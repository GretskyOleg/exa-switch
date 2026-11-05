# Xray Switch — Windows installer for the helper + native messaging.
# Run from PowerShell as your normal user (not Administrator).

param(
    [switch]$Uninstall,
    [switch]$Purge,
    [string]$Browsers = "",
    [switch]$AllBrowsers,
    [switch]$NoBrowsers
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

# --- choose browsers -----------------------------------------------------
$detected = @()
$pf = $env:ProgramFiles
$pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
$local = $env:LOCALAPPDATA
function Join-Base([string]$Base, [string]$Rel) {
    if ([string]::IsNullOrWhiteSpace($Base)) { return $null }
    return (Join-Path $Base $Rel)
}
if ((Test-Path (Join-Path $env:APPDATA "Mozilla\Firefox\Profiles")) -or
    (Test-Path (Join-Base $pf "Mozilla Firefox\firefox.exe")) -or
    (Test-Path (Join-Base $pf86 "Mozilla Firefox\firefox.exe"))) {
    $detected += "firefox"
}
$checks = @(
    @{ id = "chrome";   paths = @((Join-Base $local "Google\Chrome\Application\chrome.exe"), (Join-Base $pf "Google\Chrome\Application\chrome.exe"), (Join-Base $pf86 "Google\Chrome\Application\chrome.exe")) },
    @{ id = "chromium"; paths = @((Join-Base $local "Chromium\Application\chrome.exe"), (Join-Base $pf "Chromium\Application\chrome.exe")) },
    @{ id = "edge";     paths = @((Join-Base $pf86 "Microsoft\Edge\Application\msedge.exe"), (Join-Base $pf "Microsoft\Edge\Application\msedge.exe"), (Join-Base $local "Microsoft\Edge\Application\msedge.exe")) },
    @{ id = "brave";    paths = @((Join-Base $local "BraveSoftware\Brave-Browser\Application\brave.exe"), (Join-Base $pf "BraveSoftware\Brave-Browser\Application\brave.exe")) },
    @{ id = "vivaldi";  paths = @((Join-Base $local "Vivaldi\Application\vivaldi.exe"), (Join-Base $pf "Vivaldi\Application\vivaldi.exe")) }
)
foreach ($c in $checks) {
    foreach ($p in $c.paths) {
        if ($p -and (Test-Path $p)) { $detected += $c.id; break }
    }
}
$detected = @($detected | Select-Object -Unique)

$selected = @()
if ($NoBrowsers) {
    $selected = @()
} elseif ($AllBrowsers) {
    $selected = $detected
} elseif ($Browsers) {
    $selected = @($Browsers -split '[,;\s]+' | Where-Object { $_ } | ForEach-Object { $_.ToLower() })
} elseif ($detected.Count -eq 0) {
    Write-Host "Браузеры не обнаружены — расширение можно установить позже вручную."
} else {
    Write-Host ""
    Write-Host "Обнаружены браузеры:"
    for ($i = 0; $i -lt $detected.Count; $i++) {
        Write-Host ("  {0}) {1}" -f ($i + 1), $detected[$i])
    }
    $choice = Read-Host "Куда установить расширение? [1,2 / all / none] (Enter = Firefox, если есть)"
    if ([string]::IsNullOrWhiteSpace($choice)) {
        if ($detected -contains "firefox") { $selected = @("firefox") } else { $selected = $detected }
    } elseif ($choice -eq "all") {
        $selected = $detected
    } elseif ($choice -eq "none") {
        $selected = @()
    } else {
        foreach ($part in ($choice -split '[,;\s]+')) {
            if ($part -match '^\d+$') {
                $idx = [int]$part - 1
                if ($idx -ge 0 -and $idx -lt $detected.Count) { $selected += $detected[$idx] }
            } elseif ($part) {
                $selected += $part.ToLower()
            }
        }
    }
}
$selected = @($selected | Select-Object -Unique)

# Reconcile: drop previous extension integration, then install only selected.
$allExtRoots = @(
    "HKCU:\Software\Google\Chrome\Extensions\$chromeId",
    "HKCU:\Software\Google\Chrome Beta\Extensions\$chromeId",
    "HKCU:\Software\Chromium\Extensions\$chromeId",
    "HKCU:\Software\BraveSoftware\Brave-Browser\Extensions\$chromeId",
    "HKCU:\Software\Microsoft\Edge\Extensions\$chromeId",
    "HKCU:\Software\Vivaldi\Extensions\$chromeId"
)
foreach ($k in $allExtRoots) {
    Remove-Item -Path $k -Recurse -Force -ErrorAction SilentlyContinue
}
$ffProfiles = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
if (Test-Path $ffProfiles) {
    Get-ChildItem $ffProfiles -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item (Join-Path $_.FullName "extensions\xray-switch@oleg.dev.xpi") -Force -ErrorAction SilentlyContinue
    }
}

# Autostart at logon (per-user, no admin).
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
New-Item -Path $runKey -Force | Out-Null
Set-ItemProperty -Path $runKey -Name "XraySwitchHelper" -Value "`"$Exe`" ensure"

if ($selected -contains "firefox") {
    if (Test-Path $FirefoxXpi) {
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
        Write-Host "Firefox: расширение установлено"
    } else {
        Write-Host "Firefox: XPI не найден, пропускаю"
    }
}

$selectedExtRoots = @()
if ($selected -contains "chrome") {
    $selectedExtRoots += "HKCU:\Software\Google\Chrome\Extensions\$chromeId"
    $selectedExtRoots += "HKCU:\Software\Google\Chrome Beta\Extensions\$chromeId"
}
if ($selected -contains "chromium") { $selectedExtRoots += "HKCU:\Software\Chromium\Extensions\$chromeId" }
if ($selected -contains "edge") { $selectedExtRoots += "HKCU:\Software\Microsoft\Edge\Extensions\$chromeId" }
if ($selected -contains "brave") { $selectedExtRoots += "HKCU:\Software\BraveSoftware\Brave-Browser\Extensions\$chromeId" }
if ($selected -contains "vivaldi") { $selectedExtRoots += "HKCU:\Software\Vivaldi\Extensions\$chromeId" }

$selectedExtRoots = @($selectedExtRoots)
if ($selectedExtRoots.Count -gt 0) {
    if (Test-Path $ChromeCrx) {
        $crxDest = Join-Path $DataDir "exa-switch.crx"
        Copy-Item $ChromeCrx $crxDest -Force
        foreach ($k in $selectedExtRoots) {
            New-Item -Path $k -Force | Out-Null
            Set-ItemProperty -Path $k -Name "path" -Value $crxDest
            Set-ItemProperty -Path $k -Name "version" -Value $Version
        }
        Write-Host "Chrome/Chromium/Edge/Brave/Vivaldi: CRX установится при следующем запуске"
    } else {
        Write-Host "CRX не найден, пропускаю Chrome-семейство"
    }
}

Write-Host ""
Write-Host "Выбранные браузеры: $($selected -join ', ')"

Write-Host ""
Write-Host "Starting helper..."
& $Exe ensure

Write-Host ""
Write-Host "Next:"
if ($selected -contains "firefox") {
    Write-Host "  Firefox: перезапустите браузер — расширение уже установлено"
}
if ($selectedExtRoots.Count -gt 0) {
    Write-Host "  Chrome/Chromium/Edge/Brave/Vivaldi: перезапустите браузер;"
    Write-Host "  CRX установится автоматически (Chrome может показать один запрос подтверждения)"
}
if ($selected.Count -eq 0) {
    Write-Host "  Расширение не установлено. Позже: .\install.ps1 -Browsers firefox,chrome"
    Write-Host "  или chrome://extensions -> Developer mode -> Load unpacked -> $Root\dist\chrome"
}
