package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	appVersion     = "0.1.2"
	chromeID       = "bdbbepgnedpgfieoimcbbbigkkkcfhpl"
	firefoxID      = "xray-switch@oleg.dev"
	nativeHostName = "com.oleg.xray_switch"
	payloadMagic   = "XSWPAY01"
)

type options struct {
	uninstall   bool
	purge       bool
	silent      bool
	noOpen      bool
	help        bool
	browsers    string
	allBrowsers bool
	noBrowsers  bool
}

type payload struct {
	files  []*zip.File
	closer io.Closer
}

func (p *payload) Close() {
	if p != nil && p.closer != nil {
		_ = p.closer.Close()
	}
}

type installPaths struct {
	dataDir    string
	helperPath string
	chromeDir  string
	firefoxDir string
	setupPath  string
	firefoxXPI string
	chromeCRX  string
}

func main() {
	opts := parseArgs()
	if opts.help {
		fmt.Println("EXA Switch setup")
		fmt.Println("  --browsers=LIST  comma separated: firefox,chrome,chromium,edge,brave,vivaldi")
		fmt.Println("  --all-browsers   install the extension into every detected browser")
		fmt.Println("  --no-browsers    do not install browser extensions")
		fmt.Println("  --uninstall      remove helper, native manifests and extension files")
		fmt.Println("  --purge          with --uninstall also remove helper config/logs")
		fmt.Println("  --silent         no prompts, default to Firefox if detected")
		fmt.Println("  --no-open        install but do not open the setup page")
		return
	}
	if opts.uninstall {
		uninstall(opts)
		return
	}
	if err := install(opts); err != nil {
		platformFail("EXA Switch setup failed:\n\n" + err.Error())
		platformLog("ERROR: " + err.Error())
		if !opts.silent {
			platformWait(opts)
		}
		os.Exit(1)
	}
	platformWait(opts)
}

func parseArgs() options {
	var o options
	for _, arg := range os.Args[1:] {
		lower := strings.ToLower(arg)
		switch {
		case lower == "--uninstall" || lower == "/uninstall" || lower == "-uninstall":
			o.uninstall = true
		case lower == "--purge" || lower == "/purge":
			o.purge = true
		case lower == "--silent" || lower == "/silent" || lower == "/s":
			o.silent = true
		case lower == "--no-open" || lower == "/no-open":
			o.noOpen = true
		case lower == "--help" || lower == "/?" || lower == "-h":
			o.help = true
		case lower == "--all-browsers" || lower == "/all-browsers":
			o.allBrowsers = true
		case lower == "--no-browsers" || lower == "/no-browsers":
			o.noBrowsers = true
		case strings.HasPrefix(lower, "--browsers=") ||
			strings.HasPrefix(lower, "/browsers=") ||
			strings.HasPrefix(lower, "--browser=") ||
			strings.HasPrefix(lower, "/browser="):
			if parts := strings.SplitN(arg, "=", 2); len(parts) == 2 {
				o.browsers = parts[1]
			}
		}
	}
	return o
}

func chooseBrowsers(opts options, available []string) []string {
	if opts.noBrowsers {
		return nil
	}
	if opts.allBrowsers {
		return append([]string(nil), available...)
	}
	if strings.TrimSpace(opts.browsers) != "" {
		return parseBrowserSelection(opts.browsers, available)
	}
	if opts.silent {
		for _, id := range available {
			if id == "firefox" {
				return []string{"firefox"}
			}
		}
		return append([]string(nil), available...)
	}
	if len(available) == 0 {
		fmt.Println("Браузеры не обнаружены. Расширение можно установить позже вручную.")
		return nil
	}

	fmt.Println()
	fmt.Println("Обнаружены браузеры:")
	for i, id := range available {
		fmt.Printf("  %d) %s\n", i+1, browserName(id))
	}
	fmt.Print("Куда установить расширение? [1,2 / all / none] (Enter = Firefox, если есть): ")
	reader := bufio.NewReader(os.Stdin)
	line, _ := reader.ReadString('\n')
	line = strings.TrimSpace(line)
	if line == "" {
		for _, id := range available {
			if id == "firefox" {
				return []string{"firefox"}
			}
		}
		return append([]string(nil), available...)
	}
	return parseSelectionInput(line, available)
}

func parseSelectionInput(line string, available []string) []string {
	lower := strings.ToLower(strings.TrimSpace(line))
	if lower == "all" || lower == "*" {
		return append([]string(nil), available...)
	}
	if lower == "none" || lower == "0" {
		return nil
	}
	parts := strings.FieldsFunc(lower, func(r rune) bool {
		return r == ',' || r == ' ' || r == ';'
	})
	var out []string
	for _, part := range parts {
		if n, err := strconv.Atoi(part); err == nil {
			if n >= 1 && n <= len(available) {
				out = append(out, available[n-1])
			}
			continue
		}
		if id := browserAliases[part]; id != "" {
			out = append(out, id)
		}
	}
	return dedupeBrowserIDs(out)
}

func install(opts options) error {
	dataDir := platformDataDir()
	if dataDir == "" {
		return fmt.Errorf("cannot determine the user data directory")
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}

	helperPath := filepath.Join(dataDir, helperName())
	stopHelper(helperPath)

	p, err := openPayload()
	if err != nil {
		return err
	}
	defer p.Close()

	paths, err := installPayload(p, dataDir, helperPath)
	if err != nil {
		return err
	}

	if err := platformWriteManifests(dataDir, helperPath); err != nil {
		return fmt.Errorf("cannot register native messaging: %w", err)
	}

	available := platformDetectBrowsers()
	selected := chooseBrowsers(opts, available)
	if err := platformPostInstall(paths, selected); err != nil {
		platformLog("browser integration warning: " + err.Error())
	}

	if err := platformCreateShortcuts(paths.setupPath, paths.chromeDir); err != nil {
		platformLog("shortcut warning: " + err.Error())
	}

	if err := runHelper(helperPath, "ensure"); err != nil {
		return fmt.Errorf("helper did not start: %w", err)
	}

	platformLog("installed to " + dataDir)
	fmt.Println()
	fmt.Println("EXA Switch installed.")
	fmt.Println("  Helper:      " + helperPath)
	fmt.Println("  Chrome dir:  " + paths.chromeDir)
	fmt.Println("  Firefox dir: " + paths.firefoxDir)
	fmt.Println("  Setup page:  " + paths.setupPath)
	if len(selected) == 0 {
		fmt.Println("  Extensions:  не выбраны (--no-browsers / none)")
	} else {
		names := make([]string, 0, len(selected))
		for _, id := range selected {
			names = append(names, browserName(id))
		}
		fmt.Println("  Extensions:  " + strings.Join(names, ", "))
	}

	if !opts.silent && !opts.noOpen && hasChromeFamily(selected) {
		if err := platformOpenSetup(paths.setupPath); err != nil {
			fmt.Println("Open the setup page manually: " + paths.setupPath)
		}
	}
	platformNotify("EXA Switch", "Helper installed. Restart the selected browser(s).")
	return nil
}

func uninstall(opts options) {
	dataDir := platformDataDir()
	helperPath := filepath.Join(dataDir, helperName())
	stopHelper(helperPath)
	platformRemoveIntegration()
	platformRemoveManifests()
	platformRemoveShortcuts()
	_ = os.RemoveAll(dataDir)
	if opts.purge {
		_ = os.RemoveAll(platformConfigDir())
	}
	fmt.Println("EXA Switch removed.")
	if !opts.purge {
		fmt.Println("User config and logs in", platformConfigDir(), "were kept (use --purge to delete).")
	}
}

func stopHelper(helper string) {
	if _, err := os.Stat(helper); err == nil {
		_ = runHelper(helper, "stop")
		time.Sleep(300 * time.Millisecond)
	}
}

func runHelper(helper string, args ...string) error {
	cmd := exec.Command(helper, args...)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w (%s)", helper, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func openPayload() (*payload, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		return nil, err
	}
	if len(data) >= 16 && string(data[len(data)-8:]) == payloadMagic {
		size := binary.LittleEndian.Uint64(data[len(data)-16 : len(data)-8])
		if size > 0 && size <= uint64(len(data)-16) {
			start := len(data) - 16 - int(size)
			zr, err := zip.NewReader(bytes.NewReader(data[start:len(data)-16]), int64(size))
			if err == nil {
				return &payload{files: zr.File}, nil
			}
		}
	}

	candidates := []string{
		filepath.Join(filepath.Dir(exe), "payload.zip"),
		filepath.Join(filepath.Dir(exe), "..", "Resources", "payload.zip"),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err != nil {
			continue
		}
		zr, err := zip.OpenReader(candidate)
		if err != nil {
			return nil, err
		}
		return &payload{files: zr.File, closer: zr}, nil
	}
	return nil, fmt.Errorf("installer payload not found")
}

func installPayload(p *payload, dataDir, helperPath string) (installPaths, error) {
	tmp := filepath.Join(dataDir, ".install-tmp")
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return installPaths{}, err
	}
	defer os.RemoveAll(tmp)

	for _, f := range p.files {
		if err := extractZipFile(f, tmp); err != nil {
			return installPaths{}, err
		}
	}

	helperSrc := filepath.Join(tmp, "helper", helperName())
	if _, err := os.Stat(helperSrc); err != nil {
		return installPaths{}, fmt.Errorf("payload has no helper for this platform")
	}
	_ = os.Remove(helperPath)
	if err := copyFile(helperSrc, helperPath, 0o755); err != nil {
		return installPaths{}, err
	}

	extensionDst := filepath.Join(dataDir, "extension")
	_ = os.RemoveAll(extensionDst)
	extensionSrc := filepath.Join(tmp, "extension")
	if err := os.Rename(extensionSrc, extensionDst); err != nil {
		if err := copyDir(extensionSrc, extensionDst); err != nil {
			return installPaths{}, err
		}
	}

	brandingDst := filepath.Join(dataDir, "branding")
	_ = os.RemoveAll(brandingDst)
	if err := copyDir(filepath.Join(tmp, "branding"), brandingDst); err != nil {
		return installPaths{}, err
	}

	template, err := os.ReadFile(filepath.Join(tmp, "setup.html"))
	if err != nil {
		return installPaths{}, fmt.Errorf("payload has no setup page")
	}
	chromeDir := filepath.Join(extensionDst, "chrome")
	firefoxDir := filepath.Join(extensionDst, "firefox")
	setupPath := filepath.Join(dataDir, "setup.html")
	setup := renderSetup(string(template), dataDir, helperPath, chromeDir, firefoxDir)
	if err := os.WriteFile(setupPath, []byte(setup), 0o644); err != nil {
		return installPaths{}, err
	}

	for _, name := range []string{"README-INSTALL.txt", "LICENSE", "THIRD_PARTY.md"} {
		src := filepath.Join(tmp, name)
		if _, err := os.Stat(src); err == nil {
			if err := copyFile(src, filepath.Join(dataDir, name), 0o644); err != nil {
				return installPaths{}, err
			}
		}
	}

	firefoxXPI := ""
	chromeCRX := ""
	for _, item := range []struct{ src, dst string }{
		{"exa-switch-firefox-signed.xpi", "exa-switch-firefox.xpi"},
		{"exa-switch-chrome.crx", "exa-switch.crx"},
	} {
		src := filepath.Join(tmp, item.src)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		dst := filepath.Join(dataDir, item.dst)
		if err := copyFile(src, dst, 0o644); err != nil {
			return installPaths{}, err
		}
		if item.dst == "exa-switch-firefox.xpi" {
			firefoxXPI = dst
		} else {
			chromeCRX = dst
		}
	}

	return installPaths{
		dataDir:    dataDir,
		helperPath: helperPath,
		chromeDir:  chromeDir,
		firefoxDir: firefoxDir,
		setupPath:  setupPath,
		firefoxXPI: firefoxXPI,
		chromeCRX:  chromeCRX,
	}, nil
}

func extractZipFile(f *zip.File, dstRoot string) error {
	name := filepath.ToSlash(f.Name)
	name = strings.TrimPrefix(name, "./")
	clean := filepath.Clean(filepath.FromSlash(name))
	if clean == "." || filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") {
		return fmt.Errorf("unsafe payload path: %s", f.Name)
	}
	dst := filepath.Join(dstRoot, clean)
	if f.FileInfo().IsDir() {
		return os.MkdirAll(dst, 0o755)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	src, err := f.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, src)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chmod(dst, mode)
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target, info.Mode().Perm())
	})
}

func renderSetup(template, dataDir, helperPath, chromeDir, firefoxDir string) string {
	replacer := strings.NewReplacer(
		"{{VERSION}}", appVersion,
		"{{PLATFORM}}", platformName(),
		"{{DATA_DIR}}", html.EscapeString(dataDir),
		"{{HELPER}}", html.EscapeString(helperPath),
		"{{CHROME_DIR}}", html.EscapeString(chromeDir),
		"{{FIREFOX_DIR}}", html.EscapeString(firefoxDir),
		"{{CHROME_ID}}", chromeID,
		"{{FIREFOX_ID}}", firefoxID,
		"{{GENERATED_AT}}", time.Now().Format("2006-01-02 15:04"),
	)
	return replacer.Replace(template)
}

func chromeManifest(helperPath string) []byte {
	data := map[string]any{
		"name":            nativeHostName,
		"description":     "EXA Switch local helper (xray-core)",
		"path":            helperPath,
		"type":            "stdio",
		"allowed_origins": []string{"chrome-extension://" + chromeID + "/"},
	}
	out, _ := json.MarshalIndent(data, "", "  ")
	return append(out, '\n')
}

func firefoxManifest(helperPath string) []byte {
	data := map[string]any{
		"name":               nativeHostName,
		"description":        "EXA Switch local helper (xray-core)",
		"path":               helperPath,
		"type":               "stdio",
		"allowed_extensions": []string{firefoxID},
	}
	out, _ := json.MarshalIndent(data, "", "  ")
	return append(out, '\n')
}

func writeFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}

func waitForEnter() {
	fmt.Print("\nPress Enter to close...")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}

func platformWait(opts options) {
	if opts.silent {
		return
	}
	platformSpecificWait()
}
