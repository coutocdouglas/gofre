# -*- mode: python ; coding: utf-8 -*-
# Receita para gerar o programa (.exe). Usada pelo construir_programa.bat
from PyInstaller.utils.hooks import collect_all, collect_submodules

hidden = collect_submodules('webview') + ['pystray._win32', 'clr', 'clr_loader']

# Leitor de fatura em PDF (Fase 3): traz junto os arquivos que essas bibliotecas precisam
extra_datas, extra_bins = [], []
# + leitor de prints do Telegram (OCR local): modelos .onnx e bibliotecas nativas
for pacote in ('pdfplumber', 'pdfminer', 'pypdfium2', 'pypdfium2_raw', 'cryptography',
               'rapidocr_onnxruntime', 'onnxruntime'):
    d, b, h = collect_all(pacote)
    extra_datas += d
    extra_bins += b
    hidden += h
hidden += collect_submodules('importacao')
hidden += collect_submodules('telegram_bot')

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=extra_bins,
    datas=[('templates', 'templates'), ('static', 'static'), ('assets', 'assets')] + extra_datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=['pytest', 'tkinter'],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='Financeiro',
    debug=False,
    strip=False,
    upx=False,
    console=False,
    icon='assets/icone.ico',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='Financeiro',
)
