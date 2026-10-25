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

	peerPidRequired = false
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
		PeerCheck: unixPeerCheck(authUID, socketPeerCredentials),
		cleanup:   func() { unlinkIfInode(path, ino) },
	}, ExitOK, nil
}

func socketPeerCredentials(nc net.Conn) (peerCredentials, error) {
	ctrl, err := peerCredError(nc)
	if err != nil {
		return peerCredentials{}, err
	}
	var cred peerCredentials
	var ce error
	if err := ctrl(func(fd uintptr) {
		var xu *unix.Xucred
		xu, ce = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if ce != nil {
			return
		}
		pid, _ := unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
		cred = peerCredentials{uid: xu.Uid, pid: uint32(pid)}
	}); err != nil {
		return peerCredentials{}, err
	}
	if ce != nil {
		return peerCredentials{}, ce
	}
	return cred, nil
}

func CheckPrivilege() (int, error) {
	if !platform.IsAdmin() {
		return ExitRefused, errors.New("the network helper must run as root")
	}
	return ExitOK, nil
}

func pkexecLaunched() bool { return false }
