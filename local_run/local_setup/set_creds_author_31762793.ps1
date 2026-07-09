# One-click: activate author_id 31762793 in data/creds.env
# From repo root: & '.\local_run\local_setup\set_creds_author_31762793.ps1'
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
& "$PSScriptRoot\set_creds_author.ps1" -AuthorId 31762793
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
if ($Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Write-Host ''
    Read-Host 'Press Enter to close'
}
exit $code
