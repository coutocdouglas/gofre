"""API de importação de ponta a ponta, incluindo desfazer/refazer."""
import io
import sqlite3

import pytest

pytest.importorskip("reportlab")
from fixtures_faturas import INTER_PAGINAS, XP_PAGINAS
from pdf_ficticio import gerar_pdf


_PDFS = {}


def pdf_fixo(paginas, senha=None):
    """Mesmo conteúdo => mesmos bytes (o gerador coloca data de criação, que mudaria o hash)."""
    chave = (tuple(paginas), senha)
    if chave not in _PDFS:
        _PDFS[chave] = gerar_pdf(paginas, senha=senha)
    return _PDFS[chave]


def separar_historico(appmod):
    con = sqlite3.connect(appmod.BANCO_DE_DADOS)
    con.execute("UPDATE historico SET ts = ts - 10")
    con.commit()
    con.close()


def semear(client):
    client.post("/api/pessoas", json=[{"id": "p1", "nome": "Eu", "tipo": "principal"},
                                      {"id": "p2", "nome": "Ana", "tipo": "secundaria"}])
    client.post("/api/cartoes", json=[{"id": "c1", "nome": "XP", "vencimento": "10", "cor": "#fff", "fechamento": ""},
                                      {"id": "c2", "nome": "XP 2", "vencimento": "10", "cor": "#000", "fechamento": ""}])
    client.post("/api/categorias", json=[{"id": "cat1", "nome": "Transporte"}])


def enviar(client, paginas, senha_pdf=None, senha=None):
    dados = pdf_fixo(paginas, senha_pdf)
    form = {"arquivo": (io.BytesIO(dados), "fatura.pdf")}
    if senha:
        form["senha"] = senha
    return client.post("/api/importacao/ler", data=form, content_type="multipart/form-data").get_json()


def item(desc="Padaria", valor=10.0, **kw):
    base = {"desc": desc, "cartao_id": "c1", "data": "2026-09-02", "valor": valor, "parcela_atual": 1,
            "total_parcelas": 1, "modo": "so_esta", "cat_id": None, "subcat_id": None,
            "divisao": [{"pessoa_id": "p1", "valor": valor}]}
    base.update(kw)
    return base


def confirmar(client, itens, **kw):
    return client.post("/api/importacao/confirmar",
                       json={"mes_fatura": "2026-10", "itens": itens, **kw}).get_json()


def faturas(client):
    return client.get("/api/faturas").get_json()


def test_ler_xp_sem_senha(client):
    r = enviar(client, XP_PAGINAS)
    assert r["ok"] and r["fatura"]["emissor"] == "xp" and r["fatura"]["conferencia"]["ok"]
    assert r["importacao_anterior"] is None and len(r["arquivo"]["hash"]) == 64


def test_ler_inter(client):
    r = enviar(client, INTER_PAGINAS)
    assert r["ok"] and r["fatura"]["emissor"] == "inter"


def test_fluxo_de_senha_e_lembrar(client):
    r = enviar(client, XP_PAGINAS, senha_pdf="777")
    assert r["ok"] is False and r["erro"] == "senha_necessaria"
    assert enviar(client, XP_PAGINAS, senha_pdf="777", senha="000")["erro"] == "senha_incorreta"
    assert enviar(client, XP_PAGINAS, senha_pdf="777", senha="777")["ok"]
    assert enviar(client, XP_PAGINAS, senha_pdf="777")["ok"]          # agora lembrada
    assert client.get("/api/importacao/senhas").get_json()["qtd"] == 1
    client.delete("/api/importacao/senhas")
    assert enviar(client, XP_PAGINAS, senha_pdf="777")["erro"] == "senha_necessaria"


def test_pdf_invalido_e_sem_arquivo(client):
    r = client.post("/api/importacao/ler", data={"arquivo": (io.BytesIO(b"nada"), "x.pdf")},
                    content_type="multipart/form-data").get_json()
    assert r["ok"] is False and r["erro"] == "pdf_invalido"
    assert client.post("/api/importacao/ler", data={}, content_type="multipart/form-data").get_json()["erro"] == "sem_arquivo"


def test_formato_desconhecido(client):
    assert enviar(client, ["Texto qualquer\nsem fatura"])["erro"] == "formato_desconhecido"


def test_sugerir(client):
    semear(client)
    fat = enviar(client, XP_PAGINAS)["fatura"]
    r = client.post("/api/importacao/sugerir", json={"fatura": fat, "mapeamento": {"0": "c1", "1": "c2"},
                                                     "mes_fatura": fat["mes_fatura"]}).get_json()
    assert r["ok"] and len(r["sugestoes"]) == sum(len(s["linhas"]) for s in fat["secoes"])
    assert client.post("/api/importacao/sugerir", json={}).get_json()["ok"] is False


def test_confirmar_cria_serie_e_um_unico_desfazer(appmod, client):
    semear(client)
    separar_historico(appmod)
    r = confirmar(client, [item("Samsung", 61.46, parcela_atual=10, total_parcelas=15, modo="esta_e_seguintes"),
                           item("Padaria", 12.0), item("Uber", 20.0)])
    assert r["ok"] and r["itens"] == 3 and r["linhas"] == 6 + 2
    f = faturas(client)
    serie = sorted((x for x in f if x["desc"] == "Samsung"), key=lambda x: x["parcela_atual"])
    assert [x["mes_fatura"] for x in serie] == ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]
    assert len({x["id_compra_pai"] for x in serie}) == 1
    h = client.get("/api/historico").get_json()
    assert h["desc_desfazer"] == "Importou 3 lançamentos de cartão" or "Importou" in h["desc_desfazer"]
    assert client.post("/api/historico/desfazer").get_json()["ok"]
    assert faturas(client) == []                                   # UMA ação desfez tudo
    assert client.post("/api/historico/refazer").get_json()["ok"]
    assert len(faturas(client)) == 8


def test_confirmar_invalido_nao_grava_nada(client):
    semear(client)
    ruim = item("Ruim", 10.0, divisao=[{"pessoa_id": "p1", "valor": 5.0}])
    r = confirmar(client, [item("Boa", 9.0), ruim])
    assert r["ok"] is False and "divisão" in r["mensagem"]
    assert faturas(client) == []
    assert confirmar(client, [])["ok"] is False
    assert confirmar(client, [item(cartao_id="nao")])["ok"] is False
    assert confirmar(client, [item(parcela_atual=5, total_parcelas=3)])["ok"] is False
    assert client.post("/api/importacao/confirmar", json={"itens": [item()], "mes_fatura": "x"}).get_json()["ok"] is False


def test_categoria_inexistente_vira_vazia(client):
    semear(client)
    confirmar(client, [item(cat_id="fantasma", subcat_id="s")])
    assert faturas(client)[0]["cat_id"] in (None, "")


def test_importacao_anterior_e_apos_desfazer(client):
    semear(client)
    r = enviar(client, XP_PAGINAS)
    arq = {"hash": r["arquivo"]["hash"], "nome": "f.pdf", "emissor": "xp", "vencimento": r["fatura"]["vencimento"]}
    confirmar(client, [item()], arquivo=arq)
    again = enviar(client, XP_PAGINAS)["importacao_anterior"]
    assert again and again["mesmo_arquivo"] and again["ainda_existem"] == 1
    client.post("/api/historico/desfazer")
    assert enviar(client, XP_PAGINAS)["importacao_anterior"] is None


def test_regras_salvas_e_aplicadas(client):
    semear(client)
    regra = {"padrao": "Uberrides", "nome": "Uber", "cat_id": "cat1",
             "divisao": [{"pessoa_id": "p2", "pct": 100.0}]}
    confirmar(client, [item("Uber", 20.0)], regras=[regra, {"padrao": "ab", "nome": "curta"}])
    regras = client.get("/api/importacao/regras").get_json()
    assert len(regras) == 1 and regras[0]["padrao"] == "uberrides"
    fat = {"secoes": [{"rotulo": "x", "linhas": [{
        "seq": 1, "secao": 0, "data": "2026-09-02", "descricao": "DL *UBERRIDES", "descricao_original": "DL *UBERRIDES",
        "valor": 15.0, "valor_usd": None, "parcela_atual": None, "total_parcelas": None, "tipo": "compra"}]}]}
    s = client.post("/api/importacao/sugerir", json={"fatura": fat, "mapeamento": {"0": "c1"},
                                                     "mes_fatura": "2026-10"}).get_json()["sugestoes"][0]
    assert s["nome"] == "Uber" and s["cat_id"] == "cat1" and s["divisao_pct"][0]["pessoa_id"] == "p2"
    assert client.delete(f"/api/importacao/regras/{regras[0]['id']}").get_json()["ok"]
    assert client.get("/api/importacao/regras").get_json() == []


def test_vinculo_manual_usa_a_mesma_compra(client):
    semear(client)
    confirmar(client, [item("Samsung", 61.46, parcela_atual=5, total_parcelas=10)], mes_fatura="2026-09")
    pai = faturas(client)[0]["id_compra_pai"]
    r = confirmar(client, [item("Samsung", 61.46, parcela_atual=6, total_parcelas=10, compra_pai=pai,
                                modo="esta_e_seguintes")])
    assert r["ok"]
    serie = [x for x in faturas(client) if x["id_compra_pai"] == pai]
    assert sorted(x["parcela_atual"] for x in serie) == [5, 6, 7, 8, 9, 10]
    # compra_pai inexistente é ignorada (vira compra nova), nunca erro nem lixo
    confirmar(client, [item("Outra", 5.0, compra_pai="nao_existe")])
    outra = [x for x in faturas(client) if x["desc"] == "Outra"][0]
    assert outra["id_compra_pai"].startswith("compra_imp")


def test_vinculo_nunca_duplica_o_que_ja_existe(client):
    semear(client)
    # compra de 6 parcelas já lançada inteira (parcelas 1..6)
    confirmar(client, [item("Galaxy", 50.0, parcela_atual=1, total_parcelas=6, modo="esta_e_seguintes")], mes_fatura="2026-06")
    pai = faturas(client)[0]["id_compra_pai"]
    assert len(faturas(client)) == 6
    # vincula de novo as parcelas 3..6: tudo já existe => nada novo é criado
    r = confirmar(client, [item("Galaxy", 50.0, parcela_atual=3, total_parcelas=6, modo="esta_e_seguintes", compra_pai=pai)])
    assert r["ok"] and r["linhas"] == 0
    assert len(faturas(client)) == 6
    # compra que só tem 1..3: ao vincular a 3 em diante, cria só 4..6
    confirmar(client, [item("Fone", 20.0, parcela_atual=1, total_parcelas=6, modo="so_esta")], mes_fatura="2026-06")
    pai2 = [x for x in faturas(client) if x["desc"] == "Fone"][0]["id_compra_pai"]
    r = confirmar(client, [item("Fone", 20.0, parcela_atual=1, total_parcelas=6, modo="esta_e_seguintes", compra_pai=pai2)])
    assert sorted(x["parcela_atual"] for x in faturas(client) if x["id_compra_pai"] == pai2) == [1, 2, 3, 4, 5, 6]
    assert r["linhas"] == 5


def test_importacao_e_regra_guardam_fixo(client):
    semear(client)
    regra = {"padrao": "Smart Fit", "nome": "Academia", "fixo": True, "divisao": [{"pessoa_id": "p1", "pct": 100.0}]}
    confirmar(client, [item("Academia", 99.9, fixo=True), item("Padaria", 10.0)], regras=[regra])
    f = {x["desc"]: x for x in faturas(client)}
    assert f["Academia"]["fixo"] is True and f["Padaria"]["fixo"] is False
    assert client.get("/api/importacao/regras").get_json()[0]["fixo"] is True
    fat = {"secoes": [{"rotulo": "x", "linhas": [{
        "seq": 1, "secao": 0, "data": "2026-09-02", "descricao": "SMART FIT MENSAL", "descricao_original": "SMART FIT MENSAL",
        "valor": 99.9, "valor_usd": None, "parcela_atual": None, "total_parcelas": None, "tipo": "compra"}]}]}
    s = client.post("/api/importacao/sugerir", json={"fatura": fat, "mapeamento": {"0": "c1"}, "mes_fatura": "2026-11"}).get_json()["sugestoes"][0]
    assert s["fixo"] is True
