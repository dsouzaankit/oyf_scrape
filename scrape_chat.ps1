Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$HomeDirectory = if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'Z:\STUDY\web_scrape' }
$CredsPath = Join-Path $HomeDirectory 'data\creds.env'
$LogsFolder = Join-Path $HomeDirectory 'logs'
New-Item -ItemType Directory -Force -Path $LogsFolder | Out-Null
$LogPath = Join-Path $LogsFolder ("scrape_chat_{0:yyyyMMddTHHmmss}.log" -f (Get-Date))

Write-Host "creds.env: $CredsPath"
Write-Host "log:       $LogPath"
@(
    "creds.env: $CredsPath"
    "log:       $LogPath"
    "started:   $(Get-Date -Format o)"
    ''
) | Set-Content -LiteralPath $LogPath -Encoding utf8

function Invoke-NodeScrape {
    param(
        [Parameter(Mandatory = $true)][string[]]$NodeArgs,
        [Parameter(Mandatory = $true)][string]$LogPath
    )
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & node @NodeArgs 2>&1 | ForEach-Object {
        $line = $_.ToString()
        Write-Host $line
        Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
    }
    $ErrorActionPreference = $prevEap
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return $code
}

$exitCode = 0
$scrapeFailed = $false
try {
    $exitCode = Invoke-NodeScrape -NodeArgs @((Join-Path $PSScriptRoot 'node_script\web_scrape.js'), 'chat') -LogPath $LogPath
    Add-Content -LiteralPath $LogPath -Value "`nfinished: $(Get-Date -Format o)`nexit: $exitCode" -Encoding utf8
    if ($exitCode -ne 0) {
        Write-Host "Scrape failed (exit $exitCode). Skipping media origin tracker."
        $scrapeFailed = $true
        return
    }

    $trackerScript = Join-Path $HomeDirectory 'sql_script\run_media_origin_tracker_by_days.ps1'
    if (-not (Test-Path -LiteralPath $trackerScript)) {
        throw "Tracker script not found: $trackerScript"
    }
    Write-Host "Scrape OK. Running media origin tracker: $trackerScript"
    & $trackerScript -HomeDirectory $HomeDirectory
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
    if ($exitCode -ne 0) {
        Write-Host "Media origin tracker failed (exit $exitCode)."
        $scrapeFailed = $true
    }
} catch {
    Write-Host $_.Exception.Message
    $exitCode = 1
    $scrapeFailed = $true
}

if ($scrapeFailed) {
    Read-Host 'Press Enter to exit'
}
exit $exitCode
