package tun

import "testing"

func TestParseWeakHostLine(t *testing.T) {
	good := []string{
		"ipv4 12 weakhostsend=enabled forwarding=disabled",
		"ipv6 7 weakhostsend=disabled forwarding=enabled",
		"ipv4 12 forwarding=disabled weakhostsend=enabled",
		"  ipv4\t3 weakhostsend=enabled forwarding=enabled  ",
		"ipv4 123456789 weakhostsend=disabled forwarding=disabled",
	}
	for _, l := range good {
		if f, ok := parseWeakHostLine(l); !ok || len(f) != 4 {
			t.Errorf("rejected %q", l)
		}
	}
	bad := []string{
		"",
		"ipv4",
		"ipv4 12 weakhostsend=enabled",
		"ipv4 12 weakhostsend=enabled forwarding=disabled extra",
		"IPv4 12 weakhostsend=enabled forwarding=disabled",
		"ipv5 12 weakhostsend=enabled forwarding=disabled",
		"ipv4 -1 weakhostsend=enabled forwarding=disabled",
		"ipv4 1a weakhostsend=enabled forwarding=disabled",
		"ipv4 0x10 weakhostsend=enabled forwarding=disabled",
		"ipv4 1234567890 weakhostsend=enabled forwarding=disabled",
		"ipv4 12 weakhostsend=enabled weakhostsend=disabled",
		"ipv4 12 weakhostsend=on forwarding=disabled",
		"ipv4 12 weakhostsend=Enabled forwarding=disabled",
		"ipv4 12 weakhostsend=enabled forwarding=disabled;",
		"ipv4 12 weakhostsend=enabled forwarding=",
		"ipv4 12 weakhostsend=enabled dhcp=enabled",
		"ipv4 12 weakhostsend enabled forwarding disabled",
		"ipv4 12 weakhostsend=enabled forwarding=disabled\x00",
		"ipv4 12 weakhostsend=enabled forwarding=disabled store=persistent",
	}
	for _, l := range bad {
		if _, ok := parseWeakHostLine(l); ok {
			t.Errorf("accepted %q", l)
		}
	}
}

func TestWeakHostRestoreLine(t *testing.T) {
	line, ok := weakHostRestoreLine("IPv4 12 Enabled Disabled")
	if !ok || line != "ipv4 12 weakhostsend=enabled forwarding=disabled" {
		t.Fatalf("got %q, %v", line, ok)
	}
	for _, l := range []string{"", "IPv4 12 Enabled", "IPv4 x Enabled Disabled", "IPv9 12 Enabled Disabled", "IPv4 12 Maybe Disabled", "IPv4 12 Enabled Disabled Extra"} {
		if got, ok := weakHostRestoreLine(l); ok {
			t.Errorf("accepted %q as %q", l, got)
		}
	}
}
