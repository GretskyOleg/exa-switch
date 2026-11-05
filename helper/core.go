package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	xlog "github.com/xtls/xray-core/common/log"
	"github.com/xtls/xray-core/core"
	_ "github.com/xtls/xray-core/main/distro/all"
	_ "github.com/xtls/xray-core/main/json"
)

type coreStatus struct {
	Running   bool
	Name      string
	ProfileID string
	StartedAt time.Time
	LastError string
}

type coreRunner struct {
	mu        sync.Mutex
	inst      *core.Instance
	name      string
	profileID string
	startedAt time.Time
	lastErr   string
	logs      *ringLog
}

func newCoreRunner(logs *ringLog) *coreRunner {
	return &coreRunner{logs: logs}
}

func (c *coreRunner) Start(profileID, name string, socksPort, httpPort int, outbound map[string]any) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("xray panic: %v", recovered)
			c.lastErr = err.Error()
			c.logs.add("error", err.Error())
		}
	}()

	c.mu.Lock()
	defer c.mu.Unlock()

	c.lastErr = ""

	// Validate before stopping a working core: a bad profile must not tear
	// down the current tunnel, and the helper must never execute an arbitrary
	// xray outbound (freedom/blackhole/dokodemo-door/...) supplied by a client.
	if err = validateOutbound(outbound); err != nil {
		c.lastErr = err.Error()
		c.logs.add("error", "outbound отклонён: "+err.Error())
		return err
	}

	c.stopLocked()
	outbound["tag"] = "proxy"

	cfg := buildXrayConfig(socksPort, httpPort, outbound)
	raw, err := json.Marshal(cfg)
	if err != nil {
		c.lastErr = err.Error()
		return err
	}

	parsed, err := core.LoadConfig("json", bytes.NewReader(raw))
	if err != nil {
		c.lastErr = "xray config: " + err.Error()
		c.logs.add("error", c.lastErr)
		return fmt.Errorf("%s", c.lastErr)
	}

	inst, err := core.New(parsed)
	if err != nil {
		c.lastErr = "xray init: " + err.Error()
		c.logs.add("error", c.lastErr)
		return fmt.Errorf("%s", c.lastErr)
	}

	// app/log registers itself as the global handler during core.New; replace it
	// with our capture handler so the UI can show warnings and errors.
	xlog.RegisterHandler(&captureHandler{logs: c.logs})

	if err := inst.Start(); err != nil {
		_ = inst.Close()
		c.lastErr = "xray start: " + err.Error()
		c.logs.add("error", c.lastErr)
		return fmt.Errorf("%s", c.lastErr)
	}

	c.inst = inst
	c.name = name
	c.profileID = profileID
	c.startedAt = time.Now().UTC()
	c.lastErr = ""
	c.logs.add("info", fmt.Sprintf("ядро запущено: %s (SOCKS :%d, HTTP :%d)", name, socksPort, httpPort))
	return nil
}

func (c *coreRunner) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopLocked()
}

func (c *coreRunner) stopLocked() {
	if c.inst == nil {
		return
	}
	_ = c.inst.Close()
	c.inst = nil
	c.name = ""
	c.profileID = ""
	c.startedAt = time.Time{}
	c.logs.add("info", "ядро остановлено")
}

func (c *coreRunner) Status() coreStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return coreStatus{
		Running:   c.inst != nil,
		Name:      c.name,
		ProfileID: c.profileID,
		StartedAt: c.startedAt,
		LastError: c.lastErr,
	}
}

var allowedNetworks = map[string]bool{
	"tcp": true, "ws": true, "grpc": true, "xhttp": true, "httpupgrade": true, "kcp": true,
}

var allowedSecurity = map[string]bool{
	"": true, "none": true, "tls": true, "reality": true,
}

func jsonInt(value any) (int, bool) {
	switch n := value.(type) {
	case float64:
		if math.Trunc(n) == n && n >= 0 && n <= 65535 {
			return int(n), true
		}
	case int:
		if n >= 0 && n <= 65535 {
			return n, true
		}
	case json.Number:
		if v, err := n.Int64(); err == nil && v >= 0 && v <= 65535 {
			return int(v), true
		}
	}
	return 0, false
}

func cleanString(value any, max int, field string) (string, error) {
	s, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s должен быть строкой", field)
	}
	if len(s) > max {
		return "", fmt.Errorf("%s слишком длинный", field)
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("%s содержит управляющие символы", field)
		}
	}
	return s, nil
}

// validateOutbound makes sure the helper only ever runs a VLESS client
// outbound. Without this, a caller with the API token could ask xray-core to
// start freedom/blackhole/dokodemo-door or another protocol.
func validateOutbound(outbound map[string]any) error {
	if len(outbound) == 0 {
		return fmt.Errorf("пустой outbound")
	}
	raw, err := json.Marshal(outbound)
	if err != nil {
		return fmt.Errorf("outbound не сериализуется: %w", err)
	}
	if len(raw) > 256*1024 {
		return fmt.Errorf("outbound слишком большой")
	}

	for key := range outbound {
		switch key {
		case "tag", "protocol", "settings", "streamSettings", "mux":
		default:
			return fmt.Errorf("недопустимое поле outbound: %s", key)
		}
	}

	protocol, err := cleanString(outbound["protocol"], 32, "protocol")
	if err != nil {
		return err
	}
	if protocol != "vless" {
		return fmt.Errorf("поддерживается только protocol=vless")
	}

	settings, ok := outbound["settings"].(map[string]any)
	if !ok {
		return fmt.Errorf("нет объекта settings")
	}
	for key := range settings {
		if key != "vnext" {
			return fmt.Errorf("недопустимое поле settings: %s", key)
		}
	}
	vnext, ok := settings["vnext"].([]any)
	if !ok || len(vnext) != 1 {
		return fmt.Errorf("settings.vnext должен содержать ровно один сервер")
	}
	server, ok := vnext[0].(map[string]any)
	if !ok {
		return fmt.Errorf("некорректный settings.vnext[0]")
	}
	address, err := cleanString(server["address"], 255, "address")
	if err != nil || address == "" {
		return fmt.Errorf("некорректный address")
	}
	port, ok := jsonInt(server["port"])
	if !ok || port < 1 {
		return fmt.Errorf("некорректный port")
	}
	users, ok := server["users"].([]any)
	if !ok || len(users) != 1 {
		return fmt.Errorf("settings.vnext[0].users должен содержать одного пользователя")
	}
	user, ok := users[0].(map[string]any)
	if !ok {
		return fmt.Errorf("некорректный users[0]")
	}
	id, err := cleanString(user["id"], 64, "id")
	if err != nil || id == "" {
		return fmt.Errorf("некорректный id пользователя")
	}
	for _, r := range id {
		if r == '-' || r == '_' || r == '.' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			continue
		}
		return fmt.Errorf("id содержит недопустимые символы")
	}

	if rawStream, exists := outbound["streamSettings"]; exists {
		stream, ok := rawStream.(map[string]any)
		if !ok {
			return fmt.Errorf("streamSettings должен быть объектом")
		}
		network, _ := stream["network"].(string)
		if network == "" {
			network = "tcp"
		}
		if !allowedNetworks[network] {
			return fmt.Errorf("недопустимый transport: %s", network)
		}
		security, _ := stream["security"].(string)
		if !allowedSecurity[security] {
			return fmt.Errorf("недопустимый security: %s", security)
		}
	}

	_ = port
	return nil
}

func buildXrayConfig(socksPort, httpPort int, outbound map[string]any) map[string]any {
	return map[string]any{
		"log": map[string]any{
			"loglevel": "warning",
			"access":   "none",
		},
		"inbounds": []any{
			map[string]any{
				"tag":      "socks-in",
				"listen":   "127.0.0.1",
				"port":     socksPort,
				"protocol": "socks",
				"settings": map[string]any{
					"auth": "noauth",
					"udp":  false,
					"ip":   "127.0.0.1",
				},
			},
			map[string]any{
				"tag":      "http-in",
				"listen":   "127.0.0.1",
				"port":     httpPort,
				"protocol": "http",
				"settings": map[string]any{
					"allowTransparent": false,
				},
			},
		},
		"outbounds": []any{
			outbound,
			map[string]any{
				"tag":      "direct",
				"protocol": "freedom",
				"settings": map[string]any{},
			},
			map[string]any{
				"tag":      "block",
				"protocol": "blackhole",
				"settings": map[string]any{},
			},
		},
	}
}

type captureHandler struct {
	logs *ringLog
}

func (h *captureHandler) Handle(msg xlog.Message) {
	switch m := msg.(type) {
	case *xlog.AccessMessage:
		return
	case *xlog.GeneralMessage:
		if m.Severity == xlog.Severity_Warning || m.Severity == xlog.Severity_Error {
			h.logs.add(strings.ToLower(m.Severity.String()), m.String())
		}
	default:
		h.logs.add("info", msg.String())
	}
}
