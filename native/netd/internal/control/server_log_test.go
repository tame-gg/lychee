package control

import (
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestLogNeverBlocksCoreLoop(t *testing.T) {
	ln, err := net.Listen("unix", filepath.Join(t.TempDir(), "s"))
	if err != nil {
		t.Fatal(err)
	}
	eng := newFakeEngine()
	srv := New(Config{Listener: ln, Engine: eng, Clock: newFakeClock()})
	inOff := make(chan struct{})
	release := make(chan struct{})
	fromEngine := 2 * cap(srv.core)
	eng.offHook = func() {
		close(inOff)
		<-release
		for i := 0; i < fromEngine; i++ {
			srv.Log("warn", "engine logging from inside the core loop")
		}
	}
	go srv.Serve()
	shutdownDone := make(chan struct{})
	go func() {
		srv.Shutdown()
		close(shutdownDone)
	}()
	<-inOff

	for i := 0; i < cap(srv.core); i++ {
		srv.Log("info", "fill")
	}
	if len(srv.core) != cap(srv.core) {
		t.Fatalf("core queue holds %d of %d", len(srv.core), cap(srv.core))
	}
	returned := make(chan struct{})
	go func() {
		srv.Log("info", "one more than the queue holds")
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(3 * time.Second):
		t.Fatal("Log blocked on a full core queue")
	}

	close(release)
	select {
	case <-shutdownDone:
	case <-time.After(3 * time.Second):
		t.Fatal("Shutdown did not return while the core queue was full")
	}
	want := uint64(fromEngine + 1)
	if got := srv.logDropped.Load(); got != want {
		t.Fatalf("want %d dropped log lines, got %d", want, got)
	}
}
