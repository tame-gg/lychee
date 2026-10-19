import { connect, type Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'

/** Write/socket errors that just mean "the helper closed on us", not a test failure. */
const BENIGN_CLOSE = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'EBADF'
])

function isBenignClose(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code !== undefined && BENIGN_CLOSE.has(code)
}

/**
 * A deliberately dumb client for driving the fake helper from tests: raw bytes out, raw lines in.
 * It is NOT the real netd client (src/main/network/merge/netdClient.ts, plan item L-3) and does
 * nothing the protocol asks a client to do by itself (no hello, no reconnect, no frame limit).
 */
export class TestClient {
  /** Every line received so far, newline stripped, in order. */
  readonly lines: string[] = []
  /** Total bytes received, so a test can assert "EOF with zero bytes". */
  bytesReceived = 0
  private readonly pending: string[] = []
  private readonly decoder = new StringDecoder('utf8')
  private partial = ''
  private eof = false
  private error: Error | null = null
  private wake: (() => void) | null = null

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.bytesReceived += chunk.length
      this.partial += this.decoder.write(chunk)
      for (;;) {
        const nl = this.partial.indexOf('\n')
        if (nl === -1) break
        const line = this.partial.slice(0, nl)
        this.partial = this.partial.slice(nl + 1)
        this.lines.push(line)
        this.pending.push(line)
      }
      this.wake?.()
    })
    socket.on('end', () => {
      this.eof = true
      this.wake?.()
    })
    socket.on('close', () => {
      this.eof = true
      this.wake?.()
    })
    socket.on('error', (err) => {
      // A rejected peer makes the write fail with EPIPE/ECONNRESET; that is a clean close here.
      if (!isBenignClose(err)) this.error = err
      this.eof = true
      this.wake?.()
    })
  }

  static connect(path: string, timeoutMs = 5000): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(path)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`connect to ${path} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(new TestClient(socket))
      })
      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  /** True once the helper closed the connection (or it failed). */
  get closed(): boolean {
    return this.eof
  }

  /**
   * Writes raw bytes, exactly as given (no newline is added). A write to a socket the helper
   * already closed (a rejected peer) resolves quietly: the point of such a test is that the bytes
   * go nowhere, which the following expectEof() verifies.
   */
  send(raw: string | Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) return resolve()
      this.socket.write(raw, (err) => (err && !isBenignClose(err) ? reject(err) : resolve()))
    })
  }

  /** Stops draining the socket, so the helper's writes back up (for the write-stall test). */
  pauseReading(): void {
    this.socket.pause()
  }

  /** Sends one JSON frame: the object plus `\n`. */
  request(frame: object): Promise<void> {
    return this.send(JSON.stringify(frame) + '\n')
  }

  /** The next line (without its newline). Rejects on EOF or after `timeoutMs` of real time. */
  readLine(timeoutMs = 2000): Promise<string> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        if (this.pending.length) {
          resolve(this.pending.shift()!)
          return true
        }
        if (this.eof) {
          reject(
            this.error ??
              new Error(`EOF while waiting for a line; received so far: ${this.describe()}`)
          )
          return true
        }
        return false
      }
      if (check()) return
      const timer = setTimeout(() => {
        this.wake = null
        reject(new Error(`no line within ${timeoutMs} ms; received so far: ${this.describe()}`))
      }, timeoutMs)
      this.wake = () => {
        if (check()) {
          clearTimeout(timer)
          this.wake = null
        }
      }
    })
  }

  async readJson<T = Record<string, unknown>>(timeoutMs = 2000): Promise<T> {
    return JSON.parse(await this.readLine(timeoutMs)) as T
  }

  async readLines(count: number, timeoutMs = 2000): Promise<string[]> {
    const out: string[] = []
    for (let i = 0; i < count; i++) out.push(await this.readLine(timeoutMs))
    return out
  }

  /** Resolves when the helper closes the connection with no further line; rejects on a line. */
  expectEof(timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        if (this.pending.length) {
          reject(new Error(`expected EOF but received a line: ${this.pending[0]}`))
          return true
        }
        if (this.eof) {
          // Benign close errors are filtered out before they reach this.error.
          if (this.error) reject(this.error)
          else resolve()
          return true
        }
        return false
      }
      if (check()) return
      const timer = setTimeout(() => {
        this.wake = null
        reject(new Error(`no EOF within ${timeoutMs} ms; received: ${this.describe()}`))
      }, timeoutMs)
      this.wake = () => {
        if (check()) {
          clearTimeout(timer)
          this.wake = null
        }
      }
    })
  }

  /** Resolves true if a line arrives within the window, false if nothing does (and no EOF). */
  async quiet(windowMs: number): Promise<boolean> {
    try {
      await this.readLine(windowMs)
      return false
    } catch (err) {
      if (/no line within/.test((err as Error).message)) return true
      throw err
    }
  }

  /** Half-closes from the client side (the helper sees EOF). */
  end(): void {
    this.socket.end()
  }

  close(): void {
    this.socket.destroy()
  }

  private describe(): string {
    return this.lines.length ? this.lines.map((l) => l.slice(0, 200)).join(' | ') : '(nothing)'
  }
}
