//go:build linux || darwin

package control

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/tame-gg/lychee/native/netd/internal/platform"
)

func SelfCheck(stderr io.Writer) (int, error) {
	root := os.Geteuid() == 0
	var err error
	if root {
		err = checkOwnBinary()
	}
	return selfCheckVerdict(stderr, root, pkexecLaunched(), err)
}

func checkOwnBinary() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot locate the helper binary: %w", err)
	}
	return platform.SelfCheck(exe)
}

func lstatDir(path string, wantUID int, allowGroupWorldRead bool) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symlink", path)
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a directory", path)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || int(st.Uid) != wantUID {
		return fmt.Errorf("%s is not owned by uid %d", path, wantUID)
	}
	perm := fi.Mode().Perm()
	if allowGroupWorldRead {
		if perm&0o022 != 0 {
			return fmt.Errorf("%s is group- or world-writable", path)
		}
	} else if perm&0o077 != 0 {
		return fmt.Errorf("%s has group or world permission bits", path)
	}
	return nil
}

func isConnRefused(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED)
}

func handleStalePath(path string, expectOwner int, root bool) (int, error) {
	fi, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return ExitOK, nil
	}
	if err != nil {
		return ExitRefused, err
	}
	if fi.Mode()&os.ModeSocket == 0 {
		return ExitRefused, fmt.Errorf("control path %q exists and is not a socket", path)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	ownerOK := ok && (int(st.Uid) == expectOwner || (root && st.Uid == 0))
	if !ownerOK {
		return ExitRefused, fmt.Errorf("control path %q is a socket owned by another user", path)
	}
	c, derr := net.DialTimeout("unix", path, time.Second)
	if derr != nil {
		if isConnRefused(derr) {
			if err := os.Remove(path); err != nil {
				return ExitRefused, err
			}
			return ExitOK, nil
		}
		return ExitConflict, derr
	}
	c.Close()
	return ExitConflict, fmt.Errorf("another helper is live at %q", path)
}

func createUnixSocket(path string, root bool, authUID int) (net.Listener, uint64, int, error) {
	fd, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err != nil {
		return nil, 0, ExitTransport, err
	}
	unix.CloseOnExec(fd)
	old := unix.Umask(0o077)
	berr := unix.Bind(fd, &unix.SockaddrUnix{Name: path})
	unix.Umask(old)
	if berr != nil {
		unix.Close(fd)
		return nil, 0, ExitTransport, berr
	}
	if err := os.Chmod(path, 0o600); err != nil {
		unix.Close(fd)
		return nil, 0, ExitTransport, err
	}
	if root {
		if err := os.Chown(path, authUID, -1); err != nil {
			unix.Close(fd)
			return nil, 0, ExitTransport, err
		}
	}
	if err := unix.Listen(fd, 128); err != nil {
		unix.Close(fd)
		return nil, 0, ExitTransport, err
	}
	var ino uint64
	if st, err := os.Lstat(path); err == nil {
		if s, ok := st.Sys().(*syscall.Stat_t); ok {
			ino = uint64(s.Ino)
		}
	}
	f := os.NewFile(uintptr(fd), path)
	ln, err := net.FileListener(f)
	f.Close()
	if err != nil {
		unix.Close(fd)
		return nil, 0, ExitTransport, err
	}
	return ln, ino, ExitOK, nil
}

func unlinkIfInode(path string, ino uint64) {
	fi, err := os.Lstat(path)
	if err != nil || fi.Mode()&os.ModeSocket == 0 {
		return
	}
	if s, ok := fi.Sys().(*syscall.Stat_t); ok && uint64(s.Ino) == ino {
		os.Remove(path)
	}
}

type peerCredentials struct {
	uid uint32
	pid uint32
}

func unixPeerCheck(authUID int, read func(net.Conn) (peerCredentials, error)) func(net.Conn) (PeerInfo, error) {
	return func(nc net.Conn) (PeerInfo, error) {
		cred, err := read(nc)
		if err != nil {
			return PeerInfo{}, err
		}
		info := PeerInfo{UID: int(cred.uid), PID: int(cred.pid)}
		if !decideUnixPeer(cred.uid, cred.pid, authUID, peerPidRequired) {
			return info, fmt.Errorf("uid=%d pid=%d not authorized", cred.uid, cred.pid)
		}
		return info, nil
	}
}

func peerCredError(nc net.Conn) (func(func(uintptr)) error, error) {
	type rawConn interface {
		SyscallConn() (syscall.RawConn, error)
	}
	rc, ok := nc.(rawConn)
	if !ok {
		return nil, errors.New("connection has no raw file descriptor")
	}
	raw, err := rc.SyscallConn()
	if err != nil {
		return nil, err
	}
	return raw.Control, nil
}

func ensureParentDir(path string, mode os.FileMode) error {
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, mode); err != nil {
		return err
	}
	return nil
}
