param(
  [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root 'vendor\venv'
$pythonExe = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path -LiteralPath $pythonExe)) {
  Write-Host "Creating Python environment at $venv"
  & $Python -m venv $venv
}

Write-Host 'Installing PyMuPDF and RDKit'
& $pythonExe -m pip install --upgrade pip
& $pythonExe -m pip install -r (Join-Path $root 'requirements.txt')

& $pythonExe -c "import pymupdf, rdkit; print('Python environment ready:', pymupdf.__doc__, rdkit.__version__)"
