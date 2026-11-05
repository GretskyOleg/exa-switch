# Xray Switch — Windows installer for the helper + native messaging.
# Run from PowerShell as your normal user (not Administrator).

param(
    [switch]$Uninstall,
    [switch]$Purge
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$HostName = "com.oleg.xray_switch"
$FirefoxId = "xray-switch@oleg.dev"
$DataDir = Join-Path $env:LOCALAPPDATA "xray-switch"
$ConfigDir = Join-Path $env:APPDATA "xray-switch"
$Exe = Join-Path $DataDir "xray-switch-helper.exe"
$ChromeCrx = Join-Path $Root "dist\release\exa-switch-chrome.crx"
$FirefoxXpi = Join-Path $Root "dist\release\exa-switch-firefox-signed.xpi"
$ChromeManifestPath = Join-Path $Root "dist\chrome\manifest.json"
$Version = "0.1.1"
if (Test-Path $ChromeManifestPath) {
    $Version = (Get-Content $ChromeManifestPath -Raw | ConvertFrom-Json).version
}

# Chrome extension id from the manifest key (same algorithm as Chromium).
$chromeIdFile = Join-Path $Root "dist\chrome-id.txt"
if (Test-Path $chromeIdFile) {
    $chromeId = (Get-Content $chromeIdFile -Raw).Trim()
} else {
    $manifest = Get-Content (Join-Path $Root "extension\manifest.chrome.json") -Raw | ConvertFrom-Json
    $keyBytes = [Convert]::FromBase64String($manifest.key)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash($keyBytes)
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt 16; $i++) {
        [void]$sb.Append([char](97 + (($hash[$i] -shr 4) -band 0xF)))
        [void]$sb.Append([char](97 + ($hash[$i] -band 0xF)))
    }
    $chromeId = $sb.ToString()
}

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ($arch) {
    "X64"   { $archName = "amd64" }
    "Arm64" { $archName = "arm64" }
    default { throw "Unsupported architecture: $arch" }
}

$chromeManifest = Join-Path $DataDir "$HostName.chrome.json"
$firefoxManifest = Join-Path $DataDir "$HostName.firefox.json"
$registryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Google\Chrome Beta\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Vivaldi\NativeMessagingHosts\$HostName"
)
$firefoxKey = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
$extensionKeys = @(
    "HKCU:\Software\Google\Chrome\Extensions\$chromeId",
    "HKCU:\Software\Google\Chrome Beta\Extensions\$chromeId",
    "HKCU:\Software\Chromium\Extensions\$chromeId",
    "HKCU:\Software\BraveSoftware\Brave-Browser\Extensions\$chromeId",
    "HKCU:\Software\Microsoft\Edge\Extensions\$chromeId",
    "HKCU:\Software\Vivaldi\Extensions\$chromeId"
)

if ($Uninstall) {
    if (Test-Path $Exe) {
        & $Exe stop 2>$null | Out-Null
    }
    foreach ($key in $registryKeys) {
        Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue
    }
    foreach ($key in $extensionKeys) {
        Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "XraySwitchHelper" -ErrorAction SilentlyContinue
    Remove-Item -Path $firefoxKey -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $chromeManifest, $firefoxManifest -Force -ErrorAction SilentlyContinue
    Remove-Item -Path (Join-Path $DataDir "exa-switch.crx"), (Join-Path $DataDir "exa-switch-firefox.xpi") -Force -ErrorAction SilentlyContinue
    $ffProfiles = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
    if (Test-Path $ffProfiles) {
        Get-ChildItem $ffProfiles -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item (Join-Path $_.FullName "extensions\xray-switch@oleg.dev.xpi") -Force -ErrorAction SilentlyContinue
            $userJs = Join-Path $_.FullName "user.js"
            if (Test-Path $userJs) {
                $pref = 'user_pref("extensions.autoDisableScopes", 0);'
                $lines = @(Get-Content $userJs | Where-Object { $_.Trim() -ne $pref })
                if ($lines.Count -eq 0) { Remove-Item $userJs -Force } else { Set-Content -Path $userJs -Value $lines -Encoding UTF8 }
            }
        }
    }
    Remove-Item -Path $Exe -Force -ErrorAction SilentlyContinue
    if ($Purge) {
        Remove-Item -Path $ConfigDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Xray Switch helper removed."
    exit 0
}

$src = Join-Path $Root "dist\helper\xray-switch-helper-windows-$archName.exe"
if (-not (Test-Path $src)) {
    $src = Join-Path $Root "dist\helper\xray-switch-helper.exe"
}
if (-not (Test-Path $src)) {
    throw "Helper binary not found. Build it first: ./build.sh --cross (or put the .exe into dist\helper\)."
}

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
if (Test-Path $Exe) {
    & $Exe stop 2>$null | Out-Null
}
Copy-Item -Path $src -Destination $Exe -Force

$utf8 = New-Object System.Text.UTF8Encoding($false)

$chromeJson = @{
    name = $HostName
    description = "Xray Switch local helper (xray-core)"
    path = $Exe
    type = "stdio"
    allowed_origins = @("chrome-extension://$chromeId/")
} | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($chromeManifest, $chromeJson, $utf8)

$firefoxJson = @{
    name = $HostName
    description = "Xray Switch local helper (xray-core)"
    path = $Exe
    type = "stdio"
    allowed_extensions = @($FirefoxId)
} | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($firefoxManifest, $firefoxJson, $utf8)

foreach ($key in $registryKeys) {
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(default)" -Value $chromeManifest
}
New-Item -Path $firefoxKey -Force | Out-Null
Set-ItemProperty -Path $firefoxKey -Name "(default)" -Value $firefoxManifest

Write-Host "Native host: $HostName"
Write-Host "Chrome ID:   $chromeId"
Write-Host "Firefox ID:  $FirefoxId"
Write-Host "Helper:      $Exe"

# Autostart at logon (per-user, no admin).
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
New-Item -Path $runKey -Force | Out-Null
Set-ItemProperty -Path $runKey -Name "XraySwitchHelper" -Value "`"$Exe`" ensure"

# Firefox: signed XPI in every profile + the sideload pref.
if (Test-Path $FirefoxXpi) {
    $ffProfiles = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
    if (Test-Path $ffProfiles) {
        Get-ChildItem $ffProfiles -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $extDir = Join-Path $_.FullName "extensions"
            New-Item -ItemType Directory -Path $extDir -Force | Out-Null
            Copy-Item $FirefoxXpi (Join-Path $extDir "xray-switch@oleg.dev.xpi") -Force
            $userJs = Join-Path $_.FullName "user.js"
            $pref = 'user_pref("extensions.autoDisableScopes", 0);'
            if (-not (Test-Path $userJs)) {
                Set-Content -Path $userJs -Value $pref -Encoding UTF8
            } elseif (-not (Select-String -Path $userJs -SimpleMatch "extensions.autoDisableScopes" -Quiet)) {
                Add-Content -Path $userJs -Value $pref -Encoding UTF8
            }
        }
    }
    Copy-Item $FirefoxXpi (Join-Path $DataDir "exa-switch-firefox.xpi") -Force
}

# Chrome/Chromium/Edge/Brave/Vivaldi: external CRX via HKCU.
if (Test-Path $ChromeCrx) {
    $crxDest = Join-Path $DataDir "exa-switch.crx"
    Copy-Item $ChromeCrx $crxDest -Force
    $extRoots = @(
        "HKCU:\Software\Google\Chrome\Extensions\$chromeId",
        "HKCU:\Software\Google\Chrome Beta\Extensions\$chromeId",
        "HKCU:\Software\Chromium\Extensions\$chromeId",
        "HKCU:\Software\BraveSoftware\Brave-Browser\Extensions\$chromeId",
        "HKCU:\Software\Microsoft\Edge\Extensions\$chromeId",
        "HKCU:\Software\Vivaldi\Extensions\$chromeId"
    )
    foreach ($k in $extRoots) {
        New-Item -Path $k -Force | Out-Null
        Set-ItemProperty -Path $k -Name "path" -Value $crxDest
        Set-ItemProperty -Path $k -Name "version" -Value $Version
    }
}

Write-Host ""
Write-Host "Starting helper..."
& $Exe ensure

Write-Host ""
Write-Host "Next:"
Write-Host "  Firefox: расширение уже установлено — перезапустите браузер"
Write-Host "  Chrome/Edge/Brave: CRX установится при следующем запуске (может быть один запрос подтверждения)"
Write-Host "  Если не появилось: chrome://extensions -> Developer mode -> Load unpacked -> $Root\dist\chrome"
