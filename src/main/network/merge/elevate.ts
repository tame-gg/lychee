import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { MergeStatus } from '../../../shared/types'
import { pipeServerIdentity, systemTool, windowsIdentity } from './windowsPipe'

const execFileAsync = promisify(execFile)

export type LaunchFailure = Extract<
  MergeStatus,
  | 'needs_permission'
  | 'needs_admin'
  | 'not_installed'
  | 'out_of_date'
  | 'unsupported'
  | 'another_tool'
  | 'unavailable'
>

export interface HelperExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface HelperProcess {
  readonly pid: number | null
  readonly exit: HelperExit | null
  readonly exited: Promise<HelperExit>
  readonly stderr: string
  kill(): void
}

export interface LaunchedHelper {
  kind: 'launched'
  process: HelperProcess
  path: string
  verify?: () => Promise<void>
}

export interface FailedLaunch {
  kind: 'failed'
  status: LaunchFailure
  message: string
}

export type LaunchResult = LaunchedHelper | FailedLaunch

export interface Launcher {
  launch(): Promise<LaunchResult>
}

export interface HelperEnvironment {
  platform: NodeJS.Platform
  arch: string
  version: string
  packaged: boolean
  resourcesPath: string
  appRoot: string
  env: NodeJS.ProcessEnv
}

export const ADMIN_ACCOUNT_MESSAGE =
  'Combining connections system-wide needs an administrator account on this PC'
export const ANOTHER_TOOL_MESSAGE = 'another connection-merging tool is running'
export const MAC_HELPER = '/Library/PrivilegedHelperTools/gg.tame.lychee.netd'
export const MAC_CONTROL = '/var/run/lychee-netd/netd.sock'
export const LINUX_SYSTEM_HELPER = '/usr/lib/lychee/lychee-netd'
export const LINUX_ROOT_CONTROL = '/run/lychee-netd/netd.sock'
export const PIPE_PREFIX = '\\\\.\\pipe\\lychee-netd-'

const EARLY_EXIT_MS = 1000
const STDERR_KEEP = 8192
const MESSAGE_MAX = 200

const ELEVATE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $p = Start-Process -FilePath $env:LYCHEE_NETD_EXE -ArgumentList @('serve', '--control', $env:LYCHEE_NETD_CONTROL) -Verb RunAs -WindowStyle Hidden -PassThru
} catch {
  $code = 1
  if ($_.Exception.InnerException -and $_.Exception.InnerException.NativeErrorCode) { $code = $_.Exception.InnerException.NativeErrorCode }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit $code
}
[Console]::Out.WriteLine('pid=' + $p.Id)
[Console]::Out.Flush()
$p.WaitForExit()
exit $p.ExitCode
`

function buildDir(arch: string): string {
  return arch === 'arm64' ? 'arm64' : 'x64'
}

export function helperLocation(env: HelperEnvironment): { binary: string } | FailedLaunch {
  if (env.platform === 'win32') {
    if (env.arch !== 'x64') {
      return {
        kind: 'failed',
        status: 'unsupported',
        message: 'combining connections is not available on Windows on ARM yet'
      }
    }
    const binary = env.packaged
      ? join(env.resourcesPath, 'helper', 'lychee-netd.exe')
      : join(env.appRoot, 'build', 'netd', 'win-x64', 'lychee-netd.exe')
    if (!existsSync(binary)) {
      return {
        kind: 'failed',
        status: 'unsupported',
        message: 'the network helper is not part of this build'
      }
    }
    return { binary }
  }
  if (env.platform === 'darwin') {
    if (!existsSync(MAC_HELPER)) {
      return {
        kind: 'failed',
        status: 'not_installed',
        message: 'the network helper is not installed yet'
      }
    }
    return { binary: MAC_HELPER }
  }
  if (env.platform === 'linux') {
    const candidates = env.packaged
      ? [LINUX_SYSTEM_HELPER, join(env.resourcesPath, 'helper', 'lychee-netd')]
      : [join(env.appRoot, 'build', 'netd', `linux-${buildDir(env.arch)}`, 'lychee-netd')]
    const binary = candidates.find((candidate) => existsSync(candidate))
    if (!binary) {
      return {
        kind: 'failed',
        status: 'unsupported',
        message: 'the network helper is not part of this build'
      }
    }
    return { binary }
  }
  return {
    kind: 'failed',
    status: 'unsupported',
    message: `combining connections is not available on ${env.platform}`
  }
}

function lastLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('listening on '))
  const line = lines[lines.length - 1] ?? ''
  return line.replace(/^error:\s*/i, '').slice(0, MESSAGE_MAX)
}

export function exitStatus(
  exit: HelperExit,
  stderr: string,
  platform: NodeJS.Platform
): { status: LaunchFailure; message: string } {
  const line = lastLine(stderr)
  const text = (fallback: string): string => line || fallback
  switch (exit.code) {
    case 3:
      return { status: 'not_installed', message: text('the network helper refused to start') }
    case 4:
      return { status: 'another_tool', message: text(ANOTHER_TOOL_MESSAGE) }
    case 5:
      return {
        status: 'unavailable',
        message: text('the network helper could not create its control channel')
      }
    case 6:
      return { status: 'needs_admin', message: ADMIN_ACCOUNT_MESSAGE }
    case 126:
    case 127:
    case 1223:
      return {
        status: 'needs_permission',
        message: text('permission to start the network helper was not given')
      }
    case 1:
      if (platform === 'darwin') {
        return {
          status: 'not_installed',
          message: text('Lychee is not allowed to start the network helper without a password')
        }
      }
      break
    case null:
      return {
        status: 'unavailable',
        message: text(
          exit.signal
            ? `the network helper was stopped by ${exit.signal}`
            : 'the network helper could not be started'
        )
      }
  }
  return {
    status: 'unavailable',
    message: text(`the network helper exited with code ${exit.code}`)
  }
}

interface SpawnOptions {
  pidFromStdout?: boolean
}

class SpawnedHelper implements HelperProcess {
  pid: number | null
  exit: HelperExit | null = null
  readonly exited: Promise<HelperExit>
  stderr = ''
  spawnError: NodeJS.ErrnoException | null = null
  private readonly child: ChildProcess
  private readonly ownsPid: boolean
  private stdout = ''

  constructor(child: ChildProcess, options: SpawnOptions, log: (line: string) => void) {
    this.child = child
    this.ownsPid = !options.pidFromStdout
    this.pid = options.pidFromStdout ? null : (child.pid ?? null)
    this.exited = new Promise((resolve) => {
      const finish = (exit: HelperExit): void => {
        if (this.exit) return
        this.exit = exit
        resolve(exit)
      }
      child.on('error', (error: NodeJS.ErrnoException) => {
        this.spawnError = error
        this.append(`${error.message}\n`)
        finish({ code: null, signal: null })
      })
      child.on('exit', (code, signal) => finish({ code, signal }))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk)
      this.append(text)
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(line.trim())
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      this.stdout += String(chunk)
      const match = /pid=(\d+)/.exec(this.stdout)
      if (match && options.pidFromStdout) this.pid = Number(match[1])
    })
  }

  exitWithin(ms: number): Promise<HelperExit | null> {
    return Promise.race([this.exited, sleep(ms).then(() => null)])
  }

  kill(): void {
    if (this.exit) return
    if (!this.ownsPid && this.pid !== null) {
      try {
        process.kill(this.pid)
      } catch {
        return
      }
    }
    try {
      this.child.kill()
    } catch {
      return
    }
  }

  private append(text: string): void {
    this.stderr = (this.stderr + text).slice(-STDERR_KEEP)
  }
}

function spawnHelper(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  options: SpawnOptions = {}
): SpawnedHelper {
  const child = spawn(command, args, {
    env,
    stdio: ['ignore', options.pidFromStdout ? 'pipe' : 'ignore', 'pipe'],
    windowsHide: true
  })
  return new SpawnedHelper(child, options, log)
}

async function succeeds(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync(command, args, { env, timeout: 5000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

async function reportedVersion(binary: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ['version'], {
      env,
      timeout: 5000,
      windowsHide: true
    })
    return /lychee-netd\s+(\S+)/.exec(stdout)?.[1] ?? null
  } catch {
    return null
  }
}

function failed(status: LaunchFailure, message: string): FailedLaunch {
  return { kind: 'failed', status, message }
}

export class NativeLauncher implements Launcher {
  private readonly env: HelperEnvironment
  private readonly log: (line: string) => void

  constructor(env: HelperEnvironment, log: (line: string) => void = (): void => {}) {
    this.env = env
    this.log = log
  }

  async launch(): Promise<LaunchResult> {
    const location = helperLocation(this.env)
    if ('kind' in location) return location
    switch (this.env.platform) {
      case 'linux':
        return this.launchLinux(location.binary)
      case 'darwin':
        return this.launchDarwin(location.binary)
      case 'win32':
        return this.launchWindows(location.binary)
      default:
        return failed(
          'unsupported',
          `combining connections is not available on ${this.env.platform}`
        )
    }
  }

  private async launchLinux(binary: string): Promise<LaunchResult> {
    const runtimeDir = this.env.env.XDG_RUNTIME_DIR
    if (runtimeDir && isAbsolute(runtimeDir)) {
      const path = join(runtimeDir, 'lychee', 'netd.sock')
      const helper = spawnHelper(binary, ['serve', '--control', path], this.env.env, this.log)
      const early = await helper.exitWithin(EARLY_EXIT_MS)
      if (!early) return { kind: 'launched', process: helper, path }
      if (early.code !== 3) {
        const { status, message } = exitStatus(early, helper.stderr, 'linux')
        return failed(status, message)
      }
    }
    const path = LINUX_ROOT_CONTROL
    const helper = spawnHelper(
      'pkexec',
      [binary, 'serve', '--control', path],
      this.env.env,
      this.log
    )
    const early = await helper.exitWithin(EARLY_EXIT_MS)
    if (!early) return { kind: 'launched', process: helper, path }
    if (helper.spawnError?.code === 'ENOENT') {
      return failed('not_installed', 'the network helper needs pkexec, which is not installed')
    }
    const { status, message } = exitStatus(early, helper.stderr, 'linux')
    return failed(status, message)
  }

  private async launchDarwin(binary: string): Promise<LaunchResult> {
    const args = [binary, 'serve', '--control', MAC_CONTROL]
    if (!(await succeeds('/usr/bin/sudo', ['-n', '-l', ...args], this.env.env))) {
      return failed('not_installed', 'Lychee is not allowed to start the network helper yet')
    }
    const installed = await reportedVersion(binary, this.env.env)
    if (installed !== this.env.version) {
      return failed(
        'out_of_date',
        `the installed network helper is version ${installed ?? 'unknown'}, Lychee is ${this.env.version}`
      )
    }
    const helper = spawnHelper('/usr/bin/sudo', ['-n', ...args], this.env.env, this.log)
    const early = await helper.exitWithin(EARLY_EXIT_MS)
    if (!early) return { kind: 'launched', process: helper, path: MAC_CONTROL }
    const { status, message } = exitStatus(early, helper.stderr, 'darwin')
    return failed(status, message)
  }

  private async launchWindows(binary: string): Promise<LaunchResult> {
    let identity
    try {
      identity = await windowsIdentity(this.env.env)
    } catch (error) {
      return failed('unavailable', `cannot read the Windows user identity: ${String(error)}`)
    }
    if (!identity.administrator) return failed('needs_admin', ADMIN_ACCOUNT_MESSAGE)
    const path = PIPE_PREFIX + identity.sid
    const encoded = Buffer.from(ELEVATE_SCRIPT, 'utf16le').toString('base64')
    const helper = spawnHelper(
      systemTool(this.env.env, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded
      ],
      { ...this.env.env, LYCHEE_NETD_EXE: binary, LYCHEE_NETD_CONTROL: path },
      this.log,
      { pidFromStdout: true }
    )
    const early = await helper.exitWithin(EARLY_EXIT_MS)
    if (early) {
      const { status, message } = exitStatus(early, helper.stderr, 'win32')
      return failed(status, message)
    }
    const expected = identity.sid
    return {
      kind: 'launched',
      process: helper,
      path,
      verify: async () => {
        const server = await pipeServerIdentity(path)
        if (server.sid !== expected) {
          throw new Error(`${path} belongs to another process (pid ${server.pid})`)
        }
      }
    }
  }
}

export function connectOnlyLauncher(path: string): Launcher {
  return {
    launch: async () => ({
      kind: 'launched',
      path,
      process: {
        pid: null,
        exit: null,
        exited: new Promise<HelperExit>(() => {}),
        stderr: '',
        kill: () => {}
      }
    })
  }
}
