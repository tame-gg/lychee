import { createServer, type Server, type Socket } from 'node:net'
import { FakeNetd, type ExitInfo, type FakeNetdOptions } from './fakeNetd'

/**
 * Simulates what launching `lychee-netd serve --control <path>` can come to, for client tests:
 * the exit codes of spec section 2.7, the Windows named-pipe dead ends of sections 2.4 and 10.6,
 * and a helper whose peer check rejects the client (section 3.3). Where the spec leaves the
 * handling to the client, this only exposes the raw outcome; it does not interpret it.
 */
export type LaunchOutcome =
  /** The helper runs: a FakeNetd listens on `path` and the process exits when it does. */
  | 'serve'
  /** Exit 2: wrong arguments. */
  | 'usage'
  /** Exit 3: missing privilege, failed self-check, no authorized principal or invalid path. */
  | 'refused'
  /** Exit 4: another lychee-netd or a standalone net-merge holds a lock or a live socket. */
  | 'another_tool'
  /** Exit 5: bind/listen failed or the pipe name is taken. */
  | 'transport_failed'
  /** Exit 6 (Windows): the token is not elevated or not in Administrators. */
  | 'needs_admin'
  /** Runs, but the peer check fails: every connection gets EOF with zero bytes (section 3.3). */
  | 'peer_rejected'
  /**
   * Windows, section 2.4 rule 1: the helper is alive but belongs to another administrator, so
   * `CreateFile` on the expected pipe name fails with ERROR_ACCESS_DENIED. Nothing listens on
   * `path`; the raw outcome is in `connect`.
   */
  | 'access_denied'
  /**
   * Windows, section 2.4 rule 6: another process owns the pipe name. It accepts connections and
   * never answers; `connect` carries the server pid and SID the client's check would read.
   */
  | 'squatted'

export const EXIT_CODES: Record<
  Exclude<LaunchOutcome, 'peer_rejected' | 'access_denied' | 'squatted'>,
  number
> = {
  serve: 0,
  usage: 2,
  refused: 3,
  another_tool: 4,
  transport_failed: 5,
  needs_admin: 6
}

export interface LaunchOptions extends Partial<Omit<FakeNetdOptions, 'path' | 'rejectPeers'>> {
  outcome: LaunchOutcome
  path: string
  /** Replaces the default one-line stderr reason. */
  stderr?: string
  /** 'squatted' / 'access_denied': the other process's identity. */
  serverPid?: number
  serverSid?: string
}

export type ConnectOutcome =
  /** A connection to `path` succeeds; the server's identity is what the client would read back. */
  | { kind: 'ok'; serverPid: number; serverSid: string | null }
  /** `CreateFile` fails: the client never gets a handle. */
  | { kind: 'error'; code: 'EACCES'; message: string }
  /** Nothing listens: the process exited before creating the transport. */
  | { kind: 'unavailable' }

export interface FakeNetdProcess {
  readonly pid: number
  readonly path: string
  readonly outcome: LaunchOutcome
  /** null while the process is alive. */
  readonly exitCode: number | null
  readonly stderr: string
  readonly exited: Promise<ExitInfo>
  /** The listening fake for 'serve' and 'peer_rejected'; null otherwise. */
  readonly netd: FakeNetd | null
  readonly connect: ConnectOutcome
  /** Kills the process (a crash from the helper's point of view, section 10.5). */
  kill(): Promise<void>
}

const STDERR: Record<LaunchOutcome, string> = {
  serve: '',
  usage: 'usage: lychee-netd serve --control <path>',
  refused: 'permission_denied: lychee-netd needs root, CAP_NET_ADMIN or an elevated token',
  another_tool: 'another connection-merging tool is running',
  transport_failed: 'cannot create control transport: bind: address already in use',
  needs_admin: 'needs_admin: the process token is not elevated or not a member of Administrators',
  peer_rejected: '',
  access_denied: '',
  squatted: ''
}

const OTHER_ADMIN_SID = 'S-1-5-21-1004336348-1177238915-682003330-500'

class LaunchedProcess implements FakeNetdProcess {
  readonly pid: number
  readonly path: string
  readonly outcome: LaunchOutcome
  exitCode: number | null = null
  stderr = ''
  readonly exited: Promise<ExitInfo>
  netd: FakeNetd | null = null
  connect: ConnectOutcome = { kind: 'unavailable' }
  private resolveExit!: (info: ExitInfo) => void
  private squatter: Server | null = null
  private readonly held: Socket[] = []

  constructor(options: LaunchOptions) {
    this.pid = options.pid ?? 5120
    this.path = options.path
    this.outcome = options.outcome
    this.exited = new Promise((resolve) => (this.resolveExit = resolve))
    const line = options.stderr ?? STDERR[options.outcome]
    if (line) this.stderr += line + '\n'
  }

  async start(options: LaunchOptions): Promise<this> {
    switch (options.outcome) {
      case 'usage':
      case 'refused':
      case 'another_tool':
      case 'transport_failed':
      case 'needs_admin':
        this.finish(EXIT_CODES[options.outcome])
        return this
      case 'serve':
      case 'peer_rejected': {
        const netd = new FakeNetd({
          ...options,
          path: this.path,
          rejectPeers: options.outcome === 'peer_rejected'
        })
        await netd.start()
        this.netd = netd
        this.stderr += `listening on ${this.path}\n`
        this.connect = { kind: 'ok', serverPid: netd.pid, serverSid: sidOf(netd) }
        netd.on('exit', (info: ExitInfo, reason: string) => {
          if (reason) this.stderr += `${reason}\n`
          this.finish(info.code)
        })
        return this
      }
      case 'access_denied':
        this.connect = {
          kind: 'error',
          code: 'EACCES',
          message: 'ERROR_ACCESS_DENIED: the pipe belongs to another administrator'
        }
        return this
      case 'squatted': {
        const server = createServer((socket) => {
          this.held.push(socket)
          socket.on('error', () => {})
        })
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(this.path, () => resolve())
        })
        this.squatter = server
        this.connect = {
          kind: 'ok',
          serverPid: options.serverPid ?? 7777,
          serverSid: options.serverSid ?? OTHER_ADMIN_SID
        }
        return this
      }
    }
  }

  async kill(): Promise<void> {
    if (this.exitCode !== null) return
    if (this.netd) {
      this.netd.crash(null)
      return
    }
    for (const s of this.held) s.destroy()
    this.squatter?.close()
    this.finish(null)
  }

  private finish(code: number | null): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.resolveExit({ code })
  }
}

function sidOf(netd: FakeNetd): string | null {
  return netd.auth.model === 'windows_pipe_sid' ? netd.auth.authorized_sid : null
}

/** "Launches" the helper with the given outcome. For 'serve', `options` configure the FakeNetd. */
export async function fakeNetdLaunch(options: LaunchOptions): Promise<FakeNetdProcess> {
  return new LaunchedProcess(options).start(options)
}
