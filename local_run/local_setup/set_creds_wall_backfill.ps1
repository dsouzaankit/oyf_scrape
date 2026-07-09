# Toggle wall_scrape_force_backfill in data/config.env.
# When enabled (1), wall scrape skips the high-watermark early stop and scrolls
# maiden-style until the 730-day cutoff or hasMore=false (gap backfill).
#
# Usage:
#   .\set_creds_wall_backfill.ps1 -Enable
#   .\set_creds_wall_backfill.ps1 -Disable
#   .\set_creds_wall_backfill.ps1 -Toggle
#   .\set_creds_wall_backfill.ps1 -Status
#   .\set_creds_wall_backfill.ps1                    # interactive
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

$KeyName = 'wall_scrape_force_backfill'

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

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "config.env not found: $configPath"
}

$envLines = @(Get-Content -LiteralPath $configPath)
$currentValue = Get-CredsEnvScalarValue -Rows $envLines -Key $KeyName
$currentlyEnabled = Test-CredsEnvTruthy -Value $currentValue

if ($Status) {
    Write-Host "config.env: $configPath"
    $state = if ($currentlyEnabled) { 'enabled (1)' } else { 'disabled (0 or unset)' }
    Write-Host "$KeyName`: $state"
    return
}

$targetEnabled = $null
if ($Enable) { $targetEnabled = $true }
elseif ($Disable) { $targetEnabled = $false }
elseif ($Toggle) { $targetEnabled = -not $currentlyEnabled }
else {
    Write-Host "config.env: $configPath"
    $state = if ($currentlyEnabled) { 'enabled' } else { 'disabled' }
    Write-Host "Current $KeyName`: $state"
    Write-Host 'Enable maiden-style wall gap backfill (disable high-watermark stop)? [y/N]'
    $answer = (Read-Host 'Enter y/yes to enable, n/no to disable, or blank to cancel').Trim().ToLowerInvariant()
    if ($answer -eq '') {
        Write-Host 'No changes.'
        return
    }
    if ($answer -in @('y', 'yes', '1', 'true', 'on')) {
        $targetEnabled = $true
    }
    elseif ($answer -in @('n', 'no', '0', 'false', 'off')) {
        $targetEnabled = $false
    }
    else {
        throw "Unrecognized answer: $answer"
    }
}

$newValue = if ($targetEnabled) { '1' } else { '0' }
if ($currentlyEnabled -eq $targetEnabled) {
    Write-Host "$KeyName already set to $newValue in $configPath"
    return
}

$updated = Set-CredsEnvScalarValue -Rows $envLines -Key $KeyName -Value $newValue

Write-Host "config.env: $configPath"
Write-Host "$KeyName=$newValue"

if ($WhatIf) {
    Write-Host 'WhatIf: no file changes written.'
    return
}

$backupPath = "$configPath.bak"
Copy-Item -LiteralPath $configPath -Destination $backupPath -Force
Set-Content -LiteralPath $configPath -Value $updated -Encoding utf8
Write-Host "backup:    $backupPath"
