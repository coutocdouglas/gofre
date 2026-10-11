"""Garante que só uma cópia do programa fique aberta.

A primeira cópia 'reserva' uma porta local. Se o usuário abrir o programa de novo,
a segunda cópia avisa a primeira ("mostre sua janela") e se fecha.
"""
import socket
import threading

PORTA_TRAVA = 47615
MENSAGEM_MOSTRAR = b"mostrar"


class InstanciaUnica:
    def __init__(self, porta=PORTA_TRAVA):
        self.porta = porta
        self._servidor = None
        self._ativo = False

    def tentar_adquirir(self):
        """True se esta é a primeira cópia. False se já existe outra aberta."""
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", self.porta))
            s.listen(5)
        except OSError:
            s.close()
            return False
        self._servidor = s
        return True

    def avisar_instancia_existente(self):
        """Pede à primeira cópia para mostrar a janela. True se ela respondeu."""
        try:
            with socket.create_connection(("127.0.0.1", self.porta), timeout=2) as c:
                c.sendall(MENSAGEM_MOSTRAR)
            return True
        except OSError:
            return False

    def escutar(self, ao_receber_pedido):
        """Fica ouvindo (em segundo plano) pedidos de outras cópias."""
        self._ativo = True

        def laco():
            while self._ativo and self._servidor:
                try:
                    conexao, _ = self._servidor.accept()
                except OSError:
                    break
                try:
                    with conexao:
                        conexao.settimeout(2)
                        if conexao.recv(32).strip() == MENSAGEM_MOSTRAR:
                            ao_receber_pedido()
                except OSError:
                    pass

        threading.Thread(target=laco, daemon=True).start()

    def liberar(self):
        self._ativo = False
        if self._servidor:
            try:
                # acorda a escuta que está esperando conexões; sem isso a porta pode ficar presa
                self._servidor.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                self._servidor.close()
            except OSError:
                pass
            self._servidor = None
