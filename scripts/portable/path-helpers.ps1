# Shared helper: keep the Workbar install directory on the *user* PATH so MCP
# clients can start the server with just `workbar-mcp` (no absolute paths).
# Dot-source this file; it has no side effects on its own.

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
