param (
  [string]$SvgFile = ".\icon.svg",
  [string]$OutputDir = ".",
  [string]$SizesString = "16,32,48,128"
)

$ErrorActionPreference = "Stop"

# Resolve absolute paths
if (-not (Test-Path $SvgFile)) {
  $SvgFile = Join-Path $PSScriptRoot "icon.svg"
}
if (-not (Test-Path $SvgFile)) {
  Write-Error "SVG file not found: $SvgFile"
  exit 1
}

$OutputDir = Resolve-Path $OutputDir
$MasterPng = Join-Path $OutputDir "icon1024.png"

Write-Host "Converting SVG to High-Res PNG..."
Write-Host "Source: $SvgFile"
Write-Host "Dest:   $MasterPng"

# Execute npx svgexport to create the master PNG
& npx -y svgexport "$SvgFile" "$MasterPng" "1024:1024"

if ($LASTEXITCODE -ne 0) {
  Write-Error "Failed to convert SVG to PNG. Ensure npx and svgexport are available."
  exit $LASTEXITCODE
}

Add-Type -AssemblyName System.Drawing

$Sizes = $SizesString -split "," | ForEach-Object { [int]$_.Trim() }
Write-Host "Processing sizes: $($Sizes -join ', ')"

$srcImage = [System.Drawing.Bitmap]::FromFile($MasterPng)

foreach ($size in $Sizes) {
  try {
    Write-Host "Resizing to $size x $size ..."
    $outFile = Join-Path $OutputDir "icon$size.png"
        
    $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $destImage = New-Object System.Drawing.Bitmap $size, $size
        
    $destImage.SetResolution($srcImage.HorizontalResolution, $srcImage.VerticalResolution)
        
    $graphics = [System.Drawing.Graphics]::FromImage($destImage)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        
    $graphics.DrawImage($srcImage, $rect, 0, 0, $srcImage.Width, $srcImage.Height, [System.Drawing.GraphicsUnit]::Pixel)
        
    $destImage.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
        
    $graphics.Dispose()
    $destImage.Dispose()
        
    Write-Host "Generated $outFile"
  }
  catch {
    Write-Error "Failed to generate icon$size.png : $_"
  }
}

$srcImage.Dispose()
Write-Host "Done."
