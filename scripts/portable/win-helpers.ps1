# Windows helpers shared by install.ps1 / uninstall.ps1:
#  - user PATH add/remove (so MCP clients can use the plain `workbar-mcp` command)
#  - process cleanup and locked-file retries (Windows locks running .exe files)
# Dot-source this file; it has no side effects on its own.

# --------------------------------------------------------------------------
# Processes
# --------------------------------------------------------------------------

function Stop-WorkbarProcesses {
    param([int]$TimeoutMs = 2500)

    $names = @('Workbar', 'workbar-mcp')
    $running = @()
    foreach ($name in $names) {
        $running += @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    }
    if ($running.Count -eq 0) { return }

    foreach ($proc in $running) {
        try { $proc.Kill() } catch { }
    }
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        $alive = 0
        foreach ($name in $names) {
            $alive += @(Get-Process -Name $name -ErrorAction SilentlyContinue).Count
        }
        if ($alive -eq 0) { break }
        Start-Sleep -Milliseconds 150
    }
    # give the OS a moment to release the image file handle
    Start-Sleep -Milliseconds 250
}

function Get-WorkbarClientProcesses {
    # AI clients that may hold workbar-mcp.exe while it is running.
    $known = [ordered]@{
        'claude'       = 'Claude Code'
        'codex'        = 'Codex'
        'Cursor'       = 'Cursor'
        'CodeBuddy CN' = 'CodeBuddy'
        'Code'         = 'VS Code'
    }
    $found = @()
    foreach ($name in $known.Keys) {
        if (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) {
            $found += $known[$name]
        }
    }
    return $found
}

function Test-WorkbarFileWritable {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $stream.Close()
        return $true
    } catch {
        return $false
    }
}

function Copy-WorkbarFile {
    param([string]$From, [string]$To, [int]$Attempts = 4)

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            Copy-Item -Path $From -Destination $To -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq $Attempts) { throw }
            # an AI client may have respawned workbar-mcp right after we killed it
            Stop-WorkbarProcesses
            Start-Sleep -Milliseconds (250 * $attempt)
        }
    }
}

# --------------------------------------------------------------------------
# User PATH
# --------------------------------------------------------------------------

function Send-WorkbarEnvironmentChanged {
    try {
        if (-not ('WorkbarEnvBroadcast' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WorkbarEnvBroadcast {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
        }
        $result = [UIntPtr]::Zero
        # HWND_BROADCAST, WM_SETTINGCHANGE, "Environment"
        [WorkbarEnvBroadcast]::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result) | Out-Null
    } catch {
        # Best effort: Explorer/terminals will pick it up on their next start anyway.
    }
}

function Get-WorkbarUserPath {
    $value = $null
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
        if ($key) {
            $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $key.Close()
        }
    } catch {
        $value = $null
    }
    if ($null -eq $value) {
        $value = [Environment]::GetEnvironmentVariable('Path', 'User')
    }
    if ($null -eq $value) { return '' }
    return [string]$value
}

function Set-WorkbarUserPath {
    param([string]$Value)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if (-not $key) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    }
    $key.SetValue('Path', $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    $key.Close()
    Send-WorkbarEnvironmentChanged
}

function Split-WorkbarPath {
    param([string]$Value)
    if (-not $Value) { return @() }
    return @($Value -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Test-WorkbarPathEntry {
    param([string]$Entry, [string]$Target)
    try {
        $expanded = [Environment]::ExpandEnvironmentVariables($Entry)
    } catch {
        $expanded = $Entry
    }
    return ($expanded.TrimEnd('\') -ieq $Target.TrimEnd('\'))
}

function Add-WorkbarToUserPath {
    param([string]$Dir, [switch]$DryRun)

    $target = $Dir.TrimEnd('\')
    $parts = Split-WorkbarPath (Get-WorkbarUserPath)
    foreach ($entry in $parts) {
        if (Test-WorkbarPathEntry -Entry $entry -Target $target) {
            Write-Host "  · 用户 PATH 已包含: $target" -ForegroundColor DarkGray
            return $false
        }
    }
    $newValue = (@($parts) + $target) -join ';'
    if ($DryRun) {
        Write-Host "  [dry-run] 将追加到用户 PATH: $target" -ForegroundColor DarkGray
        return $false
    }
    Set-WorkbarUserPath -Value $newValue
    Write-Host "  ✓ 已把安装目录加入用户 PATH: $target" -ForegroundColor Green
    return $true
}

function Remove-WorkbarFromUserPath {
    param([string]$Dir, [switch]$DryRun)

    $target = $Dir.TrimEnd('\')
    $parts = Split-WorkbarPath (Get-WorkbarUserPath)
    $kept = @()
    $removed = $false
    foreach ($entry in $parts) {
        if (Test-WorkbarPathEntry -Entry $entry -Target $target) {
            $removed = $true
            continue
        }
        $kept += $entry
    }
    if (-not $removed) {
        Write-Host "  · 用户 PATH 中没有: $target" -ForegroundColor DarkGray
        return $false
    }
    if ($DryRun) {
        Write-Host "  [dry-run] 将从用户 PATH 移除: $target" -ForegroundColor DarkGray
        return $false
    }
    Set-WorkbarUserPath -Value ($kept -join ';')
    Write-Host "  - 已从用户 PATH 移除: $target" -ForegroundColor Yellow
    return $true
}
