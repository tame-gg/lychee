package platform

import (
	"os"

	"golang.org/x/sys/unix"
)

func IsAdmin() bool { return os.Geteuid() == 0 }

const (
	lockPath         = "/var/run/lychee-netd.lock"
	netMergeLockPath = "/var/run/net-merge.lock"
)

var lockFile *os.File

func SingleInstance() bool {
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return false
	}
	if unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB) != nil {
		f.Close()
		return false
	}
	lockFile = f
	return true
}

func InstanceRunning() bool { return lockHeld(lockPath) }

func NetMergeRunning() bool { return lockHeld(netMergeLockPath) }

func lockHeld(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	if unix.Flock(int(f.Fd()), unix.LOCK_SH|unix.LOCK_NB) != nil {
		return true
	}
	unix.Flock(int(f.Fd()), unix.LOCK_UN)
	return false
}

func CheckDriver() error { return nil }
