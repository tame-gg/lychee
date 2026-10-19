package control

import (
	"errors"

	"github.com/tame-gg/lychee/native/netd/internal/engine"
	"github.com/tame-gg/lychee/native/netd/internal/nics"
)

var ErrUnknownAdapter = errors.New("unknown adapter")

type Engine interface {
	Snapshot() []engine.SlotStats
	Skipped() []nics.Skip
	DiscoverySeq() uint64
	Excluded(name string) bool
	WeightMode(name string) string
	On() error
	Off() error
	IsOn() bool
	TunName() string
	SetV6Mode(engine.V6Mode)
	V6Mode() engine.V6Mode
	V6Allowed() bool
	V6State() string
	SetExcluded(name string, excluded bool) error
	SetWeight(name string, weight float64, auto bool) error
	Cleanup() error
}
