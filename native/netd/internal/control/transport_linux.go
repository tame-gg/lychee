package control

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"

	"github.com/tame-gg/lychee/native/netd/internal/platform"
)

const (
	linuxRootDir  = "/run/lychee-netd"
	linuxRootSock = linuxRootDir + "/netd.sock"
)

func Listen(path string) (*Transport, int, error) {
	if os.Geteuid() == 0 {
		return listenRootLinux(path)
	}
	return listenUserLinux(path)
}

func listenRootLinux(path string) (*Transport, int, error) {
	authUID, ok := authorizedUID()
	if !ok {
		return nil, ExitRefused, errors.New("PKEXEC_UID/SUDO_UID is not a valid uid")
	}
	if path != linuxRootSock {
		return nil, ExitRefused, fmt.Errorf("root helper must use %s", linuxRootSock)
	}
	if err := os.MkdirAll(linuxRootDir, 0o755); err != nil {
		return nil, ExitRefused, err
	}
	if err := lstatDir(linuxRootDir, 0, true); err != nil {
		return nil, ExitRefused, err
	}
	if err := lstatDir("/run", 0, true); err != nil {
		return nil, ExitRefused, err
	}
	if err := platform.RootOnly(linuxRootDir); err != nil {
		return nil, ExitRefused, err
	}
	return finishUnix(path, true, authUID, "root")
}

func listenUserLinux(path string) (*Transport, int, error) {
	uid := os.Getuid()
	if err := checkXDGRuntimeDir(uid); err != nil {
		return nil, ExitRefused, err
	}
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, ExitRefused, err
	}
	if err := lstatDir(parent, uid, false); err != nil {
		return nil, ExitRefused, err
	}
	return finishUnix(path, false, uid, "capabilities")
}

func checkXDGRuntimeDir(uid int) error {
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" || !filepath.IsAbs(dir) {
		return errors.New("XDG_RUNTIME_DIR is not set to an absolute path")
	}
	return lstatDir(dir, uid, false)
}

func finishUnix(path string, root bool, authUID int, privilege string) (*Transport, int, error) {
	if code, err := handleStalePath(path, authUID, root); err != nil {
		return nil, code, err
	}
	ln, ino, code, err := createUnixSocket(path, root, authUID)
	if err != nil {
		return nil, code, err
	}
	uid := authUID
	return &Transport{
		Listener:  ln,
		Auth:      AuthInfo{Model: "unix_peer_uid", Privilege: privilege, UID: &uid},
		PeerCheck: unixPeerCheck(authUID),
		cleanup:   func() { unlinkIfInode(path, ino) },
	}, ExitOK, nil
}

func unixPeerCheck(authUID int) func(net.Conn) (PeerInfo, error) {
	return func(nc net.Conn) (PeerInfo, error) {
		ctrl, err := peerCredError(nc)
		if err != nil {
			return PeerInfo{}, err
		}
		var cred *unix.Ucred
		var ce error
		if err := ctrl(func(fd uintptr) {
			cred, ce = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		}); err != nil {
			return PeerInfo{}, err
		}
		if ce != nil {
			return PeerInfo{}, ce
		}
		info := PeerInfo{UID: int(cred.Uid), PID: int(cred.Pid)}
		if !decideUnixPeer(cred.Uid, uint32(cred.Pid), authUID, true) {
			return info, fmt.Errorf("uid=%d pid=%d not authorized", cred.Uid, cred.Pid)
		}
		return info, nil
	}
}
