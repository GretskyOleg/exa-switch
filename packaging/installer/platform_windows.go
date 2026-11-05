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

func chromeExtensionRegistryRootsFor(id string) []string {
	switch id {
	case "chrome":
		return []string{
			`Software\Google\Chrome\Extensions\`,
			`Software\Google\Chrome Beta\Extensions\`,
		}
	case "chromium":
		return []string{`Software\Chromium\Extensions\`}
	case "edge":
		return []string{`Software\Microsoft\Edge\Extensions\`}
	case "brave":
		return []string{`Software\BraveSoftware\Brave-Browser\Extensions\`}
	case "vivaldi":
		return []string{`Software\Vivaldi\Extensions\`}
	}
	return nil
}

func chromeExtensionRegistryRoots() []string {
	var out []string
	for _, id := range []string{"chrome", "chromium", "edge", "brave", "vivaldi"} {
		out = append(out, chromeExtensionRegistryRootsFor(id)...)
	}
	return out
}

func firefoxProfileRoots() []string {
	return []string{filepath.Join(os.Getenv("APPDATA"), "Mozilla", "Firefox", "Profiles")}
}

func platformDetectBrowsers() []string {
	var out []string
	firefoxPaths := []string{
		filepath.Join(os.Getenv("ProgramFiles"), "Mozilla Firefox", "firefox.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Mozilla Firefox", "firefox.exe"),
	}
	firefox := dirExists(filepath.Join(os.Getenv("APPDATA"), "Mozilla", "Firefox", "Profiles"))
	for _, path := range firefoxPaths {
		if fileExists(path) {
			firefox = true
		}
	}
	if firefox {
		out = append(out, "firefox")
	}

	local := os.Getenv("LOCALAPPDATA")
	pf := os.Getenv("ProgramFiles")
	pf86 := os.Getenv("ProgramFiles(x86)")
	checks := []struct {
		id    string
		paths []string
		reg   string
	}{
		{"chrome", []string{
			filepath.Join(local, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(pf, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
		}, `Software\Google\Chrome`},
		{"chromium", []string{
			filepath.Join(local, "Chromium", "Application", "chrome.exe"),
			filepath.Join(pf, "Chromium", "Application", "chrome.exe"),
		}, `Software\Chromium`},
		{"edge", []string{
			filepath.Join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
		}, `Software\Microsoft\Edge`},
		{"brave", []string{
			filepath.Join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
			filepath.Join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		}, `Software\BraveSoftware\Brave-Browser`},
		{"vivaldi", []string{
			filepath.Join(local, "Vivaldi", "Application", "vivaldi.exe"),
			filepath.Join(pf, "Vivaldi", "Application", "vivaldi.exe"),
		}, `Software\Vivaldi`},
	}
	for _, check := range checks {
		found := false
		for _, path := range check.paths {
			if fileExists(path) {
				found = true
				break
			}
		}
		if !found {
			if key, err := registry.OpenKey(registry.CURRENT_USER, check.reg, registry.QUERY_VALUE); err == nil {
				key.Close()
				found = true
			}
		}
		if found {
			out = append(out, check.id)
		}
	}
	return out
}

func platformPostInstall(paths installPaths, browsers []string) error {
	platformRemoveBrowserExtensions()

	runKey := `Software\Microsoft\Windows\CurrentVersion\Run`
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	_ = key.SetStringValue("XraySwitchHelper", `"`+paths.helperPath+`" ensure`)
	key.Close()

	for _, id := range browsers {
		if id == "firefox" {
			if installFirefoxProfiles(firefoxProfileRoots(), paths.firefoxXPI) == 0 {
				fmt.Println("  ! Firefox: профиль не найден. Запустите Firefox один раз и повторите установку.")
			}
			continue
		}
		if paths.chromeCRX == "" {
			continue
		}
		for _, root := range chromeExtensionRegistryRootsFor(id) {
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

func platformRemoveBrowserExtensions() {
	for _, root := range chromeExtensionRegistryRoots() {
		_ = registry.DeleteKey(registry.CURRENT_USER, root+chromeID)
	}
	removeFirefoxProfiles(firefoxProfileRoots())
}

func platformRemoveIntegration() {
	platformRemoveBrowserExtensions()
	if key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE); err == nil {
		_ = key.DeleteValue("XraySwitchHelper")
		key.Close()
	}
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
