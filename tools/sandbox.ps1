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

.PARAMETER WithPeek
  Put the community Peek mod into the sandbox's Vivarc: its two pinned files are copied (read only) from the real
  ~\.vivarc\peek into the sandbox home, after their sha256 is checked against PEEK_FILES in -Repo's vivarc.py. Without
  it, a Peek that an earlier run copied is taken out of the sandbox home again, so the sandbox runs without Peek (the
  cases declared `peek` then report SKIP).
#>
param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [switch]$Stop,
  [switch]$Clean,
  [switch]$WithPeek
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
$SandboxPeek = Join-Path $HomeDir ".vivarc\peek"
$PeekNames = @("VividPeek.js", "VividPeek.css")
if ($WithPeek) {
  $RealPeek = Join-Path $env:USERPROFILE ".vivarc\peek"
  $pins = Get-Content -LiteralPath (Join-Path $Repo "vivarc.py") -Raw
  New-Item -ItemType Directory -Force $SandboxPeek | Out-Null
  foreach ($name in $PeekNames) {
    $src = Join-Path $RealPeek $name
    if (-not (Test-Path $src)) { throw "No $src to copy (install Vivarc with Peek first)" }
    $m = [regex]::Match($pins, [regex]::Escape("`"$name`"") + ':\s*\([^,]+,\s*"([0-9a-f]{64})"')
    if (-not $m.Success) { throw "No pinned sha256 for $name in vivarc.py" }
    $sha = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLower()
    if ($sha -ne $m.Groups[1].Value) { throw "$src does not match its pin in vivarc.py" }
    Copy-Item -LiteralPath $src -Destination (Join-Path $SandboxPeek $name) -Force
  }
  "Peek copied into the sandbox home (sha256 checked against vivarc.py)"
} else {
  foreach ($name in $PeekNames) { $f = Join-Path $SandboxPeek $name; if (Test-Path $f) { Remove-Item -LiteralPath $f -Force } }
}
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
