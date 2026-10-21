param(
  [Parameter(Mandatory = $true)][string]$RequestFile,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

$ErrorActionPreference = 'Stop'
$exitCode = 0
$stage = 'init'
$log = New-Object System.Collections.Generic.List[string]
$app = $null
$doc = $null
$startedHere = $false
$callStart = Get-Date
$ownedIds = @()
$placements = @()
$hadClipboard = $false
$previousClipboard = ''

function Write-Log([string]$message) {
  $log.Add(('{0:o} {1}' -f (Get-Date), $message))
}

function Save-Result($payload) {
  try {
    $json = $payload | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($ResultFile, $json, (New-Object Text.UTF8Encoding($false)))
  } catch {}
}

function Wait-File([string]$path, [int]$timeoutMs = 5000) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $path) {
      try {
        if ((Get-Item -LiteralPath $path -ErrorAction Stop).Length -gt 0) { return $true }
      } catch {}
    }
    Start-Sleep -Milliseconds 100
  }
  return $false
}

try {
  $request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $outCdxml = [string]$request.outCdxml
  $items = @($request.items)
  if ([string]::IsNullOrWhiteSpace($outCdxml)) { throw 'No output path.' }
  if ($items.Count -eq 0) { throw 'No structures supplied.' }

  $stage = 'clipboard-backup'
  try {
    $previousClipboard = Get-Clipboard -Raw -ErrorAction Stop
    $hadClipboard = $true
  } catch {
    $hadClipboard = $false
  }

  $stage = 'com-create'
  $beforeIds = @(Get-Process -Name ChemDraw -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $app = New-Object -ComObject ChemDraw.Application
  $newIds = @()
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline) {
    $afterIds = @(Get-Process -Name ChemDraw -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $newIds = @($afterIds | Where-Object { $beforeIds -notcontains $_ })
    if ($newIds.Count -gt 0) { break }
    Start-Sleep -Milliseconds 150
  }
  $ownedIds = @($newIds + @(Get-Process -Name ChemDraw -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime -ge $callStart.AddSeconds(-2) } |
    Select-Object -ExpandProperty Id) | Select-Object -Unique)
  $startedHere = ($ownedIds.Count -gt 0)
  if ($startedHere) { try { $app.Visible = $false } catch {} }

  $stage = 'document-add'
  $doc = $app.Documents.Add()
  $doc.Activate()

  # Keep reaction schemes compact and consistent with the structure output.
  $stage = 'style'
  try {
    $doc.Settings.BondLength = 20
    $doc.Settings.LabelFont = 3
    $doc.Settings.LabelSize = 9
    $doc.Settings.LineWidth = 0.6
    $doc.Settings.BondSpacing = 10
    $doc.Settings.MarginWidth = 1
    $doc.Settings.CaptionFont = 3
    $doc.Settings.CaptionSize = 9
  } catch {
    Write-Log ("could not apply some style settings: {0}" -f $_.Exception.Message)
  }

  foreach ($item in $items) {
    $smiles = [string]$item.smiles
    if ([string]::IsNullOrWhiteSpace($smiles)) { throw 'An item has no SMILES.' }
    $molPath = [string]$item.molPath
    $stage = 'paste'
    if (-not [string]::IsNullOrWhiteSpace($molPath)) {
      $stage = 'open-coordgen'
      $tempDoc = $app.Documents.Open($molPath)
      if ($tempDoc -eq $null) { throw 'ChemDraw could not open a CoordGen MOL.' }
      $tempDoc.Objects.Select()
      $tempDoc.Objects.Copy()
      $tempDoc.Close(0)
      $doc.Activate()
      $doc.Paste()
    } else {
      Set-Clipboard -Value $smiles
      Start-Sleep -Milliseconds 250
      $doc.Paste()
    }
    Start-Sleep -Milliseconds 350

    $stage = 'select'
    $selection = $doc.Selection.Objects
    if ($selection.Count -lt 1) { throw 'ChemDraw did not create a structure from the SMILES.' }
    $left = [double]$selection.Left
    $right = [double]$selection.Right
    $top = [double]$selection.Top
    $bottom = [double]$selection.Bottom
    $dx = [double]$item.x - (($left + $right) / 2)
    $dy = [double]$item.y - (($top + $bottom) / 2)
    $selection.Move($dx, $dy)
    $placements += [ordered]@{
      smiles = $smiles
      width = [double]$selection.Width
      height = [double]$selection.Height
    }
    Write-Log ("placed {0} at {1},{2}" -f $smiles, $item.x, $item.y)
  }

  $stage = 'save'
  $doc.SaveAs($outCdxml)
  if (-not (Wait-File $outCdxml)) { throw 'ChemDraw did not write the reaction CDXML.' }

  Save-Result @{
    ok = $true
    stage = 'done'
    startedHere = $startedHere
    placements = $placements
    log = $log
  }
} catch {
  Save-Result @{
    ok = $false
    stage = $stage
    error = $_.Exception.Message
    log = $log
  }
  $exitCode = 1
} finally {
  if ($hadClipboard) { try { Set-Clipboard -Value $previousClipboard } catch {} }
  if ($doc -ne $null) { try { $doc.Close(0) } catch {} }
  if ($startedHere -and $app -ne $null) {
    try { $app.Quit() } catch {}
    Start-Sleep -Milliseconds 700
    $cleanupIds = @($ownedIds)
    $cleanupIds += @(Get-Process -Name ChemDraw -ErrorAction SilentlyContinue |
      Where-Object { $_.StartTime -ge $callStart.AddSeconds(-2) -and $_.MainWindowHandle -eq 0 } |
      Select-Object -ExpandProperty Id)
    foreach ($processId in ($cleanupIds | Select-Object -Unique)) {
      $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if ($proc -ne $null -and $proc.MainWindowHandle -eq 0) {
        try { Stop-Process -Id $processId -Force } catch {}
      }
    }
  }
}

exit $exitCode
