import { EXIT_CODES, fakeNetdLaunch, type LaunchOutcome } from './netd/fakeLaunch'
import type { Sampler } from './netd/fakeNetd'
import type { Snapshot } from './netd/protocol'
import { TestClient } from './netd/testClient'
import {
  HELLO_ARGS,
  errorOf,
  expect,
  resultOf,
  test,
  type Event,
  type Response
} from './netd/harness'

/** The fake's scripting controls and the launch-outcome simulation. */

type Stats = Event<Snapshot & { dropped: number }>

const flat: Sampler = ({ adapter }) => ({
  link_in_bps: 1000 * adapter.index,
  link_out_bps: 100 * adapter.index
})

test.describe('scripted engine', () => {
  test('an adapter going down and up is reflected in stats and adapters_usable', async ({
    netd
  }) => {
    const { fake, client } = await netd.session({ sampler: flat })
    await client.request({ id: 2, cmd: 'subscribe' })
    await client.readJson()
    let stats = await client.readJson<Stats>()
    expect(stats.data.totals).toMatchObject({
      adapters_present: 2,
      adapters_usable: 2,
      link_in_bps: 16000
    })

    fake.updateAdapter('en7', { state: 'down' })
    netd.clock.advance(1000)
    stats = await client.readJson<Stats>()
    expect(stats.data.adapters.find((a) => a.name === 'en7')).toMatchObject({
      state: 'down',
      state6: 'none'
    })
    expect(stats.data.totals).toMatchObject({
      adapters_present: 2,
      adapters_usable: 1,
      link_in_bps: 16000
    })

    fake.updateAdapter('en7', { state: 'up', ip6: '2001:db8::7', state6: 'up' })
    netd.clock.advance(1000)
    stats = await client.readJson<Stats>()
    expect(stats.data.adapters.find((a) => a.name === 'en7')).toMatchObject({
      state: 'up',
      state6: 'up',
      ip6: '2001:db8::7'
    })
    expect(stats.data.totals.adapters_usable).toBe(2)
    expect(stats.data.discovery_seq).toBe(1) // link state is not a discovery change
  })

  test('adapters appearing and vanishing bump discovery_seq and the adapter list', async ({
    netd
  }) => {
    const { fake, client } = await netd.session({ sampler: flat })
    await client.request({ id: 2, cmd: 'subscribe' })
    await client.readLines(2)
    fake.addAdapter({
      name: 'en9',
      index: 20,
      ip: '172.20.10.2',
      ip6: null,
      state: 'checking',
      state6: 'none'
    })
    netd.clock.advance(1000)
    let stats = await client.readJson<Stats>()
    expect(stats.data.discovery_seq).toBe(2)
    expect(stats.data.adapters.map((a) => a.name)).toEqual(['en0', 'en7', 'en9'])
    expect(stats.data.totals).toMatchObject({ adapters_present: 3, adapters_usable: 2 })

    // Vanished with flows still active: listed with present false, out of the totals.
    fake.updateAdapter('en7', { present: false })
    netd.clock.advance(1000)
    stats = await client.readJson<Stats>()
    expect(stats.data.discovery_seq).toBe(3)
    expect(stats.data.adapters.find((a) => a.name === 'en7')?.present).toBe(false)
    expect(stats.data.totals).toMatchObject({ adapters_present: 2, link_in_bps: 4000 + 20000 })

    fake.removeAdapter('en7')
    netd.clock.advance(1000)
    stats = await client.readJson<Stats>()
    expect(stats.data.adapters.map((a) => a.name)).toEqual(['en0', 'en9'])
    expect(stats.data.discovery_seq).toBe(4)
    // A vanished adapter can no longer be excluded.
    await client.request({ id: 3, cmd: 'exclude', args: { adapter: 'en7' } })
    expect(errorOf(await client.readJson<Response>()).code).toBe('unknown_adapter')
  })

  test('the capture driver going away is a state event and makes on fail', async ({ netd }) => {
    const { fake, client } = await netd.session()
    fake.setCapture(false, 'wintun.dll not found')
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      data: { capture: { available: false, error: 'wintun.dll not found' } }
    })
    await client.request({ id: 2, cmd: 'on' })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'unsupported_platform',
      data: { error: 'wintun.dll not found' }
    })
    fake.setCapture(true)
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      data: { capture: { available: true, error: null } }
    })
  })

  test('a crash while a request executes: EOF without a response, exit code reported', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    const hold = fake.holdNext('status')
    await client.request({ id: 2, cmd: 'status' })
    await fake.nextRequest('status')
    fake.crash(137)
    await client.expectEof()
    expect(client.lines).toHaveLength(2) // hello response and state event only
    expect((await fake.exited).code).toBe(137)
    hold.release()
    await expect(netd.connect()).rejects.toThrow()
  })

  test('a slow command answers after the scripted fake time, not before', async ({ netd }) => {
    const { fake, client } = await netd.session()
    fake.setDelay('status', 2000)
    await client.request({ id: 2, cmd: 'status' })
    await fake.nextRequest('status')
    netd.clock.advance(1999)
    expect(await client.quiet(50)).toBe(true)
    netd.clock.advance(1)
    expect(await client.readJson()).toMatchObject({
      id: 2,
      ok: true,
      result: { ts: 1760000001500 }
    })
    fake.setDelay('status', 0)
    await client.request({ id: 3, cmd: 'status' })
    expect(await client.readJson()).toMatchObject({ id: 3, ok: true })
  })

  test('a held command answers when the test releases it', async ({ netd }) => {
    const { fake, client } = await netd.session()
    const hold = fake.holdNext('cleanup')
    await client.request({ id: 2, cmd: 'cleanup' })
    await client.request({ id: 3, cmd: 'status' })
    await fake.nextRequest('cleanup')
    expect(await client.quiet(100)).toBe(true)
    hold.release()
    expect(await client.readJson()).toEqual({ id: 2, ok: true, result: {} })
    expect(await client.readJson()).toMatchObject({ id: 3, ok: true })
  })

  test('a stats tick due during a slow command is delivered right after its response', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'subscribe', args: { interval_ms: 250 } })
    await client.readLines(2)
    fake.setDelay('status', 1000)
    await client.request({ id: 3, cmd: 'status' })
    await fake.nextRequest('status')
    netd.clock.advance(1000)
    const frames = (await client.readLines(2)).map((l) => JSON.parse(l))
    expect(frames[0]).toMatchObject({ id: 3, ok: true })
    // Four ticks fell due; one coalesced stats event follows, then the ticker continues.
    expect(frames[1]).toMatchObject({ event: 'stats', seq: 3, data: { ts: 1760000000500 } })
    netd.clock.advance(250)
    expect(await client.readJson()).toMatchObject({
      event: 'stats',
      seq: 4,
      data: { ts: 1760000000750 }
    })
  })

  test('the helper disconnecting the session: EOF, then the grace period runs', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    const grace = netd.once(fake, 'grace')
    fake.disconnect()
    await client.expectEof()
    await grace
    expect(fake.view.graceRunning).toBe(true)
    const again = await netd.connect()
    expect(resultOf((await netd.hello(again)).response).session).toBe(2)
    expect(fake.view.graceRunning).toBe(false)
  })

  test('a client that stops reading is disconnected after the 30 s write stall limit', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    // Fill the socket buffers with status responses the client never drains.
    const adapters = Array.from({ length: 64 }, (_, i) => ({
      name: `eth${i}`.padEnd(200, 'x'),
      index: i + 1,
      ip: '10.0.0.1',
      ip6: null,
      state: 'up' as const,
      state6: 'none' as const
    }))
    for (const a of adapters) fake.addAdapter(a)
    const grace = netd.once(fake, 'grace', 10000)
    for (let round = 0; round < 40 && !fake.view.graceRunning; round++) {
      let batch = ''
      for (let i = 0; i < 16; i++)
        batch += JSON.stringify({ id: round * 16 + i + 2, cmd: 'status' }) + '\n'
      await client.send(batch).catch(() => {})
      await new Promise((r) => setTimeout(r, 5))
      netd.clock.advance(1000)
    }
    await grace
    expect(fake.view.session).toBeNull()
    void client
  })

  test('log events are scriptable', async ({ netd }) => {
    const { fake, client } = await netd.session()
    fake.log('error', 'tun: read: file already closed')
    expect(await client.readJson()).toEqual({
      event: 'log',
      seq: 2,
      data: { level: 'error', message: 'tun: read: file already closed' }
    })
  })
})

test.describe('launch outcomes (2.7, 2.4, 3.3)', () => {
  for (const outcome of [
    'usage',
    'refused',
    'another_tool',
    'transport_failed',
    'needs_admin'
  ] as const) {
    test(`${outcome} exits ${EXIT_CODES[outcome]} with a one-line stderr and no listener`, async ({
      netd
    }) => {
      const proc = await fakeNetdLaunch({ outcome, path: netd.path })
      expect(proc.exitCode).toBe(EXIT_CODES[outcome])
      expect((await proc.exited).code).toBe(EXIT_CODES[outcome])
      expect(proc.stderr.split('\n').filter(Boolean)).toHaveLength(1)
      expect(proc.netd).toBeNull()
      expect(proc.connect).toEqual({ kind: 'unavailable' })
      await expect(TestClient.connect(netd.path, 500)).rejects.toThrow()
    })
  }

  test('another_tool carries the message clients show verbatim', async ({ netd }) => {
    const proc = await fakeNetdLaunch({ outcome: 'another_tool', path: netd.path })
    expect(proc.stderr).toBe('another connection-merging tool is running\n')
  })

  test('serve runs a fake that exits 0 on quit, with the lifecycle lines on stderr', async ({
    netd
  }) => {
    const proc = await fakeNetdLaunch({
      outcome: 'serve',
      path: netd.path,
      clock: netd.clock,
      pid: 777
    })
    expect(proc.exitCode).toBeNull()
    expect(proc.pid).toBe(777)
    expect(proc.netd).not.toBeNull()
    expect(proc.stderr).toBe(`listening on ${netd.path}\n`)
    const client = await netd.connect()
    const { response } = await netd.hello(client)
    expect(resultOf(response).pid).toBe(777)
    await client.request({ id: 2, cmd: 'quit' })
    await client.readJson()
    await client.expectEof()
    expect((await proc.exited).code).toBe(0)
    expect(proc.exitCode).toBe(0)
    expect(proc.stderr).toBe(`listening on ${netd.path}\nquit\n`)
  })

  test('serve with no client exits 0 after the startup timeout', async ({ netd }) => {
    const proc = await fakeNetdLaunch({ outcome: 'serve', path: netd.path, clock: netd.clock })
    netd.clock.advance(30000)
    expect((await proc.exited).code).toBe(0)
    expect(proc.stderr).toContain('no client connected')
  })

  test('kill is a crash: EOF for the client, exit code null', async ({ netd }) => {
    const proc = await fakeNetdLaunch({ outcome: 'serve', path: netd.path, clock: netd.clock })
    const client = await netd.connect()
    await netd.hello(client)
    await proc.kill()
    await client.expectEof()
    expect((await proc.exited).code).toBeNull()
  })

  test('peer_rejected: the client gets EOF with zero bytes, whatever it sends', async ({
    netd
  }) => {
    const proc = await fakeNetdLaunch({
      outcome: 'peer_rejected',
      path: netd.path,
      clock: netd.clock
    })
    const client = await netd.connect()
    await client.request({ id: 1, cmd: 'hello', args: HELLO_ARGS }).catch(() => {})
    await client.expectEof()
    expect(client.bytesReceived).toBe(0)
    expect(proc.exitCode).toBeNull()
    await proc.kill()
  })

  test('access_denied: the helper is alive but the pipe cannot be opened', async ({ netd }) => {
    const proc = await fakeNetdLaunch({ outcome: 'access_denied', path: netd.path })
    expect(proc.exitCode).toBeNull()
    expect(proc.connect).toEqual({
      kind: 'error',
      code: 'EACCES',
      message: expect.stringContaining('ERROR_ACCESS_DENIED')
    })
    // Nothing listens at the path the client computed.
    await expect(TestClient.connect(netd.path, 500)).rejects.toThrow()
    await proc.kill()
    expect((await proc.exited).code).toBeNull()
  })

  test('squatted: another process owns the name, accepts and never answers', async ({ netd }) => {
    const mySid = 'S-1-5-21-1004336348-1177238915-682003330-1001'
    const proc = await fakeNetdLaunch({
      outcome: 'squatted',
      path: netd.path,
      serverSid: 'S-1-5-21-1004336348-1177238915-682003330-500'
    })
    expect(proc.connect).toEqual({
      kind: 'ok',
      serverPid: 7777,
      serverSid: 'S-1-5-21-1004336348-1177238915-682003330-500'
    })
    expect(proc.connect.kind === 'ok' && proc.connect.serverSid !== mySid).toBe(true)
    const client = await netd.connect()
    await client.request({ id: 1, cmd: 'hello', args: HELLO_ARGS })
    expect(await client.quiet(200)).toBe(true)
    await proc.kill()
    await client.expectEof()
  })

  test('every outcome is one of the documented kinds', () => {
    const outcomes: LaunchOutcome[] = [
      'serve',
      'usage',
      'refused',
      'another_tool',
      'transport_failed',
      'needs_admin',
      'peer_rejected',
      'access_denied',
      'squatted'
    ]
    expect(outcomes).toHaveLength(9)
    expect(Object.values(EXIT_CODES).sort()).toEqual([0, 2, 3, 4, 5, 6])
  })
})
