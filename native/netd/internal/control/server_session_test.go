package control

import (
	"regexp"
	"testing"
	"time"
)

func TestHelloRequired(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.send(map[string]any{"id": 1, "cmd": "status"})
	if errCode(c.mustFrame()) != "hello_required" {
		t.Fatal("want hello_required")
	}
	c.expectEOF()
}

func TestHelloTimeout(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	base := h.clk.waiters()
	for h.clk.waiters() <= base {
		time.Sleep(time.Millisecond)
	}
	h.clk.Advance(HelloTimeout)
	if errCode(c.mustFrame()) != "hello_required" {
		t.Fatal("want hello_required after 5s")
	}
	c.expectEOF()
}

func TestHelloVersionMismatch(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.send(map[string]any{"id": 1, "cmd": "hello", "args": map[string]any{"protocol": []int{2}, "client": "lychee", "client_version": "0.2.0"}})
	resp := c.mustFrame()
	if errCode(resp) != "version_unsupported" {
		t.Fatalf("want version_unsupported, got %v", resp)
	}
	data, _ := resp["error"].(map[string]any)["data"].(map[string]any)
	sup, _ := data["supported"].([]any)
	if len(sup) != 1 || num(sup[0]) != 1 {
		t.Fatalf("want supported [1], got %v", data)
	}
	c.expectEOF()
}

func TestHelloPicksHighest(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.send(map[string]any{"id": 1, "cmd": "hello", "args": map[string]any{"protocol": []int{1, 7}, "client": "lychee", "client_version": "0.2.0"}})
	resp := c.mustFrame()
	result, _ := resp["result"].(map[string]any)
	if num(result["protocol"]) != 1 {
		t.Fatalf("want protocol 1, got %v", result)
	}
}

func TestHelloBadClientName(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.send(map[string]any{"id": 1, "cmd": "hello", "args": map[string]any{"protocol": []int{1}, "client": "a b", "client_version": "0.2.0"}})
	if errCode(c.mustFrame()) != "bad_request" {
		t.Fatal("want bad_request for bad client name")
	}
	c.expectEOF()
}

func TestHelloResultFields(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.send(map[string]any{"id": 1, "cmd": "hello", "args": map[string]any{"protocol": []int{1}, "client": "lychee", "client_version": "0.2.0"}})
	resp := c.mustFrame()
	r, _ := resp["result"].(map[string]any)
	for _, k := range []string{"protocol", "helper_version", "os", "arch", "pid", "instance", "session", "auth", "capabilities", "limits", "capture"} {
		if _, ok := r[k]; !ok {
			t.Fatalf("hello result missing %q: %v", k, r)
		}
	}
	inst, _ := r["instance"].(string)
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(inst) {
		t.Fatalf("instance not 32 hex chars: %q", inst)
	}
	lim, _ := r["limits"].(map[string]any)
	if num(lim["max_frame"]) != 65536 || num(lim["max_in_flight"]) != 16 || num(lim["grace_ms"]) != 10000 {
		t.Fatalf("limits mismatch: %v", lim)
	}
}

func TestStateEventAfterHello(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.send(map[string]any{"id": 1, "cmd": "hello", "args": map[string]any{"protocol": []int{1}, "client": "lychee", "client_version": "0.2.0"}})
	c.mustFrame()
	ev := c.mustFrame()
	if ev["event"] != "state" || num(ev["seq"]) != 1 {
		t.Fatalf("want state event seq 1, got %v", ev)
	}
}

func TestSecondHelloInvalidState(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "hello", "args": map[string]any{"protocol": []int{1}, "client": "lychee", "client_version": "0.2.0"}})
	if errCode(c.mustFrame()) != "invalid_state" {
		t.Fatal("want invalid_state for second hello")
	}
	c.send(map[string]any{"id": 3, "cmd": "status"})
	if ok, _ := c.mustFrame()["ok"].(bool); !ok {
		t.Fatal("session should continue after second hello")
	}
}

func TestBusy(t *testing.T) {
	h := startHarness(t, nil)
	c1 := h.dial()
	c1.hello()
	c2 := h.dial()
	c2.send(map[string]any{"id": 1, "cmd": "hello", "args": map[string]any{"protocol": []int{1}, "client": "lychee", "client_version": "0.2.0"}})
	resp := c2.mustFrame()
	if errCode(resp) != "busy" {
		t.Fatalf("want busy, got %v", resp)
	}
	data, _ := resp["error"].(map[string]any)["data"].(map[string]any)
	if num(data["session_pid"]) != 4242 {
		t.Fatalf("want session_pid 4242, got %v", data)
	}
	c2.expectEOF()
	c1.send(map[string]any{"id": 2, "cmd": "status"})
	if ok, _ := c1.mustFrame()["ok"].(bool); !ok {
		t.Fatal("first session should be unaffected")
	}
}

func TestPendingConnectionCap(t *testing.T) {
	h := startHarness(t, nil)
	for i := 0; i < 4; i++ {
		h.dial()
	}
	h.settle()
	c5 := h.dial()
	c5.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	b := make([]byte, 1)
	if _, err := c5.conn.Read(b); err == nil {
		t.Fatal("5th pending connection should be closed without bytes")
	}
}

func TestGraceExitsHelper(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.addKnown("Wi-Fi") })
	c := h.dial()
	c.hello()
	c.conn.Close()
	h.settle()
	h.clk.Advance(GracePeriod)
	h.waitExit()
	if h.eng.offCalls == 0 {
		t.Fatal("engine Off should be called on shutdown")
	}
}

func TestGracePreservesState(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi", "Ethernet") })
	c := h.dial()
	inst1 := c.hello()["result"].(map[string]any)["instance"]
	c.send(map[string]any{"id": 2, "cmd": "on"})
	drainResponses(c, 2)
	c.send(map[string]any{"id": 3, "cmd": "exclude", "args": map[string]any{"adapter": "Wi-Fi"}})
	drainResponses(c, 3)
	c.conn.Close()
	h.settle()
	h.clk.Advance(9 * time.Second)
	h.settle()
	c2 := h.dial()
	resp := c2.hello()
	r := resp["result"].(map[string]any)
	if r["instance"] != inst1 {
		t.Fatalf("instance changed across grace: %v vs %v", r["instance"], inst1)
	}
	if num(r["session"]) != 2 {
		t.Fatalf("want session 2, got %v", r["session"])
	}
	c2.send(map[string]any{"id": 2, "cmd": "status"})
	st := responseResult(c2, 2)
	if st["state"] != "on" {
		t.Fatalf("state not preserved across grace, got %v", st["state"])
	}
}

func TestGraceRestartsAfterFailedHello(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.conn.Close()
	h.settle()
	h.clk.Advance(8 * time.Second)
	h.settle()
	bad := h.dial()
	bad.send(map[string]any{"id": 1, "cmd": "status"})
	bad.expectEOF()
	h.settle()
	h.clk.Advance(8 * time.Second)
	h.settle()
	select {
	case <-h.exited:
		t.Fatal("grace should have restarted, helper exited too early")
	default:
	}
	h.clk.Advance(3 * time.Second)
	h.waitExit()
}

func TestStartupTimeout(t *testing.T) {
	h := startHarness(t, nil)
	h.settle()
	h.clk.Advance(StartupTimeout)
	h.waitExit()
}

func TestQuit(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.addKnown("Wi-Fi") })
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "quit"})
	resp := responseByID(c, 2)
	if ok, _ := resp["ok"].(bool); !ok {
		t.Fatalf("quit should succeed, got %v", resp)
	}
	c.expectEOF()
	h.waitExit()
	if h.eng.offCalls == 0 {
		t.Fatal("engine Off should be called on quit")
	}
}

func drainResponses(c *client, id int64) {
	c.t.Helper()
	for {
		m := c.mustFrame()
		if _, isEvent := m["event"]; isEvent {
			continue
		}
		if num(m["id"]) == id {
			return
		}
	}
}

func responseByID(c *client, id int64) map[string]any {
	c.t.Helper()
	for {
		m := c.mustFrame()
		if _, isEvent := m["event"]; isEvent {
			continue
		}
		if num(m["id"]) == id {
			return m
		}
	}
}

func responseResult(c *client, id int64) map[string]any {
	r, _ := responseByID(c, id)["result"].(map[string]any)
	return r
}

func TestSignalIsQuit(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi") })
	c := h.dial()
	c.hello()
	h.srv.Shutdown()
	h.waitExit()
	if h.eng.offCalls == 0 {
		t.Fatal("shutdown via signal should tear the engine down")
	}
}
