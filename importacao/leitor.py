"""Abre o PDF (com senha, se precisar), extrai o texto e entrega para o leitor do emissor certo."""
import hashlib
import io
import logging

from .emissores import EMISSORES
from .emissores.base import ErroLeitura

# o pdfminer avisa sobre fontes sem informação de tamanho; não é problema
logging.getLogger("pdfminer").setLevel(logging.ERROR)
logging.getLogger("pdfplumber").setLevel(logging.ERROR)

LIMITE_BYTES = 25 * 1024 * 1024


class PdfInvalido(Exception):
    """O arquivo não é um PDF legível."""


class SenhaNecessaria(Exception):
    """O PDF tem senha e nenhuma das senhas conhecidas serviu."""


class SenhaIncorreta(Exception):
    """A senha digitada pelo usuário não abriu o PDF."""


def _eh_erro_de_senha(erro):
    nome = type(erro).__name__
    causa = erro.args[0] if erro.args else None
    return ("PasswordIncorrect" in nome or "PasswordIncorrect" in type(causa).__name__
            or "password" in str(erro).lower())


def _paginas(dados, senha):
    import pdfplumber
    with pdfplumber.open(io.BytesIO(dados), password=senha) as pdf:
        return [(p.extract_text() or "") for p in pdf.pages]


def extrair_paginas(dados, senhas_salvas=(), senha_digitada=None):
    """Retorna (paginas_de_texto, senha_que_abriu_ou_None).

    Ordem: sem senha -> a digitada agora -> as salvas.
    """
    if not dados or not dados.lstrip()[:5].startswith(b"%PDF"):
        raise PdfInvalido("O arquivo não parece ser um PDF.")
    if len(dados) > LIMITE_BYTES:
        raise PdfInvalido("O PDF é grande demais.")

    ordem = [None]
    if senha_digitada:
        ordem.append(senha_digitada)
    ordem += [s for s in senhas_salvas if s != senha_digitada]

    precisou_senha = False
    for senha in ordem:
        try:
            return _paginas(dados, senha), senha
        except Exception as e:  # noqa: BLE001 (pdfminer lança vários tipos)
            if _eh_erro_de_senha(e):
                precisou_senha = True
                continue
            raise PdfInvalido(f"Não consegui abrir o PDF: {e}") from e
    if precisou_senha and senha_digitada:
        raise SenhaIncorreta("A senha informada não abriu o PDF.")
    raise SenhaNecessaria("Este PDF tem senha.")


def ler_fatura(dados, senhas_salvas=(), senha_digitada=None):
    """Lê a fatura inteira. Retorna (fatura, senha_usada, hash_do_arquivo)."""
    paginas, senha_usada = extrair_paginas(dados, senhas_salvas, senha_digitada)
    texto = "\n".join(paginas)
    if not texto.strip():
        raise ErroLeitura("O PDF não tem texto (parece ser uma imagem escaneada).")
    for emissor in EMISSORES:
        if emissor.reconhece(texto):
            fatura = emissor.ler(paginas)
            return fatura, senha_usada, hashlib.sha256(dados).hexdigest()
    raise ErroLeitura("Não reconheci este PDF. Por enquanto só leio faturas dos cartões XP e Inter.")
