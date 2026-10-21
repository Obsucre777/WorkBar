@echo off
taskkill /IM Workbar.exe /F >nul 2>&1
echo Workbar 已退出。
timeout /t 2 >nul
exit /b 0
