@echo off
taskkill /IM WorkBar.exe /F >nul 2>&1
echo WorkBar 已退出。
timeout /t 2 >nul
exit /b 0
