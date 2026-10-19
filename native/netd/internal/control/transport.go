package control

import (
	"net"
	"os"
	"strconv"
)

const (
	ExitOK         = 0
	ExitUsage      = 2
	ExitRefused    = 3
	ExitConflict   = 4
	ExitTransport  = 5
	ExitNeedsAdmin = 6
)

type Transport struct {
	Listener  net.Listener
	Auth      AuthInfo
	PeerCheck func(net.Conn) (PeerInfo, error)
	cleanup   func()
}

func (t *Transport) Close() {
	if t.Listener != nil {
		t.Listener.Close()
	}
	if t.cleanup != nil {
		t.cleanup()
	}
}

func parseUIDValue(v string) (int, bool) {
	if v == "" || len(v) > 10 {
		return 0, false
	}
	for i := 0; i < len(v); i++ {
		if v[i] < '0' || v[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 || n > (1<<31-1) {
		return 0, false
	}
	return n, true
}

func authorizedUID() (int, bool) {
	for _, k := range []string{"PKEXEC_UID", "SUDO_UID"} {
		if v, ok := os.LookupEnv(k); ok {
			return parseUIDValue(v)
		}
	}
	return os.Getuid(), true
}

func decideUnixPeer(uid, pid uint32, authUID int, requireNonZeroPid bool) bool {
	if requireNonZeroPid && pid == 0 {
		return false
	}
	return int(uid) == authUID || uid == 0
}
