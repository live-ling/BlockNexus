# 创建桌面快捷方式「BlockNexus」（图标 = BlockNexus.exe 内嵌的 images/blocknexus.ico）
# 用法: powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
# 前提: 先运行 scripts\build-exe.ps1 生成 BlockNexus.exe
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
# 优先用与项目分离的外壳目录（shell 方案，绕开项目文件夹的托盘注册异常）；不存在则回退项目根
$shellExe = Join-Path (Split-Path -Parent $root) 'BlockNexus\BlockNexus.exe'
$exe = if (Test-Path $shellExe) { $shellExe } else { Join-Path $root 'BlockNexus.exe' }
if (-not (Test-Path $exe)) { throw "BlockNexus.exe not found: $exe (run scripts\build-exe.ps1 first)" }

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'BlockNexus.lnk'

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $exe
$lnk.Arguments = ''
$lnk.WorkingDirectory = $root
$lnk.IconLocation = "$exe,0"
$lnk.Description = 'BlockNexus - 启动面板并打开应用窗口'
$lnk.WindowStyle = 1
$lnk.Save()

Write-Host "Desktop shortcut created: $lnkPath"
