# One-click: activate author_id 24569249 in data/config.env
# From repo root: & '.\local_run\local_setup\set_config_author_24569249.ps1'
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
& "$PSScriptRoot\set_config_author.ps1" -AuthorId 24569249
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
if ($Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Write-Host ''
    Read-Host 'Press Enter to close'
}
exit $code
