@echo off
cd /d "%~dp0"
if not exist "dist\Financeiro\Financeiro.exe" (
    echo O programa ainda nao foi criado. Execute primeiro o construir_programa.bat
    pause
    exit /b 1
)
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Financeiro 2026 PRO.lnk'); $s.TargetPath='%~dp0dist\Financeiro\Financeiro.exe'; $s.WorkingDirectory='%~dp0dist\Financeiro'; $s.IconLocation='%~dp0dist\Financeiro\Financeiro.exe'; $s.Save()"
echo Atalho criado na Area de Trabalho.
pause
