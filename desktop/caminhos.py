"""Onde ficam os arquivos do programa e seus dados, e as preferências do usuário."""
import json
import os
import shutil
import socket
import sys

from . import NOME_PASTA_DADOS


def empacotado():
    """True quando rodando como .exe (PyInstaller)."""
    return bool(getattr(sys, "frozen", False))


def pasta_do_programa():
    """Pasta onde estão o main.py (ou o .exe)."""
    if empacotado():
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def pasta_de_dados(base_appdata=None):
    """Pasta 'memoria' (banco, backups e logs).

    No Windows é SEMPRE %APPDATA%\\Financeiro\\memoria, seja pelo .exe ou pelo código.
    Assim existe um único banco, e mover/atualizar/reinstalar o programa não afeta os dados.
    Fora do Windows (desenvolvimento), usa a pasta 'memoria' ao lado do programa.
    """
    base = base_appdata or os.environ.get("APPDATA")
    if base:
        return os.path.join(base, NOME_PASTA_DADOS, "memoria")
    return os.path.join(pasta_do_programa(), "memoria")


def pasta_de_configuracao(pasta_dados):
    """As preferências ficam ao lado da pasta 'memoria' (não dentro dela)."""
    return os.path.dirname(pasta_dados)


def candidatos_dados_antigos(pasta_exe):
    """Lugares onde pode estar a 'memoria' da versão que rodava pelo .bat."""
    return [
        os.path.join(pasta_exe, "memoria"),
        os.path.join(pasta_exe, "..", "memoria"),
        os.path.join(pasta_exe, "..", "..", "memoria"),
    ]


def importar_dados_antigos(pasta_dados, candidatos):
    """Primeira abertura: se ainda não há banco, COPIA o banco antigo (nunca move).

    Retorna o caminho de onde copiou, ou None.
    """
    destino_db = os.path.join(pasta_dados, "financeiro.db")
    if os.path.exists(destino_db) and os.path.getsize(destino_db) > 0:
        return None
    for pasta in candidatos:
        origem = os.path.normpath(os.path.join(pasta, "financeiro.db"))
        if os.path.exists(origem) and os.path.getsize(origem) > 0:
            os.makedirs(pasta_dados, exist_ok=True)
            shutil.copy2(origem, destino_db)
            return origem
    return None


def porta_livre():
    """Uma porta qualquer livre no computador (evita conflito e porta previsível)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------- Preferências ----------------
PADRAO = {
    "fechar_para_bandeja": True,
    "pasta_backup_externa": None,
    "backup_externo_perguntado": False,
    "largura": 1320,
    "altura": 860,
    "x": None,
    "y": None,
}


def carregar_config(pasta_config):
    caminho = os.path.join(pasta_config, "config.json")
    config = dict(PADRAO)
    try:
        with open(caminho, "r", encoding="utf-8") as f:
            salvo = json.load(f)
        if isinstance(salvo, dict):
            config.update({k: v for k, v in salvo.items() if k in PADRAO})
    except (OSError, ValueError):
        pass
    return config


def salvar_config(pasta_config, config):
    os.makedirs(pasta_config, exist_ok=True)
    caminho = os.path.join(pasta_config, "config.json")
    temporario = caminho + ".tmp"
    with open(temporario, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    os.replace(temporario, caminho)
