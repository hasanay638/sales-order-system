@echo off
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3000') do (
  taskkill /PID %%p /F >nul 2>nul
)
echo 3000 portundaki portal islemleri durduruldu.
