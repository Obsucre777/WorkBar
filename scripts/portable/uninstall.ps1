# Workbar 卸载器（绿色版 / 简易安装版都适用）：删除程序、快捷方式，
# 并把安装目录从用户 PATH 里移除（-KeepPath 可保留）。
param(
    [string]$Dest = (Join-Path $env:LOCALAPPDATA 'Programs\WorkBar'),
    [switch]$PurgeData,
    [switch]$KeepPath,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $src 'win-helpers.ps1')

Write-Host ""
Write-Host "  WorkBar 卸载" -ForegroundColor Cyan
Write-Host "  ------------------------------------------"

# 结束 Workbar 本体和 AI 客户端拉起的 workbar-mcp，否则目录删不干净。
Stop-WorkbarProcesses

foreach ($lnk in @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\WorkBar.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'WorkBar.lnk')
)) {
    if (Test-Path $lnk) {
        Remove-Item $lnk -Force -ErrorAction SilentlyContinue
        Write-Host "  - 已删除快捷方式: $lnk" -ForegroundColor Yellow
    }
}

if (-not $KeepPath) {
    Remove-WorkbarFromUserPath -Dir $Dest -DryRun:$DryRun | Out-Null
}

if (Test-Path $Dest) {
    if (-not $DryRun) {
        Remove-Item $Dest -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  - 已删除程序目录: $Dest" -ForegroundColor Yellow
}

if ($PurgeData) {
    $data = Join-Path $env:APPDATA 'Workbar'
    if (Test-Path $data) {
        Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  - 已删除数据目录: $data" -ForegroundColor Yellow
    }
} else {
    Write-Host "  · 计划数据保留在: $env:APPDATA\Workbar（加 -PurgeData 可一并删除）" -ForegroundColor DarkGray
}

# 关闭开机自启（如果有）
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$prop = Get-ItemProperty $runKey -ErrorAction SilentlyContinue
if ($prop -and $prop.PSObject.Properties.Name -contains 'Workbar') {
    Remove-ItemProperty $runKey -Name 'Workbar' -ErrorAction SilentlyContinue
    Write-Host "  - 已关闭开机自启" -ForegroundColor Yellow
}

Write-Host "  ------------------------------------------"
Write-Host "  卸载完成" -ForegroundColor Cyan
Write-Host ""
