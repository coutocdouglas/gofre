"""Sugestões para cada linha do PDF: já está lançada? tem regra salva? qual nome sugerir?

Nada aqui altera dados. O usuário sempre revisa e decide.
"""
import re
import unicodedata
from datetime import date
from difflib import SequenceMatcher

TOLERANCIA_VALOR = 0.011
DIAS_PROVAVEL = 5
PADRAO_MINIMO = 3


def normalizar(texto):
    """'DL *UBERRIDES' -> 'dl uberrides' (sem acento, minúsculas, só letras/números)."""
    t = unicodedata.normalize("NFKD", texto or "")
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", t)).strip()


_PREFIXO_GATEWAY = re.compile(r"^(?:DL|MP|PG|EC|IFD|ZP|MLP|BR1|EBN|BMB|CP)\s*\*\s*", re.IGNORECASE)


def nome_sugerido(descricao):
    """Sugestão de nome mais legível (o usuário pode trocar). Ex.: 'DL *UBERRIDES' -> 'Uberrides'."""
    d = _PREFIXO_GATEWAY.sub("", (descricao or "").strip())
    d = re.sub(r"\s+", " ", d).strip(" *-")
    if d.isupper():
        d = d.title()
    return (d or descricao or "").strip()[:60]


def chave_agrupamento(descricao):
    """Linhas com a mesma chave são tratadas como 'a mesma coisa' (ex.: várias corridas de Uber)."""
    return normalizar(descricao)


# ---------------- Regras salvas ----------------

def aplicar_regra(descricao, regras):
    """Regra cujo padrão aparece na descrição; se houver várias, vale a de padrão mais específico."""
    n = normalizar(descricao)
    candidatas = [r for r in regras if r.get("padrao") and r["padrao"] in n]
    return max(candidatas, key=lambda r: len(r["padrao"])) if candidatas else None


# ---------------- Já lançado? ----------------

def _meses_entre(a, b):
    return (int(a[:4]) - int(b[:4])) * 12 + int(a[5:7]) - int(b[5:7])


def _dias_entre(a, b):
    try:
        return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)
    except (ValueError, TypeError):
        return 9999


def _mesmo_valor(f, linha):
    return abs(float(f["valor_parcela"]) - linha["valor"]) <= TOLERANCIA_VALOR


def _pontuar(f, linha):
    """Desempate: mesma data de compra e descrição parecida valem mais."""
    p = 0.0
    if f.get("data_compra") == linha["data"]:
        p += 2
    p += SequenceMatcher(None, normalizar(f.get("desc", "")), normalizar(linha["descricao"])).ratio()
    return p


def _melhor(candidatos, linha):
    return max(candidatos, key=lambda f: _pontuar(f, linha)) if candidatos else None


def _parcelada(linha):
    return bool(linha.get("parcela_atual") and linha.get("total_parcelas") and linha["total_parcelas"] > 1)


def _forte(linha, cartao_id, mes, livres):
    base = [f for f in livres if f["cartao_id"] == cartao_id and _mesmo_valor(f, linha)]
    if _parcelada(linha):
        return _melhor([f for f in base if f["mes_fatura"] == mes
                        and f["parcela_atual"] == linha["parcela_atual"]
                        and f["total_parcelas"] == linha["total_parcelas"]], linha)
    return _melhor([f for f in base if f["mes_fatura"] == mes and f["total_parcelas"] == 1
                    and f.get("data_compra") == linha["data"]], linha)


def _provavel(linha, cartao_id, mes, livres):
    base = [f for f in livres if f["cartao_id"] == cartao_id and _mesmo_valor(f, linha)
            and abs(_meses_entre(f["mes_fatura"], mes)) <= 1]
    if _parcelada(linha):
        return _melhor([f for f in base if f["parcela_atual"] == linha["parcela_atual"]
                        and f["total_parcelas"] == linha["total_parcelas"]], linha)
    return _melhor([f for f in base if f["total_parcelas"] == 1
                    and _dias_entre(f.get("data_compra"), linha["data"]) <= DIAS_PROVAVEL], linha)


def _resumo_existente(f):
    return {k: f.get(k) for k in ("id", "desc", "mes_fatura", "parcela_atual", "total_parcelas",
                                  "valor_parcela", "data_compra", "cartao_id")}


def montar_sugestoes(fatura, mapeamento, mes_fatura, existentes, regras, pessoas):
    """Retorna uma sugestão para cada linha do PDF.

    fatura      : resultado do leitor (seções com linhas)
    mapeamento  : {indice_da_secao: cartao_id do sistema}
    existentes  : faturas já lançadas no sistema (lista de dicts)
    """
    principal = next((p["id"] for p in pessoas if p.get("tipo") == "principal"), None)
    divisao_padrao = [{"pessoa_id": principal, "pct": 100.0}] if principal else []

    itens = []
    for i, secao in enumerate(fatura["secoes"]):
        cartao_id = mapeamento.get(str(i)) or mapeamento.get(i)
        for linha in secao["linhas"]:
            itens.append((linha, cartao_id))

    achados = {}                       # seq -> (nivel, fatura existente)
    consumidos = set()
    for nivel, buscar in (("forte", _forte), ("provavel", _provavel)):
        for linha, cartao_id in itens:
            if linha["seq"] in achados or linha["tipo"] == "pagamento" or not cartao_id:
                continue
            livres = [f for f in existentes if f["id"] not in consumidos]
            achada = buscar(linha, cartao_id, mes_fatura, livres)
            if achada:
                achados[linha["seq"]] = (nivel, achada)
                consumidos.add(achada["id"])

    resultado = []
    for linha, cartao_id in itens:
        regra = aplicar_regra(linha["descricao_original"], regras) or aplicar_regra(linha["descricao"], regras)
        nivel, existente = achados.get(linha["seq"], (None, None))
        avisos = []
        if linha["tipo"] == "pagamento":
            acao, motivo = "ignorar", "pagamento"
        elif nivel == "forte":
            acao, motivo = "ignorar", "ja_lancada"
        elif nivel == "provavel":
            acao, motivo = "ignorar", "provavel"
        else:
            acao, motivo = "lancar", "nova"
        if linha["tipo"] in ("encargo", "estorno"):
            avisos.append(linha["tipo"])
        if linha.get("valor_usd"):
            avisos.append("exterior")
        modo = "so_esta"
        if _parcelada(linha) and linha["parcela_atual"] < linha["total_parcelas"]:
            modo = "esta_e_seguintes"
        if _parcelada(linha) and linha["parcela_atual"] > 1 and motivo == "nova":
            avisos.append("parcela_sem_historico")
        resultado.append({
            "seq": linha["seq"],
            "acao": acao,
            "motivo": motivo,
            "nivel": nivel,
            "existente": _resumo_existente(existente) if existente else None,
            "nome": regra["nome"] if regra else nome_sugerido(linha["descricao"]),
            "cat_id": regra.get("cat_id") if regra else None,
            "subcat_id": regra.get("subcat_id") if regra else None,
            "divisao_pct": (regra.get("divisao") or divisao_padrao) if regra else divisao_padrao,
            "regra_id": regra["id"] if regra else None,
            "fixo": bool(regra.get("fixo")) if regra else False,
            "modo": modo,
            "avisos": avisos,
        })
    return resultado
