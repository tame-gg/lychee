package control

import (
	"math"

	"github.com/tame-gg/lychee/native/netd/internal/engine"
)

type captureView struct {
	Available bool    `json:"available"`
	Error     *string `json:"error"`
}

type errMsg struct {
	Message string `json:"message"`
}

type autopauseView struct {
	Enabled bool   `json:"enabled"`
	Status  string `json:"status"`
}

type ipv6View struct {
	Mode      string `json:"mode"`
	Effective string `json:"effective"`
	Detail    string `json:"detail"`
}

type tunView struct {
	Name *string `json:"name"`
	Open bool    `json:"open"`
}

type stateView struct {
	TS         int64         `json:"ts"`
	State      string        `json:"state"`
	StateSince int64         `json:"state_since"`
	Error      *errMsg       `json:"error"`
	Capture    captureView   `json:"capture"`
	Autopause  autopauseView `json:"autopause"`
	IPv6       ipv6View      `json:"ipv6"`
	Tun        tunView       `json:"tun"`
}

type totalsView struct {
	LinkInBps      int64 `json:"link_in_bps"`
	LinkOutBps     int64 `json:"link_out_bps"`
	RelayedInBps   int64 `json:"relayed_in_bps"`
	RelayedOutBps  int64 `json:"relayed_out_bps"`
	ActiveFlows    int64 `json:"active_flows"`
	AdaptersPres   int   `json:"adapters_present"`
	AdaptersUsable int   `json:"adapters_usable"`
}

type adapterView struct {
	Name         string  `json:"name"`
	IP           *string `json:"ip"`
	IP6          *string `json:"ip6"`
	Present      bool    `json:"present"`
	Excluded     bool    `json:"excluded"`
	State        string  `json:"state"`
	State6       string  `json:"state6"`
	Weight       float64 `json:"weight"`
	Weight6      float64 `json:"weight6"`
	WeightMode   string  `json:"weight_mode"`
	PeakBps      int64   `json:"peak_bps"`
	Peak6Bps     int64   `json:"peak6_bps"`
	ActiveFlows  int64   `json:"active_flows"`
	TotalFlows   int64   `json:"total_flows"`
	FailedFlows  int64   `json:"failed_flows"`
	LinkInBps    int64   `json:"link_in_bps"`
	LinkOutBps   int64   `json:"link_out_bps"`
	RelayedInBps int64   `json:"relayed_in_bps"`
	RelayedOut   int64   `json:"relayed_out_bps"`
	BytesIn      int64   `json:"bytes_in"`
	BytesOut     int64   `json:"bytes_out"`
}

type skipView struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

type snapshotView struct {
	stateView
	Totals       totalsView    `json:"totals"`
	Adapters     []adapterView `json:"adapters"`
	DiscoverySeq uint64        `json:"discovery_seq"`
	Dropped      *uint64       `json:"dropped,omitempty"`
	Skipped      []skipView    `json:"skipped,omitempty"`
}

func mapLinkState(s string) string {
	switch s {
	case "up":
		return "up"
	case "checking":
		return "checking"
	case "no internet":
		return "down"
	default:
		return "none"
	}
}

func strOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func trunc(v float64) int64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return int64(math.Trunc(v))
}

func adapterFromSlot(s engine.SlotStats, excluded bool, weightMode string) adapterView {
	return adapterView{
		Name:         s.Name,
		IP:           strOrNil(s.IP),
		IP6:          strOrNil(s.IP6),
		Present:      s.Present,
		Excluded:     excluded,
		State:        mapLinkState(s.State),
		State6:       mapLinkState(s.State6),
		Weight:       s.Weight,
		Weight6:      s.Weight6,
		WeightMode:   weightMode,
		PeakBps:      trunc(s.Peak),
		Peak6Bps:     trunc(s.Peak6),
		ActiveFlows:  s.Active,
		TotalFlows:   s.Total,
		FailedFlows:  s.Failed,
		LinkInBps:    trunc(s.LinkIn),
		LinkOutBps:   trunc(s.LinkOut),
		RelayedInBps: trunc(s.RateIn),
		RelayedOut:   trunc(s.RateOut),
		BytesIn:      s.BytesIn,
		BytesOut:     s.BytesOut,
	}
}

func buildAdapters(eng Engine) ([]adapterView, totalsView, bool) {
	slots := eng.Snapshot()
	truncated := false
	if len(slots) > MaxAdapters {
		slots = slots[:MaxAdapters]
		truncated = true
	}
	out := make([]adapterView, 0, len(slots))
	var totals totalsView
	for _, s := range slots {
		av := adapterFromSlot(s, eng.Excluded(s.Name), eng.WeightMode(s.Name))
		out = append(out, av)
		if av.Present {
			totals.LinkInBps += av.LinkInBps
			totals.LinkOutBps += av.LinkOutBps
			totals.RelayedInBps += av.RelayedInBps
			totals.RelayedOutBps += av.RelayedOut
			totals.ActiveFlows += av.ActiveFlows
			totals.AdaptersPres++
			if av.State == "up" || av.State6 == "up" {
				totals.AdaptersUsable++
			}
		}
	}
	return out, totals, truncated
}

func buildSkipped(eng Engine) ([]skipView, bool) {
	sk := eng.Skipped()
	truncated := false
	if len(sk) > MaxAdapters {
		sk = sk[:MaxAdapters]
		truncated = true
	}
	out := make([]skipView, 0, len(sk))
	for _, s := range sk {
		out = append(out, skipView{Name: s.Name, Reason: s.Reason})
	}
	return out, truncated
}

func usableCount(eng Engine) int {
	n := 0
	for _, s := range eng.Snapshot() {
		if s.Present && !eng.Excluded(s.Name) && (s.State == "up" || s.State6 == "up") {
			n++
		}
	}
	return n
}

func movingFlows(eng Engine) int64 {
	var n int64
	var rate float64
	for _, s := range eng.Snapshot() {
		if s.Present {
			n += s.Active
			rate += s.RateIn + s.RateOut
		}
	}
	if rate < quietRate {
		return 0
	}
	return n
}

func presentNonExcluded(eng Engine) int {
	n := 0
	for _, s := range eng.Snapshot() {
		if s.Present && !eng.Excluded(s.Name) {
			n++
		}
	}
	return n
}

func v6ModeString(m engine.V6Mode) string {
	switch m {
	case engine.V6On:
		return "on"
	case engine.V6Off:
		return "off"
	default:
		return "auto"
	}
}
