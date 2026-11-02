#Requires -RunAsAdministrator
#Requires -Version 7
<#
.SYNOPSIS
  Undo deploy.ps1: uninstall Vivarc from Vivaldi, remove the RevivalArc-Reapply task, and delete
  <Program Files>\RevivalArc and <ProgramData>\RevivalArc (the log).

.DESCRIPTION
  The task is disabled first, so it cannot put Vivarc back while it is being removed. Vivarc's uninstall restores
  window.html and the profile settings it saved at install, so Vivaldi must be closed. -KeepMod leaves Vivarc in
  Vivaldi and only removes the auto re-apply (then Vivaldi may stay open).
  Deletes only those two folders, and refuses if either contains a junction or symlink (an elevated recursive
  delete must not follow a link out of them). PowerShell 7 is required for the same reason.
#>
param(
    [string]$UserData = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Vivaldi\User Data'),
    [string]$VivaldiApp = (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Vivaldi\Application'),
    [switch]$KeepMod
)
$ErrorActionPreference = 'Stop'
$TaskName = 'RevivalArc-Reapply'
# Known folders come from the OS, not from environment variables a user can set.
$Target = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'RevivalArc'
$LogDir = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'RevivalArc'

foreach ($p in $Target, $LogDir) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $links = @(Get-Item -LiteralPath $p -Force) + @(Get-ChildItem -LiteralPath $p -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop) |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
    if ($links) { throw "Refusing: $($links.FullName -join ', ') is a junction or symlink. Nothing was changed." }
}
if (-not $KeepMod -and (Get-Process vivaldi -ErrorAction SilentlyContinue)) {
    throw 'Close Vivaldi first (Ctrl+Shift+Q), or use -KeepMod. Nothing was changed.'
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "==> Disabling task $TaskName" -ForegroundColor Cyan
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

if (-not $KeepMod) {
    $py = Join-Path $Target 'python\python.exe'
    if (-not (Test-Path $py)) {
        if ($task) { Enable-ScheduledTask -TaskName $TaskName | Out-Null }
        throw "No deployed Python at $py; uninstall Vivarc with the repo's vivarc.py instead. Task left as it was."
    }
    Write-Host '==> Uninstalling Vivarc from Vivaldi' -ForegroundColor Cyan
    & $py -I (Join-Path $Target 'app\vivarc.py') --app $VivaldiApp.TrimEnd('\') --data-dir $UserData.TrimEnd('\') uninstall
    if ($LASTEXITCODE) {
        if ($task) { Enable-ScheduledTask -TaskName $TaskName | Out-Null }
        throw "vivarc uninstall failed (exit $LASTEXITCODE); task re-enabled and files left in place"
    }
}

if ($task) {
    Write-Host "==> Removing task $TaskName" -ForegroundColor Cyan
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
foreach ($p in $Target, $LogDir) {
    if (Test-Path -LiteralPath $p) { Write-Host "==> Deleting $p" -ForegroundColor Cyan; Remove-Item -LiteralPath $p -Recurse -Force }
}
Write-Host 'Revival Arc auto re-apply removed.' -ForegroundColor Green
