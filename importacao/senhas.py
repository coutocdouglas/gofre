"""Senhas dos PDFs de fatura.

Ficam num arquivo LOCAL (senhas_pdf.json, na pasta de configuração do programa), nunca dentro do
código. Na primeira vez, se o arquivo ainda não existe, o programa procura um 'senhas_pdf.json'
ao lado do projeto e COPIA para a pasta de configuração. Se nenhuma senha servir, a tela pede
a senha e ela passa a ser lembrada.
"""
import json
import os
import shutil

ARQUIVO = "senhas_pdf.json"


def caminho(pasta_config):
    return os.path.join(pasta_config, ARQUIVO)


def _ler(arquivo):
    try:
        with open(arquivo, "r", encoding="utf-8") as f:
            dados = json.load(f)
        lista = dados.get("senhas", []) if isinstance(dados, dict) else dados
        return [str(s) for s in lista if str(s).strip()]
    except (OSError, ValueError, AttributeError):
        return []


def _gravar(pasta_config, senhas):
    os.makedirs(pasta_config, exist_ok=True)
    destino = caminho(pasta_config)
    temporario = destino + ".tmp"
    with open(temporario, "w", encoding="utf-8") as f:
        json.dump({"senhas": senhas}, f, ensure_ascii=False, indent=2)
    os.replace(temporario, destino)


def carregar(pasta_config, pastas_busca=()):
    """Lista de senhas conhecidas (na ordem em que serão tentadas)."""
    senhas = _ler(caminho(pasta_config))
    if senhas:
        return senhas
    for pasta in pastas_busca:
        candidato = os.path.normpath(os.path.join(pasta, ARQUIVO))
        achadas = _ler(candidato)
        if achadas:
            try:
                os.makedirs(pasta_config, exist_ok=True)
                shutil.copy2(candidato, caminho(pasta_config))   # copia; nunca move
            except OSError:
                pass
            return achadas
    return []


def adicionar(pasta_config, senha):
    """Guarda uma senha (passa a ser a primeira tentada). Retorna a lista atualizada."""
    senha = str(senha).strip()
    if not senha:
        return _ler(caminho(pasta_config))
    atuais = [s for s in _ler(caminho(pasta_config)) if s != senha]
    novas = [senha] + atuais
    _gravar(pasta_config, novas)
    return novas


def limpar(pasta_config):
    try:
        os.remove(caminho(pasta_config))
    except FileNotFoundError:
        pass
