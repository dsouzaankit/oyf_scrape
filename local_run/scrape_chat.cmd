@echo off
REM Double-click this to run chat scrape in a maximized console (Win10-style).
set "WEB_SCRAPE_IN_CONHOST=1"
start "oyf-scrape-chat" /max "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scrape_chat.ps1"
