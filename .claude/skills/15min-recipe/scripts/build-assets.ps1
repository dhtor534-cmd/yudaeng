<#
.SYNOPSIS
  집 스타일 15분 레시피 마크다운 한 편에서 PDF와 PPTX를 만든다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File build-assets.ps1 -Md "week1\레시피북\15분-에그인헬.md"

.NOTES
  - PDF: Chrome 헤드리스 --print-to-pdf (한글 Malgun Gothic)
  - PPTX: OOXML을 직접 zip으로 조립 (python/office 불필요)
  출력: <레시피북>/pdf/<이름>.pdf , <레시피북>/ppt/<이름>.pptx
#>
param(
  [Parameter(Mandatory = $true)][string]$Md,
  [switch]$NoPdf,
  [switch]$NoPptx
)

$ErrorActionPreference = 'Stop'
$mdPath = (Resolve-Path $Md).Path
$dir    = Split-Path $mdPath -Parent
$base   = [IO.Path]::GetFileNameWithoutExtension($mdPath)
$lines  = [IO.File]::ReadAllLines($mdPath, [Text.UTF8Encoding]::new($false))

function Esc([string]$s) {
  ($s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;')
}

# ---------- parse ----------
$title = ''; $intro = ''
$meta = @{ time = ''; serves = ''; level = '' }
$ingredients = New-Object System.Collections.ArrayList
$steps = New-Object System.Collections.ArrayList
$tips = New-Object System.Collections.ArrayList
$section = ''

foreach ($raw in $lines) {
  $line = $raw.TrimEnd()
  if ($line -match '^#\s+(.*)') { $title = $Matches[1].Trim(); continue }
  if ($line -match '^##\s+(.*)') { $section = $Matches[1].Trim(); continue }
  if (-not $title) { continue }

  if (-not $section) {
    if ($line -match '^\-\s+\*\*조리 시간\*\*:\s*(.*)') { $meta.time = $Matches[1].Trim(); continue }
    if ($line -match '^\-\s+\*\*분량\*\*:\s*(.*)') { $meta.serves = $Matches[1].Trim(); continue }
    if ($line -match '^\-\s+\*\*난이도\*\*:\s*(.*)') { $meta.level = $Matches[1].Trim(); continue }
    if ($line -and -not $intro -and $line -notmatch '^\-') { $intro = $line.Trim(); continue }
  }
  elseif ($section -eq '재료') {
    if ($line -match '^\|(.+)\|(.+)\|\s*$') {
      $a = $Matches[1].Trim(); $b = $Matches[2].Trim()
      if ($a -eq '재료' -or $a -match '^-+$') { continue }
      [void]$ingredients.Add([pscustomobject]@{ name = $a; qty = $b })
    }
  }
  elseif ($section -eq '만드는 법') {
    if ($line -match '^\d+\.\s+\*\*(.+?)\*\*:\s*(.*)') {
      $head = $Matches[1].Trim(); $desc = $Matches[2].Trim()
      $t = ''
      if ($head -match '^(.*?)\s*\(([^)]*)\)\s*$') { $head = $Matches[1].Trim(); $t = $Matches[2].Trim() }
      [void]$steps.Add([pscustomobject]@{ head = $head; time = $t; desc = $desc })
    }
  }
  elseif ($section -eq '팁') {
    if ($line -match '^\-\s+(.*)') { [void]$tips.Add($Matches[1].Trim()) }
  }
}

if (-not $title) { throw "제목(# ...)을 찾지 못했습니다: $mdPath" }
Write-Host "  재료 $($ingredients.Count) · 단계 $($steps.Count) · 팁 $($tips.Count)"

# ---------- PDF ----------
if (-not $NoPdf) {
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $chrome) { throw "Chrome/Edge를 찾지 못해 PDF를 만들 수 없습니다." }

  $ingRows = ($ingredients | ForEach-Object { "<tr><td>$(Esc $_.name)</td><td class='q'>$(Esc $_.qty)</td></tr>" }) -join "`n"
  $stepRows = ($steps | ForEach-Object {
      $n = [array]::IndexOf($steps.ToArray(), $_) + 1
      $tt = if ($_.time) { "<span class='t'>$(Esc $_.time)</span>" } else { '' }
      "<li><div><b>$(Esc $_.head)</b> $tt<p>$(Esc $_.desc)</p></div></li>"
    }) -join "`n"
  $tipRows = ($tips | ForEach-Object { "<li>$(Esc $_)</li>" }) -join "`n"

  $html = @"
<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
body { font-family: "Malgun Gothic", sans-serif; color: #221E18; line-height: 1.7; font-size: 11pt; }
h1 { font-size: 21pt; margin: 0 0 4pt; }
.intro { color: #5b5348; margin: 0 0 12pt; }
.meta { display: flex; gap: 18pt; font-size: 9.5pt; color: #8a2412; border-top: 2px solid #221E18; border-bottom: 1px solid #ddd3c4; padding: 6pt 0; margin-bottom: 14pt; letter-spacing: .04em; }
h2 { font-size: 11pt; letter-spacing: .12em; color: #8a7568; margin: 16pt 0 6pt; text-transform: uppercase; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px dotted #cfc4b2; padding: 4pt 8pt; text-align: left; vertical-align: top; }
td.q { text-align: right; white-space: nowrap; color: #6b6459; }
ol { margin: 0; padding-left: 18pt; }
ol li { margin: 0 0 8pt; }
ol li p { margin: 2pt 0 0; color: #4a443b; }
.t { font-size: 8.5pt; color: #4A6B3A; border: 1px solid #cfc4b2; border-radius: 999px; padding: 0 6pt; margin-left: 4pt; }
ul.tips { margin: 0; padding-left: 16pt; }
ul.tips li { margin: 0 0 5pt; color: #4a443b; }
</style></head><body>
<h1>$(Esc $title)</h1>
<p class="intro">$(Esc $intro)</p>
<div class="meta"><span>조리 $(Esc $meta.time)</span><span>$(Esc $meta.serves)</span><span>난이도 $(Esc $meta.level)</span></div>
<h2>재료</h2>
<table>$ingRows</table>
<h2>만드는 법</h2>
<ol>$stepRows</ol>
<h2>팁</h2>
<ul class="tips">$tipRows</ul>
</body></html>
"@

  $tmp = Join-Path $env:TEMP "recipe-$([guid]::NewGuid().ToString('N')).html"
  [IO.File]::WriteAllText($tmp, $html, [Text.UTF8Encoding]::new($false))
  $pdfDir = Join-Path $dir 'pdf'
  New-Item -ItemType Directory -Force -Path $pdfDir | Out-Null
  $pdf = Join-Path $pdfDir "$base.pdf"
  if (Test-Path $pdf) { Remove-Item $pdf -Force }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $chrome --headless --disable-gpu --no-pdf-header-footer "--print-to-pdf=$pdf" "file:///$($tmp -replace '\\','/')" 2>&1 | Out-String | Out-Null
  $ErrorActionPreference = $prev
  Remove-Item $tmp -Force
  if (Test-Path $pdf) { Write-Host "  PDF  -> $pdf" } else { throw "PDF 생성 실패" }
}

# ---------- PPTX ----------
if (-not $NoPptx) {
  Add-Type -AssemblyName System.IO.Compression | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

  $A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

  function RunXml([string]$text, [int]$sz, [bool]$bold, [string]$color) {
    $b = if ($bold) { ' b="1"' } else { '' }
    "<a:r><a:rPr lang=`"ko-KR`" sz=`"$sz`"$b dirty=`"0`"><a:solidFill><a:srgbClr val=`"$color`"/></a:solidFill><a:latin typeface=`"Malgun Gothic`"/><a:ea typeface=`"Malgun Gothic`"/></a:rPr><a:t>$(Esc $text)</a:t></a:r>"
  }
  function Para([string]$runs, [string]$extra = '') { "<a:p>$extra$runs</a:p>" }

  # build slide bodies -----------------------------------------------------
  $slideBodies = New-Object System.Collections.ArrayList

  # 1) title
  $p = @()
  $p += Para (RunXml $title 4000 $true '221E18')
  $p += Para (RunXml $intro 1500 $false '5B5348')
  $p += Para (RunXml "$($meta.serves) · 난이도 $($meta.level) · 조리 $($meta.time)" 1400 $false 'C63A22')
  [void]$slideBodies.Add([pscustomobject]@{ kind = 'title'; eyebrow = '15분 레시피북'; heading = ''; paras = ($p -join '') })

  # 2) ingredients
  $p = @()
  foreach ($ing in $ingredients) {
    $p += Para ((RunXml $ing.name 1500 $false '221E18') + (RunXml "   —   $($ing.qty)" 1400 $false '6B6459')) '<a:pPr><a:buChar char="•"/></a:pPr>'
  }
  [void]$slideBodies.Add([pscustomobject]@{ kind = 'body'; eyebrow = '재료'; heading = "재료 · $($meta.serves)"; paras = ($p -join '') })

  # 3+) steps, 4 per slide
  $chunk = 4
  for ($i = 0; $i -lt $steps.Count; $i += $chunk) {
    $slice = $steps[$i..([Math]::Min($i + $chunk - 1, $steps.Count - 1))]
    $p = @()
    $n = $i
    foreach ($s in $slice) {
      $n++
      $tt = if ($s.time) { "  ($($s.time))" } else { '' }
      $p += Para ((RunXml "$n. " 1600 $true 'C63A22') + (RunXml $s.head 1600 $true '221E18') + (RunXml $tt 1200 $false '4A6B3A'))
      $p += Para (RunXml $s.desc 1300 $false '4A443B') '<a:pPr marL="342900" indent="0"/>'
      $p += Para (RunXml ' ' 600 $false '4A443B')
    }
    $label = if ($steps.Count -le $chunk) { '만드는 법' } else { "만드는 법 ($([int]([Math]::Floor($i / $chunk)) + 1))" }
    [void]$slideBodies.Add([pscustomobject]@{ kind = 'body'; eyebrow = '만드는 법'; heading = $label; paras = ($p -join '') })
  }

  # last) tips
  if ($tips.Count) {
    $p = @()
    foreach ($t in $tips) { $p += Para (RunXml $t 1400 $false '4A443B') '<a:pPr><a:buChar char="•"/></a:pPr>' }
    [void]$slideBodies.Add([pscustomobject]@{ kind = 'body'; eyebrow = '팁'; heading = '팁'; paras = ($p -join '') })
  }

  # slide xml ------------------------------------------------------------
  function SlideXml($item) {
    $shapes = ''
    # accent bar
    $shapes += '<p:sp><p:nvSpPr><p:cNvPr id="2" name="bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="640080" y="560070"/><a:ext cx="720000" cy="86400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="C63A22"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>'
    # eyebrow
    $shapes += '<p:sp><p:nvSpPr><p:cNvPr id="3" name="eyebrow"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="640080" y="700080"/><a:ext cx="10911840" cy="360000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1100" spc="240" dirty="0"><a:solidFill><a:srgbClr val="C63A22"/></a:solidFill><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/></a:rPr><a:t>' + (Esc $item.eyebrow) + '</a:t></a:r></a:p></p:txBody></p:sp>'

    if ($item.kind -eq 'title') {
      $shapes += '<p:sp><p:nvSpPr><p:cNvPr id="4" name="content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="640080" y="1900000"/><a:ext cx="10911840" cy="3600000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>' + $item.paras + '</p:txBody></p:sp>'
    }
    else {
      $shapes += '<p:sp><p:nvSpPr><p:cNvPr id="4" name="heading"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="640080" y="1060080"/><a:ext cx="10911840" cy="760000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="3200" b="1" dirty="0"><a:solidFill><a:srgbClr val="221E18"/></a:solidFill><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/></a:rPr><a:t>' + (Esc $item.heading) + '</a:t></a:r></a:p></p:txBody></p:sp>'
      $shapes += '<p:sp><p:nvSpPr><p:cNvPr id="5" name="content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="640080" y="1960000"/><a:ext cx="10911840" cy="4500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>' + $item.paras + '</p:txBody></p:sp>'
    }

    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="' + $A + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    $shapes +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  }

  $N = $slideBodies.Count
  $parts = [ordered]@{}

  $parts['[Content_Types].xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
  '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>' +
  '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
  '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
  '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
  ((1..$N | ForEach-Object { "<Override PartName=`"/ppt/slides/slide$_.xml`" ContentType=`"application/vnd.openxmlformats-officedocument.presentationml.slide+xml`"/>" }) -join '') +
  '</Types>'

  $parts['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
  '</Relationships>'

  $sldIds = (1..$N | ForEach-Object { "<p:sldId id=`"$(255 + $_)`" r:id=`"rId$($_ + 1)`"/>" }) -join ''
  $parts['ppt/presentation.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:presentation xmlns:a="' + $A + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
  "<p:sldIdLst>$sldIds</p:sldIdLst>" +
  '<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/>' +
  '</p:presentation>'

  $presRels = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
  for ($k = 1; $k -le $N; $k++) { $presRels += "<Relationship Id=`"rId$($k + 1)`" Type=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide`" Target=`"slides/slide$k.xml`"/>" }
  $presRels += "<Relationship Id=`"rId$($N + 2)`" Type=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps`" Target=`"presProps.xml`"/>"
  $parts['ppt/_rels/presentation.xml.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + $presRels + '</Relationships>'

  $parts['ppt/presProps.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:a="' + $A + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'

  $parts['ppt/theme/theme1.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<a:theme xmlns:a="' + $A + '" name="RecipeBook">' +
  '<a:themeElements><a:clrScheme name="RecipeBook">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="221E18"/></a:dk2><a:lt2><a:srgbClr val="FBF3EC"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="C63A22"/></a:accent1><a:accent2><a:srgbClr val="E8991F"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="4A6B3A"/></a:accent3><a:accent4><a:srgbClr val="8A7568"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme>' +
  '<a:fontScheme name="RecipeBook"><a:majorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="RecipeBook">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements></a:theme>'

  $parts['ppt/slideMasters/slideMaster1.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sldMaster xmlns:a="' + $A + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FBF3EC"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  '</p:spTree></p:cSld>' +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000"><a:solidFill><a:srgbClr val="221E18"/></a:solidFill><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr algn="l"><a:defRPr sz="1600"><a:solidFill><a:srgbClr val="221E18"/></a:solidFill><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/></a:defRPr></a:lvl1pPr></p:bodyStyle>' +
  '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1600"><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles>' +
  '</p:sldMaster>'

  $parts['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
  '</Relationships>'

  $parts['ppt/slideLayouts/slideLayout1.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sldLayout xmlns:a="' + $A + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">' +
  '<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'

  $parts['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
  '</Relationships>'

  for ($k = 1; $k -le $N; $k++) {
    $parts["ppt/slides/slide$k.xml"] = SlideXml $slideBodies[$k - 1]
    $parts["ppt/slides/_rels/slide$k.xml.rels"] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '</Relationships>'
  }

  $pptDir = Join-Path $dir 'ppt'
  New-Item -ItemType Directory -Force -Path $pptDir | Out-Null
  $pptx = Join-Path $pptDir "$base.pptx"
  if (Test-Path $pptx) { Remove-Item $pptx -Force }

  $enc = [Text.UTF8Encoding]::new($false)
  $fs = [IO.File]::Open($pptx, [IO.FileMode]::Create)
  $zip = [System.IO.Compression.ZipArchive]::new($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($name in $parts.Keys) {
      $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
      $es = $entry.Open()
      $bytes = $enc.GetBytes([string]$parts[$name])
      $es.Write($bytes, 0, $bytes.Length)
      $es.Dispose()
    }
  }
  finally { $zip.Dispose(); $fs.Dispose() }
  Write-Host "  PPTX -> $pptx  ($N 슬라이드)"
}
