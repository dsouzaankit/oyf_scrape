# Clear expired_ts soft-deletes for the currently active author_id in data/config.env
# (from chat_thread). Runs sql_script/clear_expired_for_author.sql via DuckDB CLI.
#
# Usage:
#   & '.\local_run\local_setup\clear_expired_for_active_author.ps1'
#   & '.\local_run\local_setup\clear_expired_for_active_author.ps1' -AuthorId 253745725
#   & '.\local_run\local_setup\clear_expired_for_active_author.ps1' -WhatIf
#
# Location: local_run\local_setup\

param(
    [string] $HomeDirectory = $(if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'P:\all_scripts\oyf_scrape' }),
    [string] $AuthorId,
    [string] $configPath,
    [string] $DbPath,
    [string] $SqlPath,
    [string] $DuckDbExe = 'C:\Users\dsouzaankit\Downloads\duckdb_cli-windows-amd64\duckdb.exe',
    [switch] $WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

function Wait-EnterToClose {
    if ($Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        Write-Host ''
        Read-Host 'Press Enter to close'
    }
}

if (-not $configPath) {
    $configPath = Join-Path $HomeDirectory 'data\config.env'
}
if (-not $DbPath) {
    $DbPath = Join-Path $HomeDirectory 'data\web.db'
}
if (-not $SqlPath) {
    $SqlPath = Join-Path $HomeDirectory 'sql_script\clear_expired_for_author.sql'
}

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "config.env not found: $configPath"
}
if (-not (Test-Path -LiteralPath $DbPath)) {
    throw "Database not found: $DbPath"
}
if (-not (Test-Path -LiteralPath $SqlPath)) {
    throw "SQL script not found: $SqlPath"
}
$duckDbResolver = Join-Path $HomeDirectory 'local_run\local_setup\resolve_duckdb.ps1'
if (Test-Path -LiteralPath $duckDbResolver) {
    . $duckDbResolver
    $DuckDbExe = Resolve-WebScrapeDuckDbExe -Preferred $DuckDbExe
} elseif (-not (Test-Path -LiteralPath $DuckDbExe)) {
    $DuckDbExe = 'duckdb'
}

if (-not $AuthorId) {
    $chatThread = Get-DotEnvValue -Path $configPath -Key 'chat_thread'
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

if ($WhatIf) {
    # Counts only — no UPDATE.
    $sql = @"
CREATE OR REPLACE TEMP TABLE author_filter AS
	select unnest(['$AuthorId']) as author_id
;
SELECT 'chat' AS table_name,
	count(*) FILTER (WHERE expired_ts IS NULL)::BIGINT AS active,
	count(*) FILTER (WHERE expired_ts IS NOT NULL)::BIGINT AS expired
FROM stg_chat_messages
WHERE cast("fromUser".id AS varchar) IN (SELECT author_id FROM author_filter);
SELECT 'wall' AS table_name,
	count(*) FILTER (WHERE expired_ts IS NULL)::BIGINT AS active,
	count(*) FILTER (WHERE expired_ts IS NOT NULL)::BIGINT AS expired
FROM stg_wall_posts
WHERE cast("author".id AS varchar) IN (SELECT author_id FROM author_filter);
"@
}

try {
    $DbPath = (Resolve-Path -LiteralPath $DbPath).Path
} catch {
    # Junction / mapped drive: use as given
}

$duckArgs = @($DbPath)
if ($WhatIf) {
    $duckArgs += '-readonly'
}

Write-Host "config.env: $configPath"
Write-Host "web.db:     $DbPath"
Write-Host "SQL:        $SqlPath"
Write-Host "DuckDB:     $DuckDbExe"
Write-Host "author_id:  $AuthorId (from $(if ($PSBoundParameters.ContainsKey('AuthorId')) { '-AuthorId' } else { 'config.env chat_thread' }))"
if ($WhatIf) {
    Write-Host 'Mode:       WhatIf (read-only counts; no expired_ts clears)'
} else {
    Write-Host 'Mode:       writable (clears expired_ts)'
}

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $sql | & $DuckDbExe @duckArgs
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
} finally {
    $ErrorActionPreference = $prevEap
}

if ($exitCode -ne 0) {
    Write-Host "clear_expired failed (exit $exitCode). Close web_scrape.js / duckdb-cli if the DB is locked, then retry."
}

Wait-EnterToClose
exit $exitCode
