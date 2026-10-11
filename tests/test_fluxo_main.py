"""Roda o main.py de ponta a ponta com uma janela falsa (sem tela), para provar o fluxo:
abrir -> perguntar pela pasta de backup -> configurar -> copiar backup para a pasta escolhida."""
import importlib
import os
import sys
import types

import pytest


class Eventos:
    def __init__(self):
        self.closing = []
    # suporta:  janela.events.closing += funcao
    def __iadd__(self, f):
        return self


class FakeEvent:
    def __init__(self): self.itens = []
    def __iadd__(self, f):
        self.itens.append(f); return self


class FakeJanela:
    def __init__(self, resposta_pergunta, pasta_escolhida):
        self.x, self.y, self.width, self.height = 10, 10, 1200, 800
        self.events = types.SimpleNamespace(closing=FakeEvent())
        self.resposta_pergunta, self.pasta_escolhida = resposta_pergunta, pasta_escolhida
        self.perguntas, self.dialogos, self.mostrada = [], [], 0
    def show(self): self.mostrada += 1
    def restore(self): pass
    def hide(self): pass
    def destroy(self): pass
    def create_confirmation_dialog(self, titulo, texto):
        self.perguntas.append(texto); return self.resposta_pergunta
    def create_file_dialog(self, tipo, directory=""):
        self.dialogos.append(tipo)
        return (self.pasta_escolhida,) if self.pasta_escolhida else None


def instalar_webview_falso(monkeypatch, janela):
    fake = types.ModuleType("webview")
    fake.settings = {}
    class FileDialog: FOLDER = "FOLDER"
    fake.FileDialog = FileDialog
    fake.create_window = lambda *a, **k: janela
    def start(func=None, **k):
        if func: func()
    fake.start = start
    monkeypatch.setitem(sys.modules, "webview", fake)


@pytest.fixture()
def ambiente(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "AppData"))
    monkeypatch.setenv("FINANCEIRO_DATA_DIR", "")
    monkeypatch.setenv("FINANCEIRO_BACKUP_EXTRA", "")
    monkeypatch.delenv("FINANCEIRO_DATA_DIR")
    monkeypatch.setattr(sys, "argv", ["main.py"])
    import time
    monkeypatch.setattr(time, "sleep", lambda s: None)
    import desktop.bandeja as bandeja
    monkeypatch.setattr(bandeja, "criar_bandeja", lambda *a, **k: None)
    sys.modules.pop("app", None)
    sys.modules.pop("main", None)
    return tmp_path


def rodar_main():
    main = importlib.import_module("main")
    return main.main()


def test_primeira_abertura_pergunta_e_configura_a_pasta_do_drive(ambiente, monkeypatch):
    drive = ambiente / "Drive" / "Financeiro_Backups"
    janela = FakeJanela(resposta_pergunta=True, pasta_escolhida=str(drive))
    instalar_webview_falso(monkeypatch, janela)

    assert rodar_main() == 0

    assert len(janela.perguntas) == 1 and "Google Drive" in janela.perguntas[0]
    assert janela.dialogos == ["FOLDER"]
    # os dados foram para %APPDATA%\Financeiro\memoria
    appdata = ambiente / "AppData" / "Financeiro"
    assert (appdata / "memoria" / "financeiro.db").exists()
    # a preferência foi salva
    import json
    cfg = json.loads((appdata / "config.json").read_text(encoding="utf-8"))
    assert cfg["pasta_backup_externa"] == str(drive)
    assert cfg["backup_externo_perguntado"] is True
    # e o backup de teste chegou à pasta do Drive
    assert [f for f in os.listdir(drive) if f.startswith("financeiro_manual_")]


def test_se_o_usuario_recusar_nao_pergunta_de_novo(ambiente, monkeypatch):
    janela = FakeJanela(resposta_pergunta=False, pasta_escolhida=None)
    instalar_webview_falso(monkeypatch, janela)
    rodar_main()
    assert janela.dialogos == []        # nem abriu a escolha de pasta
    import json
    cfg = json.loads((ambiente / "AppData" / "Financeiro" / "config.json").read_text(encoding="utf-8"))
    assert cfg["pasta_backup_externa"] is None and cfg["backup_externo_perguntado"] is True

    # segunda abertura: não pergunta mais
    janela2 = FakeJanela(resposta_pergunta=True, pasta_escolhida=None)
    instalar_webview_falso(monkeypatch, janela2)
    sys.modules.pop("app", None); sys.modules.pop("main", None)
    rodar_main()
    assert janela2.perguntas == []


def test_aberturas_seguintes_ja_copiam_o_backup_de_abertura_para_o_drive(ambiente, monkeypatch):
    drive = ambiente / "Drive" / "B"
    instalar_webview_falso(monkeypatch, FakeJanela(True, str(drive)))
    rodar_main()
    antes = set(os.listdir(drive))

    # segunda abertura (já configurado): o backup de abertura também vai para fora
    import time
    sys.modules.pop("app", None); sys.modules.pop("main", None)
    # força que o backup de abertura não seja ignorado pela regra de "menos de 1 minuto"
    monkeypatch.setenv("FINANCEIRO_BACKUP_EXTRA", "")
    for f in os.listdir(ambiente / "AppData" / "Financeiro" / "memoria" / "backups"):
        p = ambiente / "AppData" / "Financeiro" / "memoria" / "backups" / f
        os.utime(p, (time.time() - 3600, time.time() - 3600))
    instalar_webview_falso(monkeypatch, FakeJanela(True, None))
    rodar_main()
    novos = set(os.listdir(drive)) - antes
    assert any(f.startswith("financeiro_abertura_") for f in novos)


def test_abre_normalmente_se_a_pasta_do_drive_sumiu(ambiente, monkeypatch):
    drive = ambiente / "Drive" / "B"
    instalar_webview_falso(monkeypatch, FakeJanela(True, str(drive)))
    rodar_main()
    # a pasta passa a ser inválida (vira um arquivo)
    import shutil, json
    shutil.rmtree(drive); drive.write_text("agora sou um arquivo")
    sys.modules.pop("app", None); sys.modules.pop("main", None)
    avisos = []
    from desktop import windows
    monkeypatch.setattr(windows, "mostrar_mensagem", lambda t, m: avisos.append(m))
    instalar_webview_falso(monkeypatch, FakeJanela(True, None))
    assert rodar_main() == 0
    assert avisos and "Google Drive" in avisos[0]
    # backup local continua existindo
    assert os.listdir(ambiente / "AppData" / "Financeiro" / "memoria" / "backups")


def test_importa_banco_antigo_da_pasta_do_projeto_se_nao_houver_banco_no_appdata(ambiente, monkeypatch):
    import sqlite3
    from desktop import caminhos
    projeto = ambiente / "projeto"; (projeto / "memoria").mkdir(parents=True)
    con = sqlite3.connect(projeto / "memoria" / "financeiro.db")
    con.execute("create table marca(x)"); con.execute("insert into marca values('antigo')"); con.commit(); con.close()
    monkeypatch.setattr(caminhos, "pasta_do_programa", lambda: str(projeto))
    instalar_webview_falso(monkeypatch, FakeJanela(False, None))
    rodar_main()
    db = ambiente / "AppData" / "Financeiro" / "memoria" / "financeiro.db"
    con = sqlite3.connect(db)
    assert con.execute("select x from marca").fetchall() == [("antigo",)]
    con.close()
    assert (projeto / "memoria" / "financeiro.db").exists()   # o original não foi movido


def test_app_usa_appdata_como_padrao(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.delenv("FINANCEIRO_DATA_DIR", raising=False)
    sys.modules.pop("app", None)
    mod = importlib.import_module("app")
    assert mod.PASTA_MEMORIA == os.path.join(str(tmp_path), "Financeiro", "memoria")
    sys.modules.pop("app", None)
