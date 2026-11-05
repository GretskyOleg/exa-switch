package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

func ensureDaemon() (*daemonInfo, error) {
	if info, err := readDaemonInfo(); err == nil && pingDaemon(info) {
		return info, nil
	}

	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("cannot locate helper binary: %w", err)
	}

	logFile, err := logPath()
	if err != nil {
		return nil, err
	}
	lf, err := os.OpenFile(logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("cannot open helper log: %w", err)
	}

	cmd := exec.Command(exe, "daemon")
	cmd.Stdout = lf
	cmd.Stderr = lf
	cmd.Stdin = nil
	detach(cmd)

	if err := cmd.Start(); err != nil {
		_ = lf.Close()
		return nil, fmt.Errorf("cannot start helper daemon: %w", err)
	}
	_ = cmd.Process.Release()
	_ = lf.Close()

	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		info, err := readDaemonInfo()
		if err != nil {
			continue
		}
		if pingDaemon(info) {
			return info, nil
		}
	}

	return nil, fmt.Errorf("helper did not start within 12s; see %s", filepath.Clean(logFile))
}

func stopDaemon() {
	info, err := readDaemonInfo()
	if err != nil {
		fmt.Println("helper is not running")
		return
	}
	client := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/api/shutdown", info.Port), nil)
	if err != nil {
		fmt.Println("cannot build shutdown request:", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+info.Token)
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("cannot stop helper:", err)
		return
	}
	_ = resp.Body.Close()

	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		if !pingDaemon(info) {
			fmt.Println("helper stopped")
			return
		}
	}
	fmt.Println("shutdown requested, but helper is still responding")
}

func printDaemonStatus() {
	info, err := readDaemonInfo()
	if err != nil {
		writeStdoutJSON(nativeResponse{OK: false, Error: "helper is not running"})
		return
	}
	client := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/api/status", info.Port), nil)
	if err != nil {
		writeStdoutJSON(nativeResponse{OK: false, Error: err.Error()})
		return
	}
	req.Header.Set("Authorization", "Bearer "+info.Token)
	resp, err := client.Do(req)
	if err != nil {
		writeStdoutJSON(nativeResponse{OK: false, Error: err.Error()})
		return
	}
	defer resp.Body.Close()
	var payload any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		writeStdoutJSON(nativeResponse{OK: false, Error: err.Error()})
		return
	}
	writeStdoutJSON(payload)
}

func pingDaemon(info *daemonInfo) bool {
	if info == nil || info.Port <= 0 || info.Token == "" {
		return false
	}
	client := &http.Client{Timeout: 1200 * time.Millisecond}
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/api/ping", info.Port), nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+info.Token)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var out struct {
		OK      bool   `json:"ok"`
		Service string `json:"service"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false
	}
	return out.OK && out.Service == "xray-switch"
}
