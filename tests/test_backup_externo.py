import os
import sqlite3
import sys
import importlib

import pytest

from conftest import gasto
from desktop import backup_externo, caminhos


@pytest.fixture()
def externo(tmp_path, monkeypatch):
    pasta = tmp_path / "Drive" / "Financeiro_Backups"
    monkeypatch.setenv("FINANCEIRO_BACKUP_EXTRA", str(pasta))
    return pasta


def com_dados(appmod, client):
    client.post("/api/gastos_pontuais", json=[gasto(i) for i in range(5)])


def arquivos(pasta, tipo=None):
    if not pasta.exists():
        return []
    return sorted(f for f in os.listdir(pasta) if f.endswith(".db") and (tipo is None or f"_{tipo}_" in f))


# ---------------- Cópia para a pasta externa ----------------

def test_backup_manual_tambem_vai_para_a_pasta_externa(appmod, client, externo):
    com_dados(appmod, client)
    local = appmod.fazer_backup("manual")
    assert os.path.basename(local) in arquivos(externo, "manual")
    assert appmod.ESTADO_BACKUP_EXTERNO["ok"] is True


def test_a_copia_externa_e_um_banco_valido_com_os_dados(appmod, client, externo):
    com_dados(appmod, client)
    appmod.fazer_backup("manual")
    nome = arquivos(externo, "manual")[0]
    con = sqlite3.connect(str(externo / nome))
    assert con.execute("SELECT COUNT(*) FROM gastos_pontuais").fetchone()[0] == 5
    con.close()


def test_gravacao_normal_dispara_backup_diario_tambem_na_pasta_externa(appmod, client, externo):
    com_dados(appmod, client)
    assert len(arquivos(externo, "diario")) == 1


def test_bloqueio_de_reducao_tambem_copia_para_fora(appmod, client, externo):
    client.post("/api/gastos_pontuais", json=[gasto(i) for i in range(20)])
    client.post("/api/gastos_pontuais", json=[gasto(0)])  # bloqueado (409)
    assert len(arquivos(externo, "reducao")) == 1


def test_nao_deixa_arquivo_temporario_na_pasta_externa(appmod, client, externo):
    com_dados(appmod, client)
    appmod.fazer_backup("manual")
    assert not [f for f in os.listdir(externo) if f.endswith(".tmp")]


def test_pasta_externa_e_criada_se_nao_existir(appmod, client, externo):
    assert not externo.exists()
    com_dados(appmod, client)
    appmod.fazer_backup("manual")
    assert externo.exists()


def test_sem_pasta_configurada_nada_vai_para_fora(appmod, client, monkeypatch, tmp_path):
    monkeypatch.delenv("FINANCEIRO_BACKUP_EXTRA", raising=False)
    com_dados(appmod, client)
    assert appmod.fazer_backup("manual") is not None
    assert appmod.ESTADO_BACKUP_EXTERNO["configurado"] is False


def test_retencao_na_pasta_externa_apaga_os_mais_antigos(appmod, client, externo, monkeypatch):
    monkeypatch.setitem(appmod.RETENCAO_BACKUPS, "manual", 3)
    externo.mkdir(parents=True)
    for i in range(6):
        (externo / f"financeiro_manual_20250101_00000{i}.db").write_bytes(b"x")
    com_dados(appmod, client)
    appmod.fazer_backup("manual")
    restantes = arquivos(externo, "manual")
    assert len(restantes) == 3
    assert "financeiro_manual_20250101_000000.db" not in restantes


def test_retencao_externa_nao_mexe_em_outros_tipos(appmod, client, externo, monkeypatch):
    monkeypatch.setitem(appmod.RETENCAO_BACKUPS, "manual", 1)
    externo.mkdir(parents=True)
    (externo / "financeiro_diario_20250101_000000.db").write_bytes(b"x")
    com_dados(appmod, client)
    appmod.fazer_backup("manual")
    assert arquivos(externo, "diario")  # continua lá


# ---------------- Falhas nunca atrapalham o uso ----------------

def test_pasta_externa_invalida_nao_quebra_o_backup_local(appmod, client, tmp_path, monkeypatch):
    arquivo = tmp_path / "isto_e_um_arquivo"
    arquivo.write_text("x")
    monkeypatch.setenv("FINANCEIRO_BACKUP_EXTRA", str(arquivo / "subpasta"))
    com_dados(appmod, client)
    local = appmod.fazer_backup("manual")
    assert local and os.path.exists(local)                      # backup local ok
    assert appmod.ESTADO_BACKUP_EXTERNO["ok"] is False          # a falha foi registrada
    assert appmod.ESTADO_BACKUP_EXTERNO["erro"]


def test_falha_externa_nao_impede_gravar_dados(appmod, client, tmp_path, monkeypatch):
    arquivo = tmp_path / "arq"; arquivo.write_text("x")
    monkeypatch.setenv("FINANCEIRO_BACKUP_EXTRA", str(arquivo / "x"))
    r = client.post("/api/gastos_pontuais", json=[gasto(1)])
    assert r.status_code == 200
    assert len(client.get("/api/gastos_pontuais").get_json()) == 1


def test_falha_externa_nao_apaga_nada_da_pasta_externa_existente(appmod, client, externo, monkeypatch):
    externo.mkdir(parents=True)
    (externo / "financeiro_manual_20250101_000000.db").write_bytes(b"importante")
    com_dados(appmod, client)
    def quebra(*a, **k): raise OSError("disco cheio")
    monkeypatch.setattr(appmod.shutil, "copy2", quebra)
    appmod.fazer_backup("manual")
    assert (externo / "financeiro_manual_20250101_000000.db").read_bytes() == b"importante"
    assert appmod.ESTADO_BACKUP_EXTERNO["ok"] is False


def test_testar_pasta_externa(appmod, tmp_path):
    ok, _ = appmod.testar_pasta_externa(str(tmp_path / "nova"))
    assert ok
    assert not os.path.exists(tmp_path / "nova" / ".teste_gravacao.tmp")
    arq = tmp_path / "f"; arq.write_text("x")
    ok, msg = appmod.testar_pasta_externa(str(arq / "sub"))
    assert ok is False and msg


# ---------------- Configurar pela interface ----------------

def test_configurar_grava_preferencia_ativa_e_faz_backup_de_teste(appmod, client, tmp_path, monkeypatch):
    monkeypatch.delenv("FINANCEIRO_BACKUP_EXTRA", raising=False)
    com_dados(appmod, client)
    pasta_cfg = tmp_path / "cfg"
    config = dict(caminhos.PADRAO)
    destino = tmp_path / "Drive" / "Backups"
    ok, detalhe = backup_externo.configurar(str(destino), config, str(pasta_cfg), appmod)
    assert ok and detalhe and detalhe != "sem_dados"
    assert arquivos(destino, "manual")
    salvo = caminhos.carregar_config(str(pasta_cfg))
    assert salvo["pasta_backup_externa"] == str(destino) and salvo["backup_externo_perguntado"] is True
    assert os.environ["FINANCEIRO_BACKUP_EXTRA"] == str(destino)


def test_configurar_pasta_invalida_nao_salva_nada(appmod, tmp_path, monkeypatch):
    monkeypatch.delenv("FINANCEIRO_BACKUP_EXTRA", raising=False)
    arq = tmp_path / "f"; arq.write_text("x")
    pasta_cfg = tmp_path / "cfg"
    config = dict(caminhos.PADRAO)
    ok, detalhe = backup_externo.configurar(str(arq / "sub"), config, str(pasta_cfg), appmod)
    assert ok is False and detalhe
    assert config["pasta_backup_externa"] is None
    assert not (pasta_cfg / "config.json").exists()
    assert not os.environ.get("FINANCEIRO_BACKUP_EXTRA")


def test_configurar_sem_dados_ainda_nao_falha(appmod, tmp_path, monkeypatch):
    monkeypatch.delenv("FINANCEIRO_BACKUP_EXTRA", raising=False)
    os.remove(appmod.BANCO_DE_DADOS)
    ok, detalhe = backup_externo.configurar(str(tmp_path / "D"), dict(caminhos.PADRAO), str(tmp_path / "c"), appmod)
    assert ok and detalhe == "sem_dados"


def test_desativar(tmp_path, monkeypatch):
    config = dict(caminhos.PADRAO, pasta_backup_externa="X")
    backup_externo.desativar(config, str(tmp_path))
    assert caminhos.carregar_config(str(tmp_path))["pasta_backup_externa"] is None
    assert os.environ["FINANCEIRO_BACKUP_EXTRA"] == ""


def test_verificar_na_abertura(appmod, tmp_path):
    assert backup_externo.verificar_na_abertura({"pasta_backup_externa": None}, appmod) is None
    assert backup_externo.verificar_na_abertura({"pasta_backup_externa": str(tmp_path / "ok")}, appmod) is None
    arq = tmp_path / "f"; arq.write_text("x")
    aviso = backup_externo.verificar_na_abertura({"pasta_backup_externa": str(arq / "sub")}, appmod)
    assert aviso and "Google Drive" in aviso


def test_texto_do_menu():
    assert "Escolher" in backup_externo.texto_do_menu({"pasta_backup_externa": None})
    assert "G:\\Backups" in backup_externo.texto_do_menu({"pasta_backup_externa": "G:\\Backups"})


# ---------------- Caixa de escolha de pasta (simulada) ----------------

class JanelaFalsa:
    def __init__(self, resposta=None, erro=False):
        self.resposta, self.erro, self.chamadas = resposta, erro, []
    def create_file_dialog(self, tipo, directory=""):
        self.chamadas.append((tipo, directory))
        if self.erro:
            raise RuntimeError("sem janela")
        return self.resposta


class WebviewNovo:   # pywebview 6: FileDialog.FOLDER
    class FileDialog:
        FOLDER = "FOLDER_NOVO"


class WebviewAntigo:  # pywebview 5: FOLDER_DIALOG
    FOLDER_DIALOG = 20


def test_escolher_pasta_aceita_as_duas_versoes_do_pywebview():
    j = JanelaFalsa(("G:\\Drive\\B",))
    assert backup_externo.escolher_pasta(j, WebviewNovo) == "G:\\Drive\\B"
    assert j.chamadas[0][0] == "FOLDER_NOVO"
    j = JanelaFalsa(("G:\\Drive\\B",))
    assert backup_externo.escolher_pasta(j, WebviewAntigo) == "G:\\Drive\\B"
    assert j.chamadas[0][0] == 20


def test_escolher_pasta_cancelado_ou_com_erro_retorna_none():
    assert backup_externo.escolher_pasta(JanelaFalsa(None), WebviewNovo) is None
    assert backup_externo.escolher_pasta(JanelaFalsa(()), WebviewNovo) is None
    assert backup_externo.escolher_pasta(JanelaFalsa(erro=True), WebviewNovo) is None


def test_config_padrao_tem_os_novos_campos():
    assert caminhos.PADRAO["pasta_backup_externa"] is None
    assert caminhos.PADRAO["backup_externo_perguntado"] is False
