@echo off
cd /d "%~dp0"
echo Iniciando o Financeiro 2026 PRO...
py -m pip install -q -r requirements.txt
py app.py
if errorlevel 1 (
    echo.
    echo O sistema encerrou com erro. Veja a mensagem acima.
    pause
)
