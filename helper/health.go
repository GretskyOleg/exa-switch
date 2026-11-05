package main

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type healthResult struct {
	OK         bool   `json:"ok"`
	Target     string `json:"target"`
	LatencyMs  int64  `json:"latencyMs,omitempty"`
	StatusCode int    `json:"status,omitempty"`
	StatusText string `json:"statusText,omitempty"`
	Error      string `json:"error,omitempty"`
}

func checkHealth(socksPort int, target string) healthResult {
	result := healthResult{Target: target}
	if socksPort <= 0 {
		result.Error = "SOCKS-порт не выделен"
		return result
	}

	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		result.Error = "нужен http(s)-URL"
		return result
	}

	host := u.Hostname()
	port := 80
	if u.Scheme == "https" {
		port = 443
	}
	if rawPort := u.Port(); rawPort != "" {
		if parsed, err := strconv.Atoi(rawPort); err == nil && parsed > 0 && parsed < 65536 {
			port = parsed
		}
	}

	start := time.Now()
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", socksPort), 4*time.Second)
	if err != nil {
		result.Error = "не удалось подключиться к локальному SOCKS: " + err.Error()
		return result
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))

	if err := socksConnect(conn, host, port); err != nil {
		result.Error = err.Error()
		return result
	}

	var stream io.ReadWriter = conn
	if u.Scheme == "https" {
		tlsConn := tls.Client(conn, &tls.Config{
			ServerName: host,
			MinVersion: tls.VersionTLS12,
		})
		if err := tlsConn.Handshake(); err != nil {
			result.Error = "TLS handshake: " + err.Error()
			return result
		}
		stream = tlsConn
	}

	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	req.Header.Set("User-Agent", "XraySwitch/"+version)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Connection", "close")

	if err := req.Write(stream); err != nil {
		result.Error = "HTTP request: " + err.Error()
		return result
	}

	resp, err := http.ReadResponse(bufio.NewReader(stream), req)
	if err != nil {
		result.Error = "HTTP response: " + err.Error()
		return result
	}
	defer resp.Body.Close()

	result.LatencyMs = time.Since(start).Milliseconds()
	result.StatusCode = resp.StatusCode
	result.StatusText = resp.Status
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		result.Error = "HTTP " + resp.Status
		return result
	}

	result.OK = true
	return result
}

func socksConnect(conn net.Conn, host string, port int) error {
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return fmt.Errorf("SOCKS handshake: %w", err)
	}
	var greeting [2]byte
	if _, err := io.ReadFull(conn, greeting[:]); err != nil {
		return fmt.Errorf("SOCKS handshake: %w", err)
	}
	if greeting[0] != 0x05 || greeting[1] != 0x00 {
		return fmt.Errorf("SOCKS5: сервер не принял no-auth")
	}

	request := []byte{0x05, 0x01, 0x00}
	if ip := net.ParseIP(host); ip != nil {
		if ip4 := ip.To4(); ip4 != nil {
			request = append(request, 0x01)
			request = append(request, ip4...)
		} else {
			request = append(request, 0x04)
			request = append(request, ip.To16()...)
		}
	} else {
		if len(host) == 0 || len(host) > 255 {
			return fmt.Errorf("SOCKS5: некорректный домен")
		}
		request = append(request, 0x03, byte(len(host)))
		request = append(request, []byte(host)...)
	}
	request = append(request, byte(port>>8), byte(port))

	if _, err := conn.Write(request); err != nil {
		return fmt.Errorf("SOCKS connect: %w", err)
	}

	var reply [4]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil {
		return fmt.Errorf("SOCKS connect: %w", err)
	}
	if reply[0] != 0x05 {
		return fmt.Errorf("SOCKS5: некорректный ответ")
	}
	if reply[1] != 0x00 {
		return fmt.Errorf("SOCKS5 CONNECT отклонён (код %d)", reply[1])
	}

	var addressLength int
	switch reply[3] {
	case 0x01:
		addressLength = 4
	case 0x03:
		var length [1]byte
		if _, err := io.ReadFull(conn, length[:]); err != nil {
			return fmt.Errorf("SOCKS reply: %w", err)
		}
		addressLength = int(length[0])
	case 0x04:
		addressLength = 16
	default:
		return fmt.Errorf("SOCKS5: неизвестный тип адреса %d", reply[3])
	}
	if addressLength > 0 {
		if _, err := io.CopyN(io.Discard, conn, int64(addressLength)); err != nil {
			return fmt.Errorf("SOCKS reply: %w", err)
		}
	}
	if _, err := io.CopyN(io.Discard, conn, 2); err != nil {
		return fmt.Errorf("SOCKS reply: %w", err)
	}
	return nil
}
