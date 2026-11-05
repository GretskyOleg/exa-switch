package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

type nativeResponse struct {
	OK     bool        `json:"ok"`
	Error  string      `json:"error,omitempty"`
	Daemon *daemonInfo `json:"daemon,omitempty"`
}

func readNativeMessage(r io.Reader) ([]byte, error) {
	var length uint32
	if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
		return nil, err
	}
	if length == 0 || length > 8*1024*1024 {
		return nil, fmt.Errorf("invalid native message length: %d", length)
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func writeNativeMessage(w io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(data)))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

func runNative() {
	request, err := readNativeMessage(os.Stdin)
	if err != nil {
		return
	}

	var msg struct {
		Cmd string `json:"cmd"`
	}
	if err := json.Unmarshal(request, &msg); err != nil {
		_ = writeNativeMessage(os.Stdout, nativeResponse{OK: false, Error: "invalid JSON: " + err.Error()})
		return
	}

	switch msg.Cmd {
	case "", "ensure", "ping", "status":
		info, err := ensureDaemon()
		if err != nil {
			_ = writeNativeMessage(os.Stdout, nativeResponse{OK: false, Error: err.Error()})
			return
		}
		_ = writeNativeMessage(os.Stdout, nativeResponse{OK: true, Daemon: info})
	default:
		_ = writeNativeMessage(os.Stdout, nativeResponse{OK: false, Error: "unknown command: " + msg.Cmd})
	}
}
