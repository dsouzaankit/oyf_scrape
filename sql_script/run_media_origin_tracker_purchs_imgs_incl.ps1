# Run media_origin_date_tracker_multi_author_purchs_imgs_incl.sql for a calendar year range.
# Prompts for start/end year and whether to include images.
# Unlocked (purchased) media — distinct from video-only purchases day-window report.
#
# Usage:
#   .\run_media_origin_tracker_purchs_imgs_incl.ps1
#   .\run_media_origin_tracker_purchs_imgs_incl.ps1 -StartYear 2025 -EndYear 2023
#   .\run_media_origin_tracker_purchs_imgs_incl.ps1 -StartYear 2024 -EndYear 2024 -IncludeImages:$false

param(
    [string] $HomeDirectory = $(if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'P:\all_scripts\oyf_scrape' }),
    [string] $AuthorId,
    [int] $StartYear,
    [int] $EndYear,
    [Nullable[bool]] $IncludeImages,
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
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Key
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

function Read-Year {
    param(
        [Parameter(Mandatory)][string] $Prompt,
        [Parameter(Mandatory)][int] $MinYear
    )
    while ($true) {
        $raw = Read-Host $Prompt
        if ($raw -match '^\d{4}$') {
            $y = [int]$raw
            if ($y -ge $MinYear -and $y -le ([DateTime]::UtcNow.Year + 1)) {
                return $y
            }
        }
        Write-Host "Enter a 4-digit year >= $MinYear (e.g. 2024)."
    }
}

function Read-YesNo {
    param(
        [Parameter(Mandatory)][string] $Prompt,
        [bool] $Default = $true
    )
    $hint = if ($Default) { 'Y/n' } else { 'y/N' }
    while ($true) {
        $raw = Read-Host "$Prompt [$hint]"
        if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
        if ($raw -match '^(y|yes)$') { return $true }
        if ($raw -match '^(n|no)$') { return $false }
        Write-Host 'Enter y or n.'
    }
}

function Get-MediaOriginSql {
    param(
        [Parameter(Mandatory)][string] $SqlTemplate,
        [Parameter(Mandatory)][string] $AuthorId,
        [Parameter(Mandatory)][int] $StartYear,
        [Parameter(Mandatory)][int] $EndYear,
        [Parameter(Mandatory)][bool] $IncludeImages
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

    $yearFilterPattern = '(?m)^(\s*)select\s+\d+::integer\s+as\s+start_year,\s*\d+::integer\s+as\s+end_year\s*$'
    if ($sql -notmatch $yearFilterPattern) {
        throw 'Could not find active origin_year_filter line to replace in SQL template'
    }

    $sql = [regex]::Replace(
        $sql,
        $yearFilterPattern,
        "`${1}select ${StartYear}::integer as start_year, ${EndYear}::integer as end_year",
        1
    )

    $imagesFilterPattern = '(?m)^(\s*)select\s+(true|false)\s+as\s+include_images\s*$'
    if ($sql -notmatch $imagesFilterPattern) {
        throw 'Could not find active include_images_filter line to replace in SQL template'
    }

    $includeLit = if ($IncludeImages) { 'true' } else { 'false' }
    $sql = [regex]::Replace(
        $sql,
        $imagesFilterPattern,
        "`${1}select $includeLit as include_images",
        1
    )

    $sql = $sql -replace "(?m)^ATTACH\s+'.+'\s+AS\s+web\s+\(TYPE\s+DUCKDB\);\s*\r?\n", ''
    return ($sql -replace "(?m)^USE\s+web;\s*\r?\n", '')
}

if (-not $configPath) {
    $configPath = Join-Path $HomeDirectory 'data\config.env'
}
if (-not $SqlPath) {
    $SqlPath = Join-Path $HomeDirectory 'sql_script\media_origin_date_tracker_multi_author_purchs_imgs_incl.sql'
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

Write-Host "Purchases origin report (videos; optional images)"
Write-Host "  start year = newer (inclusive on approx_origin_date)"
Write-Host "  end year   = older (inclusive on approx_origin_date)"
Write-Host ""

if ($StartYear -le 0) {
    $StartYear = Read-Year -Prompt 'Start year (newer)' -MinYear 2000
}
if ($EndYear -le 0) {
    $EndYear = Read-Year -Prompt 'End year (older)' -MinYear 2000
}
if ($StartYear -lt $EndYear) {
    throw "Start year ($StartYear) must be >= end year ($EndYear) (start = newer, end = older)."
}

if ($null -eq $IncludeImages) {
    $IncludeImages = Read-YesNo -Prompt 'Include images' -Default $true
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

$mediaScope = if ($IncludeImages) { 'videos + images' } else { 'videos only' }
Write-Host ""
Write-Host "Home:      $HomeDirectory"
Write-Host "DB:        $DbPath"
Write-Host "SQL:       $SqlPath"
Write-Host "config.env: $configPath"
Write-Host "author_id: $AuthorId"
Write-Host "source:    stg_all_unlocks ($mediaScope)"
Write-Host "years:     approx_origin_date in $EndYear .. $StartYear (inclusive)"
Write-Host "images:    $(if ($IncludeImages) { 'included' } else { 'excluded' })"
if (-not $Writable) {
    Write-Host 'Mode:      read-only (pass -Writable to allow writes)'
}

$sql = Get-MediaOriginSql -SqlTemplate $sqlTemplate -AuthorId $AuthorId `
    -StartYear $StartYear -EndYear $EndYear -IncludeImages ([bool]$IncludeImages)
$exitCode = 0
try {
    Write-Host ''
    Write-Host ('=' * 72)
    Write-Host "approx_origin_date years: $EndYear .. $StartYear; images=$(if ($IncludeImages) { 'yes' } else { 'no' })"
    Write-Host ('=' * 72)
    $sql | & $DuckDbExe @duckArgs
    if ($null -ne $LASTEXITCODE) { $exitCode = $LASTEXITCODE }
} finally {
    Write-Host ''
    Read-Host 'Press Enter to exit'
}
exit $exitCode
