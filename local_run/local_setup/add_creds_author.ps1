# Interactively add a chat_thread + wall_profile author pair to config.env and create
# set_creds_author_<author_id>.ps1 one-click activator.
#
# Usage:
#   .\add_creds_author.ps1
#   .\add_creds_author.ps1 -Activate

param(
    [string] $HomeDirectory = $(if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'P:\all_scripts\oyf_scrape' }),
    [string] $configPath,
    [string] $ChatThread,
    [string] $WallProfile,
    [switch] $Activate,
    [switch] $WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
if (-not $configPath) {
    $configPath = Join-Path $HomeDirectory 'data\config.env'
}

function Get-CredsEnvLineBody {
    param([string] $Line)

    $trimmed = $Line.Trim()
    if ($trimmed -match '^(#|//)\s*(.+)$') {
        return @{ Commented = $true; Prefix = $Matches[1]; Body = $Matches[2].TrimEnd() }
    }
    return @{ Commented = $false; Prefix = $null; Body = $trimmed }
}

function Get-CredsEnvKeyValue {
    param([string] $Line)

    $parsed = Get-CredsEnvLineBody -Line $Line
    if ($parsed.Body -notmatch '^\s*([^=]+?)\s*=\s*(.*)$') { return $null }
    return @{
        Key   = $Matches[1].Trim()
        Value = $Matches[2].Trim().Trim('"').Trim("'")
        Body  = $parsed.Body
    }
}

function Get-AuthorIdFromChatThread {
    param([string] $ChatThreadUrl)

    if ($ChatThreadUrl -match '/chat/(\d+)') { return $Matches[1] }
    throw "Could not extract author_id from chat_thread URL: $ChatThreadUrl"
}

function Normalize-UrlInput {
    param([string] $Url)

    $u = $Url.Trim()
    if (-not $u) { throw 'URL is required.' }
    if ($u -notmatch '^https?://') { throw "URL must start with http:// or https://: $u" }
    return $u
}

function Get-AuthorPairsFromConfigEnv {
    param([string[]] $Rows)

    $pairs = @()
    for ($i = 0; $i -lt $Rows.Count; $i++) {
        $chatKv = Get-CredsEnvKeyValue -Line $Rows[$i]
        if (-not $chatKv -or $chatKv.Key -ne 'chat_thread') { continue }

        $j = $i + 1
        while ($j -lt $Rows.Count -and $Rows[$j].Trim() -eq '') { $j++ }
        if ($j -ge $Rows.Count) { throw "chat_thread on line $($i + 1) is not followed by wall_profile." }

        $wallKv = Get-CredsEnvKeyValue -Line $Rows[$j]
        if (-not $wallKv -or $wallKv.Key -ne 'wall_profile') {
            throw "Expected wall_profile after chat_thread on line $($i + 1); got line $($j + 1)."
        }

        $pairs += [pscustomobject]@{
            AuthorId      = (Get-AuthorIdFromChatThread -ChatThreadUrl $chatKv.Value)
            ChatLineIndex = $i
            WallLineIndex = $j
        }
        $i = $j
    }
    return $pairs
}

function Write-AuthorOneClickScript {
    param(
        [string] $TargetDir,
        [string] $AuthorId
    )

    $path = Join-Path $TargetDir "set_creds_author_$AuthorId.ps1"
    @"
# One-click: activate author_id $AuthorId in data/config.env
# From repo root: & '.\local_run\local_setup\set_creds_author_$AuthorId.ps1'
`$ErrorActionPreference = 'Stop'
Set-Location `$PSScriptRoot
& "`$PSScriptRoot\set_creds_author.ps1" -AuthorId $AuthorId
`$code = `$LASTEXITCODE
if (`$null -eq `$code) { `$code = 0 }
if (`$Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Write-Host ''
    Read-Host 'Press Enter to close'
}
exit `$code
"@ | Set-Content -LiteralPath $path -Encoding utf8
    return $path
}

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "config.env not found: $configPath"
}

if (-not $ChatThread) {
    $ChatThread = Read-Host 'Chat thread URL (https://.../my/chats/chat/<author_id>/)'
}
if (-not $WallProfile) {
    $WallProfile = Read-Host 'Wall profile URL (https://.../<creator>)'
}

$ChatThread = Normalize-UrlInput -Url $ChatThread
$WallProfile = Normalize-UrlInput -Url $WallProfile
$AuthorId = Get-AuthorIdFromChatThread -ChatThreadUrl $ChatThread

if ($AuthorId -notmatch '^\d+$') {
    throw "author_id must be numeric digits, got: $AuthorId"
}

$envLines = @(Get-Content -LiteralPath $configPath)
$pairs = Get-AuthorPairsFromConfigEnv -Rows $envLines
$existing = $pairs | Where-Object { $_.AuthorId -eq $AuthorId } | Select-Object -First 1

$updated = $envLines.Clone()
$action = 'added'

if ($existing) {
    $action = 'updated'
    $updated[$existing.ChatLineIndex] = "# chat_thread=$ChatThread"
    $updated[$existing.WallLineIndex] = "# wall_profile=$WallProfile"
}
else {
    if ($updated.Count -gt 0 -and $updated[-1].Trim() -ne '') { $updated += '' }
    $updated += "# chat_thread=$ChatThread"
    $updated += "# wall_profile=$WallProfile"
}

$oneClickPath = Write-AuthorOneClickScript -TargetDir $ScriptDir -AuthorId $AuthorId

Write-Host "config.env:   $configPath"
Write-Host "author_id:   $AuthorId"
Write-Host "chat_thread: $ChatThread"
Write-Host "wall_profile: $WallProfile"
Write-Host "one-click:   $oneClickPath"
Write-Host "action:      $action author pair (stored commented)"

if ($WhatIf) {
    Write-Host 'WhatIf: no config.env changes written.'
    return
}

$backupPath = "$configPath.bak"
Copy-Item -LiteralPath $configPath -Destination $backupPath -Force
Set-Content -LiteralPath $configPath -Value $updated -Encoding utf8
Write-Host "backup:      $backupPath"

if ($Activate) {
    Write-Host 'Activating author...'
    & (Join-Path $ScriptDir 'set_creds_author.ps1') -AuthorId $AuthorId -ConfigPath $configPath
}
else {
    $ans = Read-Host 'Activate this author now? [y/N]'
    if ($ans -match '^(y|yes)$') {
        & (Join-Path $ScriptDir 'set_creds_author.ps1') -AuthorId $AuthorId -ConfigPath $configPath
    }
}
