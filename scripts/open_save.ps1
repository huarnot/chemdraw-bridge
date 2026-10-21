param(
  [Parameter(Mandatory = $true)][string]$RequestFile,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

$ErrorActionPreference = 'Stop'
$exitCode = 0
$stage = 'init'
$app = $null
$doc = $null
$startedHere = $false
$callStart = Get-Date
$ownedIds = @()

function Save-Result($payload) {
  try {
    $json = $payload | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText($ResultFile, $json, (New-Object Text.UTF8Encoding($false)))
  } catch {}
}

try {
  $request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $inCdxml = [string]$request.inCdxml
  $outCdx = [string]$request.outCdx
  $outPng = [string]$request.outPng

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

  $stage = 'open'
  $doc = $app.Documents.Open($inCdxml)
  if ($doc -eq $null) { throw 'ChemDraw could not open the generated reaction CDXML.' }

  if (-not [string]::IsNullOrWhiteSpace($outCdx)) {
    $stage = 'save-cdx'
    $doc.SaveAs($outCdx)
  }
  if (-not [string]::IsNullOrWhiteSpace($outPng)) {
    $stage = 'save-png'
    $doc.SaveAs($outPng)
  }
  $doc.Close(0)

  Save-Result @{ ok = $true; stage = 'done'; startedHere = $startedHere }
} catch {
  Save-Result @{ ok = $false; stage = $stage; error = $_.Exception.Message; startedHere = $startedHere }
  $exitCode = 1
} finally {
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
