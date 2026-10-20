package tun

import (
	"fmt"
	"net"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

const openHint = "needs root or CAP_NET_ADMIN, and /dev/net/tun"

func configure(name string, _ int) (int, []string, error) {
	link, err := netlink.LinkByName(name)
	if err != nil {
		return 0, nil, fmt.Errorf("adapter %q did not appear: %w", name, err)
	}
	idx := link.Attrs().Index
	if err := netlink.AddrReplace(link, &netlink.Addr{IPNet: hostCIDR(tunIP + "/24")}); err != nil {
		return idx, nil, fmt.Errorf("set address: %w", err)
	}
	if err := netlink.LinkSetUp(link); err != nil {
		return idx, nil, fmt.Errorf("bring up: %w", err)
	}
	for _, dst := range routes4 {
		if err := netlink.RouteReplace(tunRoute(idx, dst)); err != nil {
			return idx, nil, fmt.Errorf("route %s: %w", dst, err)
		}
	}

	var notes []string
	if err := netlink.AddrReplace(link, &netlink.Addr{IPNet: hostCIDR(tunIP6 + "/64"), Flags: unix.IFA_F_NODAD}); err != nil {
		notes = append(notes, fmt.Sprintf("warning: IPv6 not captured: %v", err))
	} else {
		for _, dst := range routes6 {
			if err := netlink.RouteReplace(tunRoute(idx, dst)); err != nil {
				notes = append(notes, fmt.Sprintf("warning: IPv6 route %s: %v", dst, err))
			}
		}
	}
	return idx, notes, nil
}

func delRoutes(idx int) {
	for _, dst := range append(append([]string{}, routes4...), routes6...) {
		netlink.RouteDel(tunRoute(idx, dst))
	}
}

func tunRoute(idx int, dst string) *netlink.Route {
	return &netlink.Route{LinkIndex: idx, Dst: prefix(dst), Scope: netlink.SCOPE_LINK}
}

func hostCIDR(s string) *net.IPNet {
	ip, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	n.IP = ip
	return n
}

func prefix(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	return n
}
