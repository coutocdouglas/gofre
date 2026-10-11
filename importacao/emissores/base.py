"""Peças comuns a todos os leitores de fatura (valores, datas, parcelas, tipo da linha)."""
import re

MESES_PT = {"jan": 1, "fev": 2, "mar": 3, "abr": 4, "mai": 5, "jun": 6,
            "jul": 7, "ago": 8, "set": 9, "out": 10, "nov": 11, "dez": 12}

TIPOS = ("compra", "encargo", "estorno", "pagamento")


class ErroLeitura(Exception):
    """O PDF abriu, mas não foi possível entender o conteúdo."""


def valor_br(texto):
    """'3.449,54' -> 3449.54 ; '-4.243,92' -> -4243.92 ; 'R$ 2,80' -> 2.8"""
    t = texto.strip().replace("R$", "").replace(" ", "")
    negativo = t.startswith("-") or t.endswith("-")
    t = t.strip("-+").replace(".", "").replace(",", ".")
    v = float(t)
    return -v if negativo else v


def data_iso_dmy(texto):
    """'10/10/2026' ou '03/12/25' -> '2026-10-10' / '2025-12-03'"""
    d, m, a = texto.strip().split("/")
    a = int(a)
    if a < 100:
        a += 2000
    return f"{a:04d}-{int(m):02d}-{int(d):02d}"


def data_iso_extenso(dia, mes_abrev, ano):
    """('12', 'set', '2026') -> '2026-09-12'"""
    mes = MESES_PT[mes_abrev.lower()[:3]]
    return f"{int(ano):04d}-{mes:02d}-{int(dia):02d}"


_PARCELA = re.compile(r"\s*[-–]?\s*\(?\s*Parcela\s+(\d{1,2})\s*(?:/|de)\s*(\d{1,2})\s*\)?\s*$", re.IGNORECASE)


def extrair_parcela(descricao):
    """'AMAZON BR (Parcela 02 de 09)' -> ('AMAZON BR', 2, 9). Sem parcela -> (desc, None, None)."""
    m = _PARCELA.search(descricao)
    if not m:
        return descricao.strip(), None, None
    return descricao[:m.start()].strip(), int(m.group(1)), int(m.group(2))


_ENCARGO = re.compile(r"^(IOF|JUROS|MULTA|ENCARGO|TARIFA|ANUIDADE)\b", re.IGNORECASE)


def classificar(descricao, valor):
    """pagamento (crédito da fatura anterior) | estorno (outro crédito) | encargo | compra"""
    if valor < 0:
        return "pagamento" if "PAGAMENTO" in descricao.upper() else "estorno"
    if _ENCARGO.match(descricao.strip()):
        return "encargo"
    return "compra"


def montar_linha(seq, secao, data, descricao_original, valor, valor_usd=None):
    descricao, atual, total = extrair_parcela(descricao_original)
    return {
        "seq": seq,
        "secao": secao,
        "data": data,
        "descricao": descricao,
        "descricao_original": descricao_original.strip(),
        "valor": round(valor, 2),
        "valor_usd": valor_usd if valor_usd else None,
        "parcela_atual": atual,
        "total_parcelas": total,
        "tipo": classificar(descricao_original, valor),
    }


def conferir(fatura):
    """Confere se a soma das linhas bate com os totais impressos no PDF.

    Os pagamentos da fatura anterior NÃO entram na conta (os bancos também não os somam).
    """
    linhas = [l for s in fatura["secoes"] for l in s["linhas"]]
    soma = round(sum(l["valor"] for l in linhas if l["tipo"] != "pagamento"), 2)
    total = fatura.get("total_fatura")
    secoes = []
    for i, s in enumerate(fatura["secoes"]):
        soma_s = round(sum(l["valor"] for l in s["linhas"] if l["tipo"] != "pagamento"), 2)
        sub = s.get("subtotal")
        secoes.append({
            "secao": i, "soma": soma_s, "subtotal_pdf": sub,
            "ok": sub is None or abs(soma_s - sub) < 0.01,
        })
    ok_total = total is None or abs(soma - total) < 0.01
    return {
        "ok": ok_total and all(s["ok"] for s in secoes),
        "soma_linhas": soma,
        "total_pdf": total,
        "diferenca": None if total is None else round(soma - total, 2),
        "secoes": secoes,
    }
