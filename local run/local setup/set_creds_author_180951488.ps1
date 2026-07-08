# One-click: activate author_id 180951488 in data/creds.env
# From repo root: & '.\local run\local setup\set_creds_author_180951488.ps1'
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
& "$PSScriptRoot\set_creds_author.ps1" -AuthorId 180951488
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
if ($Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Write-Host ''
    Read-Host 'Press Enter to close'
}
exit $code
