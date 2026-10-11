"""Leitor da fatura do cartão XP (Visa Infinite etc.)."""
import re

from .base import ErroLeitura, conferir, data_iso_dmy, montar_linha, valor_br

NOME = "xp"
ROTULO = "XP"

_SECAO = re.compile(r"^(?P<titular>.+?)\s+-\s+(?P<mascara>\d{4}\*+(?P<final>\d{4}))$")
_LINHA = re.compile(
    r"^(?P<data>\d{2}/\d{2}/\d{2})\s+(?P<desc>.+?)\s+(?:R\$\s*)?(?P<valor>-?[\d.]+,\d{2})"
    r"(?:\s+(?P<usd>[\d.]+,\d{2}))?$")
_SUBTOTAL = re.compile(r"^Subtotal\s+(?P<v>[\d.]+,\d{2})$")
_FIM = ("Encargos da fatura", "As informações deste demonstrativo")


def reconhece(texto):
    return bool(re.search(r"Banco XP|Cart[aã]o XP|App XP", texto)) and "Data Descrição R$ US$" in texto


def _resumo(texto):
    venc = re.search(r"Vencimento\s+Pagamento total\s+Pagamento m[ií]nimo\s+(\d{2}/\d{2}/\d{4})\s+R\$\s*([\d.]+,\d{2})", texto)
    if not venc:
        venc = re.search(r"Vencimento\s+(\d{2}/\d{2}/\d{4})", texto)
    if not venc:
        raise ErroLeitura("Não encontrei a data de vencimento da fatura XP.")
    total = re.search(r"Valor total devido\s+([\d.]+,\d{2})", texto)
    if total:
        total = valor_br(total.group(1))
    elif venc.lastindex and venc.lastindex >= 2:
        total = valor_br(venc.group(2))
    else:
        total = None
    fech = re.search(r"Fatura fechada em[^\n]*\n\s*(\d{2}/\d{2}/\d{4})", texto)
    return data_iso_dmy(venc.group(1)), total, (data_iso_dmy(fech.group(1)) if fech else None)


def ler(paginas):
    texto = "\n".join(paginas)
    vencimento, total, fechamento = _resumo(texto)

    secoes, atual, seq = [], None, 0
    for bruta in texto.split("\n"):
        linha = bruta.strip()
        if any(linha.startswith(f) for f in _FIM):
            break
        m = _SECAO.match(linha)
        if m and not _LINHA.match(linha):
            atual = {"rotulo": f"XP final {m.group('final')}", "final": m.group("final"),
                     "titular": m.group("titular").strip(), "subtotal": None, "linhas": []}
            secoes.append(atual)
            continue
        if atual is None:
            continue
        sub = _SUBTOTAL.match(linha)
        if sub:
            atual["subtotal"] = valor_br(sub.group("v"))
            continue
        m = _LINHA.match(linha)
        if m:
            seq += 1
            usd = valor_br(m.group("usd")) if m.group("usd") else None
            atual["linhas"].append(montar_linha(
                seq, len(secoes) - 1, data_iso_dmy(m.group("data")), m.group("desc"),
                valor_br(m.group("valor")), usd))

    secoes = [s for s in secoes if s["linhas"]]
    for i, s in enumerate(secoes):
        for l in s["linhas"]:
            l["secao"] = i
    if not secoes:
        raise ErroLeitura("Não encontrei lançamentos nesta fatura XP.")

    fatura = {
        "emissor": NOME, "emissor_rotulo": ROTULO,
        "vencimento": vencimento, "mes_fatura": vencimento[:7],
        "fechamento": fechamento, "total_fatura": total, "secoes": secoes,
    }
    fatura["conferencia"] = conferir(fatura)
    return fatura
