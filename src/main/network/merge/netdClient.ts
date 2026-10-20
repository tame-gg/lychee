import { EventEmitter } from 'node:events'
import { connect as connectSocket, type Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  CLIENT_NAME,
  COMMAND_TIMEOUT_MS,
  DEFAULT_LIMITS,
  LONG_COMMANDS,
  LONG_COMMAND_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type Cmd,
  type ErrorCode,
  type HelloResult,
  type Limits,
  type LogEntry,
  type StateInfo,
  type StatsData
} from './protocol'

export type CloseReason = 'eof' | 'error' | 'protocol' | 'timeout' | 'local' | 'quit'

export class NetdError extends Error {
  readonly code: ErrorCode
  readonly data: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, data?: Record<string, unknown>) {
    super(message)
    this.name = 'NetdError'
    this.code = code
    this.data = data
  }
}

export class ConnectionClosedError extends Error {
  readonly reason: CloseReason

  constructor(reason: CloseReason, detail: string) {
    super(detail)
    this.name = 'ConnectionClosedError'
    this.reason = reason
  }
}

export type SocketFactory = (path: string) => Socket

export interface NetdClientOptions {
  path: string
  clientVersion: string
  connect?: SocketFactory
  connectTimeoutMs?: number
  commandTimeoutMs?: number
  longCommandTimeoutMs?: number
  log?: (line: string) => void
}

export interface NetdClientEvents {
  state: [StateInfo]
  stats: [StatsData]
  log: [LogEntry]
  close: [ConnectionClosedError]
}

interface Pending {
  id: number
  cmd: Cmd
  args: object | undefined
  resolve: (result: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function sanitizeLimits(raw: unknown): Limits {
  const limits = isRecord(raw) ? raw : {}
  const interval = isRecord(limits.stats_interval_ms) ? limits.stats_interval_ms : {}
  const weight = isRecord(limits.weight) ? limits.weight : {}
  return {
    max_frame: positive(limits.max_frame, DEFAULT_LIMITS.max_frame),
    max_in_flight: positive(limits.max_in_flight, DEFAULT_LIMITS.max_in_flight),
    hello_timeout_ms: positive(limits.hello_timeout_ms, DEFAULT_LIMITS.hello_timeout_ms),
    grace_ms: positive(limits.grace_ms, DEFAULT_LIMITS.grace_ms),
    startup_timeout_ms: positive(limits.startup_timeout_ms, DEFAULT_LIMITS.startup_timeout_ms),
    stats_interval_ms: {
      min: positive(interval.min, DEFAULT_LIMITS.stats_interval_ms.min),
      max: positive(interval.max, DEFAULT_LIMITS.stats_interval_ms.max),
      default: positive(interval.default, DEFAULT_LIMITS.stats_interval_ms.default)
    },
    weight: {
      min: positive(weight.min, DEFAULT_LIMITS.weight.min),
      max: positive(weight.max, DEFAULT_LIMITS.weight.max)
    }
  }
}

export class NetdClient extends EventEmitter<NetdClientEvents> {
  static connect(options: NetdClientOptions): Promise<NetdClient> {
    return new Promise((resolve, reject) => {
      const socket = (options.connect ?? connectSocket)(options.path)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`connecting to ${options.path} timed out`))
      }, options.connectTimeoutMs ?? 5000)
      const onError = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.off('error', onError)
        resolve(new NetdClient(socket, options))
      })
    })
  }

  readonly path: string
  lastState: StateInfo | null = null
  private readonly socket: Socket
  private readonly clientVersion: string
  private readonly commandTimeoutMs: number
  private readonly longCommandTimeoutMs: number
  private readonly log: (line: string) => void
  private helloResult: HelloResult | null = null
  private currentLimits: Limits = DEFAULT_LIMITS
  private buffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly queue: Pending[] = []
  private readonly inFlight = new Map<number, Pending>()
  private lastSeq = 0
  private quitting = false
  private closedWith: ConnectionClosedError | null = null

  private constructor(socket: Socket, options: NetdClientOptions) {
    super()
    this.socket = socket
    this.path = options.path
    this.clientVersion = options.clientVersion
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS
    this.longCommandTimeoutMs = options.longCommandTimeoutMs ?? LONG_COMMAND_TIMEOUT_MS
    this.log = options.log ?? ((): void => {})
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('end', () => this.fail('eof', 'the network helper closed the connection'))
    socket.on('error', (error: Error) => this.fail('error', error.message))
    socket.on('close', () => this.fail('eof', 'the network helper closed the connection'))
  }

  get hello(): HelloResult | null {
    return this.helloResult
  }

  get limits(): Limits {
    return this.currentLimits
  }

  get closed(): boolean {
    return this.closedWith !== null
  }

  get closeError(): ConnectionClosedError | null {
    return this.closedWith
  }

  get unanswered(): number {
    return this.inFlight.size + this.queue.length
  }

  async handshake(): Promise<HelloResult> {
    const result = await this.request<HelloResult>('hello', {
      protocol: [PROTOCOL_VERSION],
      client: CLIENT_NAME,
      client_version: this.clientVersion
    })
    if (
      result.protocol !== PROTOCOL_VERSION ||
      typeof result.helper_version !== 'string' ||
      typeof result.instance !== 'string'
    ) {
      this.fail('protocol', 'the network helper answered hello with an unexpected result')
      throw this.closedWith
    }
    this.currentLimits = sanitizeLimits(result.limits)
    this.helloResult = { ...result, limits: this.currentLimits }
    return this.helloResult
  }

  request<T extends object = Record<string, unknown>>(cmd: Cmd, args?: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closedWith) return reject(this.closedWith)
      this.queue.push({
        id: this.nextId++,
        cmd,
        args,
        resolve: resolve as (result: Record<string, unknown>) => void,
        reject,
        timer: null
      })
      this.pump()
    })
  }

  async quit(timeoutMs = 1000): Promise<boolean> {
    if (this.closedWith) return true
    this.quitting = true
    const deadline = Date.now() + timeoutMs
    const closed = new Promise<void>((resolve) => this.once('close', () => resolve()))
    const answered = this.request('quit').then(
      () => undefined,
      () => undefined
    )
    await Promise.race([answered, sleep(timeoutMs)])
    await Promise.race([closed, sleep(Math.max(0, deadline - Date.now()))])
    if (this.closedWith) return true
    this.fail('local', 'the network helper did not close after quit')
    return false
  }

  close(): void {
    this.fail('local', 'the connection was closed')
  }

  private pump(): void {
    while (
      !this.closedWith &&
      this.inFlight.size < this.currentLimits.max_in_flight &&
      this.queue.length > 0
    ) {
      const pending = this.queue.shift()!
      const frame =
        pending.args === undefined
          ? { id: pending.id, cmd: pending.cmd }
          : { id: pending.id, cmd: pending.cmd, args: pending.args }
      this.inFlight.set(pending.id, pending)
      const timeout = LONG_COMMANDS.has(pending.cmd)
        ? this.longCommandTimeoutMs
        : this.commandTimeoutMs
      pending.timer = setTimeout(
        () =>
          this.fail(
            'timeout',
            `the network helper did not answer ${pending.cmd} within ${timeout} ms`
          ),
        timeout
      )
      this.socket.write(JSON.stringify(frame) + '\n')
    }
  }

  private onData(chunk: Buffer): void {
    if (this.closedWith) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline === -1) {
        if (this.buffer.length > this.currentLimits.max_frame - 1) {
          this.fail('protocol', 'a frame from the network helper exceeds the size limit')
        }
        return
      }
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.length === 0) continue
      if (line.length > this.currentLimits.max_frame - 1) {
        return this.fail('protocol', 'a frame from the network helper exceeds the size limit')
      }
      let frame: unknown
      try {
        frame = JSON.parse(line.toString('utf8'))
      } catch {
        return this.fail('protocol', 'a frame from the network helper is not valid JSON')
      }
      if (!isRecord(frame)) {
        return this.fail('protocol', 'a frame from the network helper is not an object')
      }
      this.onFrame(frame)
      if (this.closedWith) return
    }
  }

  private onFrame(frame: Record<string, unknown>): void {
    if (typeof frame.event === 'string') {
      if (typeof frame.seq !== 'number' || !isRecord(frame.data)) {
        return this.fail('protocol', 'an event from the network helper is malformed')
      }
      return this.onEvent(frame.event, frame.seq, frame.data)
    }
    if (frame.ok === true) {
      if (typeof frame.id !== 'number' || !isRecord(frame.result)) {
        return this.fail('protocol', 'a response from the network helper is malformed')
      }
      const pending = this.take(frame.id)
      if (!pending) return this.log(`unexpected response to request ${frame.id}`)
      pending.resolve(frame.result)
      return
    }
    if (frame.ok === false) {
      const body = frame.error
      if (!isRecord(body) || typeof body.code !== 'string' || typeof body.message !== 'string') {
        return this.fail('protocol', 'an error from the network helper is malformed')
      }
      const error = new NetdError(
        body.code,
        body.message,
        isRecord(body.data) ? body.data : undefined
      )
      if (frame.id === null) {
        this.log(`the network helper rejected a frame: ${error.code}: ${error.message}`)
        return this.fail('protocol', `${error.code}: ${error.message}`)
      }
      if (typeof frame.id !== 'number') {
        return this.fail('protocol', 'an error from the network helper is malformed')
      }
      const pending = this.take(frame.id)
      if (!pending) return this.log(`unexpected error for request ${frame.id}: ${error.code}`)
      pending.reject(error)
      return
    }
    this.fail('protocol', 'a frame from the network helper is neither a response nor an event')
  }

  private onEvent(event: string, seq: number, data: Record<string, unknown>): void {
    if (seq > this.lastSeq + 1 && this.lastSeq > 0) {
      this.log(`${seq - this.lastSeq - 1} event(s) missing before seq ${seq}`)
    }
    this.lastSeq = Math.max(this.lastSeq, seq)
    switch (event) {
      case 'state': {
        if (typeof data.state !== 'string') {
          return this.fail('protocol', 'a state event from the network helper is malformed')
        }
        const info = data as unknown as StateInfo
        this.lastState = info
        this.emit('state', info)
        return
      }
      case 'stats':
        if (typeof data.state !== 'string' || !Array.isArray(data.adapters)) {
          return this.fail('protocol', 'a stats event from the network helper is malformed')
        }
        this.emit('stats', data as unknown as StatsData)
        return
      case 'log':
        if (typeof data.level === 'string' && typeof data.message === 'string') {
          this.emit('log', { level: data.level, message: data.message })
        }
        return
      default:
        return
    }
  }

  private take(id: number): Pending | undefined {
    const pending = this.inFlight.get(id)
    if (!pending) return undefined
    this.inFlight.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    queueMicrotask(() => this.pump())
    return pending
  }

  private fail(reason: CloseReason, detail: string): void {
    if (this.closedWith) return
    const error = new ConnectionClosedError(
      this.quitting && reason === 'eof' ? 'quit' : reason,
      detail
    )
    this.closedWith = error
    this.buffer = Buffer.alloc(0)
    const pending = [...this.inFlight.values(), ...this.queue]
    this.inFlight.clear()
    this.queue.length = 0
    for (const request of pending) {
      if (request.timer) clearTimeout(request.timer)
      request.reject(error)
    }
    this.socket.destroy()
    this.emit('close', error)
  }
}
