# 演示站用品牌标志（文字版）生成：由 LOGO/ 目录的设计稿 JPG 得到透明底 PNG
#
# 用途：演示站 index.html 是单文件零依赖页，图片一律以 base64 内嵌；本脚本把设计给的
# 「文字版」标志（白底 JPG）处理为**透明底 PNG**，并额外产出「深色底变体」（文字改为浅色，
# 红色标志笔画保持原色）——这是品牌标志在深色背景上的标准做法，浅色版则原样保留设计稿颜色。
#
# 输出（默认 assets/web/）：
#   lockup.png       竖排版（LOGO/法元LOGO(文字版）.jpg）·原色文字 → 浅色主题用
#   lockup-inv.png   竖排版·浅色文字（红色标志笔画保持原色）→ 深色主题用
#   lockup-base64.json 上述两张的 base64（供 index.html 内嵌）
#
# 用法（仓库根执行）：
#   powershell -ExecutionPolicy Bypass -File scripts/make-site-logo.ps1
#   可选：-SrcDir LOGO -OutDir assets/web -MaxWidthS 420 -LightText "#F2EEEE"
#
# 本文件须保存为 UTF-8 with BOM（否则 Windows PowerShell 5.1 按 ANSI 读中文注释会报解析错误）。
[CmdletBinding()]
param(
  [string]$SrcDir = "LOGO",
  [string]$OutDir = "assets/web",
  [int]$MaxWidthH = 560,
  [int]$MaxWidthS = 420,
  [string]$LightText = "#F2EEEE",
  [string]$Horizontal = "法元LOGO(文字版2）.jpg",
  [string]$Stacked = "法元LOGO(文字版）.jpg"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function New-TransparentLogo {
  param(
    [string]$Path,
    [int]$MaxWidth,
    [System.Drawing.Color]$TextColor,   # 文字笔画颜色（原色变体传设计稿原色，深底变体传浅色）
    [bool]$KeepTextColor                # true = 保留设计稿文字原色
  )
  $src = [System.Drawing.Bitmap]::new((Resolve-Path $Path).Path)

  # ---- 1. 找内容外接框（白底上非白像素）----
  $minX = $src.Width; $maxX = 0; $minY = $src.Height; $maxY = 0
  for ($y = 0; $y -lt $src.Height; $y++) {
    for ($x = 0; $x -lt $src.Width; $x++) {
      $p = $src.GetPixel($x, $y)
      if ((255 - [Math]::Min($p.R, [Math]::Min($p.G, $p.B))) -gt 18) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $bw = $maxX - $minX + 1; $bh = $maxY - $minY + 1

  # ---- 2. 估计两种墨色：红族（标志笔画）与灰族（文字）----
  $redMin = 255; $grayMaxDev = 0; $grayInk = $null
  for ($y = $minY; $y -le $maxY; $y++) {
    for ($x = $minX; $x -le $maxX; $x++) {
      $p = $src.GetPixel($x, $y)
      $redness = $p.R - [Math]::Max($p.G, $p.B)
      if ($redness -gt 25) {
        $m = [Math]::Min($p.R, [Math]::Min($p.G, $p.B))
        if ($m -lt $redMin) { $redMin = $m; $redInk = $p }
      } else {
        $dev = 255 - [Math]::Max($p.R, [Math]::Max($p.G, $p.B))
        if ($dev -gt $grayMaxDev) { $grayMaxDev = $dev; $grayInk = $p }
      }
    }
  }
  if ($null -eq $redInk) { $redInk = [System.Drawing.Color]::FromArgb(234, 2, 2) }
  if ($null -eq $grayInk) { $grayInk = [System.Drawing.Color]::FromArgb(40, 40, 40) }
  $redInkMin = [Math]::Min($redInk.R, [Math]::Min($redInk.G, $redInk.B))
  $grayInkMax = [Math]::Max($grayInk.R, [Math]::Max($grayInk.G, $grayInk.B))

  # ---- 3. 逐像素白底键出 + 文字改色 ----
  $out = New-Object System.Drawing.Bitmap $bw, $bh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  for ($y = 0; $y -lt $bh; $y++) {
    for ($x = 0; $x -lt $bw; $x++) {
      $p = $src.GetPixel($minX + $x, $minY + $y)
      $redness = $p.R - [Math]::Max($p.G, $p.B)
      if ($redness -gt 25) {
        $den = 255 - $redInkMin
        $a = if ($den -le 0) { 1.0 } else { (255 - [Math]::Min($p.R, [Math]::Min($p.G, $p.B))) / [double]$den }
        $col = $redInk
      } else {
        $den = 255 - $grayInkMax
        $a = if ($den -le 0) { 1.0 } else { (255 - [Math]::Max($p.R, [Math]::Max($p.G, $p.B))) / [double]$den }
        $col = if ($KeepTextColor) { $grayInk } else { $TextColor }
      }
      if ($a -lt 0.004) { $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0)); continue }
      if ($a -gt 1) { $a = 1 }
      $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb([int][Math]::Round($a * 255), $col.R, $col.G, $col.B))
    }
  }

  # ---- 4. 等比缩放到目标宽度 ----
  if ($bw -gt $MaxWidth) {
    $scale = $MaxWidth / [double]$bw
    $tw = $MaxWidth; $th = [int][Math]::Round($bh * $scale)
    $rs = New-Object System.Drawing.Bitmap $tw, $th, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($rs)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($out, 0, 0, $tw, $th)
    $g.Dispose(); $out.Dispose()
    $out = $rs
  }
  $src.Dispose()
  return @{ bmp = $out; redInk = "$($redInk.R),$($redInk.G),$($redInk.B)"; grayInk = "$($grayInk.R),$($grayInk.G),$($grayInk.B)" }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$lightCol = [System.Drawing.ColorTranslator]::FromHtml($LightText)

Write-Host "源目录：$SrcDir"
foreach ($job in @(
  @{ src = $Stacked; maxw = $MaxWidthS; name = "lockup.png"; inv = $false },
  @{ src = $Stacked; maxw = $MaxWidthS; name = "lockup-inv.png"; inv = $true }
)) {
  $p = Join-Path $SrcDir $job.src
  if (-not (Test-Path $p)) { Write-Warning "缺失源文件：$p"; continue }
  $r = New-TransparentLogo -Path $p -MaxWidth $job.maxw -TextColor $lightCol -KeepTextColor (-not $job.inv)
  $target = Join-Path (Join-Path (Get-Location) $OutDir) $job.name
  $r.bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host ("  写出 {0}/{1}  {2}x{3}  {4}KB  红墨={5} 灰墨={6} {7}" -f $OutDir, $job.name, $r.bmp.Width, $r.bmp.Height,
    [math]::Round((Get-Item $target).Length / 1KB, 1), $r.redInk, $r.grayInk, $(if ($job.inv) { "(文字已改浅色)" } else { "(原色)" }))
  $r.bmp.Dispose()
}

# 供 index.html 内嵌的 base64
$b64 = @{}
foreach ($n in @("lockup.png", "lockup-inv.png")) {
  $f = Join-Path (Join-Path (Get-Location) $OutDir) $n
  if (Test-Path $f) { $b64[$n] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f)) }
}
$b64 | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 (Join-Path (Join-Path (Get-Location) $OutDir) "lockup-base64.json")
Write-Host "  写出 $OutDir/lockup-base64.json"
Write-Host "完成。"
