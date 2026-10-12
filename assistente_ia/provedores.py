"""Conversa com Claude (Anthropic) e Gemini (Google) usando só a biblioteca padrão do Python."""
import json
import os
import urllib.error
import urllib.request

PROVEDORES = ("claude", "gemini")
MODELO_PADRAO = {"claude": "claude-sonnet-5-5", "gemini": "gemini-2.5-flash"}
LIMITE_CONTEXTO = 60000          # caracteres: barreira de segurança contra enviar coisa enorme
LIMITE_PERGUNTA = 4000

SISTEMA = (
    "Você é um analista de finanças pessoais que fala português do Brasil, de forma clara, direta e amigável, "
    "para uma pessoa leiga. Use SOMENTE os dados fornecidos abaixo; se faltar informação, diga o que falta em vez de inventar. "
    "Valores estão em reais (R$) e referem-se à parte da pessoa principal; o mês é o mês da fatura. "
    "Seja concreto: cite números, categorias e meses. Dê sugestões práticas e realistas, sem julgar. "
    "Responda curto (até ~250 palavras, salvo se pedirem mais), com títulos curtos em **negrito** e listas com '-'. "
    "Você não é consultor financeiro licenciado: não recomende investimentos específicos; se pedirem, explique que é só informação geral."
)


class ErroIA(Exception):
    """Erro com mensagem já em português, pronta para mostrar na tela."""


# ---------------------------------------------------------------- configuração (arquivo ia.json)
def _arquivo(pasta):
    return os.path.join(pasta, "ia.json")


def carregar(pasta):
    base = {"provedor": "claude", "chave_claude": "", "chave_gemini": "",
            "modelo_claude": MODELO_PADRAO["claude"], "modelo_gemini": MODELO_PADRAO["gemini"]}
    try:
        with open(_arquivo(pasta), encoding="utf-8") as f:
            salvo = json.load(f)
        for k in base:
            if isinstance(salvo.get(k), str) and not (k.startswith("modelo") and not salvo[k]):
                base[k] = salvo[k]
    except (OSError, ValueError):
        pass
    if base["provedor"] not in PROVEDORES:
        base["provedor"] = "claude"
    return base


def salvar(pasta, cfg):
    os.makedirs(pasta, exist_ok=True)
    with open(_arquivo(pasta), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False)


def mascarar(chave):
    return ("••••" + chave[-4:]) if chave and len(chave) > 8 else ("••••" if chave else "")


def estado_publico(cfg):
    return {"provedor": cfg["provedor"],
            "claude": {"chave_definida": bool(cfg["chave_claude"]), "chave": mascarar(cfg["chave_claude"]), "modelo": cfg["modelo_claude"]},
            "gemini": {"chave_definida": bool(cfg["chave_gemini"]), "chave": mascarar(cfg["chave_gemini"]), "modelo": cfg["modelo_gemini"]}}


# ---------------------------------------------------------------- chamadas
def _requisicao(url, corpo, cabecalhos, metodo="POST"):
    dados = json.dumps(corpo).encode("utf-8") if corpo is not None else None
    req = urllib.request.Request(url, data=dados, method=metodo, headers=dict({"Content-Type": "application/json", "User-Agent": "Gofre"}, **cabecalhos))
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            detalhe = e.read().decode("utf-8", "replace")
        except Exception:
            detalhe = ""
        raise ErroIA(_traduzir_erro(e.code, detalhe)) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ErroIA("Não consegui falar com o serviço de IA. Confira sua internet e tente de novo.") from None
    except ValueError:
        raise ErroIA("A resposta do serviço de IA veio num formato inesperado.") from None


def _traduzir_erro(codigo, detalhe):
    d = detalhe.lower()
    if codigo in (401, 403) or "api key not valid" in d or "invalid x-api-key" in d:
        return "A chave de API foi recusada. Confira se copiou inteira e se é do serviço escolhido."
    if "credit balance" in d or "billing" in d:
        return "Sua conta da API está sem crédito. Adicione crédito no site do serviço (é separado da assinatura do site/app)."
    if codigo == 404 or "not found" in d or "not_found" in d:
        return "Esse modelo não existe ou não está liberado na sua conta. Escolha outro na lista de modelos."
    if codigo == 429:
        return "Limite de uso atingido neste momento. Espere um pouco e tente de novo, ou troque de modelo."
    if codigo in (500, 502, 503, 529):
        return "O serviço de IA está instável agora. Tente de novo em instantes."
    return "O serviço de IA recusou o pedido (código %s)." % codigo


def _mensagens_validas(historico):
    msgs = []
    for m in (historico or [])[-8:]:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str) and m["content"].strip():
            msgs.append({"role": m["role"], "content": m["content"][:LIMITE_CONTEXTO]})
    return msgs


def perguntar(cfg, pergunta, contexto, historico=None):
    pergunta = str(pergunta or "").strip()[:LIMITE_PERGUNTA]
    if not pergunta:
        raise ErroIA("Digite uma pergunta.")
    contexto = str(contexto or "")[:LIMITE_CONTEXTO]
    prov = cfg["provedor"]
    chave = cfg["chave_" + prov]
    if not chave:
        raise ErroIA("Cadastre a chave de API primeiro.")
    modelo = cfg["modelo_" + prov] or MODELO_PADRAO[prov]
    sistema = SISTEMA + "\n\n=== DADOS ===\n" + contexto
    msgs = _mensagens_validas(historico) + [{"role": "user", "content": pergunta}]
    if prov == "claude":
        r = _requisicao("https://api.anthropic.com/v1/messages",
                        {"model": modelo, "max_tokens": 2000, "system": sistema, "messages": msgs},
                        {"x-api-key": chave, "anthropic-version": "2023-06-01"})
        texto = "".join(b.get("text", "") for b in r.get("content", []) if b.get("type") == "text")
    else:
        conteudo = [{"role": "user" if m["role"] == "user" else "model", "parts": [{"text": m["content"]}]} for m in msgs]
        r = _requisicao("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % urllib.request.quote(modelo, safe=""),
                        {"system_instruction": {"parts": [{"text": sistema}]}, "contents": conteudo,
                         "generationConfig": {"maxOutputTokens": 2000}},
                        {"x-goog-api-key": chave})
        partes = ((r.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
        texto = "".join(p.get("text", "") for p in partes)
    if not texto.strip():
        raise ErroIA("A IA não devolveu texto (pode ter sido bloqueado pelo filtro do serviço). Tente reformular a pergunta.")
    return texto.strip()


def listar_modelos(cfg, prov):
    chave = cfg["chave_" + prov]
    if not chave:
        raise ErroIA("Cadastre a chave de API primeiro.")
    if prov == "claude":
        r = _requisicao("https://api.anthropic.com/v1/models?limit=100", None, {"x-api-key": chave, "anthropic-version": "2023-06-01"}, "GET")
        return [m["id"] for m in r.get("data", []) if m.get("id")]
    r = _requisicao("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", None, {"x-goog-api-key": chave}, "GET")
    return [m["name"].split("/", 1)[-1] for m in r.get("models", [])
            if "generateContent" in (m.get("supportedGenerationMethods") or []) and m.get("name", "").split("/", 1)[-1].startswith("gemini")]
