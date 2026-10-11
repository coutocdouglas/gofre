@echo off
cd /d "%~dp0"
echo === Testes do servidor (Python) ===
py -m pytest tests -q
echo.
echo === Testes das regras de negocio (JavaScript) ===
node --test tests/test_dominio.test.js tests/test_importacao_ui.test.js tests/test_busca.test.js tests/test_relatorios.test.js
echo.
pause
