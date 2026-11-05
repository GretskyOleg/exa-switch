//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

func platformName() string { return "Linux" }

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return os.Getenv("HOME")
}

func xdgDataHome() string {
	if value := os.Getenv("XDG_DATA_HOME"); value != "" {
		return value
	}
	return filepath.Join(homeDir(), ".local", "share")
}

func xdgConfigHome() string {
	if value := os.Getenv("XDG_CONFIG_HOME"); value != "" {
		return value
	}
	return filepath.Join(homeDir(), ".config")
}

func platformDataDir() string   { return filepath.Join(xdgDataHome(), "xray-switch") }
func platformConfigDir() string { return filepath.Join(xdgConfigHome(), "xray-switch") }
func helperName() string        { return "xray-switch-helper" }

func chromeDirs() []string {
	base := xdgConfigHome()
	return []string{
		filepath.Join(base, "google-chrome", "NativeMessagingHosts"),
		filepath.Join(base, "google-chrome-beta", "NativeMessagingHosts"),
		filepath.Join(base, "chromium", "NativeMessagingHosts"),
		filepath.Join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
		filepath.Join(base, "microsoft-edge", "NativeMessagingHosts"),
		filepath.Join(base, "vivaldi", "NativeMessagingHosts"),
	}
}

func firefoxDirs() []string {
	home := homeDir()
	return []string{
		filepath.Join(home, ".mozilla", "native-messaging-hosts"),
		filepath.Join(home, ".librewolf", "native-messaging-hosts"),
	}
}

func platformWriteManifests(dataDir, helperPath string) error {
	for _, dir := range chromeDirs() {
		if err := writeFile(filepath.Join(dir, nativeHostName+".json"), chromeManifest(helperPath), 0o644); err != nil {
			return err
		}
	}
	for _, dir := range firefoxDirs() {
		if err := writeFile(filepath.Join(dir, nativeHostName+".json"), firefoxManifest(helperPath), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func platformRemoveManifests() {
	for _, dir := range append(chromeDirs(), firefoxDirs()...) {
		_ = os.Remove(filepath.Join(dir, nativeHostName+".json"))
	}
}

func platformCreateShortcuts(setupPath, chromeDir string) error {
	dataDir := platformDataDir()
	openScript := filepath.Join(dataDir, "open-setup.sh")
	script := "#!/usr/bin/env bash\n" +
		"exec xdg-open " + shellQuote(setupPath) + " >/dev/null 2>&1\n"
	if err := writeFile(openScript, []byte(script), 0o755); err != nil {
		return err
	}

	desktop := "[Desktop Entry]\n" +
		"Type=Application\n" +
		"Version=1.0\n" +
		"Name=EXA Switch Setup\n" +
		"Comment=Finish EXA Switch browser setup\n" +
		"Exec=" + desktopQuote(openScript) + "\n" +
		"Icon=" + filepath.Join(chromeDir, "icons", "icon128.png") + "\n" +
		"Terminal=false\n" +
		"Categories=Network;Security;\n" +
		"StartupNotify=false\n"
	appsDir := filepath.Join(xdgDataHome(), "applications")
	if err := writeFile(filepath.Join(appsDir, "xray-switch-setup.desktop"), []byte(desktop), 0o644); err != nil {
		return err
	}
	if desk := filepath.Join(homeDir(), "Desktop"); isDir(desk) {
		_ = writeFile(filepath.Join(desk, "exa-switch-setup.desktop"), []byte(desktop), 0o755)
	}
	return nil
}

func platformRemoveShortcuts() {
	_ = os.Remove(filepath.Join(xdgDataHome(), "applications", "xray-switch-setup.desktop"))
	_ = os.Remove(filepath.Join(homeDir(), "Desktop", "exa-switch-setup.desktop"))
	_ = os.Remove(filepath.Join(platformDataDir(), "open-setup.sh"))
}

func platformOpenSetup(setupPath string) error {
	if _, err := exec.LookPath("xdg-open"); err == nil {
		return exec.Command("xdg-open", setupPath).Start()
	}
	if _, err := exec.LookPath("gio"); err == nil {
		return exec.Command("gio", "open", setupPath).Start()
	}
	return fmt.Errorf("xdg-open/gio not found")
}

func chromeConfigRoots() []string {
	base := xdgConfigHome()
	return []string{
		filepath.Join(base, "google-chrome"),
		filepath.Join(base, "google-chrome-beta"),
		filepath.Join(base, "chromium"),
		filepath.Join(base, "BraveSoftware", "Brave-Browser"),
		filepath.Join(base, "microsoft-edge"),
		filepath.Join(base, "vivaldi"),
	}
}

func firefoxProfileRoots() []string {
	return []string{
		filepath.Join(xdgConfigHome(), "mozilla", "firefox"),
		filepath.Join(homeDir(), ".mozilla", "firefox"),
	}
}

func chromeConfigRootsFor(id string) []string {
	base := xdgConfigHome()
	switch id {
	case "chrome":
		return []string{filepath.Join(base, "google-chrome"), filepath.Join(base, "google-chrome-beta")}
	case "chromium":
		return []string{filepath.Join(base, "chromium")}
	case "edge":
		return []string{filepath.Join(base, "microsoft-edge")}
	case "brave":
		return []string{filepath.Join(base, "BraveSoftware", "Brave-Browser")}
	case "vivaldi":
		return []string{filepath.Join(base, "vivaldi")}
	}
	return nil
}

func platformDetectBrowsers() []string {
	var out []string
	has := func(bin string) bool {
		_, err := exec.LookPath(bin)
		return err == nil
	}
	if has("firefox") || isDir(filepath.Join(xdgConfigHome(), "mozilla", "firefox")) ||
		isDir(filepath.Join(homeDir(), ".mozilla", "firefox")) {
		out = append(out, "firefox")
	}
	checks := []struct {
		id   string
		bins []string
	}{
		{"chrome", []string{"google-chrome", "google-chrome-stable"}},
		{"chromium", []string{"chromium", "chromium-browser"}},
		{"edge", []string{"microsoft-edge", "microsoft-edge-stable"}},
		{"brave", []string{"brave", "brave-browser"}},
		{"vivaldi", []string{"vivaldi", "vivaldi-stable"}},
	}
	for _, check := range checks {
		found := false
		for _, bin := range check.bins {
			if has(bin) {
				found = true
				break
			}
		}
		if !found {
			for _, root := range chromeConfigRootsFor(check.id) {
				if isDir(root) {
					found = true
					break
				}
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
	for _, id := range browsers {
		if id == "firefox" {
			installFirefoxProfiles(firefoxProfileRoots(), paths.firefoxXPI)
			continue
		}
		if paths.chromeCRX == "" {
			continue
		}
		for _, root := range chromeConfigRootsFor(id) {
			if isDir(root) {
				_ = writeExternalExtension(root, paths.chromeCRX)
			}
		}
	}

	autostart := filepath.Join(xdgConfigHome(), "autostart", "xray-switch-helper.desktop")
	content := "[Desktop Entry]\n" +
		"Type=Application\n" +
		"Name=EXA Switch helper\n" +
		"Comment=Local VLESS helper for EXA Switch\n" +
		"Exec=" + desktopQuote(paths.helperPath) + " ensure\n" +
		"Terminal=false\n" +
		"X-GNOME-Autostart-enabled=true\n" +
		"NoDisplay=true\n"
	return writeFile(autostart, []byte(content), 0o644)
}

func platformRemoveBrowserExtensions() {
	for _, root := range chromeConfigRoots() {
		removeExternalExtension(root)
	}
	removeFirefoxProfiles(firefoxProfileRoots())
}

func platformRemoveIntegration() {
	platformRemoveBrowserExtensions()
	_ = os.Remove(filepath.Join(xdgConfigHome(), "autostart", "xray-switch-helper.desktop"))
}

func platformNotify(title, message string) {
	fmt.Printf("%s: %s\n", title, message)
	if _, err := exec.LookPath("notify-send"); err == nil {
		_ = exec.Command("notify-send", "-a", "EXA Switch", title, message).Start()
	}
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

func shellQuote(value string) string {
	return "'" + filepath.ToSlash(value) + "'"
}

func desktopQuote(value string) string {
	if len(value) > 0 && value[0] == '/' && !containsAny(value, " \t\"'\\") {
		return value
	}
	return "\"" + value + "\""
}

func containsAny(value, chars string) bool {
	for _, r := range value {
		for _, c := range chars {
			if r == c {
				return true
			}
		}
	}
	return false
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
