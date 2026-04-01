@echo off
setlocal
cd /d "%~dp0backend"

echo Satis Siparis Portali baslatiliyor...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3000') do (
  taskkill /PID %%p /F >nul 2>nul
)

set "PYTHON_EXE=%LocalAppData%\Programs\Python\Python313\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

start "Sales Order Portal" cmd /k ""%PYTHON_EXE%" server.py"

timeout /t 2 /nobreak >nul
start "" http://localhost:3000

echo Portal acildi. Tarayicida http://localhost:3000 adresini kullanabilirsiniz.
endlocal
