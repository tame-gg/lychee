import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const NETD_LOG_NAME = 'lychee-netd.log'
export const NETD_LOG_MAX_BYTES = 256 * 1024
export const NETD_LOG_ROTATIONS = 2

const SECRET = /((?:password|passwd|token|secret|authorization|cookie)\s*[:=]\s*)(\S+)/gi
const HEX_RUN = /\b(?:0x)?[0-9a-fA-F]{64,}\b/g

export function netdLogsDirectory(userData: string): string {
  return join(userData, 'logs')
}

export function redactLogLine(line: string, home: string): string {
  let out = line.replace(/\r/g, '')
  out = redactHome(out, home)
  out = out.replace(SECRET, '$1[redacted]')
  out = out.replace(HEX_RUN, '[payload omitted]')
  if (out.length > 1024) out = `${out.slice(0, 1024)}…`
  return out
}

export function redactHome(text: string, home: string): string {
  const trimmed = home.replace(/[\\/]+$/, '')
  if (!trimmed) return text
  const variants = new Set<string>([
    trimmed,
    trimmed.split('\\').join('/'),
    trimmed.split('/').join('\\')
  ])
  let out = text
  for (const variant of variants) {
    if (variant.length > 1) out = out.split(variant).join('~')
  }
  return out
}

export class NetdLog {
  readonly file: string

  constructor(
    readonly dir: string,
    private readonly home: string,
    private readonly maxBytes = NETD_LOG_MAX_BYTES,
    private readonly rotations = NETD_LOG_ROTATIONS
  ) {
    this.file = join(dir, NETD_LOG_NAME)
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      void error
    }
  }

  write(line: string): void {
    const text = `${new Date().toISOString()} ${redactLogLine(line, this.home)}\n`
    try {
      this.rotate(Buffer.byteLength(text))
      appendFileSync(this.file, text)
    } catch (error) {
      void error
    }
  }

  private rotate(incoming: number): void {
    let size = 0
    try {
      size = statSync(this.file).size
    } catch {
      return
    }
    if (size + incoming <= this.maxBytes) return
    const aged = (index: number): string => join(this.dir, `${NETD_LOG_NAME}.${index}`)
    rmSync(aged(this.rotations), { force: true })
    for (let index = this.rotations - 1; index >= 1; index--)
      this.move(aged(index), aged(index + 1))
    this.move(this.file, aged(1))
  }

  private move(from: string, to: string): void {
    try {
      renameSync(from, to)
    } catch {
      return
    }
  }
}
