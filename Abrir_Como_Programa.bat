@echo off
cd /d "%~dp0"
echo Verificando componentes (so demora na primeira vez)...
py -m pip install -q -r requirements-desktop.txt
if errorlevel 1 (
    echo.
    echo Nao foi possivel instalar os componentes. Tire uma foto desta tela e envie.
    pause
    exit /b 1
)
echo Abrindo o Financeiro...
py main.py
if errorlevel 1 pause
