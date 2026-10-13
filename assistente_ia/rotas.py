"""Rotas /api/ia/... A chave nunca volta inteira para a tela."""
import re
import webbrowser

from flask import Blueprint, jsonify, request

from . import provedores as P

LINKS_PERMITIDOS = ("https://console.anthropic.com/", "https://platform.claude.com/", "https://aistudio.google.com/")


def criar_blueprint(pasta_config):
    bp = Blueprint("ia", __name__, url_prefix="/api/ia")

    @bp.route("/config", methods=["GET"])
    def ler():
        return jsonify(P.estado_publico(P.carregar(pasta_config())))

    @bp.route("/config", methods=["POST"])
    def gravar():
        corpo = request.get_json(silent=True) or {}
        cfg = P.carregar(pasta_config())
        if corpo.get("provedor") in P.PROVEDORES:
            cfg["provedor"] = corpo["provedor"]
        for prov in P.PROVEDORES:
            nova = str(corpo.get("chave_" + prov) or "").strip()
            if nova:
                if not re.fullmatch(r"[A-Za-z0-9_\-\.]{20,300}", nova):
                    return jsonify({"ok": False, "mensagem": "Essa chave parece incompleta ou tem caracteres estranhos. Copie de novo, sem espaços."}), 400
                cfg["chave_" + prov] = nova
            if corpo.get("remover_" + prov):
                cfg["chave_" + prov] = ""
            modelo = str(corpo.get("modelo_" + prov) or "").strip()
            if modelo and re.fullmatch(r"[A-Za-z0-9_\-\.:]{3,100}", modelo):
                cfg["modelo_" + prov] = modelo
        P.salvar(pasta_config(), cfg)
        return jsonify({"ok": True, **P.estado_publico(cfg)})

    @bp.route("/modelos", methods=["GET"])
    def modelos():
        prov = request.args.get("provedor", "")
        if prov not in P.PROVEDORES:
            return jsonify({"ok": False, "mensagem": "Provedor inválido."}), 400
        try:
            return jsonify({"ok": True, "modelos": sorted(P.listar_modelos(P.carregar(pasta_config()), prov))})
        except P.ErroIA as e:
            return jsonify({"ok": False, "mensagem": str(e)}), 400

    @bp.route("/perguntar", methods=["POST"])
    def perguntar():
        corpo = request.get_json(silent=True) or {}
        try:
            cfg = P.carregar(pasta_config())
            args = (corpo.get("pergunta"), corpo.get("contexto"), corpo.get("historico"))
            try:
                texto = P.perguntar(cfg, *args)
            except P.ErroIA as e:
                if e.codigo != 404:
                    raise
                # modelo salvo não existe mais: troca sozinho por um que a conta realmente tem
                prov = cfg["provedor"]
                novo = P.escolher_modelo(prov, P.listar_modelos(cfg, prov))
                if not novo or novo == cfg["modelo_" + prov]:
                    raise
                cfg["modelo_" + prov] = novo
                texto = P.perguntar(cfg, *args)
                P.salvar(pasta_config(), cfg)
            return jsonify({"ok": True, "resposta": texto, "modelo": cfg["modelo_" + cfg["provedor"]]})
        except P.ErroIA as e:
            return jsonify({"ok": False, "mensagem": str(e)}), 400

    @bp.route("/abrir_link", methods=["POST"])
    def abrir_link():
        url = str((request.get_json(silent=True) or {}).get("url", ""))
        if not url.startswith(LINKS_PERMITIDOS):
            return jsonify({"ok": False}), 400
        webbrowser.open(url)
        return jsonify({"ok": True})

    return bp
