"""Configuração do bot: fica em telegram.json, ao lado da pasta 'memoria' (nunca no banco nem no código)."""
import json
import os

PADRAO = {"ativo": False, "token": "", "usuario_id": None, "finais": {}, "avisar_volta": True}   # finais: {"7991": id_do_cartao}


def _caminho(pasta_config):
    return os.path.join(pasta_config, "telegram.json")


def carregar(pasta_config):
    cfg = dict(PADRAO)
    try:
        with open(_caminho(pasta_config), encoding="utf-8") as f:
            salvo = json.load(f)
        if isinstance(salvo, dict):
            cfg.update({k: salvo[k] for k in PADRAO if k in salvo})
    except (OSError, ValueError):
        pass
    cfg["token"] = str(cfg.get("token") or "").strip()
    try:
        cfg["usuario_id"] = int(cfg["usuario_id"]) if cfg.get("usuario_id") not in (None, "") else None
    except (TypeError, ValueError):
        cfg["usuario_id"] = None
    cfg["ativo"] = bool(cfg.get("ativo"))
    cfg["avisar_volta"] = bool(cfg.get("avisar_volta", True))
    f = cfg.get("finais")
    cfg["finais"] = {str(k): str(v) for k, v in f.items()} if isinstance(f, dict) else {}
    return cfg


def salvar(pasta_config, cfg):
    os.makedirs(pasta_config, exist_ok=True)
    caminho = _caminho(pasta_config)
    tmp = caminho + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({k: cfg.get(k) for k in PADRAO}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, caminho)


def token_mascarado(token):
    return ("••••••" + token[-4:]) if len(token) > 8 else ("••••" if token else "")


# "Visto por último": quando o bot esteve ligado pela última vez. Fica em arquivo à parte para não competir com a configuração.
def _caminho_visto(pasta_config):
    return os.path.join(pasta_config, "telegram_visto.json")


def ler_visto(pasta_config):
    try:
        with open(_caminho_visto(pasta_config), encoding="utf-8") as f:
            return float(json.load(f).get("visto_em"))
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def gravar_visto(pasta_config, quando):
    try:
        os.makedirs(pasta_config, exist_ok=True)
        tmp = _caminho_visto(pasta_config) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"visto_em": quando}, f)
        os.replace(tmp, _caminho_visto(pasta_config))
    except OSError:
        pass
