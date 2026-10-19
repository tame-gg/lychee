package control

import (
	"fmt"
	"strings"
	"testing"
)

func TestFrameTooLargeCloses(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.sendRaw(append([]byte(strings.Repeat("a", 70000)), '\n'))
	resp := c.mustFrame()
	if errCode(resp) != "frame_too_large" {
		t.Fatalf("want frame_too_large, got %v", resp)
	}
	if resp["id"] != nil {
		t.Fatalf("want id null, got %v", resp["id"])
	}
	c.expectEOF()
}

func TestInvalidJSONCloses(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.sendRaw([]byte("{\"id\":1,\n"))
	resp := c.mustFrame()
	if errCode(resp) != "bad_request" {
		t.Fatalf("want bad_request, got %v", resp)
	}
	c.expectEOF()
}

func TestNonObjectCloses(t *testing.T) {
	for _, body := range []string{"[1,2]", "\"x\"", "123"} {
		h := startHarness(t, nil)
		c := h.dial()
		c.hello()
		c.sendRaw([]byte(body + "\n"))
		resp := c.mustFrame()
		if errCode(resp) != "bad_request" {
			t.Fatalf("body %q: want bad_request, got %v", body, resp)
		}
		c.expectEOF()
	}
}

func TestInvalidUTF8Closes(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.sendRaw([]byte{0xff, 0xfe, '\n'})
	if errCode(c.mustFrame()) != "bad_request" {
		t.Fatal("want bad_request for invalid UTF-8")
	}
	c.expectEOF()
}

func TestNULByteCloses(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.sendRaw([]byte{'{', '"', 'a', '"', ':', 0x00, '}', '\n'})
	if errCode(c.mustFrame()) != "bad_request" {
		t.Fatal("want bad_request for NUL byte")
	}
	c.expectEOF()
}

func TestEmptyLinesIgnored(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.sendRaw([]byte("\n\n"))
	c.send(map[string]any{"id": 2, "cmd": "status"})
	resp := c.mustFrame()
	if ok, _ := resp["ok"].(bool); !ok || num(resp["id"]) != 2 {
		t.Fatalf("empty lines not ignored, got %v", resp)
	}
}

func TestUnknownTopLevelField(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "status", "extra": 1})
	resp := c.mustFrame()
	if errCode(resp) != "unknown_field" {
		t.Fatalf("want unknown_field, got %v", resp)
	}
	data, _ := resp["error"].(map[string]any)["data"].(map[string]any)
	if data["field"] != "extra" {
		t.Fatalf("want data.field=extra, got %v", data)
	}
	c.send(map[string]any{"id": 3, "cmd": "status"})
	if ok, _ := c.mustFrame()["ok"].(bool); !ok {
		t.Fatal("connection should stay open after unknown_field")
	}
}

func TestUnknownArgField(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "subscribe", "args": map[string]any{"interval": 1}})
	resp := c.mustFrame()
	if errCode(resp) != "unknown_field" {
		t.Fatalf("want unknown_field, got %v", resp)
	}
	data, _ := resp["error"].(map[string]any)["data"].(map[string]any)
	if data["field"] != "args.interval" {
		t.Fatalf("want data.field=args.interval, got %v", data)
	}
}

func TestWrongType(t *testing.T) {
	for _, v := range []any{"yes", 1} {
		h := startHarness(t, nil)
		c := h.dial()
		c.hello()
		c.send(map[string]any{"id": 2, "cmd": "set_autopause", "args": map[string]any{"enabled": v}})
		if errCode(c.mustFrame()) != "bad_request" {
			t.Fatalf("enabled=%v: want bad_request", v)
		}
	}
}

func TestMissingId(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.sendRaw([]byte("{\"cmd\":\"status\"}\n"))
	if errCode(c.mustFrame()) != "bad_request" {
		t.Fatal("want bad_request for missing id")
	}
	c.expectEOF()
}

func TestZeroId(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.sendRaw([]byte("{\"id\":0,\"cmd\":\"status\"}\n"))
	if errCode(c.mustFrame()) != "bad_request" {
		t.Fatal("want bad_request for id 0")
	}
	c.expectEOF()
}

func TestFloatId(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.sendRaw([]byte("{\"id\":1.5,\"cmd\":\"status\"}\n"))
	if errCode(c.mustFrame()) != "bad_request" {
		t.Fatal("want bad_request for float id")
	}
	c.expectEOF()
}

func TestDuplicateInFlightId(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.sendRaw([]byte("{\"id\":5,\"cmd\":\"status\"}\n{\"id\":5,\"cmd\":\"status\"}\n"))
	saw := map[string]int{}
	for {
		m, ok := c.readFrame()
		if !ok {
			break
		}
		if code := errCode(m); code != "" {
			saw[code]++
		} else {
			saw["ok"]++
		}
	}
	if saw["bad_request"] != 1 {
		t.Fatalf("want one bad_request for the duplicate id, got %v", saw)
	}
}

func TestUnknownCommand(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.send(map[string]any{"id": 2, "cmd": "frobnicate"})
	resp := c.mustFrame()
	if errCode(resp) != "unknown_command" {
		t.Fatalf("want unknown_command, got %v", resp)
	}
	c.send(map[string]any{"id": 3, "cmd": "status"})
	if ok, _ := c.mustFrame()["ok"].(bool); !ok {
		t.Fatal("connection should stay open after unknown_command")
	}
}

func TestInFlightLimit(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	var sb strings.Builder
	for i := 2; i <= 18; i++ {
		fmt.Fprintf(&sb, "{\"id\":%d,\"cmd\":\"status\"}\n", i)
	}
	c.sendRaw([]byte(sb.String()))
	answered := 0
	sawTooMany := false
	for {
		m, ok := c.readFrame()
		if !ok {
			break
		}
		if errCode(m) == "too_many_requests" {
			sawTooMany = true
		} else if ok2, _ := m["ok"].(bool); ok2 {
			answered++
		}
	}
	if !sawTooMany {
		t.Fatalf("want too_many_requests, answered=%d", answered)
	}
	if answered != 16 {
		t.Fatalf("want 16 answered before too_many_requests, got %d", answered)
	}
}

func TestResponsesInOrder(t *testing.T) {
	h := startHarness(t, nil)
	c := h.dial()
	c.hello()
	c.sendRaw([]byte("{\"id\":5,\"cmd\":\"status\"}\n{\"id\":3,\"cmd\":\"status\"}\n{\"id\":9,\"cmd\":\"status\"}\n"))
	var got []int64
	for len(got) < 3 {
		m := c.mustFrame()
		if _, isEvent := m["event"]; isEvent {
			continue
		}
		got = append(got, num(m["id"]))
	}
	if len(got) != 3 || got[0] != 5 || got[1] != 3 || got[2] != 9 {
		t.Fatalf("want responses in order 5,3,9, got %v", got)
	}
}

func FuzzRequestDecoder(f *testing.F) {
	f.Add([]byte(`{"id":1,"cmd":"status"}`))
	f.Add([]byte(`{"id":1,"cmd":"subscribe","args":{"interval_ms":1000}}`))
	f.Add([]byte(`[1,2,3]`))
	f.Add([]byte(`{"id":0}`))
	f.Add([]byte("\x00\xff"))
	f.Fuzz(func(t *testing.T, line []byte) {
		req, aerr := decodeEnvelope(line)
		if req == nil && aerr == nil {
			t.Fatal("decodeEnvelope returned nil, nil")
		}
		if aerr != nil {
			switch aerr.code {
			case errBadRequest, errUnknownField:
			default:
				t.Fatalf("unexpected error code %q", aerr.code)
			}
		}
	})
}
