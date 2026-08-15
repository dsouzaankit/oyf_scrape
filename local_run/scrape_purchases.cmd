@echo off
set "WEB_SCRAPE_IN_CONHOST=1"
start "oyf-scrape-purchases" /max "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scrape_purchases.ps1"
