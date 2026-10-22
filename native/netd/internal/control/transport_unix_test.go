//go:build linux || darwin

package control

import (
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/tame-gg/lychee/native/netd/internal/platform"
)

func timeNow() time.Time { return time.Now() }

func needLinuxUser(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("user/capabilities control path is Linux-only")
	}
	if os.Geteuid() == 0 {
		t.Skip("this test exercises the unprivileged user path")
	}
}

func userControlPath(t *testing.T) string {
	t.Helper()
	xdg, err := os.MkdirTemp("", "xdg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(xdg) })
	os.Chmod(xdg, 0o700)
	t.Setenv("XDG_RUNTIME_DIR", xdg)
	dir := filepath.Join(xdg, "lychee")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "netd.sock")
}

func TestSocketModeAndOwner(t *testing.T) {
	needLinuxUser(t)
	path := userControlPath(t)
	tr, code, err := Listen(path)
	if err != nil {
		t.Fatalf("Listen failed (code %d): %v", code, err)
	}
	defer tr.Close()
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %o, want 0600", fi.Mode().Perm())
	}
	di, _ := os.Lstat(filepath.Dir(path))
	if di.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode = %o, want 0700", di.Mode().Perm())
	}
	if tr.Auth.Model != "unix_peer_uid" || tr.Auth.UID == nil || *tr.Auth.UID != os.Getuid() {
		t.Fatalf("auth wrong: %+v", tr.Auth)
	}
}

func TestRefusesSymlinkPath(t *testing.T) {
	needLinuxUser(t)
	path := userControlPath(t)
	os.Symlink("/tmp/whatever", path)
	_, code, err := Listen(path)
	if err == nil || code != ExitRefused {
		t.Fatalf("symlink path should be refused (exit 3), got code %d err %v", code, err)
	}
	if _, e := os.Lstat(path); e != nil {
		t.Fatal("the symlink must not be unlinked")
	}
}

func TestRefusesRegularFile(t *testing.T) {
	needLinuxUser(t)
	path := userControlPath(t)
	os.WriteFile(path, []byte("x"), 0o600)
	_, code, err := Listen(path)
	if err == nil || code != ExitRefused {
		t.Fatalf("regular file should be refused (exit 3), got code %d err %v", code, err)
	}
}

func TestStaleSocketReplaced(t *testing.T) {
	needLinuxUser(t)
	path := userControlPath(t)
	fd, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Bind(fd, &unix.SockaddrUnix{Name: path}); err != nil {
		t.Fatal(err)
	}
	unix.Close(fd)
	tr, code, err := Listen(path)
	if err != nil {
		t.Fatalf("stale socket should be replaced, got code %d err %v", code, err)
	}
	defer tr.Close()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("new socket should accept connections: %v", err)
	}
	c.Close()
}

func TestLiveSocketRefused(t *testing.T) {
	needLinuxUser(t)
	path := userControlPath(t)
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_, code, err := Listen(path)
	if err == nil || code != ExitConflict {
		t.Fatalf("live socket should give exit 4, got code %d err %v", code, err)
	}
	if _, e := os.Lstat(path); e != nil {
		t.Fatal("a live socket must not be unlinked")
	}
}

func TestXDGRuntimeDirChecks(t *testing.T) {
	needLinuxUser(t)
	dir := filepath.Join(t.TempDir(), "lychee")
	os.MkdirAll(dir, 0o700)
	path := filepath.Join(dir, "netd.sock")

	t.Setenv("XDG_RUNTIME_DIR", "")
	if _, code, _ := Listen(path); code != ExitRefused {
		t.Fatal("unset XDG_RUNTIME_DIR should be refused")
	}
	t.Setenv("XDG_RUNTIME_DIR", "relative/path")
	if _, code, _ := Listen(path); code != ExitRefused {
		t.Fatal("relative XDG_RUNTIME_DIR should be refused")
	}
	loose, _ := os.MkdirTemp("", "loose")
	defer os.RemoveAll(loose)
	os.Chmod(loose, 0o755)
	t.Setenv("XDG_RUNTIME_DIR", loose)
	if _, code, _ := Listen(path); code != ExitRefused {
		t.Fatal("0755 XDG_RUNTIME_DIR should be refused")
	}
}

func TestRootRequiresFixedPath(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root-only")
	}
	_, code, err := Listen("/tmp/x.sock")
	if err == nil || code != ExitRefused {
		t.Fatalf("root helper with a non-fixed path should exit 3, got %d %v", code, err)
	}
}

func TestSelfCheckWhenRoot(t *testing.T) {
	if runtime.GOOS != "darwin" && !(runtime.GOOS == "linux" && os.Geteuid() == 0) {
		t.Skip("self-check applies to macOS and to Linux running as root")
	}
	t.Skip("covered by the privileged smoke scripts")
}

func TestRefusesNetMergeLock(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("abstract-socket lock probe is tested on Linux")
	}
	ln, err := net.Listen("unix", "@net-merge")
	if err != nil {
		t.Skipf("cannot hold @net-merge: %v", err)
	}
	defer ln.Close()
	if !platform.NetMergeRunning() {
		t.Fatal("NetMergeRunning should detect a held @net-merge lock")
	}
}

var _ = syscall.Stat_t{}

func TestRealPeerCheckAcceptsSelf(t *testing.T) {
	needLinuxUser(t)
	path := userControlPath(t)
	tr, code, err := Listen(path)
	if err != nil {
		t.Fatalf("Listen failed (code %d): %v", code, err)
	}
	eng := newFakeEngine()
	eng.present("Wi-Fi")
	srv := New(Config{
		Listener: tr.Listener, PeerCheck: tr.PeerCheck, Clock: newFakeClock(),
		Engine: eng, Version: "0.2.0", GOOS: "linux", GOARCH: "amd64",
		Auth: tr.Auth, Capture: CaptureStatus{Available: true},
	})
	exited := make(chan int, 1)
	go func() { exited <- srv.Serve() }()
	t.Cleanup(func() { srv.Shutdown(); tr.Close() })

	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.Write([]byte(`{"id":1,"cmd":"hello","args":{"protocol":[1],"client":"lychee","client_version":"0.2.0"}}` + "\n"))
	buf := make([]byte, 4096)
	conn.SetReadDeadline(timeNow().Add(2e9))
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("real peer check rejected self: %v", err)
	}
	if !strings.Contains(string(buf[:n]), `"ok":true`) {
		t.Fatalf("expected hello ok, got %s", buf[:n])
	}
}
