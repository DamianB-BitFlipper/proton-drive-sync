#Requires -Version 5.1
<#
.SYNOPSIS
    Uninstalls Proton Drive Sync from Windows

.DESCRIPTION
    Removes proton-drive-sync, Watchman, and optionally configuration data.

.EXAMPLE
    irm https://www.damianb.dev/proton-drive-sync/uninstall.ps1 | iex
#>

$ErrorActionPreference = "Stop"

# ============================================================================
# Configuration
# ============================================================================

$APP = "proton-drive-sync"
$INSTALL_DIR = "$env:LOCALAPPDATA\$APP"
$CONFIG_DIR = "$env:APPDATA\$APP"
$BIN_DIR = "$INSTALL_DIR\bin"


# ============================================================================
# Helper Functions
# ============================================================================

function Write-Step {
    param([string]$Message)
    Write-Host "`n=> $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

# ============================================================================
# Uninstall
# ============================================================================

Write-Host ""
Write-Host "Proton Drive Sync Uninstaller" -ForegroundColor Magenta
Write-Host ""

# Stop and uninstall service if running
Write-Step "Stopping service..."

$exePath = "$BIN_DIR\$APP.exe"
if (Test-Path $exePath) {
    try {
        & $exePath service uninstall -y 2>$null
        Write-Success "Service uninstalled"
    }
    catch {
        Write-Host "  Service was not installed or already stopped"
    }
}

# Remove installation directory
Write-Step "Removing installation files..."

if (Test-Path $INSTALL_DIR) {
    Remove-Item -Recurse -Force $INSTALL_DIR
    Write-Success "Removed $INSTALL_DIR"
}
else {
    Write-Host "  Installation directory not found"
}

# Clean PATH
Write-Step "Cleaning PATH environment variable..."

$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
$originalPath = $userPath
$pathParts = $userPath -split ';' | Where-Object { 
    $_ -and ($_ -notlike "*$APP*")
}
$userPath = $pathParts -join ';'

if ($userPath -ne $originalPath) {
    [Environment]::SetEnvironmentVariable("PATH", $userPath, "User")
    Write-Success "PATH cleaned"
}
else {
    Write-Host "  PATH was already clean"
}

# Ask about config/data removal
Write-Host ""
$response = Read-Host "Remove configuration and sync data? This cannot be undone. (y/N)"

if ($response -eq 'y' -or $response -eq 'Y') {
    Write-Step "Removing configuration and data..."
    
    if (Test-Path $CONFIG_DIR) {
        Remove-Item -Recurse -Force $CONFIG_DIR
        Write-Success "Removed $CONFIG_DIR"
    }
    
    # Also check for state directory
    $stateDir = "$env:LOCALAPPDATA\$APP"
    if (Test-Path $stateDir) {
        Remove-Item -Recurse -Force $stateDir -ErrorAction SilentlyContinue
    }
}
else {
    Write-Host ""
    Write-Host "Configuration preserved at: $CONFIG_DIR" -ForegroundColor Yellow
}

# Ask about Watchman removal
Write-Host ""
$response = Read-Host "Would you also like to remove Watchman? (y/N)"

if ($response -eq 'y' -or $response -eq 'Y') {
    Write-Step "Removing Watchman..."
    
    # Check if Chocolatey is available
    $chocoPath = Get-Command choco -ErrorAction SilentlyContinue
    if ($chocoPath) {
        try {
            choco uninstall watchman -y
            Write-Success "Watchman uninstalled via Chocolatey"
        }
        catch {
            Write-Host "  Failed to uninstall Watchman via Chocolatey: $_" -ForegroundColor Yellow
        }
    }
    else {
        Write-Host "  Chocolatey not found. If Watchman was installed manually, please remove it manually." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor White
Write-Host "  Uninstallation Complete!" -ForegroundColor Green  
Write-Host "============================================" -ForegroundColor White
Write-Host ""
Write-Host "Note: You may need to restart your terminal for PATH changes to take effect." -ForegroundColor Yellow
Write-Host ""
