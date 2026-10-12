import io
import json
import urllib.error
import urllib.request

import pytest

CHAVE = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"


class Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def falso(monkeypatch, resposta, capturar=None, erro=None):
    def urlopen(req, timeout=0):
        if capturar is not None:
            capturar.append({"url": req.full_url, "corpo": json.loads(req.data) if req.data else None, "cab": {k.lower(): v for k, v in req.header_items()}})
        if erro:
            raise urllib.error.HTTPError(req.full_url, erro[0], "x", {}, io.BytesIO(erro[1].encode()))
        return Resp(json.dumps(resposta).encode())
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)


def test_chave_fica_mascarada_e_so_valida_entra(client):
    assert client.get("/api/ia/config").get_json()["claude"]["chave_definida"] is False
    assert client.post("/api/ia/config", json={"chave_claude": "curta"}).status_code == 400
    r = client.post("/api/ia/config", json={"chave_claude": CHAVE}).get_json()
    assert r["ok"] and r["claude"]["chave_definida"] and CHAVE not in json.dumps(r) and r["claude"]["chave"].endswith(CHAVE[-4:])
    assert CHAVE not in client.get("/api/ia/config").get_data(as_text=True)
    r = client.post("/api/ia/config", json={"remover_claude": True}).get_json()
    assert r["claude"]["chave_definida"] is False


def test_pergunta_ao_claude_envia_contexto_e_devolve_texto(client, monkeypatch):
    client.post("/api/ia/config", json={"chave_claude": CHAVE})
    cap = []
    falso(monkeypatch, {"content": [{"type": "text", "text": "Você gastou **bem**."}]}, cap)
    r = client.post("/api/ia/perguntar", json={"pergunta": "Resuma", "contexto": "Lazer: R$ 10,00", "historico": [{"role": "user", "content": "oi"}, {"role": "assistant", "content": "olá"}, {"role": "x", "content": "ignora"}]}).get_json()
    assert r["ok"] and "bem" in r["resposta"]
    c = cap[0]
    assert c["url"] == "https://api.anthropic.com/v1/messages" and c["cab"]["x-api-key"] == CHAVE
    assert "Lazer: R$ 10,00" in c["corpo"]["system"]
    assert [m["role"] for m in c["corpo"]["messages"]] == ["user", "assistant", "user"] and c["corpo"]["messages"][-1]["content"] == "Resuma"


def test_pergunta_ao_gemini(client, monkeypatch):
    client.post("/api/ia/config", json={"chave_gemini": "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "provedor": "gemini", "modelo_gemini": "gemini-2.5-flash"})
    cap = []
    falso(monkeypatch, {"candidates": [{"content": {"parts": [{"text": "Resposta do Gemini"}]}}]}, cap)
    r = client.post("/api/ia/perguntar", json={"pergunta": "Oi", "contexto": "dados"}).get_json()
    assert r["ok"] and r["resposta"] == "Resposta do Gemini"
    assert cap[0]["url"].endswith("/models/gemini-2.5-flash:generateContent") and "x-goog-api-key" in cap[0]["cab"]
    assert cap[0]["corpo"]["contents"][-1] == {"role": "user", "parts": [{"text": "Oi"}]}


@pytest.mark.parametrize("codigo,corpo,trecho", [(401, "invalid x-api-key", "recusada"), (400, "Your credit balance is too low", "sem crédito"),
                                                  (404, "model: not_found", "modelo"), (429, "rate", "Limite")])
def test_erros_viram_mensagens_em_portugues(client, monkeypatch, codigo, corpo, trecho):
    client.post("/api/ia/config", json={"chave_claude": CHAVE})
    falso(monkeypatch, {}, erro=(codigo, corpo))
    r = client.post("/api/ia/perguntar", json={"pergunta": "x", "contexto": ""})
    assert r.status_code == 400 and trecho in r.get_json()["mensagem"]


def test_sem_chave_nao_chama_a_internet(client, monkeypatch):
    chamou = []
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: chamou.append(1))
    r = client.post("/api/ia/perguntar", json={"pergunta": "x", "contexto": ""})
    assert r.status_code == 400 and not chamou


def test_lista_de_modelos(client, monkeypatch):
    client.post("/api/ia/config", json={"chave_claude": CHAVE})
    falso(monkeypatch, {"data": [{"id": "claude-b"}, {"id": "claude-a"}]})
    assert client.get("/api/ia/modelos?provedor=claude").get_json()["modelos"] == ["claude-a", "claude-b"]
    assert client.get("/api/ia/modelos?provedor=x").status_code == 400


def test_so_abre_links_permitidos(client):
    assert client.post("/api/ia/abrir_link", json={"url": "https://evil.com/"}).status_code == 400
