import time
from conftest import gasto


def post(client, rota, dados, confirmar=False):
    h = {"X-Confirmar-Reducao": "1"} if confirmar else {}
    return client.post(rota, json=dados, headers=h)


def ids(client):
    return sorted(g["id"] for g in client.get("/api/gastos_pontuais").get_json())


def hist(client):
    return client.get("/api/historico").get_json()


def desfazer(client):
    return client.post("/api/historico/desfazer").get_json()


def refazer(client):
    return client.post("/api/historico/refazer").get_json()


def passar_tempo(appmod, monkeypatch=None, segundos=3):
    """Faz o histórico considerar que as ações anteriores foram há mais tempo."""
    import sqlite3
    con = sqlite3.connect(appmod.BANCO_DE_DADOS)
    con.execute("UPDATE historico SET ts = ts - ?", (segundos,))
    con.commit()
    con.close()


# ---------------- Básico ----------------

def test_desfazer_e_refazer_um_lancamento(appmod, client):
    post(client, "/api/gastos_pontuais", [gasto(1)])
    assert hist(client)["pode_desfazer"] and not hist(client)["pode_refazer"]
    assert desfazer(client)["ok"]
    assert ids(client) == []
    assert hist(client)["pode_refazer"]
    assert refazer(client)["ok"]
    assert ids(client) == ["gp_1"]


def test_nada_para_desfazer(client):
    r = desfazer(client)
    assert r["ok"] is False
    assert refazer(client)["ok"] is False


# ---------------- O cenário que causou a perda dos dados ----------------

def test_desfazer_so_reverte_a_ultima_acao_e_preserva_o_resto(appmod, client):
    post(client, "/api/gastos_pontuais", [gasto(1)]); passar_tempo(appmod)
    post(client, "/api/gastos_pontuais", [gasto(1), gasto(2)]); passar_tempo(appmod)
    post(client, "/api/gastos_pontuais", [gasto(1), gasto(2), gasto(3)]); passar_tempo(appmod)
    desfazer(client)
    assert ids(client) == ["gp_1", "gp_2"]       # só o 3 saiu
    desfazer(client)
    assert ids(client) == ["gp_1"]
    refazer(client)
    assert ids(client) == ["gp_1", "gp_2"]


def test_desfazer_exclusao_nao_apaga_lancamentos_feitos_depois_de_outros_itens(appmod, client):
    base = [gasto(i) for i in range(1, 11)]
    post(client, "/api/gastos_pontuais", base); passar_tempo(appmod)
    post(client, "/api/gastos_pontuais", base[1:]); passar_tempo(appmod)          # exclui o 1
    post(client, "/api/gastos_pontuais", base[1:] + [gasto(99)]); passar_tempo(appmod)  # lança o 99
    desfazer(client)                                  # desfaz o lançamento do 99
    assert "gp_99" not in ids(client) and "gp_1" not in ids(client)
    desfazer(client)                                  # desfaz a exclusão do 1
    assert "gp_1" in ids(client) and len(ids(client)) == 10


def test_nova_acao_apaga_o_refazer(appmod, client):
    post(client, "/api/gastos_pontuais", [gasto(1)]); passar_tempo(appmod)
    post(client, "/api/gastos_pontuais", [gasto(1), gasto(2)]); passar_tempo(appmod)
    desfazer(client)
    assert hist(client)["pode_refazer"]
    post(client, "/api/gastos_pontuais", [gasto(1), gasto(5)])
    assert not hist(client)["pode_refazer"]


def test_edicao_e_desfeita_voltando_ao_valor_antigo(appmod, client):
    g = gasto(1)
    post(client, "/api/gastos_pontuais", [g]); passar_tempo(appmod)
    g2 = dict(g, valor=500.0, desc="Mudou")
    post(client, "/api/gastos_pontuais", [g2])
    desfazer(client)
    atual = client.get("/api/gastos_pontuais").get_json()[0]
    assert atual["valor"] == g["valor"] and atual["desc"] == g["desc"]


# ---------------- Agrupamento ----------------

def test_parcelamento_de_12x_e_uma_unica_acao(appmod, client):
    parcelas = [dict(gasto(i), id_grupo="grp", parcela_num=i, total_parcelas=12) for i in range(1, 13)]
    post(client, "/api/gastos_pontuais", parcelas)
    assert len(hist(client)["itens"]) == 1
    desfazer(client)
    assert ids(client) == []
    refazer(client)
    assert len(ids(client)) == 12


def test_duas_gravacoes_seguidas_viram_uma_acao(appmod, client):
    # ex.: criar regra de gasto fixo + lançamento gerado, em requisições separadas
    post(client, "/api/regras_gastos_fixos", [{
        "id": "rgf_1", "desc": "Aluguel", "valor": 1000.0, "dia": "05", "cat_id": None,
        "subcat_id": None, "inicio": "2026-10", "divisao": []}])
    post(client, "/api/gastos_pontuais", [dict(gasto(1), origem_regra="rgf_1", desc="Aluguel")])
    assert len(hist(client)["itens"]) == 1
    desfazer(client)
    assert client.get("/api/regras_gastos_fixos").get_json() == []
    assert ids(client) == []


def test_lancamento_gerado_sozinho_nao_entra_no_historico(appmod, client):
    post(client, "/api/gastos_pontuais", [dict(gasto(1), origem_regra="rgf_1")])
    assert hist(client)["itens"] == []
    assert not hist(client)["pode_desfazer"]


def test_gerado_sozinho_nao_apaga_o_refazer(appmod, client):
    post(client, "/api/gastos_pontuais", [gasto(1)]); passar_tempo(appmod)
    post(client, "/api/gastos_pontuais", [gasto(1), gasto(2)]); passar_tempo(appmod)
    desfazer(client)
    # o app recarrega e gera fixos automaticamente:
    post(client, "/api/gastos_pontuais", [gasto(1), dict(gasto(7), origem_regra="rgf_1")])
    assert hist(client)["pode_refazer"]


def test_editar_o_mesmo_valor_varias_vezes_vira_uma_acao(appmod, client):
    g = gasto(1)
    post(client, "/api/gastos_pontuais", [g]); passar_tempo(appmod, segundos=20)
    for v in (11.0, 12.0, 13.0, 14.0):
        post(client, "/api/gastos_pontuais", [dict(g, valor=v)]); passar_tempo(appmod, segundos=2)
    assert len(hist(client)["itens"]) == 2        # criar + (4 edições juntas)
    desfazer(client)
    assert client.get("/api/gastos_pontuais").get_json()[0]["valor"] == g["valor"]


def test_gravar_sem_mudanca_nao_gera_acao(appmod, client):
    post(client, "/api/gastos_pontuais", [gasto(1)]); passar_tempo(appmod)
    n = len(hist(client)["itens"])
    post(client, "/api/gastos_pontuais", [gasto(1)])
    assert len(hist(client)["itens"]) == n


# ---------------- Outras tabelas e descrições ----------------

def test_marcar_como_pago_pode_ser_desfeito_e_tem_nome_claro(appmod, client):
    g = gasto(1, ) ; g["desc"] = "Netflix"
    post(client, "/api/gastos_pontuais", [g]); passar_tempo(appmod)
    post(client, "/api/gastos_pontuais", [dict(g, pago=True)])
    assert hist(client)["desc_desfazer"] == "Marcou como pago \u201cNetflix\u201d"
    desfazer(client)
    assert client.get("/api/gastos_pontuais").get_json()[0]["pago"] is False


def test_descricoes_de_excluir_e_adicionar(appmod, client):
    g = gasto(1); g["desc"] = "Netflix"
    post(client, "/api/gastos_pontuais", [g])
    assert hist(client)["desc_desfazer"] == "Adicionou \u201cNetflix\u201d"
    passar_tempo(appmod)
    post(client, "/api/gastos_pontuais", [gasto(2), gasto(3), gasto(4), gasto(5), gasto(6), g]); passar_tempo(appmod)
    post(client, "/api/gastos_pontuais", [gasto(2), gasto(3), gasto(4), gasto(5), gasto(6)])
    assert hist(client)["desc_desfazer"] == "Excluiu \u201cNetflix\u201d"


def test_historico_de_tabela_com_chave_composta(appmod, client):
    post(client, "/api/orcamentos", [{"cat_id": "c1", "subcat_id": "", "mes": "2026-10", "valor": 500.0}])
    passar_tempo(appmod, segundos=30)
    post(client, "/api/orcamentos", [{"cat_id": "c1", "subcat_id": "", "mes": "2026-10", "valor": 800.0}])
    desfazer(client)
    assert client.get("/api/orcamentos").get_json()[0]["valor"] == 500.0
    desfazer(client)
    assert client.get("/api/orcamentos").get_json() == []


def test_categorias_com_subcategorias(appmod, client):
    cats = [{"id": "c1", "nome": "Saúde", "subcategorias": [{"id": "s1", "nome": "Farmácia"}]}]
    post(client, "/api/categorias", cats)
    desfazer(client)
    assert client.get("/api/categorias").get_json() == []
    refazer(client)
    r = client.get("/api/categorias").get_json()
    assert r[0]["nome"] == "Saúde" and r[0]["subcategorias"][0]["nome"] == "Farmácia"


# ---------------- Segurança junto com a trava ----------------

def test_exclusao_em_massa_confirmada_pode_ser_desfeita(appmod, client):
    todos = [gasto(i) for i in range(20)]
    post(client, "/api/gastos_pontuais", todos); passar_tempo(appmod)
    assert post(client, "/api/gastos_pontuais", todos[:2]).status_code == 409
    assert post(client, "/api/gastos_pontuais", todos[:2], confirmar=True).status_code == 200
    assert len(ids(client)) == 2
    desfazer(client)
    assert len(ids(client)) == 20


def test_gravacao_bloqueada_nao_entra_no_historico(appmod, client):
    todos = [gasto(i) for i in range(20)]
    post(client, "/api/gastos_pontuais", todos); passar_tempo(appmod)
    n = len(hist(client)["itens"])
    post(client, "/api/gastos_pontuais", todos[:2])  # 409
    assert len(hist(client)["itens"]) == n


def test_limite_de_acoes_guardadas(appmod, client, monkeypatch):
    monkeypatch.setattr(appmod, "MAX_ACOES_HISTORICO", 5)
    lista = []
    for i in range(12):
        lista.append(gasto(i))
        post(client, "/api/gastos_pontuais", list(lista)); passar_tempo(appmod, segundos=30)
    import sqlite3
    con = sqlite3.connect(appmod.BANCO_DE_DADOS)
    assert con.execute("SELECT COUNT(DISTINCT grupo) FROM historico").fetchone()[0] <= 5
    con.close()
