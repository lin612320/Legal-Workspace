# 由品牌 Logo 生成应用图标（可复跑）
#
# 标志有两个版本，按尺寸各自取用（单个 .ico 内混装多尺寸，Windows 标准做法）：
#   大尺寸（> SmallIconMax）：LOGO/法元LOGO(文字版）.jpg  「文字版（竖排）」设计稿——
#                             红色渐变图形标在上、黑色「法元」字标在下，1024x1024 白底
#   小尺寸（<= SmallIconMax）：LOGO/法元LOGO（图标）.jpg  方形图形标（无字标）——
#                             文字版在 32px 下「法元」仅约 5px 高、糊成一团，故小尺寸只放图形标
#
# 本脚本把它们规整为"圆角白色方块 + 居中标志"的图标，并输出：
#   src-tauri/icons/{32x32,64x64,128x128,128x128@2x,icon}.png   桌面端打包图标
#   src-tauri/icons/icon.ico                                     Windows exe / 安装包图标（多尺寸混装）
#   assets/web/{logo-240,logo-64}.png                            演示站用的内嵌图（转 base64）
#   floating-ball/assets/icon.png                                悬浮球（Electron）自身图标
#
# 为什么要"圆角白底"：标志本身是红色渐变，深色背景（夜间主题 / 深色任务栏）上直接透明放置
# 会损失对比度；保留白底并做圆角，与旧版「渐变圆角 + 字标」的图标语言一致。
#
# 用法（仓库根执行）：
#   powershell -ExecutionPolicy Bypass -File scripts/make-icons.ps1
#   只重打主程序（Tauri）图标、不动演示站与悬浮球：
#   powershell -ExecutionPolicy Bypass -File scripts/make-icons.ps1 -SkipWeb -SkipBall
#   可选：-Logo <路径> -MarkLogo <路径> -SmallIconMax 48 -PaddingRatio 0.10 -RadiusRatio 0.18
[CmdletBinding()]
param(
  [string]$Logo = "LOGO/法元LOGO(文字版）.jpg",       # 大尺寸：竖排文字版
  [string]$MarkLogo = "LOGO/法元LOGO（图标）.jpg",     # 小尺寸：方形图形标
  [int]$SmallIconMax = 48,                            # 边长 <= 该值改用图形标
  [string]$IconsDir = "src-tauri/icons",
  [string]$WebDir = "assets/web",
  [double]$PaddingRatio = 0.12,
  [double]$RadiusRatio = 0.18,
  [switch]$SkipWeb,   # 跳过演示站内嵌图（assets/web）与 base64.json
  [switch]$SkipBall   # 跳过悬浮球自身图标（floating-ball/assets/icon.png）
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function New-RoundedPath([int]$size, [double]$radiusRatio) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [double]($size * $radiusRatio * 2)   # 圆角直径（像素）
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($size - $d, 0, $d, $d, 270, 90)
  $p.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $p.AddArc(0, $size - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# ---- 1. 读源图并裁到标志外接框（去掉四周留白） ----
function New-CroppedLogo([string]$path) {
  $src = [System.Drawing.Bitmap]::new((Resolve-Path $path).Path)
  $minX = $src.Width; $maxX = 0; $minY = $src.Height; $maxY = 0
  for ($y = 0; $y -lt $src.Height; $y++) {
    for ($x = 0; $x -lt $src.Width; $x++) {
      $p = $src.GetPixel($x, $y)
      if (-not ($p.R -gt 225 -and $p.G -gt 225 -and $p.B -gt 220)) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $bw = $maxX - $minX + 1; $bh = $maxY - $minY + 1
  Write-Host "  $path`n    外接框: $bw x $bh @ ($minX,$minY)  源图 $($src.Width)x$($src.Height)"
  $crop = New-Object System.Drawing.Bitmap $bw, $bh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($crop)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $bw, $bh), (New-Object System.Drawing.Rectangle $minX, $minY, $bw, $bh), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose(); $src.Dispose()
  return @{ bmp = $crop; w = $bw; h = $bh }
}

if (-not (Test-Path $MarkLogo)) { throw "找不到小尺寸图形标：$MarkLogo" }
$lockup   = New-CroppedLogo $Logo       # 大尺寸用：竖排文字版
$markOnly = New-CroppedLogo $MarkLogo   # 小尺寸用：方形图形标

# ---- 2. 圆角白底 + 居中标志，输出任意尺寸 ----
# 尺寸决定取哪一版标志：<= $SmallIconMax 用图形标，否则用竖排文字版
function New-Icon([int]$size) {
  $rs = if ($size -le $SmallIconMax) { $markOnly } else { $lockup }
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gr = [System.Drawing.Graphics]::FromImage($bmp)
  $gr.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $gr.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gr.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $path = New-RoundedPath $size $RadiusRatio
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $gr.FillPath($brush, $path)
  $inner = [int]($size * (1 - 2 * $PaddingRatio))
  $scale = [Math]::Min($inner / $rs.w, $inner / $rs.h)
  $dw = [int]($rs.w * $scale); $dh = [int]($rs.h * $scale)
  $dx = [int](($size - $dw) / 2); $dy = [int](($size - $dh) / 2)
  $ia = New-Object System.Drawing.Imaging.ImageAttributes
  $ia.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
  $dest = New-Object System.Drawing.Rectangle $dx, $dy, $dw, $dh
  $gr.DrawImage($rs.bmp, $dest, 0, 0, $rs.w, $rs.h, [System.Drawing.GraphicsUnit]::Pixel, $ia)
  $gr.Dispose(); $brush.Dispose(); $path.Dispose(); $ia.Dispose()
  return $bmp
}
function Get-IconSource([int]$size) { if ($size -le $SmallIconMax) { "图形标" } else { "竖排文字版" } }

New-Item -ItemType Directory -Force -Path $IconsDir | Out-Null
if (-not $SkipWeb) { New-Item -ItemType Directory -Force -Path $WebDir | Out-Null }

$targets = @(
  @{ n = "32x32.png"; s = 32 }, @{ n = "64x64.png"; s = 64 }, @{ n = "128x128.png"; s = 128 },
  @{ n = "128x128@2x.png"; s = 256 }, @{ n = "icon.png"; s = 512 }
)
foreach ($t in $targets) {
  $b = New-Icon $t.s
  $out = Join-Path $IconsDir $t.n
  $b.Save((Join-Path (Get-Location) $out), [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
  Write-Host "  写出 $out ($($t.s)x$($t.s)，$(Get-IconSource $t.s))"
}

if (-not $SkipWeb) {
  foreach ($t in @(@{ n = "logo-240.png"; s = 240 }, @{ n = "logo-64.png"; s = 64 })) {
    $b = New-Icon $t.s
    $b.Save((Join-Path (Get-Location) (Join-Path $WebDir $t.n)), [System.Drawing.Imaging.ImageFormat]::Png)
    $b.Dispose()
    Write-Host "  写出 $WebDir/$($t.n) ($($t.s)x$($t.s)，$(Get-IconSource $t.s))"
  }
} else { Write-Host "  跳过演示站内嵌图（-SkipWeb）" }

# 悬浮球（Electron）自身的应用图标源：换新后需在 floating-ball 下 `npm run dist` 重打便携版才随包生效
$ballIcon = "floating-ball/assets/icon.png"
if ($SkipBall) {
  Write-Host "  跳过悬浮球图标（-SkipBall）"
} elseif (Test-Path (Split-Path $ballIcon -Parent)) {
  $b = New-Icon 512
  $b.Save((Join-Path (Get-Location) $ballIcon), [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
  Write-Host "  写出 $ballIcon (512x512) —— 需重打悬浮球后才随包生效"
}

# ---- 3. 多尺寸 ICO（PNG 压缩条目，Vista+ 支持） ----
$icoSizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = @()
foreach ($s in $icoSizes) {
  $b = New-Icon $s
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , @{ size = $s; bytes = $ms.ToArray() }
  $ms.Dispose(); $b.Dispose()
}
$icoPath = Join-Path (Get-Location) (Join-Path $IconsDir "icon.ico")
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($e in $pngs) {
  $dim = if ($e.size -ge 256) { 0 } else { $e.size }
  $bw.Write([Byte]$dim); $bw.Write([Byte]$dim)          # 宽 / 高（0 = 256）
  $bw.Write([Byte]0); $bw.Write([Byte]0)                # 调色板数 / 保留
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)           # 平面数 / 位深
  $bw.Write([UInt32]$e.bytes.Length); $bw.Write([UInt32]$offset)
  $offset += $e.bytes.Length
}
foreach ($e in $pngs) { $bw.Write($e.bytes) }
$bw.Flush(); $bw.Dispose(); $fs.Dispose()
Write-Host "  写出 $IconsDir/icon.ico（$($pngs.Count) 个尺寸: $($icoSizes -join '/')；<=$($SmallIconMax)px 用图形标，其余用竖排文字版，$((Get-Item $icoPath).Length) 字节）"

# ---- 4. 演示站内嵌用 base64（单文件站不引外链资源） ----
if (-not $SkipWeb) {
  $b64 = @{}
  foreach ($f in @("logo-240.png", "logo-64.png")) {
    $b64[$f] = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path (Get-Location) (Join-Path $WebDir $f))))
  }
  $b64 | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $WebDir "base64.json")
  Write-Host "  写出 $WebDir/base64.json（供演示站内嵌）"
} else { Write-Host "  跳过 base64.json（-SkipWeb）" }

$lockup.bmp.Dispose(); $markOnly.bmp.Dispose()
Write-Host "完成。"
