package control

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"net"
	"runtime"
	"sync"
	"time"
)

type PeerInfo struct {
	UID int
	PID int
	SID string
}

type AuthInfo struct {
	Model     string
	Privilege string
	UID       *int
	SID       *string
}

type Config struct {
	Listener     net.Listener
	PeerCheck    func(net.Conn) (PeerInfo, error)
	Clock        Clock
	Engine       Engine
	Version      string
	GOOS         string
	GOARCH       string
	Auth         AuthInfo
	Capabilities []string
	Capture      CaptureStatus
	Stderr       io.Writer
}

type CaptureStatus struct {
	Available bool
	Error     string
}

type noteKind int

const (
	kindResp noteKind = iota
	kindState
	kindStats
	kindLog
)

type outFrame struct {
	bytes []byte
	kind  noteKind
}

type session struct {
	nc    net.Conn
	peer  PeerInfo
	fr    *frameReader
	proto int

	out      chan outFrame
	wnote    chan noteKind
	readOnce sync.Once

	seq           uint64
	dropped       uint64
	subscribed    bool
	interval      time.Duration
	statsInFlight bool
	pendingWrites int

	logWindowStart time.Time
	logCount       int

	closing      bool
	lastStateSig string
}

type msgConnArrived struct{}

type msgClaim struct {
	nc    net.Conn
	peer  PeerInfo
	fr    *frameReader
	id    int64
	proto int
	reply chan claimResult
}

type claimResult struct {
	busy bool
	pid  int
}

type msgReadEnd struct{ sess *session }
type msgBatch struct {
	sess   *session
	frames [][]byte
}
type msgFrameTooLarge struct{ sess *session }

type Server struct {
	cfg   Config
	clock Clock
	eng   Engine

	core     chan any
	pending  chan struct{}
	shutdown chan struct{}
	done     chan struct{}
	accept   chan net.Conn

	instance   string
	sessionNum int
	session    *session
	quitting   bool

	mergeState string
	stateSince int64
	lastErr    string
	starting   bool
	ap         autoPauser

	startupCh <-chan time.Time
	graceCh   <-chan time.Time
	statsCh   <-chan time.Time
	tickCh    <-chan time.Time
	stallCh   <-chan time.Time
	quitCh    <-chan time.Time

	pendingQuit bool
	stopped     bool

	shutOnce sync.Once
	exitCode int
}

func New(cfg Config) *Server {
	if cfg.Clock == nil {
		cfg.Clock = RealClock()
	}
	if cfg.GOOS == "" {
		cfg.GOOS = runtime.GOOS
	}
	if cfg.GOARCH == "" {
		cfg.GOARCH = runtime.GOARCH
	}
	if cfg.Stderr == nil {
		cfg.Stderr = io.Discard
	}
	if cfg.Capabilities == nil {
		cfg.Capabilities = []string{}
	}
	inst := make([]byte, 16)
	rand.Read(inst)
	s := &Server{
		cfg:        cfg,
		clock:      cfg.Clock,
		eng:        cfg.Engine,
		core:       make(chan any, 16),
		pending:    make(chan struct{}, PendingConns),
		shutdown:   make(chan struct{}),
		done:       make(chan struct{}),
		accept:     make(chan net.Conn),
		instance:   hex.EncodeToString(inst),
		mergeState: "off",
	}
	s.ap.enabled = true
	s.ap.manualOff = true
	return s
}

func (s *Server) Serve() int {
	s.stateSince = s.nowMs()
	go s.acceptLoop()
	s.startupCh = s.clock.After(StartupTimeout)
	s.tickCh = s.clock.After(time.Second)
	s.runLoop()
	close(s.done)
	return s.exitCode
}

func (s *Server) Shutdown() {
	s.shutOnce.Do(func() { close(s.shutdown) })
	<-s.done
}

func (s *Server) nowMs() int64 { return s.clock.Now().UnixMilli() }

func (s *Server) logf(level, format string, args ...any) {
	line := sprintfLine(format, args...)
	if s.cfg.Stderr != nil {
		io.WriteString(s.cfg.Stderr, line+"\n")
	}
	s.emitLog(level, line)
}

func (s *Server) acceptLoop() {
	ln := s.cfg.Listener
	for {
		nc, err := ln.Accept()
		if err != nil {
			return
		}
		go s.handleConn(nc)
	}
}

func (s *Server) handleConn(nc net.Conn) {
	select {
	case s.pending <- struct{}{}:
	default:
		nc.Close()
		return
	}
	released := false
	release := func() {
		if !released {
			released = true
			<-s.pending
		}
	}
	defer release()

	peer, err := s.cfg.PeerCheck(nc)
	if err != nil {
		s.sendCore(msgConnArrived{})
		s.logf("info", "peer rejected: %v", err)
		nc.Close()
		return
	}
	s.sendCore(msgConnArrived{})

	fr := newFrameReader(nc)
	type rd struct {
		line []byte
		err  error
	}
	ch := make(chan rd, 1)
	go func() {
		for {
			line, e := fr.read()
			if e == nil && len(line) == 0 {
				continue
			}
			ch <- rd{line, e}
			return
		}
	}()
	var first rd
	select {
	case first = <-ch:
	case <-s.clock.After(HelloTimeout):
		writeRaw(nc, errResponse(nil, &apiError{code: errHelloRequired, message: "hello not received within 5s"}))
		nc.Close()
		return
	}
	if first.err != nil {
		if first.err == errLineTooLong {
			writeRaw(nc, errResponse(nil, &apiError{code: errFrameTooLarge, message: "frame exceeds 65536 bytes"}))
		}
		nc.Close()
		return
	}
	req, aerr := decodeEnvelope(first.line)
	if aerr != nil {
		writeRaw(nc, errResponse(aerr.id, aerr))
		nc.Close()
		return
	}
	if req.cmd != "hello" {
		writeRaw(nc, errResponse(req.id, &apiError{code: errHelloRequired, message: "first request must be hello"}))
		nc.Close()
		return
	}
	hello, aerr := parseHello(req.args)
	if aerr != nil {
		writeRaw(nc, errResponse(req.id, aerr))
		nc.Close()
		return
	}
	proto, aerr := negotiate(hello.Protocol)
	if aerr != nil {
		writeRaw(nc, errResponse(req.id, aerr))
		nc.Close()
		return
	}
	reply := make(chan claimResult, 1)
	s.sendCore(msgClaim{nc: nc, peer: peer, fr: fr, id: *req.id, proto: proto, reply: reply})
	res := <-reply
	if res.busy {
		writeRaw(nc, errResponse(req.id, &apiError{code: errBusy, message: "another client session is active", data: map[string]any{"session_pid": res.pid}}))
		nc.Close()
		return
	}
	release()
}

func (s *Server) sendCore(m any) {
	select {
	case s.core <- m:
	case <-s.done:
	}
}

func (s *Server) runLoop() {
	for {
		if s.stopped {
			return
		}
		var wnote chan noteKind
		if s.session != nil {
			wnote = s.session.wnote
		}
		select {
		case <-s.shutdown:
			s.doShutdown(0)
		case <-s.startupCh:
			s.logf("info", "no client connected")
			s.doShutdown(0)
		case <-s.graceCh:
			s.logf("info", "client gone")
			s.doShutdown(0)
		case <-s.quitCh:
			s.quitCh = nil
			if s.pendingQuit {
				s.doShutdown(0)
			}
		case <-s.tickCh:
			s.tickCh = s.clock.After(time.Second)
			s.onTick()
		case <-s.statsCh:
			s.onStatsTick()
		case <-s.stallCh:
			s.onStall()
		case m := <-s.core:
			s.handleCoreMsg(m)
		case n := <-wnote:
			s.onWnote(n)
		}
	}
}

func (s *Server) handleCoreMsg(m any) {
	switch v := m.(type) {
	case msgConnArrived:
		s.startupCh = nil
	case msgClaim:
		s.onClaim(v)
	case msgReadEnd:
		if v.sess == s.session {
			s.logf("info", "client disconnected, waiting 10 s")
			s.dropSession()
		}
	case msgBatch:
		if v.sess == s.session {
			s.onBatch(v.frames)
		}
	case msgFrameTooLarge:
		if v.sess == s.session {
			s.closeWithError(nil, &apiError{code: errFrameTooLarge, message: "frame exceeds 65536 bytes"})
		}
	}
}

func (s *Server) onClaim(m msgClaim) {
	if s.session != nil || s.quitting {
		pid := 0
		if s.session != nil {
			pid = s.session.peer.PID
		}
		m.reply <- claimResult{busy: true, pid: pid}
		return
	}
	sess := &session{
		nc:       m.nc,
		peer:     m.peer,
		fr:       m.fr,
		proto:    m.proto,
		out:      make(chan outFrame, OutboundQueue),
		wnote:    make(chan noteKind, 256),
		interval: StatsIntervalDef,
	}
	s.session = sess
	s.sessionNum++
	s.startupCh = nil
	s.graceCh = nil
	go s.writer(sess)
	go s.reader(sess)

	res := s.buildHelloResult(m.proto, m.peer)
	raw, _ := okResponse(&m.id, res)
	s.enqueue(outFrame{raw, kindResp})
	s.emitState()
	m.reply <- claimResult{}
}

func (s *Server) dropSession() {
	if s.session == nil {
		return
	}
	s.session.nc.Close()
	s.session = nil
	s.statsCh = nil
	s.stallCh = nil
	if !s.quitting {
		s.graceCh = s.clock.After(GracePeriod)
	}
}

func (s *Server) closeWithError(id *int64, e *apiError) {
	if s.session == nil {
		return
	}
	s.enqueue(outFrame{errResponse(id, e), kindResp})
	s.session.closing = true
	if s.session.pendingWrites == 0 {
		s.dropSession()
	}
}

func (s *Server) onStall() {
	s.stallCh = nil
	if s.session != nil {
		s.logf("info", "write stalled, closing client")
		s.dropSession()
	}
}

func (s *Server) reader(sess *session) {
	for {
		batch, err := sess.fr.readBatch(MaxInFlight + 1)
		if len(batch) > 0 {
			s.sendCore(msgBatch{sess, batch})
		}
		if err != nil {
			if err == errLineTooLong {
				s.sendCore(msgFrameTooLarge{sess})
				return
			}
			sess.readOnce.Do(func() { s.sendCore(msgReadEnd{sess}) })
			return
		}
	}
}

func (s *Server) writer(sess *session) {
	for of := range sess.out {
		if _, err := sess.nc.Write(append(of.bytes, '\n')); err != nil {
			sess.readOnce.Do(func() { s.sendCore(msgReadEnd{sess}) })
			return
		}
		select {
		case sess.wnote <- of.kind:
		case <-s.done:
			return
		}
	}
}

func (s *Server) onWnote(kind noteKind) {
	if s.session == nil {
		return
	}
	s.session.pendingWrites--
	if kind == kindStats {
		s.session.statsInFlight = false
	}
	if s.session.pendingWrites <= 0 {
		s.session.pendingWrites = 0
		s.stallCh = nil
	} else {
		s.stallCh = s.clock.After(WriteStall)
	}
	if s.pendingQuit && s.session.pendingWrites == 0 {
		s.doShutdown(0)
		return
	}
	if s.session.closing && s.session.pendingWrites == 0 {
		s.dropSession()
	}
}

func (s *Server) enqueue(of outFrame) bool {
	sess := s.session
	if sess == nil {
		return false
	}
	select {
	case sess.out <- of:
		sess.pendingWrites++
		if sess.pendingWrites == 1 {
			s.stallCh = s.clock.After(WriteStall)
		}
		return true
	default:
		return false
	}
}

func (s *Server) nextSeq() uint64 {
	s.session.seq++
	return s.session.seq
}

func (s *Server) emitState() {
	if s.session == nil {
		return
	}
	sv := s.stateView()
	sig := stateSignature(sv)
	if sig == s.session.lastStateSig {
		return
	}
	s.session.lastStateSig = sig
	seq := s.nextSeq()
	frame := encodeEvent("state", seq, sv)
	if !s.enqueue(outFrame{frame, kindState}) {
		s.dropSession()
	}
}

func (s *Server) onStatsTick() {
	if s.session == nil || !s.session.subscribed {
		return
	}
	s.emitStats()
	s.statsCh = s.clock.After(s.session.interval)
}

func (s *Server) emitStats() {
	if s.session == nil || !s.session.subscribed {
		return
	}
	seq := s.nextSeq()
	if s.session.statsInFlight {
		s.session.dropped++
		return
	}
	sv := s.statsView()
	frame := encodeEvent("stats", seq, sv)
	if !s.enqueue(outFrame{frame, kindStats}) {
		s.session.dropped++
		return
	}
	s.session.statsInFlight = true
	_ = seq
}

func (s *Server) emitLog(level, msg string) {
	if s.session == nil {
		return
	}
	now := s.clock.Now()
	if now.Sub(s.session.logWindowStart) >= time.Second {
		s.session.logWindowStart = now
		s.session.logCount = 0
	}
	seq := s.nextSeq()
	if s.session.logCount >= LogRatePerSecond {
		s.session.dropped++
		return
	}
	data := map[string]any{"level": level, "message": sanitizeLog(msg)}
	frame := encodeEvent("log", seq, data)
	if !s.enqueue(outFrame{frame, kindLog}) {
		s.session.dropped++
		return
	}
	s.session.logCount++
}

func (s *Server) onTick() {
	if s.session == nil {
		return
	}
	on := s.eng.IsOn()
	switch s.ap.tick(s.clock.Now(), on, usableCount(s.eng), movingFlows(s.eng)) {
	case autoPause:
		s.eng.Off()
		s.lastErr = ""
	case autoResume:
		s.starting = true
		s.emitState()
		if err := s.eng.On(); err != nil {
			s.starting = false
			s.lastErr = err.Error()
			s.ap.resumeFailed()
		} else {
			s.starting = false
		}
	}
	s.emitState()
}

func (s *Server) doShutdown(code int) {
	if s.stopped {
		return
	}
	s.stopped = true
	s.quitting = true
	if s.eng.IsOn() {
		s.eng.Off()
	}
	if s.cfg.Listener != nil {
		s.cfg.Listener.Close()
	}
	if s.session != nil {
		s.session.nc.Close()
		s.session = nil
	}
	s.exitCode = code
}

func writeRaw(nc net.Conn, b []byte) {
	nc.SetWriteDeadline(time.Now().Add(5 * time.Second))
	nc.Write(append(b, '\n'))
	nc.SetWriteDeadline(time.Time{})
}
