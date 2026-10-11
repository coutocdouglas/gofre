"""Grava a importação revisada pelo usuário. Tudo numa única transação: ou entra tudo, ou nada."""
import json
import re
import time
import uuid
from datetime import datetime

from . import regras as repo_regras

TOLERANCIA_DIVISAO = 0.02
MAX_PARCELAS = 120


class ErroImportacao(Exception):
    """Dados inválidos enviados pela tela. A mensagem é mostrada ao usuário."""


def somar_meses(mes, qtd):
    """'2026-11' + 3 -> '2027-02'"""
    ano, m = int(mes[:4]), int(mes[5:7])
    total = ano * 12 + (m - 1) + qtd
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def _numero(valor, campo):
    try:
        return float(valor)
    except (TypeError, ValueError):
        raise ErroImportacao(f"Valor inválido em '{campo}'.")


def _validar_item(con, item, cartoes, categorias, subcategorias, pessoas, ordem, compras=None):
    compras = compras or {}
    rotulo = f"Linha {ordem}"
    desc = (item.get("desc") or "").strip()
    if not desc:
        raise ErroImportacao(f"{rotulo}: falta o nome do lançamento.")
    if item.get("cartao_id") not in cartoes:
        raise ErroImportacao(f"{rotulo} ({desc}): escolha o cartão.")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", item.get("data") or ""):
        raise ErroImportacao(f"{rotulo} ({desc}): data inválida.")
    valor = round(_numero(item.get("valor"), "valor"), 2)
    atual = int(item.get("parcela_atual") or 1)
    total = int(item.get("total_parcelas") or 1)
    if total < 1 or total > MAX_PARCELAS or atual < 1 or atual > total:
        raise ErroImportacao(f"{rotulo} ({desc}): parcela {atual}/{total} inválida.")

    cat_id = item.get("cat_id") or None
    subcat_id = item.get("subcat_id") or None
    if cat_id and cat_id not in categorias:
        cat_id = None
    if subcat_id and (not cat_id or subcategorias.get(subcat_id) != cat_id):
        subcat_id = None

    divisao = []
    for d in item.get("divisao") or []:
        if d.get("pessoa_id") not in pessoas:
            raise ErroImportacao(f"{rotulo} ({desc}): pessoa da divisão não existe mais.")
        divisao.append({"pessoa_id": d["pessoa_id"], "valor": round(_numero(d.get("valor"), "divisão"), 2)})
    if not divisao:
        raise ErroImportacao(f"{rotulo} ({desc}): defina de quem é este gasto.")
    if abs(sum(d["valor"] for d in divisao) - valor) > TOLERANCIA_DIVISAO:
        raise ErroImportacao(f"{rotulo} ({desc}): a divisão por pessoa não soma o valor da linha.")

    modo = item.get("modo") if item.get("modo") in ("so_esta", "esta_e_seguintes") else "so_esta"
    pai = item.get("compra_pai") if item.get("compra_pai") in compras else None
    return {"compra_pai": pai, "desc": desc, "cartao_id": item["cartao_id"], "data": item["data"], "valor": valor,
            "atual": atual, "total": total, "modo": modo, "cat_id": cat_id,
            "subcat_id": subcat_id, "divisao": divisao, "fixo": 1 if item.get("fixo") else 0}


def _gerar_linhas(item, mes_fatura, prefixo, ordem, ja_existem=frozenset()):
    """Uma compra vira 1 linha, ou (se 'esta e as seguintes') uma linha por parcela restante."""
    ultima = item["total"] if item["modo"] == "esta_e_seguintes" else item["atual"]
    id_compra = item.get("compra_pai") or f"compra_{prefixo}_{ordem}"   # vinculada => entra na mesma compra
    linhas = []
    for parcela in range(item["atual"], ultima + 1):
        if parcela in ja_existem:        # compra vinculada: o que já existe vence, nunca duplica
            continue
        linhas.append({
            "id": f"fat_{prefixo}_{ordem}_{parcela}",
            "id_compra_pai": id_compra,
            "cartao_id": item["cartao_id"],
            "desc": item["desc"],
            "data_compra": item["data"],
            "mes_fatura": somar_meses(mes_fatura, parcela - item["atual"]),
            "valor_parcela": item["valor"],
            "parcela_atual": parcela,
            "total_parcelas": item["total"],
            "cat_id": item["cat_id"],
            "subcat_id": item["subcat_id"],
            "divisao": json.dumps(item["divisao"], ensure_ascii=False),
            "fechamento_dia": "",
            "data_inicio": "",
            "fixo": item["fixo"],
        })
    return linhas


def confirmar(con, payload):
    """Cria os lançamentos. Retorna {'itens': n, 'linhas': n, 'ids': [...]}.

    Não faz commit: quem chamou decide (para poder desfazer tudo se algo falhar).
    """
    itens = payload.get("itens") or []
    if not itens:
        raise ErroImportacao("Não há nenhuma linha marcada para importar.")
    mes = payload.get("mes_fatura") or ""
    if not re.fullmatch(r"\d{4}-\d{2}", mes):
        raise ErroImportacao("Mês da fatura inválido.")

    cartoes = {r["id"] for r in con.execute("SELECT id FROM cartoes")}
    categorias = {r["id"] for r in con.execute("SELECT id FROM categorias")}
    subcategorias = {r["id"]: r["cat_id"] for r in con.execute("SELECT id, cat_id FROM subcategorias")}
    pessoas = {r["id"] for r in con.execute("SELECT id FROM pessoas")}
    compras = {}                                   # compra -> números das parcelas que já existem
    for r in con.execute("SELECT id_compra_pai, parcela_atual FROM faturas WHERE id_compra_pai IS NOT NULL"):
        compras.setdefault(r[0], set()).add(r[1])

    prefixo = f"imp{int(time.time() * 1000)}{uuid.uuid4().hex[:4]}"
    todas = []
    for ordem, bruto in enumerate(itens, start=1):
        item = _validar_item(con, bruto, cartoes, categorias, subcategorias, pessoas, ordem, compras)
        todas.extend(_gerar_linhas(item, mes, prefixo, ordem, compras.get(item["compra_pai"], frozenset())))

    colunas = ["id", "id_compra_pai", "cartao_id", "desc", "data_compra", "mes_fatura", "valor_parcela",
               "parcela_atual", "total_parcelas", "cat_id", "subcat_id", "divisao", "fechamento_dia", "data_inicio", "fixo"]
    con.executemany(
        f"INSERT INTO faturas ({', '.join(colunas)}) VALUES ({', '.join('?' * len(colunas))})",
        [[l[c] for c in colunas] for l in todas])

    for regra in payload.get("regras") or []:
        repo_regras.salvar(con, regra)
    repo_regras.registrar_uso(con, [i.get("regra_id") for i in itens])

    arq = payload.get("arquivo") or {}
    if arq.get("hash"):
        con.execute(
            "INSERT INTO importacoes (id, hash, arquivo, emissor, vencimento, total, itens, ids, criado_em) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("imp_" + prefixo, arq["hash"], (arq.get("nome") or "")[:200], arq.get("emissor"),
             arq.get("vencimento"), arq.get("total"), len(itens),
             json.dumps([l["id"] for l in todas]), datetime.now().isoformat(timespec="seconds")))
    return {"itens": len(itens), "linhas": len(todas), "ids": [l["id"] for l in todas]}


def importacao_anterior(con, hash_arquivo, emissor=None, vencimento=None):
    """Se este PDF (ou esta fatura) já foi importado e os lançamentos ainda existem, descreve a importação."""
    linhas = con.execute(
        "SELECT * FROM importacoes WHERE hash = ? OR (emissor = ? AND vencimento = ?) ORDER BY criado_em DESC",
        (hash_arquivo, emissor, vencimento)).fetchall()
    for l in linhas:
        ids = json.loads(l["ids"] or "[]")
        if not ids:
            continue
        marcadores = ",".join("?" * len(ids))
        vivos = con.execute(f"SELECT COUNT(*) FROM faturas WHERE id IN ({marcadores})", ids).fetchone()[0]
        if vivos:
            return {"criado_em": l["criado_em"], "itens": l["itens"], "ainda_existem": vivos,
                    "mesmo_arquivo": l["hash"] == hash_arquivo}
    return None
