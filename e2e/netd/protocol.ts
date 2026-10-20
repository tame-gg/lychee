/**
 * Wire types and constants of the lychee-netd control channel (docs/netd-control-channel.md),
 * written down locally from Appendix C so the fake helper has no runtime dependency on src/.
 * The spec's tables are normative; these types only name what the fake emits and parses.
 */

export const PROTOCOL_VERSION = 1

/** Section 1.5. Reported in the hello result as `limits`, so a client never hard-codes them. */
export const LIMITS = {
  max_frame: 65536,
  max_in_flight: 16,
  hello_timeout_ms: 5000,
  grace_ms: 10000,
  startup_timeout_ms: 30000,
  stats_interval_ms: { min: 250, max: 5000, default: 1000 },
  weight: { min: 0.05, max: 100 }
} as const

/** Section 1.5: outbound queue depth, write stall limit, string and list caps, log rate limit. */
export const PENDING_CONNECTIONS_MAX = 4
export const WRITE_STALL_MS = 30000
export const MAX_STRING_BYTES = 256
export const MAX_ADAPTERS = 64
export const LOG_EVENTS_PER_SECOND = 20
export const MAX_ID = Number.MAX_SAFE_INTEGER // 2^53 - 1

export type Cmd =
  | 'hello'
  | 'status'
  | 'subscribe'
  | 'unsubscribe'
  | 'on'
  | 'off'
  | 'set_ipv6'
  | 'set_autopause'
  | 'exclude'
  | 'include'
  | 'set_weight'
  | 'list_adapters'
  | 'cleanup'
  | 'quit'

export const COMMANDS: readonly Cmd[] = [
  'hello',
  'status',
  'subscribe',
  'unsubscribe',
  'on',
  'off',
  'set_ipv6',
  'set_autopause',
  'exclude',
  'include',
  'set_weight',
  'list_adapters',
  'cleanup',
  'quit'
]

export type ErrorCode =
  | 'bad_request'
  | 'frame_too_large'
  | 'too_many_requests'
  | 'unknown_command'
  | 'unknown_field'
  | 'hello_required'
  | 'version_unsupported'
  | 'busy'
  | 'invalid_state'
  | 'unknown_adapter'
  | 'out_of_range'
  | 'no_adapters'
  | 'unsupported_platform'
  | 'permission_denied'
  | 'internal'

export interface Req {
  id: number
  cmd: Cmd
  args?: object
}

export interface ErrorBody {
  code: ErrorCode
  message: string
  data?: Record<string, unknown>
}

export type Res =
  | { id: number | null; ok: true; result: object }
  | { id: number | null; ok: false; error: ErrorBody }

export type Ev =
  | { event: 'stats'; seq: number; data: Snapshot & { dropped: number } }
  | { event: 'state'; seq: number; data: StateInfo }
  | { event: 'log'; seq: number; data: { level: string; message: string } }

export type MergeState = 'off' | 'starting' | 'on' | 'paused_auto' | 'error'
export type AutopauseStatus = 'disabled' | 'armed' | 'held' | 'waiting' | 'manual_off' | 'idle'
export type Ipv6Mode = 'auto' | 'on' | 'off'
export type LinkState = 'none' | 'checking' | 'up' | 'down'
export type WeightMode = 'auto' | 'manual'

/** Section 8.3, in the spec's field order. */
export interface StateInfo {
  ts: number
  state: MergeState
  state_since: number
  error: { message: string } | null
  capture: { available: boolean; error: string | null }
  autopause: { enabled: boolean; status: AutopauseStatus }
  ipv6: { mode: Ipv6Mode; effective: 'balanced' | 'refused'; detail: string }
  tun: { name: string | null; open: boolean }
}

export interface Totals {
  link_in_bps: number
  link_out_bps: number
  relayed_in_bps: number
  relayed_out_bps: number
  active_flows: number
  adapters_present: number
  adapters_usable: number
}

/** Section 8.2, `adapters[]`, in the spec's field order. */
export interface Adapter {
  name: string
  ip: string | null
  ip6: string | null
  present: boolean
  excluded: boolean
  state: LinkState
  state6: LinkState
  weight: number
  weight6: number
  weight_mode: WeightMode
  peak_bps: number
  peak6_bps: number
  active_flows: number
  total_flows: number
  failed_flows: number
  link_in_bps: number
  link_out_bps: number
  relayed_in_bps: number
  relayed_out_bps: number
  bytes_in: number
  bytes_out: number
}

/** Section 8.2, in the spec's field order (stats adds `dropped`, status adds `skipped`). */
export interface Snapshot extends StateInfo {
  totals: Totals
  adapters: Adapter[]
  discovery_seq: number
}

export interface Skipped {
  name: string
  reason: string
}

export interface HelloResult {
  protocol: number
  helper_version: string
  os: string
  arch: string
  pid: number
  instance: string
  session: number
  auth: AuthInfo
  capabilities: string[]
  limits: typeof LIMITS
  capture: { available: boolean; error: string | null }
}

export type AuthInfo =
  | { model: 'unix_peer_uid'; privilege: 'root' | 'capabilities'; authorized_uid: number }
  | { model: 'windows_pipe_sid'; privilege: 'elevated'; authorized_sid: string }
