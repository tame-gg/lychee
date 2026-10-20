package tun

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	wun "golang.zx2c4.com/wireguard/tun"

	"github.com/tame-gg/lychee/native/netd/internal/logx"
	"github.com/tame-gg/lychee/native/netd/internal/nics"
)

const openHint = "needs admin and wintun.dll next to lychee-netd.exe"

var routes4win = [][2]string{{"0.0.0.0", "128.0.0.0"}, {"128.0.0.0", "128.0.0.0"}}

func init() {
	staleHook = restoreStrongHost
	wun.WintunTunnelType = "lychee-netd"

	if g, err := windows.GUIDFromString("{1a9a5bf8-8341-44fd-89a9-04ed431a8997}"); err == nil {
		wun.WintunStaticRequestedGUID = &g
	}
}

func configure(name string, mtu int) (int, []string, error) {
	if err := run("netsh", "interface", "ipv4", "set", "address", "name="+name, "source=static",
		"address="+tunIP, "mask="+tunMask, "store=active"); err != nil {
		return 0, nil, err
	}
	ifc, err := waitIface(name, 5*time.Second)
	if err != nil {
		return 0, nil, err
	}

	for try := 1; !hasAddr(ifc, tunIP); try++ {
		if try > 20 {
			return ifc.Index, nil, fmt.Errorf("adapter %q did not keep its address %s", name, tunIP)
		}
		if try%4 == 0 {
			run("netsh", "interface", "ipv4", "set", "address", "name="+name, "source=static",
				"address="+tunIP, "mask="+tunMask, "store=active")
		}
		time.Sleep(250 * time.Millisecond)
	}

	notes := startStrongHost(ifc.Index)

	idx := strconv.Itoa(ifc.Index)
	mtuArg := "mtu=" + strconv.Itoa(mtu)
	if e := run("netsh", "interface", "ipv4", "set", "subinterface", "interface="+idx, mtuArg, "store=active"); e != nil {
		notes = append(notes, fmt.Sprintf("warning: could not set IPv4 MTU: %v", e))
	}
	for _, dst := range routes4win {
		if err = run("route", "add", dst[0], "mask", dst[1], "0.0.0.0", "metric", "1", "if", idx); err != nil {
			return ifc.Index, notes, err
		}
	}

	if e := run("netsh", "interface", "ipv6", "add", "address", "interface="+idx, "address="+tunIP6+"/64", "store=active"); e != nil {
		notes = append(notes, fmt.Sprintf("warning: IPv6 not captured: %v", e))
	} else {
		if e := run("netsh", "interface", "ipv6", "set", "subinterface", "interface="+idx, mtuArg, "store=active"); e != nil {
			notes = append(notes, fmt.Sprintf("warning: could not set IPv6 MTU: %v", e))
		}
		for _, p := range routes6 {
			if e := run("netsh", "interface", "ipv6", "add", "route", "prefix="+p, "interface="+idx, "metric=1", "store=active"); e != nil {
				notes = append(notes, fmt.Sprintf("warning: IPv6 route %s: %v", p, e))
			}
		}
	}
	return ifc.Index, notes, nil
}

func delRoutes(idx int) {
	defer stopStrongHost()
	for _, dst := range routes4win {
		run("route", "delete", dst[0], "mask", dst[1], "0.0.0.0", "if", strconv.Itoa(idx))
	}
	for _, p := range routes6 {
		run("netsh", "interface", "ipv6", "delete", "route", "prefix="+p, "interface="+strconv.Itoa(idx), "store=active")
	}
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func waitIface(name string, d time.Duration) (*net.Interface, error) {
	deadline := time.Now().Add(d)
	for {
		ifc, err := net.InterfaceByName(name)
		if err == nil {
			return ifc, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("adapter %q did not appear: %w", name, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func hasAddr(ifc *net.Interface, ip string) bool {
	addrs, _ := ifc.Addrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.String() == ip {
			return true
		}
	}
	return false
}

var strongHost struct {
	mu      sync.Mutex
	checked map[int]bool
	restore []string
	stop    chan struct{}
}

const weakHostDirSDDL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

func weakHostDir() (string, error) {
	base, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "Lychee")
	sd, err := windows.SecurityDescriptorFromString(weakHostDirSDDL)
	if err != nil {
		return "", err
	}
	sa := &windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	name, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return "", err
	}
	if err := windows.CreateDirectory(name, sa); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return "", err
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	if !fi.IsDir() || fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
		return "", fmt.Errorf("%s is not a plain directory", dir)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return "", err
	}
	if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return "", err
	}
	return dir, nil
}

func writeWeakHostFile(lines []string) error {
	dir, err := weakHostDir()
	if err != nil {
		return err
	}
	path := filepath.Join(dir, weakHostFileName)
	os.Remove(path)
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600)
}

func readWeakHostFile() []string {
	dir, err := weakHostDir()
	if err != nil {
		return nil
	}
	path := filepath.Join(dir, weakHostFileName)
	if fi, err := os.Lstat(path); err != nil || !fi.Mode().IsRegular() {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return strings.Split(string(b), "\n")
}

func removeWeakHostFile() {
	if dir, err := weakHostDir(); err == nil {
		os.Remove(filepath.Join(dir, weakHostFileName))
	}
}

func startStrongHost(tunIdx int) []string {
	stop := make(chan struct{})
	strongHost.mu.Lock()
	strongHost.checked, strongHost.restore, strongHost.stop = map[int]bool{tunIdx: true}, nil, stop
	strongHost.mu.Unlock()
	notes := syncStrongHost(stop)
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				for _, n := range syncStrongHost(stop) {
					logx.Printf("%s\n", n)
				}
			}
		}
	}()
	return notes
}

func syncStrongHost(stop chan struct{}) []string {
	found, _ := nics.DiscoverNics(nil, nil)
	strongHost.mu.Lock()
	defer strongHost.mu.Unlock()
	if strongHost.stop != stop {
		return nil
	}
	var idx []string
	for _, n := range found {
		if !strongHost.checked[n.Index] {
			strongHost.checked[n.Index] = true
			idx = append(idx, strconv.Itoa(n.Index))
		}
	}
	if len(idx) == 0 {
		return nil
	}

	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"Get-NetIPInterface -InterfaceIndex "+strings.Join(idx, ",")+" -ErrorAction SilentlyContinue | "+
			"Where-Object { $_.WeakHostSend -eq 'Enabled' -or $_.Forwarding -eq 'Enabled' } | "+
			"ForEach-Object { '{0} {1} {2} {3}' -f $_.AddressFamily, $_.InterfaceIndex, $_.WeakHostSend, $_.Forwarding }").Output()
	if err != nil {
		return []string{fmt.Sprintf("warning: could not check the adapters' weak host setting: %v", err)}
	}
	var notes []string
	for _, psLine := range strings.Split(string(out), "\n") {
		line, ok := weakHostRestoreLine(psLine)
		if !ok {
			continue
		}
		f := strings.Fields(line)
		if err := run("netsh", "interface", f[0], "set", "interface", "interface="+f[1],
			"weakhostsend=disabled", "forwarding=disabled", "store=active"); err != nil {
			notes = append(notes, fmt.Sprintf("warning: %v", err))
			continue
		}
		strongHost.restore = append(strongHost.restore, line)
		notes = append(notes, fmt.Sprintf("note: turned off weak host send and forwarding on adapter %s (%s) while merging; "+
			"Windows ignores pinned connections there. Sharing its connection (Mobile Hotspot) pauses until merging is off.", f[1], f[0]))
	}
	if err := writeWeakHostFile(strongHost.restore); err != nil {
		notes = append(notes, fmt.Sprintf("warning: could not save the weak host restore file: %v", err))
	}
	return notes
}

func stopStrongHost() {
	strongHost.mu.Lock()
	defer strongHost.mu.Unlock()
	if strongHost.stop != nil {
		close(strongHost.stop)
		strongHost.stop = nil
	}
	putBack(strongHost.restore)
	strongHost.restore = nil
	removeWeakHostFile()
}

func restoreStrongHost() {
	putBack(readWeakHostFile())
	removeWeakHostFile()
}

func putBack(lines []string) {
	for _, l := range lines {
		if f, ok := parseWeakHostLine(l); ok {
			run("netsh", "interface", f[0], "set", "interface", "interface="+f[1], f[2], f[3], "store=active")
		}
	}
}
