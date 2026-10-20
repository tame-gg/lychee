package control

import (
	"encoding/json"
	"net"
	"strings"
	"testing"

	"github.com/tame-gg/lychee/native/netd/internal/engine"
)

func whiteBox(t *testing.T) (*Server, *session, *fakeEngine) {
	t.Helper()
	eng := newFakeEngine()
	s := New(Config{Engine: eng, Clock: newFakeClock(), Capture: CaptureStatus{Available: true}, GOOS: "linux", GOARCH: "amd64"})
	a, b := net.Pipe()
	t.Cleanup(func() { a.Close(); b.Close() })
	sess := &session{nc: a, out: make(chan outFrame, OutboundQueue), wnote: make(chan noteKind, 256), interval: StatsIntervalDef}
	s.session = sess
	return s, sess, eng
}

func TestStatsFieldMapping(t *testing.T) {
	sl := engine.SlotStats{
		Name: "en0", IP: "1.2.3.4", IP6: "2001:db8::1",
		State: "no internet", State6: "up",
		Weight: 0.61, Weight6: 1, Present: true,
		Active: 5, Total: 100, Failed: 2,
		BytesIn: 111, BytesOut: 222,
		RateIn: 3333.9, RateOut: 44.9, LinkIn: 5555.9, LinkOut: 66.9,
		Peak: 7777.9, Peak6: 88.9,
	}
	av := adapterFromSlot(sl, true, "manual")
	b, _ := json.Marshal(av)
	var m map[string]any
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	dec.Decode(&m)
	want := map[string]int64{
		"weight_mode_is_manual": 0,
		"peak_bps":              7777, "peak6_bps": 88,
		"active_flows": 5, "total_flows": 100, "failed_flows": 2,
		"link_in_bps": 5555, "link_out_bps": 66,
		"relayed_in_bps": 3333, "relayed_out_bps": 44,
		"bytes_in": 111, "bytes_out": 222,
	}
	for k, v := range want {
		if strings.HasPrefix(k, "weight_mode") {
			continue
		}
		if num(m[k]) != v {
			t.Fatalf("%s: want %d, got %v", k, v, m[k])
		}
	}
	if m["state"] != "down" {
		t.Fatalf("state no internet should map to down, got %v", m["state"])
	}
	if m["state6"] != "up" {
		t.Fatalf("state6 should be up, got %v", m["state6"])
	}
	if m["excluded"] != true || m["weight_mode"] != "manual" {
		t.Fatalf("excluded/weight_mode wrong: %v %v", m["excluded"], m["weight_mode"])
	}
	if m["ip"] != "1.2.3.4" || m["ip6"] != "2001:db8::1" {
		t.Fatalf("ip mapping wrong: %v %v", m["ip"], m["ip6"])
	}
}

func TestStatsFieldNullIP(t *testing.T) {
	av := adapterFromSlot(engine.SlotStats{Name: "x", State: "-", State6: "-"}, false, "auto")
	b, _ := json.Marshal(av)
	if !strings.Contains(string(b), `"ip":null`) || !strings.Contains(string(b), `"ip6":null`) {
		t.Fatalf("empty IP should be null: %s", b)
	}
	if !strings.Contains(string(b), `"state":"none"`) {
		t.Fatalf(`"-" state should map to none: %s`, b)
	}
}

func TestSubscribeIntervalRange(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi") })
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "subscribe", "args": map[string]any{"interval_ms": 249}})
	if errCode(responseByID(c, 2)) != "out_of_range" {
		t.Fatal("249 should be out_of_range")
	}
	c.send(map[string]any{"id": 3, "cmd": "subscribe", "args": map[string]any{"interval_ms": 5001}})
	if errCode(responseByID(c, 3)) != "out_of_range" {
		t.Fatal("5001 should be out_of_range")
	}
	c.send(map[string]any{"id": 4, "cmd": "subscribe"})
	if num(responseResult(c, 4)["interval_ms"]) != 1000 {
		t.Fatal("default interval should be 1000")
	}
	c.send(map[string]any{"id": 5, "cmd": "subscribe", "args": map[string]any{"interval_ms": 500}})
	if num(responseResult(c, 5)["interval_ms"]) != 500 {
		t.Fatal("re-subscribe should change the interval")
	}
}

func TestStatsWhileOff(t *testing.T) {
	h := startHarness(t, func(c *Config, e *fakeEngine) { e.present("Wi-Fi") })
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "subscribe"})
	drainResponses(c, 2)
	st := nextStats(c)
	if st["state"] != "off" {
		t.Fatalf("want off, got %v", st["state"])
	}
	tot := st["totals"].(map[string]any)
	if num(tot["link_in_bps"]) == 0 {
		t.Fatal("link rates should be live while off")
	}
}

func TestTotals(t *testing.T) {
	_, _, eng := whiteBox(t)
	eng.setSlots(
		engine.SlotStats{Name: "A", Present: true, State: "up", LinkIn: 1000, LinkOut: 100, Active: 3},
		engine.SlotStats{Name: "B", Present: true, State: "up", LinkIn: 2000, LinkOut: 200, Active: 2},
		engine.SlotStats{Name: "C", Present: false, State: "up", LinkIn: 9999, LinkOut: 9999, Active: 9},
	)
	eng.mu.Lock()
	eng.excluded["B"] = true
	eng.mu.Unlock()
	_, totals, _ := buildAdapters(eng)
	if totals.LinkInBps != 3000 || totals.LinkOutBps != 300 {
		t.Fatalf("totals should sum present (incl excluded), got %+v", totals)
	}
	if totals.ActiveFlows != 5 {
		t.Fatalf("active flows should be 5, got %d", totals.ActiveFlows)
	}
	if totals.AdaptersPres != 2 {
		t.Fatalf("present should be 2 (absent C excluded), got %d", totals.AdaptersPres)
	}
}

func TestStatsFrameFits(t *testing.T) {
	s, sess, eng := whiteBox(t)
	sess.subscribed = true
	longName := strings.Repeat("n", 256)
	slots := make([]engine.SlotStats, 64)
	for i := range slots {
		slots[i] = engine.SlotStats{Name: longName, IP: "255.255.255.255", IP6: "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", State: "up", State6: "up", Present: true, Weight: 1, Weight6: 1}
	}
	eng.setSlots(slots...)
	frame := encodeEvent("stats", 1, s.statsView())
	if len(frame)+1 > MaxFrame {
		t.Fatalf("stats frame with 64 adapters is %d bytes, over the limit", len(frame)+1)
	}
}

func TestSeqMonotonic(t *testing.T) {
	s, sess, _ := whiteBox(t)
	sess.subscribed = true
	s.emitState()
	s.emitLog("warn", "a warning")
	s.emitStats()
	var seqs []uint64
	for len(sess.out) > 0 {
		of := <-sess.out
		var ev eventFrame
		if json.Unmarshal(of.bytes, &ev) == nil && ev.Event != "" {
			seqs = append(seqs, ev.Seq)
		}
	}
	if len(seqs) != 3 || seqs[0] != 1 || seqs[1] != 2 || seqs[2] != 3 {
		t.Fatalf("seq should increase by 1 across events, got %v", seqs)
	}
}

func TestBackpressureDropsStats(t *testing.T) {
	s, sess, _ := whiteBox(t)
	sess.subscribed = true
	for len(sess.out) < cap(sess.out) {
		sess.out <- outFrame{[]byte("x"), kindStats}
		sess.pendingWrites++
	}
	d0 := sess.dropped
	seq0 := sess.seq
	s.emitStats()
	s.emitStats()
	if sess.dropped <= d0 {
		t.Fatal("dropped should grow when the queue is full")
	}
	if sess.seq != seq0+2 {
		t.Fatalf("seq should advance for dropped events too, got %d want %d", sess.seq, seq0+2)
	}
	s.emitState()
	if s.session != nil {
		t.Fatal("a state event that cannot be enqueued must close the session")
	}
}

func TestBackpressureStatusHasRoom(t *testing.T) {
	s, sess, _ := whiteBox(t)
	id := int64(2)
	s.respondOK(&id, map[string]any{"ok": 1})
	if len(sess.out) != 1 {
		t.Fatal("a response must be enqueued while the queue has room")
	}
}

func TestWriteStallCloses(t *testing.T) {
	s, _, _ := whiteBox(t)
	id := int64(2)
	s.respondOK(&id, map[string]any{})
	if s.stallCh == nil {
		t.Fatal("enqueue should arm the write-stall timer")
	}
	s.onWnote(kindResp)
	if s.stallCh != nil {
		t.Fatal("a completed write should clear the stall timer")
	}
	s.respondOK(&id, map[string]any{})
	s.onStall()
	if s.session != nil {
		t.Fatal("a stalled write must close the session")
	}
}

func TestLogRateLimit(t *testing.T) {
	s, sess, _ := whiteBox(t)
	for i := 0; i < 100; i++ {
		s.emitLog("warn", "flood")
	}
	delivered := 0
	for len(sess.out) > 0 {
		if (<-sess.out).kind == kindLog {
			delivered++
		}
	}
	if delivered > LogRatePerSecond {
		t.Fatalf("delivered %d log events, want at most %d", delivered, LogRatePerSecond)
	}
	if sess.dropped < 100-LogRatePerSecond {
		t.Fatalf("expected ~%d dropped, got %d", 100-LogRatePerSecond, sess.dropped)
	}
}
