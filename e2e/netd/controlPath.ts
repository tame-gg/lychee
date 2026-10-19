import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface ControlPath {
  /** What to pass to `net.createServer().listen()` and `net.connect()`. */
  path: string
  /** Removes the temporary directory (Unix). A no-op on Windows, where nothing is created. */
  cleanup(): void
}

/**
 * A unique control path for one test: a Unix socket in a fresh temporary directory on Linux and
 * macOS (the socket file is unlinked when the server closes), or a named pipe
 * `\\.\pipe\lychee-netd-test-<random>` on Windows (section 2.4 names production pipes after the
 * user's SID; tests use a random suffix so parallel workers never collide).
 */
export function uniqueControlPath(): ControlPath {
  if (process.platform === 'win32') {
    return {
      path: `\\\\.\\pipe\\lychee-netd-test-${randomBytes(8).toString('hex')}`,
      cleanup: () => {}
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'lychee-netd-'))
  return {
    path: join(dir, 'netd.sock'),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}
