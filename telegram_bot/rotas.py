"""Rotas da tela de configuração do Telegram (/api/telegram/...). O token nunca volta inteiro para a tela."""
from flask import Blueprint, jsonify, request

from . import config as cfg_mod
from .api import Api, ErroTelegram


def criar_blueprint(bot, pasta_config):
    bp = Blueprint("telegram", __name__, url_prefix="/api/telegram")

    def estado_publico():
        cfg = cfg_mod.carregar(pasta_config())
        return {"ativo": cfg["ativo"], "token_definido": bool(cfg["token"]), "token_mascarado": cfg_mod.token_mascarado(cfg["token"]),
                "usuario_id": cfg["usuario_id"], "avisar_volta": cfg.get("avisar_volta", True), "rodando": bool(bot.estado.get("rodando")), "bot": bot.estado.get("bot"),
                "erro": bot.estado.get("erro"), "ultima_mensagem": bot.estado.get("ultima_mensagem"),
                "ultima_atividade": bot.estado.get("ultima_atividade")}

    @bp.route("/status", methods=["GET"])
    def status():
        return jsonify(estado_publico())

    @bp.route("/config", methods=["POST"])
    def salvar():
        corpo = request.get_json(silent=True) or {}
        cfg = cfg_mod.carregar(pasta_config())
        if "token" in corpo and str(corpo["token"]).strip():
            cfg["token"] = str(corpo["token"]).strip()
        if corpo.get("limpar_token"):
            cfg["token"] = ""
            cfg["ativo"] = False
        if "usuario_id" in corpo:
            v = str(corpo["usuario_id"] or "").strip()
            if v and not v.lstrip("-").isdigit():
                return jsonify({"ok": False, "mensagem": "O número de usuário deve ter só dígitos."})
            cfg["usuario_id"] = int(v) if v else None
        if "avisar_volta" in corpo:
            cfg["avisar_volta"] = bool(corpo["avisar_volta"])
        if "ativo" in corpo:
            cfg["ativo"] = bool(corpo["ativo"])
        if cfg["ativo"] and not cfg["token"]:
            return jsonify({"ok": False, "mensagem": "Cole o token do bot antes de ativar."})
        cfg_mod.salvar(pasta_config(), cfg)
        bot.estado["erro"] = None
        bot.reiniciar()
        return jsonify({"ok": True, **estado_publico()})

    @bp.route("/testar", methods=["POST"])
    def testar():
        cfg = cfg_mod.carregar(pasta_config())
        if not cfg["token"]:
            return jsonify({"ok": False, "mensagem": "Cole o token do bot e salve primeiro."})
        api = Api(cfg["token"], bot.url_base)
        try:
            quem = api.quem_sou() or {}
        except ErroTelegram as e:
            return jsonify({"ok": False, "mensagem": bot._explicar(e)})
        msg = f"O bot @{quem.get('username')} respondeu."
        if cfg["usuario_id"] is not None:
            try:
                api.enviar(cfg["usuario_id"], "✅ Conexão com o Financeiro funcionando! Mande um gasto, por exemplo: <code>45,90 uber</code>")
                msg += " Mandei uma mensagem de teste para você no Telegram."
            except ErroTelegram:
                msg += " Mas não consegui te escrever: abra o bot no Telegram e toque em Iniciar (/start) primeiro."
        else:
            msg += " Agora abra o bot no Telegram e mande /start para descobrir seu número de usuário."
        return jsonify({"ok": True, "mensagem": msg})

    return bp
