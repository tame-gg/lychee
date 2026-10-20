package control

import (
	"runtime"
	"testing"
	"time"
)

func TestSessionCloseStopsWriter(t *testing.T) {
	h := startHarness(t, nil)
	h.settle()
	base := runtime.NumGoroutine()
	c := h.dial()
	c.hello()
	c.sendRaw([]byte(`{"id":2,"cmd":"status"}` + "\n" + `{"id":2,"cmd":"status"}` + "\n"))
	c.expectEOF()
	deadline := time.Now().Add(3 * time.Second)
	for runtime.NumGoroutine() > base {
		if time.Now().After(deadline) {
			t.Fatalf("%d goroutines remain after the session closed, baseline %d", runtime.NumGoroutine(), base)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
