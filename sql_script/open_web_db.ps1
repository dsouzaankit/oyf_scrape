# Open DuckDB CLI, ATTACH external data/web.db as schema "web", and drop into the interactive prompt.
#
# Usage:
#   .\open_web_db.ps1
#   .\open_web_db.ps1 -ReadOnly
#   .\open_web_db.ps1 -HomeDirectory P:\all_scripts\oyf_scrape

param(
    [string] $HomeDirectory = $(if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'P:\all_scripts\oyf_scrape' }),
    [string] $DbPath,
    [string] $DuckDbExe = 'C:\Users\dsouzaankit\Downloads\duckdb_cli-windows-amd64\duckdb.exe',
    [switch] $ReadOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $DbPath) {
    $DbPath = Join-Path $HomeDirectory 'data\web.db'
}

if (-not (Test-Path -LiteralPath $DbPath)) {
    throw "DuckDB file not found: $DbPath"
}

$duckDbResolver = Join-Path $HomeDirectory 'local_run\local_setup\resolve_duckdb.ps1'
if (Test-Path -LiteralPath $duckDbResolver) {
    . $duckDbResolver
    $DuckDbExe = Resolve-WebScrapeDuckDbExe -Preferred $DuckDbExe
} elseif (-not (Test-Path -LiteralPath $DuckDbExe)) {
    $DuckDbExe = 'duckdb'
}

try {
    $DbPath = (Resolve-Path -LiteralPath $DbPath).Path
} catch {
    # Junction / mapped drive: use as given
}

$duckDbFile = $DbPath.Replace('\', '/').Replace("'", "''")

Write-Host "DuckDB: $DuckDbExe"
Write-Host "DB:     $DbPath"

function Test-DuckDbWritableAttach {
    param([string] $Exe, [string] $AttachSql)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # -c runs SQL and exits; -cmd would drop into interactive stdin and appear hung.
        $out = & $Exe -c $AttachSql 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
        return ($exitCode -eq 0) -and ($out -notmatch '(?i)(error|cannot open|locked|already open)')
    } finally {
        $ErrorActionPreference = $prevEap
    }
}

$writableAttachSql = "ATTACH '$duckDbFile' AS web_probe (TYPE DUCKDB); DETACH web_probe;"
$useWritable = $false
if ($ReadOnly) {
    $mode = 'read-only'
} else {
    Write-Host 'Checking writable access...'
    if (Test-DuckDbWritableAttach -Exe $DuckDbExe -AttachSql $writableAttachSql) {
        $useWritable = $true
        $mode = 'read-write'
    } else {
        $mode = 'read-only'
        Write-Warning 'Could not open database for writing (file may be locked); falling back to read-only.'
    }
}

if ($useWritable) {
    $initSql = "ATTACH '$duckDbFile' AS web (TYPE DUCKDB); USE web;"
} else {
    $initSql = "ATTACH '$duckDbFile' AS web (TYPE DUCKDB, READ_ONLY); USE web;"
}

Write-Host "Mode:   $mode (attached as schema [web])"
Write-Host 'Exit the DuckDB prompt with .quit or Ctrl+D.'
Write-Host ''

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $DuckDbExe -cmd $initSql -cmd '.tables'
$exitCode = $LASTEXITCODE
if ($null -eq $exitCode) { $exitCode = 0 }
$ErrorActionPreference = $prevEap

if ($Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Write-Host ''
    Read-Host 'Press Enter to close'
}

exit $exitCode
