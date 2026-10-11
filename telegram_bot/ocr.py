"""Leitura de imagens (OCR) 100% local e gratuita. A imagem fica só na memória: nunca é gravada em disco
nem enviada para nenhum serviço. O motor só é carregado na primeira vez que um print chega."""
import threading

_motor = None
_trava = threading.Lock()


class OcrIndisponivel(Exception):
    pass


def _carregar_motor():
    global _motor
    with _trava:
        if _motor is None:
            try:
                from rapidocr_onnxruntime import RapidOCR
            except Exception as e:                      # pacote ausente ou biblioteca nativa que não carregou
                raise OcrIndisponivel(str(e))
            _motor = RapidOCR()
        return _motor


def ler(conteudo):
    """bytes da imagem -> (largura, [ {"x0","x1","y","h","texto","conf"} ... ] ordenadas de cima para baixo)."""
    import cv2
    import numpy as np
    motor = _carregar_motor()
    img = cv2.imdecode(np.frombuffer(conteudo, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("imagem inválida")
    alt, larg = img.shape[:2]
    if larg < 700:                                       # print pequeno: ampliar ajuda a ler os números
        f = 700 / larg
        img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
        alt, larg = img.shape[:2]
    resultado, _ = motor(img)
    linhas = []
    for caixa, texto, conf in resultado or []:
        xs = [p[0] for p in caixa]
        ys = [p[1] for p in caixa]
        linhas.append({"x0": min(xs), "x1": max(xs), "y": sum(ys) / len(ys), "h": max(ys) - min(ys),
                       "texto": str(texto).strip(), "conf": float(conf)})
    linhas.sort(key=lambda l: (l["y"], l["x0"]))
    return larg, linhas
