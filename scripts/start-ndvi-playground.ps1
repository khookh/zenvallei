param(
    [switch]$Test
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PlaygroundRoot = Join-Path $ProjectRoot "playground\ndvi"
$EnvironmentRoot = Join-Path $ProjectRoot ".cache\ndvi-playground-venv"
$EnvironmentPython = Join-Path $EnvironmentRoot "Scripts\python.exe"
$Requirements = Join-Path $PlaygroundRoot "requirements.lock.txt"
$RequirementsStamp = Join-Path $EnvironmentRoot "greenwave-requirements.sha256"

Set-Location $ProjectRoot

$Launcher = Get-Command py -ErrorAction SilentlyContinue
if (-not $Launcher) {
    throw "Python Launcher (py.exe) was not found. Install Python 3.11 or newer first."
}

& $Launcher.Source -3.11 -c "import sys; assert sys.version_info >= (3, 11)" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Python 3.11 or newer was not found."
}

if (-not (Test-Path -LiteralPath $EnvironmentPython)) {
    Write-Host "Creating the isolated Greenwave NDVI environment..."
    & $Launcher.Source -3.11 -m venv $EnvironmentRoot
    if ($LASTEXITCODE -ne 0) { throw "Could not create the Python environment." }
}

$CurrentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Requirements).Hash
$InstalledHash = if (Test-Path -LiteralPath $RequirementsStamp) {
    (Get-Content -LiteralPath $RequirementsStamp -Raw).Trim()
} else { "" }

if ($CurrentHash -ne $InstalledHash) {
    Write-Host "Installing pinned NDVI playground dependencies..."
    & $EnvironmentPython -m pip install --disable-pip-version-check -r $Requirements
    if ($LASTEXITCODE -ne 0) { throw "Could not install the NDVI playground dependencies." }
    & $EnvironmentPython -m pip install --disable-pip-version-check --no-deps --editable $PlaygroundRoot
    if ($LASTEXITCODE -ne 0) { throw "Could not install the Greenwave NDVI loader." }
    & $EnvironmentPython -c "import dask, numpy, pandas, rasterio, xarray; import greenwave_ndvi"
    if ($LASTEXITCODE -ne 0) {
        throw "The scientific Python stack could not be imported. The requirements stamp was not written; rerun after resolving the reported binary error."
    }
    Set-Content -LiteralPath $RequirementsStamp -Value $CurrentHash -Encoding ascii
}

if ($Test) {
    & $EnvironmentPython -m pytest (Join-Path $PlaygroundRoot "tests")
    exit $LASTEXITCODE
}

Write-Host "Opening the NDVI playground on this computer only..."
& $EnvironmentPython -m jupyterlab `
    --notebook-dir=$PlaygroundRoot `
    --ip=127.0.0.1 `
    --port=8888 `
    --ServerApp.open_browser=True
exit $LASTEXITCODE
