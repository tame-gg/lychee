package control

import "strconv"

func (s *Server) currentState() string {
	st := s.deriveState()
	if st != s.mergeState {
		s.mergeState = st
		s.stateSince = s.nowMs()
	}
	return st
}

func (s *Server) deriveState() string {
	if s.starting {
		return "starting"
	}
	if s.eng.IsOn() {
		return "on"
	}
	if s.lastErr != "" {
		return "error"
	}
	if s.ap.enabled && s.ap.waiting && !s.ap.manualOff {
		return "paused_auto"
	}
	return "off"
}

func (s *Server) autopauseStatus() string {
	on := s.eng.IsOn()
	switch {
	case !s.ap.enabled:
		return "disabled"
	case on && s.ap.held:
		return "held"
	case on:
		return "armed"
	case s.ap.manualOff:
		return "manual_off"
	case s.ap.waiting:
		return "waiting"
	default:
		return "idle"
	}
}

func (s *Server) ipv6View() ipv6View {
	eff := "refused"
	if s.eng.V6Allowed() {
		eff = "balanced"
	}
	return ipv6View{Mode: v6ModeString(s.eng.V6Mode()), Effective: eff, Detail: s.eng.V6State()}
}

func (s *Server) tunView() tunView {
	name := s.eng.TunName()
	return tunView{Name: strOrNil(name), Open: name != ""}
}

func (s *Server) stateView() stateView {
	st := s.currentState()
	var errObj *errMsg
	if s.lastErr != "" {
		errObj = &errMsg{Message: s.lastErr}
	}
	return stateView{
		TS:         s.nowMs(),
		State:      st,
		StateSince: s.stateSince,
		Error:      errObj,
		Capture:    s.captureView(),
		Autopause:  autopauseView{Enabled: s.ap.enabled, Status: s.autopauseStatus()},
		IPv6:       s.ipv6View(),
		Tun:        s.tunView(),
	}
}

func (s *Server) statsView() snapshotView {
	adapters, totals, _ := buildAdapters(s.eng)
	dropped := s.session.dropped
	return snapshotView{
		stateView:    s.stateView(),
		Totals:       totals,
		Adapters:     adapters,
		DiscoverySeq: s.eng.DiscoverySeq(),
		Dropped:      &dropped,
	}
}

func (s *Server) statusView() snapshotView {
	adapters, totals, trunc := buildAdapters(s.eng)
	skipped, skTrunc := buildSkipped(s.eng)
	sv := snapshotView{
		stateView:    s.stateView(),
		Totals:       totals,
		Adapters:     adapters,
		DiscoverySeq: s.eng.DiscoverySeq(),
		Skipped:      skipped,
	}
	if trunc || skTrunc {
		sv.Truncated = true
	}
	return sv
}

func stateSignature(sv stateView) string {
	cap := "0"
	if sv.Capture.Available {
		cap = "1"
	}
	if sv.Capture.Error != nil {
		cap += *sv.Capture.Error
	}
	tun := ""
	if sv.Tun.Name != nil {
		tun = *sv.Tun.Name
	}
	open := "0"
	if sv.Tun.Open {
		open = "1"
	}
	errMsg := ""
	if sv.Error != nil {
		errMsg = sv.Error.Message
	}
	return sv.State + "|" + errMsg + "|" + sv.Autopause.Status + "|" +
		strconv.FormatBool(sv.Autopause.Enabled) + "|" + sv.IPv6.Effective + "|" + tun + "|" + open + "|" + cap
}
