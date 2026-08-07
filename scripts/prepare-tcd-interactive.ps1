[CmdletBinding()]
param()

# Deprecated and intentionally disconnected from the active CLI and map.
# Retained temporarily so an earlier Tree Cover Density cache can be reproduced.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$previousLocation = Get-Location

try {
    Set-Location $projectRoot
    $credential = Get-Credential -Message "Copernicus Data Space login for Tree Cover Density"
    $tokenBody = @{
        client_id  = "cdse-public"
        grant_type = "password"
        username   = $credential.UserName
        password   = $credential.GetNetworkCredential().Password
    }
    $totp = Read-Host "2FA code (press Enter when not enabled)"
    if ($totp) { $tokenBody.totp = $totp }

    $tokenResult = Invoke-RestMethod `
        -Method Post `
        -Uri "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token" `
        -ContentType "application/x-www-form-urlencoded" `
        -Body $tokenBody

    $env:CDSE_ACCESS_TOKEN = $tokenResult.access_token
    & node.exe scripts/run-local-layer-python.mjs -m greenwave_local_layers --dataset tcd
    if ($LASTEXITCODE -ne 0) { throw "Tree Cover Density preparation failed." }
    Write-Host "Tree Cover Density preparation is complete." -ForegroundColor Green
}
catch {
    Write-Error $_.Exception.Message
}
finally {
    Remove-Item Env:CDSE_ACCESS_TOKEN -ErrorAction SilentlyContinue
    Remove-Variable credential, tokenBody, tokenResult, totp -ErrorAction SilentlyContinue
    Set-Location $previousLocation
    Read-Host "Press Enter to close this window"
}
