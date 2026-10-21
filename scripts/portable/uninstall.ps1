# Workbar 卸载器（绿色版 / 简易安装版都适用）
param(
    [string]$Dest = (Join-Path $env:LOCALAPPDATA 'Programs\Workbar'),
    [switch]$PurgeData
)

$ErrorActionPreference = 'Continue'
Write-Host ""
Write-Host "  Workbar 卸载" -ForegroundColor Cyan
Write-Host "  ------------------------------------------"

Get-Process Workbar -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

foreach ($lnk in @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Workbar.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Workbar.lnk')
)) {
    if (Test-Path $lnk) {
        Remove-Item $lnk -Force -ErrorAction SilentlyContinue
        Write-Host "  - 已删除快捷方式: $lnk" -ForegroundColor Yellow
    }
}

if (Test-Path $Dest) {
    Remove-Item $Dest -Recurse -Force -ErrorAction SilentlyContinue
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
