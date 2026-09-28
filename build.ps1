#requires -Version 5.1
<#
.SYNOPSIS
Build the Windows 11 x64 application and NSIS installer.
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-BuildStep {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE."
    }
}

Push-Location $PSScriptRoot
try {
    if ($env:OS -ne 'Windows_NT') {
        throw 'This project supports Windows 11 x64 only.'
    }
    $windowsVersion = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    if ($windowsVersion.InstallationType -ne 'Client' -or [int]$windowsVersion.CurrentBuildNumber -lt 22000) {
        throw 'Windows 11 is required to run this build script.'
    }
    foreach ($command in @('node', 'npm.cmd', 'rustc', 'cargo', 'rustup')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Missing $command. Install the prerequisites in README.md and reopen PowerShell."
        }
    }
    $nodeVersion = & node --version
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read the Node.js version.' }
    if ([version]($nodeVersion.TrimStart('v').Split('-')[0]) -lt [version]'22.12.0') {
        throw 'Node.js 22.12+ is required.'
    }
    $rustInfo = & rustc -vV
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read the Rust toolchain.' }
    if ($rustInfo -notcontains 'host: x86_64-pc-windows-msvc') {
        throw 'Use the x86_64-pc-windows-msvc Rust toolchain; the bundled device SDK requires Windows x64. See README.md.'
    }
    if (-not (Test-Path -LiteralPath 'src-tauri/resources/sdk/zkemkeeper.dll')) {
        throw 'Missing bundled SDK. Restore src-tauri/resources/sdk from the repository.'
    }

    Write-Host '[1/2] Installing locked frontend dependencies...'
    Invoke-BuildStep 'npm.cmd' @('ci', '--include=dev')
    Write-Host '[2/2] Building frontend, Rust application and Windows installer...'
    Invoke-BuildStep 'npm.cmd' @('run', 'bundle', '--', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis', '--', '--locked')
    Write-Host 'Build completed. Default output: src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/'
    Write-Host 'If CARGO_TARGET_DIR is configured, use the output path printed by Tauri above.'
}
catch {
    [Console]::Error.WriteLine("Build failed: $($_.Exception.Message)")
    exit 1
}
finally {
    Pop-Location
}
