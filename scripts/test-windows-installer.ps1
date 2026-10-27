param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or -not $env:RUNNER_TEMP) {
    throw 'Run installer integration checks only on a disposable Windows CI runner.'
}
$uninstallRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\WorkBar'
if (Test-Path $uninstallRegistryPath) {
    throw 'Refusing to replace an existing WorkBar installation.'
}
. (Join-Path $PSScriptRoot 'portable/path-helpers.ps1')
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$expectedVersion = (Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
$originalUserPath = Get-WorkbarUserPath
$originalProcessPath = $env:Path
$environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$hadUserPath = $environmentKey -and ($environmentKey.GetValueNames() -contains 'Path')
if ($environmentKey) { $environmentKey.Dispose() }
$testRoot = Join-Path $env:RUNNER_TEMP ('workbar-installer-' + [Guid]::NewGuid().ToString('N'))
$firstDirectory = Join-Path $testRoot "WorkBar $([char]0x6d4b)$([char]0x8bd5)"
$secondDirectory = Join-Path $testRoot 'WorkBar updated'
$heldMcp = $null

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    Write-Host "PASS $Message"
}
function Install-Workbar([string]$Directory) {
    # NSIS requires /D to be the final argument, without quotes even with spaces.
    $process = Start-Process -FilePath $installerPath -ArgumentList "/S /NS /D=$Directory" -WindowStyle Hidden -Wait -PassThru
    Assert ($process.ExitCode -eq 0) "Installer succeeds: $Directory"
    Assert (Test-Path -LiteralPath (Join-Path $Directory 'workbar-mcp.exe')) 'The installer includes the MCP executable'
    $matches = @((Get-WorkbarUserPath) -split ';' | Where-Object { Test-WorkbarPathEntry $_ $Directory })
    Assert ($matches.Count -eq 1) 'The real user PATH contains exactly one installation entry'
    $entry = Get-ItemProperty -LiteralPath $uninstallRegistryPath -ErrorAction Stop
    Assert ($entry.DisplayName -ceq 'WorkBar') 'Windows displays the exact WorkBar name in Installed apps and Control Panel'
    Assert ($entry.DisplayVersion -eq $expectedVersion) 'The uninstall entry displays the installed version'
    Assert ($entry.SystemComponent -ne 1 -and $entry.NoRemove -ne 1) 'The Windows uninstall entry is visible and allows removal'
    Assert ($entry.UninstallString.Trim('"') -ieq (Join-Path $Directory 'uninstall.exe')) 'Windows points to the correct uninstaller'
}
function Uninstall-Workbar([string]$Directory, [switch]$UseRegisteredEntry) {
    $uninstaller = Join-Path $Directory 'uninstall.exe'
    if ($UseRegisteredEntry) {
        $entry = Get-ItemProperty -LiteralPath $uninstallRegistryPath -ErrorAction Stop
        $uninstaller = $entry.UninstallString.Trim('"')
        Assert ($uninstaller -ieq (Join-Path $Directory 'uninstall.exe')) 'The Windows-registered uninstall command targets this installation'
    }
    $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    Assert ($process.ExitCode -eq 0) 'Uninstaller succeeds'
    Assert (-not (Test-Path -LiteralPath (Join-Path $Directory 'workbar-mcp.exe'))) 'The MCP executable is removed'
}
function Start-HeldMcp([string]$Directory) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $Directory 'workbar-mcp.exe'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    Assert (-not $process.WaitForExit(250)) 'An MCP client is holding the installed executable open'
    return $process
}
function Test-McpCommand([string]$Directory) {
    # Model the environment of a newly opened terminal without changing this runner's parent.
    $env:Path = $originalProcessPath + ';' + (Get-WorkbarUserPath)
    $resolved = Get-Command workbar-mcp -CommandType Application -ErrorAction Stop
    Assert ($resolved.Source -ieq (Join-Path $Directory 'workbar-mcp.exe')) 'The bare workbar-mcp command resolves to the installed binary'
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = 'workbar-mcp'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['WORKBAR_DATA_DIR'] = (Join-Path $testRoot 'mcp-data')
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"installer-test","version":"1"}}}')
        $process.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
        $process.StandardInput.WriteLine('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workbar_get_today","arguments":{}}}')
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'Installed MCP server did not exit.' }
        $responses = @($output.GetAwaiter().GetResult() -split '\r?\n' | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
        Assert ($process.ExitCode -eq 0) "Installed MCP server exits successfully: $($errors.GetAwaiter().GetResult())"
        $tools = $responses | Where-Object { $_.id -eq 2 }
        $today = $responses | Where-Object { $_.id -eq 3 }
        Assert ($tools.result.tools.name -contains 'workbar_get_today') 'A client can discover tools through the PATH command'
        Assert ($today.result -and -not $today.error -and -not $today.result.isError) 'A client can read tasks through the PATH command'
    } finally {
        $process.Dispose()
        $env:Path = $originalProcessPath
    }
}

try {
    Install-Workbar $firstDirectory
    Test-McpCommand $firstDirectory
    $afterFirstInstall = Get-WorkbarUserPath
    $heldMcp = Start-HeldMcp $firstDirectory
    Install-Workbar $firstDirectory
    Assert ($heldMcp.WaitForExit(10000)) 'Reinstall closes the MCP process before replacing its executable'
    $heldMcp.Dispose()
    $heldMcp = $null
    Assert ((Get-WorkbarUserPath) -ceq $afterFirstInstall) 'Reinstalling keeps the complete user PATH unchanged'
    Install-Workbar $secondDirectory
    Assert (-not @((Get-WorkbarUserPath) -split ';' | Where-Object { Test-WorkbarPathEntry $_ $firstDirectory }).Count) 'Moving the installation removes the old PATH entry'
    Test-McpCommand $secondDirectory
    $heldMcp = Start-HeldMcp $secondDirectory
    Uninstall-Workbar $secondDirectory -UseRegisteredEntry
    Assert ($heldMcp.WaitForExit(10000)) 'Windows uninstall closes the MCP process before removing its executable'
    $heldMcp.Dispose()
    $heldMcp = $null
    Assert (-not (Test-Path -LiteralPath $uninstallRegistryPath)) 'Uninstall removes the Windows Installed apps entry'
    Assert ((Get-WorkbarUserPath) -ceq $originalUserPath) 'Uninstall restores all unrelated PATH entries exactly'
} finally {
    $env:Path = $originalProcessPath
    if ($heldMcp) {
        try { if (-not $heldMcp.HasExited) { $heldMcp.Kill(); $heldMcp.WaitForExit() } } finally { $heldMcp.Dispose() }
    }
    foreach ($directory in @($secondDirectory, $firstDirectory)) {
        if (Test-Path -LiteralPath (Join-Path $directory 'uninstall.exe')) {
            try { Uninstall-Workbar $directory } catch { Write-Warning $_.Exception.Message }
        }
    }
    if ((Get-WorkbarUserPath) -cne $originalUserPath) { Set-WorkbarUserPath $originalUserPath }
    if (-not $hadUserPath) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        if ($key) { try { $key.DeleteValue('Path', $false) } finally { $key.Dispose() } }
        Send-WorkbarEnvironmentChanged
    }
}
Write-Host 'Windows installer PATH lifecycle checks passed.'
