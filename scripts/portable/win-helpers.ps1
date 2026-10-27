# Windows helpers shared by install.ps1 / uninstall.ps1:
#  - user PATH add/remove (so MCP clients can use the plain `workbar-mcp` command)
#  - process cleanup and locked-file retries (Windows locks running .exe files)
# Dot-source this file; it has no side effects on its own.

# --------------------------------------------------------------------------
# Processes
# --------------------------------------------------------------------------

function Stop-WorkbarProcesses {
    param([int]$TimeoutMs = 2500)

    $names = @('Workbar', 'workbar-mcp')
    $running = @()
    foreach ($name in $names) {
        $running += @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    }
    if ($running.Count -eq 0) { return }

    foreach ($proc in $running) {
        try { $proc.Kill() } catch { }
    }
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        $alive = 0
        foreach ($name in $names) {
            $alive += @(Get-Process -Name $name -ErrorAction SilentlyContinue).Count
        }
        if ($alive -eq 0) { break }
        Start-Sleep -Milliseconds 150
    }
    # give the OS a moment to release the image file handle
    Start-Sleep -Milliseconds 250
}

function Get-WorkbarClientProcesses {
    # AI clients that may hold workbar-mcp.exe while it is running.
    $known = [ordered]@{
        'claude'       = 'Claude Code'
        'codex'        = 'Codex'
        'Cursor'       = 'Cursor'
        'CodeBuddy CN' = 'CodeBuddy'
        'Code'         = 'VS Code'
    }
    $found = @()
    foreach ($name in $known.Keys) {
        if (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) {
            $found += $known[$name]
        }
    }
    return $found
}

function Test-WorkbarFileWritable {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $stream.Close()
        return $true
    } catch {
        return $false
    }
}

function Copy-WorkbarFile {
    param([string]$From, [string]$To, [int]$Attempts = 4)

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            Copy-Item -Path $From -Destination $To -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq $Attempts) { throw }
            # an AI client may have respawned workbar-mcp right after we killed it
            Stop-WorkbarProcesses
            Start-Sleep -Milliseconds (250 * $attempt)
        }
    }
}

# Shared with the Windows installer. Dot-sourcing only defines functions.
. (Join-Path $PSScriptRoot 'path-helpers.ps1')
