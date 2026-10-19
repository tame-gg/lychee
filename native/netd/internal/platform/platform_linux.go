package platform

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func IsAdmin() bool {
	f, err := os.Open("/proc/self/status")
	if err != nil {
		return os.Geteuid() == 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "CapEff:"); ok {
			caps, err := strconv.ParseUint(strings.TrimSpace(v), 16, 64)
			return err == nil && caps&(1<<unix.CAP_NET_ADMIN) != 0
		}
	}
	return os.Geteuid() == 0
}

const (
	lockAddr         = "@lychee-netd"
	netMergeLockAddr = "@net-merge"
)

var lock net.Listener

func SingleInstance() bool {
	ln, err := net.Listen("unix", lockAddr)
	if err != nil {
		return false
	}
	lock = ln
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	return true
}

func InstanceRunning() bool { return lockHeld(lockAddr) }

func NetMergeRunning() bool { return lockHeld(netMergeLockAddr) }

func lockHeld(addr string) bool {
	c, err := net.DialTimeout("unix", addr, time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func CheckDriver() error {
	if _, err := os.Stat("/dev/net/tun"); err != nil {
		return fmt.Errorf("/dev/net/tun not found (try: sudo modprobe tun): %w", err)
	}
	return nil
}
