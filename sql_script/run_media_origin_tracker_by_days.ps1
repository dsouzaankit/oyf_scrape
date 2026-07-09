# Run media_origin_date_tracker_multi_author.sql for standard origin-day windows.
#
# Usage:
#   .\run_media_origin_tracker_by_days.ps1
#   .\run_media_origin_tracker_by_days.ps1 -Days 30,90
#   .\run_media_origin_tracker_by_days.ps1 -AuthorId 180951488

param(
    [string] $HomeDirectory = $(if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'P:\all_scripts\oyf_scrape' }),
    [string] $AuthorId,
    [int[]] $Days = @(30, 60, 90, 180, 365),
    [string] $SqlPath,
    [string] $configPath,
    [string] $DuckDbExe = 'C:\Users\dsouzaankit\Downloads\duckdb_cli-windows-amd64\duckdb.exe',
    [switch] $Writable
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Maximize console window (full screen)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ConsoleWindow {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    public const int SW_MAXIMIZE = 3;
}
"@
$hwnd = [ConsoleWindow]::GetConsoleWindow()
if ($hwnd -ne [IntPtr]::Zero) {
    [void][ConsoleWindow]::ShowWindow($hwnd, [ConsoleWindow]::SW_MAXIMIZE)
}

function Get-DotEnvValue {
    param(
        [Parameter(Mandatory)]
        [string] $Path,
        [Parameter(Mandatory)]
        [string] $Key
    )

    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.+?)\s*$") {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }

    throw "Key '$Key' not found in $Path"
}

function Get-AuthorIdFromChatThread {
    param([Parameter(Mandatory)][string] $ChatThreadUrl)

    if ($ChatThreadUrl -match '/chat/(\d+)') {
        return $Matches[1]
    }

    throw "Could not extract author_id from chat_thread URL: $ChatThreadUrl"
}

function Get-MediaOriginSql {
    param(
        [Parameter(Mandatory)][string] $SqlTemplate,
        [Parameter(Mandatory)][string] $AuthorId,
        [Parameter(Mandatory)][int] $OriginDays
    )

    $authorFilterPattern = '(?m)^(\s*)select\s+unnest\(\[''[^'']*''\]\)\s+as\s+author_id\s*$'
    if ($SqlTemplate -notmatch $authorFilterPattern) {
        throw 'Could not find active author_filter line to replace in SQL template'
    }

    $sql = [regex]::Replace(
        $SqlTemplate,
        $authorFilterPattern,
        "`${1}select unnest(['$AuthorId']) as author_id",
        1
    )

    $daysFilterPattern = '(?m)^(\s*)select\s+(?:\d+|null::integer)\s+as\s+last_n_days\s*$'
    if ($sql -notmatch $daysFilterPattern) {
        throw 'Could not find active origin_days_filter line to replace in SQL template'
    }

    $sql = [regex]::Replace(
        $sql,
        $daysFilterPattern,
        "`${1}select $OriginDays as last_n_days",
        1
    )

    $sql = $sql -replace "(?m)^ATTACH\s+'.+'\s+AS\s+web\s+\(TYPE\s+DUCKDB\);\s*\r?\n", ''
    return ($sql -replace "(?m)^USE\s+web;\s*\r?\n", '')
}

if (-not $configPath) {
    $configPath = Join-Path $HomeDirectory 'data\config.env'
}
if (-not $SqlPath) {
    $SqlPath = Join-Path $HomeDirectory 'sql_script\media_origin_date_tracker_multi_author.sql'
}
$DbPath = Join-Path $HomeDirectory 'data\web.db'

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "config.env not found: $configPath"
}
if (-not (Test-Path -LiteralPath $SqlPath)) {
    throw "SQL script not found: $SqlPath"
}
if (-not (Test-Path -LiteralPath $DbPath)) {
    throw "DuckDB file not found: $DbPath"
}
if (-not (Test-Path -LiteralPath $DuckDbExe)) {
    $DuckDbExe = 'duckdb'
}

if (-not $AuthorId) {
    $chatThread = Get-DotEnvValue -Path $configPath -Key 'chat_thread'
    $AuthorId = Get-AuthorIdFromChatThread -ChatThreadUrl $chatThread
}

if ($AuthorId -notmatch '^\d+$') {
    throw "author_id must be numeric digits, got: $AuthorId"
}

foreach ($dayWindow in $Days) {
    if ($dayWindow -le 0) {
        throw "Each day window must be positive, got: $dayWindow"
    }
}

try {
    $DbPath = (Resolve-Path -LiteralPath $DbPath).Path
} catch {
    # Junction / mapped drive: use as given
}

$sqlTemplate = Get-Content -LiteralPath $SqlPath -Raw
$duckArgs = @($DbPath)
if (-not $Writable) {
    $duckArgs += '-readonly'
}

Write-Host "Home:      $HomeDirectory"
Write-Host "DB:        $DbPath"
Write-Host "SQL:       $SqlPath"
Write-Host "config.env: $configPath"
Write-Host "author_id: $AuthorId (from config.env chat_thread)"
Write-Host "last_n_days windows: $($Days -join ', ')"
if (-not $Writable) {
    Write-Host 'Mode:      read-only (pass -Writable to allow writes)'
}

$exitCode = 0
try {
    foreach ($dayWindow in $Days) {
        Write-Host ''
        Write-Host ('=' * 72)
        Write-Host "last_n_days: $dayWindow"
        Write-Host "approx_origin_date within last $dayWindow days"
        Write-Host ('=' * 72)

        $sql = Get-MediaOriginSql -SqlTemplate $sqlTemplate -AuthorId $AuthorId -OriginDays $dayWindow
        $sql | & $DuckDbExe @duckArgs
        if ($LASTEXITCODE -ne 0) {
            $exitCode = $LASTEXITCODE
            break
        }
    }
} finally {
    Write-Host ''
    Read-Host 'Press Enter to exit'
}
exit $exitCode
