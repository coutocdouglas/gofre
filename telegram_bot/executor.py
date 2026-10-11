"""Faz o bot funcionar em segundo plano: pergunta ao Telegram se há mensagens novas e responde.

Não precisa abrir portas nem de endereço na internet: o programa é quem "puxa" as mensagens
(o Telegram guarda por cerca de 24 h as que chegarem com o computador desligado).
"""
import threading
import time
from datetime import datetime

from . import config as cfg_mod
from .api import Api, ErroTelegram
from . import leitura
from . import ocr as ocr_mod
from .conversa import AJUDA, Conversa

ESPERA_LONGA = 20          # (usado só para aguardar o encerramento)
ESPERA_CONSULTA = 3        # consulta curta: se algum antivírus/proxy segurar respostas, o atraso máximo é pequeno
ESPERA_ERRO = (5, 15, 30, 60)
ATRASO_FILA = 120          # mensagem com mais de 2 min de idade = chegou com o programa desligado (vai para a fila)
AUSENCIA_AVISO = 1800      # ficou 30 min ou mais sem ouvir o Telegram: avisa que voltou
SALVAR_VISTO_A_CADA = 60


class _Finais:
    """Lembra qual cartão cadastrado corresponde a cada 'final' (ex.: 7991), em telegram.json."""

    def __init__(self, pasta_config):
        self._pasta = pasta_config

    def get(self, final):
        return cfg_mod.carregar(self._pasta)["finais"].get(str(final))

    def set(self, final, cartao_id):
        cfg = cfg_mod.carregar(self._pasta)
        if cfg["finais"].get(str(final)) != str(cartao_id):
            cfg["finais"][str(final)] = str(cartao_id)
            cfg_mod.salvar(self._pasta, cfg)


class BotTelegram:
    def __init__(self, pasta_config, carregar, lancar, parecidos, log, url_base=None, parecidos_lista=None, ler_imagem=None, historico=None):
        self.pasta_config = pasta_config
        self.log = log
        self.url_base = url_base
        self._ler_imagem = ler_imagem or ocr_mod.ler
        self.conversa = Conversa(carregar, lancar, parecidos, parecidos_lista=parecidos_lista, finais=_Finais(pasta_config),
                                 historico=historico)
        self._thread = None
        self._parar = threading.Event()
        self._lock = threading.Lock()
        self.estado = {"rodando": False, "bot": None, "erro": None, "ultima_atividade": None, "ultima_mensagem": None}
        self._avisados = {}

    # ------------------------------------------------------------ controle
    def iniciar(self):
        with self._lock:
            cfg = cfg_mod.carregar(self.pasta_config)
            if not (cfg["ativo"] and cfg["token"]):
                self.estado.update(rodando=False, bot=None, erro=None)
                return False
            if self._thread and self._thread.is_alive():
                return True
            self._parar = threading.Event()
            self._thread = threading.Thread(target=self._laco, args=(self._parar, cfg["token"]), daemon=True, name="bot-telegram")
            self._thread.start()
            return True

    def parar(self, esperar=True):
        with self._lock:
            parar, thread = self._parar, self._thread
            parar.set()
        if esperar and thread and thread.is_alive():
            thread.join(timeout=ESPERA_LONGA + 20)
        self.estado.update(rodando=False)

    def reiniciar(self):
        """Chamado quando a configuração muda. Roda fora da requisição (a parada pode levar alguns segundos)."""
        threading.Thread(target=lambda: (self.parar(), self.iniciar()), daemon=True).start()

    # ------------------------------------------------------------ laço principal
    def _laco(self, parar, token):
        api = Api(token, self.url_base)
        offset, falhas = None, 0
        ultimo_ok, ultimo_visto = cfg_mod.ler_visto(self.pasta_config), 0
        self.estado.update(rodando=True, erro=None)
        try:
            api.limpar_webhook()
            self.estado["bot"] = (api.quem_sou() or {}).get("username")
        except ErroTelegram as e:
            self.estado.update(rodando=False, erro=self._explicar(e))
            if e.codigo in (401, 404):          # token errado: não adianta insistir
                return
        while not parar.is_set():
            try:
                novidades = api.novidades(offset, ESPERA_CONSULTA)
                falhas = 0
                agora = time.time()
                self.estado.update(rodando=True, erro=None, ultima_atividade=agora)
                if ultimo_ok is not None and agora - ultimo_ok > AUSENCIA_AVISO:      # programa desligado (ou computador dormindo)
                    self._avisar_volta(api, ultimo_ok, novidades)
                ultimo_ok = agora
                if agora - ultimo_visto > SALVAR_VISTO_A_CADA:
                    cfg_mod.gravar_visto(self.pasta_config, agora)
                    ultimo_visto = agora
                for up in novidades:
                    offset = up["update_id"] + 1
                    t0 = time.time()
                    try:
                        self._tratar(api, up)
                        self.log.info("Telegram: mensagem tratada em %.1f s", time.time() - t0)
                    except Exception:
                        self.log.exception("Falha ao tratar mensagem do Telegram")
                        self._avisar_falha(api, up)
            except ErroTelegram as e:
                self.estado.update(erro=self._explicar(e))
                if e.codigo in (401, 404):
                    self.estado["rodando"] = False
                    return
                parar.wait(ESPERA_ERRO[min(falhas, len(ESPERA_ERRO) - 1)])
                falhas += 1
            except Exception:
                self.log.exception("Erro inesperado no laço do Telegram")
                parar.wait(ESPERA_ERRO[min(falhas, len(ESPERA_ERRO) - 1)])
                falhas += 1
        self.estado["rodando"] = False
        cfg_mod.gravar_visto(self.pasta_config, time.time())
        api.fechar()

    @staticmethod
    def _mensagem_antiga(msg):
        quando = msg.get("date")
        return bool(quando) and time.time() - quando > ATRASO_FILA

    def _avisar_volta(self, api, desde, novidades):
        """'Voltei!': só se a pessoa quiser (Configs) e já tiver um usuário configurado."""
        cfg = cfg_mod.carregar(self.pasta_config)
        if not (cfg["avisar_volta"] and cfg["usuario_id"] is not None):
            return
        esperando = sum(1 for up in novidades if (up.get("message") or {}).get("from", {}).get("id") == cfg["usuario_id"]
                        and self._mensagem_antiga(up["message"]) and (up["message"].get("text") or self._arquivo_de_imagem(up["message"])))
        texto = f"🟢 Voltei! Fiquei desligado desde {datetime.fromtimestamp(desde).strftime('%d/%m %H:%M')}."
        if esperando:
            texto += (f"\nVocê me mandou {esperando} mensagem(ns) nesse tempo. Vou mostrar uma de cada vez, "
                      "usando como data o dia em que você mandou cada uma (dá para trocar no botão 📅).")
        try:
            api.enviar(cfg["usuario_id"], texto)
        except ErroTelegram:
            pass

    @staticmethod
    def _explicar(e):
        if e.codigo in (401, 404):
            return "O token do bot não foi aceito pelo Telegram. Confira se copiou inteiro."
        if e.codigo == 409:
            return "Outro programa está usando este mesmo bot (feche a outra cópia do Financeiro)."
        if e.codigo == 0:
            return "Sem conexão com o Telegram. Tento de novo sozinho."
        return f"Telegram respondeu: {e.descricao}"

    # ------------------------------------------------------------ mensagens
    def _avisar_falha(self, api, up):
        """Nunca deixa a pessoa no silêncio: se algo der errado ao tratar a mensagem, avisa no próprio Telegram."""
        try:
            m = up.get("message") or (up.get("callback_query") or {}).get("message") or {}
            chat = (m.get("chat") or {}).get("id")
            if chat:
                api.enviar(chat, "⚠️ Tive um problema ao processar isso. Tente de novo; se repetir, avise o suporte (o detalhe ficou no registro do programa).")
        except Exception:
            pass

    def _registrar(self, de, autorizado, tipo):
        self.estado["ultima_mensagem"] = {"quando": time.time(), "de": de, "autorizado": autorizado, "tipo": tipo}
        self.log.info("Telegram: %s de %s (%s)", tipo, de, "autorizado" if autorizado else "NÃO autorizado")

    def _tratar(self, api, up):
        cfg = cfg_mod.carregar(self.pasta_config)
        if "callback_query" in up:
            cq = up["callback_query"]
            de = (cq.get("from") or {}).get("id")
            self._registrar(de, cfg["usuario_id"] is not None and de == cfg["usuario_id"], "botão")
            if cfg["usuario_id"] is None or de != cfg["usuario_id"]:
                return
            msg = cq.get("message") or {}
            chat = (msg.get("chat") or {}).get("id")
            try:
                for r in self.conversa.botao(chat, cq.get("data") or ""):
                    self._enviar(api, chat, r, msg.get("message_id"))
            finally:
                try:
                    api.responder_botao(cq["id"])      # tira o "relógio" do botão
                except ErroTelegram:
                    pass
            return
        msg = up.get("message")
        if not msg:
            return
        de = (msg.get("from") or {}).get("id")
        chat = (msg.get("chat") or {}).get("id")
        if (msg.get("chat") or {}).get("type") != "private":
            return
        self._registrar(de, cfg["usuario_id"] is not None and de == cfg["usuario_id"], "mensagem")
        if cfg["usuario_id"] is None:
            # Ainda não configurado: só diz qual é o ID da pessoa, para ela colar no programa.
            api.enviar(chat, f"Seu número de usuário no Telegram é <code>{de}</code>.\n"
                             "No programa, abra Configs → Telegram, cole esse número no campo indicado e salve.")
            return
        if de != cfg["usuario_id"]:
            self.log.warning("Mensagem de usuário não autorizado ignorada (id %s)", de)
            # Avisa (no máximo 1 vez por minuto) para o erro mais comum não ficar mudo: número digitado errado.
            if time.time() - self._avisados.get(de, 0) > 60:
                self._avisados[de] = time.time()
                api.enviar(chat, f"🔒 Este bot está configurado para outra pessoa. Seu número de usuário é <code>{de}</code>.\n"
                                 "Se você é o dono, abra Configs → Telegram no programa e confira se o número é exatamente este.")
            return
        quando = msg.get("date")
        dia = datetime.fromtimestamp(quando).date() if quando else None     # a data do gasto é o dia em que você ENVIOU
        antiga = self._mensagem_antiga(msg)
        arquivo = self._arquivo_de_imagem(msg)
        if arquivo:
            self._tratar_imagem(api, chat, arquivo, msg.get("caption") or "", dia, antiga)
            return
        if msg.get("document") or msg.get("video") or msg.get("voice"):
            api.enviar(chat, "Só consigo ler imagens (print) ou texto. Mande o gasto assim: <code>45,90 uber</code>")
            return
        for r in self.conversa.texto(chat, msg.get("text") or "", dia=dia, fila=antiga):
            self._enviar(api, chat, r, None)

    @staticmethod
    def _arquivo_de_imagem(msg):
        if msg.get("photo"):
            return msg["photo"][-1].get("file_id")              # a última é a maior
        doc = msg.get("document") or {}
        if str(doc.get("mime_type") or "").startswith("image/"):
            return doc.get("file_id")
        return None

    def _tratar_imagem(self, api, chat, file_id, legenda, dia=None, antiga=False):
        """Baixa o print, lê com OCR local e segue a conversa. A imagem existe só na memória, nunca vai para o disco."""
        try:
            if not antiga:
                api.enviar(chat, "🔎 Lendo o print…")
            conteudo = api.baixar_arquivo(file_id)
            try:
                largura, linhas = self._ler_imagem(conteudo)
            finally:
                del conteudo
            lido = leitura.interpretar(largura, linhas)
        except ocr_mod.OcrIndisponivel:
            self.log.exception("Leitura de imagem indisponível")
            api.enviar(chat, "A leitura de prints não está disponível nesta instalação. Mande o gasto em texto, por exemplo: <code>45,90 uber</code>")
            return
        except ErroTelegram:
            api.enviar(chat, "Não consegui baixar o print do Telegram agora. Tente enviar de novo.")
            return
        except Exception:
            self.log.exception("Falha ao ler o print")
            api.enviar(chat, "😕 Não consegui ler esse print. Tente de novo com um print mais nítido, ou mande o gasto em texto.")
            return
        self.log.info("Telegram: print lido (%s, %d compra(s))", lido["tipo"], len(lido["itens"]))
        for r in self.conversa.imagem(chat, lido, legenda, dia=dia, fila=antiga):
            self._enviar(api, chat, r, None)

    def _enviar(self, api, chat, resposta, mensagem_id):
        if resposta["modo"] == "editar" and mensagem_id:
            try:
                api.editar(chat, mensagem_id, resposta["texto"], resposta["botoes"])
                return
            except ErroTelegram as e:
                if "not modified" in e.descricao.lower():
                    return
        api.enviar(chat, resposta["texto"], resposta["botoes"])
