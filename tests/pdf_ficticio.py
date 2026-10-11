"""Gera PDFs de teste (com ou sem senha) a partir dos textos de exemplo."""
import io


def gerar_pdf(paginas, senha=None, algoritmo="AES-128"):
    reportlab = __import__("pytest").importorskip("reportlab")
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    for texto in paginas:
        y = 810
        c.setFont("Helvetica", 8)
        for linha in texto.split("\n"):
            c.drawString(30, y, linha)
            y -= 11
        c.showPage()
    c.save()
    dados = buf.getvalue()
    if not senha:
        return dados

    pypdf = __import__("pytest").importorskip("pypdf")
    escritor = pypdf.PdfWriter(clone_from=pypdf.PdfReader(io.BytesIO(dados)))
    escritor.encrypt(senha, algorithm=algoritmo)
    saida = io.BytesIO()
    escritor.write(saida)
    return saida.getvalue()
