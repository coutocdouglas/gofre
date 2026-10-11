"""Regras de classificação salvas (ex.: descrição contém 'uber' -> categoria Transporte)."""
import json
import uuid
from datetime import datetime

from .sugestoes import PADRAO_MINIMO, normalizar


def _para_dict(linha):
    d = dict(linha)
    try:
        d["divisao"] = json.loads(d.get("divisao") or "[]")
    except ValueError:
        d["divisao"] = []
    d["fixo"] = bool(d.get("fixo"))
    return d


def listar(con):
    return [_para_dict(r) for r in con.execute(
        "SELECT * FROM regras_importacao ORDER BY LENGTH(padrao) DESC, padrao").fetchall()]


def salvar(con, regra):
    """Cria ou atualiza (pelo padrão). Retorna o id, ou None se o padrão for curto demais."""
    padrao = normalizar(regra.get("padrao", ""))
    nome = (regra.get("nome") or "").strip()
    if len(padrao) < PADRAO_MINIMO or not nome:
        return None
    divisao = json.dumps(regra.get("divisao") or [], ensure_ascii=False)
    fixo = 1 if regra.get("fixo") else 0
    existente = con.execute("SELECT id FROM regras_importacao WHERE padrao = ?", (padrao,)).fetchone()
    if existente:
        con.execute(
            "UPDATE regras_importacao SET nome=?, cat_id=?, subcat_id=?, divisao=?, fixo=? WHERE id=?",
            (nome, regra.get("cat_id"), regra.get("subcat_id"), divisao, fixo, existente["id"]))
        return existente["id"]
    novo = "reg_" + uuid.uuid4().hex[:12]
    con.execute(
        "INSERT INTO regras_importacao (id, padrao, nome, cat_id, subcat_id, divisao, usos, criado_em, fixo) "
        "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
        (novo, padrao, nome, regra.get("cat_id"), regra.get("subcat_id"), divisao,
         datetime.now().isoformat(timespec="seconds"), fixo))
    return novo


def remover(con, regra_id):
    return con.execute("DELETE FROM regras_importacao WHERE id = ?", (regra_id,)).rowcount > 0


def registrar_uso(con, ids):
    for rid in set(i for i in ids if i):
        con.execute("UPDATE regras_importacao SET usos = usos + 1 WHERE id = ?", (rid,))
