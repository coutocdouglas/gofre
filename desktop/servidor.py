"""Sobe o servidor do Financeiro em segundo plano, só para este computador."""
import threading
import time
import urllib.request


def iniciar_servidor(flask_app, porta):
    """Inicia o servidor numa thread. Retorna o objeto do servidor (use .shutdown() para parar)."""
    from werkzeug.serving import make_server
    servidor = make_server("127.0.0.1", porta, flask_app, threaded=True)
    threading.Thread(target=servidor.serve_forever, daemon=True, name="servidor-financeiro").start()
    return servidor


def aguardar_servidor(porta, tentativas=60, intervalo=0.25):
    """Espera o servidor responder antes de abrir a janela. True se respondeu."""
    url = f"http://127.0.0.1:{porta}/"
    for _ in range(tentativas):
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(intervalo)
    return False
