import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { FakeClock, type FakeTimer } from './fakeClock'
import {
  COMMANDS,
  LIMITS,
  LOG_EVENTS_PER_SECOND,
  MAX_ADAPTERS,
  MAX_ID,
  MAX_STRING_BYTES,
  PENDING_CONNECTIONS_MAX,
  WRITE_STALL_MS,
  type Adapter,
  type AuthInfo,
  type AutopauseStatus,
  type Cmd,
  type ErrorBody,
  type ErrorCode,
  type HelloResult,
  type Ipv6Mode,
  type LinkState,
  type MergeState,
  type Skipped,
  type Snapshot,
  type StateInfo,
  type Totals
} from './protocol'

/**
 * A TEST-ONLY fake of `lychee-netd serve --control <path>`: the helper side of
 * docs/netd-control-channel.md over a real Unix socket or named pipe, with a manual clock and a
 * scriptable engine, so the client (src/main/network/merge/netdClient.ts, plan item L-3) can be
 * tested against exact frames. Not shipped (electron-builder excludes e2e/). See README.md here.
 */

/** What discovery would say about one adapter. */
export interface AdapterSpec {
  name: string
  index: number
  ip: string | null
  ip6: string | null
  /** The OS's hardware description; `list_adapters` only. */
  description?: string | null
  state: LinkState
  state6: LinkState
  /** Listed by the latest discovery (default true); false models "vanished, flows still active". */
  present?: boolean
}

/** The per-adapter numbers of a stats sample (section 8.2); the fake fills in what is missing. */
export interface AdapterCounters {
  weight: number
  weight6: number
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

export interface SampleContext {
  /** Number of stats events emitted so far by this helper (0 for the first). */
  tick: number
  /** The snapshot's `ts`. */
  ts: number
  adapter: AdapterSpec
  state: MergeState
  excluded: boolean
}

/** Produces an adapter's counters for one snapshot. Rates are truncated to integers by the fake. */
export type Sampler = (ctx: SampleContext) => Partial<AdapterCounters>

export const defaultSampler: Sampler = ({ tick, adapter }) => ({
  weight: 1,
  weight6: 1,
  link_in_bps: 100000 * adapter.index + 1000 * tick,
  link_out_bps: 10000 * adapter.index + 100 * tick
})

/** Appendix B's two adapters. */
export const appendixBAdapters: AdapterSpec[] = [
  {
    name: 'en0',
    index: 4,
    ip: '192.168.1.23',
    ip6: null,
    description: 'Wi-Fi',
    state: 'up',
    state6: 'none'
  },
  {
    name: 'en7',
    index: 12,
    ip: '192.168.2.5',
    ip6: null,
    description: 'USB 10/100/1000 LAN',
    state: 'up',
    state6: 'none'
  }
]

export interface FakeNetdOptions {
  /** From uniqueControlPath(). */
  path: string
  clock?: FakeClock
  /** Identity reported in the hello result. Defaults reproduce Appendix B. */
  pid?: number
  instance?: string
  helperVersion?: string
  os?: string
  arch?: string
  auth?: AuthInfo
  capabilities?: string[]
  /** `tun.name` while the adapter exists (`utunN` on macOS, `lychee-netd` elsewhere). */
  tunName?: string
  /** Protocol versions this helper speaks (hello negotiation picks the highest common one). */
  supportedProtocols?: number[]
  capture?: { available: boolean; error: string | null }
  adapters?: AdapterSpec[]
  skipped?: Skipped[]
  /**
   * `busy` reports the session's client pid. Node cannot read a Unix peer's pid, so the fake
   * reports this constant (Appendix B: 4098).
   */
  clientPid?: number
  /** Peer check fails for everyone: every connection is closed with zero bytes (section 3.3). */
  rejectPeers?: boolean
  sampler?: Sampler
  /** `ipv6.effective` under mode `auto`; 'derive' means "every usable adapter has IPv6 up". */
  ipv6CoversAll?: boolean | 'derive'
}

export interface ExitInfo {
  /** The process exit code; null for a crash that was killed rather than exited. */
  code: number | null
}

export interface Hold {
  /** Lets the held command finish (at the fake clock's current time). */
  release(): void
}

export type StateView = {
  state: MergeState
  autopause: AutopauseStatus
  excluded: string[]
  weights: Record<string, number>
  session: number | null
  subscriptionMs: number | null
  graceRunning: boolean
  exited: boolean
}

interface QueuedRequest {
  id: number
  cmd: string
  args: Record<string, unknown>
  /** Top-level keys other than id/cmd/args, in order. */
  extraKeys: string[]
  sources: NumberSources
}

/** Where every JSON number came from, so `1.0` can be told from `1` (section 4.1). */
type NumberSources = WeakMap<object, Map<string, string>>

interface SessionState {
  number: number
  seq: number
  dropped: number
  subscription: { intervalMs: number; nextDue: number; timer: FakeTimer | null } | null
  statsPending: boolean
  logWindowStart: number
  logWindowCount: number
}

class Connection {
  buffer: Buffer = Buffer.alloc(0)
  closed = false
  gone = false
  session: SessionState | null = null
  queue: QueuedRequest[] = []
  executing: QueuedRequest | null = null
  processingScheduled = false
  helloTimer: FakeTimer | null = null
  stallTimer: FakeTimer | null = null
  needDrain = false
  constructor(
    readonly socket: Socket,
    readonly index: number
  ) {}
  get unanswered(): number {
    return this.queue.length + (this.executing ? 1 : 0)
  }
}

const CLIENT_RE = /^[A-Za-z0-9._-]{1,32}$/
const CLIENT_VERSION_RE = /^[A-Za-z0-9._+-]{1,32}$/
const INT_LITERAL_RE = /^-?(0|[1-9][0-9]*)$/
const decoder = new TextDecoder('utf-8', { fatal: true })

type FieldType = 'integer' | 'number' | 'string' | 'boolean' | 'array' | 'weight'
type Schema = Record<string, { type: FieldType; required: boolean }>

function error(code: ErrorCode, message: string, data?: Record<string, unknown>): ErrorBody {
  return data ? { code, message, data } : { code, message }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parses one frame, remembering the source text of every number. */
function parseFrame(text: string): { value: unknown; sources: NumberSources } {
  const sources: NumberSources = new WeakMap()
  const value = JSON.parse(text, function (this: unknown, key, v, context?: { source?: string }) {
    if (typeof v === 'number' && context?.source && typeof this === 'object' && this !== null) {
      let m = sources.get(this)
      if (!m) sources.set(this, (m = new Map()))
      m.set(key, context.source)
    }
    return v
  })
  return { value, sources }
}

function isIntegerLiteral(sources: NumberSources, holder: object, key: string): boolean {
  const v = (holder as Record<string, unknown>)[key]
  if (typeof v !== 'number' || !Number.isInteger(v)) return false
  const src = sources.get(holder)?.get(key)
  return src === undefined ? true : INT_LITERAL_RE.test(src)
}

/** 1 to 256 bytes of UTF-8 with no control characters (sections 1.5, 7.9). */
function validName(s: string): boolean {
  const bytes = Buffer.byteLength(s, 'utf8')
  // eslint-disable-next-line no-control-regex
  return bytes >= 1 && bytes <= MAX_STRING_BYTES && !/[\u0000-\u001f\u007f]/.test(s)
}

export class FakeNetd extends EventEmitter {
  readonly path: string
  readonly clock: FakeClock
  readonly pid: number
  readonly instance: string
  readonly helperVersion: string
  readonly os: string
  readonly arch: string
  readonly auth: AuthInfo
  readonly capabilities: string[]
  readonly tunName: string
  readonly supportedProtocols: number[]
  readonly clientPid: number
  /** Resolves when the fake "process" exits (quit, grace expiry, startup timeout, crash). */
  readonly exited: Promise<ExitInfo>

  private server: Server | null = null
  private resolveExit!: (info: ExitInfo) => void
  private rejectPeers: boolean
  private sampler: Sampler
  private ipv6CoversAll: boolean | 'derive'

  // Engine state (section 10.1).
  private capture: { available: boolean; error: string | null }
  private routesOn = false
  private onInProgress = false
  private lastError: { message: string } | null = null
  private autopauseEnabled = true
  private manualOff = true
  private waiting = false
  private held = false
  private ipv6Mode: Ipv6Mode = 'auto'
  private tun: { name: string | null; open: boolean } = { name: null, open: false }
  private adapters: AdapterSpec[]
  private skipped: Skipped[]
  private readonly excluded = new Set<string>()
  private readonly weights = new Map<string, number>()
  private discoverySeq = 1
  private tick = 0
  private currentState: MergeState = 'off'
  private stateSince: number
  private lastStateKey = ''

  // Connections and lifecycle (sections 5.2, 10.2, 10.3).
  private readonly pending = new Set<Connection>()
  private sessionConn: Connection | null = null
  private sessionCounter = 0
  private connectionCount = 0
  private acceptedCount = 0
  private startupTimer: FakeTimer | null = null
  private graceTimer: FakeTimer | null = null
  private exitedFlag = false
  private quitting = false

  // Scripts.
  private readonly delays = new Map<string, number>()
  private readonly holds = new Map<string, Array<{ promise: Promise<void> }>>()
  private onFailure: string | null = null
  private cleanupFailure: string | null = null

  constructor(options: FakeNetdOptions) {
    super()
    this.path = options.path
    this.clock = options.clock ?? new FakeClock()
    this.pid = options.pid ?? 5120
    this.instance = options.instance ?? '3f9c2a7e5b1d4c6a8e0f1a2b3c4d5e6f'
    this.helperVersion = options.helperVersion ?? '0.2.0'
    this.os = options.os ?? 'darwin'
    this.arch = options.arch ?? 'arm64'
    this.auth = options.auth ?? { model: 'unix_peer_uid', privilege: 'root', authorized_uid: 501 }
    this.capabilities = options.capabilities ?? ['link_counters', 'keep_adapter_on_off']
    this.tunName = options.tunName ?? 'utun5'
    this.supportedProtocols = options.supportedProtocols ?? [1]
    this.clientPid = options.clientPid ?? 4098
    this.rejectPeers = options.rejectPeers ?? false
    this.sampler = options.sampler ?? defaultSampler
    this.ipv6CoversAll = options.ipv6CoversAll ?? 'derive'
    this.capture = options.capture ?? { available: true, error: null }
    this.adapters = (options.adapters ?? appendixBAdapters).map((a) => ({ ...a }))
    this.skipped = (options.skipped ?? []).map((s) => ({ ...s }))
    this.stateSince = this.clock.now()
    this.lastStateKey = this.stateKey()
    this.exited = new Promise((resolve) => (this.resolveExit = resolve))
  }

  /** Binds and listens; the 30 s startup timer starts now (section 10.2). */
  start(): Promise<this> {
    return new Promise((resolve, reject) => {
      const server = createServer({ allowHalfOpen: false }, (socket) => this.accept(socket))
      server.on('error', reject)
      server.listen(this.path, () => {
        server.off('error', reject)
        this.server = server
        this.startupTimer = this.clock.setTimeout(
          () => this.shutdown(0, 'no client connected'),
          LIMITS.startup_timeout_ms
        )
        resolve(this)
      })
    })
  }

  // ---- Observability -----------------------------------------------------------------------

  get view(): StateView {
    return {
      state: this.currentState,
      autopause: this.autopauseStatus(),
      excluded: [...this.excluded],
      weights: Object.fromEntries(this.weights),
      session: this.sessionConn?.session?.number ?? null,
      subscriptionMs: this.sessionConn?.session?.subscription?.intervalMs ?? null,
      graceRunning: this.graceTimer !== null,
      exited: this.exitedFlag
    }
  }

  /** Connections the kernel handed us so far, including rejected and capped ones. */
  get connections(): number {
    return this.connectionCount
  }

  /** Resolves once at least `n` connections have reached the fake (accepted, rejected or capped). */
  waitForConnections(n: number, timeoutMs = 2000): Promise<void> {
    return this.waitFor(() => this.connectionCount >= n, 'connection', timeoutMs)
  }

  /** Resolves when the fake starts executing a request with this command. */
  nextRequest(cmd: Cmd, timeoutMs = 2000): Promise<{ id: number }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('request', handler)
        reject(new Error(`no ${cmd} request within ${timeoutMs} ms`))
      }, timeoutMs)
      const handler = (req: { cmd: string; id: number }): void => {
        if (req.cmd !== cmd) return
        clearTimeout(timer)
        this.off('request', handler)
        resolve({ id: req.id })
      }
      this.on('request', handler)
    })
  }

  // ---- Scripting controls ------------------------------------------------------------------

  /** Replaces the per-adapter sampler used for `stats` and `status`. */
  setSampler(sampler: Sampler): void {
    this.sampler = sampler
  }

  addAdapter(spec: AdapterSpec): void {
    this.adapters = this.adapters.filter((a) => a.name !== spec.name).concat({ ...spec })
    this.discoverySeq++
    this.adaptersChanged()
  }

  removeAdapter(name: string): void {
    this.adapters = this.adapters.filter((a) => a.name !== name)
    this.discoverySeq++
    this.adaptersChanged()
  }

  /** Changes link state, addresses or presence of an adapter ("down": state 'down'). */
  updateAdapter(name: string, patch: Partial<Omit<AdapterSpec, 'name'>>): void {
    const a = this.adapters.find((x) => x.name === name)
    if (!a) throw new Error(`no adapter ${name}`)
    Object.assign(a, patch)
    if ('present' in patch) this.discoverySeq++
    this.adaptersChanged()
  }

  setSkipped(skipped: Skipped[]): void {
    this.skipped = skipped.map((s) => ({ ...s }))
    this.discoverySeq++
  }

  /** `capture.available`/`capture.error`, as `platform.CheckDriver` would report them. */
  setCapture(available: boolean, errorMessage: string | null = null): void {
    this.capture = { available, error: available ? null : errorMessage }
    this.refreshState()
  }

  /** Every later `on` fails with `internal` and this message; null restores success. */
  setOnFailure(message: string | null): void {
    this.onFailure = message
  }

  setCleanupFailure(message: string | null): void {
    this.cleanupFailure = message
  }

  /** The command's work takes `ms` of fake time (0 clears). For `on`, between `starting` and `on`. */
  setDelay(cmd: Cmd, ms: number): void {
    if (ms > 0) this.delays.set(cmd, ms)
    else this.delays.delete(cmd)
  }

  /** The next request with this command waits (in real time) until `release()` is called. */
  holdNext(cmd: Cmd): Hold {
    let release!: () => void
    const promise = new Promise<void>((resolve) => (release = resolve))
    const list = this.holds.get(cmd) ?? []
    list.push({ promise })
    this.holds.set(cmd, list)
    return { release }
  }

  /** The autopauser pauses merging (fewer than two usable adapters for long enough, 10.1). */
  autoPause(): boolean {
    if (!this.routesOn || !this.autopauseEnabled || this.held) return false
    this.routesOn = false
    this.waiting = true
    if (!this.keepsDevice()) this.tun = { name: null, open: false }
    this.refreshState()
    return true
  }

  /** The autopauser resumes merging after two usable adapters came back (10.1). */
  autoResume(): boolean {
    if (this.currentState !== 'paused_auto') return false
    this.onInProgress = true
    this.refreshState()
    this.afterScript('on', () => {
      this.onInProgress = false
      if (this.onFailure) {
        this.lastError = { message: this.onFailure }
      } else {
        this.routesOn = true
        this.waiting = false
        this.tun = { name: this.tunName, open: true }
      }
      this.refreshState()
    })
    return true
  }

  /** Emits a `log` event on the session (rate-limited to 20/s of fake time, section 8.4). */
  log(level: 'info' | 'warn' | 'error', message: string): void {
    const conn = this.sessionConn
    if (!conn?.session) return
    const s = conn.session
    const now = this.clock.now()
    if (now - s.logWindowStart >= 1000) {
      s.logWindowStart = now
      s.logWindowCount = 0
    }
    s.logWindowCount++
    s.seq++
    if (s.logWindowCount > LOG_EVENTS_PER_SECOND) {
      s.dropped++
      return
    }
    this.write(conn, { event: 'log', seq: s.seq, data: { level, message } })
  }

  /** Pretends `n` events were dropped for backpressure: `seq` advances, `dropped` grows (8.5). */
  dropEvents(n: number): void {
    const s = this.sessionConn?.session
    if (!s) return
    s.seq += n
    s.dropped += n
  }

  /** The helper closes the session's connection (as a write stall would): the grace period starts. */
  disconnect(): void {
    const conn = this.sessionConn
    if (!conn) return
    conn.closed = true
    conn.socket.end()
    this.connectionGone(conn)
  }

  /** The process dies: every connection is destroyed without a response and `exit` fires. */
  crash(code: number | null = null): void {
    this.shutdown(code, 'crash', true)
  }

  setRejectPeers(reject: boolean): void {
    this.rejectPeers = reject
  }

  /** Test teardown: closes everything without an exit event. */
  async close(): Promise<void> {
    this.shutdown(null, 'closed by test', true, true)
  }

  // ---- Connections -------------------------------------------------------------------------

  private accept(socket: Socket): void {
    this.connectionCount++
    if (this.exitedFlag || this.quitting) {
      socket.destroy()
      return
    }
    if (this.rejectPeers) {
      // Section 3.3: a peer that fails the credential check receives nothing and sees EOF.
      socket.destroy()
      this.emit('rejected')
      this.emit('connection')
      return
    }
    if (this.pending.size >= PENDING_CONNECTIONS_MAX) {
      socket.destroy()
      this.emit('connection')
      return
    }
    this.acceptedCount++
    const conn = new Connection(socket, this.acceptedCount)
    this.pending.add(conn)
    if (this.startupTimer) {
      this.clock.clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.graceTimer) {
      this.clock.clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    conn.helloTimer = this.clock.setTimeout(() => {
      conn.helloTimer = null
      this.closeWithError(
        conn,
        null,
        error('hello_required', `hello not received within ${LIMITS.hello_timeout_ms} ms`)
      )
    }, LIMITS.hello_timeout_ms)
    socket.on('data', (chunk: Buffer) => this.onData(conn, chunk))
    socket.on('drain', () => {
      conn.needDrain = false
      if (conn.stallTimer) {
        this.clock.clearTimeout(conn.stallTimer)
        conn.stallTimer = null
      }
    })
    socket.on('end', () => {
      conn.closed = true
      this.connectionGone(conn)
    })
    socket.on('close', () => {
      conn.closed = true
      this.connectionGone(conn)
    })
    socket.on('error', () => {
      conn.closed = true
      this.connectionGone(conn)
    })
    this.emit('connection')
  }

  /** Bookkeeping when a connection is over, whoever ended it. Idempotent. */
  private connectionGone(conn: Connection): void {
    if (conn.gone) return
    conn.gone = true
    conn.closed = true
    if (conn.helloTimer) this.clock.clearTimeout(conn.helloTimer)
    if (conn.stallTimer) this.clock.clearTimeout(conn.stallTimer)
    conn.helloTimer = conn.stallTimer = null
    this.pending.delete(conn)
    const wasSession = this.sessionConn === conn
    if (wasSession) {
      if (conn.session?.subscription?.timer) {
        this.clock.clearTimeout(conn.session.subscription.timer)
      }
      conn.session = null
      this.sessionConn = null
      this.emit('sessionLost')
    }
    if (this.exitedFlag || this.quitting) return
    // Section 10.3: the grace timer starts when the session drops and restarts when a connection
    // accepted during it fails to become the session.
    if (!this.sessionConn && this.pending.size === 0 && this.sessionCounter > 0) {
      this.startGrace()
    }
  }

  private startGrace(): void {
    if (this.graceTimer) this.clock.clearTimeout(this.graceTimer)
    this.graceTimer = this.clock.setTimeout(() => {
      this.graceTimer = null
      this.shutdown(0, 'client gone')
    }, LIMITS.grace_ms)
    this.emit('grace')
  }

  private shutdown(code: number | null, reason: string, abrupt = false, silent = false): void {
    if (this.exitedFlag) return
    this.exitedFlag = true
    this.quitting = true
    this.routesOn = false
    this.onInProgress = false
    this.tun = { name: null, open: false }
    this.currentState = 'off'
    if (this.startupTimer) this.clock.clearTimeout(this.startupTimer)
    if (this.graceTimer) this.clock.clearTimeout(this.graceTimer)
    this.startupTimer = this.graceTimer = null
    for (const conn of [...this.pending, ...(this.sessionConn ? [this.sessionConn] : [])]) {
      conn.closed = true
      if (abrupt) conn.socket.destroy()
      else conn.socket.end()
      this.connectionGone(conn)
    }
    this.server?.close()
    this.server = null
    if (!silent) {
      const info: ExitInfo = { code }
      this.emit('exit', info, reason)
      this.resolveExit(info)
    }
  }

  // ---- Framing (section 4) -----------------------------------------------------------------

  private onData(conn: Connection, chunk: Buffer): void {
    if (conn.closed) return
    conn.buffer = conn.buffer.length ? Buffer.concat([conn.buffer, chunk]) : chunk
    for (;;) {
      const nl = conn.buffer.indexOf(0x0a)
      if (nl === -1) {
        if (conn.buffer.length > LIMITS.max_frame - 1) this.frameTooLarge(conn)
        break
      }
      const line = conn.buffer.subarray(0, nl)
      conn.buffer = conn.buffer.subarray(nl + 1)
      if (line.length === 0) continue
      if (line.length > LIMITS.max_frame - 1) {
        this.frameTooLarge(conn)
        break
      }
      if (!this.acceptLine(conn, line)) break
    }
    if (!conn.closed) this.scheduleProcessing(conn)
  }

  private frameTooLarge(conn: Connection): void {
    this.closeWithError(
      conn,
      null,
      error('frame_too_large', `frame exceeds ${LIMITS.max_frame} bytes`)
    )
  }

  /** Decodes one line into the queue. Returns false if the connection was closed. */
  private acceptLine(conn: Connection, line: Buffer): boolean {
    const fail = (id: number | null, message: string): false => {
      this.closeWithError(conn, id, error('bad_request', message))
      return false
    }
    if (line.includes(0)) return fail(null, 'NUL byte in frame')
    let text: string
    try {
      text = decoder.decode(line)
    } catch {
      return fail(null, 'frame is not valid UTF-8')
    }
    let parsed: { value: unknown; sources: NumberSources }
    try {
      parsed = parseFrame(text)
    } catch {
      return fail(null, 'frame is not valid JSON')
    }
    const { value, sources } = parsed
    if (!isObject(value)) return fail(null, 'frame is not a JSON object')
    const id = value.id
    if (
      typeof id !== 'number' ||
      !isIntegerLiteral(sources, value, 'id') ||
      id < 1 ||
      id > MAX_ID
    ) {
      return fail(null, `id must be an integer between 1 and ${MAX_ID}`)
    }
    if (typeof value.cmd !== 'string') return fail(id, 'cmd must be a string')
    if ('args' in value && !isObject(value.args)) return fail(id, 'args must be an object')
    if (conn.queue.some((r) => r.id === id) || conn.executing?.id === id) {
      return fail(id, `id ${id} is still unanswered`)
    }
    if (conn.unanswered >= LIMITS.max_in_flight) {
      this.closeWithError(
        conn,
        id,
        error('too_many_requests', `more than ${LIMITS.max_in_flight} unanswered requests`)
      )
      return false
    }
    conn.queue.push({
      id,
      cmd: value.cmd,
      args: isObject(value.args) ? value.args : {},
      extraKeys: Object.keys(value).filter((k) => k !== 'id' && k !== 'cmd' && k !== 'args'),
      sources
    })
    return true
  }

  private scheduleProcessing(conn: Connection): void {
    if (conn.processingScheduled) return
    conn.processingScheduled = true
    queueMicrotask(() => {
      conn.processingScheduled = false
      this.processNext(conn)
    })
  }

  /** Section 4.3: one request at a time, strictly in order. */
  private processNext(conn: Connection): void {
    while (!conn.closed && !conn.executing && conn.queue.length) {
      const req = conn.queue.shift()!
      conn.executing = req
      this.emit('request', { cmd: req.cmd, id: req.id })
      this.execute(conn, req)
    }
  }

  private respond(conn: Connection, req: QueuedRequest, body: ErrorBody | object): void {
    if (conn.executing !== req) return
    conn.executing = null
    if (conn.closed) return
    const frame =
      'code' in body && 'message' in body
        ? { id: req.id, ok: false, error: body }
        : { id: req.id, ok: true, result: body }
    this.write(conn, frame)
    this.emit('response', frame)
    // A stats tick that fell due while this command ran goes out right after its response.
    if (conn.session?.statsPending) {
      conn.session.statsPending = false
      this.emitStats(conn)
    }
    this.processNext(conn)
  }

  private closeWithError(conn: Connection, id: number | null, body: ErrorBody): void {
    if (conn.closed) return
    this.write(conn, { id, ok: false, error: body })
    conn.closed = true
    conn.socket.end()
    this.connectionGone(conn)
  }

  private write(conn: Connection, frame: object): void {
    if (conn.closed || conn.socket.destroyed) return
    const ok = conn.socket.write(JSON.stringify(frame) + '\n')
    if (!ok && !conn.stallTimer) {
      conn.needDrain = true
      conn.stallTimer = this.clock.setTimeout(() => {
        conn.stallTimer = null
        conn.closed = true
        conn.socket.destroy()
        this.connectionGone(conn)
      }, WRITE_STALL_MS)
    }
  }

  // ---- Commands (sections 5 and 7) ---------------------------------------------------------

  private execute(conn: Connection, req: QueuedRequest): void {
    if (!conn.session) {
      if (req.cmd !== 'hello') {
        this.respondAndClose(
          conn,
          req,
          error('hello_required', 'hello must be the first request on a connection')
        )
        return
      }
      this.hello(conn, req)
      return
    }
    if (req.extraKeys.length) {
      this.respond(conn, req, unknownField(req.extraKeys[0]))
      return
    }
    if (!(COMMANDS as readonly string[]).includes(req.cmd)) {
      this.respond(
        conn,
        req,
        error('unknown_command', `unknown command ${JSON.stringify(req.cmd)}`, { cmd: req.cmd })
      )
      return
    }
    switch (req.cmd as Cmd) {
      case 'hello':
        this.respond(
          conn,
          req,
          error('invalid_state', 'hello already completed on this connection', {
            state: this.currentState
          })
        )
        return
      case 'status':
        return this.simple(conn, req, () => this.statusResult())
      case 'subscribe':
        return this.subscribe(conn, req)
      case 'unsubscribe':
        return this.simple(conn, req, () => {
          this.stopSubscription(conn)
          return {}
        })
      case 'on':
        return this.cmdOn(conn, req)
      case 'off':
        return this.cmdOff(conn, req)
      case 'set_ipv6':
        return this.setIpv6(conn, req)
      case 'set_autopause':
        return this.setAutopause(conn, req)
      case 'exclude':
        return this.excludeInclude(conn, req, true)
      case 'include':
        return this.excludeInclude(conn, req, false)
      case 'set_weight':
        return this.setWeight(conn, req)
      case 'list_adapters':
        return this.simple(conn, req, () => this.listAdapters())
      case 'cleanup':
        return this.cleanup(conn, req)
      case 'quit':
        return this.quit(conn, req)
    }
  }

  private respondAndClose(conn: Connection, req: QueuedRequest, body: ErrorBody): void {
    conn.executing = null
    this.closeWithError(conn, req.id, body)
  }

  /** Validates `args` against a schema: unknown fields first, then types, then required. */
  private validate(req: QueuedRequest, schema: Schema): ErrorBody | null {
    for (const key of Object.keys(req.args)) {
      if (!(key in schema)) return unknownField(`args.${key}`)
    }
    for (const [field, rule] of Object.entries(schema)) {
      if (!(field in req.args)) {
        if (rule.required) {
          return error('bad_request', `missing required field ${JSON.stringify(field)}`, {
            field
          })
        }
        continue
      }
      const v = req.args[field]
      const bad = (expected: string): ErrorBody =>
        error('bad_request', `${field} must be ${expected}`, { field })
      switch (rule.type) {
        case 'integer':
          if (!isIntegerLiteral(req.sources, req.args, field)) return bad('an integer')
          break
        case 'number':
          if (typeof v !== 'number') return bad('a number')
          break
        case 'string':
          if (typeof v !== 'string') return bad('a string')
          break
        case 'boolean':
          if (typeof v !== 'boolean') return bad('a boolean (true or false)')
          break
        case 'array':
          if (!Array.isArray(v)) return bad('an array')
          break
        case 'weight':
          if (typeof v !== 'number' && v !== 'auto') return bad('a number or the string "auto"')
          break
      }
    }
    return null
  }

  /** Runs `work` after this command's scripted delay or hold, if any. */
  private afterScript(cmd: string, work: () => void): void {
    const hold = this.holds.get(cmd)?.shift()
    if (hold) {
      void hold.promise.then(work)
      return
    }
    const delay = this.delays.get(cmd) ?? 0
    if (delay > 0) this.clock.setTimeout(work, delay)
    else work()
  }

  /** A command without arguments whose result is computed when its (scripted) work completes. */
  private simple(conn: Connection, req: QueuedRequest, result: () => object): void {
    const err = this.validate(req, {})
    if (err) return this.respond(conn, req, err)
    this.afterScript(req.cmd, () => this.respond(conn, req, result()))
  }

  private hello(conn: Connection, req: QueuedRequest): void {
    const fail = (body: ErrorBody): void => this.respondAndClose(conn, req, body)
    if (req.extraKeys.length) return fail(unknownField(req.extraKeys[0]))
    const err = this.validate(req, {
      protocol: { type: 'array', required: true },
      client: { type: 'string', required: true },
      client_version: { type: 'string', required: true }
    })
    if (err) return fail(err)
    const protocol = req.args.protocol as unknown[]
    const badProtocol = (why: string): ErrorBody =>
      error('bad_request', `protocol must be ${why}`, { field: 'protocol' })
    if (protocol.length < 1 || protocol.length > 8) return fail(badProtocol('1 to 8 versions'))
    for (let i = 0; i < protocol.length; i++) {
      const v = protocol[i]
      if (
        !isIntegerLiteral(req.sources, protocol, String(i)) ||
        (v as number) < 1 ||
        (v as number) > 1000
      ) {
        return fail(badProtocol('integers between 1 and 1000'))
      }
    }
    if (new Set(protocol).size !== protocol.length) return fail(badProtocol('without duplicates'))
    if (!CLIENT_RE.test(req.args.client as string)) {
      return fail(
        error('bad_request', 'client must match ^[A-Za-z0-9._-]{1,32}$', { field: 'client' })
      )
    }
    if (!CLIENT_VERSION_RE.test(req.args.client_version as string)) {
      return fail(
        error('bad_request', 'client_version must match ^[A-Za-z0-9._+-]{1,32}$', {
          field: 'client_version'
        })
      )
    }
    const common = (protocol as number[]).filter((v) => this.supportedProtocols.includes(v))
    if (!common.length) {
      return fail(
        error(
          'version_unsupported',
          `no common protocol version; helper supports ${this.supportedProtocols.join(', ')}`,
          { supported: [...this.supportedProtocols] }
        )
      )
    }
    if (this.sessionConn) {
      return fail(
        error('busy', 'another client session is active', { session_pid: this.clientPid })
      )
    }
    // Section 5.2: this connection becomes the session.
    this.pending.delete(conn)
    if (conn.helloTimer) this.clock.clearTimeout(conn.helloTimer)
    conn.helloTimer = null
    const now = this.clock.now()
    conn.session = {
      number: ++this.sessionCounter,
      seq: 0,
      dropped: 0,
      subscription: null,
      statsPending: false,
      logWindowStart: now,
      logWindowCount: 0
    }
    this.sessionConn = conn
    const result: HelloResult = {
      protocol: Math.max(...common),
      helper_version: this.helperVersion,
      os: this.os,
      arch: this.arch,
      pid: this.pid,
      instance: this.instance,
      session: conn.session.number,
      auth: this.auth,
      capabilities: [...this.capabilities],
      limits: LIMITS,
      capture: { ...this.capture }
    }
    this.respond(conn, req, result)
    // Section 8.3: one state event right after a successful hello.
    this.lastStateKey = this.stateKey()
    this.emitEvent(conn, 'state', this.stateInfo(this.clock.now()), false)
    this.emit('session', conn.session.number)
  }

  private subscribe(conn: Connection, req: QueuedRequest): void {
    const err = this.validate(req, { interval_ms: { type: 'integer', required: false } })
    if (err) return this.respond(conn, req, err)
    const { min, max } = LIMITS.stats_interval_ms
    const interval =
      (req.args.interval_ms as number | undefined) ?? LIMITS.stats_interval_ms.default
    if (interval < min || interval > max) {
      return this.respond(
        conn,
        req,
        error('out_of_range', `interval_ms must be between ${min} and ${max}`, {
          field: 'interval_ms',
          min,
          max
        })
      )
    }
    this.afterScript(req.cmd, () => {
      const s = conn.session
      if (!s) return
      if (s.subscription?.timer) this.clock.clearTimeout(s.subscription.timer)
      s.subscription = { intervalMs: interval, nextDue: this.clock.now() + interval, timer: null }
      this.scheduleTick(conn)
      this.respond(conn, req, { interval_ms: interval })
      // Section 7.3: the first stats event follows the response immediately.
      this.emitStats(conn)
    })
  }

  private stopSubscription(conn: Connection): void {
    const s = conn.session
    if (!s?.subscription) return
    if (s.subscription.timer) this.clock.clearTimeout(s.subscription.timer)
    s.subscription = null
    s.statsPending = false
  }

  private scheduleTick(conn: Connection): void {
    const sub = conn.session?.subscription
    if (!sub) return
    sub.timer = this.clock.setTimeout(
      () => {
        const s = conn.session
        if (!s?.subscription || s.subscription !== sub) return
        sub.nextDue += sub.intervalMs
        // A tick that falls due while a command runs is delivered after that command's response
        // (Appendix B: the stats event after `on` carries state "on"). One is kept, like Go's
        // time.Ticker channel.
        if (conn.executing) s.statsPending = true
        else this.emitStats(conn)
        this.scheduleTick(conn)
      },
      Math.max(0, sub.nextDue - this.clock.now())
    )
  }

  private cmdOn(conn: Connection, req: QueuedRequest): void {
    const err = this.validate(req, {})
    if (err) return this.respond(conn, req, err)
    if (!this.capture.available) {
      return this.respond(
        conn,
        req,
        error('unsupported_platform', `capture is not available: ${this.capture.error}`, {
          error: this.capture.error
        })
      )
    }
    if (!this.adapters.some((a) => a.present !== false && !this.excluded.has(a.name))) {
      return this.respond(conn, req, error('no_adapters', 'no adapter is present and not excluded'))
    }
    if (this.routesOn) return this.respond(conn, req, { state: 'on' })
    // Section 7.5: userSet(true, usable), then tun.On with a `starting` event before it.
    this.manualOff = false
    this.waiting = false
    this.held = this.usableCount() < 2
    this.lastError = null
    this.onInProgress = true
    this.refreshState()
    this.afterScript('on', () => {
      this.onInProgress = false
      if (this.onFailure) {
        this.lastError = { message: this.onFailure }
        this.refreshState()
        this.respond(conn, req, error('internal', this.onFailure))
        return
      }
      this.routesOn = true
      this.tun = { name: this.tunName, open: true }
      this.refreshState()
      this.respond(conn, req, { state: 'on' })
    })
  }

  private cmdOff(conn: Connection, req: QueuedRequest): void {
    const err = this.validate(req, {})
    if (err) return this.respond(conn, req, err)
    this.afterScript('off', () => {
      this.routesOn = false
      this.manualOff = true
      this.waiting = false
      this.held = false
      this.lastError = null
      if (!this.keepsDevice()) this.tun = { name: null, open: false }
      this.refreshState()
      this.respond(conn, req, { state: 'off' })
    })
  }

  private setIpv6(conn: Connection, req: QueuedRequest): void {
    const err = this.validate(req, { mode: { type: 'string', required: true } })
    if (err) return this.respond(conn, req, err)
    const mode = req.args.mode as string
    if (mode !== 'auto' && mode !== 'on' && mode !== 'off') {
      return this.respond(
        conn,
        req,
        error('bad_request', 'mode must be one of auto, on, off', { field: 'mode' })
      )
    }
    this.ipv6Mode = mode
    this.refreshState()
    this.respond(conn, req, { mode, effective: this.ipv6Effective() })
  }

  private setAutopause(conn: Connection, req: QueuedRequest): void {
    const err = this.validate(req, { enabled: { type: 'boolean', required: true } })
    if (err) return this.respond(conn, req, err)
    const enabled = req.args.enabled as boolean
    if (enabled !== this.autopauseEnabled) {
      this.autopauseEnabled = enabled
      // Section 7.8: enabling while off and not manually off makes it wait (paused_auto).
      if (enabled && !this.routesOn && !this.manualOff) this.waiting = true
      this.refreshState()
    }
    this.respond(conn, req, { enabled, status: this.autopauseStatus() })
  }

  private excludeInclude(conn: Connection, req: QueuedRequest, exclude: boolean): void {
    const err = this.validate(req, { adapter: { type: 'string', required: true } })
    if (err) return this.respond(conn, req, err)
    const name = req.args.adapter as string
    if (!validName(name)) {
      return this.respond(
        conn,
        req,
        error('bad_request', 'adapter must be 1 to 256 bytes without control characters', {
          field: 'adapter'
        })
      )
    }
    const discovered =
      this.adapters.some((a) => a.present !== false && a.name === name) ||
      this.skipped.some((s) => s.name === name)
    if (!discovered && !this.excluded.has(name)) {
      return this.respond(
        conn,
        req,
        error('unknown_adapter', `no adapter named ${JSON.stringify(name)}`, { adapter: name })
      )
    }
    if (exclude) this.excluded.add(name)
    else this.excluded.delete(name)
    this.adaptersChanged()
    this.respond(conn, req, { adapter: name, excluded: exclude })
  }

  private setWeight(conn: Connection, req: QueuedRequest): void {
    const err = this.validate(req, {
      adapter: { type: 'string', required: true },
      weight: { type: 'weight', required: true }
    })
    if (err) return this.respond(conn, req, err)
    const name = req.args.adapter as string
    const weight = req.args.weight as number | 'auto'
    const { min, max } = LIMITS.weight
    if (typeof weight === 'number' && (!Number.isFinite(weight) || weight < min || weight > max)) {
      return this.respond(
        conn,
        req,
        error('out_of_range', `weight must be between ${min} and ${max}`, {
          field: 'weight',
          min,
          max
        })
      )
    }
    if (!validName(name)) {
      return this.respond(
        conn,
        req,
        error('bad_request', 'adapter must be 1 to 256 bytes without control characters', {
          field: 'adapter'
        })
      )
    }
    const spec = this.adapters.find((a) => a.present !== false && a.name === name)
    if (!spec && !this.weights.has(name)) {
      return this.respond(
        conn,
        req,
        error('unknown_adapter', `no adapter named ${JSON.stringify(name)}`, { adapter: name })
      )
    }
    if (weight === 'auto') {
      this.weights.delete(name)
      const auto = spec ? this.adapterRow(spec, this.clock.now()).weight : 1
      this.respond(conn, req, { adapter: name, weight_mode: 'auto', weight: auto })
    } else {
      this.weights.set(name, weight)
      this.respond(conn, req, { adapter: name, weight_mode: 'manual', weight })
    }
  }

  private listAdapters(): object {
    const present = this.adapters.filter((a) => a.present !== false)
    const result: Record<string, unknown> = {
      discovery_seq: this.discoverySeq,
      adapters: present.slice(0, MAX_ADAPTERS).map((a) => ({
        name: a.name,
        index: a.index,
        ip: a.ip,
        ip6: a.ip6,
        excluded: this.excluded.has(a.name),
        weight_mode: this.weights.has(a.name) ? 'manual' : 'auto',
        description: a.description ?? null
      })),
      skipped: this.skipped.slice(0, MAX_ADAPTERS).map((s) => ({ ...s }))
    }
    if (present.length > MAX_ADAPTERS || this.skipped.length > MAX_ADAPTERS) result.truncated = true
    return result
  }

  private cleanup(conn: Connection, req: QueuedRequest): void {
    const err = this.validate(req, {})
    if (err) return this.respond(conn, req, err)
    if (this.currentState !== 'off' && this.currentState !== 'error') {
      return this.respond(
        conn,
        req,
        error('invalid_state', 'cleanup is only allowed while off', { state: this.currentState })
      )
    }
    this.afterScript('cleanup', () => {
      if (this.cleanupFailure)
        return this.respond(conn, req, error('internal', this.cleanupFailure))
      this.respond(conn, req, {})
    })
  }

  private quit(conn: Connection, req: QueuedRequest): void {
    const err = this.validate(req, {})
    if (err) return this.respond(conn, req, err)
    this.afterScript('quit', () => {
      // Appendix B: the `off` state event precedes the quit response, then EOF (10.4).
      this.quitting = true
      this.routesOn = false
      this.onInProgress = false
      this.manualOff = true
      this.waiting = false
      this.held = false
      this.lastError = null
      this.tun = { name: null, open: false }
      this.refreshState()
      this.respond(conn, req, {})
      this.shutdown(0, 'quit')
    })
  }

  // ---- State derivation (sections 8 and 10.1) ----------------------------------------------

  private keepsDevice(): boolean {
    return this.capabilities.includes('keep_adapter_on_off')
  }

  private deriveState(): MergeState {
    if (this.onInProgress) return 'starting'
    if (this.routesOn) return 'on'
    if (this.lastError) return 'error'
    if (this.autopauseEnabled && this.waiting && !this.manualOff) return 'paused_auto'
    return 'off'
  }

  private autopauseStatus(): AutopauseStatus {
    if (!this.autopauseEnabled) return 'disabled'
    if (this.routesOn) return this.held ? 'held' : 'armed'
    if (this.manualOff) return 'manual_off'
    if (this.waiting) return 'waiting'
    return 'idle'
  }

  private usableCount(): number {
    return this.adapters.filter(
      (a) =>
        a.present !== false && !this.excluded.has(a.name) && (a.state === 'up' || a.state6 === 'up')
    ).length
  }

  private coversAll(): boolean {
    if (this.ipv6CoversAll !== 'derive') return this.ipv6CoversAll
    const usable4 = this.adapters.filter(
      (a) => a.present !== false && !this.excluded.has(a.name) && a.state === 'up'
    )
    return usable4.length > 0 && usable4.every((a) => a.state6 === 'up')
  }

  private ipv6Effective(): 'balanced' | 'refused' {
    if (this.ipv6Mode === 'on') return 'balanced'
    if (this.ipv6Mode === 'off') return 'refused'
    return this.coversAll() ? 'balanced' : 'refused'
  }

  private ipv6Detail(): string {
    switch (this.ipv6Mode) {
      case 'auto':
        return this.coversAll()
          ? 'auto: balanced, every adapter has IPv6'
          : 'auto: refused, apps fall back to IPv4 so every adapter is used (not every adapter has IPv6)'
      case 'on':
        return 'on: IPv6 balanced across the adapters that have it'
      case 'off':
        return 'off: IPv6 refused, apps fall back to IPv4'
    }
  }

  private stateInfo(ts: number): StateInfo {
    return {
      ts,
      state: this.currentState,
      state_since: this.stateSince,
      error: this.currentState === 'error' && this.lastError ? { ...this.lastError } : null,
      capture: { ...this.capture },
      autopause: { enabled: this.autopauseEnabled, status: this.autopauseStatus() },
      ipv6: { mode: this.ipv6Mode, effective: this.ipv6Effective(), detail: this.ipv6Detail() },
      tun: { ...this.tun }
    }
  }

  /** The fields whose change produces a `state` event (section 8.1). */
  private stateKey(): string {
    const i = this.stateInfo(0)
    return JSON.stringify([
      i.state,
      i.error,
      i.capture,
      i.autopause.status,
      i.ipv6.effective,
      i.tun
    ])
  }

  private adaptersChanged(): void {
    // Section 7.5: held until two usable adapters have been seen at the same time.
    if (this.routesOn && this.held && this.usableCount() >= 2) this.held = false
    this.refreshState()
  }

  /** Re-derives the state after any mutation and emits a `state` event if it changed. */
  private refreshState(): void {
    const derived = this.deriveState()
    if (derived !== this.currentState) {
      this.currentState = derived
      this.stateSince = this.clock.now()
    }
    const key = this.stateKey()
    if (key === this.lastStateKey) return
    this.lastStateKey = key
    const conn = this.sessionConn
    if (conn?.session) this.emitEvent(conn, 'state', this.stateInfo(this.clock.now()), false)
  }

  private adapterRow(a: AdapterSpec, ts: number): Adapter {
    const excluded = this.excluded.has(a.name)
    const sample: Partial<AdapterCounters> = this.sampler({
      tick: this.tick,
      ts,
      adapter: a,
      state: this.currentState,
      excluded
    })
    const n = (v: number | undefined): number => Math.trunc(v ?? 0)
    const manual = this.weights.get(a.name)
    // Section 8.2: an excluded adapter keeps its link rates; everything else is 0 and `none`.
    const weight = manual ?? (excluded ? 0 : (sample.weight ?? 1))
    const weight6 = manual ?? (excluded ? 0 : (sample.weight6 ?? 1))
    return {
      name: a.name,
      ip: a.ip,
      ip6: a.ip6,
      present: a.present !== false,
      excluded,
      state: excluded ? 'none' : a.state,
      state6: excluded ? 'none' : a.state6,
      weight,
      weight6,
      weight_mode: manual !== undefined ? 'manual' : 'auto',
      peak_bps: excluded ? 0 : n(sample.peak_bps),
      peak6_bps: excluded ? 0 : n(sample.peak6_bps),
      active_flows: excluded ? 0 : n(sample.active_flows),
      total_flows: excluded ? 0 : n(sample.total_flows),
      failed_flows: excluded ? 0 : n(sample.failed_flows),
      link_in_bps: n(sample.link_in_bps),
      link_out_bps: n(sample.link_out_bps),
      relayed_in_bps: excluded ? 0 : n(sample.relayed_in_bps),
      relayed_out_bps: excluded ? 0 : n(sample.relayed_out_bps),
      bytes_in: excluded ? 0 : n(sample.bytes_in),
      bytes_out: excluded ? 0 : n(sample.bytes_out)
    }
  }

  private snapshot(ts: number): Snapshot {
    const rows = this.adapters.map((a) => this.adapterRow(a, ts))
    const present = rows.filter((r) => r.present)
    const totals: Totals = {
      link_in_bps: 0,
      link_out_bps: 0,
      relayed_in_bps: 0,
      relayed_out_bps: 0,
      active_flows: 0,
      adapters_present: present.length,
      adapters_usable: present.filter((r) => r.state === 'up' || r.state6 === 'up').length
    }
    for (const r of present) {
      totals.link_in_bps += r.link_in_bps
      totals.link_out_bps += r.link_out_bps
      totals.relayed_in_bps += r.relayed_in_bps
      totals.relayed_out_bps += r.relayed_out_bps
      totals.active_flows += r.active_flows
    }
    return {
      ...this.stateInfo(ts),
      totals,
      adapters: rows.slice(0, MAX_ADAPTERS),
      discovery_seq: this.discoverySeq
    }
  }

  private statusResult(): object {
    return {
      ...this.snapshot(this.clock.now()),
      skipped: this.skipped.slice(0, MAX_ADAPTERS).map((s) => ({ ...s }))
    }
  }

  private emitStats(conn: Connection): void {
    const s = conn.session
    if (!s?.subscription) return
    const data = { ...this.snapshot(this.clock.now()), dropped: s.dropped }
    this.tick++
    this.emitEvent(conn, 'stats', data, true)
  }

  /** Writes an event with the next `seq`; droppable events are dropped while the client stalls. */
  private emitEvent(conn: Connection, event: string, data: object, droppable: boolean): void {
    const s = conn.session
    if (!s) return
    s.seq++
    if (droppable && conn.needDrain) {
      s.dropped++
      return
    }
    this.write(conn, { event, seq: s.seq, data })
  }

  private waitFor(predicate: () => boolean, event: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (predicate()) return resolve()
      const timer = setTimeout(() => {
        this.off(event, handler)
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${event}`))
      }, timeoutMs)
      const handler = (): void => {
        if (!predicate()) return
        clearTimeout(timer)
        this.off(event, handler)
        resolve()
      }
      this.on(event, handler)
    })
  }
}

function unknownField(field: string): ErrorBody {
  return error('unknown_field', `unknown field ${JSON.stringify(field)}`, { field })
}

/** Creates the fake and listens on `options.path`. */
export async function startFakeNetd(options: FakeNetdOptions): Promise<FakeNetd> {
  return new FakeNetd(options).start()
}
