# BlockNexus Edge helper - inspect / close the app-window process group.
#
# The app window runs msedge/chrome with its own profile (--user-data-dir=...\BlockNexus\app-profile),
# so its processes are found by that path appearing in the command line. The user's normal
# browser never carries this profile path, so it is never touched.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\blocknexus-edge.ps1 -ProfileDir <dir> -Action list
#     -> prints one PID per line (exit 0)
#   ... -Action haswindow
#     -> prints yes/no; exit 0 when a visible app window exists, 1 otherwise
#   ... -Action close
#     -> closes the window (graceful), then ends the whole group; prints "closed <n>" or "none"

param(
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [ValidateSet('list', 'haswindow', 'close')][string]$Action = 'list'
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-AppProcs {
  @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($ProfileDir.ToLower()) })
}

function Get-VisibleWindowCount {
  $n = 0
  foreach ($p in Get-AppProcs) {
    $g = Get-Process -Id $p.ProcessId
    if ($g -and $g.MainWindowHandle -ne 0) { $n++ }
  }
  return $n
}

switch ($Action) {
  'list' {
    Get-AppProcs | ForEach-Object { $_.ProcessId }
  }

  'haswindow' {
    if ((Get-VisibleWindowCount) -gt 0) { Write-Output 'yes'; exit 0 }
    Write-Output 'no'; exit 1
  }

  'close' {
    if ((Get-AppProcs).Count -eq 0) { Write-Output 'none'; exit 0 }

    # graceful: ask the window to close, exactly like clicking the X
    foreach ($p in Get-AppProcs) {
      $g = Get-Process -Id $p.ProcessId
      if ($g -and $g.MainWindowHandle -ne 0) { [void]$g.CloseMainWindow() }
    }
    for ($i = 0; $i -lt 10; $i++) {
      Start-Sleep -Milliseconds 400
      if ((Get-AppProcs).Count -eq 0) { Write-Output 'closed 0'; exit 0 }
    }

    # still alive: a windowless resident group (Startup Boost); terminate it
    $n = 0
    foreach ($p in Get-AppProcs) {
      Stop-Process -Id $p.ProcessId -Force
      $n++
    }
    Write-Output ("closed " + $n)
  }
}
