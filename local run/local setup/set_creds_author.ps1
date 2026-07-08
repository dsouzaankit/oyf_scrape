# Activate one author in data/creds.env by uncommenting its chat_thread + wall_profile pair
# and commenting out every other author pair.
#
# Usage:
#   .\set_creds_author.ps1 -AuthorId 180951488
#   .\set_creds_author.ps1 -List
#   .\set_creds_author.ps1                    # interactive menu
#
# Location: local run\local setup\
# One-click shortcuts (optional):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\set_creds_author.ps1 -AuthorId 180951488

param(
    [string] $HomeDirectory = $(if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'P:\all_scripts\oyf_scrape' }),
    [string] $CredsPath,
    [string] $AuthorId,
    [switch] $List,
    [switch] $WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $CredsPath) {
    $CredsPath = Join-Path $HomeDirectory 'data\creds.env'
}

function Test-CredsEnvLineCommented {
    param([Parameter(Mandatory)][string] $Line)

    $trimmed = $Line.TrimStart()
    return $trimmed.StartsWith('#') -or $trimmed.StartsWith('//')
}

function Get-CredsEnvLineBody {
    param([Parameter(Mandatory)][string] $Line)

    $trimmed = $Line.Trim()
    if ($trimmed -match '^(#|//)\s*(.+)$') {
        return @{
            Commented = $true
            Prefix    = $Matches[1]
            Body      = $Matches[2].TrimEnd()
        }
    }

    return @{
        Commented = $false
        Prefix    = $null
        Body      = $trimmed
    }
}

function Get-CredsEnvKeyValue {
    param([Parameter(Mandatory)][string] $Line)

    $parsed = Get-CredsEnvLineBody -Line $Line
    if ($parsed.Body -notmatch '^\s*([^=]+?)\s*=\s*(.*)$') {
        return $null
    }

    return @{
        Key       = $Matches[1].Trim()
        Value     = $Matches[2].Trim().Trim('"').Trim("'")
        Commented = $parsed.Commented
        Prefix    = $parsed.Prefix
        Body      = $parsed.Body
    }
}

function Get-AuthorIdFromChatThread {
    param([Parameter(Mandatory)][string] $ChatThreadUrl)

    if ($ChatThreadUrl -match '/chat/(\d+)') {
        return $Matches[1]
    }

    throw "Could not extract author_id from chat_thread URL: $ChatThreadUrl"
}

function Set-CredsEnvLineActive {
    param(
        [Parameter(Mandatory)][string] $Line,
        [Parameter(Mandatory)][bool] $Active,
        [string] $CommentStyle = '#'
    )

    $parsed = Get-CredsEnvLineBody -Line $Line
    if ($Active) {
        return $parsed.Body
    }

    if ($parsed.Commented) {
        return $Line
    }

    if ($CommentStyle -eq '//') {
        return "// $($parsed.Body)"
    }

    return "# $($parsed.Body)"
}

function Get-AuthorPairsFromCredsEnv {
    param([Parameter(Mandatory)][string[]] $Lines)

    $pairs = @()
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $chatKv = Get-CredsEnvKeyValue -Line $Lines[$i]
        if (-not $chatKv -or $chatKv.Key -ne 'chat_thread') {
            continue
        }

        $j = $i + 1
        while ($j -lt $Lines.Count -and $Lines[$j].Trim() -eq '') {
            $j++
        }
        if ($j -ge $Lines.Count) {
            throw "chat_thread on line $($i + 1) is not followed by wall_profile."
        }

        $wallKv = Get-CredsEnvKeyValue -Line $Lines[$j]
        if (-not $wallKv -or $wallKv.Key -ne 'wall_profile') {
            throw "Expected wall_profile after chat_thread on line $($i + 1); got line $($j + 1)."
        }

        $authorId = Get-AuthorIdFromChatThread -ChatThreadUrl $chatKv.Value
        $pairs += [pscustomobject]@{
            AuthorId       = $authorId
            ChatLineIndex  = $i
            WallLineIndex  = $j
            IsActive       = (-not $chatKv.Commented) -and (-not $wallKv.Commented)
            CommentStyle   = if ($chatKv.Prefix -eq '//' -or $wallKv.Prefix -eq '//') { '//' } else { '#' }
        }
        $i = $j
    }

    return $pairs
}

if (-not (Test-Path -LiteralPath $CredsPath)) {
    throw "creds.env not found: $CredsPath"
}

$lines = Get-Content -LiteralPath $CredsPath
$pairs = Get-AuthorPairsFromCredsEnv -Lines $lines

if ($pairs.Count -eq 0) {
    throw "No chat_thread / wall_profile author pairs found in $CredsPath"
}

if ($List) {
    Write-Host "creds.env: $CredsPath"
    foreach ($pair in $pairs) {
        $state = if ($pair.IsActive) { 'active' } else { 'commented' }
        Write-Host ("  {0}  ({1})" -f $pair.AuthorId, $state)
    }
    return
}

if (-not $AuthorId) {
    Write-Host "creds.env: $CredsPath"
    Write-Host 'Select author_id to activate:'
    for ($n = 0; $n -lt $pairs.Count; $n++) {
        $marker = if ($pairs[$n].IsActive) { '*' } else { ' ' }
        Write-Host ("  [{0}] {1}{2}" -f $n + 1, $marker, $pairs[$n].AuthorId)
    }

    $choice = Read-Host 'Enter number or author_id'
    if ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $pairs.Count) {
        $AuthorId = $pairs[[int]$choice - 1].AuthorId
    }
    else {
        $AuthorId = $choice.Trim()
    }
}

if ($AuthorId -notmatch '^\d+$') {
    throw "author_id must be numeric digits, got: $AuthorId"
}

$target = $pairs | Where-Object { $_.AuthorId -eq $AuthorId } | Select-Object -First 1
if (-not $target) {
    $available = ($pairs | ForEach-Object { $_.AuthorId }) -join ', '
    throw "author_id $AuthorId not found in creds.env. Available: $available"
}

if ($target.IsActive -and (@($pairs | Where-Object { $_.IsActive })).Count -eq 1) {
    Write-Host "author_id $AuthorId is already active in $CredsPath"
    return
}

$updated = $lines.Clone()
foreach ($pair in $pairs) {
    $makeActive = $pair.AuthorId -eq $AuthorId
    $updated[$pair.ChatLineIndex] = Set-CredsEnvLineActive -Line $lines[$pair.ChatLineIndex] -Active $makeActive -CommentStyle $pair.CommentStyle
    $updated[$pair.WallLineIndex] = Set-CredsEnvLineActive -Line $lines[$pair.WallLineIndex] -Active $makeActive -CommentStyle $pair.CommentStyle
}

Write-Host "creds.env: $CredsPath"
Write-Host "active author_id: $AuthorId"

if ($WhatIf) {
    Write-Host 'WhatIf: no file changes written.'
    foreach ($pair in $pairs) {
        $state = if ($pair.AuthorId -eq $AuthorId) { '-> active' } else { '-> commented' }
        Write-Host ("  {0} {1}" -f $pair.AuthorId, $state)
    }
    return
}

$backupPath = "$CredsPath.bak"
Copy-Item -LiteralPath $CredsPath -Destination $backupPath -Force
Set-Content -LiteralPath $CredsPath -Value $updated -Encoding utf8
Write-Host "backup:    $backupPath"
