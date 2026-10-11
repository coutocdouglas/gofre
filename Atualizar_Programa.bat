@echo off
cd /d "%~dp0"
echo ==========================================================
echo  Atualizar o Financeiro (um clique so)
echo  Cria o programa novo e instala por cima do antigo.
echo  Seus dados NAO sao apagados. Demora alguns minutos.
echo ==========================================================
echo.
set MODO=%1
call construir_programa.bat nopause
if errorlevel 1 exit /b 1
call construir_instalador.bat nopause
if errorlevel 1 exit /b 1
set INST=
for /f "delims=" %%f in ('dir /b /o-d "instalador\Instalar_Financeiro_*.exe"') do if not defined INST set INST=instalador\%%f
if not defined INST (
    echo Nao achei o instalador criado.
    pause
    exit /b 1
)
echo Instalando %INST% ...
taskkill /im Financeiro.exe /f >nul 2>&1
"%INST%" /SILENT /CLOSEAPPLICATIONS /NORESTART
echo.
echo ==========================================================
echo  PRONTO! O Financeiro foi atualizado. Abra pelo atalho.
echo ==========================================================
pause
