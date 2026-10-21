# Seeds a demo day (times relative to "now") into %APPDATA%\Workbar\plan.json
# only if no plan exists yet, then starts Workbar. Runs as the signed-in user.
param(
    [string]$DataDir = (Join-Path $env:APPDATA 'Workbar'),
    [switch]$NoStart,
    [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force $DataDir | Out-Null
$planPath = Join-Path $DataDir 'plan.json'

if ($Fresh -and (Test-Path $planPath)) {
    Remove-Item $planPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $planPath)) {
    $now = Get-Date
    function HHMM([int]$offsetMinutes) {
        return $now.AddMinutes($offsetMinutes).ToString('HH:mm')
    }
    $tasks = @(
        [ordered]@{ id = 'demo1'; title = '写周报'; start = (HHMM -35); end = (HHMM -5); est_min = 30; spent_sec = 1800; running = $false; done = $true },
        [ordered]@{ id = 'demo2'; title = '修登录 bug'; start = (HHMM -5); end = (HHMM 35); est_min = 40; spent_sec = 300; running = $true; done = $false },
        [ordered]@{ id = 'demo3'; title = 'Agent 一页纸'; start = (HHMM 35); end = (HHMM 65); est_min = 30; spent_sec = 0; running = $false; done = $false },
        [ordered]@{ id = 'demo4'; title = '第一分钟补丁'; start = (HHMM 65); end = (HHMM 185); est_min = 120; spent_sec = 0; running = $false; done = $false },
        [ordered]@{ id = 'demo5'; title = '运动 30 分钟'; start = '18:30'; end = '19:00'; est_min = 30; spent_sec = 0; running = $false; done = $false },
        [ordered]@{ id = 'demo6'; title = 'Sitta 收尾 · 周五素材'; start = '19:30'; end = '21:30'; est_min = 120; spent_sec = 0; running = $false; done = $false }
    )
    $plan = [ordered]@{
        date       = (Get-Date -Format 'yyyy-MM-dd')
        intro      = '今天只推进「第一分钟」'
        current_id = $null
        tasks      = $tasks
    }
    $json = $plan | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($planPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "已写入示例计划: $planPath"
}

if (-not $NoStart) {
    Start-Process -FilePath (Join-Path $here 'Workbar.exe')
}
