package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gofrs/flock"
)

type Daemon struct {
	info      *daemonInfo
	core      *coreRunner
	logs      *ringLog
	socksPort int
	httpPort  int
	startedAt time.Time
	lock      *flock.Flock
	srv       *http.Server

	apiRequests atomic.Uint64
	lastAPIUnix atomic.Int64

	shutdownOnce sync.Once
}

func runDaemon() {
	dir, err := appDir()
	if err != nil {
		log.Fatalf("cannot create config dir: %v", err)
	}

	lock := flock.New(filepath.Join(dir, "daemon.lock"))
	locked, err := lock.TryLock()
	if err != nil {
		log.Fatalf("cannot lock daemon: %v", err)
	}
	if !locked {
		return
	}
	defer func() { _ = lock.Unlock() }()

	ports, err := freePorts(2)
	if err != nil {
		log.Fatalf("cannot allocate ports: %v", err)
	}

	token, err := randomToken()
	if err != nil {
		log.Fatalf("cannot generate token: %v", err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("cannot listen on loopback: %v", err)
	}

	apiPort := listener.Addr().(*net.TCPAddr).Port
	d := &Daemon{
		info: &daemonInfo{
			Port:      apiPort,
			Token:     token,
			PID:       os.Getpid(),
			Version:   version,
			StartedAt: time.Now().UTC(),
		},
		logs:      newRingLog(1000),
		socksPort: ports[0],
		httpPort:  ports[1],
		startedAt: time.Now().UTC(),
		lock:      lock,
	}
	d.core = newCoreRunner(d.logs)

	if err := writeJSONAtomic(mustInfoPath(), d.info); err != nil {
		log.Fatalf("cannot write daemon info: %v", err)
	}
	defer removeInfoIfMine(d.info)

	log.Printf("helper %s started: api :%d, socks :%d, http :%d", version, apiPort, d.socksPort, d.httpPort)
	d.logs.add("info", fmt.Sprintf("helper %s запущен: api :%d, socks :%d, http :%d",
		version, apiPort, d.socksPort, d.httpPort))

	d.srv = &http.Server{
		Handler:           d.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       20 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	go func() {
		if err := d.srv.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("api server stopped: %v", err)
		}
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	<-signals
	d.shutdown()
}

func (d *Daemon) shutdown() {
	d.shutdownOnce.Do(func() {
		log.Printf("helper stopping")
		d.logs.add("info", "helper останавливается")
		d.core.Stop()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		if d.srv != nil {
			_ = d.srv.Shutdown(ctx)
		}
		cancel()
		removeInfoIfMine(d.info)
	})
}

func (d *Daemon) repickPorts() error {
	ports, err := freePorts(2)
	if err != nil {
		return err
	}
	d.socksPort = ports[0]
	d.httpPort = ports[1]
	return nil
}

func mustInfoPath() string {
	path, err := infoPath()
	if err != nil {
		log.Fatalf("cannot resolve daemon info path: %v", err)
	}
	return path
}
