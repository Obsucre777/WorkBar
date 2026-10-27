$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'portable/path-helpers.ps1')

# Replace registry access: these checks never modify the user's real PATH.
$script:TestPath = ''
$script:Writes = 0
$script:Checks = 0
function Get-WorkbarUserPath { return $script:TestPath }
function Set-WorkbarUserPath {
    param([string]$Value)
    $script:TestPath = $Value
    $script:Writes++
}
function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:Checks++
    Write-Host "PASS $Message"
}

$directory = 'C:\Work Bar\MCP'
$original = ' C:\Other tools ;"C:\Quoted tools";;%LOCALAPPDATA%\Other;'
$script:TestPath = $original
Add-WorkbarToUserPath -Dir $directory | Out-Null
Assert ($script:TestPath -ceq ($original + ';' + $directory)) 'Adding keeps unrelated PATH text and variables verbatim'
$afterAdd = $script:TestPath
$writesAfterAdd = $script:Writes
Add-WorkbarToUserPath -Dir ($directory.ToUpperInvariant() + '\') | Out-Null
Assert ($script:TestPath -ceq $afterAdd) 'Repeated installation is case-insensitive and ignores trailing separators'
Assert ($script:Writes -eq $writesAfterAdd) 'Repeated installation does not rewrite PATH'
Remove-WorkbarFromUserPath -Dir $directory | Out-Null
Assert ($script:TestPath -ceq $original) 'Uninstall restores unrelated entries including spaces and empty entries'

$script:TestPath = '%LOCALAPPDATA%\Programs\Workbar'
Add-WorkbarToUserPath -Dir (Join-Path $env:LOCALAPPDATA 'Programs/Workbar') | Out-Null
Assert ($script:TestPath -ceq '%LOCALAPPDATA%\Programs\Workbar') 'Environment-variable entries are recognized without expansion on disk'
$script:TestPath = '"C:\Work Bar\MCP\";C:\Other'
Add-WorkbarToUserPath -Dir $directory | Out-Null
Assert ($script:TestPath -ceq '"C:\Work Bar\MCP\";C:\Other') 'Quoted PATH entries do not create duplicates'

$script:TestPath = ''
Add-WorkbarToUserPath -Dir $directory | Out-Null
Assert ($script:TestPath -ceq $directory) 'Installation works with an empty user PATH'
Remove-WorkbarFromUserPath -Dir $directory | Out-Null
Assert ($script:TestPath -ceq '') 'Removing the only entry leaves an empty user PATH'

$longPath = (1..800 | ForEach-Object { "C:\Unrelated tools\directory-$_" }) -join ';'
$script:TestPath = $longPath
Add-WorkbarToUserPath -Dir $directory | Out-Null
Remove-WorkbarFromUserPath -Dir $directory | Out-Null
Assert ($script:TestPath -ceq $longPath) 'Long PATH values are preserved without truncation'

$newDirectory = "C:\WorkBar $([char]0x6d4b)$([char]0x8bd5)\New"
$script:TestPath = "C:\Other;$directory;C:\Work Bar\MCP-neighbor"
Update-WorkbarUserPath -AddDirectory $newDirectory -RemoveDirectory $directory | Out-Null
Assert ($script:TestPath -ceq "C:\Other;C:\Work Bar\MCP-neighbor;$newDirectory") 'Changing install location replaces only the exact old directory'
Remove-WorkbarFromUserPath -Dir $directory | Out-Null
Assert ($script:TestPath -like "*;$newDirectory") 'An older uninstaller cannot remove a newer installation at another location'
Remove-WorkbarFromUserPath -Dir $newDirectory | Out-Null
Assert ($script:TestPath -ceq 'C:\Other;C:\Work Bar\MCP-neighbor') 'Uninstall handles Unicode paths and leaves similarly named paths intact'

$script:TestPath = "C:\Other;$directory"
$before = $script:TestPath
Update-WorkbarUserPath -AddDirectory $directory -RemoveDirectory $directory | Out-Null
Assert ($script:TestPath -ceq $before) 'Same-directory upgrades preserve the existing entry'
Update-WorkbarUserPath -AddDirectory $newDirectory -RemoveDirectory $directory -DryRun | Out-Null
Assert ($script:TestPath -ceq $before) 'Dry runs never change PATH'

foreach ($invalid in @('relative\directory', 'C:relative', '\relative', 'C:\semi;colon')) {
    $rejected = $false
    try { Add-WorkbarToUserPath -Dir $invalid | Out-Null } catch { $rejected = $true }
    Assert $rejected "Invalid installation path is rejected: $invalid"
    Assert ($script:TestPath -ceq $before) 'Rejected input leaves PATH untouched'
}

function Get-WorkbarUserPath { throw 'Simulated registry read failure' }
$writesBeforeFailure = $script:Writes
$failed = $false
try { Add-WorkbarToUserPath -Dir $directory | Out-Null } catch { $failed = $true }
Assert $failed 'Registry read failures stop the update'
Assert ($script:Writes -eq $writesBeforeFailure) 'A failed registry read never overwrites PATH'
Write-Host "$script:Checks Windows PATH checks passed."
