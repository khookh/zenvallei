[CmdletBinding()]
param(
    [ValidateSet("Install", "Remove", "Status")]
    [string]$Action = "Status",

    [ValidateRange(1, 65535)]
    [int]$Port = 4173,

    [switch]$Elevated
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ruleName = "Greenwave LAN TCP $Port"

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-GreenwaveFirewallRule {
    return Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
}

if ($Action -eq "Status") {
    $rule = Get-GreenwaveFirewallRule
    if ($rule) {
        Write-Host "The Greenwave LAN firewall rule is installed and $($rule.Enabled.ToString().ToLowerInvariant())."
        exit 0
    }

    Write-Host "The Greenwave LAN firewall rule is not installed."
    exit 1
}

if (-not (Test-IsAdministrator)) {
    if ($Elevated) {
        Write-Error "Administrator approval was not granted."
        exit 1
    }

    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"",
        "-Action", $Action,
        "-Port", $Port,
        "-Elevated"
    )
    $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $process.ExitCode
}

try {
    $existingRule = Get-GreenwaveFirewallRule

    if ($Action -eq "Install") {
        if ($existingRule) {
            Write-Host "The Greenwave LAN firewall rule already exists."
            exit 0
        }

        New-NetFirewallRule `
            -DisplayName $ruleName `
            -Description "Allow Greenwave on TCP $Port from devices on the local subnet." `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort $Port `
            -RemoteAddress LocalSubnet `
            -Profile Private, Public | Out-Null

        Write-Host "Created '$ruleName', restricted to the local subnet."
        exit 0
    }

    if (-not $existingRule) {
        Write-Host "The Greenwave LAN firewall rule is already absent."
        exit 0
    }

    $existingRule | Remove-NetFirewallRule
    Write-Host "Removed '$ruleName'."
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
