package control

import (
	"testing"
	"time"

	"github.com/tame-gg/lychee/native/netd/internal/engine"
)

func TestStartsOff(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi") })
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "status"})
	st := responseResult(c, 2)
	if st["state"] != "off" {
		t.Fatalf("fresh helper should be off, got %v", st["state"])
	}
	ap, _ := st["autopause"].(map[string]any)
	if ap["status"] != "manual_off" {
		t.Fatalf("want autopause manual_off, got %v", ap["status"])
	}
	if h.eng.onCalls != 0 {
		t.Fatal("engine On must not be called without an on request")
	}
}

func TestOnOffIdempotent(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi") })
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "on"})
	drainResponses(c, 2)
	c.send(map[string]any{"id": 3, "cmd": "on"})
	drainResponses(c, 3)
	if h.eng.onCalls != 1 {
		t.Fatalf("on twice should call engine On once, got %d", h.eng.onCalls)
	}
	c.send(map[string]any{"id": 4, "cmd": "off"})
	drainResponses(c, 4)
	c.send(map[string]any{"id": 5, "cmd": "off"})
	drainResponses(c, 5)
}

func TestOnEmitsStateEvents(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi") })
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "on"})
	var states []string
	for {
		m := c.mustFrame()
		if m["event"] == "state" {
			d, _ := m["data"].(map[string]any)
			states = append(states, d["state"].(string))
			continue
		}
		if num(m["id"]) == 2 {
			break
		}
	}
	if len(states) < 2 || states[0] != "starting" || states[len(states)-1] != "on" {
		t.Fatalf("want starting then on before response, got %v", states)
	}
}

func TestOnFailureSetsError(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) {
		e.present("Wi-Fi")
		e.onErr = errFake("route add failed")
	})
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "on"})
	resp := responseByID(c, 2)
	if errCode(resp) != "internal" {
		t.Fatalf("want internal, got %v", resp)
	}
	c.send(map[string]any{"id": 3, "cmd": "status"})
	st := responseResult(c, 3)
	if st["state"] != "error" {
		t.Fatalf("want error state, got %v", st["state"])
	}
	e := st["error"].(map[string]any)
	if e["message"] != "route add failed" {
		t.Fatalf("want error message, got %v", e)
	}
	c.send(map[string]any{"id": 4, "cmd": "off"})
	drainResponses(c, 4)
	c.send(map[string]any{"id": 5, "cmd": "status"})
	if responseResult(c, 5)["error"] != nil {
		t.Fatal("off should clear the error")
	}
}

func TestOnNoAdapters(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "on"})
	if errCode(responseByID(c, 2)) != "no_adapters" {
		t.Fatal("want no_adapters with empty snapshot")
	}
}

func TestOnUnsupportedPlatform(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) {
		e.present("Wi-Fi")
		c.Capture = CaptureStatus{Available: false, Error: "no /dev/net/tun"}
	})
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "on"})
	resp := responseByID(c, 2)
	if errCode(resp) != "unsupported_platform" {
		t.Fatalf("want unsupported_platform, got %v", resp)
	}
}

func TestSetIPv6(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi") })
	c := h.dial()
	c.hello()
	for _, mode := range []string{"auto", "on", "off"} {
		c.send(map[string]any{"id": 2, "cmd": "set_ipv6", "args": map[string]any{"mode": mode}})
		r := responseResult(c, 2)
		if r["mode"] != mode {
			t.Fatalf("want mode %q, got %v", mode, r)
		}
	}
	h.eng.mu.Lock()
	h.eng.v6allowed = true
	h.eng.mu.Unlock()
	c.send(map[string]any{"id": 3, "cmd": "set_ipv6", "args": map[string]any{"mode": "on"}})
	if responseResult(c, 3)["effective"] != "balanced" {
		t.Fatal("effective should follow V6Allowed")
	}
	c.send(map[string]any{"id": 4, "cmd": "set_ipv6", "args": map[string]any{"mode": "bogus"}})
	if errCode(responseByID(c, 4)) != "bad_request" {
		t.Fatal("invalid mode should be bad_request")
	}
}

func TestExcludeInclude(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi") })
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "exclude", "args": map[string]any{"adapter": "Nope"}})
	if errCode(responseByID(c, 2)) != "unknown_adapter" {
		t.Fatal("want unknown_adapter for unknown name")
	}
	c.send(map[string]any{"id": 3, "cmd": "exclude", "args": map[string]any{"adapter": "Wi-Fi"}})
	if responseResult(c, 3)["excluded"] != true {
		t.Fatal("exclude should set the flag")
	}
	if !h.eng.Excluded("Wi-Fi") {
		t.Fatal("engine SetExcluded not called")
	}
	c.send(map[string]any{"id": 4, "cmd": "exclude", "args": map[string]any{"adapter": "Wi-Fi"}})
	if responseResult(c, 4)["excluded"] != true {
		t.Fatal("exclude should be idempotent")
	}
	c.send(map[string]any{"id": 5, "cmd": "subscribe"})
	drainResponses(c, 5)
	st := nextStats(c)
	ads := st["adapters"].([]any)
	a0 := ads[0].(map[string]any)
	if a0["excluded"] != true {
		t.Fatal("excluded adapter should appear with excluded:true in stats")
	}
	if num(a0["link_in_bps"]) == 0 {
		t.Fatal("excluded adapter should still report link rates")
	}
}

func TestSetWeight(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Ethernet") })
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "set_weight", "args": map[string]any{"adapter": "Ethernet", "weight": 0.049}})
	if errCode(responseByID(c, 2)) != "out_of_range" {
		t.Fatal("0.049 should be out_of_range")
	}
	c.send(map[string]any{"id": 3, "cmd": "set_weight", "args": map[string]any{"adapter": "Ethernet", "weight": 100.1}})
	if errCode(responseByID(c, 3)) != "out_of_range" {
		t.Fatal("100.1 should be out_of_range")
	}
	c.send(map[string]any{"id": 4, "cmd": "set_weight", "args": map[string]any{"adapter": "Ethernet", "weight": 3}})
	if responseResult(c, 4)["weight_mode"] != "manual" {
		t.Fatal("weight 3 should be manual")
	}
	c.send(map[string]any{"id": 5, "cmd": "set_weight", "args": map[string]any{"adapter": "Ethernet", "weight": "auto"}})
	if responseResult(c, 5)["weight_mode"] != "auto" {
		t.Fatal(`"auto" should clear to auto`)
	}
	c.send(map[string]any{"id": 6, "cmd": "set_weight", "args": map[string]any{"adapter": "Ethernet", "weight": "Auto"}})
	if errCode(responseByID(c, 6)) != "bad_request" {
		t.Fatal(`"Auto" should be bad_request`)
	}
	c.send(map[string]any{"id": 7, "cmd": "set_weight", "args": map[string]any{"adapter": "Ethernet", "weight": true}})
	if errCode(responseByID(c, 7)) != "bad_request" {
		t.Fatal("true should be bad_request")
	}
}

func TestListAdaptersCaps(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) {
		for i := 0; i < 70; i++ {
			e.adapters = append(e.adapters, AdapterInfo{Name: name70(i), Index: i + 1, WeightMode: "auto"})
		}
	})
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "list_adapters"})
	r := responseResult(c, 2)
	ads := r["adapters"].([]any)
	if len(ads) != 64 {
		t.Fatalf("want 64 adapters, got %d", len(ads))
	}
	if r["truncated"] != true {
		t.Fatal("want truncated:true")
	}
}

func TestCleanupOnlyWhenOff(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi") })
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "on"})
	drainResponses(c, 2)
	c.send(map[string]any{"id": 3, "cmd": "cleanup"})
	resp := responseByID(c, 3)
	if errCode(resp) != "invalid_state" {
		t.Fatalf("cleanup while on should be invalid_state, got %v", resp)
	}
	if resp["error"].(map[string]any)["data"].(map[string]any)["state"] != "on" {
		t.Fatal("want data.state=on")
	}
	c.send(map[string]any{"id": 4, "cmd": "off"})
	drainResponses(c, 4)
	c.send(map[string]any{"id": 5, "cmd": "cleanup"})
	if ok, _ := responseByID(c, 5)["ok"].(bool); !ok {
		t.Fatal("cleanup while off should succeed")
	}
	if h.eng.cleanupCnt == 0 {
		t.Fatal("engine Cleanup not called")
	}
}

func TestStringsNeverReachExec(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi") })
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "exclude", "args": map[string]any{"adapter": "Wi-Fi; rm -rf /"}})
	if errCode(responseByID(c, 2)) != "unknown_adapter" {
		t.Fatal("malicious name should be unknown_adapter")
	}
	for _, n := range h.eng.setExclRx {
		if n == "Wi-Fi; rm -rf /" {
		}
	}
	if h.eng.Excluded("Wi-Fi; rm -rf /") {
		t.Fatal("malicious name should never be excluded")
	}
}

func TestAutopauseStates(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi", "Ethernet") })
	srv := h.srv
	srv.ap = autoPauser{enabled: true, manualOff: true}
	if srv.autopauseStatus() != "manual_off" {
		t.Fatalf("want manual_off, got %q", srv.autopauseStatus())
	}
	srv.ap.setEnabled(false, false)
	if srv.autopauseStatus() != "disabled" {
		t.Fatalf("want disabled, got %q", srv.autopauseStatus())
	}
	srv.ap = autoPauser{enabled: true}
	srv.ap.userSet(true, 1)
	h.eng.mu.Lock()
	h.eng.on = true
	h.eng.mu.Unlock()
	if srv.autopauseStatus() != "held" {
		t.Fatalf("want held with one usable adapter, got %q", srv.autopauseStatus())
	}
	srv.ap.userSet(true, 2)
	if srv.autopauseStatus() != "armed" {
		t.Fatalf("want armed with two usable, got %q", srv.autopauseStatus())
	}
	h.eng.mu.Lock()
	h.eng.on = false
	h.eng.mu.Unlock()
	srv.ap = autoPauser{enabled: true}
	srv.ap.setEnabled(true, false)
	if srv.autopauseStatus() != "waiting" || srv.deriveState() != "paused_auto" {
		t.Fatalf("want waiting/paused_auto, got %q/%q", srv.autopauseStatus(), srv.deriveState())
	}
}

func TestAutopauseNeverStartsWithoutOn(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi", "Ethernet") })
	srv := h.srv
	srv.ap = autoPauser{enabled: true}
	now := srv.clock.Now()
	for i := 0; i < 120; i++ {
		now = now.Add(time.Second)
		srv.ap.tick(now, false, 2, 0)
	}
	if srv.eng.IsOn() {
		t.Fatal("autopause must never start merging without an on request")
	}
	if srv.deriveState() == "on" {
		t.Fatal("state must not be on")
	}
}

type fakeErr string

func (e fakeErr) Error() string { return string(e) }
func errFake(s string) error    { return fakeErr(s) }

func name70(i int) string {
	return "adapter-" + string(rune('a'+i/26)) + string(rune('a'+i%26))
}

func nextStats(c *client) map[string]any {
	c.t.Helper()
	for {
		m := c.mustFrame()
		if m["event"] == "stats" {
			return m["data"].(map[string]any)
		}
	}
}

var _ = engine.Fam4
