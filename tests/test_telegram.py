"""Bot do Telegram: texto, conversa com botões e gravação — usando um 'Telegram falso' local (nada vai para a internet)."""
import json
import threading
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from telegram_bot import dados as tg_dados
from telegram_bot.conversa import Conversa
from telegram_bot.texto import entender, moeda, para_valor

HOJE = date(2026, 10, 9)


# ---------------------------------------------------------------- texto
def test_entender_exemplos():
    ok = lambda t: entender(t, HOJE)[0]
    assert ok("uber 45,90") == {"desc": "Uber", "valor": 45.9, "parcelas": 1, "data": "2026-10-09"}
    assert ok("45,90 uber")["desc"] == "Uber"
    assert ok("Notebook Dell 3000 em 10x")["parcelas"] == 10
    assert ok("mercado 120 ontem")["data"] == "2026-10-08"
    assert ok("academia r$ 129,90 05/10")["data"] == "2026-10-05"
    assert ok("smart tv 55 polegadas 2.499,90 3x")["valor"] == 2499.9      # o "55" é parte do nome
    assert ok("pizza 1.234,56 12/09/2026")["data"] == "2026-09-12"


def test_entender_erros_amigaveis():
    assert "valor" in entender("padaria", HOJE)[1]
    assert "data" in entender("uber 45,90 31/02", HOJE)[1]
    assert "nome" in entender("45,90", HOJE)[1]
    assert "parcelas" in entender("tv 100 99x", HOJE)[1]


def test_valores():
    assert para_valor("1.234,56") == 1234.56 and para_valor("3.000") == 3000 and para_valor("45.9") == 45.9
    assert moeda(1234.5) == "R$ 1.234,50"


def test_mes_da_fatura_igual_ao_da_tela():
    assert tg_dados.mes_da_fatura("2026-10-09", {"fechamento": "3"}) == "2026-11"
    assert tg_dados.mes_da_fatura("2026-10-02", {"fechamento": "3"}) == "2026-10"
    assert tg_dados.mes_da_fatura("2026-12-20", {"fechamento": ""}) == "2027-01"


# ---------------------------------------------------------------- conversa (sem Telegram, sem banco)
CTX = {
    "cartoes": [{"id": "c1", "nome": "XP", "fechamento": "3"}, {"id": "c2", "nome": "Inter", "fechamento": "10"}],
    "categorias": [{"id": "k1", "nome": "Transporte", "subcategorias": [{"id": "s1", "nome": "Apps"}]},
                   {"id": "k2", "nome": "Lazer", "subcategorias": []}],
    "pessoas": [{"id": "p1", "nome": "Douglas", "tipo": "principal"}, {"id": "p2", "nome": "Ana", "tipo": "secundaria"}],
    "regras": [],
}


def nova(ctx=None, parecidos=None):
    gravados = []

    def lancar(payload):
        gravados.append(payload)
        return {"ok": True, "linhas": 1}
    return Conversa(lambda: json.loads(json.dumps(ctx or CTX)), lancar, parecidos or (lambda *a: []), hoje=lambda: HOJE), gravados


def apertar(conv, resp, rotulo, chat=1):
    for linha in resp["botoes"]:
        for rot, dado in linha:
            if rotulo in rot:
                return conv.botao(chat, dado)[0]
    raise AssertionError(f"botão {rotulo!r} não encontrado em {resp['botoes']}")


def test_fluxo_completo_com_dois_cartoes():
    conv, gravados = nova()
    r = conv.texto(1, "uber 45,90")[0]
    assert "Em qual cartão" in r["texto"]
    r = apertar(conv, r, "Inter")
    assert "Qual a categoria" in r["texto"]
    r = apertar(conv, r, "Transporte")
    assert "Subcategoria de Transporte" in r["texto"]
    r = apertar(conv, r, "Apps")
    assert "Inter · fatura de out/2026" in r["texto"] and "Transporte › Apps" in r["texto"]    # dia 9 < fechamento 10: fatura do mesmo mês
    r = apertar(conv, r, "Lançar")
    assert "Lançado" in r["texto"]
    p = gravados[0]
    item = p["itens"][0]
    assert item["cartao_id"] == "c2" and item["valor"] == 45.9 and item["cat_id"] == "k1" and item["subcat_id"] == "s1"
    assert item["divisao"] == [{"pessoa_id": "p1", "valor": 45.9}] and item["modo"] == "so_esta"
    assert p["mes_fatura"] == "2026-10"                       # compra dia 09, fechamento dia 10 -> fatura de outubro
    assert p["regras"][0]["padrao"] == "uber"                 # "lembrar" vem ligado


def test_resumo_mostra_mes_certo_da_fatura():
    conv, _ = nova()
    r = apertar(conv, apertar(conv, conv.texto(1, "uber 45,90")[0], "XP"), "Lazer")
    assert "XP · fatura de nov/2026" in r["texto"]            # dia 9 >= fechamento 3 -> novembro


def test_parcelado_divide_o_total_e_gera_todas_as_parcelas():
    conv, gravados = nova()
    r = apertar(conv, apertar(conv, conv.texto(1, "notebook 3000 em 3x")[0], "XP"), "Lazer")
    assert "3x de R$ 1.000,00" in r["texto"]
    apertar(conv, r, "Lançar")
    item = gravados[0]["itens"][0]
    assert item["valor"] == 1000.0 and item["total_parcelas"] == 3 and item["modo"] == "esta_e_seguintes"


def test_um_cartao_so_pula_a_pergunta_do_cartao():
    ctx = dict(CTX, cartoes=[CTX["cartoes"][0]])
    conv, _ = nova(ctx)
    assert "Qual a categoria" in conv.texto(1, "uber 45,90")[0]["texto"]


def test_dividir_entre_pessoas_por_igual_sem_perder_centavos():
    conv, gravados = nova()
    r = apertar(conv, apertar(conv, conv.texto(1, "pizza 100")[0], "XP"), "Lazer")
    r = apertar(conv, r, "De quem")
    r = apertar(conv, r, "Ana")                      # marca Ana (Douglas já vem marcado)
    r = apertar(conv, r, "Pronto")
    assert "por igual" in r["texto"]
    apertar(conv, r, "Lançar")
    assert gravados[0]["itens"][0]["divisao"] == [{"pessoa_id": "p1", "valor": 50.0}, {"pessoa_id": "p2", "valor": 50.0}]
    conv2, g2 = nova()
    r = apertar(conv2, apertar(conv2, conv2.texto(1, "pizza 100,01")[0], "XP"), "Lazer")
    r = apertar(conv2, apertar(conv2, apertar(conv2, r, "De quem"), "Ana"), "Pronto")
    apertar(conv2, r, "Lançar")
    assert [d["valor"] for d in g2[0]["itens"][0]["divisao"]] == [50.01, 50.0]


def test_regra_salva_preenche_tudo_e_vai_direto_ao_resumo():
    ctx = dict(CTX, regras=[{"id": "reg1", "padrao": "uber", "nome": "Uber", "cat_id": "k1", "subcat_id": "s1",
                             "divisao": [{"pessoa_id": "p1", "pct": 60}, {"pessoa_id": "p2", "pct": 40}], "fixo": True}])
    conv, gravados = nova(ctx)
    r = apertar(conv, conv.texto(1, "uber 100")[0], "XP")
    assert "Preenchi pelo que você já usou" in r["texto"] and "Douglas 60%" in r["texto"] and "Dívida fixa: sim" in r["texto"]
    apertar(conv, r, "Lançar")
    item = gravados[0]["itens"][0]
    assert item["divisao"] == [{"pessoa_id": "p1", "valor": 60.0}, {"pessoa_id": "p2", "valor": 40.0}]
    assert item["fixo"] is True and item["regra_id"] == "reg1"


def test_aviso_de_possivel_duplicado():
    conv, _ = nova(parecidos=lambda *a: [{"desc": "Uber", "valor_parcela": 45.9, "data_compra": "2026-10-08", "mes_fatura": "2026-11"}])
    r = apertar(conv, apertar(conv, conv.texto(1, "uber 45,90")[0], "XP"), "Lazer")
    assert "Já existe algo parecido" in r["texto"]


def test_botao_de_lancamento_antigo_e_cancelar():
    conv, gravados = nova()
    r1 = conv.texto(1, "uber 45,90")[0]
    r2 = conv.texto(1, "mercado 80")[0]                         # novo gasto substitui o anterior
    antigo = conv.botao(1, r1["botoes"][0][0][1])[0]
    assert "encerrado" in antigo["texto"] and not gravados
    r = apertar(conv, r2, "Cancelar")
    assert "Cancelado" in r["texto"] and conv.estados.get(1) is None


def test_falha_ao_gravar_nao_perde_o_rascunho():
    def quebra(payload):
        raise RuntimeError("banco ocupado")
    conv = Conversa(lambda: json.loads(json.dumps(CTX)), quebra, lambda *a: [], hoje=lambda: HOJE)
    r = apertar(conv, apertar(conv, conv.texto(1, "uber 45,90")[0], "XP"), "Lazer")
    r = apertar(conv, r, "Lançar")
    assert "Não consegui lançar" in r["texto"] and conv.estados.get(1) is not None


# ---------------------------------------------------------------- de ponta a ponta com Telegram falso
class TelegramFalso:
    def __init__(self):
        self.updates, self.enviadas, self.respondidos = [], [], []
        self.baixados = 0
        self._id = 0
        self.token_valido = "123:abc"
        falso = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                corpo = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                partes = self.path.strip("/").split("/")
                token, metodo = partes[0][3:], partes[1]
                if token != falso.token_valido:
                    return self._json({"ok": False, "error_code": 401, "description": "Unauthorized"}, 401)
                if metodo == "getMe":
                    return self._json({"ok": True, "result": {"username": "fin_bot"}})
                if metodo == "deleteWebhook":
                    return self._json({"ok": True, "result": True})
                if metodo == "getUpdates":
                    fim = time.time() + 0.3
                    while time.time() < fim:
                        novos = [u for u in falso.updates if u["update_id"] >= (corpo.get("offset") or 0)]
                        if novos:
                            return self._json({"ok": True, "result": novos})
                        time.sleep(0.02)
                    return self._json({"ok": True, "result": []})
                if metodo == "getFile":
                    return self._json({"ok": True, "result": {"file_path": "fotos/p1.jpg", "file_size": 3}})
                if metodo in ("sendMessage", "editMessageText"):
                    falso._id += 1
                    falso.enviadas.append((metodo, corpo))
                    return self._json({"ok": True, "result": {"message_id": falso._id}})
                if metodo == "answerCallbackQuery":
                    falso.respondidos.append(corpo)
                return self._json({"ok": True, "result": True})

            def do_GET(self):
                if self.path.endswith("fotos/p1.jpg"):
                    falso.baixados += 1
                    self.send_response(200)
                    self.send_header("Content-Length", "3")
                    self.end_headers()
                    self.wfile.write(b"IMG")
                else:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()

            def _json(self, d, code=200):
                b = json.dumps(d).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

        self.servidor = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.servidor.server_port}"
        threading.Thread(target=self.servidor.serve_forever, daemon=True).start()
        self._uid = 0

    def texto(self, de, txt, data=None):
        self._uid += 1
        msg = {"message_id": self._uid, "from": {"id": de}, "chat": {"id": de, "type": "private"}, "text": txt}
        if data:
            msg["date"] = data
        self.updates.append({"update_id": self._uid, "message": msg})

    def foto(self, de, legenda=None):
        self._uid += 1
        msg = {"message_id": self._uid, "from": {"id": de}, "chat": {"id": de, "type": "private"}, "photo": [{"file_id": "p0"}, {"file_id": "p1"}]}
        if legenda:
            msg["caption"] = legenda
        self.updates.append({"update_id": self._uid, "message": msg})

    def toque(self, de, dado, msg_id=1):
        self._uid += 1
        self.updates.append({"update_id": self._uid, "callback_query": {"id": f"cb{self._uid}", "from": {"id": de}, "data": dado,
                                                                        "message": {"message_id": msg_id, "chat": {"id": de, "type": "private"}}}})

    def aguardar(self, qtd, limite=6):
        fim = time.time() + limite
        while len(self.enviadas) < qtd and time.time() < fim:
            time.sleep(0.03)
        assert len(self.enviadas) >= qtd, f"esperava {qtd} mensagens, vieram {len(self.enviadas)}"
        return self.enviadas[qtd - 1][1]

    def botao(self, msg, rotulo):
        for linha in msg["reply_markup"]["inline_keyboard"]:
            for b in linha:
                if rotulo in b["text"]:
                    return b["callback_data"]
        raise AssertionError(f"sem botão {rotulo!r}")


@pytest.fixture()
def cenario(client, appmod, monkeypatch):
    falso = TelegramFalso()
    monkeypatch.setenv("FINANCEIRO_TELEGRAM_URL", falso.url)
    client.post("/api/pessoas", json=[{"id": "p_principal", "nome": "Douglas", "tipo": "principal"}])
    client.post("/api/cartoes", json=[{"id": "c1", "nome": "XP", "vencimento": "10", "cor": "#fff", "fechamento": "3"}])
    client.post("/api/categorias", json=[{"id": "k1", "nome": "Transporte", "subcategorias": []}])
    yield client, appmod, falso
    appmod.bot_telegram.parar()
    falso.servidor.shutdown()


def ligar(client, appmod, falso, usuario=777):
    r = client.post("/api/telegram/config", json={"token": falso.token_valido, "usuario_id": str(usuario), "ativo": True}).get_json()
    assert r["ok"]
    fim = time.time() + 6
    while not appmod.bot_telegram.estado.get("rodando") and time.time() < fim:
        time.sleep(0.05)
    assert appmod.bot_telegram.estado["rodando"]


def test_lancar_de_ponta_a_ponta(cenario):
    client, appmod, falso = cenario
    ligar(client, appmod, falso)
    versao_antes = client.get("/api/versao").get_json()["versao"]
    falso.texto(777, "uber 45,90 15/10/2026")
    resumo = falso.aguardar(1)
    assert "Qual a categoria" in resumo["text"]                   # um cartão só: pula direto para a categoria
    falso.toque(777, falso.botao(resumo, "Transporte"), msg_id=1)
    resumo = falso.aguardar(2)
    assert "XP · fatura de nov/2026" in resumo["text"]
    falso.toque(777, falso.botao(resumo, "Lançar"), msg_id=1)
    final = falso.aguardar(3)
    assert "Lançado" in final["text"]
    linhas = client.get("/api/faturas").get_json()
    assert [(f["desc"], f["valor_parcela"], f["mes_fatura"], f["cartao_id"], f["cat_id"]) for f in linhas] == \
        [("Uber", 45.9, "2026-11", "c1", "k1")]
    assert client.get("/api/versao").get_json()["versao"] != versao_antes          # a tela vai perceber e atualizar
    assert client.get("/api/historico").get_json()["pode_desfazer"]                # Ctrl+Z desfaz o lançamento
    client.post("/api/historico/desfazer")
    assert client.get("/api/faturas").get_json() == []
    assert falso.respondidos                                                        # botões foram "reconhecidos" (sem ficar girando)


def test_ignora_estranhos_e_ensina_o_id_quando_nao_configurado(cenario):
    client, appmod, falso = cenario
    ligar(client, appmod, falso, usuario=777)
    falso.texto(999, "uber 45,90")                                 # outra pessoa: só recebe aviso com o próprio número
    aviso = falso.aguardar(1)
    assert aviso["chat_id"] == 999 and "999" in aviso["text"]
    assert client.get("/api/faturas").get_json() == []
    falso.texto(777, "oi")
    msg = falso.aguardar(2)
    assert msg["chat_id"] == 777 and "Mande o gasto" in msg["text"]
    falso.updates.append({"update_id": 99, "message": {"message_id": 99, "from": {"id": 777}, "chat": {"id": 777, "type": "private"},
                                                         "document": {"file_id": "d", "mime_type": "application/pdf"}}})
    assert "Só consigo ler imagens" in falso.aguardar(3)["text"]


def test_sem_id_configurado_responde_o_numero_da_pessoa(cenario):
    client, appmod, falso = cenario
    r = client.post("/api/telegram/config", json={"token": falso.token_valido, "ativo": True}).get_json()
    assert r["ok"]
    fim = time.time() + 6
    while not appmod.bot_telegram.estado.get("rodando") and time.time() < fim:
        time.sleep(0.05)
    falso.texto(555, "/start")
    msg = falso.aguardar(1)
    assert "555" in msg["text"] and "Configs" in msg["text"]
    assert client.get("/api/faturas").get_json() == []


def test_token_errado_mostra_erro_claro_e_nao_vaza_o_token(cenario):
    client, appmod, falso = cenario
    client.post("/api/telegram/config", json={"token": "999:errado", "usuario_id": "777", "ativo": True})
    fim = time.time() + 6
    while not appmod.bot_telegram.estado.get("erro") and time.time() < fim:
        time.sleep(0.05)
    st = client.get("/api/telegram/status").get_json()
    assert "token" in st["erro"].lower() and st["rodando"] is False
    assert "999:errado" not in json.dumps(st) and st["token_mascarado"].endswith("rado")
    teste = client.post("/api/telegram/testar").get_json()
    assert teste["ok"] is False


def test_testar_envia_mensagem_e_ativar_exige_token(cenario):
    client, appmod, falso = cenario
    assert client.post("/api/telegram/config", json={"ativo": True}).get_json()["ok"] is False
    assert client.post("/api/telegram/config", json={"token": falso.token_valido, "usuario_id": "777"}).get_json()["ok"]
    t = client.post("/api/telegram/testar").get_json()
    assert t["ok"] and "fin_bot" in t["mensagem"]
    assert falso.enviadas and falso.enviadas[0][1]["chat_id"] == 777
    assert client.post("/api/telegram/config", json={"usuario_id": "abc"}).get_json()["ok"] is False


def test_usuario_nao_autorizado_recebe_aviso_com_o_id(tmp_path):
    from telegram_bot import config as cfg_mod
    from telegram_bot.executor import BotTelegram
    import logging

    class ApiFalsa:
        def __init__(self): self.enviadas = []
        def enviar(self, chat, texto, botoes=None): self.enviadas.append(texto)

    cfg_mod.salvar(str(tmp_path), {"token": "1:x", "usuario_id": 111, "ativo": True})
    bot = BotTelegram(str(tmp_path), lambda: {}, lambda p: {}, lambda *a: [], logging.getLogger("t"))
    api = ApiFalsa()
    up = {"update_id": 1, "message": {"from": {"id": 222}, "chat": {"id": 222, "type": "private"}, "text": "45,90 uber"}}
    bot._tratar(api, up)
    bot._tratar(api, up)  # segunda dentro de 1 min: não repete
    assert len(api.enviadas) == 1 and "222" in api.enviadas[0]
    assert bot.estado["ultima_mensagem"]["autorizado"] is False


def test_falha_ao_tratar_avisa_no_telegram(tmp_path):
    from telegram_bot.executor import BotTelegram
    import logging

    class ApiFalsa:
        def __init__(self): self.enviadas = []
        def enviar(self, chat, texto, botoes=None): self.enviadas.append(texto)

    bot = BotTelegram(str(tmp_path), lambda: {}, lambda p: {}, lambda *a: [], logging.getLogger("t"))
    api = ApiFalsa()
    bot._avisar_falha(api, {"message": {"chat": {"id": 5}}})
    assert api.enviadas and "problema" in api.enviadas[0]


# ---------------------------------------------------------------- prints (OCR): leitura, conversa e ponta a ponta
import os, sys  # noqa: E402
sys.path.insert(0, os.path.dirname(__file__))
import prints_falsos as P  # noqa: E402
from telegram_bot import leitura  # noqa: E402
from telegram_bot.texto import entender_parcial  # noqa: E402


def test_leitura_notificacoes():
    r = leitura.interpretar(*P.NOTIF_XP)
    assert r["tipo"] == "notificacao" and r["banco"] == "xp"
    assert r["itens"] == [{"desc": "PADARIA AURORA LTDA", "valor": 110.0}]
    r = leitura.interpretar(*P.NOTIF_XP_OCR_RUIM)                      # "110,O0" (letra O) ainda vira 110,00
    assert r["itens"][0]["valor"] == 110.0
    r = leitura.interpretar(*P.NOTIF_INTER)                            # "Rs 24,90" ainda é R$ 24,90; nome sem espaços é separado
    assert r["banco"] == "inter" and r["final"] == "7991"
    assert r["itens"] == [{"desc": "MERCADO*Mercado Teste Brasil Int", "valor": 24.9}]


def test_leitura_listas_ignoram_data_hora_categoria_e_creditos():
    r = leitura.interpretar(*P.LISTA_XP)
    assert r["tipo"] == "lista" and r["banco"] == "xp"
    assert [(i["desc"], i["valor"]) for i in r["itens"]] == [
        ("Assinatura", 110.0), ("Loja Do Joao Beams", 21.52), ("99food *testeburgers-Burgersbelo Horizontbr", 72.62), ("Uber", 10.93)]
    r = leitura.interpretar(*P.LISTA_INTER)
    assert r["banco"] == "inter"
    assert [i["valor"] for i in r["itens"]] == [24.9, 554.44, 216.9, 52.92]          # o estorno (sem "-") não entra
    assert r["itens"][2]["desc"] == "CONTA TESTE SAO PAULO"                           # nome que quebra em duas linhas é juntado
    texto_tudo = " ".join(i["desc"] for i in r["itens"])
    assert "Transporte" not in texto_tudo and "Outros" not in texto_tudo and "/" not in texto_tudo   # categoria e data fora


def test_leitura_sem_compras():
    assert leitura.interpretar(800, [P.L(10, 100, 50, "Bom dia")])["tipo"] == "nada"


def test_entender_parcial():
    assert entender_parcial("05/10", HOJE)[0] == {"data": "2026-10-05"}
    assert entender_parcial("Uber 45,90", HOJE)[0] == {"desc": "Uber", "valor": 45.9}
    assert entender_parcial("ontem 3x", HOJE)[0] == {"parcelas": 3, "data": "2026-10-08"}
    assert entender_parcial("", HOJE)[0] == {}


def _lido(P_):
    return leitura.interpretar(*P_)


class FinaisFalso:
    def __init__(self):
        self.d = {}

    def get(self, f):
        return self.d.get(f)

    def set(self, f, c):
        self.d[f] = c


def nova_img(parecidos_lista=None, finais=None):
    gravados = []

    def lancar(payload):
        gravados.append(payload)
        return {"ok": True, "linhas": 1}
    conv = Conversa(lambda: json.loads(json.dumps(CTX)), lancar, lambda *a: [], hoje=lambda: HOJE,
                    parecidos_lista=parecidos_lista, finais=finais)
    return conv, gravados


def test_print_unico_usa_data_de_hoje_e_nunca_a_da_imagem():
    conv, gravados = nova_img(finais=FinaisFalso())
    r = conv.imagem(1, _lido(P.NOTIF_INTER))[0]                 # o print diz "Yesterday"; a data tem que ser hoje
    assert "Mercado" in r["texto"] and "R$ 24,90" in r["texto"] and "hoje" in r["texto"]
    assert "Qual a categoria" in r["texto"]                      # cartão "Inter" foi deduzido; categoria é sempre da pessoa
    r = apertar(conv, apertar(conv, r, "Lazer"), "Lançar")
    item = gravados[0]["itens"][0]
    assert item["data"] == "2026-10-09" and item["cartao_id"] == "c2" and item["cat_id"] == "k2"


def test_legenda_define_data_e_parcelas():
    conv, gravados = nova_img()
    r = conv.imagem(1, _lido(P.NOTIF_XP), "ontem 3x")[0]
    assert "3x de R$ 36,67" in r["texto"] and "08/10" in r["texto"]


def test_botao_data_e_corrigir_no_resumo():
    conv, gravados = nova_img()
    r = conv.imagem(1, _lido(P.NOTIF_XP))[0]
    r = apertar(conv, r, "Lazer")
    r = apertar(conv, r, "Data")
    assert "Qual a data" in r["texto"]
    r = apertar(conv, r, "Ontem")
    assert "08/10" in r["texto"] and "Lançar" in str(r["botoes"])
    r = apertar(conv, r, "Corrigir")
    assert "O que está errado" in r["texto"]
    r = conv.texto(1, "Padaria Nova 99,90")[0]                  # texto digitado vira correção (não um gasto novo)
    assert "Padaria Nova" in r["texto"] and "R$ 99,90" in r["texto"]
    apertar(conv, r, "Lançar")
    item = gravados[0]["itens"][0]
    assert item["desc"] == "Padaria Nova" and item["valor"] == 99.9 and item["data"] == "2026-10-08"


def test_data_digitada_depois_do_botao():
    conv, _ = nova_img()
    r = conv.imagem(1, _lido(P.NOTIF_XP))[0]                       # XP deduzido pelo print
    r = apertar(conv, r, "Lazer")
    r = apertar(conv, r, "Data")
    r = conv.texto(1, "05/10")[0]
    assert "05/10" in r["texto"] and "Lançar" in str(r["botoes"])


def test_lista_marca_duplicadas_e_lanca_uma_por_vez_herdando_o_cartao():
    finais = FinaisFalso()
    conv, gravados = nova_img(parecidos_lista=lambda valor, desc: [1] if valor == 10.93 else [], finais=finais)
    r = conv.imagem(1, _lido(P.LISTA_XP))[0]
    assert "Li <b>4</b> compras" in r["texto"]
    marcados = [b[0][0] for b in r["botoes"] if b[0][0][0] in "☑⬜"]
    assert sum(m.startswith("☑") for m in marcados) == 3 and any("⚠️" in m and m.startswith("⬜") for m in marcados)   # Uber já lançado
    r = apertar(conv, r, "Loja Do Joao")                           # desmarca uma
    assert "Lançar 2 compra(s)" in str(r["botoes"])
    resp = conv.botao(1, [d for l in r["botoes"] for t, d in l if "Lançar 2" in t][0])
    assert "uma de cada vez" in resp[0]["texto"] and "(1 de 2)" in resp[1]["texto"]
    r = apertar(conv, resp[1], "Lazer")                            # o cartão XP já foi deduzido pelo print: vai direto à categoria
    assert "(1 de 2)" in r["texto"] and "XP · fatura" in r["texto"]
    saida = conv.botao(1, [d for l in r["botoes"] for t, d in l if "Lançar" in t and "✅" in t][0])
    assert "Lançado" in saida[0]["texto"] and "(2 de 2)" in saida[1]["texto"]
    assert "Em qual cartão" not in saida[1]["texto"]               # herdou o cartão do primeiro
    assert gravados[0]["itens"][0]["data"] == "2026-10-09"


def test_lista_sem_marcar_nada_avisa():
    conv, _ = nova_img(parecidos_lista=lambda v, d: [1])
    r = conv.imagem(1, _lido(P.LISTA_XP))[0]
    r = apertar(conv, r, "Lançar 0")
    assert "Marque pelo menos uma" in r["texto"]


def test_final_do_cartao_e_lembrado_depois_de_lancar():
    finais = FinaisFalso()
    conv, _ = nova_img(finais=finais)
    r = apertar(conv, conv.imagem(1, _lido(P.NOTIF_INTER))[0], "Lazer")
    apertar(conv, r, "Lançar")
    assert finais.d == {"7991": "c2"}
    finais.d["7991"] = "c1"                                        # lembrado como XP: vale mais que o palpite pelo nome
    conv2, _ = nova_img(finais=finais)
    conv2.imagem(1, _lido(P.NOTIF_INTER))
    assert conv2.estados[1]["rasc"]["cartao_i"] == 0


def test_print_sem_compra_responde_com_ajuda():
    conv, _ = nova_img()
    assert "Não achei nenhuma compra" in conv.imagem(1, {"tipo": "nada", "itens": []})[0]["texto"]


def test_ponta_a_ponta_foto_pelo_telegram(cenario):
    client, appmod, falso = cenario
    appmod.bot_telegram._ler_imagem = lambda conteudo: P.NOTIF_XP     # sem o motor de OCR: só a ligação
    ligar(client, appmod, falso, usuario=777)
    falso.foto(777, "ontem")
    assert "Lendo o print" in falso.aguardar(1)["text"]
    msg = falso.aguardar(2)
    ontem = (date.today() - timedelta(days=1)).strftime("%d/%m")
    assert "PADARIA" in msg["text"] and "R$ 110,00" in msg["text"] and ontem in msg["text"]
    assert falso.baixados == 1


def test_ocr_indisponivel_avisa_sem_travar(cenario):
    client, appmod, falso = cenario
    from telegram_bot.ocr import OcrIndisponivel

    def quebra(conteudo):
        raise OcrIndisponivel("sem biblioteca")
    appmod.bot_telegram._ler_imagem = quebra
    ligar(client, appmod, falso, usuario=777)
    falso.foto(777)
    assert "não está disponível" in falso.aguardar(2)["text"]
    falso.texto(777, "oi")
    assert "Mande o gasto" in falso.aguardar(3)["text"]


# ---------------------------------------------------------------- memória por estabelecimento + mensagens antigas + "voltei"
def test_sugestao_pelo_historico_quando_nao_ha_regra():
    conv, gravados = nova()
    conv._historico = lambda desc: {"cat_id": "k1", "subcat_id": "s1", "divisao": [], "n": 3, "fixo": False} if "uber" in desc.lower() else None
    r = conv.texto(1, "uber 45,90")[0]
    r = apertar(conv, r, "XP")
    assert "histórico" in r["texto"] and "Transporte › Apps" in r["texto"] and "Lançar" in str(r["botoes"])   # já veio preenchido
    r2 = conv.texto(1, "mercado 80")[0]
    assert "Em qual cartão" in r2["texto"]                                    # sem histórico: pergunta como sempre
    apertar(conv, r2, "XP")


def test_historico_com_erro_nao_atrapalha():
    conv, _ = nova()

    def quebra(desc):
        raise RuntimeError("banco indisponível")
    conv._historico = quebra
    assert "Em qual cartão" in conv.texto(1, "uber 45,90")[0]["texto"]


def test_historico_real_no_banco(client, appmod):
    client.post("/api/cartoes", json=[{"id": "c1", "nome": "XP", "vencimento": "10", "cor": "#fff", "fechamento": "3"}])
    client.post("/api/categorias", json=[{"id": "k1", "nome": "Transporte", "subcategorias": [{"id": "s1", "nome": "Apps"}]},
                                         {"id": "k2", "nome": "Lazer", "subcategorias": []}])

    def fat(i, desc, cat, sub=""):
        return {"id": f"f{i}", "id_compra_pai": f"f{i}", "cartao_id": "c1", "desc": desc, "data_compra": f"2026-09-0{i}", "mes_fatura": "2026-10",
                "valor_parcela": 10.0 * i, "parcela_atual": 1, "total_parcelas": 1, "cat_id": cat, "subcat_id": sub,
                "divisao": [{"pessoa_id": "p_principal", "valor": 10.0 * i}], "fechamento_dia": "", "data_inicio": ""}
    client.post("/api/faturas", json=[fat(1, "RAPPI*RappiBrasilInt", "k1", "s1"), fat(2, "RAPPI*Rappi Brasil Int", "k1", "s1"),
                                      fat(3, "PIX CRED A VISTA FULANO", "k2")])
    sug = tg_dados.sugerir_do_historico(appmod.conectar, "RAPPI*Rappi Brasil Int")
    assert sug["cat_id"] == "k1" and sug["subcat_id"] == "s1" and sug["n"] == 2
    assert sug["divisao"] == [{"pessoa_id": "p_principal", "pct": 100.0}]
    assert tg_dados.sugerir_do_historico(appmod.conectar, "Padaria Nova") is None
    assert tg_dados.sugerir_do_historico(appmod.conectar, "PIX CRED A VISTA OUTRA PESSOA") is None      # palavras genéricas não casam


def test_mensagens_antigas_esperam_a_vez_e_usam_o_dia_em_que_foram_enviadas():
    conv, gravados = nova()
    d7, d8 = date(2026, 10, 7), date(2026, 10, 8)
    assert conv.texto(1, "uber 10,00", dia=d7, fila=True)                      # primeira: abre normalmente (não havia nada aberto)
    assert conv.texto(1, "mercado 20,00", dia=d8, fila=True) == []             # segunda: entra na fila (já há um aberto)
    assert conv.texto(1, "padaria 30,00", dia=d8, fila=True) == []
    primeira = conv.estados[1]["rasc"]
    assert primeira["data"] == "2026-10-07" and "enviada em 07/10" in primeira["prefixo"]
    resp = conv.botao(1, f"{conv.estados[1]['n']}|cancelar|")                  # cancela a primeira -> aparece a segunda
    assert "Cancelado" in resp[0]["texto"] and "Mercado" in resp[1]["texto"] and "enviada em 08/10" in resp[1]["texto"]
    assert conv.estados[1]["rasc"]["data"] == "2026-10-08"
    resp = conv.botao(1, f"{conv.estados[1]['n']}|cancelar|")
    assert "Padaria" in resp[1]["texto"]
    resp = conv.botao(1, f"{conv.estados[1]['n']}|cancelar|")
    assert len(resp) == 1 and 1 not in conv.estados                            # fila acabou


def test_mensagem_ao_vivo_continua_substituindo_o_lancamento_aberto():
    conv, _ = nova()
    conv.texto(1, "uber 10")
    r = conv.texto(1, "mercado 20")[0]                                         # sem fila: comportamento de sempre
    assert "Mercado" in r["texto"]


def test_botao_data_relativo_ao_dia_real_mesmo_em_mensagem_antiga():
    conv, _ = nova()
    r = conv.texto(1, "uber 10", dia=date(2026, 10, 3))[0]
    r = apertar(conv, apertar(conv, r, "XP"), "Lazer")
    assert "03/10" in r["texto"]
    r = apertar(conv, r, "Data")
    assert "Hoje (09/10)" in str(r["botoes"])                                  # Hoje = hoje de verdade, não o dia da mensagem
    r = apertar(conv, r, "Ontem")
    assert "08/10" in r["texto"]


def _antiga_e_visto(client, appmod, falso, horas_visto=2, minutos_msg=60):
    from telegram_bot import config as cfg_mod
    cfg_mod.gravar_visto(appmod.pasta_config(), time.time() - horas_visto * 3600)
    falso.texto(777, "45,90 uber", data=int(time.time()) - minutos_msg * 60)


def test_aviso_de_volta_e_mensagem_antiga_vira_lancamento(cenario):
    client, appmod, falso = cenario
    _antiga_e_visto(client, appmod, falso)
    ligar(client, appmod, falso, usuario=777)
    aviso = falso.aguardar(1)["text"]
    assert "Voltei" in aviso and "1 mensagem" in aviso
    assert "Uber" in falso.aguardar(2)["text"]


def test_aviso_de_volta_pode_ser_desligado(cenario):
    client, appmod, falso = cenario
    _antiga_e_visto(client, appmod, falso)
    r = client.post("/api/telegram/config", json={"token": falso.token_valido, "usuario_id": "777", "ativo": True, "avisar_volta": False}).get_json()
    assert r["ok"] and r["avisar_volta"] is False
    assert "Uber" in falso.aguardar(1)["text"]                                 # sem aviso: vai direto ao lançamento
    assert all("Voltei" not in c.get("text", "") for _, c in falso.enviadas)


def test_sem_ausencia_longa_nao_avisa(cenario):
    client, appmod, falso = cenario
    from telegram_bot import config as cfg_mod
    cfg_mod.gravar_visto(appmod.pasta_config(), time.time() - 300)             # esteve ligado há 5 minutos
    falso.texto(777, "45,90 uber")
    ligar(client, appmod, falso, usuario=777)
    assert "Uber" in falso.aguardar(1)["text"]
    assert all("Voltei" not in c.get("text", "") for _, c in falso.enviadas)
