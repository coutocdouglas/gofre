"""Cliente mínimo da API de bots do Telegram (só biblioteca padrão: sem dependências novas)."""
import http.client
import json
import logging
import os
import socket
import threading
import time
import urllib.parse

URL_PADRAO = "https://api.telegram.org"


class ErroTelegram(Exception):
    def __init__(self, codigo, descricao):
        super().__init__(f"{codigo}: {descricao}")
        self.codigo = codigo
        self.descricao = descricao


def _conectar_rapido(host, porta, timeout):
    """Tenta primeiro IPv4 (rápido, 5 s no máximo) e só depois IPv6. Em muitas redes o IPv6 'trava' por ~20 s
    antes de desistir, e era isso que deixava o bot lento."""
    infos = socket.getaddrinfo(host, porta, 0, socket.SOCK_STREAM)
    infos.sort(key=lambda i: 0 if i[0] == socket.AF_INET else 1)
    ultimo = None
    for fam, tipo, proto, _, addr in infos:
        sock = socket.socket(fam, tipo, proto)
        try:
            sock.settimeout(min(5, timeout) if timeout else 5)
            sock.connect(addr)
            sock.settimeout(timeout)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            return sock
        except OSError as e:
            ultimo = e
            sock.close()
    raise ultimo or OSError("sem endereço para conectar")


class _ConexaoHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = _conectar_rapido(self.host, self.port, self.timeout)


class _ConexaoHTTPS(http.client.HTTPSConnection):
    def connect(self):
        sock = _conectar_rapido(self.host, self.port, self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class Api:
    """Mantém a conexão com o Telegram aberta entre as chamadas (evita refazer a conexão segura a cada botão,
    que era o que deixava as respostas lentas)."""

    def __init__(self, token, base=None):
        self.token = token
        self.base = (base or os.environ.get("FINANCEIRO_TELEGRAM_URL") or URL_PADRAO).rstrip("/")
        u = urllib.parse.urlsplit(self.base)
        self._https = u.scheme == "https"
        self._host = u.hostname
        self._porta = u.port or (443 if self._https else 80)
        self._prefixo = u.path.rstrip("/")
        self._conexoes = {}
        self.ultima_duracao = None
        self._trava = {"cmd": threading.Lock(), "poll": threading.Lock()}

    def _nova(self, timeout):
        if self._https:
            return _ConexaoHTTPS(self._host, self._porta, timeout=timeout)
        return _ConexaoHTTP(self._host, self._porta, timeout=timeout)

    def _http(self, canal, metodo_http, caminho, corpo, timeout):
        """Uma chamada HTTP reaproveitando a conexão aberta. -> (status, bytes)."""
        cab = {"Connection": "keep-alive"}
        if corpo is not None:
            cab["Content-Type"] = "application/json"
        inicio = time.time()
        with self._trava[canal]:
            for tentativa in (0, 1):
                con = self._conexoes.get(canal)
                reutilizada = con is not None
                if con is None:
                    con = self._conexoes[canal] = self._nova(timeout)
                con.timeout = timeout
                if con.sock is not None:
                    con.sock.settimeout(timeout)
                try:
                    con.request(metodo_http, caminho, body=corpo, headers=cab)
                    resp = con.getresponse()
                    dados = resp.read()
                    status = resp.status
                    break
                except (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError, http.client.CannotSendRequest) as e:
                    con.close()
                    self._conexoes.pop(canal, None)
                    if reutilizada and tentativa == 0:      # a conexão guardada já tinha sido fechada pelo servidor
                        continue
                    raise ErroTelegram(0, f"sem conexão ({e})")
                except (OSError, http.client.HTTPException) as e:
                    con.close()
                    self._conexoes.pop(canal, None)
                    raise ErroTelegram(0, f"sem conexão ({e})")
        self.ultima_duracao = (caminho.rsplit("/", 1)[-1], time.time() - inicio)
        return status, dados

    def _requisitar(self, canal, metodo, corpo, timeout):
        caminho = f"{self._prefixo}/bot{self.token}/{metodo}"
        status, bruto = self._http(canal, "POST", caminho, json.dumps(corpo).encode("utf-8"), timeout)
        nome = metodo
        if nome != "getUpdates" and self.ultima_duracao[1] > 2:
            logging.getLogger("financeiro").warning("Telegram lento: %s levou %.1f s", nome, self.ultima_duracao[1])
        try:
            dados = json.loads(bruto.decode("utf-8"))
        except ValueError:
            raise ErroTelegram(status, "resposta inválida")
        if not dados.get("ok"):
            raise ErroTelegram(dados.get("error_code", status), dados.get("description", "erro"))
        return dados.get("result")

    def baixar_arquivo(self, file_id, limite=15 * 1024 * 1024):
        """Baixa uma foto/arquivo enviado ao bot. Fica só na memória (bytes)."""
        info = self.chamar("getFile", file_id=file_id) or {}
        if info.get("file_size") and info["file_size"] > limite:
            raise ErroTelegram(0, "arquivo grande demais")
        status, bruto = self._http("cmd", "GET", f"{self._prefixo}/file/bot{self.token}/{info.get('file_path')}", None, 30)
        if status != 200:
            raise ErroTelegram(status, "não consegui baixar o arquivo")
        return bruto

    def chamar(self, metodo, timeout=15, **parametros):
        return self._requisitar("cmd", metodo, {k: v for k, v in parametros.items() if v is not None}, timeout)

    def fechar(self):
        for con in list(self._conexoes.values()):
            try:
                con.close()
            except Exception:
                pass
        self._conexoes.clear()

    # ---- métodos usados ----
    def quem_sou(self):
        return self.chamar("getMe")

    def limpar_webhook(self):
        return self.chamar("deleteWebhook")

    def novidades(self, offset, espera=20):
        return self._novidades(offset, espera)

    def _novidades(self, offset, espera):
        corpo = {"offset": offset, "timeout": espera, "allowed_updates": ["message", "callback_query"]}
        return self._requisitar("poll", "getUpdates", {k: v for k, v in corpo.items() if v is not None}, espera + 15) or []

    def enviar(self, chat_id, texto, botoes=None):
        return self.chamar("sendMessage", chat_id=chat_id, text=texto, parse_mode="HTML",
                           reply_markup=_teclado(botoes), disable_web_page_preview=True)

    def editar(self, chat_id, mensagem_id, texto, botoes=None):
        return self.chamar("editMessageText", chat_id=chat_id, message_id=mensagem_id, text=texto,
                           parse_mode="HTML", reply_markup=_teclado(botoes) or {"inline_keyboard": []},
                           disable_web_page_preview=True)

    def responder_botao(self, callback_id, texto=None):
        return self.chamar("answerCallbackQuery", callback_query_id=callback_id, text=texto)


def _teclado(botoes):
    if not botoes:
        return None
    return {"inline_keyboard": [[{"text": t, "callback_data": d} for t, d in linha] for linha in botoes]}
