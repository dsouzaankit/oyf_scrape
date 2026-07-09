# Toggle wall/chat/purchases scrape_force_backfill in data/config.env.
# When enabled (1), wall/chat/purchases scrape skip the high-watermark early stop and scroll
# maiden-style for gap backfill (until 730-day cutoff or hasMore=false).
#
# Usage:
#   .\set_config_force_backfill.ps1 -Enable
#   .\set_config_force_backfill.ps1 -Disable
#   .\set_config_force_backfill.ps1 -Toggle
#   .\set_config_force_backfill.ps1 -Status
#   .\set_config_force_backfill.ps1                    # toggle (default)
#
# Location: local_run\local_setup\

param(
    [string] $HomeDirectory = $(if ($env:WEB_SCRAPE_HOME) { $env:WEB_SCRAPE_HOME } else { 'P:\all_scripts\oyf_scrape' }),
    [string] $configPath,
    [switch] $Enable,
    [switch] $Disable,
    [switch] $Toggle,
    [switch] $Status,
    [switch] $WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$KeyNames = @('wall_scrape_force_backfill', 'chat_scrape_force_backfill', 'purchases_scrape_force_backfill')

if (-not $configPath) {
    $configPath = Join-Path $HomeDirectory 'data\config.env'
}

function Get-CredsEnvLineBody {
    param([string] $Line)

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
    param([string] $Line)

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

function Test-CredsEnvTruthy {
    param([string] $Value)

    $v = ([string]$Value).Trim().ToLowerInvariant()
    return $v -in @('1', 'true', 'yes', 'on')
}

function Get-CredsEnvScalarValue {
    param(
        [string[]] $Rows,
        [string] $Key
    )

    foreach ($line in $Rows) {
        $kv = Get-CredsEnvKeyValue -Line $line
        if ($kv -and $kv.Key -eq $Key -and -not $kv.Commented) {
            return $kv.Value
        }
    }
    return $null
}

function Set-CredsEnvScalarValue {
    param(
        [string[]] $Rows,
        [string] $Key,
        [string] $Value,
        [string] $InsertAfterKey = 'wall_scrape_max_age_days'
    )

    $updated = New-Object System.Collections.Generic.List[string]
    $found = $false
    $inserted = $false

    for ($i = 0; $i -lt $Rows.Count; $i++) {
        $line = $Rows[$i]
        $kv = Get-CredsEnvKeyValue -Line $line
        if ($kv -and $kv.Key -eq $Key) {
            $found = $true
            $updated.Add("$Key=$Value")
            continue
        }

        $updated.Add($line)

        if (-not $found -and -not $inserted -and $InsertAfterKey -and $kv -and $kv.Key -eq $InsertAfterKey) {
            $updated.Add("$Key=$Value")
            $inserted = $true
        }
    }

    if (-not $found -and -not $inserted) {
        if ($updated.Count -gt 0 -and $updated[$updated.Count - 1].Trim() -ne '') {
            $updated.Add('')
        }
        $updated.Add("$Key=$Value")
    }

    return ,@($updated.ToArray())
}

function Wait-EnterToClose {
    if ($Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        Write-Host ''
        Read-Host 'Press Enter to close'
    }
}

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "config.env not found: $configPath"
}

$envLines = @(Get-Content -LiteralPath $configPath)
$currentStates = @{}
foreach ($key in $KeyNames) {
    $val = Get-CredsEnvScalarValue -Rows $envLines -Key $key
    $currentStates[$key] = Test-CredsEnvTruthy -Value $val
}
$enabledCount = @($currentStates.Values | Where-Object { $_ }).Count
$currentlyEnabled = $enabledCount -eq $KeyNames.Count

if ($Status) {
    Write-Host "config.env: $configPath"
    foreach ($key in $KeyNames) {
        $state = if ($currentStates[$key]) { 'enabled (1)' } else { 'disabled (0 or unset)' }
        Write-Host "${key}: $state"
    }
    Wait-EnterToClose
    return
}
if ($Enable) { $targetEnabled = $true }
elseif ($Disable) { $targetEnabled = $false }
else {
    $targetEnabled = -not $currentlyEnabled
    Write-Host "config.env: $configPath"
    $verb = if ($targetEnabled) { 'Enabling' } else { 'Disabling' }
    Write-Host "$verb force backfill for wall, chat, and purchases..."
}

$newValue = if ($targetEnabled) { '1' } else { '0' }
$allMatch = $true
foreach ($key in $KeyNames) {
    if ($currentStates[$key] -ne $targetEnabled) { $allMatch = $false; break }
}
if ($allMatch) {
    Write-Host "Force backfill already $($newValue) for wall, chat, and purchases in $configPath"
    Wait-EnterToClose
    return
}

$updated = $envLines
foreach ($key in $KeyNames) {
    $insertAfter = if ($key -eq 'chat_scrape_force_backfill') {
        'wall_scrape_force_backfill'
    } elseif ($key -eq 'purchases_scrape_force_backfill') {
        'chat_scrape_force_backfill'
    } else {
        'wall_scrape_max_age_days'
    }
    $updated = Set-CredsEnvScalarValue -Rows $updated -Key $key -Value $newValue -InsertAfterKey $insertAfter
}

Write-Host "config.env: $configPath"
foreach ($key in $KeyNames) {
    Write-Host "$key=$newValue"
}

if ($WhatIf) {
    Write-Host 'WhatIf: no file changes written.'
    Wait-EnterToClose
    return
}

$backupPath = "$configPath.bak"
Copy-Item -LiteralPath $configPath -Destination $backupPath -Force
Set-Content -LiteralPath $configPath -Value $updated -Encoding utf8
Write-Host "backup:    $backupPath"
Wait-EnterToClose
