# Workbar 简易安装器：复制程序、建快捷方式、并把安装目录写进用户 PATH，
# 这样 MCP 客户端可以直接用 `workbar-mcp`，不需要任何绝对路径。
# 由 install.cmd 调用；参数主要给测试用。
param(
    [string]$Dest = (Join-Path $env:LOCALAPPDATA 'Programs\Workbar'),
    [switch]$NoShortcut,
    [switch]$NoStart,
    [switch]$NoPath,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $src 'path-helpers.ps1')

# Stop a running instance first, otherwise the .exe files are locked.
Get-Process Workbar -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600

Write-Host ""
Write-Host "  Workbar 安装器" -ForegroundColor Cyan
Write-Host "  ------------------------------------------"
Write-Host "  安装到: $Dest"

if (-not (Test-Path $Dest)) {
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
}

foreach ($name in @('Workbar.exe', 'workbar-mcp.exe')) {
    $from = Join-Path $src $name
    if (-not (Test-Path $from)) {
        throw "缺少文件: $from"
    }
    Copy-Item -Path $from -Destination (Join-Path $Dest $name) -Force
    Write-Host "  ✓ $name" -ForegroundColor Green
}

if (-not $NoShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $targets = @(
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Workbar.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Workbar.lnk')
    )
    foreach ($lnkPath in $targets) {
        try {
            $lnk = $shell.CreateShortcut($lnkPath)
            $lnk.TargetPath = Join-Path $Dest 'Workbar.exe'
            $lnk.WorkingDirectory = $Dest
            $lnk.IconLocation = (Join-Path $Dest 'Workbar.exe') + ',0'
            $lnk.Description = 'Workbar - 现在该干什么'
            $lnk.Save()
            Write-Host "  ✓ 快捷方式: $lnkPath" -ForegroundColor Green
        } catch {
            Write-Host "  ! 快捷方式创建失败（不影响使用）: $lnkPath" -ForegroundColor Yellow
        }
    }
}

if (-not $NoPath) {
    $added = Add-WorkbarToUserPath -Dir $Dest -DryRun:$DryRun
    if ($added) {
        Write-Host "  · 已打开的终端 / AI 客户端需要重启一次才能读到新的 PATH" -ForegroundColor DarkGray
    }
}

Write-Host "  ------------------------------------------"
Write-Host "  完成。数据目录: $env:APPDATA\Workbar" -ForegroundColor Cyan
Write-Host "  MCP 客户端现在可以这样接：" -ForegroundColor Cyan
Write-Host "    claude mcp add --scope user workbar -- workbar-mcp" -ForegroundColor DarkGray
Write-Host ""

if (-not $NoStart -and -not $DryRun) {
    Start-Process -FilePath (Join-Path $Dest 'Workbar.exe')
}
