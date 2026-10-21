@echo off
setlocal
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0seed-demo.ps1" -Fresh
exit /b 0
