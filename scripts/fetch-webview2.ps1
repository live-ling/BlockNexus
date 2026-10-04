# 下载 Microsoft.Web.WebView2 SDK（NuGet 包）并解出编译所需 DLL。
# 只需运行一次；build-exe.ps1 依赖 vendor\webview2 下的产物。
#
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fetch-webview2.ps1 [-Version 1.0.2792.45]
param(
  [string]$Version = '1.0.2792.45'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vdir = Join-Path $root 'vendor\webview2'
New-Item -ItemType Directory -Force -Path $vdir | Out-Null

$pkg = 'Microsoft.Web.WebView2'
$id = $pkg.ToLowerInvariant()
$nupkg = Join-Path $env:TEMP "$id.$Version.nupkg"

if (-not (Test-Path $nupkg)) {
  $url = "https://api.nuget.org/v3-flatcontainer/$id/$Version/$id.$Version.nupkg"
  Write-Host "downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $nupkg -TimeoutSec 120
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($nupkg)
try {
  $targets = @(
    'runtimes/win-x64/native/WebView2Loader.dll',
    'runtimes/win-x86/native/WebView2Loader.dll',
    'lib/net462/Microsoft.Web.WebView2.Core.dll',
    'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
  )
  foreach ($t in $targets) {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq $t }
    if (-not $entry) { throw "package missing entry: $t" }
    $dest = Join-Path $vdir ($t -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
    Write-Host "  ok: $t"
  }
}
finally { $zip.Dispose() }

Write-Host "WebView2 SDK ready: $vdir"
