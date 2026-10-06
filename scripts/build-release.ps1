# 组装 Release 产物：便携版 zip + 纯外壳 zip（含 SHA256）
#
# 便携版（解压到任意目录双击 BlockNexus.exe 即用）：
#   外壳运行件（exe/dll/runtimes）+ 内置 Node（runtime/node.exe，托盘 FindNode 的约定位置）
#   + 运行所需的最小源码树（panel/、agent/agent.js、web/dist、scripts/blocknexus-launcher.js）
#   + 全新安装的生产依赖（npm ci --omit=dev，不携带开发依赖）
# 纯外壳（解压到项目根目录，需项目已完成 npm install 与 npm run build:web）：
#   只有 exe/dll/runtimes。
#
# 用法: powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1 [-OutDir <目录>] [-RebuildExe]
#   -OutDir     产物输出目录（默认 ..\..\DE Project\BlockNexus Project 相对仓库不存在时用 .\release）
#   -RebuildExe 先重新构建 BlockNexus.exe（会结束正在运行的托盘；默认复用现有 exe——
#               托盘源码不变时二进制无需重打，也避免打断正在运行的面板）
param(
  [string]$OutDir = '',
  [switch]$RebuildExe,
  [switch]$SkipPortable,
  [switch]$SkipShell
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$raw = Get-Content (Join-Path $root 'package.json') -Raw
if ($raw -notmatch '"version"\s*:\s*"([^"]+)"') { throw 'package.json missing version' }
$version = $Matches[1]
Write-Host "BlockNexus v$version"

# ---------- 前置检查 ----------
$mustHave = @(
  'BlockNexus.exe', 'BlockNexus.exe.config', 'WebView2Loader.dll',
  'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll',
  'agent\agent.js', 'web\dist\index.html', 'LICENSE',
  'scripts\blocknexus-launcher.js'
)
foreach ($f in $mustHave) {
  if (-not (Test-Path (Join-Path $root $f))) { throw "缺少 $f（先跑 build-exe.ps1 / fetch-webview2.ps1 / build:web / build:agent）" }
}
$nodeExe = (Get-Command node.exe).Source
Write-Host "node: $nodeExe ($(& $nodeExe -v))"
if ($RebuildExe) {
  & (Join-Path $PSScriptRoot 'build-exe.ps1')
  if ($LASTEXITCODE -ne 0) { throw "build-exe 失败" }
}

if (-not $OutDir) {
  $preferred = 'D:\11493\Desktop\DE Project\BlockNexus Project'
  $OutDir = if (Test-Path (Split-Path -Parent $preferred)) { $preferred } else { Join-Path $root 'release' }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stage = Join-Path $env:TEMP ("bn-release-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

function Copy-ShellRuntime($dest) {
  foreach ($f in @('BlockNexus.exe', 'BlockNexus.exe.config', 'WebView2Loader.dll',
    'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')) {
    Copy-Item (Join-Path $root $f) $dest -Force
  }
  if (Test-Path (Join-Path $root 'runtimes')) {
    Copy-Item (Join-Path $root 'runtimes') $dest -Recurse -Force
  }
}

try {
  # ---------- 便携版 ----------
  if (-not $SkipPortable) {
    # 顶层目录名沿用 v0.2.0 约定（不带版本号），解压即得一个文件夹
    $app = Join-Path $stage "BlockNexus-portable"
    New-Item -ItemType Directory -Force -Path $app, (Join-Path $app 'runtime'), (Join-Path $app 'agent'), (Join-Path $app 'scripts') | Out-Null
    Copy-ShellRuntime $app
    Copy-Item $nodeExe (Join-Path $app 'runtime\node.exe') -Force
    foreach ($f in @('package.json', 'package-lock.json', 'README.md', 'LICENSE')) {
      Copy-Item (Join-Path $root $f) $app -Force
    }
    foreach ($d in @('panel', 'images')) {
      if (Test-Path (Join-Path $root $d)) { Copy-Item (Join-Path $root $d) $app -Recurse -Force }
    }
    # PS5.1 的 Copy-Item 在目标上级目录不存在时会复制残缺，先建出 web/ 再拷
    New-Item -ItemType Directory -Force -Path (Join-Path $app 'web') | Out-Null
    Copy-Item (Join-Path $root 'web\dist') (Join-Path $app 'web') -Recurse -Force
    Copy-Item (Join-Path $root 'agent\agent.js') (Join-Path $app 'agent') -Force
    Copy-Item (Join-Path $root 'scripts\blocknexus-launcher.js') (Join-Path $app 'scripts') -Force

    Write-Host '安装生产依赖（npm ci --omit=dev）…'
    Push-Location $app
    try {
      # 便携包内置的 runtime/node.exe 供托盘使用；本机 PATH 里的 npm 装依赖即可
      $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
      if (-not $npm) { throw '未找到 npm（PATH）' }
      & $npm ci --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
    } finally { Pop-Location }

    # 压缩前断言关键内容都在（PS5.1 的 Copy-Item 出过静默残缺）
    foreach ($v in @('web\dist\index.html', 'runtime\node.exe', 'panel\server.js', 'agent\agent.js', 'node_modules\express\package.json')) {
      if (-not (Test-Path (Join-Path $app $v))) { throw ('打包内容缺失: ' + $v) }
    }

    $zip = Join-Path $OutDir "BlockNexus-v$version-portable.zip"
    Compress-Archive -Path $app -DestinationPath $zip -Force  # 打整个目录：保留顶层 BlockNexus-portable/
    Write-Host "便携版: $zip"
  }

  # ---------- 纯外壳 ----------
  if (-not $SkipShell) {
    $shell = Join-Path $stage "BlockNexus-shell-v$version"
    New-Item -ItemType Directory -Force -Path $shell | Out-Null
    Copy-ShellRuntime $shell
    $zip = Join-Path $OutDir "BlockNexus-shell-v$version.zip"
    Compress-Archive -Path (Join-Path $shell '*') -DestinationPath $zip -Force
    Write-Host "纯外壳: $zip"
  }

  Write-Host "`n========== SHA256 =========="
  Get-ChildItem $OutDir -Filter "BlockNexus-*v$version*.zip" |
    ForEach-Object { "{0}`n  {1}" -f $_.Name, (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
}
finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
