"""Lê do banco o que o bot precisa (cartões, categorias, pessoas, regras) e monta o lançamento final."""
import json

from importacao import regras as repo_regras
from importacao.servico import somar_meses
from importacao.sugestoes import normalizar

TOLERANCIA = 0.011


def contexto(conectar):
    with conectar() as con:
        cartoes = [dict(r) for r in con.execute("SELECT id, nome, fechamento FROM cartoes ORDER BY nome")]
        subs = [dict(r) for r in con.execute("SELECT id, nome, cat_id FROM subcategorias ORDER BY nome")]
        categorias = []
        for r in con.execute("SELECT id, nome FROM categorias ORDER BY nome"):
            c = dict(r)
            c["subcategorias"] = [{"id": s["id"], "nome": s["nome"]} for s in subs if s["cat_id"] == c["id"]]
            categorias.append(c)
        pessoas = [dict(r) for r in con.execute("SELECT id, nome, tipo FROM pessoas")]
        pessoas.sort(key=lambda p: (p["tipo"] != "principal", p["nome"].lower()))
        regras = repo_regras.listar(con)
    return {"cartoes": cartoes, "categorias": categorias, "pessoas": pessoas, "regras": regras}


def mes_da_fatura(data_iso, cartao):
    """Mesma regra da tela: compra no dia de fechamento ou depois cai na fatura do mês seguinte;
    cartão sem dia de fechamento cadastrado: sempre o mês seguinte."""
    ano, mes, dia = int(data_iso[:4]), int(data_iso[5:7]), int(data_iso[8:10])
    try:
        fechamento = int(cartao.get("fechamento") or 0)
    except (TypeError, ValueError):
        fechamento = 0
    base = f"{ano:04d}-{mes:02d}"
    if fechamento and dia < fechamento:
        return base
    return somar_meses(base, 1)


def dividir(valor, partes):
    """Divide em reais sem perder centavos (o resto vai para os primeiros)."""
    centavos = round(valor * 100)
    base, resto = divmod(centavos, partes)
    return [round((base + (1 if i < resto else 0)) / 100, 2) for i in range(partes)]


def valores_da_divisao(valor, ids, pct=None):
    """ids: pessoas escolhidas. pct: {pessoa_id: %} vindo de uma regra salva (opcional)."""
    if pct and set(pct) == set(ids) and abs(sum(pct.values()) - 100) < 0.5:
        centavos = round(valor * 100)
        partes = {i: int(centavos * pct[i] / 100) for i in ids}
        sobra = centavos - sum(partes.values())
        for i in ids:
            if sobra <= 0:
                break
            partes[i] += 1
            sobra -= 1
        return [{"pessoa_id": i, "valor": round(partes[i] / 100, 2)} for i in ids]
    return [{"pessoa_id": i, "valor": v} for i, v in zip(ids, dividir(valor, len(ids)))]


def parecidos(conectar, cartao_id, valor_parcela, data_iso):
    """Lançamentos já existentes no mesmo cartão com o mesmo valor e data próxima (aviso de duplicidade)."""
    from datetime import date
    try:
        alvo = date.fromisoformat(data_iso)
    except ValueError:
        return []
    achados = []
    with conectar() as con:
        for r in con.execute("SELECT desc, valor_parcela, data_compra, mes_fatura, parcela_atual, total_parcelas "
                             "FROM faturas WHERE cartao_id = ?", (cartao_id,)):
            if abs(float(r["valor_parcela"]) - valor_parcela) > TOLERANCIA:
                continue
            try:
                d = date.fromisoformat(r["data_compra"])
            except (TypeError, ValueError):
                continue
            if abs((d - alvo).days) <= 3:
                achados.append(dict(r))
    return achados[:3]


def parecidos_lista(conectar, valor, desc, hoje=None, dias=90):
    """Para prints sem data: já existe lançamento recente com o mesmo valor e nome parecido? (aviso de duplicidade)"""
    from datetime import date, timedelta
    corte = ((hoje or date.today()) - timedelta(days=dias)).isoformat()
    chave = normalizar(desc)
    achados = []
    with conectar() as con:
        for r in con.execute("SELECT desc, valor_parcela, data_compra, mes_fatura FROM faturas WHERE data_compra >= ?", (corte,)):
            if abs(float(r["valor_parcela"]) - valor) > TOLERANCIA:
                continue
            outro = normalizar(r["desc"])
            if chave and outro and (chave[:5] in outro or outro[:5] in chave):
                achados.append(dict(r))
    return achados[:2]


_GENERICAS = {"pix", "compra", "compras", "pagamento", "cred", "debito", "credito", "parcela", "boleto", "tarifa", "transferencia", "vista", "avista", "prazo", "saque", "fatura", "pagto", "compra"}


def _chave(desc):
    """Primeira palavra 'de verdade' do nome (sem prefixos de gateway nem palavras genéricas), para casar nomes parecidos."""
    for t in normalizar(desc).split():
        if len(t) >= 4 and t not in _GENERICAS and not t.isdigit():
            return t
    return ""


def sugerir_do_historico(conectar, desc):
    """Sem regra salva, olha o que você já classificou antes para o mesmo estabelecimento (faturas lançadas/importadas)
    e sugere a categoria mais usada. -> {"cat_id","subcat_id","divisao":[{pessoa_id,pct}],"n"} ou None."""
    chave = _chave(desc)
    if not chave:
        return None
    from collections import Counter
    contagem, exemplos = Counter(), {}
    with conectar() as con:
        for r in con.execute("SELECT desc, cat_id, subcat_id, divisao FROM faturas WHERE cat_id IS NOT NULL AND cat_id <> '' ORDER BY data_compra DESC"):
            outro = normalizar(r["desc"]).replace(" ", "")
            if chave not in outro and _chave(r["desc"]) != chave:
                continue
            k = (r["cat_id"], r["subcat_id"] or None)
            contagem[k] += 1
            exemplos.setdefault(k, r["divisao"])          # a primeira é a mais recente
    if not contagem:
        return None
    (cat_id, subcat_id), n = contagem.most_common(1)[0]
    divisao = []
    try:
        itens = json.loads(exemplos[(cat_id, subcat_id)] or "[]")
        total = sum(float(d.get("valor", 0)) for d in itens) or 0
        if total > 0:
            divisao = [{"pessoa_id": d["pessoa_id"], "pct": round(float(d["valor"]) / total * 100, 2)} for d in itens if d.get("pessoa_id")]
    except (ValueError, TypeError, KeyError):
        divisao = []
    return {"cat_id": cat_id, "subcat_id": subcat_id, "divisao": divisao, "n": n, "fixo": False}


def montar_payload(rasc, ctx, valor_parcela):
    """Converte o rascunho aprovado no formato que o sistema de importação já sabe gravar."""
    cartao = ctx["cartoes"][rasc["cartao_i"]]
    cat = ctx["categorias"][rasc["cat_i"]]
    sub = cat["subcategorias"][rasc["sub_i"]] if rasc.get("sub_i") is not None else None
    ids = [ctx["pessoas"][i]["id"] for i in rasc["pessoas"]]
    divisao = valores_da_divisao(valor_parcela, ids, rasc.get("div_pct"))
    n = rasc["parcelas"]
    item = {
        "desc": rasc["desc"], "cartao_id": cartao["id"], "data": rasc["data"], "valor": valor_parcela,
        "parcela_atual": 1, "total_parcelas": n, "modo": "esta_e_seguintes" if n > 1 else "so_esta",
        "cat_id": cat["id"], "subcat_id": sub["id"] if sub else None, "divisao": divisao,
        "fixo": bool(rasc.get("fixo")), "regra_id": rasc.get("regra_id"),
    }
    payload = {"mes_fatura": mes_da_fatura(rasc["data"], cartao), "itens": [item]}
    if rasc.get("lembrar"):
        total = sum(d["valor"] for d in divisao) or 1
        payload["regras"] = [{
            "padrao": normalizar(rasc["desc"]), "nome": rasc["desc"], "cat_id": cat["id"],
            "subcat_id": item["subcat_id"], "fixo": item["fixo"],
            "divisao": [{"pessoa_id": d["pessoa_id"], "pct": round(d["valor"] / total * 100, 2)} for d in divisao],
        }]
    return payload
