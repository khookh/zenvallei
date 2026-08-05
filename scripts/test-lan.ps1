[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 41973
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path $projectRoot ".cache"
$stdout = Join-Path $cacheRoot "lan-test.stdout.log"
$stderr = Join-Path $cacheRoot "lan-test.stderr.log"

New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    throw "LAN integration test port $Port is already occupied."
}

$arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot "start-lan.ps1"),
    "-Port", $Port,
    "-SkipInstall",
    "-SkipBrowser"
)
$launcher = Start-Process powershell.exe `
    -ArgumentList $arguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr

try {
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 250
        $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
            Select-Object -First 1
    } until ($listener -or (Get-Date) -ge $deadline -or $launcher.HasExited)

    if (-not $listener) {
        $details = (Get-Content $stdout, $stderr -ErrorAction SilentlyContinue) -join [Environment]::NewLine
        throw "The LAN server did not start. $details"
    }
    if ($listener.LocalAddress -notin @("0.0.0.0", "::")) {
        throw "The LAN server listened on $($listener.LocalAddress), not all interfaces."
    }

    $route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" |
        Where-Object { $_.NextHop -ne "0.0.0.0" } |
        Sort-Object RouteMetric, InterfaceMetric |
        Select-Object -First 1
    $lanAddress = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex |
        Where-Object { -not $_.SkipAsSource -and $_.IPAddress -notlike "169.254.*" } |
        Select-Object -First 1
    $response = Invoke-WebRequest -Uri "http://$($lanAddress.IPAddress):$Port/" -UseBasicParsing

    if ($response.StatusCode -ne 200 -or $response.Content -notmatch "<title>Hittekwetsbaarheid Zennevallei</title>") {
        throw "The LAN address did not return the Greenwave application."
    }
    if ($response.Headers["X-Content-Type-Options"] -ne "nosniff") {
        throw "The LAN preview did not return the configured security headers."
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "configure-lan-firewall.ps1") -Action Install -Port $Port -WhatIf
    if ($LASTEXITCODE -ne 0) { throw "Firewall install dry run failed." }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "configure-lan-firewall.ps1") -Action Remove -Port $Port -WhatIf
    if ($LASTEXITCODE -ne 0) { throw "Firewall removal dry run failed." }

    Write-Host "LAN integration passed at http://$($lanAddress.IPAddress):$Port/."
}
finally {
    $activeListener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($activeListener) {
        $owner = Get-Process -Id $activeListener.OwningProcess -ErrorAction SilentlyContinue
        if ($owner -and $owner.ProcessName -eq "node") {
            Stop-Process -Id $owner.Id -Force
        }
    }
    if (-not $launcher.HasExited) {
        Stop-Process -Id $launcher.Id -Force
    }
    $launcher.WaitForExit()
}
