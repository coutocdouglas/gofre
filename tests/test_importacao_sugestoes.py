"""Sugestões: nomes, regras salvas e detecção de lançamentos que já existem."""
from importacao.sugestoes import aplicar_regra, montar_sugestoes, nome_sugerido, normalizar

PESSOAS = [{"id": "p1", "nome": "Eu", "tipo": "principal"}, {"id": "p2", "nome": "Ana", "tipo": "secundaria"}]


def linha(seq, desc, valor, data="2026-09-02", atual=None, total=None, tipo="compra", usd=None):
    return {"seq": seq, "secao": 0, "data": data, "descricao": desc, "descricao_original": desc,
            "valor": valor, "valor_usd": usd, "parcela_atual": atual, "total_parcelas": total, "tipo": tipo}


def fatura(*linhas):
    return {"secoes": [{"rotulo": "XP final 1", "linhas": list(linhas)}]}


def existente(i, desc, valor, mes="2026-10", atual=1, total=1, data="2026-09-02", cartao="c1"):
    return {"id": i, "desc": desc, "valor_parcela": valor, "mes_fatura": mes, "parcela_atual": atual,
            "total_parcelas": total, "data_compra": data, "cartao_id": cartao}


def sug(f, existentes=(), regras=()):
    return montar_sugestoes(f, {"0": "c1"}, "2026-10", list(existentes), list(regras), PESSOAS)


def test_normalizar_e_nome():
    assert normalizar("DL *UBERRIDES  Ção") == "dl uberrides cao"
    assert nome_sugerido("DL *UBERRIDES") == "Uberrides"
    assert nome_sugerido("Mercado do Zé") == "Mercado do Zé"


def test_regra_mais_especifica_vence():
    regras = [{"id": "a", "padrao": "uber"}, {"id": "b", "padrao": "uber eats"}]
    assert aplicar_regra("UBER EATS SP", regras)["id"] == "b"
    assert aplicar_regra("PADARIA", regras) is None


def test_linha_nova_e_divisao_padrao():
    r = sug(fatura(linha(1, "PADARIA X", 12.5)))[0]
    assert (r["acao"], r["motivo"]) == ("lancar", "nova")
    assert r["divisao_pct"] == [{"pessoa_id": "p1", "pct": 100.0}]
    assert r["modo"] == "so_esta"


def test_pagamento_e_ignorado():
    r = sug(fatura(linha(1, "Pagamento de fatura", -500, tipo="pagamento")))[0]
    assert (r["acao"], r["motivo"]) == ("ignorar", "pagamento")


def test_parcelada_ja_lancada_forte():
    f = fatura(linha(1, "MP *SAMSUNG - Parcela 10/15", 61.46, atual=10, total=15))
    r = sug(f, [existente("x", "Samsung", 61.46, atual=10, total=15)])[0]
    assert (r["acao"], r["motivo"], r["nivel"]) == ("ignorar", "ja_lancada", "forte")
    assert r["existente"]["id"] == "x"


def test_parcelada_mes_vizinho_e_provavel():
    f = fatura(linha(1, "SAMSUNG", 61.46, atual=10, total=15))
    r = sug(f, [existente("x", "Samsung", 61.46, mes="2026-11", atual=10, total=15)])[0]
    assert (r["acao"], r["motivo"]) == ("ignorar", "provavel")


def test_outro_cartao_nao_conta():
    f = fatura(linha(1, "SAMSUNG", 61.46, atual=10, total=15))
    r = sug(f, [existente("x", "Samsung", 61.46, atual=10, total=15, cartao="outro")])[0]
    assert r["acao"] == "lancar"


def test_avulsa_precisa_da_mesma_data_para_ser_forte():
    f = fatura(linha(1, "GOOGLE", 24.99, data="2026-09-02"))
    forte = sug(f, [existente("x", "Google", 24.99, data="2026-09-02")])[0]
    assert forte["nivel"] == "forte"
    prov = sug(f, [existente("x", "Google", 24.99, data="2026-09-04")])[0]
    assert prov["nivel"] == "provavel"
    longe = sug(f, [existente("x", "Google", 24.99, data="2026-08-20")])[0]
    assert longe["acao"] == "lancar"


def test_um_existente_so_casa_com_uma_linha():
    f = fatura(linha(1, "UBER", 20.0), linha(2, "UBER", 20.0))
    r = sug(f, [existente("x", "Uber", 20.0)])
    assert sorted(i["acao"] for i in r) == ["ignorar", "lancar"]


def test_parcela_k_menor_que_n_vira_esta_e_seguintes():
    r = sug(fatura(linha(1, "LOJA", 50.0, atual=3, total=5), linha(2, "LOJA2", 50.0, atual=5, total=5)))
    assert r[0]["modo"] == "esta_e_seguintes" and "parcela_sem_historico" in r[0]["avisos"]
    assert r[1]["modo"] == "so_esta"


def test_avisos_encargo_estorno_exterior():
    f = fatura(linha(1, "IOF", 3.0, tipo="encargo"), linha(2, "ESTORNO X", -9.0, tipo="estorno"),
               linha(3, "NETFLIX", 50.0, usd=9.0))
    a = [x["avisos"] for x in sug(f)]
    assert a[0] == ["encargo"] and a[1] == ["estorno"] and a[2] == ["exterior"]


def test_regra_aplicada():
    regra = {"id": "r1", "padrao": "uber", "nome": "Uber", "cat_id": "cat1", "subcat_id": None,
             "divisao": [{"pessoa_id": "p2", "pct": 100.0}]}
    r = sug(fatura(linha(1, "DL *UBERRIDES", 30.0)), regras=[regra])[0]
    assert (r["nome"], r["cat_id"], r["regra_id"]) == ("Uber", "cat1", "r1")
    assert r["divisao_pct"][0]["pessoa_id"] == "p2"
