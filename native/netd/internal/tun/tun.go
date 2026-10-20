package tun

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip/stack"

	"github.com/xjasonlyu/tun2socks/v2/core"
	"github.com/xjasonlyu/tun2socks/v2/core/device"
	"github.com/xjasonlyu/tun2socks/v2/core/device/tun"
	"github.com/xjasonlyu/tun2socks/v2/core/option"
	tlog "github.com/xjasonlyu/tun2socks/v2/log"
	M "github.com/xjasonlyu/tun2socks/v2/metadata"
	"github.com/xjasonlyu/tun2socks/v2/proxy/reject"
	"github.com/xjasonlyu/tun2socks/v2/tunnel"

	"github.com/tame-gg/lychee/native/netd/internal/engine"
	"github.com/tame-gg/lychee/native/netd/internal/logx"
)

const (
	tunName = "lychee-netd"
	tunIP   = "198.18.0.1"
	tunMask = "255.255.255.0"

	tunIP6 = "fd6e:6d65:7267::1"
)

var openName = tunName

var staleHook func()

var (
	routes4 = []string{"0.0.0.0/1", "128.0.0.0/1"}
	routes6 = []string{"::/1", "8000::/1"}
)

type tunProxy struct{ b *engine.Balancer }

func (p tunProxy) DialContext(ctx context.Context, m *M.Metadata) (net.Conn, error) {
	return p.b.DialPinned(ctx, m.DstIP.Unmap().String(), int(m.DstPort))
}

func (p tunProxy) DialUDP(m *M.Metadata) (net.PacketConn, error) {
	f := engine.Fam4
	if d := m.DstIP.Unmap(); d.Is6() {
		f = engine.Fam6
	}
	return p.b.ListenUDP(context.Background(), f)
}

type Tun struct {
	mu  sync.Mutex
	B   *engine.Balancer
	MTU int
	dev device.Device
	stk *stack.Stack
	idx int
	on  bool
}

const DefaultMTU = 9000

const udpSessionTimeout = 30 * time.Second

func New(b *engine.Balancer) *Tun { return &Tun{B: b, MTU: DefaultMTU} }

func (t *Tun) IsOn() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.on
}

func (t *Tun) Name() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.dev == nil {
		return ""
	}
	return t.dev.Name()
}

var keepDevice bool

func (t *Tun) open() error {

	if lvl, e := tlog.ParseLevel("error"); e == nil {
		tlog.SetLogger(tlog.Must(tlog.NewLeveled(lvl)))
	}
	tunnel.T().SetUDPTimeout(udpSessionTimeout)
	CleanupStale()

	dev, err := tun.Open(openName, uint32(t.MTU))
	if err != nil {
		return fmt.Errorf("open TUN (%s): %w", openHint, err)
	}
	stk, err := core.CreateStack(&core.Config{
		LinkEndpoint:     dev,
		TransportHandler: tunnel.T(),
		Options:          []option.Option{option.WithTCPModerateReceiveBuffer(true)},
	})
	if err != nil {
		dev.Close()
		return err
	}
	installForwarders(stk, t.B.V6Allowed)
	t.dev, t.stk = dev, stk
	return nil
}

func (t *Tun) Warm() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !keepDevice || t.dev != nil {
		return nil
	}
	return t.open()
}

func (t *Tun) On() error {
	t.mu.Lock()
	notes, err := t.turnOn()
	t.mu.Unlock()
	for _, n := range notes {
		logx.Printf("%s\n", n)
	}
	return err
}

func (t *Tun) turnOn() (notes []string, err error) {
	if t.on {
		return nil, nil
	}
	if t.dev == nil {
		if err = t.open(); err != nil {
			return nil, err
		}
	}
	defer func() {
		if err != nil {
			t.teardown()
		}
	}()
	tunnel.T().SetProxy(tunProxy{t.B})

	t.idx, notes, err = configure(t.dev.Name(), t.MTU)
	if err != nil {
		return notes, err
	}
	t.on = true
	return notes, nil
}

func (t *Tun) Off() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if keepDevice && t.dev != nil {
		if t.idx != 0 {
			delRoutes(t.idx)
		}
		tunnel.T().SetProxy(&reject.Reject{})
		t.on = false
		return
	}
	t.teardown()
}

func (t *Tun) Close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.teardown()
}

func (t *Tun) teardown() {
	if t.idx != 0 {
		delRoutes(t.idx)
	}
	tunnel.T().SetProxy(&reject.Reject{})
	if t.dev != nil {
		t.dev.Close()
	}
	if t.stk != nil {
		done := make(chan struct{})
		go func() { t.stk.Close(); t.stk.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	}
	t.dev, t.stk, t.idx, t.on = nil, nil, 0, false
}

func CleanupStale() {
	if staleHook != nil {
		staleHook()
	}
	if ifc, err := net.InterfaceByName(tunName); err == nil {
		delRoutes(ifc.Index)
	}
}
