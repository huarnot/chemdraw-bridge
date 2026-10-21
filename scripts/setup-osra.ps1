param(
  [string]$Destination = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Join-Path $root 'vendor\osra'
}
$zip = Join-Path $env:TEMP 'osra-bin-win-x64.zip'
$url = 'https://github.com/k-ujihara/osra_vs/releases/download/v0.1.0/osra-bin-win-x64.zip'

if (Test-Path -LiteralPath (Join-Path $Destination 'osra.exe')) {
  Write-Host "OSRA already present at $Destination"
  exit 0
}

New-Item -ItemType Directory -Force $Destination | Out-Null
Write-Host "Downloading OSRA from $url"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
Expand-Archive -LiteralPath $zip -DestinationPath $Destination -Force
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue

$exe = Join-Path $Destination 'osra.exe'
if (-not (Test-Path -LiteralPath $exe)) {
  throw "OSRA extraction did not produce osra.exe at $exe"
}
Write-Host "OSRA ready: $exe"
