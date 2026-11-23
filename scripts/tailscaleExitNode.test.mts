import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { win32 } from 'node:path'
import {
  detectTailscaleExitNode,
  parseTailscaleStatus,
  resolveTailscaleBinary
} from '../src/main/network/merge/tailscaleExitNode.ts'

const fixtures = join(import.meta.dirname, '../src/main/network/merge/fixtures')

const read = (name: string): string => readFileSync(join(fixtures, name), 'utf8')

test('an exit node in recorded status is active', () => {
  const status = read('tailscale-exit-node-on.json')
  assert.deepEqual(parseTailscaleStatus(status), { detected: true, active: true })
  const withoutStatus = JSON.parse(status) as {
    ExitNodeStatus?: unknown
    Peer: Record<string, { ExitNode?: boolean }>
  }
  delete withoutStatus.ExitNodeStatus
  assert.deepEqual(parseTailscaleStatus(JSON.stringify(withoutStatus)), {
    detected: true,
    active: true
  })
})

test('offering an exit node without using one is not active', () => {
  const status = read('tailscale-exit-node-off.json')
  assert.deepEqual(parseTailscaleStatus(status), { detected: true, active: false })
  const asExit = JSON.parse(status) as { Self: { ExitNode: boolean } }
  asExit.Self.ExitNode = true
  assert.deepEqual(parseTailscaleStatus(JSON.stringify(asExit)), {
    detected: true,
    active: false
  })
})

test('a missing CLI is not detected', async () => {
  const missing = Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' })
  assert.deepEqual(
    await detectTailscaleExitNode(async () => {
      throw missing
    }),
    { detected: false, active: false }
  )
  assert.deepEqual(await detectTailscaleExitNode(async () => null), {
    detected: false,
    active: false
  })
  assert.deepEqual(await detectTailscaleExitNode(async () => '   '), {
    detected: false,
    active: false
  })
})

test('malformed status JSON is not detected', () => {
  assert.deepEqual(parseTailscaleStatus(read('tailscale-malformed.txt')), {
    detected: false,
    active: false
  })
  assert.deepEqual(parseTailscaleStatus('[]'), { detected: false, active: false })
  assert.deepEqual(parseTailscaleStatus(''), { detected: false, active: false })
})

test('the CLI is the first installed candidate, otherwise the name on PATH', () => {
  const darwin = [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale'
  ]
  const checked: string[] = []
  const exists = (path: string): boolean => {
    checked.push(path)
    return path === '/usr/local/bin/tailscale'
  }
  assert.equal(resolveTailscaleBinary('darwin', {}, exists), '/usr/local/bin/tailscale')
  assert.deepEqual(checked, darwin)
  assert.equal(
    resolveTailscaleBinary('darwin', {}, (path) => path === darwin[0]),
    darwin[0]
  )
  assert.equal(
    resolveTailscaleBinary('darwin', {}, () => false),
    'tailscale'
  )

  const programFiles = 'C:\\Program Files'
  const programFilesX86 = 'C:\\Program Files (x86)'
  const windows = [
    win32.join(programFiles, 'Tailscale', 'tailscale.exe'),
    win32.join(programFilesX86, 'Tailscale', 'tailscale.exe')
  ]
  const windowsEnv = { ProgramFiles: programFiles, 'ProgramFiles(x86)': programFilesX86 }
  assert.equal(
    resolveTailscaleBinary('win32', windowsEnv, (path) => path === windows[0]),
    windows[0]
  )
  assert.equal(
    resolveTailscaleBinary('win32', windowsEnv, (path) => path === windows[1]),
    windows[1]
  )
  assert.equal(
    resolveTailscaleBinary(
      'win32',
      { 'ProgramFiles(x86)': programFilesX86 },
      (path) => path === windows[1]
    ),
    windows[1]
  )
  assert.equal(
    resolveTailscaleBinary('win32', {}, () => true),
    'tailscale'
  )

  const linux = ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale']
  assert.equal(
    resolveTailscaleBinary('linux', {}, (path) => path === linux[1]),
    linux[1]
  )
  assert.equal(
    resolveTailscaleBinary('linux', {}, () => false),
    'tailscale'
  )
})

test('a recorded exit node is active through the detector', async () => {
  const on = read('tailscale-exit-node-on.json')
  const off = read('tailscale-exit-node-off.json')
  assert.deepEqual(await detectTailscaleExitNode(async () => on), {
    detected: true,
    active: true
  })
  assert.deepEqual(await detectTailscaleExitNode(async () => off), {
    detected: true,
    active: false
  })
})
