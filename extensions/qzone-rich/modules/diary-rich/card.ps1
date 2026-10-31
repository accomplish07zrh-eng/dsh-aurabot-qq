$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
$card = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$palettes = @(@('#EDF4FA','#3978A2'),@('#F6F0E8','#AB7C56'),@('#F1EEF8','#826AA9'))
$palette = $palettes[[int]$card.theme]
$bitmap = New-Object System.Drawing.Bitmap(1080,1080)
$g = [Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'
$ink = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#28364A'))
$muted = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#7D899A'))
$accent = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml($palette[1]))
$white = New-Object Drawing.SolidBrush([Drawing.Color]::White)
$title = New-Object Drawing.Font('Microsoft YaHei',44,[Drawing.FontStyle]::Bold,[Drawing.GraphicsUnit]::Pixel)
$body = New-Object Drawing.Font('Microsoft YaHei',36,[Drawing.FontStyle]::Regular,[Drawing.GraphicsUnit]::Pixel)
$small = New-Object Drawing.Font('Microsoft YaHei',25,[Drawing.FontStyle]::Regular,[Drawing.GraphicsUnit]::Pixel)
$format = New-Object Drawing.StringFormat
try {
  $g.Clear([Drawing.ColorTranslator]::FromHtml($palette[0]))
  $g.FillRectangle($white,55,55,970,970)
  $g.FillRectangle($accent,100,110,8,42)
  $g.DrawString('大肥鱼的日常', $title,$ink,130,100)
  $g.DrawString('一页小小的心情手记', $small,$muted,100,188)
  if($g.MeasureString([string]$card.text,$body,880).Height -gt 590){ throw '文字超出手记卡尺寸' }
  $g.DrawString([string]$card.text,$body,$ink,[Drawing.RectangleF]::new(100,285,880,590),$format)
  $g.FillRectangle($accent,100,925,55,3)
  $g.DrawString([string]$card.date,$small,$muted,100,955)
  $g.DrawString('心情与生活碎片',$small,$muted,745,955)
  $bitmap.Save([string]$card.file,[Drawing.Imaging.ImageFormat]::Png)
} finally {
  $format.Dispose();$title.Dispose();$body.Dispose();$small.Dispose();$ink.Dispose();$muted.Dispose();$accent.Dispose();$white.Dispose();$g.Dispose();$bitmap.Dispose()
}
