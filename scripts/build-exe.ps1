# 生成 BlockNexus.exe：用 logo.png 做图标 → csc 编译 →（可选）本地自签并把证书加入信任
#
# 为什么要自签：未签名的本地 exe 会被 Defender SmartScreen 拦下（「发布者未知」）。
# 这里在本机创建一个代码签名证书并放进「受信任的根证书颁发机构」/「受信任的发布者」，
# 这样本机运行 BlockNexus.exe 不再弹拦截框。
# 注意：这是**本机自签**，只消除自己机器上的 SmartScreen 拦截；换一台电脑仍需正规证书签名。
#
# 用法: powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1 [-Sign]
#   -Sign     顺便做自签（首次会创建证书并导入信任区，可能弹 UAC/确认框）
#   -NoCert   跳过证书创建，只签名已存在的同主题证书
param(
  [switch]$Sign,
  [switch]$NoCert
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $PSScriptRoot 'tray\BlockNexusTray.cs'
$logo = Join-Path $root 'images\logo.png'
$ico = Join-Path $root 'images\blocknexus.ico'
$out = Join-Path $root 'BlockNexus.exe'
$certFile = Join-Path $root 'BlockNexus.cer'
$subject = 'CN=BlockNexus Local Developer'

if (-not (Test-Path $src)) { throw "source not found: $src" }

# ---------- 1) 图标：始终由 logo.png 生成，保证 exe/托盘图标就是 logo.png ----------
if (-not (Test-Path $logo)) { throw "logo not found: $logo" }
Write-Host "icon: regenerating blocknexus.ico from logo.png"
& (Join-Path $PSScriptRoot 'make-ico.ps1') -Png $logo -Out $ico
if (-not (Test-Path $ico)) { throw "icon generation failed: $ico" }

# ---------- 2) 正在运行的 exe 会让 csc 写不出来，先结束 ----------
$exeName = [System.IO.Path]::GetFileNameWithoutExtension($out)
Get-Process -Name $exeName -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $out } | ForEach-Object {
    Write-Host "stopping running instance (pid $($_.Id))"
    Stop-Process -Id $_.Id -Force
    Start-Sleep -Milliseconds 500
  }

# ---------- 3) 编译 ----------
$csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework*\v4.0.30319\csc.exe' -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $csc) { throw 'csc.exe not found: .NET Framework 4.x is required' }
Write-Host "csc: $($csc.FullName)"

# /win32icon 给 exe 本身的图标；/resource 把同一份 ico 内嵌为托盘图标资源（脱离 images 目录也能显示）
# WebView2：主窗口用 WebView2 渲染前端页面（桌面程序，不再依赖 msedge --app）。
#   - /r 引用 vendor\webview2\lib\net462 下的托管 DLL
#   - WebView2Loader.dll（本机 loader）按架构复制到 exe 同目录（anycpu 优先 x64）
$wv = Join-Path $root 'vendor\webview2'
$wvCore = Join-Path $wv 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$wvForms = Join-Path $wv 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
if (-not (Test-Path $wvCore)) { throw "WebView2 SDK missing: $wvCore (run scripts\fetch-webview2.ps1)" }
if (-not (Test-Path $wvForms)) { throw "WebView2 SDK missing: $wvForms" }

foreach ($arch in @('win-x64', 'win-x86')) {
  $loaderSrc = Join-Path $wv "runtimes\$arch\native\WebView2Loader.dll"
  if (-not (Test-Path $loaderSrc)) { throw "WebView2Loader.dll missing: $loaderSrc" }
}
# anycpu 进程在 x64 系统上加载 exe 同目录的 loader；x86 loader 放 runtimes\win-x86\native 兜底
Copy-Item (Join-Path $wv 'runtimes\win-x64\native\WebView2Loader.dll') $root -Force
$x86Dir = Join-Path $root 'runtimes\win-x86\native'
New-Item -ItemType Directory -Force -Path $x86Dir | Out-Null
Copy-Item (Join-Path $wv 'runtimes\win-x86\native\WebView2Loader.dll') $x86Dir -Force

# 托管 DLL 必须随 exe 分发（运行时程序集解析在 exe 同目录）
Copy-Item $wvCore $root -Force
Copy-Item $wvForms $root -Force

$cscArgs = @(
  '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
  "/out:$out",
  "/win32icon:$ico",
  "/resource:$ico,BlockNexus.AppIcon",
  "/win32manifest:$((Join-Path $PSScriptRoot 'tray\app.manifest'))",
  '/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
  "/r:$wvCore", "/r:$wvForms",
  $src
)
& $csc.FullName $cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
if (-not (Test-Path $out)) { throw "build failed: $out was not produced" }

# app.config → BlockNexus.exe.config：WinForms 的 PerMonitorV2 高 DPI 支持在此启用
Copy-Item (Join-Path $PSScriptRoot 'tray\app.config') "$out.config" -Force

$size = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host "built: $out ($size KB)"

# ---------- 3.2) 外壳分发包（与项目分离的目录） ----------
# Win11 25H2 上出现过「项目文件夹内任何 exe 的托盘图标都无法注册」的 shell 异常，
# 把外壳 exe 放到项目外的兄弟目录即可绕开。exe 通过 root.txt 找回项目根。
# 每次 build 都刷新该目录；目录不存在则创建，机器上没有异常时用哪个 exe 都一样。
$shellDir = Join-Path (Split-Path -Parent $root) 'BlockNexus'
try {
  New-Item -ItemType Directory -Force -Path $shellDir | Out-Null
  Set-Content -Path (Join-Path $shellDir 'root.txt') -Value $root -Encoding Ascii
  Copy-Item $out (Join-Path $shellDir 'BlockNexus.exe') -Force
  Copy-Item "$out.config" (Join-Path $shellDir 'BlockNexus.exe.config') -Force
  Copy-Item (Join-Path $root 'WebView2Loader.dll') $shellDir -Force
  Copy-Item $wvCore $shellDir -Force
  Copy-Item $wvForms $shellDir -Force
  $x86Dst = Join-Path $shellDir 'runtimes\win-x86\native'
  New-Item -ItemType Directory -Force -Path $x86Dst | Out-Null
  Copy-Item (Join-Path $wv 'runtimes\win-x86\native\WebView2Loader.dll') $x86Dst -Force
  Write-Host "shell: $shellDir"
}
catch {
  Write-Host "shell: skip ($($_.Exception.Message))"
}

# ---------- 3.5) 清 Windows 图标缓存 ----------
# 资源管理器按 exe 路径缓存图标，图标换了也还会显示旧图，必须让它重建。
Write-Host 'refreshing Windows icon cache...'
$ie4uinit = Join-Path $env:SystemRoot 'System32\ie4uinit.exe'
if (Test-Path $ie4uinit) {
  try {
    Start-Process $ie4uinit -ArgumentList '-ClearIconCache' -Wait -WindowStyle Hidden -ErrorAction Stop
    Write-Host 'cleared shell icon cache (ie4uinit)'
  }
  catch {
    Write-Host "icon cache clear skipped: $($_.Exception.Message)"
  }
}

if (-not $Sign) {
  Write-Host 'tip: run with -Sign to self-sign the exe and remove the SmartScreen block'
  exit 0
}

# ---------- 4) 自签：需要管理员才能把证书装进本机信任区 ----------
# AppHost / SmartScreen 只认 **LocalMachine\TrustedPublisher**（本机范围），
# 只导进 CurrentUser 的话仍会被拦截，所以这一步必须提权。
if (-not (Test-Path $out)) { throw "nothing to sign: $out" }
$here = $MyInvocation.MyCommand.Path
if ($NoCert) { $needReload = $true } else { $needReload = $false }
$signArg = '-ExecutionPolicy Bypass -NoProfile -File "' + $here + '" -Sign -NoCert'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host 'elevating (admin needed to install the cert into local machine trust stores)...'
  try {
    Start-Process powershell -Verb RunAs -Wait -ArgumentList $signArg
  }
  catch { throw 'elevation was declined by UAC' }
  $sig0 = Get-AuthenticodeSignature $out
  if ($sig0.Status -eq 'Valid') {
    Write-Host "signed (elevated session): $out -> $($sig0.SignerCertificate.Subject)"
  }
  else {
    Write-Host "warning: exe still unsigned ($($sig0.Status))"
  }
  exit 0
}

$signtool = Get-ChildItem 'C:\Program Files*\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue |
  Sort-Object FullName | Select-Object -Last 1
if (-not $signtool) { throw 'signtool.exe not found (install Windows SDK)' }
Write-Host "signtool: $($signtool.FullName)"

$cert = Get-ChildItem 'Cert:\CurrentUser\My' -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -eq $subject } | Sort-Object NotAfter -Descending | Select-Object -First 1

if (-not $cert -and -not $NoCert) {
  Write-Host 'creating a local code-signing certificate...'
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -KeyAlgorithm RSA -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -NotAfter (Get-Date).AddYears(5) `
    -FriendlyName 'BlockNexus local code signing'
  if (-not $cert) { throw 'certificate creation failed' }
}
if (-not $cert) { throw "no code-signing certificate found ($subject)" }

Write-Host "cert: $($cert.Subject) thumbprint $($cert.Thumbprint)"

# 证书要被信任：导出公钥 cer，装进 **LocalMachine** 的 Root 与 TrustedPublisher。
# 当前已是提权窗口（上面 Start-Process -Verb RunAs 重开的才是写 LocalMachine 的那个）。
Export-Certificate -Cert $cert -FilePath $certFile -Force | Out-Null
$certObj = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2
$certObj.Import($certFile)
foreach ($storeName in @('Root', 'TrustedPublisher')) {
  foreach ($location in @('CurrentUser', 'LocalMachine')) {
    try {
      $store = New-Object System.Security.Cryptography.X509Certificates.X509Store $storeName, $location
      $store.Open('ReadWrite')
      $exists = $store.Certificates | Where-Object { $_.Thumbprint -eq $certObj.Thumbprint }
      if (-not $exists) {
        Write-Host "trusting certificate in $location\$storeName"
        $store.Add($certObj)
      }
      $store.Close()
    }
    catch {
      Write-Host "skip $location\$storeName : $($_.Exception.Message)"
    }
  }
}

# RFC3161 时间戳：证明签名时证书有效，也让 SmartScreen 不必走「未加戳」的严格路径。
# 需要能访问时间戳服务器；离线时自动退回无时间戳签名（签名本身仍然有效）。
& $signtool.FullName sign /fd SHA256 /td SHA256 /sha1 $cert.Thumbprint `
  /tr 'http://timestamp.digicert.com' $out
if ($LASTEXITCODE -ne 0) {
  Write-Host 'timestamping failed (offline?), retrying without timestamp...'
  & $signtool.FullName sign /fd SHA256 /td SHA256 /sha1 $cert.Thumbprint $out
  if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE" }
}

& $signtool.FullName verify /pa $out
Write-Host "signed: $out"
$signedSig = Get-AuthenticodeSignature $out
Write-Host "signature: $($signedSig.Status) / timestamped: $([bool]$signedSig.TimeStamperCertificate)"
