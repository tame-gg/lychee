package control

import "testing"

func TestFuzzPeerCheckInputs(t *testing.T) {
	bad := []string{"1000x", "-1", " 1000", "", "99999999999", "0x10", "1000\n", "+5"}
	for _, v := range bad {
		if _, ok := parseUIDValue(v); ok {
			t.Fatalf("parseUIDValue(%q) should be rejected", v)
		}
	}
	good := map[string]int{"0": 0, "1000": 1000, "2147483647": 1<<31 - 1}
	for v, want := range good {
		got, ok := parseUIDValue(v)
		if !ok || got != want {
			t.Fatalf("parseUIDValue(%q) = %d,%v; want %d,true", v, got, ok, want)
		}
	}
}

func TestPeerCheckDecision(t *testing.T) {
	if !decideUnixPeer(1000, 123, 1000, true) {
		t.Fatal("same uid with non-zero pid should be accepted")
	}
	if decideUnixPeer(0, 123, 1000, true) {
		t.Fatal("root is not the socket owner and should be refused")
	}
	if !decideUnixPeer(0, 123, 0, true) {
		t.Fatal("root should be accepted when it owns the socket")
	}
	if decideUnixPeer(65534, 123, 1000, true) {
		t.Fatal("another uid should be rejected")
	}
	if decideUnixPeer(1000, 0, 1000, true) {
		t.Fatal("pid 0 should be rejected on Linux")
	}
	if !decideUnixPeer(1000, 0, 1000, false) {
		t.Fatal("pid is not an auth input on macOS")
	}
}
