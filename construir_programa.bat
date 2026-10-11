@echo off
cd /d "%~dp0"
echo ==========================================================
echo  Criando o programa Financeiro (.exe)
echo  Isso demora alguns minutos e so precisa ser feito de novo
echo  quando o sistema for atualizado.
echo ==========================================================
echo.
py --version
if errorlevel 1 (
    echo Python nao encontrado.
    if not "%1"=="nopause" pause
    exit /b 1
)

echo [1/4] Preparando ambiente...
if not exist ".venv_build\Scripts\python.exe" py -m venv .venv_build
if errorlevel 1 goto erro

echo [2/4] Instalando componentes...
".venv_build\Scripts\python.exe" -m pip install --upgrade pip -q
".venv_build\Scripts\python.exe" -m pip install -r requirements-desktop.txt pyinstaller -q
if errorlevel 1 goto erro

echo [3/4] Montando o programa...
".venv_build\Scripts\python.exe" -m PyInstaller --noconfirm --clean financeiro.spec
if errorlevel 1 goto erro

echo [4/4] Conferindo...
if not exist "dist\Financeiro\Financeiro.exe" goto erro

echo.
echo ==========================================================
echo  PRONTO!
echo  O programa esta em:  dist\Financeiro\Financeiro.exe
echo  Para criar o atalho na Area de Trabalho, de dois cliques
echo  em  criar_atalho.bat
echo ==========================================================
if not "%1"=="nopause" pause
exit /b 0

:erro
echo.
echo ----------------------------------------------------------
echo  Algo deu errado. Tire uma foto (ou copie o texto) desta
echo  tela e envie para suporte.
echo ----------------------------------------------------------
if not "%1"=="nopause" pause
exit /b 1
