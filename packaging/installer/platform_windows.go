//go:build windows

package main

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/registry"
)

func platformName() string { return "Windows" }

func envDir(name string, fallbackParts ...string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	home := os.Getenv("USERPROFILE")
	return filepath.Join(append([]string{home}, fallbackParts...)...)
}

func platformDataDir() string {
	return filepath.Join(envDir("LOCALAPPDATA", "AppData", "Local"), "xray-switch")
}

func platformConfigDir() string {
	return filepath.Join(envDir("APPDATA", "AppData", "Roaming"), "xray-switch")
}

func helperName() string { return "xray-switch-helper.exe" }

func chromeRegistryKeys() []string {
	return []string{
		`Software\Google\Chrome\NativeMessagingHosts\` + nativeHostName,
		`Software\Google\Chrome Beta\NativeMessagingHosts\` + nativeHostName,
		`Software\Chromium\NativeMessagingHosts\` + nativeHostName,
		`Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\` + nativeHostName,
		`Software\Microsoft\Edge\NativeMessagingHosts\` + nativeHostName,
		`Software\Vivaldi\NativeMessagingHosts\` + nativeHostName,
	}
}

func firefoxRegistryKey() string {
	return `Software\Mozilla\NativeMessagingHosts\` + nativeHostName
}

func setRegistryDefault(path, value string) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE|registry.CREATE_SUB_KEY)
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetStringValue("", value)
}

func platformWriteManifests(dataDir, helperPath string) error {
	chromeManifestPath := filepath.Join(dataDir, nativeHostName+".chrome.json")
	firefoxManifestPath := filepath.Join(dataDir, nativeHostName+".firefox.json")
	if err := writeFile(chromeManifestPath, chromeManifest(helperPath), 0o644); err != nil {
		return err
	}
	if err := writeFile(firefoxManifestPath, firefoxManifest(helperPath), 0o644); err != nil {
		return err
	}
	for _, key := range chromeRegistryKeys() {
		if err := setRegistryDefault(key, chromeManifestPath); err != nil {
			return fmt.Errorf("registry %s: %w", key, err)
		}
	}
	if err := setRegistryDefault(firefoxRegistryKey(), firefoxManifestPath); err != nil {
		return fmt.Errorf("registry firefox: %w", err)
	}
	return nil
}

func platformRemoveManifests() {
	for _, key := range chromeRegistryKeys() {
		_ = registry.DeleteKey(registry.CURRENT_USER, key)
	}
	_ = registry.DeleteKey(registry.CURRENT_USER, firefoxRegistryKey())
	dataDir := platformDataDir()
	_ = os.Remove(filepath.Join(dataDir, nativeHostName+".chrome.json"))
	_ = os.Remove(filepath.Join(dataDir, nativeHostName+".firefox.json"))
}

func fileURL(path string) string {
	return (&url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(path)}).String()
}

func writeURLShortcut(path, setupPath, iconPath string) error {
	content := "[InternetShortcut]\r\n" +
		"URL=" + fileURL(setupPath) + "\r\n" +
		"IconFile=" + iconPath + "\r\n" +
		"IconIndex=0\r\n"
	return writeFile(path, []byte(content), 0o644)
}

func platformCreateShortcuts(setupPath, chromeDir string) error {
	iconPath := filepath.Join(chromeDir, "icons", "icon128.png")
	desktop := filepath.Join(os.Getenv("USERPROFILE"), "Desktop")
	if info, err := os.Stat(desktop); err == nil && info.IsDir() {
		_ = writeURLShortcut(filepath.Join(desktop, "EXA Switch Setup.url"), setupPath, iconPath)
	}
	startMenu := filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs")
	if err := os.MkdirAll(startMenu, 0o755); err == nil {
		_ = writeURLShortcut(filepath.Join(startMenu, "EXA Switch Setup.url"), setupPath, iconPath)
	}
	return nil
}

func platformRemoveShortcuts() {
	_ = os.Remove(filepath.Join(os.Getenv("USERPROFILE"), "Desktop", "EXA Switch Setup.url"))
	_ = os.Remove(filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs", "EXA Switch Setup.url"))
}

func platformOpenSetup(setupPath string) error {
	if err := exec.Command("rundll32", "url.dll,FileProtocolHandler", setupPath).Start(); err == nil {
		return nil
	}
	return exec.Command("cmd", "/c", "start", "", setupPath).Start()
}

func chromeExtensionRegistryRoots() []string {
	return []string{
		`Software\Google\Chrome\Extensions\`,
		`Software\Google\Chrome Beta\Extensions\`,
		`Software\Chromium\Extensions\`,
		`Software\BraveSoftware\Brave-Browser\Extensions\`,
		`Software\Microsoft\Edge\Extensions\`,
		`Software\Vivaldi\Extensions\`,
	}
}

func firefoxProfileRoots() []string {
	return []string{filepath.Join(os.Getenv("APPDATA"), "Mozilla", "Firefox", "Profiles")}
}

func platformPostInstall(paths installPaths) error {
	runKey := `Software\Microsoft\Windows\CurrentVersion\Run`
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	_ = key.SetStringValue("XraySwitchHelper", `"`+paths.helperPath+`" ensure`)
	key.Close()

	installFirefoxProfiles(firefoxProfileRoots(), paths.firefoxXPI)

	if paths.chromeCRX != "" {
		for _, root := range chromeExtensionRegistryRoots() {
			key, _, err := registry.CreateKey(registry.CURRENT_USER, root+chromeID, registry.SET_VALUE)
			if err != nil {
				continue
			}
			_ = key.SetStringValue("path", paths.chromeCRX)
			_ = key.SetStringValue("version", appVersion)
			key.Close()
		}
	}
	return nil
}

func platformRemoveIntegration() {
	if key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE); err == nil {
		_ = key.DeleteValue("XraySwitchHelper")
		key.Close()
	}
	for _, root := range chromeExtensionRegistryRoots() {
		_ = registry.DeleteKey(registry.CURRENT_USER, root+chromeID)
	}
	removeFirefoxProfiles(firefoxProfileRoots())
}

func platformNotify(title, message string) {
	fmt.Printf("%s: %s\n", title, message)
}

func platformFail(message string) {
	fmt.Fprintln(os.Stderr, message)
}

func platformLog(message string) {
	dir := platformConfigDir()
	_ = os.MkdirAll(dir, 0o700)
	f, err := os.OpenFile(filepath.Join(dir, "installer.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), message)
}

func platformSpecificWait() {
	waitForEnter()
}
