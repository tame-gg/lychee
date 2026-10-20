package nics

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

type adapterInfo struct {
	v4, v6  bool
	virtual string
	desc    string
}

func physicalIfType(t uint32) bool {
	switch t {
	case 6, 62, 69, 117,
		71,
		243, 244:
		return true
	}
	return false
}

func adapterInfos() (map[int]adapterInfo, error) {
	const flags = windows.GAA_FLAG_INCLUDE_GATEWAYS | windows.GAA_FLAG_SKIP_ANYCAST |
		windows.GAA_FLAG_SKIP_MULTICAST | windows.GAA_FLAG_SKIP_DNS_SERVER
	size := uint32(32 << 10)
	for try := 0; try < 4; try++ {
		buf := make([]byte, size)
		aa := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0]))
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, flags, 0, aa, &size)
		if err == windows.ERROR_BUFFER_OVERFLOW {
			continue
		}
		if err != nil {
			return nil, err
		}
		m := map[int]adapterInfo{}
		for a := aa; a != nil; a = a.Next {
			if a.OperStatus != windows.IfOperStatusUp {
				continue
			}
			info := adapterInfo{desc: windows.UTF16PtrToString(a.Description)}
			if !physicalIfType(a.IfType) {
				info.virtual = fmt.Sprintf("tunnel/virtual interface type %d (%s)", a.IfType, info.desc)
			}
			for g := a.FirstGatewayAddress; g != nil; g = g.Next {
				if g.Address.Sockaddr == nil {
					continue
				}
				switch g.Address.Sockaddr.Addr.Family {
				case windows.AF_INET:
					info.v4 = true
				case windows.AF_INET6:
					info.v6 = true
				}
			}

			for _, idx := range []uint32{a.IfIndex, a.Ipv6IfIndex} {
				if idx == 0 {
					continue
				}
				cur := m[int(idx)]
				cur.v4, cur.v6 = cur.v4 || info.v4, cur.v6 || info.v6
				cur.virtual, cur.desc = info.virtual, info.desc
				m[int(idx)] = cur
			}
		}
		return m, nil
	}
	return nil, windows.ERROR_BUFFER_OVERFLOW
}
