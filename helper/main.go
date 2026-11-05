package main

import (
	"encoding/json"
	"fmt"
	"os"
)

const nativeHostName = "com.oleg.xray_switch"

// Overridden with -ldflags "-X main.version=..." by build.sh.
var version = "0.1.0"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "daemon":
			runDaemon()
			return
		case "ensure":
			runEnsureCommand()
			return
		case "native":
			runNative()
			return
		case "stop":
			stopDaemon()
			return
		case "status":
			printDaemonStatus()
			return
		case "version":
			fmt.Println(version)
			return
		}
	}
	// Chrome/Firefox invoke the native host with the caller origin as an argument,
	// so anything unknown is treated as native messaging mode.
	runNative()
}

func runEnsureCommand() {
	info, err := ensureDaemon()
	if err != nil {
		writeStdoutJSON(nativeResponse{OK: false, Error: err.Error()})
		os.Exit(1)
	}
	writeStdoutJSON(nativeResponse{OK: true, Daemon: info})
}

func writeStdoutJSON(value any) {
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = os.Stdout.Write(append(data, '\n'))
}
