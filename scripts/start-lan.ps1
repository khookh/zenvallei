[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 4173,

    [switch]$Check,
    [switch]$SkipInstall,
    [switch]$SkipBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-GreenwaveLanAddress {
    $defaultRoutes = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
        Where-Object { $_.NextHop -ne "0.0.0.0" } |
        Sort-Object RouteMetric, InterfaceMetric

    foreach ($route in $defaultRoutes) {
        $address = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue |
            Where-Object {
                -not $_.SkipAsSource -and
                $_.IPAddress -notlike "169.254.*" -and
                $_.IPAddress -ne "127.0.0.1"
            } |
            Select-Object -First 1

        if ($address) {
            return $address.IPAddress
        }
    }

    $fallback = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
        Where-Object {
            $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
            -not [System.Net.IPAddress]::IsLoopback($_) -and
            $_.ToString() -notlike "169.254.*"
        } |
        Select-Object -First 1

    if ($fallback) {
        return $fallback.ToString()
    }

    throw "No active LAN IPv4 address was found. Connect this computer to the local network and try again."
}

function Get-CommandPath([string]$Name, [string]$InstallHint) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) {
        throw "$Name was not found. $InstallHint"
    }

    return $command.Source
}

function Assert-PortAvailable([int]$RequestedPort) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $RequestedPort -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($listener) {
        throw "Port $RequestedPort is already in use by process $($listener.OwningProcess). Stop that process or close the existing Greenwave server."
    }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$previousLocation = Get-Location

try {
    Set-Location $projectRoot

    $nodeCommand = Get-CommandPath "node" "Install Node.js 24 LTS, then reopen this launcher."
    $pnpmCommand = Get-CommandPath "pnpm.cmd" "Install pnpm, then reopen this launcher."
    $nodeVersionText = (& $nodeCommand --version).TrimStart("v")
    $nodeVersion = [System.Version]::Parse($nodeVersionText)

    $supportedNode = ($nodeVersion.Major -eq 20 -and $nodeVersion.Minor -ge 19) -or
        ($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 12) -or
        $nodeVersion.Major -ge 23
    if (-not $supportedNode) {
        throw "Node.js $nodeVersionText is not supported. Install Node.js 24 LTS, then reopen this launcher."
    }

    Assert-PortAvailable $Port
    $lanAddress = Get-GreenwaveLanAddress
    $localUrl = "http://127.0.0.1:$Port/"
    $lanUrl = "http://${lanAddress}:$Port/"

    if ($Check) {
        Write-Host "Greenwave LAN check succeeded."
        Write-Host "Node.js: $nodeVersionText"
        Write-Host "pnpm: $((& $pnpmCommand --version).Trim())"
        Write-Host "LAN address: $lanUrl"
        exit 0
    }

    Write-Host "Preparing Greenwave..." -ForegroundColor Cyan
    if (-not $SkipInstall) {
        & $pnpmCommand install --frozen-lockfile --prefer-offline
        if ($LASTEXITCODE -ne 0) {
            throw "Dependency installation failed. Check the pnpm message above."
        }
    }

    $localDataIndex = Join-Path $projectRoot ".cache\local-layers\index.json"
    $useLocalData = Test-Path -LiteralPath $localDataIndex

    if ($useLocalData) {
        & $pnpmCommand exec vite build --mode local-data
        if ($LASTEXITCODE -ne 0) {
            throw "The Greenwave local-data build failed. Check the build message above."
        }
    }
    else {
        & $pnpmCommand build
        if ($LASTEXITCODE -ne 0) {
            throw "The Greenwave production build failed. Check the build message above."
        }
    }

    Write-Host ""
    Write-Host "Greenwave is starting." -ForegroundColor Green
    if ($useLocalData) {
        Write-Host "Mode: local official data (prepared layers detected)." -ForegroundColor Cyan
    } else {
        Write-Host "Mode: public application (no prepared local-layer catalogue found)." -ForegroundColor Cyan
        Write-Host "To add Landsat temperature, JaarBAK, Groenkaart and Landgebruik, prepare them once with pnpm local-data:prepare." -ForegroundColor DarkYellow
    }
    Write-Host "This computer: $localUrl"
    Write-Host "Other devices on this network: $lanUrl" -ForegroundColor Yellow
    Write-Host "Close this window or press Ctrl+C to stop Greenwave."
    Write-Host ""

    if (-not $SkipBrowser) {
        $browserCommand = @"
for (`$attempt = 0; `$attempt -lt 60; `$attempt++) {
    try {
        Invoke-WebRequest -Uri '$localUrl' -UseBasicParsing -TimeoutSec 1 | Out-Null
        Start-Process '$localUrl'
        break
    }
    catch {
        Start-Sleep -Milliseconds 250
    }
}
"@
        Start-Process powershell.exe -ArgumentList "-NoProfile", "-WindowStyle", "Hidden", "-Command", $browserCommand -WindowStyle Hidden | Out-Null
    }

    if ($useLocalData) {
        & $pnpmCommand exec vite preview --mode local-data --host 0.0.0.0 --port $Port --strictPort
    } else {
        & $pnpmCommand exec vite preview --host 0.0.0.0 --port $Port --strictPort
    }
    if ($LASTEXITCODE -ne 0) {
        throw "The Greenwave LAN server stopped unexpectedly."
    }
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
finally {
    Set-Location $previousLocation
}
