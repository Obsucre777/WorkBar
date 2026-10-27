# Workbar 简易安装器：复制程序、建快捷方式、并把安装目录写进用户 PATH，
# 这样 MCP 客户端可以直接用 `workbar-mcp`，不需要任何绝对路径。
#
# 覆盖正在运行的 .exe 时 Windows 会锁文件，所以顺序是：
#   结束旧进程 → 覆盖前检查占用 → 带重试地复制 → 失败时告诉用户该关哪个 AI 客户端
param(
    [string]$Dest = (Join-Path $env:LOCALAPPDATA 'Programs\WorkBar'),
    [switch]$NoShortcut,
    [switch]$NoStart,
    [switch]$NoPath,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $src 'win-helpers.ps1')

Write-Host ""
Write-Host "  WorkBar 安装器" -ForegroundColor Cyan
Write-Host "  ------------------------------------------"
Write-Host "  安装到: $Dest"

$files = @('WorkBar.exe', 'workbar-mcp.exe')
foreach ($name in $files) {
    $from = Join-Path $src $name
    if (-not (Test-Path -LiteralPath $from)) {
        throw "缺少文件: $from"
    }
}

if (-not (Test-Path -LiteralPath $Dest)) {
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
}

# 1) 结束旧进程（Workbar 本体，以及被 AI 客户端拉起的 workbar-mcp）
Stop-WorkbarProcesses

# 2) 覆盖前确认两个目标文件都能独占打开；任何一个被占用就再清场重试一次
$locked = @()
foreach ($name in $files) {
    $target = Join-Path $Dest $name
    if (-not (Test-WorkbarFileWritable -Path $target)) { $locked += $name }
}
if ($locked.Count -gt 0) {
    Stop-WorkbarProcesses
    Start-Sleep -Milliseconds 500
    $locked = @()
    foreach ($name in $files) {
        $target = Join-Path $Dest $name
        if (-not (Test-WorkbarFileWritable -Path $target)) { $locked += $name }
    }
}
if ($locked.Count -gt 0) {
    Write-Host "  ✗ 无法更新: $($locked -join '、') 正被其他进程占用" -ForegroundColor Red
    $clients = Get-WorkbarClientProcesses
    if ($clients.Count -gt 0) {
        Write-Host "    检测到你正在运行: $($clients -join '、')" -ForegroundColor Yellow
    }
    Write-Host "    请完全退出这些 AI 客户端（包括托盘图标）后重新运行 install.cmd。" -ForegroundColor Yellow
    exit 1
}

# 3) 复制（带重试：客户端可能在杀掉后立刻把 mcp 进程重新拉起来）
foreach ($name in $files) {
    if ($DryRun) {
        Write-Host "  [dry-run] 将复制: $name" -ForegroundColor DarkGray
        continue
    }
    try {
        Copy-WorkbarFile -From (Join-Path $src $name) -To (Join-Path $Dest $name)
    } catch {
        Write-Host "  ✗ 复制失败（文件仍被占用）: $name" -ForegroundColor Red
        $clients = Get-WorkbarClientProcesses
        if ($clients.Count -gt 0) {
            Write-Host "    检测到你正在运行: $($clients -join '、')" -ForegroundColor Yellow
        }
        Write-Host "    请完全退出这些 AI 客户端后重新运行 install.cmd。" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "  ✓ $name" -ForegroundColor Green
}

# 4) 快捷方式
if (-not $NoShortcut -and -not $DryRun) {
    $shell = New-Object -ComObject WScript.Shell
    $targets = @(
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\WorkBar.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'WorkBar.lnk')
    )
    foreach ($lnkPath in $targets) {
        try {
            $lnk = $shell.CreateShortcut($lnkPath)
            $lnk.TargetPath = Join-Path $Dest 'WorkBar.exe'
            $lnk.WorkingDirectory = $Dest
            $lnk.IconLocation = (Join-Path $Dest 'WorkBar.exe') + ',0'
            $lnk.Description = 'WorkBar - 现在该干什么'
            $lnk.Save()
            Write-Host "  ✓ 快捷方式: $lnkPath" -ForegroundColor Green
        } catch {
            Write-Host "  ! 快捷方式创建失败（不影响使用）: $lnkPath" -ForegroundColor Yellow
        }
    }
}

# 5) 用户 PATH
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
    Start-Process -FilePath (Join-Path $Dest 'WorkBar.exe') -WindowStyle Hidden
}
