package main

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func (d *Daemon) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", d.auth(d.handlePing))
	mux.HandleFunc("/api/status", d.auth(d.handleStatus))
	mux.HandleFunc("/api/start", d.auth(d.handleStart))
	mux.HandleFunc("/api/stop", d.auth(d.handleStop))
	mux.HandleFunc("/api/health", d.auth(d.handleHealth))
	mux.HandleFunc("/api/logs", d.auth(d.handleLogs))
	mux.HandleFunc("/api/shutdown", d.auth(d.handleShutdown))
	return d.cors(d.hostGuard(mux))
}

func (d *Daemon) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		expected := "Bearer " + d.info.Token
		got := r.Header.Get("Authorization")
		if subtle.ConstantTimeCompare([]byte(got), []byte(expected)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		d.apiRequests.Add(1)
		d.lastAPIUnix.Store(time.Now().Unix())
		next(w, r)
	}
}

func (d *Daemon) hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		host = strings.Trim(host, "[]")
		if host != "127.0.0.1" && host != "localhost" && host != "::1" {
			writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "invalid host"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

const chromeExtensionID = "bdbbepgnedpgfieoimcbbbigkkkcfhpl"

func allowedOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	if origin == "chrome-extension://"+chromeExtensionID {
		return true
	}
	// Firefox assigns a random moz-extension:// UUID per profile, so the exact
	// origin cannot be known at build time. Every real request still needs the
	// 256-bit Bearer token.
	return strings.HasPrefix(origin, "moz-extension://")
}

func (d *Daemon) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !allowedOrigin(origin) {
				writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "forbidden origin"})
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Max-Age", "600")
			if strings.EqualFold(r.Header.Get("Access-Control-Request-Private-Network"), "true") {
				w.Header().Set("Access-Control-Allow-Private-Network", "true")
			}
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (d *Daemon) handlePing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "xray-switch",
		"version": version,
	})
}

func (d *Daemon) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, d.statusPayload())
}

func (d *Daemon) statusPayload() map[string]any {
	coreState := d.core.Status()
	payload := map[string]any{
		"ok":        true,
		"service":   "xray-switch",
		"version":   version,
		"pid":       os.Getpid(),
		"running":   coreState.Running,
		"name":      coreState.Name,
		"profileId": coreState.ProfileID,
		"socksPort": d.socksPort,
		"httpPort":  d.httpPort,
		"apiPort":   d.info.Port,
		"uptimeSec": int(time.Since(d.startedAt).Seconds()),
		"lastError": coreState.LastError,
		"apiRequests": d.apiRequests.Load(),
	}
	if last := d.lastAPIUnix.Load(); last > 0 {
		payload["lastApiAt"] = time.Unix(last, 0).UTC()
	}
	if !coreState.StartedAt.IsZero() {
		payload["coreStartedAt"] = coreState.StartedAt
		payload["coreUptimeSec"] = int(time.Since(coreState.StartedAt).Seconds())
	}
	return payload
}

func (d *Daemon) handleStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	defer r.Body.Close()
	r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)

	var req struct {
		ID       string         `json:"id"`
		Name     string         `json:"name"`
		Outbound map[string]any `json:"outbound"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON: " + err.Error()})
		return
	}
	if len(req.ID) > 200 {
		req.ID = ""
	}
	if len(req.Name) > 160 {
		req.Name = "VLESS"
	}
	if req.Name == "" {
		req.Name = "VLESS"
	}

	if d.socksPort == 0 || d.httpPort == 0 {
		if err := d.repickPorts(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
			return
		}
	}

	err := d.core.Start(req.ID, req.Name, d.socksPort, d.httpPort, req.Outbound)
	if err != nil && isAddrInUse(err) {
		if repickErr := d.repickPorts(); repickErr == nil {
			err = d.core.Start(req.ID, req.Name, d.socksPort, d.httpPort, req.Outbound)
		}
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, d.statusPayload())
}

func (d *Daemon) handleStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	d.core.Stop()
	writeJSON(w, http.StatusOK, d.statusPayload())
}

func (d *Daemon) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	target := r.URL.Query().Get("target")
	if target == "" {
		target = "https://www.gstatic.com/generate_204"
	}
	if len(target) > 2048 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "target too long"})
		return
	}
	if !d.core.Status().Running {
		writeJSON(w, http.StatusOK, healthResult{
			OK:     false,
			Target: target,
			Error:  "ядро не запущено — нажмите «Подключить»",
		})
		return
	}
	result := checkHealth(d.socksPort, target)
	writeJSON(w, http.StatusOK, result)
}

func (d *Daemon) handleLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "logs": d.logs.list(limit)})
}

func (d *Daemon) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	go func() {
		time.Sleep(150 * time.Millisecond)
		d.shutdown()
		os.Exit(0)
	}()
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		fmt.Fprintf(os.Stderr, "write json: %v\n", err)
	}
}
