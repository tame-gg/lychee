package control

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/tame-gg/lychee/native/netd/internal/engine"
)

func (s *Server) onBatch(frames [][]byte) {
	seen := map[int64]bool{}
	for i, line := range frames {
		if s.session == nil || s.session.closing {
			return
		}
		if i >= MaxInFlight {
			s.closeWithError(decodeIDBestEffort(line), &apiError{code: errTooManyRequests, message: "more than 16 requests in flight"})
			return
		}
		if !s.handleFrame(line, seen) {
			return
		}
	}
}

func decodeIDBestEffort(line []byte) *int64 {
	req, aerr := decodeEnvelope(line)
	if aerr == nil {
		return req.id
	}
	return aerr.id
}

func (s *Server) handleFrame(line []byte, seen map[int64]bool) bool {
	if s.session == nil || s.session.closing {
		return false
	}
	req, aerr := decodeEnvelope(line)
	if aerr != nil {
		if aerr.closes {
			s.closeWithError(aerr.id, aerr)
			return false
		}
		s.respondErr(aerr.id, aerr)
		return true
	}
	if seen[*req.id] {
		s.closeWithError(req.id, &apiError{code: errBadRequest, message: "id reused while still unanswered"})
		return false
	}
	seen[*req.id] = true
	return !s.dispatch(req)
}

func (s *Server) respondOK(id *int64, result any) {
	raw, err := okResponse(id, result)
	if err != nil {
		s.respondErr(id, &apiError{code: errInternal, message: err.Error()})
		return
	}
	if !s.enqueue(outFrame{raw, kindResp}) {
		s.dropSession()
	}
}

func (s *Server) respondErr(id *int64, e *apiError) {
	if !s.enqueue(outFrame{errResponse(id, e), kindResp}) {
		s.dropSession()
	}
}

func (s *Server) dispatch(req *request) (closed bool) {
	switch req.cmd {
	case "hello":
		s.respondErr(req.id, &apiError{code: errInvalidState, message: "hello already completed", data: map[string]any{"state": s.currentState()}})
	case "status":
		s.cmdStatus(req)
	case "subscribe":
		s.cmdSubscribe(req)
	case "unsubscribe":
		s.cmdUnsubscribe(req)
	case "on":
		s.cmdOn(req)
	case "off":
		s.cmdOff(req)
	case "set_ipv6":
		s.cmdSetIPv6(req)
	case "set_autopause":
		s.cmdSetAutopause(req)
	case "exclude":
		s.cmdExcludeInclude(req, true)
	case "include":
		s.cmdExcludeInclude(req, false)
	case "set_weight":
		s.cmdSetWeight(req)
	case "list_adapters":
		s.cmdListAdapters(req)
	case "cleanup":
		s.cmdCleanup(req)
	case "quit":
		return s.cmdQuit(req)
	default:
		s.respondErr(req.id, &apiError{code: errUnknownCommand, message: "unknown command", data: map[string]any{"cmd": req.cmd}})
	}
	return false
}

func (s *Server) noArgs(req *request) *apiError {
	m, aerr := argsObject(req.args)
	if aerr != nil {
		return aerr
	}
	for k := range m {
		return &apiError{code: errUnknownField, message: "unknown field args." + k, data: map[string]any{"field": "args." + k}}
	}
	return nil
}

func (s *Server) cmdStatus(req *request) {
	if aerr := s.noArgs(req); aerr != nil {
		s.respondErr(req.id, aerr)
		return
	}
	s.respondOK(req.id, s.statusView())
}

func (s *Server) cmdSubscribe(req *request) {
	m, aerr := argsObject(req.args)
	if aerr != nil {
		s.respondErr(req.id, aerr)
		return
	}
	interval := StatsIntervalDef
	for k := range m {
		if k != "interval_ms" {
			s.respondErr(req.id, &apiError{code: errUnknownField, message: "unknown field args." + k, data: map[string]any{"field": "args." + k}})
			return
		}
	}
	if raw, ok := m["interval_ms"]; ok {
		var n json.Number
		if err := json.Unmarshal(raw, &n); err != nil || containsFloat(n) {
			s.respondErr(req.id, bad("interval_ms must be an integer"))
			return
		}
		v, err := n.Int64()
		if err != nil {
			s.respondErr(req.id, bad("interval_ms must be an integer"))
			return
		}
		if v < msInt(StatsIntervalMin) || v > msInt(StatsIntervalMax) {
			s.respondErr(req.id, &apiError{code: errOutOfRange, message: "interval_ms must be between 250 and 5000", data: map[string]any{"field": "interval_ms", "min": msInt(StatsIntervalMin), "max": msInt(StatsIntervalMax)}})
			return
		}
		interval = durMs(v)
	}
	s.session.subscribed = true
	s.session.interval = interval
	s.respondOK(req.id, map[string]any{"interval_ms": msInt(interval)})
	s.emitStats()
	s.statsCh = s.clock.After(interval)
}

func (s *Server) cmdUnsubscribe(req *request) {
	if aerr := s.noArgs(req); aerr != nil {
		s.respondErr(req.id, aerr)
		return
	}
	s.session.subscribed = false
	s.statsCh = nil
	s.respondOK(req.id, map[string]any{})
}

func (s *Server) cmdOn(req *request) {
	if aerr := s.noArgs(req); aerr != nil {
		s.respondErr(req.id, aerr)
		return
	}
	if !s.cfg.Capture.Available {
		s.respondErr(req.id, &apiError{code: errUnsupportedPlatform, message: "capture not available", data: map[string]any{"error": s.cfg.Capture.Error}})
		return
	}
	if s.eng.IsOn() {
		s.respondOK(req.id, map[string]any{"state": "on"})
		return
	}
	if presentNonExcluded(s.eng) == 0 {
		s.respondErr(req.id, &apiError{code: errNoAdapters, message: "no present, non-excluded adapter"})
		return
	}
	s.ap.userSet(true, usableCount(s.eng))
	s.starting = true
	s.emitState()
	err := s.runEngineOp(s.eng.On)
	s.starting = false
	if err != nil {
		s.lastErr = err.Error()
		s.emitState()
		s.respondErr(req.id, &apiError{code: errInternal, message: err.Error()})
		return
	}
	s.lastErr = ""
	s.emitState()
	s.respondOK(req.id, map[string]any{"state": "on"})
}

func (s *Server) cmdOff(req *request) {
	if aerr := s.noArgs(req); aerr != nil {
		s.respondErr(req.id, aerr)
		return
	}
	s.ap.userSet(false, usableCount(s.eng))
	err := s.runEngineOp(s.eng.Off)
	s.lastErr = ""
	if err != nil {
		s.lastErr = err.Error()
	}
	s.emitState()
	if err != nil {
		s.respondErr(req.id, &apiError{code: errInternal, message: err.Error()})
		return
	}
	s.respondOK(req.id, map[string]any{"state": "off"})
}

func (s *Server) cmdSetIPv6(req *request) {
	m, aerr := argsObject(req.args)
	if aerr != nil {
		s.respondErr(req.id, aerr)
		return
	}
	mode := ""
	have := false
	for k, v := range m {
		if k != "mode" {
			s.respondErr(req.id, &apiError{code: errUnknownField, message: "unknown field args." + k, data: map[string]any{"field": "args." + k}})
			return
		}
		if err := json.Unmarshal(v, &mode); err != nil {
			s.respondErr(req.id, bad("mode must be a string"))
			return
		}
		have = true
	}
	if !have {
		s.respondErr(req.id, bad("mode is required"))
		return
	}
	v6, ok := engine.ParseV6Mode(mode)
	if !ok {
		s.respondErr(req.id, bad("mode must be auto, on or off"))
		return
	}
	s.eng.SetV6Mode(v6)
	eff := "refused"
	if s.eng.V6Allowed() {
		eff = "balanced"
	}
	s.respondOK(req.id, map[string]any{"mode": mode, "effective": eff})
	s.emitState()
}

func (s *Server) cmdSetAutopause(req *request) {
	m, aerr := argsObject(req.args)
	if aerr != nil {
		s.respondErr(req.id, aerr)
		return
	}
	var enabled bool
	have := false
	for k, v := range m {
		if k != "enabled" {
			s.respondErr(req.id, &apiError{code: errUnknownField, message: "unknown field args." + k, data: map[string]any{"field": "args." + k}})
			return
		}
		if err := json.Unmarshal(v, &enabled); err != nil {
			s.respondErr(req.id, bad("enabled must be a boolean"))
			return
		}
		have = true
	}
	if !have {
		s.respondErr(req.id, bad("enabled is required"))
		return
	}
	s.ap.setEnabled(enabled, s.eng.IsOn())
	s.respondOK(req.id, map[string]any{"enabled": enabled, "status": s.autopauseStatus()})
	s.emitState()
}

func (s *Server) cmdExcludeInclude(req *request, exclude bool) {
	name, aerr := s.oneAdapter(req)
	if aerr != nil {
		s.respondErr(req.id, aerr)
		return
	}
	if err := s.eng.SetExcluded(name, exclude); err != nil {
		if errors.Is(err, ErrUnknownAdapter) {
			s.respondErr(req.id, &apiError{code: errUnknownAdapterCode, message: fmt.Sprintf("no adapter named %q", name), data: map[string]any{"adapter": name}})
			return
		}
		s.respondErr(req.id, &apiError{code: errInternal, message: err.Error()})
		return
	}
	s.respondOK(req.id, map[string]any{"adapter": name, "excluded": exclude})
	s.emitState()
}

func (s *Server) cmdSetWeight(req *request) {
	m, aerr := argsObject(req.args)
	if aerr != nil {
		s.respondErr(req.id, aerr)
		return
	}
	var name string
	haveName := false
	var weightRaw json.RawMessage
	haveWeight := false
	for k, v := range m {
		switch k {
		case "adapter":
			if err := json.Unmarshal(v, &name); err != nil {
				s.respondErr(req.id, bad("adapter must be a string"))
				return
			}
			haveName = true
		case "weight":
			weightRaw = v
			haveWeight = true
		default:
			s.respondErr(req.id, &apiError{code: errUnknownField, message: "unknown field args." + k, data: map[string]any{"field": "args." + k}})
			return
		}
	}
	if !haveName || !validAdapterName(name) {
		s.respondErr(req.id, bad("adapter is required and must be 1-256 bytes"))
		return
	}
	if !haveWeight {
		s.respondErr(req.id, bad("weight is required"))
		return
	}
	var asString string
	if json.Unmarshal(weightRaw, &asString) == nil {
		if asString != "auto" {
			s.respondErr(req.id, bad(`weight must be a number or "auto"`))
			return
		}
		if err := s.eng.SetWeight(name, 0, true); err != nil {
			s.respondUnknownOrInternal(req.id, name, err)
			return
		}
		s.respondOK(req.id, map[string]any{"adapter": name, "weight_mode": "auto", "weight": s.currentAutoWeight(name)})
		return
	}
	var num json.Number
	if json.Unmarshal(weightRaw, &num) != nil {
		s.respondErr(req.id, bad(`weight must be a number or "auto"`))
		return
	}
	w, err := num.Float64()
	if err != nil {
		s.respondErr(req.id, bad("weight must be a finite number"))
		return
	}
	if w < WeightMin || w > WeightMax {
		s.respondErr(req.id, &apiError{code: errOutOfRange, message: "weight must be between 0.05 and 100", data: map[string]any{"field": "weight", "min": WeightMin, "max": WeightMax}})
		return
	}
	if err := s.eng.SetWeight(name, w, false); err != nil {
		s.respondUnknownOrInternal(req.id, name, err)
		return
	}
	s.respondOK(req.id, map[string]any{"adapter": name, "weight_mode": "manual", "weight": w})
}

func (s *Server) cmdListAdapters(req *request) {
	if aerr := s.noArgs(req); aerr != nil {
		s.respondErr(req.id, aerr)
		return
	}
	adapters := s.eng.Adapters()
	truncated := false
	if len(adapters) > MaxAdapters {
		adapters = adapters[:MaxAdapters]
		truncated = true
	}
	list := make([]map[string]any, 0, len(adapters))
	for _, a := range adapters {
		list = append(list, map[string]any{
			"name": a.Name, "index": a.Index, "ip": strOrNil(a.IP), "ip6": strOrNil(a.IP6),
			"excluded": a.Excluded, "weight_mode": a.WeightMode, "description": strOrNil(a.Description),
		})
	}
	skipped, skTrunc := buildSkipped(s.eng)
	result := map[string]any{"discovery_seq": s.eng.DiscoverySeq(), "adapters": list, "skipped": skipped}
	if truncated || skTrunc {
		result["truncated"] = true
	}
	s.respondOK(req.id, result)
}

func (s *Server) cmdCleanup(req *request) {
	if aerr := s.noArgs(req); aerr != nil {
		s.respondErr(req.id, aerr)
		return
	}
	st := s.currentState()
	if st != "off" && st != "error" {
		s.respondErr(req.id, &apiError{code: errInvalidState, message: "cleanup is only allowed while off", data: map[string]any{"state": st}})
		return
	}
	if err := s.runEngineOp(s.eng.Cleanup); err != nil {
		s.respondErr(req.id, &apiError{code: errInternal, message: err.Error()})
		return
	}
	s.respondOK(req.id, map[string]any{})
}

func (s *Server) cmdQuit(req *request) bool {
	if aerr := s.noArgs(req); aerr != nil {
		s.respondErr(req.id, aerr)
		return false
	}
	if s.eng.IsOn() {
		s.eng.Off()
		s.lastErr = ""
		s.emitState()
	}
	s.respondOK(req.id, map[string]any{})
	s.quitting = true
	s.pendingQuit = true
	s.quitCh = s.clock.After(2 * time.Second)
	if s.session == nil || s.session.pendingWrites == 0 {
		s.doShutdown(0)
	}
	return true
}

func (s *Server) oneAdapter(req *request) (string, *apiError) {
	m, aerr := argsObject(req.args)
	if aerr != nil {
		return "", aerr
	}
	var name string
	have := false
	for k, v := range m {
		if k != "adapter" {
			return "", &apiError{code: errUnknownField, message: "unknown field args." + k, data: map[string]any{"field": "args." + k}}
		}
		if err := json.Unmarshal(v, &name); err != nil {
			return "", bad("adapter must be a string")
		}
		have = true
	}
	if !have || !validAdapterName(name) {
		return "", bad("adapter is required and must be 1-256 bytes with no control characters")
	}
	return name, nil
}

func (s *Server) respondUnknownOrInternal(id *int64, name string, err error) {
	if errors.Is(err, ErrUnknownAdapter) {
		s.respondErr(id, &apiError{code: errUnknownAdapterCode, message: fmt.Sprintf("no adapter named %q", name), data: map[string]any{"adapter": name}})
		return
	}
	s.respondErr(id, &apiError{code: errInternal, message: err.Error()})
}

func (s *Server) currentAutoWeight(name string) float64 {
	for _, sl := range s.eng.Snapshot() {
		if sl.Name == name {
			return sl.Weight
		}
	}
	return 0
}

func (s *Server) runEngineOp(op func() error) error {
	done := make(chan error, 1)
	go func() { done <- op() }()
	select {
	case e := <-done:
		return e
	case <-s.clock.After(CommandDeadline):
		return errors.New("operation timed out")
	}
}

func containsFloat(n json.Number) bool {
	for _, c := range []byte(n) {
		if c == '.' || c == 'e' || c == 'E' {
			return true
		}
	}
	return false
}
