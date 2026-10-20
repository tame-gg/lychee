package control

import "time"

const ProtocolVersion = 1

const (
	MaxFrame         = 65536
	MaxInFlight      = 16
	HelloTimeout     = 5000 * time.Millisecond
	PendingConns     = 4
	StartupTimeout   = 30000 * time.Millisecond
	GracePeriod      = 10000 * time.Millisecond
	StatsIntervalMin = 250 * time.Millisecond
	StatsIntervalMax = 5000 * time.Millisecond
	StatsIntervalDef = 1000 * time.Millisecond
	OutboundQueue    = 64
	WriteStall       = 30000 * time.Millisecond
	WeightMin        = 0.05
	WeightMax        = 100
	CommandDeadline  = 30 * time.Second
	MaxAdapters      = 64
	MaxStringLen     = 256
	LogRatePerSecond = 20
)

func msInt(d time.Duration) int64 { return int64(d / time.Millisecond) }

func durMs(ms int64) time.Duration { return time.Duration(ms) * time.Millisecond }
