package nics

import (
	"encoding/binary"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	rtmIfInfo2 = 0x12
	offIBytes  = 32 + 64
	offOBytes  = 32 + 72
)

func Octets(idx int) (in, out uint64, ok bool) {
	if idx <= 0 {
		return 0, 0, false
	}
	rib, err := syscall.RouteRIB(unix.NET_RT_IFLIST2, idx)
	if err != nil {
		return 0, 0, false
	}
	for len(rib) >= 4 {
		n := int(binary.LittleEndian.Uint16(rib))
		if n < 4 || n > len(rib) {
			return 0, 0, false
		}
		if rib[3] == rtmIfInfo2 && n >= offOBytes+8 && int(binary.LittleEndian.Uint16(rib[12:])) == idx {
			return binary.LittleEndian.Uint64(rib[offIBytes:]), binary.LittleEndian.Uint64(rib[offOBytes:]), true
		}
		rib = rib[n:]
	}
	return 0, 0, false
}
