import os
import sys
import socket
import time

import pytest

from desktop import caminhos, windows
from desktop.instancia import InstanciaUnica
from desktop.servidor import aguardar_servidor, iniciar_servidor

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---------------- Onde ficam os dados ----------------

def test_sem_appdata_usa_a_pasta_memoria_do_projeto(monkeypatch):
    monkeypatch.delenv("APPDATA", raising=False)
    assert caminhos.pasta_de_dados() == os.path.join(RAIZ, "memoria")


def test_no_windows_os_dados_sao_sempre_do_appdata_mesmo_rodando_pelo_codigo(monkeypatch, tmp_path):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert not getattr(sys, "frozen", False)
    assert caminhos.pasta_de_dados() == os.path.join(str(tmp_path), "Financeiro", "memoria")


def test_modo_exe_usa_appdata(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    esperado = os.path.join(str(tmp_path), "Financeiro", "memoria")
    assert caminhos.pasta_de_dados(base_appdata=str(tmp_path)) == esperado


def test_configuracao_fica_ao_lado_da_memoria_nao_dentro():
    assert caminhos.pasta_de_configuracao(os.path.join("x", "Financeiro", "memoria")) == os.path.join("x", "Financeiro")


# ---------------- Importar dados antigos ----------------

def test_importa_banco_antigo_copiando_sem_mover(tmp_path):
    antiga = tmp_path / "projeto" / "memoria"; antiga.mkdir(parents=True)
    (antiga / "financeiro.db").write_bytes(b"dados importantes")
    destino = tmp_path / "appdata" / "memoria"
    origem = caminhos.importar_dados_antigos(str(destino), [str(antiga)])
    assert origem is not None
    assert (destino / "financeiro.db").read_bytes() == b"dados importantes"
    assert (antiga / "financeiro.db").exists()  # o original continua lá


def test_nao_sobrescreve_banco_ja_existente(tmp_path):
    antiga = tmp_path / "antiga"; antiga.mkdir()
    (antiga / "financeiro.db").write_bytes(b"VELHO")
    destino = tmp_path / "dados"; destino.mkdir()
    (destino / "financeiro.db").write_bytes(b"ATUAL")
    assert caminhos.importar_dados_antigos(str(destino), [str(antiga)]) is None
    assert (destino / "financeiro.db").read_bytes() == b"ATUAL"


def test_sem_banco_antigo_nao_faz_nada(tmp_path):
    assert caminhos.importar_dados_antigos(str(tmp_path / "dados"), [str(tmp_path / "nada")]) is None
    assert not (tmp_path / "dados" / "financeiro.db").exists()


def test_procura_a_memoria_em_pastas_proximas_ao_exe():
    c = [os.path.normpath(p) for p in caminhos.candidatos_dados_antigos(os.path.join("a", "dist", "Financeiro"))]
    assert os.path.normpath(os.path.join("a", "dist", "Financeiro", "memoria")) in c
    assert os.path.normpath(os.path.join("a", "memoria")) in c   # raiz do projeto, onde estava no .bat


def test_porta_livre_e_utilizavel():
    p = caminhos.porta_livre()
    s = socket.socket(); s.bind(("127.0.0.1", p)); s.close()


# ---------------- Preferências ----------------

def test_config_padrao_quando_nao_existe(tmp_path):
    assert caminhos.carregar_config(str(tmp_path)) == caminhos.PADRAO


def test_config_salva_e_le(tmp_path):
    cfg = caminhos.carregar_config(str(tmp_path))
    cfg.update({"largura": 1000, "fechar_para_bandeja": False})
    caminhos.salvar_config(str(tmp_path), cfg)
    lido = caminhos.carregar_config(str(tmp_path))
    assert lido["largura"] == 1000 and lido["fechar_para_bandeja"] is False


def test_config_corrompida_volta_ao_padrao(tmp_path):
    (tmp_path / "config.json").write_text("{isto nao e json", encoding="utf-8")
    assert caminhos.carregar_config(str(tmp_path)) == caminhos.PADRAO


def test_config_ignora_chaves_desconhecidas(tmp_path):
    (tmp_path / "config.json").write_text('{"largura": 900, "hack": 1}', encoding="utf-8")
    cfg = caminhos.carregar_config(str(tmp_path))
    assert cfg["largura"] == 900 and "hack" not in cfg


# ---------------- Só uma cópia aberta ----------------

def porta_teste():
    return caminhos.porta_livre()


def test_segunda_copia_nao_consegue_abrir_e_avisa_a_primeira():
    porta = porta_teste()
    primeira, segunda = InstanciaUnica(porta), InstanciaUnica(porta)
    assert primeira.tentar_adquirir() is True
    recebidos = []
    primeira.escutar(lambda: recebidos.append("mostrar"))
    assert segunda.tentar_adquirir() is False
    assert segunda.avisar_instancia_existente() is True
    for _ in range(40):
        if recebidos:
            break
        time.sleep(0.05)
    assert recebidos == ["mostrar"]
    primeira.liberar()


def test_depois_de_fechar_a_primeira_outra_pode_abrir():
    porta = porta_teste()
    a = InstanciaUnica(porta)
    assert a.tentar_adquirir()
    a.liberar()
    b = InstanciaUnica(porta)
    assert b.tentar_adquirir()
    b.liberar()


def test_fechar_a_primeira_libera_a_porta_mesmo_com_a_escuta_ativa():
    porta = porta_teste()
    a = InstanciaUnica(porta)
    assert a.tentar_adquirir()
    a.escutar(lambda: None)
    time.sleep(0.2)
    a.liberar()
    time.sleep(0.2)
    b = InstanciaUnica(porta)
    assert b.tentar_adquirir()
    b.liberar()


def test_avisar_sem_ninguem_aberto_retorna_falso():
    assert InstanciaUnica(porta_teste()).avisar_instancia_existente() is False


def test_mensagem_estranha_nao_mostra_a_janela():
    porta = porta_teste()
    a = InstanciaUnica(porta)
    a.tentar_adquirir()
    chamadas = []
    a.escutar(lambda: chamadas.append(1))
    with socket.create_connection(("127.0.0.1", porta), timeout=2) as c:
        c.sendall(b"lixo")
    time.sleep(0.3)
    assert chamadas == []
    a.liberar()


# ---------------- Servidor interno ----------------

def test_servidor_interno_sobe_serve_a_pagina_e_para(appmod):
    porta = caminhos.porta_livre()
    srv = iniciar_servidor(appmod.app, porta)
    try:
        assert aguardar_servidor(porta, tentativas=20, intervalo=0.1)
        import urllib.request
        html = urllib.request.urlopen(f"http://127.0.0.1:{porta}/", timeout=3).read().decode("utf-8")
        assert "Gofre" in html
    finally:
        srv.shutdown()


def test_servidor_escuta_somente_neste_computador(appmod):
    porta = caminhos.porta_livre()
    srv = iniciar_servidor(appmod.app, porta)
    try:
        assert srv.server_address[0] == "127.0.0.1"
    finally:
        srv.shutdown()


# ---------------- Windows (partes seguras de testar em qualquer sistema) ----------------

def test_comando_de_inicio_com_windows_abre_minimizado():
    cmd = windows.comando_de_inicio(r"C:\Users\Eu\Financeiro\Financeiro.exe")
    assert cmd == r'"C:\Users\Eu\Financeiro\Financeiro.exe" --minimizado'


@pytest.mark.skipif(sys.platform.startswith("win"), reason="só faz sentido fora do Windows")
def test_fora_do_windows_as_funcoes_nao_quebram():
    assert windows.webview2_instalado() is True
    assert windows.inicio_com_windows_ativo() is False
    assert windows.definir_inicio_com_windows(True) is False


# ---------------- Arquivos de construção coerentes ----------------

def ler(nome):
    with open(os.path.join(RAIZ, nome), encoding="utf-8") as f:
        return f.read()


def test_spec_inclui_as_pastas_que_o_programa_precisa():
    spec = ler("financeiro.spec")
    for pasta in ("templates", "static", "assets"):
        assert f"('{pasta}', '{pasta}')" in spec
        assert os.path.isdir(os.path.join(RAIZ, pasta))
    assert "console=False" in spec and "assets/icone.ico" in spec


def test_nomes_do_exe_batem_entre_spec_instalador_e_atalho():
    assert "name='Financeiro'" in ler("financeiro.spec")
    assert r"dist\Financeiro\*" in ler("instalador.iss")
    assert r"dist\Financeiro\Financeiro.exe" in ler("criar_atalho.bat")
    assert r"dist\Financeiro\Financeiro.exe" in ler("construir_programa.bat")


def test_icone_existe_nos_formatos_necessarios():
    for nome in ("icone.ico", "icone.png"):
        assert os.path.getsize(os.path.join(RAIZ, "assets", nome)) > 1000


def test_instalador_nao_apaga_dados_e_registra_inicio_minimizado():
    iss = ler("instalador.iss")
    assert "--minimizado" in iss
    assert "memoria" not in iss.split("[Files]")[1].split("[Icons]")[0]  # dados fora do instalador


def test_main_importa_sem_abrir_nada():
    import importlib
    m = importlib.import_module("main")
    assert callable(m.main)


def test_bats_nao_tem_acentos_que_quebram_o_prompt():
    for nome in ("Abrir_Como_Programa.bat", "construir_programa.bat", "criar_atalho.bat", "construir_instalador.bat"):
        ler(nome).encode("ascii")  # levanta erro se houver caractere fora do ASCII
