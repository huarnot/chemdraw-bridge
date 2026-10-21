param(
  [Parameter(Mandatory = $true)][string]$RequestFile,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

$ErrorActionPreference = 'Stop'
$exitCode = 0
$stage = 'init'
$log = New-Object System.Collections.Generic.List[string]

function Write-Log([string]$message) {
  $log.Add(('{0:o} {1}' -f (Get-Date), $message))
}

function Save-Result($payload) {
  try {
    $json = $payload | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($ResultFile, $json, (New-Object Text.UTF8Encoding($false)))
  } catch {
    # The caller also reports a missing result file.
  }
}

function Wait-File([string]$path, [int]$timeoutMs = 5000) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $path) {
      try {
        $item = Get-Item -LiteralPath $path -ErrorAction Stop
        if ($item.Length -gt 0) { return $true }
      } catch {}
    }
    Start-Sleep -Milliseconds 100
  }
  return $false
}

$app = $null
$doc = $null
$startedHere = $false
$callStart = Get-Date
$newIds = @()
$ownedIds = @()
$hadClipboard = $false
$previousClipboard = ''

try {
  Write-Log 'reading request'
  $request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $smiles = [string]$request.smiles
  $outCdxml = [string]$request.outCdxml
  $outCdx = [string]$request.outCdx
  if ([string]::IsNullOrWhiteSpace($smiles)) { throw 'The request contains no SMILES.' }

  $stage = 'clipboard-backup'
  try {
    $previousClipboard = Get-Clipboard -Raw -ErrorAction Stop
    $hadClipboard = $true
  } catch {
    $hadClipboard = $false
  }

  $stage = 'com-create'
  $callStart = Get-Date
  $beforeIds = @(Get-Process -Name ChemDraw -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  Write-Log ("existing ChemDraw processes: {0}" -f $beforeIds.Count)
  $app = New-Object -ComObject ChemDraw.Application

  # ChemDraw may attach to an existing instance or start a new one. Only the
  # process(es) that appeared during this call belong to us. Start time is also
  # checked because a slow start can outlive the polling window.
  $newIds = @()
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline) {
    $afterIds = @(Get-Process -Name ChemDraw -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $newIds = @($afterIds | Where-Object { $beforeIds -notcontains $_ })
    if ($newIds.Count -gt 0) { break }
    Start-Sleep -Milliseconds 150
  }
  $youngIds = @(Get-Process -Name ChemDraw -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime -ge $callStart.AddSeconds(-2) } |
    Select-Object -ExpandProperty Id)
  $ownedIds = @($newIds + $youngIds | Select-Object -Unique)
  $startedHere = ($ownedIds.Count -gt 0)
  Write-Log ("started by this call: {0} ({1})" -f $startedHere, ($ownedIds -join ','))
  if ($startedHere) {
    try { $app.Visible = $false } catch { Write-Log 'could not hide ChemDraw' }
  }

  $stage = 'document-add'
  $doc = $app.Documents.Add()
  $doc.Activate()

  $stage = 'paste'
  Set-Clipboard -Value $smiles
  Start-Sleep -Milliseconds 200
  $doc.Paste()

  $stage = 'wait-for-atoms'
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    try {
      if ($doc.Atoms.Count -gt 0) { break }
    } catch {
      # The collection is briefly unavailable while ChemDraw lays out the structure.
    }
    Start-Sleep -Milliseconds 100
  }

  $atomCount = 0
  $bondCount = 0
  try { $atomCount = [int]$doc.Atoms.Count } catch { $atomCount = 0 }
  try { $bondCount = [int]$doc.Bonds.Count } catch { $bondCount = 0 }
  if ($atomCount -lt 1) { throw 'ChemDraw did not create any atoms from the SMILES.' }

  $stage = 'save-cdxml'
  $doc.SaveAs($outCdxml)
  if (-not (Wait-File $outCdxml)) { throw 'ChemDraw reported success but the CDXML file is missing.' }

  if (-not [string]::IsNullOrWhiteSpace($outCdx)) {
    $stage = 'save-cdx'
    $doc.SaveAs($outCdx)
    if (-not (Wait-File $outCdx)) { throw 'ChemDraw reported success but the CDX file is missing.' }
  }

  $version = ''
  try { $version = [string]$app.Version } catch { $version = '' }
  if ([string]::IsNullOrWhiteSpace($version)) {
    try { $version = [string]$app.Name } catch { $version = '' }
  }

  $cdxBytes = 0
  $cdxMagicOk = $false
  if (-not [string]::IsNullOrWhiteSpace($outCdx)) {
    try {
      $cdxBytes = (Get-Item -LiteralPath $outCdx -ErrorAction Stop).Length
      $stream = [IO.File]::Open($outCdx, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      try {
        $buffer = New-Object byte[] 8
        $read = $stream.Read($buffer, 0, 8)
        $cdxMagicOk = ([Text.Encoding]::ASCII.GetString($buffer, 0, $read) -eq 'VjCD0100')
      } finally {
        $stream.Close()
      }
    } catch {
      Write-Log ("could not inspect CDX: {0}" -f $_.Exception.Message)
    }
  }

  Write-Log ("saved {0} atoms, {1} bonds" -f $atomCount, $bondCount)
  Save-Result @{
    ok = $true
    atomCount = $atomCount
    bondCount = $bondCount
    version = $version
    startedHere = $startedHere
    stage = 'done'
    cdxBytes = $cdxBytes
    cdxMagicOk = $cdxMagicOk
    log = $log
  }
} catch {
  $message = $_.Exception.Message
  Write-Log ("error at {0}: {1}" -f $stage, $message)
  Save-Result @{
    ok = $false
    error = $message
    stage = $stage
    version = ''
    startedHere = $startedHere
    log = $log
  }
  $exitCode = 1
} finally {
  if ($hadClipboard) {
    try { Set-Clipboard -Value $previousClipboard } catch {}
  }

  if ($doc -ne $null) {
    try { $doc.Close(0) } catch {}
  }

  if ($startedHere -and $app -ne $null) {
    try { $app.Quit() } catch {}
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
      $remaining = @($ownedIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
      if ($remaining.Count -eq 0) { break }
      Start-Sleep -Milliseconds 200
    }
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
