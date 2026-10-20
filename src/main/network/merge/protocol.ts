import type {
  MergeAdapter,
  MergeAutopause,
  MergeCapture,
  MergeIpv6,
  MergeSkipped,
  MergeTotals,
  MergeTun
} from '../../../shared/types'

export const PROTOCOL_VERSION = 1
export const CLIENT_NAME = 'lychee'
export const COMMAND_TIMEOUT_MS = 5000
export const LONG_COMMAND_TIMEOUT_MS = 45000

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

export const LONG_COMMANDS: ReadonlySet<Cmd> = new Set<Cmd>(['on', 'off', 'cleanup'])

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
  | (string & {})

export interface ErrorBody {
  code: ErrorCode
  message: string
  data?: Record<string, unknown>
}

export interface Limits {
  max_frame: number
  max_in_flight: number
  hello_timeout_ms: number
  grace_ms: number
  startup_timeout_ms: number
  stats_interval_ms: { min: number; max: number; default: number }
  weight: { min: number; max: number }
}

export const DEFAULT_LIMITS: Limits = {
  max_frame: 65536,
  max_in_flight: 16,
  hello_timeout_ms: 5000,
  grace_ms: 10000,
  startup_timeout_ms: 30000,
  stats_interval_ms: { min: 250, max: 5000, default: 1000 },
  weight: { min: 0.05, max: 100 }
}

export type AuthInfo =
  | { model: 'unix_peer_uid'; privilege: string; authorized_uid: number }
  | { model: 'windows_pipe_sid'; privilege: string; authorized_sid: string }
  | { model: string; privilege: string }

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
  limits: Limits
  capture: MergeCapture
}

export type HelperState = 'off' | 'starting' | 'on' | 'paused_auto' | 'error' | (string & {})

export interface StateInfo {
  ts: number
  state: HelperState
  state_since: number
  error: { message: string } | null
  capture: MergeCapture
  autopause: MergeAutopause
  ipv6: MergeIpv6
  tun: MergeTun
}

export interface Snapshot extends StateInfo {
  totals: MergeTotals
  adapters: MergeAdapter[]
  discovery_seq: number
}

export interface StatsData extends Snapshot {
  dropped: number
}

export interface StatusResult extends Snapshot {
  skipped: MergeSkipped[]
  truncated?: boolean
}

export interface LogEntry {
  level: string
  message: string
}

export interface ListedAdapter {
  name: string
  index: number
  ip: string | null
  ip6: string | null
  excluded: boolean
  weight_mode: 'auto' | 'manual'
  description: string | null
}

export interface ListAdaptersResult {
  discovery_seq: number
  adapters: ListedAdapter[]
  skipped: MergeSkipped[]
  truncated?: boolean
}
