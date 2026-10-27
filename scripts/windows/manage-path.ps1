param(
    [Parameter(Mandatory = $true)][ValidateSet('Add', 'Remove')][string]$Action,
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [string]$PreviousInstallDirectory = ''
)

$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'path-helpers.ps1')
    $directory = ConvertTo-WorkbarPathDirectory $InstallDirectory
    if ($Action -eq 'Add') {
        if (-not (Test-Path -LiteralPath (Join-Path $directory 'workbar-mcp.exe') -PathType Leaf)) {
            throw 'workbar-mcp.exe is missing from the installation directory.'
        }
        Update-WorkbarUserPath -AddDirectory $directory -RemoveDirectory $PreviousInstallDirectory | Out-Null
    } else {
        # The uninstaller calls this after removing the program files.
        Remove-WorkbarFromUserPath -Dir $directory | Out-Null
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
