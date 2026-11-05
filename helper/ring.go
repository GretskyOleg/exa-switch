package main

import (
	"sync"
	"time"
)

type logEntry struct {
	Time    time.Time `json:"time"`
	Level   string    `json:"level"`
	Message string    `json:"message"`
}

type ringLog struct {
	mu    sync.Mutex
	items []logEntry
	max   int
}

func newRingLog(max int) *ringLog {
	if max < 10 {
		max = 10
	}
	return &ringLog{items: make([]logEntry, 0, max), max: max}
}

func (r *ringLog) add(level, message string) {
	if len(message) > 4000 {
		message = message[:4000] + "…"
	}
	entry := logEntry{Time: time.Now().UTC(), Level: level, Message: message}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.items) >= r.max {
		copy(r.items, r.items[len(r.items)-r.max+1:])
		r.items = r.items[:r.max-1]
	}
	r.items = append(r.items, entry)
}

func (r *ringLog) list(limit int) []logEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	if limit <= 0 || limit > len(r.items) {
		limit = len(r.items)
	}
	out := make([]logEntry, limit)
	copy(out, r.items[len(r.items)-limit:])
	return out
}
