//go:build darwin

package main

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func platformName() string { return "macOS" }

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return os.Getenv("HOME")
}

func platformDataDir() string {
	return filepath.Join(homeDir(), "Library", "Application Support", "xray-switch")
}

func platformConfigDir() string { return platformDataDir() }
func helperName() string        { return "xray-switch-helper" }

func chromeDirs() []string {
	base := filepath.Join(homeDir(), "Library", "Application Support")
	return []string{
		filepath.Join(base, "Google", "Chrome", "NativeMessagingHosts"),
		filepath.Join(base, "Google", "Chrome Canary", "NativeMessagingHosts"),
		filepath.Join(base, "Chromium", "NativeMessagingHosts"),
		filepath.Join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
		filepath.Join(base, "Microsoft Edge", "NativeMessagingHosts"),
		filepath.Join(base, "Vivaldi", "NativeMessagingHosts"),
	}
}

func firefoxDirs() []string {
	return []string{
		filepath.Join(homeDir(), "Library", "Application Support", "Mozilla", "NativeMessagingHosts"),
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
	desk := filepath.Join(homeDir(), "Desktop")
	if !isDir(desk) {
		return nil
	}
	fileURL := (&url.URL{Scheme: "file", Path: filepath.ToSlash(setupPath)}).String()
	webloc := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>` + xmlEscape(fileURL) + `</string></dict></plist>
`
	return writeFile(filepath.Join(desk, "EXA Switch Setup.webloc"), []byte(webloc), 0o644)
}

func platformRemoveShortcuts() {
	_ = os.Remove(filepath.Join(homeDir(), "Desktop", "EXA Switch Setup.webloc"))
}

func platformOpenSetup(setupPath string) error {
	return exec.Command("open", setupPath).Start()
}

func chromeConfigRoots() []string {
	base := filepath.Join(homeDir(), "Library", "Application Support")
	return []string{
		filepath.Join(base, "Google", "Chrome"),
		filepath.Join(base, "Google", "Chrome Canary"),
		filepath.Join(base, "Chromium"),
		filepath.Join(base, "BraveSoftware", "Brave-Browser"),
		filepath.Join(base, "Microsoft Edge"),
		filepath.Join(base, "Vivaldi"),
	}
}

func firefoxProfileRoots() []string {
	return []string{filepath.Join(homeDir(), "Library", "Application Support", "Firefox", "Profiles")}
}

func chromeConfigRootsFor(id string) []string {
	base := filepath.Join(homeDir(), "Library", "Application Support")
	switch id {
	case "chrome":
		return []string{filepath.Join(base, "Google", "Chrome"), filepath.Join(base, "Google", "Chrome Canary")}
	case "chromium":
		return []string{filepath.Join(base, "Chromium")}
	case "edge":
		return []string{filepath.Join(base, "Microsoft Edge")}
	case "brave":
		return []string{filepath.Join(base, "BraveSoftware", "Brave-Browser")}
	case "vivaldi":
		return []string{filepath.Join(base, "Vivaldi")}
	}
	return nil
}

func platformDetectBrowsers() []string {
	var out []string
	if isDir(filepath.Join(homeDir(), "Library", "Application Support", "Firefox", "Profiles")) ||
		isDir("/Applications/Firefox.app") {
		out = append(out, "firefox")
	}
	checks := []struct {
		id  string
		app string
	}{
		{"chrome", "/Applications/Google Chrome.app"},
		{"chromium", "/Applications/Chromium.app"},
		{"edge", "/Applications/Microsoft Edge.app"},
		{"brave", "/Applications/Brave Browser.app"},
		{"vivaldi", "/Applications/Vivaldi.app"},
	}
	for _, check := range checks {
		found := isDir(check.app)
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
			if installFirefoxProfiles(firefoxProfileRoots(), paths.firefoxXPI) == 0 {
				fmt.Println("  ! Firefox: профиль не найден. Запустите Firefox один раз и повторите установку.")
			}
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

	dir := filepath.Join(homeDir(), "Library", "LaunchAgents")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.oleg.xray-switch</string>
<key>ProgramArguments</key><array><string>` + xmlEscape(paths.helperPath) + `</string><string>ensure</string></array>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`
	return writeFile(filepath.Join(dir, "com.oleg.xray-switch.plist"), []byte(plist), 0o644)
}

func platformRemoveBrowserExtensions() {
	for _, root := range chromeConfigRoots() {
		removeExternalExtension(root)
	}
	removeFirefoxProfiles(firefoxProfileRoots())
}

func platformRemoveIntegration() {
	platformRemoveBrowserExtensions()
	_ = os.Remove(filepath.Join(homeDir(), "Library", "LaunchAgents", "com.oleg.xray-switch.plist"))
}

func platformNotify(title, message string) {
	script := fmt.Sprintf(`display notification %s with title %s`, appleScriptQuote(message), appleScriptQuote(title))
	_ = exec.Command("osascript", "-e", script).Start()
}

func platformFail(message string) {
	fmt.Fprintln(os.Stderr, message)
	script := fmt.Sprintf(`display dialog %s buttons {"OK"} with title "EXA Switch" default button "OK" with icon caution`,
		appleScriptQuote(message))
	_ = exec.Command("osascript", "-e", script).Run()
}

func platformLog(message string) {
	dir := filepath.Join(homeDir(), "Library", "Logs")
	_ = os.MkdirAll(dir, 0o755)
	f, err := os.OpenFile(filepath.Join(dir, "EXA-Switch-Setup.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), message)
}

func platformSpecificWait() {}

func appleScriptQuote(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return `"` + value + `"`
}

func xmlEscape(value string) string {
	value = strings.ReplaceAll(value, "&", "&amp;")
	value = strings.ReplaceAll(value, "<", "&lt;")
	value = strings.ReplaceAll(value, ">", "&gt;")
	value = strings.ReplaceAll(value, `"`, "&quot;")
	return value
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
