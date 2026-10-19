package main

import (
	"strings"
	"sync"
	"time"

	"github.com/tame-gg/lychee/native/netd/internal/control"
	"github.com/tame-gg/lychee/native/netd/internal/engine"
	"github.com/tame-gg/lychee/native/netd/internal/nics"
	"github.com/tame-gg/lychee/native/netd/internal/tun"
)

type linkSampler struct {
	idx             int
	inPrev, outPrev uint64
	inRate, outRate float64
	primed          bool
}

type realEngine struct {
	mu        sync.Mutex
	sched     *engine.Scheduler
	bal       *engine.Balancer
	t         *tun.Tun
	excluded  map[string]bool
	overrides map[string]float64
	lastNics  []nics.Nic
	skipped   []nics.Skip
	discSeq   uint64
	discSig   string
	samplers  map[string]*linkSampler
	stop      chan struct{}
	lastTick  time.Time
}

func newRealEngine() *realEngine {
	s := engine.NewScheduler(nil)
	s.SetAuto(true)
	b := engine.NewBalancer(s)
	b.SetV6Mode(engine.V6Auto)
	e := &realEngine{
		sched:     s,
		bal:       b,
		t:         tun.New(b),
		excluded:  map[string]bool{},
		overrides: map[string]float64{},
		samplers:  map[string]*linkSampler{},
		stop:      make(chan struct{}),
	}
	return e
}

func (e *realEngine) start() {
	e.rescan()
	go e.sched.RunProbes(e.stop)
	go e.rescanLoop()
	go e.tickLoop()
}

func (e *realEngine) close() {
	select {
	case <-e.stop:
	default:
		close(e.stop)
	}
	e.t.Close()
}

func (e *realEngine) rescanLoop() {
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-e.stop:
			return
		case <-t.C:
			e.rescan()
		}
	}
}

func (e *realEngine) tickLoop() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	last := time.Now()
	for {
		select {
		case <-e.stop:
			return
		case now := <-t.C:
			e.sched.Tick(now.Sub(last))
			last = now
			e.sampleExcluded()
		}
	}
}

func (e *realEngine) rescan() {
	e.mu.Lock()
	weights := make(map[string]float64, len(e.overrides))
	for k, v := range e.overrides {
		weights[k] = v
	}
	excl := make(map[string]bool, len(e.excluded))
	for k, v := range e.excluded {
		excl[k] = v
	}
	e.mu.Unlock()

	found, skipped, err := nics.DiscoverNicsDetailed(nil, weights)
	if err != nil {
		return
	}
	var included []nics.Nic
	for _, n := range found {
		if !excl[n.Name] {
			included = append(included, n)
		}
	}
	e.sched.Update(included)
	for name := range weights {
		e.sched.SetWeightOverride(name, weights[name])
	}

	sig := discoverySignature(found, skipped)
	e.mu.Lock()
	e.lastNics = found
	e.skipped = skipped
	if sig != e.discSig {
		e.discSig = sig
		e.discSeq++
	}
	e.mu.Unlock()
}

func discoverySignature(found []nics.Nic, skipped []nics.Skip) string {
	var b strings.Builder
	for _, n := range found {
		b.WriteString(n.Name)
		b.WriteByte('|')
	}
	b.WriteByte('#')
	for _, s := range skipped {
		b.WriteString(s.Name)
		b.WriteByte('=')
		b.WriteString(s.Reason)
		b.WriteByte('|')
	}
	return b.String()
}

func (e *realEngine) sampleExcluded() {
	e.mu.Lock()
	defer e.mu.Unlock()
	live := map[string]bool{}
	for _, n := range e.lastNics {
		if !e.excluded[n.Name] {
			continue
		}
		live[n.Name] = true
		s := e.samplers[n.Name]
		if s == nil {
			s = &linkSampler{idx: n.Index}
			e.samplers[n.Name] = s
		}
		s.idx = n.Index
		in, out, ok := nics.Octets(n.Index)
		if !ok {
			s.primed, s.inRate, s.outRate = false, 0, 0
			continue
		}
		if s.primed && in >= s.inPrev && out >= s.outPrev {
			s.inRate = float64(in - s.inPrev)
			s.outRate = float64(out - s.outPrev)
		}
		s.inPrev, s.outPrev, s.primed = in, out, true
	}
	for name := range e.samplers {
		if !live[name] {
			delete(e.samplers, name)
		}
	}
}

func (e *realEngine) Snapshot() []engine.SlotStats {
	slots := e.sched.Snapshot()
	e.mu.Lock()
	defer e.mu.Unlock()
	inSched := map[string]bool{}
	for _, s := range slots {
		inSched[s.Name] = true
	}
	for _, n := range e.lastNics {
		if !e.excluded[n.Name] || inSched[n.Name] {
			continue
		}
		st := engine.SlotStats{Name: n.Name, State: "-", State6: "-", Present: true}
		if n.IP != nil {
			st.IP = n.IP.String()
		}
		if n.IP6 != nil {
			st.IP6 = n.IP6.String()
		}
		if s := e.samplers[n.Name]; s != nil {
			st.LinkIn, st.LinkOut = s.inRate, s.outRate
		}
		slots = append(slots, st)
	}
	return slots
}

func (e *realEngine) Adapters() []control.AdapterInfo {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]control.AdapterInfo, 0, len(e.lastNics))
	for _, n := range e.lastNics {
		a := control.AdapterInfo{Name: n.Name, Index: n.Index, Excluded: e.excluded[n.Name], WeightMode: "auto"}
		if n.IP != nil {
			a.IP = n.IP.String()
		}
		if n.IP6 != nil {
			a.IP6 = n.IP6.String()
		}
		if _, ok := e.overrides[n.Name]; ok {
			a.WeightMode = "manual"
		}
		out = append(out, a)
	}
	return out
}

func (e *realEngine) Skipped() []nics.Skip {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]nics.Skip(nil), e.skipped...)
}

func (e *realEngine) DiscoverySeq() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.discSeq
}

func (e *realEngine) Excluded(name string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.excluded[name]
}

func (e *realEngine) WeightMode(name string) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.overrides[name]; ok {
		return "manual"
	}
	return "auto"
}

func (e *realEngine) On() error       { return e.t.On() }
func (e *realEngine) Off() error      { e.t.Off(); return nil }
func (e *realEngine) IsOn() bool      { return e.t.IsOn() }
func (e *realEngine) TunName() string { return e.t.Name() }

func (e *realEngine) SetV6Mode(m engine.V6Mode) { e.bal.SetV6Mode(m) }
func (e *realEngine) V6Mode() engine.V6Mode     { return e.bal.V6Mode() }
func (e *realEngine) V6Allowed() bool           { return e.bal.V6Allowed() }
func (e *realEngine) V6State() string           { return e.bal.V6State() }

func (e *realEngine) knownLocked(name string) bool {
	for _, n := range e.lastNics {
		if n.Name == name {
			return true
		}
	}
	for _, s := range e.skipped {
		if s.Name == name {
			return true
		}
	}
	return false
}

func (e *realEngine) SetExcluded(name string, excluded bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.knownLocked(name) && !e.excluded[name] {
		return control.ErrUnknownAdapter
	}
	if excluded {
		e.excluded[name] = true
	} else {
		delete(e.excluded, name)
	}
	return nil
}

func (e *realEngine) SetWeight(name string, weight float64, auto bool) error {
	e.mu.Lock()
	_, hasOverride := e.overrides[name]
	e.mu.Unlock()
	if !hasOverride && !e.sched.HasSlot(name) {
		return control.ErrUnknownAdapter
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if auto {
		delete(e.overrides, name)
		e.sched.ClearWeightOverride(name)
		return nil
	}
	e.overrides[name] = weight
	e.sched.SetWeightOverride(name, weight)
	return nil
}

func (e *realEngine) Cleanup() error {
	tun.CleanupStale()
	return nil
}

var _ control.Engine = (*realEngine)(nil)
