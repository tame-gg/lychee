package nics

import (
	"net"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/net/route"
	"golang.org/x/sys/unix"
)

type adapterInfo struct {
	v4, v6  bool
	virtual string
	desc    string
}

var hardwareName = regexp.MustCompile(`^(en|feth)\d+$`)

func adapterInfos() (map[int]adapterInfo, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	m := map[int]adapterInfo{}
	for _, ifc := range ifaces {
		info := adapterInfo{desc: portName(ifc.Name)}
		if !hardwareName.MatchString(ifc.Name) {
			info.virtual = "tunnel/virtual interface (not an enN/fethN device)"
		}
		m[ifc.Index] = info
	}
	routes, err := DefaultRoutes()
	if err != nil {
		return nil, err
	}
	for _, r := range routes {
		cur, ok := m[r.Index]
		if !ok {
			continue
		}
		if r.V6 {
			cur.v6 = true
		} else {
			cur.v4 = true
		}
		m[r.Index] = cur
	}
	return m, nil
}

type DefaultRoute struct {
	Index  int
	Name   string
	GW     net.IP
	V6     bool
	Scoped bool
}

func DefaultRoutes() ([]DefaultRoute, error) {
	rib, err := route.FetchRIB(syscall.AF_UNSPEC, route.RIBTypeRoute, 0)
	if err != nil {
		return nil, err
	}
	msgs, err := route.ParseRIB(route.RIBTypeRoute, rib)
	if err != nil {
		return nil, err
	}
	var out []DefaultRoute
	for _, msg := range msgs {
		rm, ok := msg.(*route.RouteMessage)
		if !ok || rm.Flags&(syscall.RTF_HOST|syscall.RTF_REJECT|syscall.RTF_BLACKHOLE) != 0 || len(rm.Addrs) <= syscall.RTAX_NETMASK {
			continue
		}
		var v6 bool
		switch dst := rm.Addrs[syscall.RTAX_DST].(type) {
		case *route.Inet4Addr:
			if dst.IP != [4]byte{} {
				continue
			}
		case *route.Inet6Addr:
			if dst.IP != [16]byte{} {
				continue
			}
			v6 = true
		default:
			continue
		}
		if !zeroMask(rm.Addrs[syscall.RTAX_NETMASK]) {
			continue
		}
		ifc, err := net.InterfaceByIndex(rm.Index)
		if err != nil {
			continue
		}
		r := DefaultRoute{Index: rm.Index, Name: ifc.Name, V6: v6, Scoped: rm.Flags&unix.RTF_IFSCOPE != 0}
		if len(rm.Addrs) > syscall.RTAX_GATEWAY {
			switch gw := rm.Addrs[syscall.RTAX_GATEWAY].(type) {
			case *route.Inet4Addr:
				r.GW = net.IP(gw.IP[:])
			case *route.Inet6Addr:
				ip := net.IP(append([]byte(nil), gw.IP[:]...))
				if ip.IsLinkLocalUnicast() {
					ip[2], ip[3] = 0, 0
				}
				r.GW = ip
			}
		}
		out = append(out, r)
	}
	return out, nil
}

func zeroMask(a route.Addr) bool {
	switch a := a.(type) {
	case nil:
		return true
	case *route.Inet4Addr:
		return a.IP == [4]byte{}
	case *route.Inet6Addr:
		return a.IP == [16]byte{}
	}
	return false
}

var ports struct {
	mu    sync.Mutex
	at    time.Time
	names map[string]string
}

func portName(ifname string) string {
	ports.mu.Lock()
	defer ports.mu.Unlock()
	if n, ok := ports.names[ifname]; ok || !hardwareName.MatchString(ifname) {
		return n
	}
	if time.Since(ports.at) > 10*time.Second {
		ports.at, ports.names = time.Now(), listPorts()
	}
	return ports.names[ifname]
}

func listPorts() map[string]string {
	out, err := exec.Command("/usr/sbin/networksetup", "-listallhardwareports").Output()
	if err != nil {
		return nil
	}
	names := map[string]string{}
	var port string
	for _, line := range strings.Split(string(out), "\n") {
		if v, ok := strings.CutPrefix(line, "Hardware Port: "); ok {
			port = v
		} else if v, ok := strings.CutPrefix(line, "Device: "); ok && port != "" {
			names[strings.TrimSpace(v)] = port
		}
	}
	return names
}
