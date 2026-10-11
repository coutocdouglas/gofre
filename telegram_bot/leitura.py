"""Entende o que o OCR leu num print de banco: valor e nome do estabelecimento de cada compra.

Regras da casa (decididas pelo usuário):
  • a data NUNCA é lida da imagem (quem decide é o programa: hoje, ou o que a pessoa escolher);
  • a categoria que o banco mostra é IGNORADA (quem decide é a pessoa).
Só texto de entrada (linhas do OCR), sem imagem nem banco: fácil de testar.
"""
import re
import unicodedata

from .texto import para_valor

_NUM = r"([0-9OoIl][0-9OoIl.,]*[0-9Oo])"              # o OCR às vezes lê 0 como "O" e 1 como "l"/"I"
_MOEDA = r"R\s?[\$S5s]\s?" + _NUM
_RE_VALOR_LINHA = re.compile(r"^(-)?\s*" + _MOEDA + r"$")
_RE_VALOR_SOLTO = re.compile(_MOEDA)
_RE_DATA_CURTA = re.compile(r"^\d{1,2}/\d{1,2}(/\d{2,4})?$")
_RE_HORA = re.compile(r"^\d{1,2}:\d{2}$")
_MESES = {"janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"}
_RE_NOTIF_LOJA = re.compile(r"\bem\s+(.+?)(?=\s+via\s|\.\s*A\s+compra|\s+com\s+o\s+cart|\.?\s*$)", re.IGNORECASE)
MAX_ITENS = 20
_RE_FINAL = re.compile(r"final\s*(\d{4})", re.IGNORECASE)


def sem_acento(s):
    return "".join(c for c in unicodedata.normalize("NFD", str(s)) if unicodedata.category(c) != "Mn").lower()


def valor_do_ocr(num):
    """'110,O0' -> 110.0 ; '21690' (vírgula perdida) -> 216.9 ; devolve None se não der para confiar."""
    t = num.translate(str.maketrans("OoIl", "0011"))
    if "," not in t:
        if not re.fullmatch(r"\d{3,}", t):
            return None
        t = t[:-2] + "," + t[-2:]          # bancos sempre mostram 2 casas: sem vírgula, os 2 últimos dígitos são os centavos
    return para_valor(t)


def limpar_nome(s):
    """O OCR costuma colar palavras ('MoustacheBeams'); separa o que dá e tira o código do país no fim."""
    s = " ".join(str(s).split())
    s = re.sub(r"(?<=[A-Z])l(?=[A-Z*])", "I", s)                  # RAPPl* -> RAPPI*
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)                    # MoustacheBeams -> Moustache Beams
    s = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", s)               # GABBelo -> GAB Belo
    s = re.sub(r"(?<=[A-Za-z])(?=\d{3})|(?<=\d{3})(?=[A-Za-z])", " ", s)
    s = re.sub(r"\s+BRA$", "", s).strip(" -:·,;.")
    s = s[:60]
    return (s[0].upper() + s[1:]) if s else s


def _dica_banco(texto):
    t = sem_acento(texto).replace(" ", "")
    if "cartaoxp" in t or "lancamentosencontrados" in t or ("encontrados" in t and "ordenar" in t):
        return "xp"
    if ("movimentacoes" in t and "parcelamentos" in t) or "compranocredito" in t:
        return "inter"
    return None


def interpretar(largura, linhas):
    """-> {"tipo": "notificacao"|"lista"|"nada", "itens": [{"desc","valor"}], "banco": "xp"|"inter"|None, "final": "7991"|None}"""
    linhas = [l for l in linhas if l.get("texto")]
    juntas = " ".join(l["texto"] for l in sorted(linhas, key=lambda l: (round(l["y"] / 6), l["x0"])))
    banco = _dica_banco(juntas)
    final = None
    m = _RE_FINAL.search(juntas)
    if m:
        final = m.group(1)

    # Notificação: uma frase só ("Compra de R$ 110,00 APROVADA em LOJA via ...")
    n_valores = len(_RE_VALOR_SOLTO.findall(juntas))
    if n_valores == 1 and re.search(r"compra", juntas, re.IGNORECASE) and len(linhas) <= 10:
        v = _RE_VALOR_SOLTO.search(juntas)
        depois = juntas[v.end():]
        loja = _RE_NOTIF_LOJA.search(" " + depois.strip())
        valor = valor_do_ocr(v.group(1))
        if loja and valor:
            return {"tipo": "notificacao", "itens": [{"desc": limpar_nome(loja.group(1)), "valor": valor}], "banco": banco, "final": final}

    # Lista: cada valor "R$ x" ancora uma compra; o nome é o texto à esquerda, na mesma altura
    valores = []
    for l in linhas:
        mm = _RE_VALOR_LINHA.match(l["texto"].replace(" ", " "))
        v = valor_do_ocr(mm.group(2)) if mm else None
        if v:
            valores.append((l, bool(mm.group(1)), v))
    if not valores:
        return {"tipo": "nada", "itens": [], "banco": banco, "final": final}
    estilo_sinal = any(neg for _, neg, _ in valores)             # Inter mostra gastos com "-" (sem "-" seria crédito/estorno)
    tol = 0.032 * largura
    itens = []
    for l, neg, valor in valores:
        if estilo_sinal and not neg:
            continue
        vizinhas = []
        for o in linhas:
            if o is l or abs(o["y"] - l["y"]) > tol or o["x1"] > l["x0"] + 4 or o["x0"] >= l["x0"] - 10:
                continue
            if o["x1"] <= 0.125 * largura:                       # logotipo/ícone da loja (letras soltas, ex.: "9W")
                continue
            t = o["texto"]
            if _RE_DATA_CURTA.match(t) or _RE_HORA.match(t) or sem_acento(t) in _MESES:
                continue
            vizinhas.append(o)
        # junta em linhas (mesma altura) e lê de cima para baixo, da esquerda para a direita
        vizinhas.sort(key=lambda o: o["y"])
        linhas_txt, atual, ref = [], [], None
        for o in vizinhas:
            if ref is None or abs(o["y"] - ref) <= 0.012 * largura:
                atual.append(o)
                ref = o["y"] if ref is None else ref
            else:
                linhas_txt.append(atual)
                atual, ref = [o], o["y"]
        if atual:
            linhas_txt.append(atual)
        nome = " ".join(" ".join(x["texto"] for x in sorted(g, key=lambda x: x["x0"])) for g in linhas_txt)
        nome = limpar_nome(nome)
        if nome:
            itens.append({"desc": nome, "valor": valor})
    if not itens:
        return {"tipo": "nada", "itens": [], "banco": banco, "final": final}
    return {"tipo": "lista", "itens": itens[:MAX_ITENS], "banco": banco, "final": final, "cortado": len(itens) > MAX_ITENS}
