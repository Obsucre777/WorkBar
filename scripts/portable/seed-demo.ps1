# Create example tasks through MCP; SQLite is written only by workbar-core.
param(
    [string]$DataDir = (Join-Path $env:APPDATA 'Workbar'),
    [switch]$NoStart,
    [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$mcpPath = Join-Path $here 'workbar-mcp.exe'
if (-not (Test-Path -LiteralPath $mcpPath)) { throw "找不到 MCP 程序：$mcpPath" }
$previousDataDir = $env:WORKBAR_DATA_DIR
$previousOutputEncoding = $OutputEncoding
$previousConsoleEncoding = [Console]::OutputEncoding
try {
    $env:WORKBAR_DATA_DIR = $DataDir
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = $OutputEncoding
    function Invoke-WorkbarTool([string]$Name, [hashtable]$Arguments) {
        $initialize = @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{
            protocolVersion = '2024-11-05'; clientInfo = @{ name = 'portable-demo'; version = '1' }
        } } | ConvertTo-Json -Depth 8 -Compress
        $call = @{ jsonrpc = '2.0'; id = 2; method = 'tools/call'; params = @{
            name = $Name; arguments = $Arguments
        } } | ConvertTo-Json -Depth 8 -Compress
        $responses = @($initialize, $call) | & $mcpPath
        if ($LASTEXITCODE -ne 0) { throw 'MCP 程序运行失败' }
        $response = $responses | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.id -eq 2 } | Select-Object -First 1
        if (-not $response -or $response.error -or $response.result.isError) { throw "任务写入失败：$($response | ConvertTo-Json -Depth 8 -Compress)" }
        return $response.result.content[0].text | ConvertFrom-Json
    }

    $existing = Invoke-WorkbarTool 'workbar_get_today' @{}
    if ($Fresh -or @($existing.tasks).Count -eq 0) {
        $tasks = @(
            @{ title = '写周报'; est_min = 30; running = $true },
            @{ title = '修登录 bug'; est_min = 40 },
            @{ title = 'Agent 一页纸'; est_min = 30 },
            @{ title = '第一分钟补丁'; timer = 'up' },
            @{ title = '运动 30 分钟'; est_min = 30 }
        )
        $null = Invoke-WorkbarTool 'workbar_plan_day' @{ tasks = $tasks }
        Write-Host "已创建示例任务：$(Join-Path $DataDir 'workbar.db')"
    }
    if (-not $NoStart) {
        Start-Process -FilePath (Join-Path $here 'Workbar.exe') -WindowStyle Hidden
    }
} finally {
    $env:WORKBAR_DATA_DIR = $previousDataDir
    $OutputEncoding = $previousOutputEncoding
    [Console]::OutputEncoding = $previousConsoleEncoding
}
