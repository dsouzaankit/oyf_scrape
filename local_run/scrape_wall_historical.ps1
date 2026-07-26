Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
$HomeDirectory = if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'P:\all_scripts\oyf_scrape' }
# node_modules lives on a local disk (pCloud/network drives lock/slow it); expose it to node via NODE_PATH.
$DepsHome = if ($env:WEB_SCRAPE_NODE_HOME) { $env:WEB_SCRAPE_NODE_HOME } else { Join-Path $env:LOCALAPPDATA 'oyf_scrape' }
$env:NODE_PATH = Join-Path $DepsHome 'node_modules'
$configPath = Join-Path $HomeDirectory 'data\config.env'
$LogsFolder = Join-Path $HomeDirectory 'logs'
New-Item -ItemType Directory -Force -Path $LogsFolder | Out-Null
$LogPath = Join-Path $LogsFolder ("scrape_wall_hist_{0:yyyyMMddTHHmmss}.log" -f (Get-Date))

Write-Host "Historical wall scrape"
Write-Host "  start year = newer (date-picker jump to earliest day of that year)"
Write-Host "  end year   = older (stop when batch newest is before that year)"
Write-Host "config.env: $configPath"
Write-Host "log:       $LogPath"
Write-Host ""

function Read-Year {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [Parameter(Mandatory = $true)][int]$MinYear
    )
    while ($true) {
        $raw = Read-Host $Prompt
        if ($raw -match '^\d{4}$') {
            $y = [int]$raw
            if ($y -ge $MinYear -and $y -le ([DateTime]::UtcNow.Year + 1)) {
                return $y
            }
        }
        Write-Host "Enter a 4-digit year >= $MinYear (e.g. 2022)."
    }
}

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
    # Native exit code after a pipeline is unreliable on some Windows PowerShell builds;
    # prefer $LASTEXITCODE when set, else treat pipeline failure as error.
    $code = $LASTEXITCODE
    if ($null -eq $code) {
        $code = if (-not $?) { 1 } else { 0 }
    }
    $ErrorActionPreference = $prevEap
    return $code
}

$exitCode = 0
$scrapeFailed = $false
try {
    $StartYear = Read-Year -Prompt 'Start year (newer)' -MinYear 2000
    $EndYear = Read-Year -Prompt 'End year (older)' -MinYear 2000
    if ($StartYear -lt $EndYear) {
        throw "Start year ($StartYear) must be >= end year ($EndYear) (start = newer, end = older)."
    }

    Write-Host ""
    Write-Host "Scraping wall from earliest $StartYear down through $EndYear (stop when batch newest < ${EndYear}-01-01)."

    @(
        "config.env: $configPath"
        "log:       $LogPath"
        "hist:      start=$StartYear end=$EndYear"
        "started:   $(Get-Date -Format o)"
        ''
    ) | Set-Content -LiteralPath $LogPath -Encoding utf8

    $nodeScript = Join-Path $RepoRoot 'node_script\web_scrape.js'
    $env:WALL_HIST_NO_NODE_PAUSE = '1'
    $exitCode = Invoke-NodeScrape -NodeArgs @(
        $nodeScript
        'wall'
        "--hist-start=$StartYear"
        "--hist-end=$EndYear"
    ) -LogPath $LogPath
    Add-Content -LiteralPath $LogPath -Value "`nfinished: $(Get-Date -Format o)`nexit: $exitCode" -Encoding utf8
    if ($exitCode -ne 0) {
        Write-Host "Historical wall scrape failed (exit $exitCode)."
        $scrapeFailed = $true
    } else {
        Write-Host "Historical wall scrape finished OK. (Media origin tracker not run — invoke separately if needed.)"
    }
} catch {
    Write-Host $_.Exception.Message
    $exitCode = 1
    $scrapeFailed = $true
}

if ($scrapeFailed -or $exitCode -ne 0) {
    Read-Host 'Press Enter to exit'
}
exit $exitCode
