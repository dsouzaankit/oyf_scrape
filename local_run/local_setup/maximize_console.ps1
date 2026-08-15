# Open a real maximized console window (Windows 10 behavior).
# Windows Terminal ignores GetConsoleWindow(); a Cursor terminal cannot maximize.

function Restart-InConHostIfNeeded {
    param(
        [Parameter(Mandatory)][string] $ScriptPath,
        [string[]] $ScriptArgs = @()
    )

    if ($env:WEB_SCRAPE_IN_CONHOST -eq '1') { return $false }
    if (-not $ScriptPath -or -not (Test-Path -LiteralPath $ScriptPath)) { return $false }

    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe)) {
        $psExe = (Get-Command powershell.exe -ErrorAction Stop).Source
    }
    $wd = Split-Path -Parent $ScriptPath

    $psArgs = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath + '"'
    foreach ($a in @($ScriptArgs)) {
        if ($null -eq $a -or [string]$a -eq '') { continue }
        $s = [string]$a
        if ($s -match '[\s"]') { $psArgs += ' "' + ($s.Replace('"', '\"')) + '"' }
        else { $psArgs += ' ' + $s }
    }

    $env:WEB_SCRAPE_IN_CONHOST = '1'

    $wt = $null
    $wtCmd = Get-Command wt.exe -ErrorAction SilentlyContinue
    if ($wtCmd -and $wtCmd.Source) { $wt = $wtCmd.Source }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.UseShellExecute = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Maximized
    $psi.WorkingDirectory = $wd
    if ($wt) {
        $psi.FileName = $wt
        $psi.Arguments = '-M -d "' + $wd + '" -- "' + $psExe + '" ' + $psArgs
    } else {
        $psi.FileName = $psExe
        $psi.Arguments = $psArgs
    }
    [void][System.Diagnostics.Process]::Start($psi)
    return $true
}

function Get-BoundRestartArgs {
    param([hashtable] $Bound)
    $out = @()
    if (-not $Bound) { return $out }
    foreach ($key in $Bound.Keys) {
        $val = $Bound[$key]
        if ($val -is [System.Management.Automation.SwitchParameter]) {
            if ($val.IsPresent) { $out += "-$key" }
            continue
        }
        $out += "-$key"
        if ($val -is [array]) { $out += ($val -join ',') }
        else { $out += [string]$val }
    }
    return $out
}

function Maximize-HostConsoleWindow {
    if (-not ('HostConsoleWindow' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class HostConsoleWindow {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    public const int SW_RESTORE = 9;
    public const int SW_MAXIMIZE = 3;
}
"@
    }

    $hwnd = [HostConsoleWindow]::GetConsoleWindow()
    if ($hwnd -eq [IntPtr]::Zero) { return }

    # Windows Terminal: GetConsoleWindow() is a hidden ConPTY hwnd. Maximizing it
    # covers the real window and the title bar / close / scroll controls stop working.
    if ($env:WT_SESSION) {
        [void][HostConsoleWindow]::ShowWindow($hwnd, [HostConsoleWindow]::SW_RESTORE)
        return
    }

    [void][HostConsoleWindow]::ShowWindow($hwnd, [HostConsoleWindow]::SW_MAXIMIZE)
}
