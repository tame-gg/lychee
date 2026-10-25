//go:build linux || darwin

package control

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const dialEnv = "LYCHEE_NETD_TEST_DIAL"

func TestMain(m *testing.M) {
	if sock := os.Getenv(dialEnv); sock != "" {
		os.Exit(dialForTest(sock))
	}
	os.Exit(m.Run())
}

func dialForTest(sock string) int {
	conn, err := net.DialTimeout("unix", sock, 3*time.Second)
	if err != nil {
		fmt.Println("dial:", err)
		return 2
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprint(conn, `{"id":1,"cmd":"hello","args":{"protocol":[1],"client":"lychee","client_version":"0.2.0"}}`+"\n")
	line, err := bufio.NewReader(conn).ReadString('\n')
	switch {
	case strings.Contains(line, `"ok":true`):
		fmt.Println("accepted")
	case line == "" && err != nil && !errors.Is(err, os.ErrDeadlineExceeded):
		fmt.Println("refused")
	default:
		fmt.Printf("unexpected: %q %v\n", line, err)
		return 1
	}
	return 0
}

type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func (s *syncBuffer) waitFor(t *testing.T, text string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !strings.Contains(s.String(), text) {
		if time.Now().After(deadline) {
			t.Fatalf("log never showed %q; got:\n%s", text, s.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func fakeCredentials(uid, pid uint32) func(net.Conn) (peerCredentials, error) {
	return func(net.Conn) (peerCredentials, error) { return peerCredentials{uid: uid, pid: pid}, nil }
}

func TestPeerCheckAcceptsOnlySocketOwner(t *testing.T) {
	t.Setenv("PKEXEC_UID", "1000")
	authUID, ok := authorizedUID()
	if !ok || authUID != 1000 {
		t.Fatalf("authorizedUID = %d,%v; want 1000,true", authUID, ok)
	}
	accepted := func(uid, pid uint32) bool {
		_, err := unixPeerCheck(authUID, fakeCredentials(uid, pid))(nil)
		return err == nil
	}
	if !accepted(1000, 7) {
		t.Fatal("the socket owner should be accepted")
	}
	if accepted(0, 7) {
		t.Fatal("root is not the socket owner and should be refused")
	}
	if accepted(65534, 7) {
		t.Fatal("another uid should be refused")
	}
	if accepted(1000, 0) != (runtime.GOOS != "linux") {
		t.Fatal("pid 0 should be refused on Linux and ignored on macOS")
	}
	info, err := unixPeerCheck(authUID, fakeCredentials(0, 7))(nil)
	if err == nil || !strings.Contains(err.Error(), "uid=0 pid=7") {
		t.Fatalf("the refusal should name uid and pid, got %v", err)
	}
	if info.UID != 0 || info.PID != 7 {
		t.Fatalf("refused peer info = %+v", info)
	}
	t.Setenv("PKEXEC_UID", "0")
	authUID, _ = authorizedUID()
	if _, err := unixPeerCheck(authUID, fakeCredentials(0, 7))(nil); err != nil {
		t.Fatalf("root owning the socket should be accepted: %v", err)
	}
}

func TestPeerCheckReportsCredentialErrors(t *testing.T) {
	boom := errors.New("getsockopt failed")
	_, err := unixPeerCheck(1000, func(net.Conn) (peerCredentials, error) { return peerCredentials{}, boom })(nil)
	if !errors.Is(err, boom) {
		t.Fatalf("want the credential error, got %v", err)
	}
}

func TestRefusedPeerGetsNoBytes(t *testing.T) {
	logs := &syncBuffer{}
	h := startHarness(t, func(cfg *Config, _ *fakeEngine) {
		cfg.PeerCheck = unixPeerCheck(1000, fakeCredentials(0, 1))
		cfg.Stderr = logs
	})
	c := h.dial()
	c.send(map[string]any{"id": 1, "cmd": "hello", "args": map[string]any{"protocol": []int{1}, "client": "lychee", "client_version": "0.2.0"}})
	if frame, ok := c.readFrame(); ok {
		t.Fatalf("a refused peer must get no bytes, got %v", frame)
	}
	logs.waitFor(t, "peer rejected: uid=0 pid=1 not authorized")
}

func TestPeerCheckRejectsOtherUid(t *testing.T) {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		t.Skip("needs root on Linux to connect as another uid")
	}
	const owner = 65534
	dir, err := os.MkdirTemp("", "netd-peer")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(dir, "s")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(sock, 0o666); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PKEXEC_UID", strconv.Itoa(owner))
	authUID, ok := authorizedUID()
	if !ok || authUID != owner {
		t.Fatalf("authorizedUID = %d,%v", authUID, ok)
	}
	logs := &syncBuffer{}
	eng := newFakeEngine()
	srv := New(Config{
		Listener: ln, PeerCheck: unixPeerCheck(authUID, socketPeerCredentials), Clock: newFakeClock(),
		Engine: eng, Version: "0.2.0", GOOS: "linux", GOARCH: "amd64",
		Auth:    AuthInfo{Model: "unix_peer_uid", Privilege: "root", UID: &authUID},
		Capture: CaptureStatus{Available: true}, Stderr: logs,
	})
	go srv.Serve()
	t.Cleanup(func() { srv.Shutdown(); ln.Close() })

	exe := worldRunnableTestBinary(t, dir)
	if got := dialAs(t, exe, dir, sock, owner); got != "accepted" {
		t.Fatalf("the socket owner (uid %d) got %q", owner, got)
	}
	if got := dialAs(t, exe, dir, sock, 0); got != "refused" {
		t.Fatalf("root, which does not own the socket, got %q", got)
	}
	if got := dialAs(t, exe, dir, sock, 1000); got != "refused" {
		t.Fatalf("a third uid got %q", got)
	}
	logs.waitFor(t, "peer rejected: uid=0 pid=")
	logs.waitFor(t, "peer rejected: uid=1000 pid=")
}

func worldRunnableTestBinary(t *testing.T, dir string) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "control.test")
	if err := os.WriteFile(exe, data, 0o755); err != nil {
		t.Fatal(err)
	}
	return exe
}

func dialAs(t *testing.T, exe, dir, sock string, uid uint32) string {
	t.Helper()
	cmd := exec.Command(exe, "-test.run", "^$")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), dialEnv+"="+sock)
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: uid, NoSetGroups: true}}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("dialer as uid %d: %v\n%s", uid, err, out)
	}
	return strings.TrimSpace(string(out))
}
