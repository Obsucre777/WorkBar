# Shared user PATH management. Dot-sourcing this file does not change anything.

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
        [WorkbarEnvBroadcast]::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result) | Out-Null
    } catch {
        # Existing applications may still need to be restarted.
    }
}

function Get-WorkbarUserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    try {
        if (-not $key) { return '' }
        return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally {
        if ($key) { $key.Dispose() }
    }
}

function Set-WorkbarUserPath {
    param([AllowEmptyString()][string]$Value)

    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if ($key.GetValueNames() -contains 'Path') {
            $kind = $key.GetValueKind('Path')
            if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
                throw 'The user PATH registry value has an unsupported type.'
            }
        }
        $key.SetValue('Path', $Value, $kind)
    } finally {
        if ($key) { $key.Dispose() }
    }
    Send-WorkbarEnvironmentChanged
}

function ConvertTo-WorkbarPathDirectory {
    param([string]$Directory)

    $expanded = [Environment]::ExpandEnvironmentVariables($Directory.Trim().Trim('"'))
    if (-not $expanded -or $expanded.Contains(';') -or $expanded -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') {
        throw 'The installation directory must be an absolute path without semicolons.'
    }
    $full = [IO.Path]::GetFullPath($expanded)
    if ($full.Length -gt [IO.Path]::GetPathRoot($full).Length) { $full = $full.TrimEnd('\', '/') }
    return $full
}

function Test-WorkbarPathEntry {
    param([string]$Entry, [string]$Target)

    if (-not $Entry.Trim()) { return $false }
    try {
        return (ConvertTo-WorkbarPathDirectory $Entry) -ieq (ConvertTo-WorkbarPathDirectory $Target)
    } catch {
        return $false
    }
}

function Update-WorkbarUserPath {
    param([string]$AddDirectory, [string]$RemoveDirectory, [switch]$DryRun)

    $add = if ($AddDirectory) { ConvertTo-WorkbarPathDirectory $AddDirectory } else { '' }
    $remove = if ($RemoveDirectory) { ConvertTo-WorkbarPathDirectory $RemoveDirectory } else { '' }
    $original = Get-WorkbarUserPath
    $updated = $original

    # Preserve other entries verbatim, including empty entries and %variables%.
    if ($remove -and (-not $add -or -not (Test-WorkbarPathEntry $remove $add))) {
        $kept = @()
        foreach ($entry in ($original -split ';')) {
            if (-not (Test-WorkbarPathEntry $entry $remove)) { $kept += $entry }
        }
        $updated = $kept -join ';'
    }

    if ($add) {
        $found = $false
        foreach ($entry in ($updated -split ';')) {
            if (Test-WorkbarPathEntry $entry $add) { $found = $true; break }
        }
        if (-not $found) {
            $updated = if ($updated.Length) { $updated + ';' + $add } else { $add }
        }
    }

    if ($updated -ceq $original) { return $false }
    if ($DryRun) {
        Write-Host '[dry-run] User PATH would be updated for WorkBar.'
        return $false
    }
    Set-WorkbarUserPath -Value $updated
    Write-Host 'WorkBar user PATH updated. Restart existing terminals and AI clients.'
    return $true
}

function Add-WorkbarToUserPath {
    param([string]$Dir, [switch]$DryRun)
    return Update-WorkbarUserPath -AddDirectory $Dir -DryRun:$DryRun
}

function Remove-WorkbarFromUserPath {
    param([string]$Dir, [switch]$DryRun)
    return Update-WorkbarUserPath -RemoveDirectory $Dir -DryRun:$DryRun
}
