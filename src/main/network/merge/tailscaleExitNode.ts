import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const STATUS_TIMEOUT_MS = 4000

export interface ExitNodeDetection {
  detected: boolean
  active: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stdoutOf(error: unknown): string | null {
  if (!isRecord(error) || !('stdout' in error)) return null
  const stdout = error.stdout
  if (typeof stdout === 'string') return stdout
  if (stdout instanceof Uint8Array) return Buffer.from(stdout).toString('utf8')
  return null
}

export function parseTailscaleStatus(text: string): ExitNodeDetection {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { detected: false, active: false }
  }
  if (!isRecord(parsed)) return { detected: false, active: false }
  if (isRecord(parsed.ExitNodeStatus)) return { detected: true, active: true }
  if (isRecord(parsed.Peer)) {
    for (const peer of Object.values(parsed.Peer)) {
      if (isRecord(peer) && peer.ExitNode === true) return { detected: true, active: true }
    }
  }
  return { detected: true, active: false }
}

export function tailscaleBinaryCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale'
    ]
  }
  if (platform === 'win32') {
    return ['ProgramFiles', 'ProgramFiles(x86)'].flatMap((name) => {
      const root = env[name]
      return root ? [win32.join(root, 'Tailscale', 'tailscale.exe')] : []
    })
  }
  if (platform === 'linux') {
    return ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale']
  }
  return []
}

export function resolveTailscaleBinary(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean
): string {
  for (const candidate of tailscaleBinaryCandidates(platform, env)) {
    if (exists(candidate)) return candidate
  }
  return 'tailscale'
}

export async function readTailscaleStatusCli(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      resolveTailscaleBinary(platform, env, exists),
      ['status', '--json'],
      {
        timeout: STATUS_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      }
    )
    return stdout
  } catch (error) {
    const stdout = stdoutOf(error)
    if (stdout && stdout.trim().startsWith('{')) return stdout
    return null
  }
}

export async function detectTailscaleExitNode(
  read: () => Promise<string | null> = readTailscaleStatusCli
): Promise<ExitNodeDetection> {
  let text: string | null
  try {
    text = await read()
  } catch {
    return { detected: false, active: false }
  }
  if (text === null || text.trim() === '') return { detected: false, active: false }
  return parseTailscaleStatus(text)
}
