import { setTimeout as sleep } from 'node:timers/promises'
import {
  DEFAULT_MERGE_SETTINGS,
  validAdapterName,
  validWeight
} from '../../../shared/mergeSettings'
import {
  MERGE_HISTORY_SECONDS,
  type MergeOptionsPatch,
  type MergeSettings,
  type MergeSkipped,
  type MergeState,
  type MergeStatus
} from '../../../shared/types'
import { ADMIN_ACCOUNT_MESSAGE, exitStatus, type HelperProcess, type Launcher } from './elevate'
import { ConnectionClosedError, NetdClient, NetdError, type SocketFactory } from './netdClient'
import {
  DEFAULT_LIMITS,
  type Cmd,
  type HelloResult,
  type Limits,
  type Snapshot,
  type StateInfo,
  type StatsData,
  type StatusResult
} from './protocol'

export interface MergeSettingsStore {
  load(): Promise<MergeSettings>
  save(settings: MergeSettings): Promise<void>
}

export interface MergeTiming {
  connectRetryMs: number
  connectTimeoutMs: number
  reconnectEveryMs: number
  graceMs: number | null
  pushEveryMs: number
  quitTimeoutMs: number
  commandTimeoutMs: number
  longCommandTimeoutMs: number
}

export const DEFAULT_MERGE_TIMING: MergeTiming = {
  connectRetryMs: 250,
  connectTimeoutMs: 30000,
  reconnectEveryMs: 500,
  graceMs: null,
  pushEveryMs: 1000,
  quitTimeoutMs: 1000,
  commandTimeoutMs: 5000,
  longCommandTimeoutMs: 45000
}

export interface MergeControllerOptions {
  launcher: Launcher
  version: string
  settings: MergeSettingsStore
  push: (state: MergeState) => void
  log?: (line: string) => void
  connect?: SocketFactory
  platform?: NodeJS.Platform
  timing?: Partial<MergeTiming>
}

export const NO_ADAPTERS_MESSAGE = 'No network connection is available to combine'
export const STOPPED_MESSAGE = 'The network helper stopped unexpectedly'
export const RECONNECTING_MESSAGE = 'Reconnecting to the network helper'
export const BUSY_MESSAGE = 'Another Lychee is already using the network helper'

type CommandFailure = { status: 'error' | 'unsupported' | 'needs_permission'; message: string }

type Established =
  | { kind: 'ok'; client: NetdClient; fresh: boolean }
  | { kind: 'retry'; message: string }
  | { kind: 'fatal' }

const STATS_INTERVAL_MS = 1000

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MergeController {
  private readonly options: MergeControllerOptions
  private readonly timing: MergeTiming
  private readonly platform: NodeJS.Platform
  private readonly log: (line: string) => void
  private settings: MergeSettings = { ...DEFAULT_MERGE_SETTINGS }
  private status: MergeStatus = 'off'
  private message: string | null = null
  private commandFailure: CommandFailure | null = null
  private helper: HelperProcess | null = null
  private controlPath: string | null = null
  private verify: (() => Promise<void>) | null = null
  private client: NetdClient | null = null
  private hello: HelloResult | null = null
  private limits: Limits = DEFAULT_LIMITS
  private lastInstance: string | null = null
  private helperState: StateInfo | null = null
  private snapshot: Snapshot | null = null
  private skipped: MergeSkipped[] = []
  private lastDiscoverySeq: number | null = null
  private readonly history = { down: new Map<string, number[]>(), up: new Map<string, number[]>() }
  private seq = 0
  private pushTimer: NodeJS.Timeout | null = null
  private lastPushAt = 0
  private gate: Promise<NetdClient | null> | null = null
  private pendingOn = 0
  private refreshing = false
  private sessionReady = false
  private shuttingDown = false
  private readonly reapplying = new Set<string>()

  constructor(options: MergeControllerOptions) {
    this.options = options
    this.timing = { ...DEFAULT_MERGE_TIMING, ...options.timing }
    this.platform = options.platform ?? process.platform
    this.log = options.log ?? ((): void => {})
  }

  async start(): Promise<void> {
    try {
      this.settings = await this.options.settings.load()
    } catch (error) {
      this.log(`cannot load the merge settings: ${describe(error)}`)
    }
    this.pushSoon(true)
    if (this.settings.enabled) await this.enable()
  }

  state(): MergeState {
    const hello = this.hello
    const snapshot = this.snapshot
    const info = this.helperState ?? snapshot
    return {
      seq: this.seq,
      status: this.status,
      message: this.message,
      settings: {
        ...this.settings,
        excluded: [...this.settings.excluded],
        weights: { ...this.settings.weights }
      },
      helper: hello
        ? {
            version: hello.helper_version,
            pid: hello.pid,
            os: hello.os,
            arch: hello.arch,
            instance: hello.instance,
            capabilities: Array.isArray(hello.capabilities) ? [...hello.capabilities] : []
          }
        : null,
      helperState: info?.state ?? null,
      capture: info?.capture ?? hello?.capture ?? null,
      autopause: info?.autopause ?? null,
      ipv6: info?.ipv6 ?? null,
      tun: info?.tun ?? null,
      stateSince: info?.state_since ?? null,
      totals: snapshot?.totals ?? null,
      adapters: snapshot?.adapters ?? [],
      skipped: this.skipped,
      discoverySeq: snapshot?.discovery_seq ?? 0,
      history: {
        down: Object.fromEntries(
          [...this.history.down].map(([name, series]) => [name, [...series]])
        ),
        up: Object.fromEntries([...this.history.up].map(([name, series]) => [name, [...series]]))
      }
    }
  }

  pushState(): void {
    this.pushSoon(true)
  }

  async setMerging(on: boolean): Promise<void> {
    if (this.shuttingDown) return
    await this.saveSettings({ ...this.settings, enabled: on })
    if (on) await this.enable()
    else await this.disable()
  }

  async setOptions(patch: MergeOptionsPatch): Promise<void> {
    const next = { ...this.settings }
    const ipv6 = patch.ipv6
    if (ipv6 !== undefined) {
      if (ipv6 !== 'auto' && ipv6 !== 'on' && ipv6 !== 'off') throw new Error('Unknown IPv6 mode')
      next.ipv6 = ipv6
    }
    if (patch.autoPause !== undefined) next.autoPause = patch.autoPause === true
    await this.saveSettings(next)
    const client = this.session()
    if (!client) return
    if (ipv6 !== undefined) await this.send(client, 'set_ipv6', { mode: next.ipv6 })
    if (patch.autoPause !== undefined) {
      await this.send(client, 'set_autopause', { enabled: next.autoPause })
    }
  }

  async setNetwork(id: string, enabled: boolean): Promise<void> {
    if (!validAdapterName(id)) throw new Error('Unknown network')
    const excluded = this.settings.excluded.filter((name) => name !== id)
    if (!enabled) excluded.push(id)
    await this.saveSettings({ ...this.settings, excluded })
    const client = this.session()
    if (!client) return
    await this.send(client, enabled ? 'include' : 'exclude', { adapter: id })
  }

  async setWeight(id: string, weight: number | 'auto'): Promise<void> {
    if (!validAdapterName(id)) throw new Error('Unknown network')
    if (weight !== 'auto' && !validWeight(weight)) throw new Error('Weight out of range')
    const weights = { ...this.settings.weights }
    if (weight === 'auto') delete weights[id]
    else weights[id] = weight
    await this.saveSettings({ ...this.settings, weights })
    const client = this.session()
    if (!client) return
    await this.send(client, 'set_weight', { adapter: id, weight })
  }

  async repair(): Promise<void> {
    const client = await this.ensureSession()
    if (!client) throw new Error(this.message ?? 'The network helper is not available')
    try {
      await client.request('cleanup')
    } catch (error) {
      throw new Error(error instanceof NetdError ? error.message : describe(error))
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
    const client = this.client
    const helper = this.helper
    this.client = null
    if (client && !client.closed) await client.quit(this.timing.quitTimeoutMs)
    if (helper && !helper.exit) {
      const exit = await Promise.race([
        helper.exited,
        sleep(Math.min(200, this.timing.quitTimeoutMs)).then(() => null)
      ])
      if (!exit) helper.kill()
    }
  }

  private session(): NetdClient | null {
    return this.client?.hello && !this.client.closed ? this.client : null
  }

  private async enable(): Promise<void> {
    this.commandFailure = null
    this.pendingOn++
    try {
      const client = await this.ensureSession()
      if (client && this.settings.enabled && !this.shuttingDown) await this.turnOn(client)
    } finally {
      this.pendingOn--
      this.refreshStatus()
    }
  }

  private async disable(): Promise<void> {
    this.commandFailure = null
    const client = this.session()
    if (!client) {
      if (!this.gate) this.setStatus('off', null)
      return
    }
    try {
      await client.request('off')
    } catch (error) {
      this.commandFailed(error, 'off')
    }
    this.refreshStatus()
  }

  private async turnOn(client: NetdClient): Promise<void> {
    try {
      await client.request('on')
    } catch (error) {
      this.commandFailed(error, 'on')
    }
  }

  private ensureSession(): Promise<NetdClient | null> {
    const current = this.session()
    if (current) return Promise.resolve(current)
    if (!this.gate) {
      const gate: Promise<NetdClient | null> = this.openSession().finally(() => {
        if (this.gate === gate) this.gate = null
      })
      this.gate = gate
    }
    return this.gate
  }

  private async openSession(): Promise<NetdClient | null> {
    if (this.shuttingDown) return null
    this.setStatus('starting', null)
    let helper = this.helper
    if (!helper || helper.exit) {
      let result
      try {
        result = await this.options.launcher.launch()
      } catch (error) {
        this.setStatus('unavailable', `the network helper could not be started: ${describe(error)}`)
        return null
      }
      if (result.kind === 'failed') {
        this.setStatus(result.status, result.message)
        return null
      }
      if (this.shuttingDown) {
        result.process.kill()
        return null
      }
      const launched = result.process
      helper = launched
      this.helper = launched
      this.controlPath = result.path
      this.verify = result.verify ?? null
      this.lastInstance = null
      this.watchHelper(launched)
    }
    const client = await this.connectWithin(this.timing.connectTimeoutMs)
    if (!client) return null
    const established = await this.establish(client)
    if (established.kind === 'retry') {
      this.setStatus('unavailable', `the network helper did not answer: ${established.message}`)
      return null
    }
    return established.kind === 'ok' ? established.client : null
  }

  private watchHelper(helper: HelperProcess): void {
    void helper.exited.then((exit) => {
      this.log(`helper exited with code ${exit.code}${exit.signal ? ` (${exit.signal})` : ''}`)
      if (this.helper !== helper) return
      if (!this.client && !this.gate) this.helper = null
    })
  }

  private async tryConnect(): Promise<NetdClient | null> {
    if (!this.controlPath) return null
    const client = await NetdClient.connect({
      path: this.controlPath,
      clientVersion: this.options.version,
      connect: this.options.connect,
      commandTimeoutMs: this.timing.commandTimeoutMs,
      longCommandTimeoutMs: this.timing.longCommandTimeoutMs,
      log: this.log
    })
    if (!this.verify) return client
    try {
      await this.verify()
    } catch (error) {
      client.close()
      this.setStatus('unavailable', `the network helper could not be verified: ${describe(error)}`)
      return null
    }
    return client
  }

  private async connectWithin(totalMs: number): Promise<NetdClient | null> {
    const deadline = Date.now() + totalMs
    for (;;) {
      const helper = this.helper
      if (!helper || this.shuttingDown) return null
      if (helper.exit) {
        this.helperFailed(helper)
        return null
      }
      try {
        return await this.tryConnect()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (this.platform === 'win32' && (code === 'EACCES' || code === 'EPERM')) {
          this.setStatus('needs_admin', ADMIN_ACCOUNT_MESSAGE)
          return null
        }
        if (Date.now() >= deadline) {
          this.setStatus(
            'unavailable',
            `could not connect to the network helper: ${describe(error)}`
          )
          return null
        }
        await sleep(this.timing.connectRetryMs)
      }
    }
  }

  private helperFailed(helper: HelperProcess): void {
    const exit = helper.exit ?? { code: null, signal: null }
    const { status, message } = exitStatus(exit, helper.stderr, this.platform)
    this.setStatus(status, message)
    if (this.helper === helper) this.helper = null
  }

  private async establish(client: NetdClient): Promise<Established> {
    let hello: HelloResult
    try {
      hello = await client.handshake()
    } catch (error) {
      client.close()
      if (!(error instanceof NetdError)) return { kind: 'retry', message: describe(error) }
      if (error.code === 'version_unsupported') {
        this.setStatus(
          'out_of_date',
          `the network helper speaks protocol ${JSON.stringify(error.data?.supported ?? [])}, Lychee speaks 1`
        )
      } else if (error.code === 'busy') {
        this.setStatus('unavailable', BUSY_MESSAGE)
      } else {
        this.setStatus(
          'unavailable',
          `the network helper refused the session: ${error.code}: ${error.message}`
        )
      }
      return { kind: 'fatal' }
    }
    if (hello.helper_version !== this.options.version) {
      this.setStatus(
        'out_of_date',
        `the network helper is version ${hello.helper_version}, Lychee is ${this.options.version}`
      )
      const closed = await client.quit(this.timing.quitTimeoutMs)
      if (!closed) this.helper?.kill()
      return { kind: 'fatal' }
    }
    const fresh = hello.instance !== this.lastInstance
    this.lastInstance = hello.instance
    this.attach(client, hello)
    try {
      await this.subscribeAndApply(client, fresh)
    } catch (error) {
      if (!(error instanceof ConnectionClosedError)) {
        this.log(`cannot set up the session: ${describe(error)}`)
      }
    }
    if (client.closed || this.client !== client) return { kind: 'retry', message: 'closed' }
    this.refreshStatus()
    return { kind: 'ok', client, fresh }
  }

  private attach(client: NetdClient, hello: HelloResult): void {
    this.client = client
    this.hello = hello
    this.limits = hello.limits
    this.helperState = client.lastState
    this.commandFailure = null
    this.sessionReady = false
    client.on('state', (info) => {
      if (this.client !== client) return
      this.helperState = info
      this.refreshStatus()
      this.pushSoon(true)
    })
    client.on('stats', (data) => {
      if (this.client !== client) return
      this.onStats(client, data)
    })
    client.on('log', (entry) => this.log(`helper ${entry.level}: ${entry.message}`))
    client.on('close', (error) => {
      if (this.client !== client) return
      this.onClose(error)
    })
  }

  private async subscribeAndApply(client: NetdClient, fresh: boolean): Promise<void> {
    await client.request('subscribe', { interval_ms: STATS_INTERVAL_MS })
    await this.refreshSnapshot(client)
    if (!fresh) {
      this.sessionReady = true
      return
    }
    const settings = this.settings
    await this.apply(client, 'set_ipv6', { mode: settings.ipv6 })
    await this.apply(client, 'set_autopause', { enabled: settings.autoPause })
    const present = new Set(
      (this.snapshot?.adapters ?? []).filter((adapter) => adapter.present).map((a) => a.name)
    )
    for (const name of settings.excluded) {
      if (present.has(name)) await this.apply(client, 'exclude', { adapter: name })
    }
    for (const [name, weight] of Object.entries(settings.weights)) {
      if (present.has(name)) await this.apply(client, 'set_weight', { adapter: name, weight })
    }
    this.sessionReady = true
  }

  private async apply(client: NetdClient, cmd: Cmd, args: object): Promise<void> {
    try {
      await client.request(cmd, args)
    } catch (error) {
      if (error instanceof ConnectionClosedError) throw error
      this.log(`${cmd} ${JSON.stringify(args)} failed: ${describe(error)}`)
    }
  }

  private async send(client: NetdClient, cmd: Cmd, args: object): Promise<void> {
    try {
      await client.request(cmd, args)
    } catch (error) {
      if (error instanceof ConnectionClosedError) return
      if (error instanceof NetdError && error.code === 'unknown_adapter') return
      throw new Error(describe(error))
    }
  }

  private async refreshSnapshot(client: NetdClient): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      const status = await client.request<StatusResult>('status')
      if (this.client !== client) return
      this.snapshot = status
      this.helperState = status
      this.skipped = Array.isArray(status.skipped) ? status.skipped : []
      this.lastDiscoverySeq = status.discovery_seq
      this.pushSoon(false)
    } catch (error) {
      if (!(error instanceof ConnectionClosedError)) this.log(`status failed: ${describe(error)}`)
    } finally {
      this.refreshing = false
    }
  }

  private onStats(client: NetdClient, data: StatsData): void {
    this.snapshot = data
    this.helperState = data
    this.sample(data)
    if (this.sessionReady) this.reapply(client, data)
    if (this.lastDiscoverySeq !== null && data.discovery_seq !== this.lastDiscoverySeq) {
      this.lastDiscoverySeq = data.discovery_seq
      void this.refreshSnapshot(client)
    }
    this.refreshStatus()
    this.pushSoon(false)
  }

  private sample(data: StatsData): void {
    const names = new Set<string>()
    const length = Math.max(0, ...[...this.history.down.values()].map((series) => series.length))
    const push = (map: Map<string, number[]>, name: string, value: number): void => {
      const series = map.get(name) ?? new Array<number>(length).fill(0)
      series.push(Math.max(0, Math.trunc(value)))
      if (series.length > MERGE_HISTORY_SECONDS)
        series.splice(0, series.length - MERGE_HISTORY_SECONDS)
      map.set(name, series)
    }
    for (const adapter of data.adapters) {
      names.add(adapter.name)
      push(this.history.down, adapter.name, adapter.present ? adapter.link_in_bps : 0)
      push(this.history.up, adapter.name, adapter.present ? adapter.link_out_bps : 0)
    }
    for (const name of [...this.history.down.keys()]) {
      if (names.has(name)) continue
      push(this.history.down, name, 0)
      push(this.history.up, name, 0)
      const quiet = (series: number[] | undefined): boolean =>
        (series ?? []).every((value) => value === 0)
      if (quiet(this.history.down.get(name)) && quiet(this.history.up.get(name))) {
        this.history.down.delete(name)
        this.history.up.delete(name)
      }
    }
  }

  private reapply(client: NetdClient, data: StatsData): void {
    for (const adapter of data.adapters) {
      if (!adapter.present) continue
      if (!adapter.excluded && this.settings.excluded.includes(adapter.name)) {
        this.reapplyOnce(client, 'exclude', { adapter: adapter.name })
      }
      const weight = this.settings.weights[adapter.name]
      if (weight !== undefined && adapter.weight_mode === 'auto' && !adapter.excluded) {
        this.reapplyOnce(client, 'set_weight', { adapter: adapter.name, weight })
      }
    }
  }

  private reapplyOnce(
    client: NetdClient,
    cmd: Cmd,
    args: { adapter: string; weight?: number }
  ): void {
    const key = `${cmd}:${args.adapter}`
    if (this.reapplying.has(key)) return
    this.reapplying.add(key)
    void this.apply(client, cmd, args)
      .catch(() => undefined)
      .finally(() => this.reapplying.delete(key))
  }

  private onClose(error: ConnectionClosedError): void {
    this.client = null
    this.hello = null
    this.reapplying.clear()
    if (this.shuttingDown) return
    if (error.reason === 'quit') {
      this.helperState = null
      if (this.status !== 'out_of_date') this.setStatus('off', null)
      return
    }
    this.log(`connection lost: ${error.message}`)
    const previous = this.gate ?? Promise.resolve(null)
    const run = previous
      .catch(() => null)
      .then(() => (this.shuttingDown || this.session() ? this.session() : this.recover()))
    const gate: Promise<NetdClient | null> = run.finally(() => {
      if (this.gate === gate) this.gate = null
    })
    this.gate = gate
  }

  private async recover(): Promise<NetdClient | null> {
    const helper = this.helper
    this.setStatus('reconnecting', RECONNECTING_MESSAGE)
    const deadline = Date.now() + (this.timing.graceMs ?? this.limits.grace_ms)
    for (let attempt = 0; !this.shuttingDown; attempt++) {
      if (!helper || helper.exit || !this.controlPath) break
      if (attempt > 0) {
        await sleep(this.timing.reconnectEveryMs)
        if (Date.now() >= deadline || helper.exit || this.shuttingDown) break
      }
      let client: NetdClient | null
      try {
        client = await this.tryConnect()
      } catch {
        continue
      }
      if (!client) return null
      const established = await this.establish(client)
      if (established.kind === 'fatal') return null
      if (established.kind === 'retry') continue
      if (established.fresh && this.settings.enabled) {
        this.pendingOn++
        try {
          await this.turnOn(established.client)
        } finally {
          this.pendingOn--
          this.refreshStatus()
        }
      }
      return established.client
    }
    if (!this.shuttingDown) this.helperLost(helper)
    return null
  }

  private helperLost(helper: HelperProcess | null): void {
    const exit = helper?.exit
    let detail: string | null = null
    if (helper && exit && exit.code !== null && exit.code !== 0) {
      detail = exitStatus(exit, helper.stderr, this.platform).message
    }
    this.helperState = null
    this.setStatus('stopped', detail ? `${STOPPED_MESSAGE}: ${detail}` : STOPPED_MESSAGE)
    if (helper && !exit) helper.kill()
    if (this.helper === helper) this.helper = null
  }

  private commandFailed(error: unknown, cmd: Cmd): void {
    if (error instanceof ConnectionClosedError) return
    if (!(error instanceof NetdError)) {
      this.log(`${cmd} failed: ${describe(error)}`)
      return
    }
    this.log(`${cmd} failed: ${error.code}: ${error.message}`)
    switch (error.code) {
      case 'unsupported_platform':
        this.commandFailure = {
          status: 'unsupported',
          message: typeof error.data?.error === 'string' ? error.data.error : error.message
        }
        break
      case 'no_adapters':
        this.commandFailure = { status: 'error', message: NO_ADAPTERS_MESSAGE }
        break
      case 'permission_denied':
        this.commandFailure = { status: 'needs_permission', message: error.message }
        break
      case 'internal':
        break
      default:
        this.commandFailure = { status: 'error', message: error.message }
    }
    this.refreshStatus()
  }

  private refreshStatus(): void {
    if (this.shuttingDown) return
    const client = this.session()
    const info = this.helperState
    if (!client || !info) return
    switch (info.state) {
      case 'error':
        return this.setStatus('error', info.error?.message ?? 'Combining connections failed')
      case 'starting':
        return this.setStatus('starting', null)
      case 'on':
        return this.setStatus('on', null)
      case 'paused_auto':
        return this.setStatus('paused_auto', null)
      case 'off':
        if (this.pendingOn > 0) return this.setStatus('starting', null)
        if (this.commandFailure) {
          return this.setStatus(this.commandFailure.status, this.commandFailure.message)
        }
        return this.setStatus('off', null)
      default:
        return this.setStatus('off', null)
    }
  }

  private setStatus(status: MergeStatus, message: string | null): void {
    if (this.status === status && this.message === message) return
    this.status = status
    this.message = message
    this.pushSoon(true)
  }

  private async saveSettings(next: MergeSettings): Promise<void> {
    this.settings = next
    this.pushSoon(true)
    try {
      await this.options.settings.save(next)
    } catch (error) {
      this.log(`cannot save the merge settings: ${describe(error)}`)
    }
  }

  private pushSoon(immediate: boolean): void {
    if (this.shuttingDown) return
    const elapsed = Date.now() - this.lastPushAt
    if (immediate || elapsed >= this.timing.pushEveryMs) return this.pushNow()
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.pushNow()
    }, this.timing.pushEveryMs - elapsed)
  }

  private pushNow(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
    this.seq++
    this.lastPushAt = Date.now()
    this.options.push(this.state())
  }
}
