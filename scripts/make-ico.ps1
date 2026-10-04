# Convert images/logo.png to a multi-size Windows icon images/blocknexus.ico
# Usage: powershell -ExecutionPolicy Bypass -File scripts\make-ico.ps1
param(
  [string]$Png = "$PSScriptRoot\..\images\logo.png",
  [string]$Out = "$PSScriptRoot\..\images\blocknexus.ico"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Resolve-Path $Png))
$sizes = 16, 24, 32, 48, 64, 128, 256
$tmp = Join-Path $env:TEMP ("blocknexus-ico-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

$files = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = 'HighQuality'
  $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($src, 0, 0, $s, $s)
  $p = Join-Path $tmp ("$s.png")
  $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $files += $p
}
$src.Dispose()

# Assemble the ICO: embed PNG blobs directly (supported since Windows Vista)
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$files.Count)
$offset = 6 + 16 * $files.Count
$blobs = @()
foreach ($p in $files) {
  $bytes = [IO.File]::ReadAllBytes($p)
  $s = [IO.Path]::GetFileNameWithoutExtension($p) -as [int]
  $w = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$w); $bw.Write([byte]$w); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$bytes.Length); $bw.Write([uint32]$offset)
  $offset += $bytes.Length
  $blobs += , $bytes
}
foreach ($b in $blobs) { $bw.Write($b) }
$bw.Flush()
$outDir = Resolve-Path (Split-Path -Parent $Out)
[IO.File]::WriteAllBytes((Join-Path $outDir (Split-Path -Leaf $Out)), $ms.ToArray())
$bw.Close(); $ms.Close()
Remove-Item -Recurse -Force $tmp
$kb = [math]::Round((Get-Item $Out).Length / 1KB, 1)
Write-Host "ICO written: $Out ($kb KB, $($files.Count) sizes)"
