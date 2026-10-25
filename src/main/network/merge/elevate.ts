import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
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
  uid?: number
}

export interface HelperLocation {
  binary: string
  bundled?: string
}

export const ADMIN_ACCOUNT_MESSAGE =
  'Combining connections system-wide needs an administrator account on this PC'
export const ANOTHER_TOOL_MESSAGE = 'another connection-merging tool is running'
export const MAC_HELPER_DIR = '/Library/PrivilegedHelperTools'
export const MAC_HELPER = `${MAC_HELPER_DIR}/gg.tame.lychee.netd`
export const MAC_CONTROL = '/var/run/lychee-netd/netd.sock'
export const MAC_PROMPT = 'Lychee needs an administrator password to combine your connections.'
export const PERMISSION_MESSAGE = 'permission to start the network helper was not given'
export const LINUX_SYSTEM_HELPER = '/usr/lib/lychee/lychee-netd'
export const LINUX_ROOT_CONTROL = '/run/lychee-netd/netd.sock'
export const PKEXEC_PATHS = ['/usr/bin/pkexec', '/run/wrappers/bin/pkexec']
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

function bundledBinary(env: HelperEnvironment, os: 'mac' | 'linux' | 'win', name: string): string {
  return env.packaged
    ? join(env.resourcesPath, 'helper', name)
    : join(env.appRoot, 'build', 'netd', `${os}-${buildDir(env.arch)}`, name)
}

function runnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function pkexecPath(usable: (path: string) => boolean = runnable): string | null {
  return PKEXEC_PATHS.find(usable) ?? null
}

export function helperLocation(env: HelperEnvironment): HelperLocation | FailedLaunch {
  if (env.platform === 'win32') {
    if (env.arch !== 'x64') {
      return {
        kind: 'failed',
        status: 'unsupported',
        message: 'combining connections is not available on Windows on ARM yet'
      }
    }
    const binary = bundledBinary(env, 'win', 'lychee-netd.exe')
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
    const bundled = bundledBinary(env, 'mac', 'lychee-netd')
    if (!existsSync(bundled)) {
      return {
        kind: 'failed',
        status: 'unsupported',
        message: 'the network helper is not part of this build'
      }
    }
    return { binary: MAC_HELPER, bundled }
  }
  if (env.platform === 'linux') {
    const bundled = bundledBinary(env, 'linux', 'lychee-netd')
    const candidates = env.packaged ? [LINUX_SYSTEM_HELPER, bundled] : [bundled]
    const binary = candidates.find(runnable)
    if (!binary) {
      return {
        kind: 'failed',
        status: 'unsupported',
        message: 'the network helper is not part of this build'
      }
    }
    return { binary, bundled }
  }
  return {
    kind: 'failed',
    status: 'unsupported',
    message: `combining connections is not available on ${env.platform}`
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function macAdminShellScript(options: {
  bundled: string
  install: boolean
  uid: number
}): string {
  const temp = `${MAC_HELPER}.tmp`
  const steps = ['set -e']
  if (options.install) {
    steps.push(
      `/bin/mkdir -p ${shellQuote(MAC_HELPER_DIR)}`,
      `/usr/sbin/chown root:wheel ${shellQuote(MAC_HELPER_DIR)}`,
      `/bin/chmod 755 ${shellQuote(MAC_HELPER_DIR)}`,
      `/bin/cp ${shellQuote(options.bundled)} ${shellQuote(temp)}`,
      `/usr/sbin/chown root:wheel ${shellQuote(temp)}`,
      `/bin/chmod 755 ${shellQuote(temp)}`,
      `/bin/mv -f ${shellQuote(temp)} ${shellQuote(MAC_HELPER)}`
    )
  }
  steps.push(
    `exec /usr/bin/env SUDO_UID=${Math.trunc(options.uid)} ${shellQuote(MAC_HELPER)} serve --control ${shellQuote(MAC_CONTROL)}`
  )
  return steps.join('; ')
}

export function macAdminAppleScript(shell: string): string {
  return `do shell script ${appleScriptString(shell)} with administrator privileges with prompt ${appleScriptString(MAC_PROMPT)}`
}

const OSASCRIPT_ERROR = /execution error:\s*([\s\S]*?)\s*\((-?\d+)\)$/

export function osascriptOutcome(
  exit: HelperExit,
  stderr: string
): { exit: HelperExit; stderr: string } {
  if (exit.code !== 1) return { exit, stderr }
  const match = OSASCRIPT_ERROR.exec(stderr.trim())
  if (!match) return { exit, stderr }
  return { exit: { code: Number(match[2]), signal: null }, stderr: match[1] }
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
    case -128:
      return { status: 'needs_permission', message: PERMISSION_MESSAGE }
    case 126:
    case 127:
    case 1223:
      return { status: 'needs_permission', message: text(PERMISSION_MESSAGE) }
    case 1:
      if (platform === 'darwin' && /sudo/i.test(stderr)) {
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
      child.on('close', (code, signal) => finish({ code, signal }))
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

class OsascriptHelper implements HelperProcess {
  readonly exited: Promise<HelperExit>

  constructor(private readonly inner: SpawnedHelper) {
    this.exited = inner.exited.then((exit) => osascriptOutcome(exit, inner.stderr).exit)
  }

  get pid(): number | null {
    return this.inner.pid
  }

  get exit(): HelperExit | null {
    const exit = this.inner.exit
    return exit ? osascriptOutcome(exit, this.inner.stderr).exit : null
  }

  get stderr(): string {
    const exit = this.inner.exit
    return exit ? osascriptOutcome(exit, this.inner.stderr).stderr : this.inner.stderr
  }

  exitWithin(ms: number): Promise<HelperExit | null> {
    return Promise.race([this.exited, sleep(ms).then(() => null)])
  }

  kill(): void {
    this.inner.kill()
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

export interface LauncherOptions {
  pkexec?: () => string | null
}

export class NativeLauncher implements Launcher {
  private readonly env: HelperEnvironment
  private readonly log: (line: string) => void
  private readonly pkexec: () => string | null

  constructor(
    env: HelperEnvironment,
    log: (line: string) => void = (): void => {},
    options: LauncherOptions = {}
  ) {
    this.env = env
    this.log = log
    this.pkexec = options.pkexec ?? pkexecPath
  }

  async launch(): Promise<LaunchResult> {
    const location = helperLocation(this.env)
    if ('kind' in location) return location
    switch (this.env.platform) {
      case 'linux':
        return this.launchLinux(location.binary, location.bundled ?? null)
      case 'darwin':
        return this.launchDarwin(location.bundled ?? location.binary)
      case 'win32':
        return this.launchWindows(location.binary)
      default:
        return failed(
          'unsupported',
          `combining connections is not available on ${this.env.platform}`
        )
    }
  }

  private async launchLinux(chosen: string, bundled: string | null): Promise<LaunchResult> {
    let binary = chosen
    if (this.env.packaged && chosen !== LINUX_SYSTEM_HELPER && existsSync(LINUX_SYSTEM_HELPER)) {
      this.log(
        `${LINUX_SYSTEM_HELPER} is not executable by this user (only the lychee group may run it); using ${chosen}`
      )
    }
    const installed = await reportedVersion(binary, this.env.env)
    if (installed === null) {
      return failed('unavailable', `the network helper at ${binary} could not be run`)
    }
    if (installed !== this.env.version) {
      const fallback =
        binary !== bundled && bundled && existsSync(bundled)
          ? await reportedVersion(bundled, this.env.env)
          : null
      if (fallback !== this.env.version) {
        return failed(
          'out_of_date',
          `the installed network helper is version ${installed}, Lychee is ${this.env.version}`
        )
      }
      this.log(`${binary} is version ${installed}; using the packaged copy ${bundled}`)
      binary = bundled as string
    }
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
    const pkexec = this.pkexec()
    if (!pkexec) {
      return failed('not_installed', 'the network helper needs pkexec, which is not installed')
    }
    const path = LINUX_ROOT_CONTROL
    const helper = spawnHelper(pkexec, [binary, 'serve', '--control', path], this.env.env, this.log)
    const early = await helper.exitWithin(EARLY_EXIT_MS)
    if (!early) return { kind: 'launched', process: helper, path }
    if (helper.spawnError?.code === 'ENOENT') {
      return failed('not_installed', 'the network helper needs pkexec, which is not installed')
    }
    const { status, message } = exitStatus(early, helper.stderr, 'linux')
    return failed(status, message)
  }

  private async launchDarwin(bundled: string): Promise<LaunchResult> {
    const args = [MAC_HELPER, 'serve', '--control', MAC_CONTROL]
    const installed = await reportedVersion(MAC_HELPER, this.env.env)
    const current = installed === this.env.version
    if (current && (await succeeds('/usr/bin/sudo', ['-n', '-l', ...args], this.env.env))) {
      const helper = spawnHelper('/usr/bin/sudo', ['-n', ...args], this.env.env, this.log)
      const early = await helper.exitWithin(EARLY_EXIT_MS)
      if (!early) return { kind: 'launched', process: helper, path: MAC_CONTROL }
      const { status, message } = exitStatus(early, helper.stderr, 'darwin')
      return failed(status, message)
    }
    const uid = this.env.uid
    if (uid === undefined) {
      return failed('unavailable', 'cannot tell which user may use the network helper')
    }
    if (!current) {
      this.log(
        `installing the network helper ${this.env.version} over ${installed ?? 'none'} at ${MAC_HELPER}`
      )
    }
    const script = macAdminAppleScript(macAdminShellScript({ bundled, install: !current, uid }))
    const helper = new OsascriptHelper(
      spawnHelper('/usr/bin/osascript', ['-e', script], this.env.env, this.log)
    )
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
