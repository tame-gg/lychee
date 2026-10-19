package control

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type harness struct {
	t    *testing.T
	srv  *Server
	clk  *fakeClock
	eng  *fakeEngine
	addr string
}

func startHarness(t *testing.T, tweak func(*Config, *fakeEngine)) *harness {
	t.Helper()
	dir, err := os.MkdirTemp("", "netd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "s")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	clk := newFakeClock()
	eng := newFakeEngine()
	uid := os.Getuid()
	cfg := Config{
		Listener:     ln,
		PeerCheck:    func(net.Conn) (PeerInfo, error) { return PeerInfo{UID: uid, PID: 4242}, nil },
		Clock:        clk,
		Engine:       eng,
		Version:      "0.2.0",
		GOOS:         "linux",
		GOARCH:       "amd64",
		Auth:         AuthInfo{Model: "unix_peer_uid", Privilege: "root", UID: &uid},
		Capabilities: []string{"link_counters", "keep_adapter_on_off"},
		Capture:      CaptureStatus{Available: true},
	}
	if tweak != nil {
		tweak(&cfg, eng)
	}
	srv := New(cfg)
	go srv.Serve()
	t.Cleanup(func() { srv.Shutdown() })
	return &harness{t: t, srv: srv, clk: clk, eng: eng, addr: sock}
}

type client struct {
	t    *testing.T
	conn net.Conn
	r    *bufio.Reader
}

func (h *harness) dial() *client {
	h.t.Helper()
	conn, err := net.Dial("unix", h.addr)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { conn.Close() })
	return &client{t: h.t, conn: conn, r: bufio.NewReader(conn)}
}

func (c *client) send(v any) {
	c.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		c.t.Fatal(err)
	}
	b = append(b, '\n')
	if _, err := c.conn.Write(b); err != nil {
		c.t.Fatal(err)
	}
}

func (c *client) sendRaw(b []byte) {
	c.t.Helper()
	if _, err := c.conn.Write(b); err != nil {
		c.t.Fatal(err)
	}
}

func (c *client) readFrame() (map[string]any, bool) {
	c.t.Helper()
	c.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	line, err := c.r.ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return nil, false
	}
	var m map[string]any
	dec := json.NewDecoder(bytesReader(line))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		c.t.Fatalf("bad frame %q: %v", line, err)
	}
	return m, true
}

func (c *client) mustFrame() map[string]any {
	c.t.Helper()
	m, ok := c.readFrame()
	if !ok {
		c.t.Fatal("expected a frame, got EOF")
	}
	return m
}

func (c *client) expectEOF() {
	c.t.Helper()
	c.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, err := c.r.ReadByte(); err != nil {
			return
		}
	}
}

func (c *client) hello() map[string]any {
	c.t.Helper()
	c.send(map[string]any{"id": 1, "cmd": "hello", "args": map[string]any{"protocol": []int{1}, "client": "lychee", "client_version": "0.2.0"}})
	resp := c.mustFrame()
	if ok, _ := resp["ok"].(bool); !ok {
		c.t.Fatalf("hello failed: %v", resp)
	}
	st := c.mustFrame()
	if st["event"] != "state" {
		c.t.Fatalf("expected state event after hello, got %v", st)
	}
	return resp
}

func num(v any) int64 {
	switch n := v.(type) {
	case json.Number:
		i, _ := n.Int64()
		return i
	case float64:
		return int64(n)
	}
	return 0
}

func errCode(m map[string]any) string {
	e, ok := m["error"].(map[string]any)
	if !ok {
		return ""
	}
	s, _ := e["code"].(string)
	return s
}

func bytesReader(b []byte) *bufferReader { return &bufferReader{b: b} }

type bufferReader struct {
	b []byte
	i int
}

func (r *bufferReader) Read(p []byte) (int, error) {
	if r.i >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}
