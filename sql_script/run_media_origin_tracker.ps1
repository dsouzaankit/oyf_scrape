# Run media_origin_date_tracker_multi_author.sql filtered to the author in creds.env chat_thread.
#
# Usage:
#   .\run_media_origin_tracker.ps1
#   .\run_media_origin_tracker.ps1 -AuthorId 180951488
#   .\run_media_origin_tracker.ps1 -OriginDaysLast 90
#   .\run_media_origin_tracker.ps1 -HomeDirectory Z:\STUDY\web_scrape -Writable

param(
    [string] $HomeDirectory = $(if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'Z:\STUDY\web_scrape' }),
    [string] $AuthorId,
    [int] $OriginDaysLast,
    [string] $SqlPath,
    [string] $CredsPath,
    [string] $DuckDbExe = 'C:\Users\dsouzaankit\Downloads\duckdb_cli-windows-amd64\duckdb.exe',
    [switch] $Writable
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

if (-not $CredsPath) {
    $CredsPath = Join-Path $HomeDirectory 'data\creds.env'
}
if (-not $SqlPath) {
    $SqlPath = Join-Path $HomeDirectory 'sql_script\media_origin_date_tracker_multi_author.sql'
}
$DbPath = Join-Path $HomeDirectory 'data\web.db'

if (-not (Test-Path -LiteralPath $CredsPath)) {
    throw "creds.env not found: $CredsPath"
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
    $chatThread = Get-DotEnvValue -Path $CredsPath -Key 'chat_thread'
    $AuthorId = Get-AuthorIdFromChatThread -ChatThreadUrl $chatThread
}

if ($AuthorId -notmatch '^\d+$') {
    throw "author_id must be numeric digits, got: $AuthorId"
}

$sql = Get-Content -LiteralPath $SqlPath -Raw
$authorFilterPattern = '(?m)^(\s*)select\s+unnest\(\[''[^'']*''\]\)\s+as\s+author_id\s*$'
$authorFilterReplacement = "`${1}select unnest(['$AuthorId']) as author_id"

if ($sql -notmatch $authorFilterPattern) {
    throw "Could not find active author_filter line to replace in: $SqlPath"
}

$sql = [regex]::Replace($sql, $authorFilterPattern, $authorFilterReplacement, 1)

if ($PSBoundParameters.ContainsKey('OriginDaysLast')) {
    if ($OriginDaysLast -le 0) {
        throw "OriginDaysLast must be positive, got: $OriginDaysLast"
    }
    $daysFilterPattern = '(?m)^(\s*)select\s+(?:\d+|null::integer)\s+as\s+last_n_days\s*$'
    if ($sql -notmatch $daysFilterPattern) {
        throw "Could not find active origin_days_filter line to replace in: $SqlPath"
    }
    $sql = [regex]::Replace($sql, $daysFilterPattern, "`${1}select $OriginDaysLast as last_n_days", 1)
}

# Open web.db directly; drop ATTACH/USE from the script (not valid with -readonly :memory:).
$sql = $sql -replace "(?m)^ATTACH\s+'.+'\s+AS\s+web\s+\(TYPE\s+DUCKDB\);\s*\r?\n", ''
$sql = $sql -replace "(?m)^USE\s+web;\s*\r?\n", ''

try {
    $DbPath = (Resolve-Path -LiteralPath $DbPath).Path
} catch {
    # Junction / mapped drive: use as given
}

$duckArgs = @($DbPath)
if (-not $Writable) {
    $duckArgs += '-readonly'
}

Write-Host "Home:      $HomeDirectory"
Write-Host "DB:        $DbPath"
Write-Host "SQL:       $SqlPath"
Write-Host "author_id: $AuthorId (from creds.env chat_thread)"
if ($PSBoundParameters.ContainsKey('OriginDaysLast')) {
    Write-Host "last_n_days: $OriginDaysLast"
} else {
    Write-Host 'last_n_days: none (all approx_origin_date values)'
}
if (-not $Writable) {
    Write-Host 'Mode:      read-only (pass -Writable to allow writes)'
}

$sql | & $DuckDbExe @duckArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
