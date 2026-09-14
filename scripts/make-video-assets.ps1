# 演示视频静态素材生成（片头帧 / 落版 / 角标），由品牌标志 logo.jpg 确定性生成
#
# 用途：docs/13-演示视频分镜脚本.md 的 S0/S6 镜头需要「品牌帧」——本脚本用真实标志生成
# 1920×1080 片头与落版、透明角标、竖版片头（30 秒竖版切片用），不依赖任何生成式模型，
# 保证画面里的标志与产品图标、官网、安装包完全一致（等比缩放、不改色、不变形）。
#
# 用法（仓库根执行）：
#   powershell -ExecutionPolicy Bypass -File scripts/make-video-assets.ps1
#   可选：-Logo <路径> -OutDir assets/video -Version "赛事版 0.7.3"
#
# 注意：本文件须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 ANSI 读中文注释而报解析错误。
[CmdletBinding()]
param(
  [string]$Logo = "logo.jpg",
  [string]$OutDir = "assets/video",
  [string]$Version = "赛事版 0.7.3",
  [string]$BrandCn = "法元 · Faron",
  [string]$Tagline = "本地优先的 AI 法律工作台",
  [string]$Principles = "红色 · 中国品牌　渐变 · 智能科技　平行四边形 · 高效利落"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

# ---------- 调色板（与演示站设计令牌一致）----------
$DARK_BG   = [System.Drawing.ColorTranslator]::FromHtml("#070A14")
$DARK_BG2  = [System.Drawing.ColorTranslator]::FromHtml("#0A0F1E")
$LIGHT_BG  = [System.Drawing.ColorTranslator]::FromHtml("#F5F6FA")
$TEXT_D    = [System.Drawing.ColorTranslator]::FromHtml("#E9EEF8")
$TEXT_D2   = [System.Drawing.ColorTranslator]::FromHtml("#AAB6CC")
$TEXT_L    = [System.Drawing.ColorTranslator]::FromHtml("#0F1729")
$TEXT_L2   = [System.Drawing.ColorTranslator]::FromHtml("#4A5568")
$GOLD      = [System.Drawing.ColorTranslator]::FromHtml("#EFD9A3")
$BRAND_RED = [System.Drawing.ColorTranslator]::FromHtml("#EA0202")
$BRAND_RED_D = [System.Drawing.ColorTranslator]::FromHtml("#8C1012")

function New-RoundedPath([int]$w, [int]$h, [int]$radius) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  if ($d -gt $w) { $d = $w }; if ($d -gt $h) { $d = $h }
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($w - $d, 0, $d, $d, 270, 90)
  $p.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
  $p.AddArc(0, $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-SoftGlow([int]$w, [int]$h, [System.Drawing.Color]$color, [int]$alpha) {
  # 用路径渐变模拟柔和光晕（无需模糊滤镜）
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse(0, 0, $w, $h)
  $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
  $brush.CenterColor = [System.Drawing.Color]::FromArgb($alpha, $color)
  $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $color))
  $g.FillPath($brush, $path)
  $g.Dispose(); $brush.Dispose(); $path.Dispose()
  return $bmp
}

# ---------- 读标志并裁到外接框 ----------
$src = [System.Drawing.Bitmap]::new((Resolve-Path $Logo).Path)
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
$boxW = $maxX - $minX + 1; $boxH = $maxY - $minY + 1
$mark = New-Object System.Drawing.Bitmap $boxW, $boxH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$mg = [System.Drawing.Graphics]::FromImage($mark)
$mg.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $boxW, $boxH), (New-Object System.Drawing.Rectangle $minX, $minY, $boxW, $boxH), [System.Drawing.GraphicsUnit]::Pixel)
$mg.Dispose()
Write-Host "标志外接框: $boxW x $boxH @ ($minX,$minY)"

function Draw-LogoTile([System.Drawing.Graphics]$g, [int]$x, [int]$y, [int]$size) {
  # 白色圆角方块 + 居中标志（与桌面应用图标同形态：圆角 18% / 内边距 12%）
  $radius = [int]($size * 0.18)
  $state = $g.Save()
  $g.TranslateTransform($x, $y)
  $shadowPath = New-RoundedPath $size $size $radius
  $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 0, 0, 0))
  $g.TranslateTransform(0, 6)
  $g.FillPath($shadow, $shadowPath)
  $g.TranslateTransform(0, -6)
  $tilePath = New-RoundedPath $size $size $radius
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $g.FillPath($white, $tilePath)
  $inner = [int]($size * 0.76)
  $scale = [Math]::Min($inner / $boxW, $inner / $boxH)
  $dw = [int]($boxW * $scale); $dh = [int]($boxH * $scale)
  $dx = [int](($size - $dw) / 2); $dy = [int](($size - $dh) / 2)
  $g.DrawImage($mark, (New-Object System.Drawing.Rectangle $dx, $dy, $dw, $dh), 0, 0, $boxW, $boxH, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Restore($state)
  $shadow.Dispose(); $white.Dispose(); $shadowPath.Dispose(); $tilePath.Dispose()
}

function New-Canvas([int]$w, [int]$h, [bool]$dark) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $bg = New-Object System.Drawing.SolidBrush ($(if ($dark) { $DARK_BG } else { $LIGHT_BG }))
  $g.FillRectangle($bg, 0, 0, $w, $h)
  $bg.Dispose()
  if ($dark) {
    $glow1 = New-SoftGlow ([int]($w * 0.7)) ([int]($h * 0.9)) $BRAND_RED 34
    $g.DrawImage($glow1, [int]($w * -0.05), [int]($h * -0.25))
    $glow1.Dispose()
    $glow2 = New-SoftGlow ([int]($w * 0.55)) ([int]($h * 0.8)) ([System.Drawing.ColorTranslator]::FromHtml("#D8B26A")) 26
    $g.DrawImage($glow2, [int]($w * 0.55), [int]($h * 0.3))
    $glow2.Dispose()
  } else {
    $glow = New-SoftGlow ([int]($w * 0.6)) ([int]($h * 0.8)) $BRAND_RED 16
    $g.DrawImage($glow, [int]($w * -0.02), [int]($h * -0.2))
    $glow.Dispose()
  }
  return @{ bmp = $bmp; g = $g }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$out = (Join-Path (Get-Location) $OutDir)

# ================= 1. 片头帧（1920×1080，深色 / 浅色两版）=================
foreach ($variant in @(@{ name = "intro-dark.png"; dark = $true }, @{ name = "intro-light.png"; dark = $false })) {
  $dark = $variant.dark
  $c = New-Canvas 1920 1080 $dark
  $g = $c.g
  $tile = 400
  $tx = 300; $ty = [int]((1080 - $tile) / 2)
  Draw-LogoTile $g $tx $ty $tile
  $fTitle = New-Object System.Drawing.Font "Microsoft YaHei", 92, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fSub = New-Object System.Drawing.Font "Microsoft YaHei", 38, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $fPrin = New-Object System.Drawing.Font "Microsoft YaHei", 30, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $bTitle = New-Object System.Drawing.SolidBrush ($(if ($dark) { $TEXT_D } else { $TEXT_L }))
  $bSub = New-Object System.Drawing.SolidBrush ($(if ($dark) { $TEXT_D2 } else { $TEXT_L2 }))
  $bPrin = New-Object System.Drawing.SolidBrush ($(if ($dark) { $GOLD } else { $BRAND_RED_D }))
  $x = $tx + $tile + 96
  $g.DrawString($BrandCn, $fTitle, $bTitle, $x, 396)
  $g.DrawString($Tagline, $fSub, $bSub, ($x + 6), 516)
  $line = New-Object System.Drawing.Pen ($(if ($dark) { [System.Drawing.Color]::FromArgb(70, 239, 217, 163) } else { [System.Drawing.Color]::FromArgb(90, 234, 2, 2) })), 2
  $g.DrawLine($line, $x + 6, 590, $x + 6 + 620, 590)
  $g.DrawString($Principles, $fPrin, $bPrin, ($x + 6), 620)
  $g.Dispose()
  $target = Join-Path $out $variant.name
  $c.bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $c.bmp.Dispose()
  $fTitle.Dispose(); $fSub.Dispose(); $fPrin.Dispose(); $bTitle.Dispose(); $bSub.Dispose(); $bPrin.Dispose(); $line.Dispose()
  Write-Host "  写出 $OutDir/$($variant.name) (1920x1080)"
}

# ================= 2. 落版（1920×1080，深色）=================
$c = New-Canvas 1920 1080 $true
$g = $c.g
$tile = 260
$tx = [int]((1920 - $tile) / 2); $ty = 300
Draw-LogoTile $g $tx $ty $tile
$fTitle = New-Object System.Drawing.Font "Microsoft YaHei", 76, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$fSub = New-Object System.Drawing.Font "Microsoft YaHei", 34, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fLine = New-Object System.Drawing.Font "Microsoft YaHei", 30, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$bTitle = New-Object System.Drawing.SolidBrush $TEXT_D
$bSub = New-Object System.Drawing.SolidBrush $TEXT_D2
$bGold = New-Object System.Drawing.SolidBrush $GOLD
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString($BrandCn, $fTitle, $bTitle, (New-Object System.Drawing.RectangleF 0, 610, 1920, 110), $fmt)
$g.DrawString($Tagline, $fSub, $bSub, (New-Object System.Drawing.RectangleF 0, 726, 1920, 60), $fmt)
$g.DrawString("$Version　·　数据不出本机　·　引用可反查", $fLine, $bGold, (New-Object System.Drawing.RectangleF 0, 806, 1920, 60), $fmt)
$g.Dispose()
$c.bmp.Save((Join-Path $out "end-card.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$c.bmp.Dispose()
$fTitle.Dispose(); $fSub.Dispose(); $fLine.Dispose(); $bTitle.Dispose(); $bSub.Dispose(); $bGold.Dispose(); $fmt.Dispose()
Write-Host "  写出 $OutDir/end-card.png (1920x1080)"

# ================= 3. 竖版片头（1080×1920，30 秒切片用）=================
$c = New-Canvas 1080 1920 $true
$g = $c.g
$tile = 380
$tx = [int]((1080 - $tile) / 2); $ty = 560
Draw-LogoTile $g $tx $ty $tile
$fTitle = New-Object System.Drawing.Font "Microsoft YaHei", 82, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$fSub = New-Object System.Drawing.Font "Microsoft YaHei", 36, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fPrin = New-Object System.Drawing.Font "Microsoft YaHei", 28, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$bTitle = New-Object System.Drawing.SolidBrush $TEXT_D
$bSub = New-Object System.Drawing.SolidBrush $TEXT_D2
$bGold = New-Object System.Drawing.SolidBrush $GOLD
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString($BrandCn, $fTitle, $bTitle, (New-Object System.Drawing.RectangleF 0, 1020, 1080, 110), $fmt)
$g.DrawString($Tagline, $fSub, $bSub, (New-Object System.Drawing.RectangleF 0, 1140, 1080, 60), $fmt)
$g.DrawString("红色 · 中国品牌", $fPrin, $bGold, (New-Object System.Drawing.RectangleF 0, 1250, 1080, 50), $fmt)
$g.DrawString("渐变 · 智能科技", $fPrin, $bGold, (New-Object System.Drawing.RectangleF 0, 1308, 1080, 50), $fmt)
$g.DrawString("平行四边形 · 高效利落", $fPrin, $bGold, (New-Object System.Drawing.RectangleF 0, 1366, 1080, 50), $fmt)
$g.Dispose()
$c.bmp.Save((Join-Path $out "intro-vertical.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$c.bmp.Dispose()
$fTitle.Dispose(); $fSub.Dispose(); $fPrin.Dispose(); $bTitle.Dispose(); $bSub.Dispose(); $bGold.Dispose(); $fmt.Dispose()
Write-Host "  写出 $OutDir/intro-vertical.png (1080x1920)"

# ================= 4. 角标（透明背景，叠在画面右下角）=================
# 方形标：白色圆角方块 + 标志
$s = 160
$badge = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bg = [System.Drawing.Graphics]::FromImage($badge)
$bg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$bg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$radius = [int]($s * 0.18)
$path = New-RoundedPath $s $s $radius
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
$bg.FillPath($white, $path)
$inner = [int]($s * 0.76)
$scale = [Math]::Min($inner / $boxW, $inner / $boxH)
$dw = [int]($boxW * $scale); $dh = [int]($boxH * $scale)
$bg.DrawImage($mark, (New-Object System.Drawing.Rectangle ([int](($s - $dw) / 2)), ([int](($s - $dh) / 2)), $dw, $dh), 0, 0, $boxW, $boxH, [System.Drawing.GraphicsUnit]::Pixel)
$bg.Dispose(); $white.Dispose(); $path.Dispose()
$badge.Save((Join-Path $out "corner-badge.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$badge.Dispose()
Write-Host "  写出 $OutDir/corner-badge.png (${s}x${s} 透明)"

# 横版角标：半透明深色胶囊 + 白色圆角标志 + 品牌名
$bw = 520; $bh = 132
$wide = New-Object System.Drawing.Bitmap $bw, $bh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$wg = [System.Drawing.Graphics]::FromImage($wide)
$wg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$wg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$wg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$pill = New-RoundedPath $bw $bh 28
$pillBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 10, 15, 30))
$wg.FillPath($pillBrush, $pill)
$ts = 92
$tpath = New-RoundedPath $ts $ts ([int]($ts * 0.18))
$tb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240, 255, 255, 255))
$wg.FillPath($tb, $tpath)
$iscale = [Math]::Min(($ts * 0.76) / $boxW, ($ts * 0.76) / $boxH)
$idw = [int]($boxW * $iscale); $idh = [int]($boxH * $iscale)
$ix = 20 + [int](($ts - $idw) / 2); $iy = [int](($bh - $idh) / 2)
$wg.DrawImage($mark, (New-Object System.Drawing.Rectangle $ix, $iy, $idw, $idh), 0, 0, $boxW, $boxH, [System.Drawing.GraphicsUnit]::Pixel)
$fWide = New-Object System.Drawing.Font "Microsoft YaHei", 40, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$bWide = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240, 233, 238, 248))
$wg.DrawString($BrandCn, $fWide, $bWide, 128, 44)
$wg.Dispose(); $pillBrush.Dispose(); $pill.Dispose(); $tb.Dispose(); $tpath.Dispose()
$wide.Save((Join-Path $out "corner-badge-wide.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$wide.Dispose()
Write-Host "  写出 $OutDir/corner-badge-wide.png (${bw}x${bh} 透明)"

$mark.Dispose(); $src.Dispose()
Write-Host "完成。素材目录：$OutDir"
