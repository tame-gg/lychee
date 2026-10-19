package control

import "time"

const (
	pauseAfterIdle = 10 * time.Second
	pauseAfterBusy = 2 * time.Minute
	resumeAfter    = 3 * time.Second
	autoGap        = 30 * time.Second
	quietRate      = 50_000
)

type autoAction int

const (
	autoNone autoAction = iota
	autoPause
	autoResume
)

type autoPauser struct {
	enabled    bool
	manualOff  bool
	held       bool
	waiting    bool
	low, high  time.Duration
	quiet      time.Duration
	lastTick   time.Time
	lastSwitch time.Time
}

func (a *autoPauser) start(startOn bool) {
	if !startOn {
		a.manualOff = true
	} else if a.enabled {
		a.waiting = true
	}
}

func (a *autoPauser) tick(now time.Time, on bool, usable int, active int64) autoAction {
	dt := time.Second
	if d := now.Sub(a.lastTick); !a.lastTick.IsZero() && d > 0 && d < 2*time.Second {
		dt = d
	}
	a.lastTick = now
	if active == 0 {
		a.quiet += dt
	} else {
		a.quiet = 0
	}
	if !a.enabled {
		a.low, a.high = 0, 0
		return autoNone
	}
	if usable >= 2 {
		a.held = false
	}
	cooling := !a.lastSwitch.IsZero() && now.Sub(a.lastSwitch) < autoGap
	switch {
	case on && usable < 2 && !a.held:
		a.low, a.high = a.low+dt, 0
		settled := a.low >= pauseAfterIdle && a.quiet >= pauseAfterIdle
		if (settled || a.low >= pauseAfterBusy) && !cooling {
			a.low, a.waiting, a.lastSwitch = 0, true, now
			return autoPause
		}
	case !on && a.waiting && !a.manualOff && usable >= 2:
		a.high, a.low = a.high+dt, 0
		if a.high >= resumeAfter && !cooling {
			a.high, a.waiting, a.lastSwitch = 0, false, now
			return autoResume
		}
	default:
		a.low, a.high = 0, 0
	}
	return autoNone
}

func (a *autoPauser) userSet(on bool, usable int) {
	a.low, a.high = 0, 0
	a.waiting = false
	a.manualOff = !on
	a.held = on && usable < 2
}

func (a *autoPauser) setEnabled(enabled, on bool) {
	a.enabled = enabled
	a.low, a.high = 0, 0
	if enabled && !on && !a.manualOff {
		a.waiting = true
	}
}

func (a *autoPauser) resumeFailed() { a.waiting = true }
