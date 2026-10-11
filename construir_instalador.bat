@echo off
cd /d "%~dp0"
if not exist "dist\Financeiro\Financeiro.exe" (
    echo O programa ainda nao foi criado. Execute primeiro o construir_programa.bat
    if not "%1"=="nopause" pause
    exit /b 1
)
set ISCC=
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe
if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe
if not defined ISCC (
    echo O Inno Setup nao esta instalado.
    echo Baixe gratis em https://jrsoftware.org/isdl.php , instale e rode este arquivo de novo.
    if not "%1"=="nopause" pause
    exit /b 1
)
"%ISCC%" instalador.iss
if errorlevel 1 (
    echo Algo deu errado. Tire uma foto desta tela e envie para suporte.
    if not "%1"=="nopause" pause
    exit /b 1
)
echo.
echo PRONTO! O instalador esta na pasta:  instalador
if not "%1"=="nopause" pause
