import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  detectTailscaleExitNode,
  parseTailscaleStatus
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
