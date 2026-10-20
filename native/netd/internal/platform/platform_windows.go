package platform

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func IsAdmin() bool { return windows.GetCurrentProcessToken().IsElevated() }

const (
	mutexName         = `Global\lychee-netd`
	netMergeMutexName = `Global\net-merge`
)

var mutexHandle windows.Handle

func SingleInstance() bool {
	name, err := windows.UTF16PtrFromString(mutexName)
	if err != nil {
		return false
	}
	h, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		if h != 0 {
			windows.CloseHandle(h)
		}
		return false
	}
	if err != nil && h == 0 {
		return false
	}
	mutexHandle = h
	return true
}

func InstanceRunning() bool { return mutexHeld(mutexName) }

func NetMergeRunning() bool { return mutexHeld(netMergeMutexName) }

func mutexHeld(name string) bool {
	n, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return false
	}
	h, err := windows.OpenMutex(windows.SYNCHRONIZE, false, n)
	if err == nil {
		windows.CloseHandle(h)
		return true
	}
	return err == windows.ERROR_ACCESS_DENIED
}

func CheckDriver() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot locate lychee-netd.exe: %w", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(exe), "wintun.dll")); err != nil {
		return fmt.Errorf("wintun.dll not found next to %s", exe)
	}
	return nil
}
