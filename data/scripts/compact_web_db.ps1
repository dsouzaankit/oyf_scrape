Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$HomeDirectory = if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'Z:\STUDY\web_scrape' }
$DbPath = Join-Path $HomeDirectory 'data\web.db'
$LogsFolder = Join-Path $HomeDirectory 'logs'
New-Item -ItemType Directory -Force -Path $LogsFolder | Out-Null
$LogPath = Join-Path $LogsFolder ("compact_web_db_{0:yyyyMMddTHHmmss}.log" -f (Get-Date))

Write-Host "web.db: $DbPath"
Write-Host "log:    $LogPath"
@(
    "web.db: $DbPath"
    "log:    $LogPath"
    "started: $(Get-Date -Format o)"
    ''
) | Set-Content -LiteralPath $LogPath -Encoding utf8

if (-not (Test-Path -LiteralPath $DbPath)) {
    throw "Database not found: $DbPath"
}

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& node (Join-Path $PSScriptRoot 'compact_web_db.js') $DbPath 2>&1 | ForEach-Object {
    $line = $_.ToString()
    Write-Host $line
    Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
}
$ErrorActionPreference = $prevEap

$exitCode = $LASTEXITCODE
if ($null -eq $exitCode) { $exitCode = 0 }
Add-Content -LiteralPath $LogPath -Value "`nfinished: $(Get-Date -Format o)`nexit: $exitCode" -Encoding utf8

if ($exitCode -ne 0) {
    Write-Host "compact_web_db failed (exit $exitCode). Close web_scrape.js and duckdb-cli, then retry."
}

Read-Host 'Press Enter to exit'
exit $exitCode
