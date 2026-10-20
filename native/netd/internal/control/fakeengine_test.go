package control

import (
	"sync"

	"github.com/tame-gg/lychee/native/netd/internal/engine"
	"github.com/tame-gg/lychee/native/netd/internal/nics"
)

var _ Engine = (*fakeEngine)(nil)

type fakeEngine struct {
	mu          sync.Mutex
	slots       []engine.SlotStats
	adapters    []AdapterInfo
	skipped     []nics.Skip
	discSeq     uint64
	excluded    map[string]bool
	overrides   map[string]float64
	known       map[string]bool
	on          bool
	tunName     string
	v6mode      engine.V6Mode
	v6allowed   bool
	v6state     string
	onErr       error
	offErr      error
	cleanupErr  error
	onCalls     int
	offCalls    int
	cleanupCnt  int
	setWeightRx []string
	setExclRx   []string
	offHook     func()
}

func newFakeEngine() *fakeEngine {
	return &fakeEngine{
		excluded:  map[string]bool{},
		overrides: map[string]float64{},
		known:     map[string]bool{},
		tunName:   "",
		v6state:   "auto: refused, apps fall back to IPv4 so every adapter is used (not every adapter has IPv6)",
	}
}

func (f *fakeEngine) Snapshot() []engine.SlotStats {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]engine.SlotStats(nil), f.slots...)
}

func (f *fakeEngine) Adapters() []AdapterInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]AdapterInfo(nil), f.adapters...)
}

func (f *fakeEngine) Skipped() []nics.Skip {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]nics.Skip(nil), f.skipped...)
}

func (f *fakeEngine) DiscoverySeq() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.discSeq
}

func (f *fakeEngine) Excluded(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.excluded[name]
}

func (f *fakeEngine) WeightMode(name string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.overrides[name]; ok {
		return "manual"
	}
	return "auto"
}

func (f *fakeEngine) On() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onCalls++
	if f.onErr != nil {
		return f.onErr
	}
	f.on = true
	if f.tunName == "" {
		f.tunName = "lychee-netd"
	}
	return nil
}

func (f *fakeEngine) Off() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.offCalls++
	f.on = false
	if f.offHook != nil {
		f.offHook()
	}
	return f.offErr
}

func (f *fakeEngine) IsOn() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.on
}

func (f *fakeEngine) TunName() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.on {
		return f.tunName
	}
	return ""
}

func (f *fakeEngine) SetV6Mode(m engine.V6Mode) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.v6mode = m
}

func (f *fakeEngine) V6Mode() engine.V6Mode {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.v6mode
}

func (f *fakeEngine) V6Allowed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.v6allowed
}

func (f *fakeEngine) V6State() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.v6state
}

func (f *fakeEngine) SetExcluded(name string, excluded bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.setExclRx = append(f.setExclRx, name)
	if !f.known[name] && !f.excluded[name] {
		return ErrUnknownAdapter
	}
	f.excluded[name] = excluded
	return nil
}

func (f *fakeEngine) SetWeight(name string, weight float64, auto bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.setWeightRx = append(f.setWeightRx, name)
	if !f.known[name] {
		if _, ok := f.overrides[name]; !ok {
			return ErrUnknownAdapter
		}
	}
	if auto {
		delete(f.overrides, name)
	} else {
		f.overrides[name] = weight
	}
	return nil
}

func (f *fakeEngine) Cleanup() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cleanupCnt++
	return f.cleanupErr
}

func (f *fakeEngine) addKnown(names ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, n := range names {
		f.known[n] = true
	}
}

func (f *fakeEngine) setSlots(slots ...engine.SlotStats) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.slots = slots
}

func (f *fakeEngine) present(names ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, n := range names {
		f.known[n] = true
		f.slots = append(f.slots, engine.SlotStats{
			Name: n, IP: "192.168.0.2", State: "up", State6: "-",
			Present: true, Weight: 1, Weight6: 1,
			LinkIn: 100000, LinkOut: 2000,
		})
		f.adapters = append(f.adapters, AdapterInfo{Name: n, Index: len(f.adapters) + 1, IP: "192.168.0.2", WeightMode: "auto"})
	}
}
