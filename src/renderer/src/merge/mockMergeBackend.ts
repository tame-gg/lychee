import { validWeight } from '@shared/mergeSettings'
import {
  MERGE_HISTORY_SECONDS,
  type MergeAdapter,
  type MergeSettings,
  type MergeSkipped,
  type MergeState,
  type MergeStatus
} from '@shared/types'
import type { MergeBackend } from './mergeBackend'

// A stand-in for lychee-netd and the MergeController together, for working on the Network page
// without the helper (LYCHEE_NETWORK_PAGE=mock). It keeps everything in memory: nothing it is told
// is saved, so it can never leave merging switched on for the real helper's next launch.

interface MockAdapter {
  name: string
  ip: string
  ip6: string | null
  /** Bytes a second it carries in and out while merging, before the wobble. */
  inBps: number
  outBps: number
}

const ADAPTERS: MockAdapter[] = [
  { name: 'Wi-Fi', ip: '192.168.1.23', ip6: '2001:db8:1::23', inBps: 6_100_000, outBps: 250_000 },
  { name: 'Ethernet', ip: '10.42.0.5', ip6: null, inBps: 3_800_000, outBps: 160_000 },
  { name: 'iPhone USB', ip: '172.20.10.2', ip6: null, inBps: 2_200_000, outBps: 90_000 }
]

const SKIPPED: MergeSkipped[] = [
  { name: 'tailscale0', reason: 'looks like a virtual/VPN adapter (name)' },
  { name: 'docker0', reason: 'no default gateway (no internet route)' }
]

/** What the controller reports for each way turning merging on can end, worded as it words them. */
const OUTCOME_MESSAGES: Partial<Record<MergeStatus, string>> = {
  error: 'route 0.0.0.0/1: file exists',
  stopped: 'The network helper stopped unexpectedly',
  reconnecting: 'Reconnecting to the network helper',
  needs_permission: 'the administrator prompt was declined',
  needs_admin:
    'Combining connections system-wide needs an administrator account on this PC. Sign in with one, or ask an administrator to set it up.',
  not_installed: 'the network helper is not set up on this computer',
  out_of_date: 'the network helper speaks protocol [2], Lychee speaks 1',
  unsupported: 'this computer has no TUN driver (/dev/net/tun)',
  another_tool: 'another connection-merging tool is running',
  unavailable: 'could not connect to the network helper: connect ECONNREFUSED'
}

/** Outcomes where the helper never got going: no stats follow. */
const LAUNCH_FAILURES = new Set<MergeStatus>([
  'needs_permission',
  'needs_admin',
  'not_installed',
  'out_of_date',
  'unsupported',
  'another_tool',
  'unavailable'
])

type Engine = 'off' | 'on' | 'paused_auto' | 'error'

export interface MockMergeOptions {
  settings: MergeSettings
  /** What turning merging on comes to; 'on' unless a test or a designer wants another state. */
  outcome?: MergeStatus
  tickMs?: number
  startMs?: number
}

export function createMockMergeBackend(options: MockMergeOptions): MergeBackend {
  const outcome =
    options.outcome && (options.outcome in OUTCOME_MESSAGES || options.outcome === 'paused_auto')
      ? options.outcome
      : 'on'
  const tickMs = options.tickMs ?? 1000
  const startMs = options.startMs ?? 700
  const listeners = new Set<(state: MergeState) => void>()
  // Never on from the start: the simulation is switched on from the page, like the real thing.
  let settings: MergeSettings = { ...options.settings, enabled: false }
  let status: MergeStatus = 'off'
  let message: string | null = null
  let running = false
  let engine: Engine = 'off'
  let since: number | null = null
  let tick = 0
  let seq = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let starting: ReturnType<typeof setTimeout> | null = null
  let adapters: MergeAdapter[] = []
  const peaks = new Map<string, number>()
  const history = { down: {} as Record<string, number[]>, up: {} as Record<string, number[]> }

  const state = (): MergeState => {
    const present = adapters.filter((adapter) => adapter.present)
    const sum = (key: keyof MergeAdapter): number =>
      present.reduce((total, adapter) => total + (adapter[key] as number), 0)
    const used = present.filter((adapter) => !adapter.excluded)
    const allV6 = used.length > 0 && used.every((adapter) => adapter.ip6 !== null)
    const v6 = settings.ipv6 === 'on' || (settings.ipv6 === 'auto' && allV6)
    return {
      seq,
      status,
      message,
      settings: { ...settings, excluded: [...settings.excluded], weights: { ...settings.weights } },
      helper: running
        ? {
            version: 'mock',
            pid: 0,
            os: window.lychee.platform,
            arch: 'x64',
            instance: 'mock',
            capabilities: ['link_counters']
          }
        : null,
      helperState: running ? engine : null,
      capture: running ? { available: true, error: null } : null,
      autopause: running
        ? {
            enabled: settings.autoPause,
            status: !settings.autoPause
              ? 'disabled'
              : engine === 'on'
                ? 'armed'
                : engine === 'paused_auto'
                  ? 'waiting'
                  : 'manual_off'
          }
        : null,
      ipv6: running
        ? {
            mode: settings.ipv6,
            effective: v6 ? 'balanced' : 'refused',
            detail: v6
              ? `${settings.ipv6}: balanced across every adapter`
              : `${settings.ipv6}: refused, apps fall back to IPv4 so every adapter is used (not every adapter has IPv6)`
          }
        : null,
      tun: running ? { name: 'lychee-netd', open: engine === 'on' } : null,
      stateSince: since,
      totals: running
        ? {
            link_in_bps: sum('link_in_bps'),
            link_out_bps: sum('link_out_bps'),
            relayed_in_bps: sum('relayed_in_bps'),
            relayed_out_bps: sum('relayed_out_bps'),
            active_flows: sum('active_flows'),
            adapters_present: present.length,
            adapters_usable: present.filter(
              (adapter) => adapter.state === 'up' || adapter.state6 === 'up'
            ).length
          }
        : null,
      adapters: adapters.map((adapter) => ({ ...adapter })),
      skipped: running ? SKIPPED : [],
      discoverySeq: running ? 1 : 0,
      history: {
        down: Object.fromEntries(Object.entries(history.down).map(([k, v]) => [k, [...v]])),
        up: Object.fromEntries(Object.entries(history.up).map(([k, v]) => [k, [...v]]))
      }
    }
  }

  const push = (): void => {
    seq++
    const snapshot = state()
    for (const listener of listeners) listener(snapshot)
  }

  /** One stats tick: OS counters for every adapter, the helper's own counters for those it uses. */
  const sample = (): void => {
    tick++
    const merging = engine === 'on'
    adapters = ADAPTERS.map((spec, index) => {
      const excluded = settings.excluded.includes(spec.name)
      const wobble =
        1 + 0.22 * Math.sin(tick / 3 + index * 1.3) + 0.08 * Math.sin(tick * 1.7 + index)
      // Not merging, the default route (the first) carries nearly everything.
      const share = merging && !excluded ? 1 : index === 0 ? 0.55 : 0.03
      const linkIn = Math.trunc(spec.inBps * share * wobble)
      const linkOut = Math.trunc(spec.outBps * share * wobble)
      const relaying = merging && !excluded
      const relayedIn = relaying ? Math.trunc(linkIn * 0.93) : 0
      const relayedOut = relaying ? Math.trunc(linkOut * 0.93) : 0
      if (relaying) peaks.set(spec.name, Math.max(peaks.get(spec.name) ?? 0, relayedIn))
      const checking = tick <= 2
      const up = checking ? 'checking' : 'up'
      const manual = settings.weights[spec.name]
      const peak = peaks.get(spec.name) ?? 0
      const best = Math.max(1, ...peaks.values())
      const flows = relaying ? Math.max(1, Math.round((linkIn / 250_000) * (1 + index * 0.2))) : 0
      return {
        name: spec.name,
        ip: spec.ip,
        ip6: spec.ip6,
        present: true,
        excluded,
        state: excluded ? 'none' : up,
        state6: excluded || !spec.ip6 ? 'none' : up,
        weight: excluded ? 0 : (manual ?? (peak > 0 ? Math.round((peak / best) * 100) / 100 : 1)),
        weight6: excluded ? 0 : 1,
        weight_mode: manual === undefined ? 'auto' : 'manual',
        peak_bps: excluded ? 0 : peak,
        peak6_bps: 0,
        active_flows: flows,
        total_flows: excluded ? 0 : tick * 3 + flows * 11,
        failed_flows: excluded ? 0 : index,
        link_in_bps: linkIn,
        link_out_bps: linkOut,
        relayed_in_bps: relayedIn,
        relayed_out_bps: relayedOut,
        bytes_in: excluded ? 0 : relayedIn * tick,
        bytes_out: excluded ? 0 : relayedOut * tick
      }
    })
    for (const adapter of adapters) {
      for (const [series, value] of [
        [history.down, adapter.link_in_bps],
        [history.up, adapter.link_out_bps]
      ] as const) {
        const ring = (series[adapter.name] ??= [])
        ring.push(value)
        if (ring.length > MERGE_HISTORY_SECONDS) ring.shift()
      }
    }
    if (outcome === 'stopped' && tick === 4) return stop()
    push()
  }

  const setEngine = (next: Engine, nextStatus: MergeStatus, nextMessage: string | null): void => {
    if (engine !== next) since = Date.now()
    engine = next
    status = nextStatus
    message = nextMessage
  }

  /** The helper went away: its history stays, like the controller keeps it. */
  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = null
    running = false
    adapters = []
    setEngine('off', 'stopped', OUTCOME_MESSAGES.stopped!)
    push()
  }

  const launch = (): void => {
    starting = null
    if (!settings.enabled) return
    if (LAUNCH_FAILURES.has(outcome)) {
      status = outcome
      message = OUTCOME_MESSAGES[outcome] ?? null
      return push()
    }
    if (!running) {
      running = true
      timer = setInterval(sample, tickMs)
    }
    if (outcome === 'error') setEngine('error', 'error', OUTCOME_MESSAGES.error!)
    else if (outcome === 'paused_auto') setEngine('paused_auto', 'paused_auto', null)
    else if (outcome === 'reconnecting')
      setEngine('on', 'reconnecting', OUTCOME_MESSAGES.reconnecting!)
    else setEngine('on', 'on', null)
    sample()
  }

  return {
    mergeState: async () => state(),
    onMergeState: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    setMerging: async (on) => {
      settings = { ...settings, enabled: on }
      if (starting) clearTimeout(starting)
      starting = null
      if (on) {
        status = 'starting'
        message = null
        starting = setTimeout(launch, startMs)
      } else if (running) {
        setEngine('off', 'off', null)
      } else {
        status = 'off'
        message = null
      }
      push()
    },
    setMergeOptions: async (patch) => {
      settings = { ...settings, ...patch }
      push()
    },
    setMergeNetwork: async (id, enabled) => {
      const excluded = settings.excluded.filter((name) => name !== id)
      if (!enabled) excluded.push(id)
      settings = { ...settings, excluded }
      push()
    },
    setMergeWeight: async (id, weight) => {
      if (weight !== 'auto' && !validWeight(weight)) throw new Error('Weight out of range')
      const weights = { ...settings.weights }
      if (weight === 'auto') delete weights[id]
      else weights[id] = weight
      settings = { ...settings, weights }
      push()
    },
    repairNetwork: async () => {
      if (!running) throw new Error('The network helper is not available')
      if (engine !== 'off') throw new Error('Turn combining off before repairing')
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
}
