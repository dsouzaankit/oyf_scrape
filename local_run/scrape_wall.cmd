@echo off
set "WEB_SCRAPE_IN_CONHOST=1"
start "oyf-scrape-wall" /max "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scrape_wall.ps1"
