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
	darwinRootDir  = "/var/run/lychee-netd"
	darwinRootSock = darwinRootDir + "/netd.sock"
)

func Listen(path string) (*Transport, int, error) {
	authUID, ok := authorizedUID()
	if !ok {
		return nil, ExitRefused, errors.New("SUDO_UID is not a valid uid")
	}
	if path != darwinRootSock {
		return nil, ExitRefused, fmt.Errorf("helper must use %s", darwinRootSock)
	}
	if err := os.MkdirAll(darwinRootDir, 0o755); err != nil {
		return nil, ExitRefused, err
	}
	for _, d := range []string{darwinRootDir, "/private" + darwinRootDir} {
		resolved, err := filepath.EvalSymlinks(d)
		if err != nil {
			continue
		}
		if err := platform.RootOnly(resolved); err != nil {
			return nil, ExitRefused, err
		}
	}
	if err := lstatDir(darwinRootDir, 0, true); err != nil {
		return nil, ExitRefused, err
	}
	if code, err := handleStalePath(path, authUID, true); err != nil {
		return nil, code, err
	}
	ln, ino, code, err := createUnixSocket(path, true, authUID)
	if err != nil {
		return nil, code, err
	}
	uid := authUID
	return &Transport{
		Listener:  ln,
		Auth:      AuthInfo{Model: "unix_peer_uid", Privilege: "root", UID: &uid},
		PeerCheck: darwinPeerCheck(authUID),
		cleanup:   func() { unlinkIfInode(path, ino) },
	}, ExitOK, nil
}

func darwinPeerCheck(authUID int) func(net.Conn) (PeerInfo, error) {
	return func(nc net.Conn) (PeerInfo, error) {
		ctrl, err := peerCredError(nc)
		if err != nil {
			return PeerInfo{}, err
		}
		var uid uint32
		var pid int
		var ce error
		if err := ctrl(func(fd uintptr) {
			var xu *unix.Xucred
			xu, ce = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
			if ce != nil {
				return
			}
			uid = xu.Uid
			pid, _ = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
		}); err != nil {
			return PeerInfo{}, err
		}
		if ce != nil {
			return PeerInfo{}, ce
		}
		info := PeerInfo{UID: int(uid), PID: pid}
		if !decideUnixPeer(uid, uint32(pid), authUID, false) {
			return info, fmt.Errorf("uid=%d not authorized", uid)
		}
		return info, nil
	}
}

func CheckPrivilege() (int, error) {
	if !platform.IsAdmin() {
		return ExitRefused, errors.New("the network helper must run as root")
	}
	return ExitOK, nil
}

func pkexecLaunched() bool { return false }
