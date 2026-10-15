# 组装 Release 产物：便携版 zip + 纯外壳 zip + 应用包 zip + 版本元数据（含 SHA256SUMS）
#
# ⚠ 本文件必须保存为 **UTF-8 带 BOM + CRLF**：Windows PowerShell 5.1 按 ANSI 码页读无 BOM 的 .ps1，
#   中文注释与字符串会变乱码并直接解析失败（实测报 UnexpectedToken，脚本根本跑不起来）。
#   用编辑器/AI 工具改完这个文件后，务必确认前 3 字节仍是 EF BB BF。
#
# 便携版（解压到任意目录双击 BlockNexus.exe 即用）：
#   外壳运行件（exe/dll/runtimes）+ 内置 Node（runtime/node.exe，托盘 FindNode 的约定位置）
#   + 运行所需的最小源码树（panel/、agent/agent.js、web/dist、scripts/*.js）
#   + 全新安装的生产依赖（npm ci --omit=dev，不携带开发依赖）
#   + install.json 安装标记（面板凭它认出自更新形态为 portable；绝不含任何密钥/凭据）
# 纯外壳（解压到项目根目录，需项目已完成 npm install 与 npm run build:web）：
#   只有 exe/dll/runtimes。
# 应用包（面板「一键自更新」下载的载荷，根即应用目录，不套一层目录名）：
#   manifest.json + panel/ + web/dist/ + agent/agent.js + scripts/*.js
#   + package.json / package-lock.json / README.md / LICENSE /（images/ 若存在）
#   刻意不含 node_modules/runtime/exe/dll/data —— 依赖与外壳有变时面板会改用便携版（见 panel/update.js）
#
# 另外产出两个 release 资产：
#   update.json      版本元数据（由 scripts/update.template.json 填充；字段与 panel/update.js 的
#                    META_DEFAULTS 对齐，面板据此判断能否/是否自动升级）
#   SHA256SUMS.txt   `"<64位小写哈希>  <文件名>"`，覆盖全部 zip 与 update.json，按文件名升序
#
# 用法: powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1 [-OutDir <目录>] [-RebuildExe]
#         [-SkipPortable] [-SkipShell] [-SkipApp]
#         [-Severity security|critical|recommended|optional] [-AutoSafe] [-Breaking] [-RequiresAgentReinstall]
#         [-MinSourceVersion <版本>] [-Bridge <版本,版本>] [-DataSchema <int>] [-MinSchema <int>]
#         [-Irreversible] [-Summary <文本>] [-NotesUrl <https URL>]
#   -OutDir     产物输出目录（默认 ..\..\DE Project\BlockNexus Project 相对仓库不存在时用 .\release）
#   -RebuildExe 先重新构建 BlockNexus.exe（会结束正在运行的托盘；默认复用现有 exe——
#               托盘源码不变时二进制无需重打，也避免打断正在运行的面板）
#   -SkipPortable / -SkipShell / -SkipApp  跳过对应 zip（应用包会与便携版一样慢？不——应用包只是复制，
#               不跑 npm ci；跳过它主要用于快速验证）
#   元数据参数**默认值一律偏保守**（= 不自动更新、视为可能有破坏性、不承诺可回滚），
#   想放宽必须显式传参，避免「忘了想」就发布出可自动安装的版本。
param(
  [string]$OutDir = '',
  [switch]$RebuildExe,
  [switch]$SkipPortable,
  [switch]$SkipShell,
  [switch]$SkipApp,
  [ValidateSet('security', 'critical', 'recommended', 'optional')]
  [string]$Severity = 'recommended',
  [switch]$AutoSafe,
  [switch]$Breaking,
  [switch]$RequiresAgentReinstall,
  [string]$MinSourceVersion = '',
  [string[]]$Bridge = @(),
  [int]$DataSchema = 1,
  [int]$MinSchema = 1,
  [switch]$Irreversible,
  [string]$Summary = '',
  [string]$NotesUrl = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$raw = Get-Content (Join-Path $root 'package.json') -Raw
if ($raw -notmatch '"version"\s*:\s*"([^"]+)"') { throw 'package.json missing version' }
# 面板元数据里的版本号不带 v 前缀（panel/update.js 的 normalizeVersion 也容忍 v，但产出统一无前缀）
$version = $Matches[1] -replace '^[vV]', ''
Write-Host "BlockNexus v$version"

# ---------- 小工具 ----------
function Get-File-Sha256($path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# 写 UTF-8 **无 BOM** 的文本（必须无 BOM：manifest.json / update.json 由 Node 侧读取，
# 带 BOM 会让 JSON.parse 直接抛错）。
# 不用 Set-Content：PS5.1 的 -Encoding UTF8 永远带 BOM（且写不出"无尾换行"），
# 而 utf8NoBOM 这个枚举值在 PS5.1 的校验集里根本不存在。
function Write-TextNoBom($path, $text) {
  [System.IO.File]::WriteAllText($path, [string]$text, (New-Object System.Text.UTF8Encoding($false)))
}

# 相对路径里的分隔符统一用 '/'（Node 侧 shellHash 算法要求）
function Get-RelUnix($baseDir, $fullPath) {
  return ($fullPath.Substring($baseDir.Length).TrimStart('\', '/')) -replace '\\', '/'
}

# ---------- shellHash（必须与 Node 侧逐字一致） ----------
# 对存在的外壳文件按文件名升序（ordinal）取 "<相对路径>:<文件 SHA256 小写十六进制>"，
# 用 "\n" 连接（末尾不加换行），再对该字符串的 UTF-8 字节取 SHA256 小写十六进制。
# 一个文件都不存在 → ''（表示"无法判定"，见 panel/update.js 的 needsFullPackage）。
$shellHashFiles = @(
  'BlockNexus.exe', 'BlockNexus.exe.config', 'WebView2Loader.dll',
  'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll'
)
function Get-ShellHash() {
  $parts = New-Object System.Collections.Generic.List[string]
  # 必须用 Ordinal（逐字节）比较器：Sort-Object 默认是**文化相关**比较，
  # 对 BlockNexus.exe / BlockNexus.exe.config 这类前缀关系的相对次序可能与 Node 侧不同
  # （panel/update.js 的 shellHashOf 用 ordinal 排序，那边也写了同一条警示注释）。
  $names = @($shellHashFiles | Where-Object { Test-Path (Join-Path $root $_) })
  [Array]::Sort($names, [System.StringComparer]::Ordinal)
  foreach ($n in $names) {
    $parts.Add($n + ':' + (Get-File-Sha256 (Join-Path $root $n)))
  }
  if ($parts.Count -eq 0) { return '' }
  $joined = [string]::Join("`n", $parts)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($joined))
  } finally { $sha.Dispose() }
  return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

# ---------- 打包前断言 ----------
$forbiddenDirs = @('data', '.git', 'desin', 'docs', 'web/src', 'agent/src', 'node_modules')
$forbiddenFilesTop = @('root.txt')

# 暂存目录里不许出现的目录/文件（递归检查，全部按相对路径判定）
function Assert-NoForbidden($dir, $label) {
  $items = @(Get-ChildItem -LiteralPath $dir -Recurse -Force)
  foreach ($d in $forbiddenDirs) {
    $needle = $d -replace '/', '\'
    $hit = $items | Where-Object { $_.PSIsContainer -and (Get-RelUnix $dir $_.FullName) -eq $d }
    if (-not $hit) {
      $hit = $items | Where-Object {
        (Get-RelUnix $dir $_.FullName) -like "$needle\*" -or (Get-RelUnix $dir $_.FullName) -eq $needle
      }
    }
    if ($hit) { throw ("$label 暂存目录含禁止内容 $d （防公开仓库素材外泄）") }
  }
  foreach ($f in $forbiddenFilesTop) {
    if (Test-Path (Join-Path $dir $f)) { throw ("$label 暂存目录含禁止文件 $f （凭据/外壳标记，绝不能进发布包）") }
  }
  $logs = @($items | Where-Object { -not $_.PSIsContainer -and $_.Name -like '*.log' })
  if ($logs.Count -gt 0) { throw ("$label 暂存目录含日志文件: " + (($logs | ForEach-Object { $_.Name }) -join ', ')) }
}

function Assert-HasRequired($dir, $relPaths, $label) {
  foreach ($rel in $relPaths) {
    $p = Join-Path $dir ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $p)) { throw ("$label 打包内容缺失: $rel") }
  }
}

function Assert-HasNoExeOrDll($dir, $label) {
  # 必须用 -Path：-Include 与 -LiteralPath 同用时会被**静默忽略**（PS5.1 实测过），
  # 那样这条断言会永远通过。$dir 是本脚本自建的 TEMP 暂存路径，不含通配符，用 -Path 安全。
  $bad = @(Get-ChildItem -Path $dir -Recurse -Force -File -Include '*.exe', '*.dll')
  if ($bad.Count -gt 0) {
    throw ("$label 暂存目录含 exe/dll: " + (($bad | ForEach-Object { $_.Name }) -join ', '))
  }
}

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

# ---------- 版本元数据参数校验（与 panel/update.js 的清洗规则同向：宁缺勿错） ----------
$minSourceVersionNorm = ''
if ($MinSourceVersion) {
  $msv = $MinSourceVersion.Trim() -replace '^[vV]', ''
  if ($msv -notmatch '^\d+(\.\d+)*$') { throw "-MinSourceVersion 非法: $MinSourceVersion" }
  $minSourceVersionNorm = $msv
}
$bridgeNorm = @()
foreach ($b in @($Bridge)) {
  if (-not $b) { continue }
  $bv = $b.Trim() -replace '^[vV]', ''
  if ($bv -notmatch '^\d+(\.\d+)*$') { throw "-Bridge 含非法版本: $b" }
  if ($bridgeNorm -notcontains $bv) { $bridgeNorm += $bv }
  if ($bridgeNorm.Count -ge 8) { break }   # 与 parseUpdateMeta 的 slice(0,8) 上限一致
}
if ($Summary.Length -gt 500) { $Summary = $Summary.Substring(0, 500) }
$notesUrlNorm = ''
if ($NotesUrl) {
  if ($NotesUrl -notmatch '^https://\S+$') { throw "-NotesUrl 必须是 https:// 开头的 URL（panel/update.js 只收 https）" }
  $notesUrlNorm = $NotesUrl
}
if ($DataSchema -lt 1 -or $DataSchema -gt 9999) { throw "-DataSchema 必须在 1..9999" }
if ($MinSchema -lt 1 -or $MinSchema -gt 9999) { throw "-MinSchema 必须在 1..9999" }
if ($MinSchema -gt $DataSchema) { $MinSchema = $DataSchema }   # 与 parseUpdateMeta 的收敛规则一致

function Copy-ShellRuntime($dest) {
  foreach ($f in @('BlockNexus.exe', 'BlockNexus.exe.config', 'WebView2Loader.dll',
    'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')) {
    Copy-Item (Join-Path $root $f) $dest -Force
  }
  if (Test-Path (Join-Path $root 'runtimes')) {
    Copy-Item (Join-Path $root 'runtimes') $dest -Recurse -Force
  }
}

function Get-AppZipName() { return "BlockNexus-v$version-app.zip" }

# SHA256SUMS.txt：`"<64位小写哈希>  <文件名>"`，每行一个，按文件名升序（覆盖全部 zip 与 update.json）
function Write-Checksums($outDir, $paths) {
  $files = New-Object System.Collections.Generic.List[object]
  foreach ($p in $paths) {
    foreach ($f in @(Get-ChildItem -LiteralPath $p -File -ErrorAction SilentlyContinue)) {
      $files.Add([pscustomobject]@{ Name = $f.Name; FullName = $f.FullName })
    }
  }
  $lines = @($files | Sort-Object Name | ForEach-Object {
    (Get-File-Sha256 $_.FullName) + '  ' + $_.Name
  })
  $dest = Join-Path $outDir 'SHA256SUMS.txt'
  if ($lines.Count -eq 0) { $lines = @('') }   # 极端情况下别写出 0 字节文件
  Write-TextNoBom $dest ([string]::Join("`n", $lines))
  return $dest
}

# 读取模板并替换 __占位符__（模板是人工审查用的「产出结构说明书」，必须与产出结构一致）
function Get-UpdateJsonFromTemplate($templatePath, $values) {
  if (-not (Test-Path -LiteralPath $templatePath)) { throw "缺少模板 $templatePath" }
  $text = Get-Content -LiteralPath $templatePath -Raw
  foreach ($k in $values.Keys) {
    $ph = [regex]::Escape("__${k}__")
    if ($text -notmatch $ph) { throw "模板 $templatePath 缺少占位符 __${k}__" }
    # 不用 MatchEvaluator 回调：实测它在 PS5.1 下拿不到值（bridge 会被替成空，产出非法 JSON）
    $text = $text.Replace($ph, [string]$values[$k])
  }
  return $text
}

try {
  $artifacts = New-Object System.Collections.Generic.List[string]

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
    # scripts/ 下**所有** .js 都要带上：便携版是自更新的主要形态（install.json 会让面板认出
    # portable 并显示「立即更新」），缺了 panel-updater.js 就会在拉起更新器时 ENOENT。
    Get-ChildItem (Join-Path $root 'scripts') -Filter '*.js' | ForEach-Object {
      Copy-Item $_.FullName (Join-Path $app 'scripts') -Force
    }

    # 安装标记：面板凭它认出自更新形态 = portable（panel/update.js 的 readInstallMarker）。
    # 刻意只放形态/版本/构建时刻 —— 绝不放 token、SSH 密码、路径等任何凭据或环境信息。
    $install = [ordered]@{
      schema  = 1
      kind    = 'portable'
      version = $version
      builtAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    Write-TextNoBom (Join-Path $app 'install.json') ($install | ConvertTo-Json -Compress)

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
    # ⚠ scripts\panel-updater.js 是自更新的执行器：便携版缺了它，用户点「立即更新」会失败
    foreach ($v in @('web\dist\index.html', 'runtime\node.exe', 'panel\server.js', 'panel\update.js',
                     'agent\agent.js', 'node_modules\express\package.json',
                     'scripts\blocknexus-launcher.js', 'scripts\panel-updater.js')) {
      if (-not (Test-Path (Join-Path $app $v))) { throw ('打包内容缺失: ' + $v) }
    }
    # 便携包虽含 node_modules，但绝不能带上运行时数据与仓库标记
    if (Test-Path (Join-Path $app 'data')) { throw '便携包暂存目录含 data/（运行时凭据，绝不能进发布包）' }
    if (Test-Path (Join-Path $app 'root.txt')) { throw '便携包暂存目录含 root.txt（本机路径标记，绝不能进发布包）' }
    foreach ($v in @('install.json', 'package.json')) {
      if (-not (Test-Path (Join-Path $app $v))) { throw ('便携包暂存目录缺失: ' + $v) }
    }

    $zip = Join-Path $OutDir "BlockNexus-v$version-portable.zip"
    Compress-Archive -Path $app -DestinationPath $zip -Force  # 打整个目录：保留顶层 BlockNexus-portable/
    $artifacts.Add($zip)
    Write-Host "便携版: $zip"
  }

  # ---------- 纯外壳 ----------
  if (-not $SkipShell) {
    $shell = Join-Path $stage "BlockNexus-shell-v$version"
    New-Item -ItemType Directory -Force -Path $shell | Out-Null
    Copy-ShellRuntime $shell
    $zip = Join-Path $OutDir "BlockNexus-shell-v$version.zip"
    Compress-Archive -Path (Join-Path $shell '*') -DestinationPath $zip -Force
    $artifacts.Add($zip)
    Write-Host "纯外壳: $zip"
  }

  # ---------- 应用包（面板自更新的载荷） ----------
  if (-not $SkipApp) {
    $appDir = Join-Path $stage "BlockNexus-v$version-app"
    New-Item -ItemType Directory -Force -Path $appDir, (Join-Path $appDir 'web'), (Join-Path $appDir 'agent'), (Join-Path $appDir 'scripts') | Out-Null
    foreach ($f in @('package.json', 'package-lock.json', 'README.md', 'LICENSE')) {
      Copy-Item (Join-Path $root $f) $appDir -Force
    }
    foreach ($d in @('panel', 'images')) {
      if (Test-Path (Join-Path $root $d)) { Copy-Item (Join-Path $root $d) $appDir -Recurse -Force }
    }
    # 先建出 web/ 再拷（PS5.1 的 Copy-Item 在目标上级目录不存在时会复制残缺）
    Copy-Item (Join-Path $root 'web\dist') (Join-Path $appDir 'web') -Recurse -Force
    Copy-Item (Join-Path $root 'agent\agent.js') (Join-Path $appDir 'agent') -Force
    # 通配 scripts/*.js —— 别写死文件名：以后新增脚本（如 scripts/panel-updater.js）自动带上
    foreach ($js in @(Get-ChildItem -Path (Join-Path $root 'scripts') -Filter '*.js' -File)) {
      Copy-Item $js.FullName (Join-Path $appDir 'scripts') -Force
    }
    $tplPath = Join-Path $PSScriptRoot 'update.template.json'
    if (Test-Path -LiteralPath $tplPath) {
      Copy-Item $tplPath (Join-Path $appDir 'scripts') -Force
    } else {
      throw "缺少 scripts\update.template.json（版本库必须跟踪该模板）"
    }

    $lockHash = Get-File-Sha256 (Join-Path $root 'package-lock.json')
    $shellHash = Get-ShellHash
    if ($shellHash) { Write-Host "shellHash: $shellHash" } else { Write-Host 'shellHash: (空 —— 外壳文件都不存在，面板会按"无法判定"改用便携版)' }
    $assetName = Get-AppZipName

    # manifest.json：面板校验应用包身份与「依赖/外壳是否变过」
    $manifest = [ordered]@{
      schema     = 1
      version    = $version
      minNode    = 18
      lockHash   = $lockHash
      shellHash  = $shellHash
      assetName  = $assetName
    }
    Write-TextNoBom (Join-Path $appDir 'manifest.json') ($manifest | ConvertTo-Json)

    # 打包前断言：既防缺件，也防公开仓库素材/运行时数据外泄
    Assert-NoForbidden $appDir '应用包'
    Assert-HasRequired $appDir @(
      'manifest.json', 'panel/server.js', 'web/dist/index.html', 'agent/agent.js', 'package.json'
    ) '应用包'
    Assert-HasNoExeOrDll $appDir '应用包'
    if (-not (Test-Path (Join-Path $appDir 'scripts\update.template.json'))) {
      Write-Warning '应用包里没有 scripts/update.template.json —— 模板是 scripts/*.js 之外的资源，需人工确认发布内容'
    }

    # 关键：-Path 传 $appDir\* 让 zip 根即应用目录（不套一层 BlockNexus-v<ver>-app/）
    $zip = Join-Path $OutDir $assetName
    Compress-Archive -Path (Join-Path $appDir '*') -DestinationPath $zip -Force
    $artifacts.Add($zip)
    Write-Host "应用包: $zip"
  }

  # ---------- update.json（release 资产，面板更新的判定依据） ----------
  # 模板里分两类槽位：
  #   · 带引号的字符串槽（"__VERSION__"）——放**原始值**，模板的引号负责 JSON 引号
  #   · 裸槽（__BRIDGE__ / __SUMMARY__ / __NOTESURL__）——必须自己产出**合法的 JSON 字面量**，
  #     否则 Summary 里一个双引号就能把 update.json 变成非法 JSON（已实测踩到）
  # 注意：@() | ConvertTo-Json 在空数组时**什么都不输出**（PS5.1 实测），用 -InputObject 兜住。
  $updateValues = [ordered]@{
    VERSION          = $version
    SEVERITY         = $Severity
    AUTOSAFE         = if ($AutoSafe) { 'true' } else { 'false' }
    BREAKING         = if ($Breaking) { 'true' } else { 'false' }
    AGENTREINSTALL   = if ($RequiresAgentReinstall) { 'true' } else { 'false' }
    MINSOURCEVERSION = $minSourceVersionNorm
    BRIDGE           = (ConvertTo-Json -InputObject ([object[]]@($bridgeNorm)) -Compress)
    DATASCHEMA       = [string]$DataSchema
    MINSCHEMA        = [string]$MinSchema
    IRREVERSIBLE     = if ($Irreversible) { 'true' } else { 'false' }
    SUMMARY          = (ConvertTo-Json -InputObject ([string]$Summary) -Compress)
    NOTESURL         = (ConvertTo-Json -InputObject ([string]$notesUrlNorm) -Compress)
    LOCKHASH         = (Get-File-Sha256 (Join-Path $root 'package-lock.json'))
    SHELLHASH        = (Get-ShellHash)
  }
  $updatePath = Join-Path $OutDir 'update.json'
  $updateText = Get-UpdateJsonFromTemplate (Join-Path $PSScriptRoot 'update.template.json') $updateValues
  # 兜底断言：任何没被替换掉的占位符都会让 update.json 非法（面板一律按安全默认处理）
  $leftover = @([regex]::Matches($updateText, '__[A-Z]+__') | ForEach-Object { $_.Value })
  if ($leftover.Count -gt 0) { throw ('update.json 存在未替换的占位符: ' + ($leftover -join ', ')) }
  # 顺便确认产出是合法 JSON（PS5.1 的 ConvertFrom-Json 会直接抛）
  $null = $updateText | ConvertFrom-Json
  Write-TextNoBom $updatePath $updateText
  Write-Host "版本元数据: $updatePath"

  # ---------- SHA256SUMS.txt ----------
  $sums = Write-Checksums $OutDir ($artifacts + $updatePath)
  Write-Host "校验文件: $sums"

  Write-Host "`n========== SHA256SUMS.txt =========="
  Get-Content -LiteralPath $sums | ForEach-Object { Write-Host $_ }
}
finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
