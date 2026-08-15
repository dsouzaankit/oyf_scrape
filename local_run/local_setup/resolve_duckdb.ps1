# Resolve duckdb.exe on this PC without a hardcoded username path.
# Preference: -Preferred, WEB_SCRAPE_DUCKDB, %LOCALAPPDATA%\oyf_scrape\duckdb, PATH, legacy Downloads.

function Resolve-WebScrapeDuckDbExe {
    param([string] $Preferred)

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Preferred) { [void]$candidates.Add($Preferred) }
    if ($env:WEB_SCRAPE_DUCKDB) { [void]$candidates.Add($env:WEB_SCRAPE_DUCKDB) }
    if ($env:LOCALAPPDATA) {
        [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'oyf_scrape\duckdb\duckdb.exe'))
    }
    if ($env:USERPROFILE) {
        [void]$candidates.Add((Join-Path $env:USERPROFILE 'Downloads\duckdb_cli-windows-amd64\duckdb.exe'))
    }
    [void]$candidates.Add('C:\Users\dsouzaankit\Downloads\duckdb_cli-windows-amd64\duckdb.exe')

    $seen = @{}
    foreach ($c in $candidates) {
        if (-not $c -or $seen.ContainsKey($c)) { continue }
        $seen[$c] = $true
        if (Test-Path -LiteralPath $c) {
            try {
                return (Resolve-Path -LiteralPath $c).Path
            } catch {
                return $c
            }
        }
    }

    $cmd = Get-Command duckdb -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        return $cmd.Source
    }

    return 'duckdb'
}
