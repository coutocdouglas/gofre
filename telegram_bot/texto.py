"""Entende o texto digitado ("uber 45,90", "notebook 3000 em 10x", "mercado 120 ontem") e formata valores."""
import re
from datetime import date, timedelta

MAX_PARCELAS = 60

_RE_PARCELAS = re.compile(r"(?:\bem\s+)?\b(\d{1,2})\s*x\b", re.IGNORECASE)
_RE_DATA = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b")
_RE_NUMERO = re.compile(r"(?<![\w/])(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\w/])", re.IGNORECASE)


def para_valor(txt):
    """'1.234,56' -> 1234.56 ; '45,9' -> 45.9 ; '45.90' -> 45.9 ; '3.000' -> 3000.0"""
    t = re.sub(r"(?i)r\$", "", txt).strip()
    if "," in t:
        t = t.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(?:\.\d{3})+", t):
        t = t.replace(".", "")
    try:
        return round(float(t), 2)
    except ValueError:
        return None


def moeda(v):
    s = f"{abs(float(v)):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return ("-" if v < 0 else "") + "R$ " + s


def dia_mes(iso):
    return f"{iso[8:10]}/{iso[5:7]}"


def mes_rotulo(ym):
    nomes = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]
    return f"{nomes[int(ym[5:7]) - 1]}/{ym[:4]}"


def _analisar(texto, hoje):
    """Tira do texto as partes que achar. -> (partes, erro). 'valor' fica None se não houver número;
    'desc' fica vazio se não sobrar nome. As chaves tem_data/tem_parcelas dizem o que a pessoa escreveu."""
    t = " " + " ".join((texto or "").split()) + " "

    parcelas, tem_parcelas = 1, False
    m = _RE_PARCELAS.search(t)
    if m:
        parcelas, tem_parcelas = int(m.group(1)), True
        t = t[:m.start()] + " " + t[m.end():]
    if parcelas < 1 or parcelas > MAX_PARCELAS:
        return None, f"O número de parcelas precisa ficar entre 1 e {MAX_PARCELAS}."

    data, tem_data = hoje, False
    m = _RE_DATA.search(t)
    if m:
        dia, mes = int(m.group(1)), int(m.group(2))
        ano = int(m.group(3)) if m.group(3) else hoje.year
        if ano < 100:
            ano += 2000
        try:
            data = date(ano, mes, dia)
        except ValueError:
            return None, "Não entendi a data. Use dia/mês, por exemplo 05/10."
        if not m.group(3) and data > hoje + timedelta(days=60):
            data = date(ano - 1, mes, dia)
        tem_data = True
        t = t[:m.start()] + " " + t[m.end():]
    else:
        for palavra, dias in (("anteontem", 2), ("ontem", 1), ("hoje", 0)):
            mm = re.search(rf"\b{palavra}\b", t, re.IGNORECASE)
            if mm:
                data, tem_data = hoje - timedelta(days=dias), True
                t = t[:mm.start()] + " " + t[mm.end():]
                break

    valor = None
    achados = list(_RE_NUMERO.finditer(t))
    if achados:
        com_decimal = [a for a in achados if re.search(r"[.,]\d{1,2}$", a.group(1)) or "r$" in a.group(0).lower()]
        escolhido = (com_decimal or achados)[-1]
        valor = para_valor(escolhido.group(0))
        if not valor or valor <= 0:
            return None, "O valor precisa ser maior que zero."
        t = t[:escolhido.start()] + " " + t[escolhido.end():]

    desc = re.sub(r"\s+", " ", t).strip(" -:·,;")
    desc = re.sub(r"(?i)^(de|do|da|no|na|em)\s+", "", desc).strip()
    desc = desc[:60]
    if desc:
        desc = desc[0].upper() + desc[1:]
    return {"desc": desc, "valor": valor, "parcelas": parcelas, "data": data.isoformat(),
            "tem_data": tem_data, "tem_parcelas": tem_parcelas}, None


def entender(texto, hoje=None):
    """Retorna ({desc, valor, parcelas, data}, None) ou (None, mensagem_de_erro)."""
    p, erro = _analisar(texto, hoje or date.today())
    if erro:
        return None, erro
    if p["valor"] is None:
        return None, "Não achei o valor. Exemplo: 45,90 uber"
    if not p["desc"]:
        return None, "Falta o nome do gasto. Exemplo: 45,90 uber"
    return {k: p[k] for k in ("desc", "valor", "parcelas", "data")}, None


def entender_parcial(texto, hoje=None):
    """Para correções e legendas: devolve só o que a pessoa escreveu (nome, valor, parcelas, data)."""
    p, erro = _analisar(texto, hoje or date.today())
    if erro:
        return None, erro
    achado = {}
    if p["desc"]:
        achado["desc"] = p["desc"]
    if p["valor"] is not None:
        achado["valor"] = p["valor"]
    if p["tem_parcelas"]:
        achado["parcelas"] = p["parcelas"]
    if p["tem_data"]:
        achado["data"] = p["data"]
    return achado, None
