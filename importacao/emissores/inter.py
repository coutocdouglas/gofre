"""Leitor da fatura do cartão Inter."""
import re

from .base import ErroLeitura, conferir, data_iso_extenso, montar_linha, valor_br

NOME = "inter"
ROTULO = "Inter"

_SECAO = re.compile(r"^CART[ÃA]O\s+(?P<mascara>\d{4}\*+(?P<final>\d{4}))$")
_TOTAL_SECAO = re.compile(r"^Total CART[ÃA]O\s+\S+\s+R\$\s*(?P<v>[\d.]+,\d{2})$")
_LINHA = re.compile(r"^(?P<dia>\d{2}) de (?P<mes>[a-zç]{3})\.? (?P<ano>\d{4}) (?P<resto>.+)$")
_RESTO = re.compile(r"^(?P<desc>.*?)(?:\s+-)?\s+(?P<mais>\+\s*)?R\$\s*(?P<valor>[\d.]+,\d{2})$")
_CABECALHO = re.compile(r"^\d{4}\*+\d{4}\s+(?P<venc>\d{2}/\d{2}/\d{4})\s+R\$\s*(?P<total>[\d.]+,\d{2})$", re.MULTILINE)
_FIM = "Próxima fatura"


def reconhece(texto):
    return bool(re.search(r"Banco Inter|Super App|Inter One|bancointer", texto)) and "Despesas da fatura" in texto


def ler(paginas):
    texto = "\n".join(paginas)
    cab = _CABECALHO.search(texto)
    if cab:
        d, m, a = cab.group("venc").split("/")
        vencimento, total = f"{a}-{m}-{d}", valor_br(cab.group("total"))
    else:
        venc = re.search(r"(\d{2})/(\d{2})/(\d{4})", texto[texto.find("Vencimento"):] if "Vencimento" in texto else "")
        tot = re.search(r"Total da sua fatura\s*R\$\s*[\d.]+,\d{2}\s*R\$\s*([\d.]+,\d{2})", texto)
        if not venc:
            raise ErroLeitura("Não encontrei a data de vencimento da fatura Inter.")
        vencimento = f"{venc.group(3)}-{venc.group(2)}-{venc.group(1)}"
        total = valor_br(tot.group(1)) if tot else None

    secoes, atual, seq = [], None, 0
    for bruta in texto.split("\n"):
        linha = bruta.strip()
        if linha.startswith(_FIM):
            break
        m = _SECAO.match(linha)
        if m:
            atual = {"rotulo": f"Inter final {m.group('final')}", "final": m.group("final"),
                     "titular": None, "subtotal": None, "linhas": []}
            secoes.append(atual)
            continue
        if atual is None:
            continue
        t = _TOTAL_SECAO.match(linha)
        if t:
            atual["subtotal"] = valor_br(t.group("v"))
            continue
        m = _LINHA.match(linha)
        if not m:
            continue
        r = _RESTO.match(m.group("resto"))
        if not r:
            continue
        valor = valor_br(r.group("valor"))
        if r.group("mais"):          # "+ R$" = crédito
            valor = -valor
        seq += 1
        try:
            data = data_iso_extenso(m.group("dia"), m.group("mes"), m.group("ano"))
        except KeyError:
            continue
        atual["linhas"].append(montar_linha(seq, len(secoes) - 1, data, r.group("desc"), valor))

    secoes = [s for s in secoes if s["linhas"]]
    for i, s in enumerate(secoes):
        for l in s["linhas"]:
            l["secao"] = i
    if not secoes:
        raise ErroLeitura("Não encontrei lançamentos nesta fatura Inter.")

    fatura = {
        "emissor": NOME, "emissor_rotulo": ROTULO,
        "vencimento": vencimento, "mes_fatura": vencimento[:7],
        "fechamento": None, "total_fatura": total, "secoes": secoes,
    }
    fatura["conferencia"] = conferir(fatura)
    return fatura
