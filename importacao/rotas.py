"""Rotas da API de importação (/api/importacao/...).

Convenção: erros 'esperados' (senha necessária, PDF desconhecido, dados inválidos) voltam com
HTTP 200 e {"ok": false, "erro": ...}; assim a tela mostra uma mensagem clara em vez de um aviso
genérico de falha de gravação.
"""
import os

from flask import Blueprint, jsonify, request

from . import regras as repo_regras
from . import senhas, servico
from .emissores.base import ErroLeitura
from .leitor import LIMITE_BYTES, PdfInvalido, SenhaIncorreta, SenhaNecessaria, ler_fatura
from .sugestoes import montar_sugestoes


def criar_blueprint(conectar, pasta_config, pasta_programa, log):
    bp = Blueprint("importacao", __name__, url_prefix="/api/importacao")

    def pastas_de_busca():
        base = pasta_programa()
        return [base, os.path.join(base, ".."), os.path.join(base, "..", "..")]

    def falha(erro, **extra):
        return jsonify({"ok": False, "erro": erro, **extra})

    @bp.route("/ler", methods=["POST"])
    def ler():
        arquivo = request.files.get("arquivo")
        if arquivo is None:
            return falha("sem_arquivo", mensagem="Nenhum arquivo foi enviado.")
        dados = arquivo.read(LIMITE_BYTES + 1)
        senha = (request.form.get("senha") or "").strip() or None
        pasta = pasta_config()
        try:
            fatura, usada, hash_arquivo = ler_fatura(
                dados, senhas.carregar(pasta, pastas_de_busca()), senha)
        except SenhaNecessaria:
            return falha("senha_necessaria", mensagem="Este PDF tem senha. Digite a senha da fatura.")
        except SenhaIncorreta:
            return falha("senha_incorreta", mensagem="Senha incorreta. Tente novamente.")
        except PdfInvalido as e:
            return falha("pdf_invalido", mensagem=str(e))
        except ErroLeitura as e:
            return falha("formato_desconhecido", mensagem=str(e))
        except Exception:
            log.exception("Falha inesperada ao ler a fatura em PDF")
            return falha("erro_inesperado", mensagem="Não foi possível ler este PDF.")

        if senha and usada == senha:
            senhas.adicionar(pasta, senha)          # lembra a senha para a próxima vez

        with conectar() as con:
            anterior = servico.importacao_anterior(
                con, hash_arquivo, fatura["emissor"], fatura["vencimento"])
        nome = os.path.basename((arquivo.filename or "fatura.pdf").replace("\\", "/"))[:120]
        return jsonify({"ok": True, "fatura": fatura,
                        "arquivo": {"nome": nome, "hash": hash_arquivo},
                        "importacao_anterior": anterior})

    @bp.route("/sugerir", methods=["POST"])
    def sugerir():
        corpo = request.get_json(silent=True) or {}
        fatura = corpo.get("fatura")
        if not isinstance(fatura, dict) or "secoes" not in fatura:
            return falha("invalido", mensagem="Dados da fatura ausentes.")
        mes = corpo.get("mes_fatura") or fatura.get("mes_fatura")
        try:
            with conectar() as con:
                existentes = [dict(r) for r in con.execute("SELECT * FROM faturas")]
                regras = repo_regras.listar(con)
                pessoas = [dict(r) for r in con.execute("SELECT * FROM pessoas")]
            sugestoes = montar_sugestoes(fatura, corpo.get("mapeamento") or {}, mes,
                                         existentes, regras, pessoas)
        except (KeyError, TypeError, ValueError):
            log.exception("Dados inválidos ao montar sugestões")
            return falha("invalido", mensagem="Não foi possível analisar os dados da fatura.")
        return jsonify({"ok": True, "sugestoes": sugestoes})

    @bp.route("/confirmar", methods=["POST"])
    def confirmar():
        corpo = request.get_json(silent=True) or {}
        with conectar() as con:
            try:
                resultado = servico.confirmar(con, corpo)
            except servico.ErroImportacao as e:
                con.rollback()
                return falha("invalido", mensagem=str(e))
            con.commit()
        log.info("Importação de fatura: %s lançamentos criados", resultado["linhas"])
        return jsonify({"ok": True, **resultado})

    @bp.route("/regras", methods=["GET"])
    def listar_regras():
        with conectar() as con:
            return jsonify(repo_regras.listar(con))

    @bp.route("/regras/<regra_id>", methods=["DELETE"])
    def apagar_regra(regra_id):
        with conectar() as con:
            apagou = repo_regras.remover(con, regra_id)
            con.commit()
        return jsonify({"ok": apagou})

    @bp.route("/senhas", methods=["GET"])
    def quantas_senhas():
        return jsonify({"qtd": len(senhas.carregar(pasta_config(), pastas_de_busca()))})

    @bp.route("/senhas", methods=["DELETE"])
    def limpar_senhas():
        senhas.limpar(pasta_config())
        return jsonify({"ok": True})

    return bp
