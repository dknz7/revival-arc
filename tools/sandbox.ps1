<#
.SYNOPSIS
  A throwaway Vivaldi for live checks: a copy of the installed app with its own profile, running this repo's Vivarc,
  reachable over CDP on port 9333 only.

.DESCRIPTION
  Default: copy C:\Program Files\Vivaldi\Application to %TEMP%\vivarc-sandbox\app (skipped when already copied),
  apply -Repo's Vivarc to the copy, then launch the copy on its own profile with the debugging port open.

  vivarc.py apply runs with USERPROFILE and HOME pointed at %TEMP%\vivarc-sandbox\home, so it reads and writes
  %TEMP%\vivarc-sandbox\home\.vivarc and never the real ~\.vivarc (config, start page, backups).

  Nothing here touches the installed Vivaldi or a Vivaldi running on its own profile: the installed app is only read,
  and -Stop matches processes by a command line that contains "vivarc-sandbox".

.PARAMETER Repo
  The checkout whose vivarc.py and src are applied. Default: the repo holding this script. A git worktree at an
  older commit works too (run -Clean first, so the copy starts from the installed app again).

.PARAMETER Stop
  Kill the sandbox's vivaldi.exe processes (command line contains "vivarc-sandbox") and nothing else.

.PARAMETER Clean
  Stop the sandbox, then delete %TEMP%\vivarc-sandbox.
#>
param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [switch]$Stop,
  [switch]$Clean
)
$ErrorActionPreference = "Stop"

$Root = Join-Path $env:TEMP "vivarc-sandbox"
$AppDir = Join-Path $Root "app"
$ProfileDir = Join-Path $Root "profile"
$HomeDir = Join-Path $Root "home"
$Copied = Join-Path $Root "app.copied"
$Installed = "C:\Program Files\Vivaldi\Application"
$Port = 9333

function Get-SandboxProcesses {
  @(Get-CimInstance Win32_Process -Filter "name='vivaldi.exe'" | Where-Object { $_.CommandLine -like "*vivarc-sandbox*" })
}

function Stop-Sandbox {
  $procs = Get-SandboxProcesses
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 20 -and (Get-SandboxProcesses).Count; $i++) { Start-Sleep -Milliseconds 250 }
  $left = (Get-SandboxProcesses).Count
  if ($left) { throw "$left sandbox process(es) still running" }
  "Stopped $($procs.Count) sandbox process(es)."
}

if ($Stop -or $Clean) {
  Stop-Sandbox
  if ($Clean -and (Test-Path $Root)) {
    Remove-Item -LiteralPath $Root -Recurse -Force
    "Deleted $Root"
  }
  return
}

if ((Get-SandboxProcesses).Count) { throw "The sandbox is already running. Run with -Stop first, so it restarts on the code applied now." }
$Repo = (Resolve-Path $Repo).Path
if (-not (Test-Path (Join-Path $Repo "vivarc.py"))) { throw "No vivarc.py in $Repo" }

# 1. Copy the installed app (once). The marker is written only after a complete copy.
if (-not (Test-Path $Copied)) {
  if (Test-Path $AppDir) { Remove-Item -LiteralPath $AppDir -Recurse -Force }
  New-Item -ItemType Directory -Force $AppDir | Out-Null
  robocopy $Installed $AppDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
  Set-Content -LiteralPath $Copied -Value (Get-Date).ToString("o")
  "Copied $Installed to $AppDir"
} else { "App copy already present: $AppDir" }

# 2. Apply the repo's Vivarc to the copy, with a sandbox home so the real ~\.vivarc is never read or written.
$realGuide = Join-Path $env:USERPROFILE ".vivarc\start\index.html"
$guideBefore = if (Test-Path $realGuide) { (Get-Item $realGuide).LastWriteTimeUtc } else { $null }
New-Item -ItemType Directory -Force $HomeDir, $ProfileDir | Out-Null
$saved = @{ USERPROFILE = $env:USERPROFILE; HOME = $env:HOME }
try {
  $env:USERPROFILE = $HomeDir
  $env:HOME = $HomeDir
  & python (Join-Path $Repo "vivarc.py") --app $AppDir --data-dir $ProfileDir apply
  if ($LASTEXITCODE) { throw "vivarc.py apply failed ($LASTEXITCODE)" }
} finally {
  $env:USERPROFILE = $saved.USERPROFILE
  $env:HOME = $saved.HOME
}
$guideAfter = if (Test-Path $realGuide) { (Get-Item $realGuide).LastWriteTimeUtc } else { $null }
if ($guideBefore -ne $guideAfter) { throw "$realGuide changed during apply: the sandbox home did not hold" }

# 3. Launch the copy on its own profile.
$exe = Join-Path $AppDir "vivaldi.exe"
$taken = try { Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 } catch { $null }
if ($taken) { throw "Something else already listens on port $Port ($($taken.Browser)); not launching" }
Start-Process -FilePath $exe -ArgumentList @(
  "--user-data-dir=`"$ProfileDir`"", "--remote-debugging-port=$Port", "--no-first-run", "--no-default-browser-check")
$v = $null
for ($i = 0; $i -lt 60; $i++) {
  try { $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2; break } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $v) { throw "The sandbox did not open port $Port" }
"Sandbox up: $($v.Browser) on port $Port, profile $ProfileDir, Vivarc from $Repo"
