# Toggle scrape_debug in data/config.env.
# When enabled (1), chat/purchases write api_out.json as append-only NDJSON
# (one batch JSON array per line). DuckDB still loads each batch from api_out.load.json.
#
# Usage:
#   .\set_config_debug.ps1 -Enable
#   .\set_config_debug.ps1 -Disable
#   .\set_config_debug.ps1 -Toggle
#   .\set_config_debug.ps1 -Status
#   .\set_config_debug.ps1                    # toggle (default)
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

$KeyName = 'scrape_debug'
$InsertAfterKey = 'purchases_scrape_force_backfill'

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
$currentValue = Get-CredsEnvScalarValue -Rows $envLines -Key $KeyName
$currentlyEnabled = Test-CredsEnvTruthy -Value $currentValue

if ($Status) {
    Write-Host "config.env: $configPath"
    $state = if ($currentlyEnabled) { 'enabled (1)' } else { 'disabled (0 or unset)' }
    Write-Host "${KeyName}: $state"
    if ($currentlyEnabled) {
        Write-Host 'Effect:    api_out.json append-only NDJSON; DuckDB loads api_out.load.json'
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
    Write-Host "$verb scrape_debug..."
}

$newValue = if ($targetEnabled) { '1' } else { '0' }
if ($currentlyEnabled -eq $targetEnabled -and $null -ne $currentValue) {
    Write-Host "scrape_debug already $newValue in $configPath"
    Wait-EnterToClose
    return
}

Write-Host "config.env: $configPath"
Write-Host "$KeyName=$newValue"
if ($targetEnabled) {
    Write-Host 'Effect:    chat/purchases append each batch to api_out.json (NDJSON); load via api_out.load.json'
} else {
    Write-Host 'Effect:    api_out.json overwritten per batch (default)'
}

if ($WhatIf) {
    Write-Host 'WhatIf: no file changes written.'
    Wait-EnterToClose
    return
}

$updated = Set-CredsEnvScalarValue -Rows $envLines -Key $KeyName -Value $newValue -InsertAfterKey $InsertAfterKey
$backupPath = "$configPath.bak"
Copy-Item -LiteralPath $configPath -Destination $backupPath -Force
Set-Content -LiteralPath $configPath -Value $updated -Encoding utf8
Write-Host "backup:    $backupPath"
Wait-EnterToClose
