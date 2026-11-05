package main

// Shared browser-integration helpers used by the platform_*.go files.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const firefoxUserPref = `user_pref("extensions.autoDisableScopes", 0);`

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

var browserNames = map[string]string{
	"firefox":  "Firefox",
	"chrome":   "Google Chrome",
	"chromium": "Chromium",
	"edge":     "Microsoft Edge",
	"brave":    "Brave",
	"vivaldi":  "Vivaldi",
}

var browserAliases = map[string]string{
	"firefox": "firefox", "ff": "firefox", "mozilla": "firefox",
	"chrome": "chrome", "google-chrome": "chrome", "googlechrome": "chrome",
	"chromium": "chromium",
	"edge": "edge", "msedge": "edge", "microsoft-edge": "edge",
	"brave": "brave", "brave-browser": "brave",
	"vivaldi": "vivaldi",
}

func browserName(id string) string {
	if name, ok := browserNames[id]; ok {
		return name
	}
	return id
}

func dedupeBrowserIDs(ids []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = browserAliases[strings.ToLower(strings.TrimSpace(id))]
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

func parseBrowserSelection(value string, available []string) []string {
	lower := strings.ToLower(strings.TrimSpace(value))
	if lower == "all" || lower == "*" {
		return append([]string(nil), available...)
	}
	if lower == "none" || lower == "0" {
		return nil
	}
	parts := strings.FieldsFunc(lower, func(r rune) bool {
		return r == ',' || r == ' ' || r == ';'
	})
	return dedupeBrowserIDs(parts)
}

func hasChromeFamily(ids []string) bool {
	for _, id := range ids {
		if id != "firefox" {
			return true
		}
	}
	return false
}


// profileDirs returns Firefox profile directories under a Profiles/ root that
// already contain profile data.
func profileDirs(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		if fileExists(filepath.Join(dir, "prefs.js")) || fileExists(filepath.Join(dir, "times.json")) {
			out = append(out, dir)
		}
	}
	return out
}

func installFirefoxXPI(profile, xpi string) error {
	if xpi == "" {
		return nil
	}
	extDir := filepath.Join(profile, "extensions")
	if err := os.MkdirAll(extDir, 0o755); err != nil {
		return err
	}
	if err := copyFile(xpi, filepath.Join(extDir, "xray-switch@oleg.dev.xpi"), 0o644); err != nil {
		return err
	}

	userJS := filepath.Join(profile, "user.js")
	data, _ := os.ReadFile(userJS)
	if strings.Contains(string(data), "extensions.autoDisableScopes") {
		return nil
	}
	f, err := os.OpenFile(userJS, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if len(data) > 0 && data[len(data)-1] != '\n' {
		if _, err := f.WriteString("\n"); err != nil {
			return err
		}
	}
	_, err = f.WriteString(firefoxUserPref + "\n")
	return err
}

func removeFirefoxXPI(profile string) {
	_ = os.Remove(filepath.Join(profile, "extensions", "xray-switch@oleg.dev.xpi"))
	userJS := filepath.Join(profile, "user.js")
	data, err := os.ReadFile(userJS)
	if err != nil {
		return
	}
	lines := strings.Split(string(data), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) != firefoxUserPref {
			kept = append(kept, line)
		}
	}
	rest := strings.TrimSpace(strings.Join(kept, "\n"))
	if rest == "" {
		_ = os.Remove(userJS)
		return
	}
	_ = os.WriteFile(userJS, []byte(strings.Join(kept, "\n")), 0o644)
}

// writeExternalExtension creates Chrome's per-user external-extension JSON:
// <config>/External Extensions/<id>.json
func writeExternalExtension(configRoot, crx string) error {
	if crx == "" {
		return nil
	}
	dir := filepath.Join(configRoot, "External Extensions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	payload := map[string]string{
		"external_crx":     crx,
		"external_version": appVersion,
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, chromeID+".json"), append(data, '\n'), 0o644)
}

func removeExternalExtension(configRoot string) {
	_ = os.Remove(filepath.Join(configRoot, "External Extensions", chromeID+".json"))
}

func installFirefoxProfiles(roots []string, xpi string) {
	for _, root := range roots {
		for _, profile := range profileDirs(root) {
			_ = installFirefoxXPI(profile, xpi)
		}
	}
}

func removeFirefoxProfiles(roots []string) {
	for _, root := range roots {
		for _, profile := range profileDirs(root) {
			removeFirefoxXPI(profile)
		}
	}
}
