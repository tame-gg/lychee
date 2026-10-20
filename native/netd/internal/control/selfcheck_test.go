package control

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestSelfCheckVerdict(t *testing.T) {
	bad := errors.New("/opt/x/lychee-netd is not a root-owned, non-writable regular file")
	cases := []struct {
		name     string
		root     bool
		pkexec   bool
		checkErr error
		code     int
		fails    bool
		warns    bool
	}{
		{"not root", false, false, bad, ExitOK, false, false},
		{"root ok", true, false, nil, ExitOK, false, false},
		{"root ok under pkexec", true, true, nil, ExitOK, false, false},
		{"root under sudo", true, false, bad, ExitRefused, true, false},
		{"root under pkexec", true, true, bad, ExitOK, false, true},
	}
	for _, c := range cases {
		var out bytes.Buffer
		code, err := selfCheckVerdict(&out, c.root, c.pkexec, c.checkErr)
		if code != c.code || (err != nil) != c.fails {
			t.Errorf("%s: got code %d, err %v", c.name, code, err)
		}
		if c.fails && (!errors.Is(err, bad) || !strings.Contains(err.Error(), "root-owned")) {
			t.Errorf("%s: unhelpful error: %v", c.name, err)
		}
		if strings.HasPrefix(out.String(), "warning:") != c.warns {
			t.Errorf("%s: stderr %q", c.name, out.String())
		}
		if c.warns && !strings.Contains(out.String(), bad.Error()) {
			t.Errorf("%s: warning lacks the reason: %q", c.name, out.String())
		}
	}
}

func TestSelfCheckWithoutRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root")
	}
	var out bytes.Buffer
	if code, err := SelfCheck(&out); code != ExitOK || err != nil || out.Len() != 0 {
		t.Fatalf("got %d, %v, %q", code, err, out.String())
	}
}
