#Requires -RunAsAdministrator
#Requires -Version 7
<#
.SYNOPSIS
  Install or update Revival Arc's auto re-apply: embedded Python + a release copy of Vivarc in Program Files, and the
  RevivalArc-Reapply scheduled task that puts Vivarc back after every Vivaldi update.

.DESCRIPTION
  Run elevated, as the user whose Vivaldi it serves (UAC on your own account). Run again after changing the code: it
  also force-refreshes Vivarc in Vivaldi so the new code is live (restart Vivaldi to load it).
  Nothing the elevated task runs or writes lives anywhere a standard user can write or redirect:
    <Program Files>\RevivalArc\python\   embeddable Python, SHA-256 pinned and Authenticode-checked
    <Program Files>\RevivalArc\app\      vivarc.py, windows_support.py, src\ (copied from this repo)
    <Program Files>\RevivalArc\reapply.py
    <ProgramData>\RevivalArc\reapply.log  owned by Administrators; Administrators/SYSTEM write, Users read
  Both trees are checked by SID, recursively: only Administrators, SYSTEM and TrustedInstaller may own or write them,
  and no junctions or symlinks are allowed. If a check fails, the task is disabled and nothing is registered.
  Task triggers: Vivaldi's installer re-adding its "Vivaldi (mDNS-In)" firewall rule (every install/update), logon,
  and daily at 11:00 as a safety net. remove.ps1 undoes all of it.
#>
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$UserData = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Vivaldi\User Data'),
    [string]$VivaldiApp = (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Vivaldi\Application'),
    [switch]$NoSmokeRun
)
$ErrorActionPreference = 'Stop'
# A trailing backslash would escape the closing quote in the task's command line.
$RepoRoot = $RepoRoot.TrimEnd('\'); $UserData = $UserData.TrimEnd('\'); $VivaldiApp = $VivaldiApp.TrimEnd('\')

$PyVersion = '3.14.3'
$PyUrl     = "https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-embed-amd64.zip"
$PySha256  = 'ad4961a479dedbeb7c7d113253f8db1b1935586b73c27488712beec4f2c894e6'  # python.org release page, 2026-11-02
$PySigner  = 'CN=Python Software Foundation, O=Python Software Foundation, L=Beaverton, S=Oregon, C=US'
$TaskName  = 'RevivalArc-Reapply'
# Known folders come from the OS, not from environment variables a user can set.
$Target    = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'RevivalArc'
$LogDir    = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'RevivalArc'
$TrustedSids = @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')  # Administrators, SYSTEM, TrustedInstaller
$CreatorOwner = 'S-1-3-0'
# Bits that let someone change content or permissions (FullControl/Modify also hold read bits, so no masks of those):
# WriteData 0x2, AppendData 0x4, WriteEA 0x10, DeleteChild 0x40, WriteAttributes 0x100, Delete 0x10000,
# ChangePermissions 0x40000, TakeOwnership 0x80000, GenericAll 0x10000000, GenericWrite 0x40000000
$WriteBits = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

function Stop-Unsafe($why) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $TaskName | Out-Null; $why += " (task $TaskName disabled)" }
    throw $why
}

# Every item under $Path (and $Path itself): no reparse points; owner and every write-capable Allow entry must be a
# trusted SID (CREATOR OWNER only as an inherit-only placeholder).
function Assert-AdminOnly($Path) {
    $items = @(Get-Item -LiteralPath $Path -Force) + @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction Stop)
    foreach ($item in $items) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Stop-Unsafe "$($item.FullName) is a junction or symlink; refusing" }
        $acl = Get-Acl -LiteralPath $item.FullName
        $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($TrustedSids -notcontains $owner) { Stop-Unsafe "$($item.FullName) is owned by $owner, who could rewrite its permissions; refusing" }
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -ne 'Allow' -or -not ([int64]$rule.FileSystemRights -band $WriteBits)) { continue }
            $sid = $rule.IdentityReference.Value
            if ($TrustedSids -contains $sid) { continue }
            if ($sid -eq $CreatorOwner -and $rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
            Stop-Unsafe "$($item.FullName) grants write access to $sid; refusing"
        }
    }
    Write-Host "    $Path`: $($items.Count) items, admin-only, no links"
}

if (-not (Test-Path (Join-Path $RepoRoot 'vivarc.py'))) { throw "No vivarc.py in $RepoRoot (use -RepoRoot)" }
if (-not (Test-Path (Join-Path $UserData 'Local State'))) { throw "No Vivaldi profile data at $UserData (use -UserData)" }
if (-not (Test-Path (Join-Path $VivaldiApp 'vivaldi.exe'))) { throw "No vivaldi.exe in $VivaldiApp (use -VivaldiApp)" }

Step "Target $Target"
if (Test-Path $Target) { Assert-AdminOnly $Target }  # an earlier deploy (or anything planted there) before touching it
New-Item -ItemType Directory -Force $Target | Out-Null

# --- Python -------------------------------------------------------------------------------------------------------
$py = Join-Path $Target 'python'
$have = if (Test-Path "$py\python.exe") { (Get-Item "$py\python.exe").VersionInfo.ProductVersion } else { $null }
if ($have -ne $PyVersion) {
    Step "Embeddable Python $PyVersion (had: $(if ($have) { $have } else { 'none' }))"
    $dl = Join-Path ([Environment]::GetFolderPath('Windows')) ("Temp\revivalarc-" + [guid]::NewGuid())
    New-Item -ItemType Directory $dl | Out-Null
    try {
        $zip = Join-Path $dl 'python.zip'
        Invoke-WebRequest -Uri $PyUrl -OutFile $zip -UseBasicParsing
        $sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
        if ($sha -ne $PySha256) { throw "Python download SHA-256 mismatch: got $sha, expected $PySha256" }
        if (Test-Path $py) { Remove-Item $py -Recurse -Force }
        Expand-Archive $zip $py
    } finally { Remove-Item $dl -Recurse -Force -ErrorAction SilentlyContinue }
}
foreach ($exe in 'python.exe', 'pythonw.exe') {
    $sig = Get-AuthenticodeSignature (Join-Path $py $exe)
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -ne $PySigner) {
        throw "$exe signature check failed: $($sig.Status) $($sig.SignerCertificate.Subject)"
    }
}

# --- App ----------------------------------------------------------------------------------------------------------
Step "Release copy of Vivarc from $RepoRoot"
$app = Join-Path $Target 'app'
if (Test-Path $app) { Remove-Item $app -Recurse -Force }
New-Item -ItemType Directory $app | Out-Null
foreach ($f in 'vivarc.py', 'windows_support.py', 'LICENSE') { Copy-Item (Join-Path $RepoRoot $f) $app }
Copy-Item (Join-Path $RepoRoot 'src') $app -Recurse
Get-ChildItem $app -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force
Copy-Item (Join-Path $PSScriptRoot 'reapply.py') $Target -Force
# The commit, read from .git directly: an elevated deploy should not run whatever "git" is first on PATH.
$commit = 'unknown'
try {
    $head = (Get-Content (Join-Path $RepoRoot '.git\HEAD') -Raw).Trim()
    if ($head -match '^ref: (.+)$') {
        $ref = $Matches[1]; $file = Join-Path $RepoRoot ".git\$ref"
        $commit = if (Test-Path $file) { (Get-Content $file -Raw).Trim() } else { ((Select-String -Path (Join-Path $RepoRoot '.git\packed-refs') -Pattern " $([regex]::Escape($ref))$").Line -split ' ')[0] }
        $commit = "$($commit.Substring(0, 7)) ($ref)"
    } else { $commit = $head.Substring(0, 7) }
} catch { }
Set-Content (Join-Path $Target 'DEPLOYED.txt') ("deployed {0:s} from {1} at commit {2} (uncommitted changes, if any, are included)" -f (Get-Date), $RepoRoot, $commit)

# --- Permissions --------------------------------------------------------------------------------------------------
Step 'Checking the install is admin-only'
Assert-AdminOnly $Target

Step "Log folder $LogDir"
if ((Test-Path $LogDir) -and ((Get-Item -LiteralPath $LogDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Stop-Unsafe "$LogDir is a junction or symlink; refusing" }
New-Item -ItemType Directory -Force $LogDir | Out-Null
# A standard user can create folders in ProgramData, so take ownership before trusting anything in it.
& icacls $LogDir /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
& icacls $LogDir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
if ($LASTEXITCODE) { throw "icacls failed on $LogDir" }
if (Get-ChildItem -LiteralPath $LogDir -Force) { & icacls "$LogDir\*" /reset /T /C /Q | Out-Null }  # children inherit the folder's entries
Assert-AdminOnly $LogDir

# --- Scheduled task -----------------------------------------------------------------------------------------------
Step "Scheduled task $TaskName"
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$esc = { param($s) [Security.SecurityElement]::Escape($s) }
$query = "<QueryList><Query Id=`"0`" Path=`"Microsoft-Windows-Windows Firewall With Advanced Security/Firewall`">" +
         "<Select Path=`"Microsoft-Windows-Windows Firewall With Advanced Security/Firewall`">" +
         "*[System[(EventID=2097)]] and *[EventData[Data[@Name='RuleName']='Vivaldi (mDNS-In)']]</Select></Query></QueryList>"
$start = (Get-Date).Date.AddDays(1).AddHours(11).ToString('s')
$arguments = "-I `"$Target\reapply.py`" --app `"$VivaldiApp`" --data-dir `"$UserData`""
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Revival Arc: puts Vivarc back after a Vivaldi update. Installed by $(& $esc $PSCommandPath); remove with remove.ps1.</Description>
  </RegistrationInfo>
  <Triggers>
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>$(& $esc $query)</Subscription>
      <Delay>PT30S</Delay>
    </EventTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$sid</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
    <CalendarTrigger>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$sid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(& $esc "$py\pythonw.exe")</Command>
      <Arguments>$(& $esc $arguments)</Arguments>
      <WorkingDirectory>$(& $esc $Target)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force | Out-Null

# --- Refresh Vivaldi with the code just deployed --------------------------------------------------------------------
Step 'Refreshing Vivarc in Vivaldi with the deployed code'
& "$py\python.exe" -I "$Target\reapply.py" --app $VivaldiApp --data-dir $UserData --force --no-toast
if ($LASTEXITCODE) { throw "reapply --force failed (exit $LASTEXITCODE); see $LogDir\reapply.log" }

# --- Smoke run ----------------------------------------------------------------------------------------------------
if (-not $NoSmokeRun) {
    Step 'Smoke run through the task'
    $log = Join-Path $LogDir 'reapply.log'
    $lines = if (Test-Path $log) { (Get-Content $log).Count } else { 0 }
    $previous = (Get-ScheduledTaskInfo -TaskName $TaskName).LastRunTime
    Start-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(90)
    do {
        Start-Sleep -Milliseconds 500
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        $state = (Get-ScheduledTask -TaskName $TaskName).State
    } while (($info.LastRunTime -eq $previous -or $state -eq 'Running') -and (Get-Date) -lt $deadline)
    $new = if (Test-Path $log) { @(Get-Content $log | Select-Object -Skip $lines) } else { @() }
    $new | ForEach-Object { Write-Host "    log: $_" }
    if ($info.LastRunTime -eq $previous) { throw 'Smoke run: the task did not start within 90 s' }
    if ($state -eq 'Running') { throw 'Smoke run: the task was still running after 90 s' }
    if ($info.LastTaskResult -ne 0) { throw ("Smoke run: task result 0x{0:X}" -f $info.LastTaskResult) }
    if (-not $new -or ($new -match 'FAILED')) { throw 'Smoke run: no success line in the log' }
    Write-Host '    task ran and succeeded'
}
Write-Host "Done. Log: $LogDir\reapply.log. Restart Vivaldi to load the refreshed code." -ForegroundColor Green
