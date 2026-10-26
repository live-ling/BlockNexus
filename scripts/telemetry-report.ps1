#!/usr/bin/env pwsh
<#
.SYNOPSIS
  查询 BlockNexus 遥测统计。

.DESCRIPTION
  从遥测服务器拉 /summary 聚合结果：按天装机数、版本分布、系统分布、错误码排行。

  读数据需要 token（运营数据只有运维者该看）。token 的取法按优先级：
    1. -Token 参数
    2. 环境变量 $env:BLOCKNEXUS_TELEMETRY_TOKEN
    3. 本地文件（默认 <仓库>/data/telemetry-token.txt，data/ 已 gitignore）
  **token 绝不要写进本脚本或提交进仓库**——脚本的壳可以公开，钥匙不行。

.PARAMETER Endpoint
  遥测端点。默认 https://api-blocknexus.liveling.top（经反代与 CDN 的 HTTPS 地址；
  不要在文档或脚本里写源站 IP——源站只应接受来自反代的流量，直接暴露等于绕过防护）。

.PARAMETER Token
  读 token。省略时依次读环境变量与本地 token 文件。

.PARAMETER Days
  最近 N 天的按天装机数，0 = 全部。默认 30。

.PARAMETER Json
  输出原始 JSON 而不是表格。

.EXAMPLE
  ./scripts/telemetry-report.ps1              # 默认端点，最近 30 天
  ./scripts/telemetry-report.ps1 -Days 7
  ./scripts/telemetry-report.ps1 -Json
#>
param(
  [string]$Endpoint = 'https://api-blocknexus.liveling.top',
  [string]$Token = '',
  [int]$Days = 30,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$base = $Endpoint.TrimEnd('/')
if ($Days -lt 0 -or $Days -gt 3650) { Write-Error '-Days 需在 0-3650 之间'; exit 1 }
$path = if ($Days -gt 0) { "/summary?days=$Days" } else { '/summary' }

# ---------- 取 token（参数 > 环境变量 > 本地文件）----------
$tokenFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'data\telemetry-token.txt'
if (-not $Token) { $Token = $env:BLOCKNEXUS_TELEMETRY_TOKEN }
if (-not $Token -and (Test-Path $tokenFile)) {
  $Token = (Get-Content $tokenFile -Raw -ErrorAction SilentlyContinue)
  if ($Token) { $Token = $Token.Trim() }
}
if (-not $Token) {
  Write-Output '缺少读 token，无法查询统计。三种给法任选其一：'
  Write-Output ''
  Write-Output ("  1. 参数    : ./telemetry-report.ps1 -Token <token>")
  Write-Output ("  2. 环境变量: `$env:BLOCKNEXUS_TELEMETRY_TOKEN = '<token>'")
  Write-Output ("  3. 本地文件: 把 token 写进 {0}（data/ 已 gitignore）" -f $tokenFile)
  Write-Output ''
  Write-Output 'token 在 VPS 的 /opt/blocknexus-telemetry/env 里（TELEMETRY_TOKEN=...）。'
  exit 1
}
$headers = @{ 'X-Summary-Token' = $Token }

# 拉取失败重试 2 次（EO 路由抖动 / 本地网络抖动不该让报表直接挂掉），失败给排查提示。
# 401/503 不重试：那是 token 或服务端配置问题，重试只会白等。
$summary = $null
$lastErr = ''
$lastStatus = 0
for ($i = 0; $i -lt 3; $i++) {
  try {
    $summary = Invoke-RestMethod -Uri ($base + $path) -Headers $headers -TimeoutSec 20
    break
  } catch {
    $lastErr = $_.Exception.Message
    $lastStatus = 0
    if ($_.Exception.Response) { $lastStatus = [int]$_.Exception.Response.StatusCode }
    if ($lastStatus -eq 401 -or $lastStatus -eq 503) { break }
    if ($i -lt 2) { Start-Sleep -Seconds (1 + $i * 2) }
  }
}
if (-not $summary) {
  if ($lastStatus -eq 401) {
    Write-Output 'token 不正确（401）：请确认用的是 VPS 上 /opt/blocknexus-telemetry/env 里的 TELEMETRY_TOKEN。'
  } elseif ($lastStatus -eq 503) {
    Write-Output '服务端没配 token（503）：VPS 上需要 /opt/blocknexus-telemetry/env 里的 TELEMETRY_TOKEN，然后重启服务。'
  } else {
    Write-Output "获取遥测统计失败（已重试 3 次）: $lastErr"
    Write-Output ''
    Write-Output '排查提示:'
    Write-Output ("  1. 确认端点可达  : Invoke-RestMethod '{0}/health'" -f $base)
    Write-Output '  2. VPS 服务状态  : systemctl status blocknexus-telemetry'
    Write-Output '  3. 换端点对比    : ./telemetry-report.ps1 -Endpoint <其它地址>'
  }
  exit 1
}
# Invoke-RestMethod 对单键对象的类型推断不稳定：JSON 往返一次，强制成规整的 PSCustomObject
$summary = $summary | ConvertTo-Json -Depth 10 | ConvertFrom-Json

if ($Json) {
  $summary | ConvertTo-Json -Depth 10
  return
}

$line = '-' * 62
Write-Output ''
Write-Output ("  BlockNexus 遥测统计   {0}" -f $summary.day)
Write-Output ("  总上报 {0} 条 · 独立装机 {1} 台" -f $summary.totalRecords, $summary.uniqueIds)
Write-Output $line

function Show-Distribution($title, $obj, $width = 14) {
  Write-Output ''
  Write-Output ("  {0}" -f $title)
  Write-Output $line
  if (-not $obj) { Write-Output '  （无数据）'; return }
  $props = if ($obj -is [System.Management.Automation.PSCustomObject]) { $obj.PSObject.Properties } else { @() }
  $max = ($props | Measure-Object -Property Value -Maximum).Maximum
  if (-not $max) { $max = 1 }
  foreach ($p in ($props | Sort-Object Value -Descending)) {
    $bar = [string]::new('#', [Math]::Max(1, [int][Math]::Round(($p.Value / $max) * 24)))
    Write-Output ("  {0,-16} {1,5}  {2}" -f $p.Name, $p.Value, $bar)
  }
}

Write-Output ''
Write-Output '  按天独立装机数（按匿名 ID 去重）'
Write-Output $line
if (-not $summary.installsPerDay) {
  Write-Output '  （还没有数据）'
} else {
  # 变量名不能叫 $days：与参数 $Days 是同一个变量（PowerShell 大小写不敏感），
  # 覆盖它会让 -Days 失效并出类型转换错误（踩过一次）。
  $dayRows = @($summary.installsPerDay.PSObject.Properties | ForEach-Object { [pscustomobject]@{ Day = [string]$_.Name; Count = $_.Value } } | Sort-Object Day)
  $max = ($dayRows | Measure-Object -Property Count -Maximum).Maximum
  if (-not $max) { $max = 1 }
  foreach ($p in $dayRows) {
    $bar = [string]::new('#', [Math]::Max(1, [int][Math]::Round(($p.Count / $max) * 30)))
    Write-Output ("  {0}  {1,3}  {2}" -f $p.Day, $p.Count, $bar)
  }
}

Show-Distribution '面板版本' $summary.panelVer
Show-Distribution 'Agent 版本' $summary.agentVers
Show-Distribution '操作系统' $summary.os
Show-Distribution '安装形态' $summary.installKind
Show-Distribution '服务器数量（区间）' $summary.servers
Show-Distribution '启用的功能' $summary.features
Show-Distribution '错误码排行' $summary.errors

Write-Output ''
