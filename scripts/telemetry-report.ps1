#!/usr/bin/env pwsh
<#
.SYNOPSIS
  查询 BlockNexus 遥测统计。

.DESCRIPTION
  从遥测服务器拉 /summary 聚合结果：按天装机数、版本分布、系统分布、错误码排行。
  只读接口，不需要凭据。

.PARAMETER Endpoint
  遥测端点。默认 https://api-blocknexus.liveling.top（经反代与 CDN 的 HTTPS 地址；
  不要在文档或脚本里写源站 IP——源站只应接受来自反代的流量，直接暴露等于绕过防护）。

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
  [int]$Days = 30,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$base = $Endpoint.TrimEnd('/')
$path = if ($Days -gt 0) { "/summary?days=$Days" } else { '/summary' }

$summary = Invoke-RestMethod -Uri ($base + $path) -TimeoutSec 20
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
