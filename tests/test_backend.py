import os
from conftest import gasto


def postar(client, rota, dados, confirmar=False):
    headers = {"X-Confirmar-Reducao": "1"} if confirmar else {}
    return client.post(rota, json=dados, headers=headers)


def lista(client, rota):
    return client.get(rota).get_json()


# ---------------- Gravação normal continua funcionando ----------------

def test_grava_e_le_gastos(client):
    dados = [gasto(i) for i in range(3)]
    assert postar(client, "/api/gastos_pontuais", dados).status_code == 200
    assert len(lista(client, "/api/gastos_pontuais")) == 3


def test_editar_nao_dispara_trava(client):
    dados = [gasto(i) for i in range(10)]
    postar(client, "/api/gastos_pontuais", dados)
    dados[0]["desc"] = "Editado"
    assert postar(client, "/api/gastos_pontuais", dados).status_code == 200


def test_excluir_um_item_nao_dispara_trava(client):
    dados = [gasto(i) for i in range(10)]
    postar(client, "/api/gastos_pontuais", dados)
    assert postar(client, "/api/gastos_pontuais", dados[:-1]).status_code == 200
    assert len(lista(client, "/api/gastos_pontuais")) == 9


def test_tabela_pequena_pode_reduzir_livremente(client):
    postar(client, "/api/gastos_pontuais", [gasto(i) for i in range(4)])
    assert postar(client, "/api/gastos_pontuais", [gasto(0)]).status_code == 200


# ---------------- A trava ----------------

def test_reducao_drastica_e_bloqueada_e_nada_e_apagado(client):
    postar(client, "/api/gastos_pontuais", [gasto(i) for i in range(20)])
    r = postar(client, "/api/gastos_pontuais", [gasto(0), gasto(1)])
    assert r.status_code == 409
    corpo = r.get_json()
    assert corpo["erro"] == "reducao_drastica"
    assert corpo["antes"] == 20 and corpo["depois"] == 2
    assert len(lista(client, "/api/gastos_pontuais")) == 20  # intacto


def test_zerar_tabela_com_dados_e_bloqueado(client):
    postar(client, "/api/gastos_pontuais", [gasto(i) for i in range(3)])
    assert postar(client, "/api/gastos_pontuais", []).status_code == 409
    assert len(lista(client, "/api/gastos_pontuais")) == 3


def test_confirmacao_explicita_libera_a_reducao(client):
    postar(client, "/api/gastos_pontuais", [gasto(i) for i in range(20)])
    r = postar(client, "/api/gastos_pontuais", [gasto(0)], confirmar=True)
    assert r.status_code == 200
    assert len(lista(client, "/api/gastos_pontuais")) == 1


def test_trava_vale_para_faturas(client):
    faturas = [{
        "id": f"f{i}", "id_compra_pai": f"c{i}", "cartao_id": "card_1", "desc": "x",
        "data_compra": "2026-09-01", "mes_fatura": "2026-10", "valor_parcela": 10.0,
        "parcela_atual": 1, "total_parcelas": 1, "cat_id": None, "subcat_id": None,
        "divisao": [], "fechamento_dia": "", "data_inicio": "",
    } for i in range(10)]
    postar(client, "/api/faturas", faturas)
    assert postar(client, "/api/faturas", faturas[:3]).status_code == 409
    assert len(lista(client, "/api/faturas")) == 10


def test_trava_vale_para_entradas(client):
    trans = [{"id": f"t{i}", "desc": "x", "valor": 1.0, "data": "2026-10-01", "origem_regra": None} for i in range(8)]
    postar(client, "/api/entradas", {"regras_fixas": [], "transacoes": trans})
    r = postar(client, "/api/entradas", {"regras_fixas": [], "transacoes": []})
    assert r.status_code == 409
    assert len(lista(client, "/api/entradas")["transacoes"]) == 8


# ---------------- Backups ----------------

def arquivos_backup(appmod, tipo=None):
    return [f for f in os.listdir(appmod.PASTA_BACKUPS)
            if f.endswith(".db") and (tipo is None or f"_{tipo}_" in f)]


def test_primeira_gravacao_do_dia_cria_backup_diario(appmod, client):
    appmod.fazer_backup("abertura")  # só para o banco ter conteúdo/existir
    postar(client, "/api/gastos_pontuais", [gasto(0)])
    assert len(arquivos_backup(appmod, "diario")) == 1


def test_backup_diario_nao_repete_no_mesmo_dia(appmod, client):
    postar(client, "/api/gastos_pontuais", [gasto(0)])
    postar(client, "/api/gastos_pontuais", [gasto(0), gasto(1)])
    postar(client, "/api/gastos_pontuais", [gasto(0), gasto(1), gasto(2)])
    assert len(arquivos_backup(appmod, "diario")) == 1


def test_backup_e_uma_copia_valida_do_banco(appmod, client):
    import sqlite3
    postar(client, "/api/gastos_pontuais", [gasto(i) for i in range(5)])
    caminho = appmod.fazer_backup("manual")
    con = sqlite3.connect(caminho)
    assert con.execute("SELECT COUNT(*) FROM gastos_pontuais").fetchone()[0] == 5
    con.close()


def test_bloqueio_gera_backup_de_reducao(appmod, client):
    postar(client, "/api/gastos_pontuais", [gasto(i) for i in range(20)])
    postar(client, "/api/gastos_pontuais", [gasto(0)])
    assert len(arquivos_backup(appmod, "reducao")) == 1


def test_retencao_apaga_os_mais_antigos(appmod, monkeypatch):
    monkeypatch.setitem(appmod.RETENCAO_BACKUPS, "manual", 3)
    for i in range(6):
        nome = os.path.join(appmod.PASTA_BACKUPS, f"financeiro_manual_20250101_00000{i}.db")
        open(nome, "wb").write(b"x")
    appmod.fazer_backup("manual")
    assert len(arquivos_backup(appmod, "manual")) == 3


def test_sem_banco_nao_quebra(tmp_path, monkeypatch):
    import sys, importlib
    monkeypatch.setenv("FINANCEIRO_DATA_DIR", str(tmp_path / "vazio"))
    sys.modules.pop("app", None)
    mod = importlib.import_module("app")
    assert mod.fazer_backup("abertura") is None


# ---------------- Fumaça: a aplicação sobe e serve as telas ----------------

def test_pagina_principal_e_arquivos_estaticos(client):
    r = client.get("/")
    assert r.status_code == 200
    assert b"Gofre" in r.data
    assert client.get("/static/js/script.js").status_code == 200
    assert client.get("/static/css/style.css").status_code == 200


def test_html_nao_tem_ids_duplicados(client):
    import re
    html = client.get("/").get_data(as_text=True)
    ids = re.findall(r'\bid="([^"]+)"', html)
    assert len(ids) == len(set(ids)), {i for i in ids if ids.count(i) > 1}


def test_fatura_fixo_ida_e_volta_e_desfazer(client):
    base = {"id": "f1", "id_compra_pai": "f1", "cartao_id": "c1", "desc": "Academia", "data_compra": "2026-10-05",
            "mes_fatura": "2026-11", "valor_parcela": 99.9, "parcela_atual": 1, "total_parcelas": 1, "cat_id": None,
            "subcat_id": None, "divisao": [{"pessoa_id": "p_principal", "valor": 99.9}], "fechamento_dia": "", "data_inicio": ""}
    client.post("/api/faturas", json=[{**base, "fixo": True}, {**base, "id": "f2", "id_compra_pai": "f2"}])
    got = {f["id"]: f for f in client.get("/api/faturas").get_json()}
    assert got["f1"]["fixo"] is True and got["f2"]["fixo"] is False       # sem o campo => não é fixo


def test_banco_antigo_sem_coluna_fixo_e_atualizado(tmp_path, monkeypatch):
    import importlib, sqlite3, sys
    monkeypatch.setenv("FINANCEIRO_DATA_DIR", str(tmp_path / "dados"))
    monkeypatch.setenv("FINANCEIRO_CONFIG_DIR", str(tmp_path / "config"))
    sys.modules.pop("app", None)
    mod = importlib.import_module("app")
    mod.inicializar_db(); mod.migrar_colunas_novas()
    con = sqlite3.connect(mod.BANCO_DE_DADOS)
    con.execute("ALTER TABLE faturas DROP COLUMN fixo"); con.execute("ALTER TABLE regras_importacao DROP COLUMN fixo")
    con.execute("INSERT INTO faturas (id, id_compra_pai, cartao_id, desc, data_compra, mes_fatura, valor_parcela, parcela_atual, total_parcelas, divisao) "
                "VALUES ('a','a','c','Velha','2026-01-01','2026-02',10,1,1,'[]')")
    con.commit(); con.close()
    mod.migrar_colunas_novas()
    con = sqlite3.connect(mod.BANCO_DE_DADOS)
    assert con.execute("SELECT fixo FROM faturas WHERE id='a'").fetchone()[0] == 0     # dados antigos preservados, não-fixo
    assert "fixo" in [r[1] for r in con.execute("PRAGMA table_info(regras_importacao)")]


def test_aparencia_salva_e_valida(client, appmod):
    assert client.get("/api/aparencia").get_json() == {"paleta": "concreto", "destaque": "bordo", "densidade": "normal", "tema": "dark", "cor": "#8c6bff", "sobre": "#FFFFFF",
                                                       "status": "paleta", "s_ok": "#8fb39a", "s_ruim": "#cf8173", "s_atencao": "#cfae6e"}
    r = client.post("/api/aparencia", json={"paleta": "areia", "destaque": "teal", "densidade": "compacta"})
    assert r.get_json() == {"paleta": "areia", "destaque": "teal", "densidade": "compacta", "tema": "light", "cor": "#8c6bff", "sobre": "#FFFFFF",
                          "status": "paleta", "s_ok": "#8fb39a", "s_ruim": "#cf8173", "s_atencao": "#cfae6e"}
    r = client.post("/api/aparencia", json={"paleta": "neon", "destaque": "coral"})      # inválido é ignorado
    assert r.get_json() == {"paleta": "areia", "destaque": "coral", "densidade": "compacta", "tema": "light", "cor": "#8c6bff", "sobre": "#FFFFFF",
                          "status": "paleta", "s_ok": "#8fb39a", "s_ruim": "#cf8173", "s_atencao": "#cfae6e"}
    html = client.get("/").get_data(as_text=True)
    assert 'data-theme="light"' in html and 'data-paleta="areia"' in html and 'data-accent="coral"' in html


def test_aparencia_cor_personalizada(client, appmod):
    r = client.post("/api/aparencia", json={"destaque": "custom", "cor": "#C8F169"}).get_json()
    assert r["destaque"] == "custom" and r["cor"] == "#c8f169" and r["sobre"] == "#14102B"
    r = client.post("/api/aparencia", json={"cor": "vermelho; background:red"}).get_json()   # lixo é ignorado
    assert r["cor"] == "#c8f169"
    html = client.get("/").get_data(as_text=True)
    assert 'data-accent="custom"' in html and "--a-custom:#c8f169" in html


def test_aparencia_antiga_padrao_vira_gofre(client, appmod):
    import json, os
    os.makedirs(appmod.pasta_config(), exist_ok=True)
    with open(os.path.join(appmod.pasta_config(), "aparencia.json"), "w") as f:
        json.dump({"paleta": "grafite", "destaque": "gold", "densidade": "compacta"}, f)
    a = client.get("/api/aparencia").get_json()
    assert a["paleta"] == "concreto" and a["destaque"] == "bordo" and a["densidade"] == "compacta"
    with open(os.path.join(appmod.pasta_config(), "aparencia.json"), "w") as f:      # escolha própria é respeitada
        json.dump({"paleta": "grafite", "destaque": "teal"}, f)
    assert client.get("/api/aparencia").get_json()["paleta"] == "grafite"


def test_aparencia_le_arquivo_da_versao_anterior(client, appmod):
    import json, os
    os.makedirs(appmod.pasta_config(), exist_ok=True)
    with open(os.path.join(appmod.pasta_config(), "aparencia.json"), "w") as f:
        json.dump({"tema": "light", "destaque": "moss", "densidade": "normal"}, f)
    assert client.get("/api/aparencia").get_json()["paleta"] == "claro"


def test_regra_gasto_fixo_guarda_meses_pulados(client, appmod):
    regra = {"id": "rgf1", "desc": "Academia", "valor": 100.0, "dia": "5", "cat_id": None, "subcat_id": None,
             "inicio": "2026-01", "divisao": [{"pessoa_id": "p_principal", "valor": 100.0}], "meses_pulados": ["2026-03", "2026-03"]}
    assert client.post("/api/regras_gastos_fixos", json=[regra]).get_json()["status"] == "sucesso"
    lida = client.get("/api/regras_gastos_fixos").get_json()[0]
    assert lida["meses_pulados"] == ["2026-03"]
    # regra enviada sem o campo (versão antiga da tela) volta com lista vazia
    regra.pop("meses_pulados")
    client.post("/api/regras_gastos_fixos", json=[regra])
    assert client.get("/api/regras_gastos_fixos").get_json()[0]["meses_pulados"] == []


def test_banco_antigo_ganha_coluna_meses_pulados(appmod):
    with appmod.conectar() as con:
        con.execute("DROP TABLE regras_gastos_fixos")
        con.execute("CREATE TABLE regras_gastos_fixos (id TEXT PRIMARY KEY, desc TEXT NOT NULL, valor REAL NOT NULL, "
                    "dia TEXT NOT NULL, cat_id TEXT, subcat_id TEXT, inicio TEXT NOT NULL, divisao TEXT NOT NULL DEFAULT '[]')")
        con.execute("INSERT INTO regras_gastos_fixos VALUES ('r','Netflix',40,'3',NULL,NULL,'2026-01','[]')")
        con.commit()
    appmod.migrar_colunas_novas()
    with appmod.conectar() as con:
        assert con.execute("SELECT meses_pulados FROM regras_gastos_fixos").fetchone()[0] == "[]"


def test_gravacao_com_versao_velha_e_recusada(client, appmod):
    v0 = client.get("/api/versao").get_json()["versao"]
    pessoas = [{"id": "p_principal", "nome": "Eu", "tipo": "principal"}]
    r = client.post("/api/pessoas", json=pessoas, headers={"X-Versao": v0})
    assert r.status_code == 200
    v1 = r.headers["X-Versao"]
    assert v1 != v0 and client.get("/api/versao").get_json()["versao"] == v1
    # outra origem grava (sem cabeçalho) e a versão avança
    client.post("/api/pessoas", json=pessoas + [{"id": "p2", "nome": "Ana", "tipo": "secundaria"}])
    # a tela ainda conhece v1: a gravação dela NÃO pode apagar a Ana
    r = client.post("/api/pessoas", json=pessoas, headers={"X-Versao": v1})
    assert r.status_code == 409 and r.get_json()["erro"] == "desatualizado"
    assert len(client.get("/api/pessoas").get_json()) == 2
    # leitura não muda a versão; gravação sem cabeçalho (testes antigos/ferramentas) continua valendo
    assert client.get("/api/pessoas").headers["X-Versao"] == client.get("/api/versao").get_json()["versao"]


def test_fechar_mes_grava_reabre_e_desfaz(client, appmod, monkeypatch):
    monkeypatch.setattr(appmod, "JANELA_GRUPO", 0)          # na vida real fechar e reabrir ficam segundos longe um do outro
    monkeypatch.setattr(appmod, "JANELA_COALESCER", 0)
    mes = {"mes": "2026-09", "fechado_em": "2026-10-01T10:00:00", "entradas": 5000, "gastos": 3200.5,
           "resumo": {"categorias": {"Mercado": 800}}}
    assert postar(client, "/api/meses_fechados", [mes]).status_code == 200
    got = lista(client, "/api/meses_fechados")
    assert got[0]["mes"] == "2026-09" and got[0]["gastos"] == 3200.5 and got[0]["resumo"]["categorias"]["Mercado"] == 800
    assert "Fechou" in lista(client, "/api/historico")["desc_desfazer"]
    assert postar(client, "/api/meses_fechados", [], confirmar=True).status_code == 200      # reabrir
    assert lista(client, "/api/meses_fechados") == []
    r = client.post("/api/historico/desfazer").get_json()
    assert r["ok"] and "Reabriu" in r["descricao"], r
    assert len(lista(client, "/api/meses_fechados")) == 1


def test_aparencia_cores_de_situacao(client):
    r = client.post("/api/aparencia", json={"status": "custom", "s_ok": "#112233", "s_ruim": "#ZZZZZZ", "s_atencao": "#AABBCC"}).get_json()
    assert r["status"] == "custom" and r["s_ok"] == "#112233" and r["s_atencao"] == "#aabbcc"
    assert r["s_ruim"] == "#cf8173"                       # cor inválida é ignorada
    assert client.post("/api/aparencia", json={"status": "invalido"}).get_json()["status"] == "custom"
    assert client.get("/api/aparencia").get_json()["s_ok"] == "#112233"


def test_atualizacao_desligada_sem_repositorio(client, appmod):
    appmod.REPO_GITHUB = ""
    d = client.get("/api/atualizacao").get_json()
    assert d["ativo"] is False and d["disponivel"] is False and d["atual"] == appmod.APP_VERSAO
    assert client.post("/api/abrir_pagina_projeto", json={"url": "https://github.com/x/y/"}).status_code == 400


def test_atualizacao_compara_versoes(client, appmod, monkeypatch):
    import io, json as _j, urllib.request
    appmod.REPO_GITHUB = "fulano/gofre"
    appmod._cache_versao.update({"quando": 0, "dados": None})

    class Resp(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: Resp(_j.dumps({"tag_name": "v99.0.0", "html_url": "https://github.com/fulano/gofre/releases/tag/v99.0.0"}).encode()))
    d = client.get("/api/atualizacao").get_json()
    assert d["disponivel"] is True and d["nova"] == "99.0.0"
    assert client.post("/api/abrir_pagina_projeto", json={"url": "https://evil.com/"}).status_code == 400
    appmod.REPO_GITHUB = ""


def test_atualizacao_automatica_so_aceita_instalador_do_repositorio(client, appmod):
    appmod.REPO_GITHUB = "fulano/gofre"
    ok = "https://github.com/fulano/gofre/releases/download/v2.6.0/Instalar_Financeiro_2.6.0.exe"
    assert appmod._url_instalador_valida(ok)
    for ruim in ("https://evil.com/Instalar_Financeiro_2.6.0.exe",
                 "https://github.com/outro/gofre/releases/download/v2.6.0/Instalar_Financeiro_2.6.0.exe",
                 "https://github.com/fulano/gofre/releases/download/v2.6.0/malware.exe",
                 "http://github.com/fulano/gofre/releases/download/v2.6.0/Instalar_Financeiro_2.6.0.exe"):
        assert not appmod._url_instalador_valida(ruim)
    assert client.post("/api/atualizar_agora").status_code == 400      # fora do programa instalado não instala nada
    assert client.get("/api/atualizar_estado").get_json()["fase"] == "parado"
    appmod.REPO_GITHUB = ""
