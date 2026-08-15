# First-time / idempotent setup for oyf_scrape on this Windows PC.
# Installs Node.js + DuckDB CLI (winget), npm deps on a local disk, and checks data folders.
# Does not overwrite data/config.env or data/web.db.
#
# Usage:
#   & '.\local_run\local_setup\setup_this_pc.ps1'
#   & '.\local_run\local_setup\setup_this_pc.ps1' -SkipWinget   # deps only (Node/DuckDB already installed)
#   & '.\local_run\local_setup\setup_this_pc.ps1' -SkipNpm

param(
    [string] $HomeDirectory = $(if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'P:\all_scripts\oyf_scrape' }),
    [string] $DepsHome = $(if ($env:WEB_SCRAPE_NODE_HOME) { $env:WEB_SCRAPE_NODE_HOME } else { Join-Path $env:LOCALAPPDATA 'oyf_scrape' }),
    [switch] $SkipWinget,
    [switch] $SkipNpm
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$NodeWingetId = 'OpenJS.NodeJS.22'
$DuckDbWingetId = 'DuckDB.cli'
$MinNodeMajor = 18

function Write-SetupStep {
    param([string] $Message)
    Write-Host ""
    Write-Host "==> $Message"
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machine, $user) -join ';'
}

function Test-CommandExists {
    param([string] $Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-NodeVersion {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    $raw = (& node -v 2>$null)
    if (-not $raw) { return $null }
    return $raw.ToString().Trim()
}

function Test-NodeUsable {
    $ver = Get-NodeVersion
    if (-not $ver) { return $false }
    if ($ver -match '^v?(\d+)') {
        return ([int]$Matches[1] -ge $MinNodeMajor)
    }
    return $false
}

function Invoke-WingetInstall {
    param([Parameter(Mandatory)][string] $PackageId)

    if (-not (Test-CommandExists 'winget')) {
        throw 'winget is not available. Install Node.js 22+ and DuckDB CLI manually, then re-run with -SkipWinget.'
    }

    Write-Host "winget install $PackageId"
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & winget install --id $PackageId -e --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-Host
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($null -eq $code) { $code = 0 }

    # 0 = success; -1978335189 / -1978335135 = already installed / no applicable update
    $okCodes = @(0, -1978335189, -1978335135)
    if ($okCodes -notcontains $code) {
        throw "winget install $PackageId failed (exit $code). Approve a UAC prompt if shown, or install the package yourself and re-run with -SkipWinget."
    }
}

function Install-NodeIfNeeded {
    Refresh-ProcessPath
    if (Test-NodeUsable) {
        Write-Host ("Node.js already usable: {0}" -f (Get-NodeVersion))
        return
    }
    if ($SkipWinget) {
        throw "Node.js $MinNodeMajor+ not found on PATH. Install it or omit -SkipWinget."
    }
    $null = Invoke-WingetInstall -PackageId $NodeWingetId
    Refresh-ProcessPath
    if (-not (Test-NodeUsable)) {
        throw "Node.js was installed but this shell still cannot run 'node'. Open a new terminal and re-run this script with -SkipWinget."
    }
    Write-Host ("Node.js ready: {0}" -f (Get-NodeVersion))
}

function Install-DuckDbIfNeeded {
    $resolver = Join-Path $PSScriptRoot 'resolve_duckdb.ps1'
    . $resolver
    Refresh-ProcessPath
    $exe = Resolve-WebScrapeDuckDbExe
    if ($exe -and $exe -ne 'duckdb' -and (Test-Path -LiteralPath $exe)) {
        Write-Host "DuckDB CLI already present: $exe"
        return $exe
    }
    if (Test-CommandExists 'duckdb') {
        $found = (Get-Command duckdb).Source
        Write-Host "DuckDB CLI already on PATH: $found"
        return $found
    }
    if ($SkipWinget) {
        Write-Warning 'DuckDB CLI not found. Reporting scripts need it; scrape launchers do not.'
        return $null
    }
    $null = Invoke-WingetInstall -PackageId $DuckDbWingetId
    Refresh-ProcessPath
    $exe = Resolve-WebScrapeDuckDbExe
    if ($exe -eq 'duckdb' -and -not (Test-CommandExists 'duckdb')) {
        throw "DuckDB CLI was installed but this shell still cannot run 'duckdb'. Open a new terminal and re-run with -SkipWinget."
    }
    if ($exe -eq 'duckdb') {
        $exe = (Get-Command duckdb).Source
    }
    Write-Host "DuckDB CLI ready: $exe"
    return $exe
}

function Install-NodeModules {
    $pkg = Join-Path $HomeDirectory 'node_script\package.json'
    $lock = Join-Path $HomeDirectory 'node_script\package-lock.json'
    if (-not (Test-Path -LiteralPath $pkg)) {
        throw "package.json not found: $pkg"
    }

    New-Item -ItemType Directory -Force -Path $DepsHome | Out-Null
    Copy-Item -LiteralPath $pkg -Destination (Join-Path $DepsHome 'package.json') -Force
    if (Test-Path -LiteralPath $lock) {
        Copy-Item -LiteralPath $lock -Destination (Join-Path $DepsHome 'package-lock.json') -Force
    }

    Write-Host "npm install --prefix $DepsHome"
    Push-Location $DepsHome
    try {
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        if (Test-Path -LiteralPath (Join-Path $DepsHome 'package-lock.json')) {
            & npm ci --prefix $DepsHome
        } else {
            & npm install --prefix $DepsHome
        }
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
        if ($null -eq $code) { $code = 0 }
        if ($code -ne 0) {
            throw "npm install failed (exit $code) in $DepsHome"
        }
    } finally {
        Pop-Location
    }

    $nodeApi = Join-Path $DepsHome 'node_modules\@duckdb\node-api'
    if (-not (Test-Path -LiteralPath $nodeApi)) {
        throw "npm install finished but @duckdb/node-api is missing under $DepsHome\node_modules"
    }
    Write-Host "node_modules ready: $(Join-Path $DepsHome 'node_modules')"
}

function Install-PuppeteerChrome {
    $cacheDir = Join-Path $env:USERPROFILE '.cache\puppeteer'
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    $env:PUPPETEER_CACHE_DIR = $cacheDir
    Write-Host "PUPPETEER_CACHE_DIR=$cacheDir"
    Write-Host 'puppeteer browsers install chrome'
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & npx --prefix $DepsHome --yes puppeteer browsers install chrome
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($null -eq $code) { $code = 0 }
    if ($code -ne 0) {
        Write-Warning "Puppeteer Chrome install exited $code. The first scrape may download Chromium itself."
        return
    }
    $chrome = Get-ChildItem -LiteralPath $cacheDir -Filter chrome.exe -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
    if ($chrome) {
        Write-Host "Chromium ready: $chrome"
    } else {
        Write-Warning "Chrome.exe not found under $cacheDir yet. The first scrape may download it."
    }
}

Write-Host "oyf_scrape setup on this PC"
Write-Host "home: $HomeDirectory"
Write-Host "deps: $DepsHome"

if (-not (Test-Path -LiteralPath $HomeDirectory)) {
    throw "Project home not found: $HomeDirectory"
}

Write-SetupStep 'Folders'
$dataDir = Join-Path $HomeDirectory 'data'
$logsDir = Join-Path $HomeDirectory 'logs'
New-Item -ItemType Directory -Force -Path $dataDir, $logsDir | Out-Null
Write-Host "data: $dataDir"
Write-Host "logs: $logsDir"

Write-SetupStep 'Node.js'
Install-NodeIfNeeded

Write-SetupStep 'DuckDB CLI'
$duckDbExe = Install-DuckDbIfNeeded

if (-not $SkipNpm) {
    Write-SetupStep 'Local npm dependencies (not on P:)'
    Install-NodeModules
    Write-SetupStep 'Puppeteer Chromium'
    Install-PuppeteerChrome
} else {
    Write-Host 'Skipping npm install (-SkipNpm).'
}

Write-SetupStep 'Existing project data'
$configPath = Join-Path $dataDir 'config.env'
$dbPath = Join-Path $dataDir 'web.db'
if (Test-Path -LiteralPath $configPath) {
    Write-Host "config.env: present (left unchanged)"
} else {
    Write-Warning "config.env missing at $configPath — copy it from the other PC or fill keys from the README Setup section before scraping."
}
if (Test-Path -LiteralPath $dbPath) {
    Write-Host "web.db:     present (left unchanged)"
} else {
    Write-Host "web.db:     not found yet — the first scrape will create it."
}

$dbtDir = Join-Path $HomeDirectory 'dbt'
if (Test-Path -LiteralPath $dbtDir) {
    Write-Host "dbt:        present (optional; not installed by this script)"
} else {
    Write-Host "dbt:        not in this checkout (optional)"
}

Write-Host ""
Write-Host "Setup finished."
Write-Host "Launchers: local_run\scrape_chat.ps1, scrape_wall.ps1, scrape_purchases.ps1"
if ($duckDbExe -is [array]) {
    $duckDbExe = $duckDbExe | Select-Object -Last 1
}
if ($duckDbExe) {
    Write-Host "DuckDB:    $duckDbExe"
}
