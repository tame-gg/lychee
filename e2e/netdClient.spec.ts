import { connect, createServer, type Socket } from 'node:net'
import { ConnectionClosedError, NetdClient, NetdError } from '../src/main/network/merge/netdClient'
import type { LogEntry, StateInfo, StatsData } from '../src/main/network/merge/protocol'
import { uniqueControlPath } from './netd/controlPath'
import type { FakeNetd, FakeNetdOptions } from './netd/fakeNetd'
import { expect, test, type NetdHarness } from './netd/harness'

const CLIENT_VERSION = '0.2.0'

interface Tap {
  connect: (path: string) => Socket
  sent: string[]
  received: string[]
}

function tap(): Tap {
  const sent: string[] = []
  const received: string[] = []
  let inbound = ''
  return {
    sent,
    received,
    connect: (path) => {
      const socket = connect(path)
      const write = socket.write.bind(socket) as (...args: unknown[]) => boolean
      socket.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        sent.push(...String(chunk).split('\n').filter(Boolean))
        return write(chunk, ...rest)
      }) as typeof socket.write
      socket.on('data', (chunk: Buffer) => {
        inbound += chunk.toString('utf8')
        for (;;) {
          const newline = inbound.indexOf('\n')
          if (newline === -1) break
          received.push(inbound.slice(0, newline))
          inbound = inbound.slice(newline + 1)
        }
      })
      return socket
    }
  }
}

function nextEvent<K extends 'state' | 'stats' | 'log' | 'close'>(
  client: NetdClient,
  event: K
): Promise<
  K extends 'state'
    ? StateInfo
    : K extends 'stats'
      ? StatsData
      : K extends 'log'
        ? LogEntry
        : ConnectionClosedError
> {
  return new Promise((resolve) => client.once(event, resolve as never))
}

async function session(
  netd: NetdHarness,
  fakeOptions: Partial<Omit<FakeNetdOptions, 'path' | 'clock'>> = {},
  clientOptions: Partial<Parameters<typeof NetdClient.connect>[0]> = {}
): Promise<{ fake: FakeNetd; client: NetdClient }> {
  const fake = await netd.start(fakeOptions)
  const client = await NetdClient.connect({
    path: netd.path,
    clientVersion: CLIENT_VERSION,
    ...clientOptions
  })
  await client.handshake()
  return { fake, client }
}

type Expected = { exact: string } | { fragments: string[] }

function matches(line: string, expected: Expected): void {
  if ('exact' in expected) {
    expect(line).toBe(expected.exact)
    return
  }
  const { fragments } = expected
  expect(line.startsWith(fragments[0]), `${line} should start with ${fragments[0]}`).toBe(true)
  expect(line.endsWith(fragments.at(-1)!), `${line} should end with ${fragments.at(-1)}`).toBe(true)
  let from = 0
  for (const fragment of fragments) {
    const at = line.indexOf(fragment, from)
    expect(at, `${fragment} not found in order in ${line}`).toBeGreaterThanOrEqual(0)
    from = at + fragment.length
  }
}

test('Appendix B: the client sends the exact request frames and understands the exact responses', async ({
  netd
}) => {
  const { clock } = netd
  const fake = await netd.start()
  const wire = tap()
  clock.advance(500)
  const client = await NetdClient.connect({
    path: netd.path,
    clientVersion: CLIENT_VERSION,
    connect: wire.connect
  })

  const hello = await client.handshake()
  expect(hello).toMatchObject({
    protocol: 1,
    helper_version: '0.2.0',
    instance: '3f9c2a7e5b1d4c6a8e0f1a2b3c4d5e6f',
    session: 1,
    limits: { grace_ms: 10000, max_in_flight: 16 }
  })
  await expect.poll(() => client.lastState?.state).toBe('off')

  clock.advance(10)
  const firstStats = nextEvent(client, 'stats')
  expect(await client.request('subscribe', { interval_ms: 1000 })).toEqual({ interval_ms: 1000 })
  const stats = await firstStats
  expect(stats.adapters.map((adapter) => adapter.name)).toEqual(['en0', 'en7'])
  expect(stats).toMatchObject({ state: 'off', discovery_seq: 1, dropped: 0 })

  expect(await client.request('set_ipv6', { mode: 'auto' })).toEqual({
    mode: 'auto',
    effective: 'refused'
  })
  expect(await client.request('exclude', { adapter: 'en7' })).toEqual({
    adapter: 'en7',
    excluded: true
  })

  clock.advance(990)
  fake.setDelay('on', 350)
  const states: StateInfo[] = []
  client.on('state', (info) => states.push(info))
  const seen = fake.nextRequest('on')
  const turningOn = client.request('on')
  await seen
  clock.advance(350)
  expect(await turningOn).toEqual({ state: 'on' })
  expect(states.map((info) => info.state)).toEqual(['starting', 'on'])
  expect(states[1]).toMatchObject({
    ts: 1760000001350,
    autopause: { enabled: true, status: 'held' },
    tun: { name: 'utun5', open: true }
  })

  await expect(client.request('exclude', { adapter: 'en9' })).rejects.toMatchObject({
    name: 'NetdError',
    code: 'unknown_adapter',
    message: 'no adapter named "en9"',
    data: { adapter: 'en9' }
  })
  await expect(client.request('cleanup')).rejects.toMatchObject({
    code: 'invalid_state',
    data: { state: 'on' }
  })

  clock.jumpTo(1760000020000)
  const closing = nextEvent(client, 'close')
  expect(await client.quit()).toBe(true)
  expect((await closing).reason).toBe('quit')
  expect(client.lastState).toMatchObject({ state: 'off', tun: { name: null, open: false } })
  expect((await fake.exited).code).toBe(0)

  expect(wire.sent).toEqual([
    '{"id":1,"cmd":"hello","args":{"protocol":[1],"client":"lychee","client_version":"0.2.0"}}',
    '{"id":2,"cmd":"subscribe","args":{"interval_ms":1000}}',
    '{"id":3,"cmd":"set_ipv6","args":{"mode":"auto"}}',
    '{"id":4,"cmd":"exclude","args":{"adapter":"en7"}}',
    '{"id":5,"cmd":"on"}',
    '{"id":6,"cmd":"exclude","args":{"adapter":"en9"}}',
    '{"id":7,"cmd":"cleanup"}',
    '{"id":8,"cmd":"quit"}'
  ])
  const expected: Expected[] = [
    {
      exact:
        '{"id":1,"ok":true,"result":{"protocol":1,"helper_version":"0.2.0","os":"darwin","arch":"arm64","pid":5120,"instance":"3f9c2a7e5b1d4c6a8e0f1a2b3c4d5e6f","session":1,"auth":{"model":"unix_peer_uid","privilege":"root","authorized_uid":501},"capabilities":["link_counters","keep_adapter_on_off"],"limits":{"max_frame":65536,"max_in_flight":16,"hello_timeout_ms":5000,"grace_ms":10000,"startup_timeout_ms":30000,"stats_interval_ms":{"min":250,"max":5000,"default":1000},"weight":{"min":0.05,"max":100}},"capture":{"available":true,"error":null}}}'
    },
    {
      exact:
        '{"event":"state","seq":1,"data":{"ts":1760000000000,"state":"off","state_since":1759999999500,"error":null,"capture":{"available":true,"error":null},"autopause":{"enabled":true,"status":"manual_off"},"ipv6":{"mode":"auto","effective":"refused","detail":"auto: refused, apps fall back to IPv4 so every adapter is used (not every adapter has IPv6)"},"tun":{"name":null,"open":false}}}'
    },
    { exact: '{"id":2,"ok":true,"result":{"interval_ms":1000}}' },
    {
      fragments: [
        '{"event":"stats","seq":2,"data":{"ts":1760000000010,"state":"off",',
        '"adapters":[{"name":"en0",',
        '},{"name":"en7",',
        '}],"discovery_seq":1,"dropped":0}}'
      ]
    },
    { exact: '{"id":3,"ok":true,"result":{"mode":"auto","effective":"refused"}}' },
    { exact: '{"id":4,"ok":true,"result":{"adapter":"en7","excluded":true}}' },
    {
      fragments: ['{"event":"state","seq":3,"data":{"ts":1760000001000,"state":"starting",', '}}']
    },
    {
      fragments: [
        '{"event":"state","seq":4,"data":{"ts":1760000001350,"state":"on","state_since":1760000001350,',
        '"autopause":{"enabled":true,"status":"held"}',
        '"tun":{"name":"utun5","open":true}}}'
      ]
    },
    { exact: '{"id":5,"ok":true,"result":{"state":"on"}}' },
    { fragments: ['{"event":"stats","seq":5,"data":{', '"state":"on",', '}}'] },
    {
      exact:
        '{"id":6,"ok":false,"error":{"code":"unknown_adapter","message":"no adapter named \\"en9\\"","data":{"adapter":"en9"}}}'
    },
    {
      exact:
        '{"id":7,"ok":false,"error":{"code":"invalid_state","message":"cleanup is only allowed while off","data":{"state":"on"}}}'
    },
    {
      fragments: [
        '{"event":"state","seq":6,"data":{"ts":1760000020000,"state":"off",',
        '"tun":{"name":null,"open":false}}}'
      ]
    },
    { exact: '{"id":8,"ok":true,"result":{}}' }
  ]
  expect(wire.received).toHaveLength(expected.length)
  expected.forEach((line, index) => matches(wire.received[index], line))
})

test.describe('handshake', () => {
  test('a helper that speaks only another protocol version is refused', async ({ netd }) => {
    await netd.start({ supportedProtocols: [2] })
    const client = await NetdClient.connect({ path: netd.path, clientVersion: CLIENT_VERSION })
    const closing = nextEvent(client, 'close')
    await expect(client.handshake()).rejects.toMatchObject({
      code: 'version_unsupported',
      data: { supported: [2] }
    })
    expect((await closing).reason).toBe('eof')
    expect(client.hello).toBeNull()
  })

  test('busy: a second client is refused and the first keeps working', async ({ netd }) => {
    const { client: first } = await session(netd)
    const second = await NetdClient.connect({ path: netd.path, clientVersion: CLIENT_VERSION })
    await expect(second.handshake()).rejects.toMatchObject({
      code: 'busy',
      data: { session_pid: 4098 }
    })
    await expect.poll(() => second.closed).toBe(true)
    expect(await first.request('status')).toMatchObject({ state: 'off' })
  })

  test('the limits come from the helper', async ({ netd }) => {
    const { client } = await session(netd)
    expect(client.limits).toEqual({
      max_frame: 65536,
      max_in_flight: 16,
      hello_timeout_ms: 5000,
      grace_ms: 10000,
      startup_timeout_ms: 30000,
      stats_interval_ms: { min: 250, max: 5000, default: 1000 },
      weight: { min: 0.05, max: 100 }
    })
  })

  test('a peer the helper rejects sees EOF before any answer', async ({ netd }) => {
    await netd.start({ rejectPeers: true })
    const client = await NetdClient.connect({ path: netd.path, clientVersion: CLIENT_VERSION })
    await expect(client.handshake()).rejects.toBeInstanceOf(ConnectionClosedError)
    expect(client.closed).toBe(true)
  })

  test('a request on a closed connection is rejected at once', async ({ netd }) => {
    const { client } = await session(netd)
    client.close()
    await expect(client.request('status')).rejects.toMatchObject({ reason: 'local' })
  })
})

test.describe('requests', () => {
  test('pipelined requests are answered in order with at most 16 in flight', async ({ netd }) => {
    const { fake, client } = await session(netd)
    const answered: Array<number | null> = []
    fake.on('response', (frame: { id: number | null }) => answered.push(frame.id))
    const hold = fake.holdNext('status')
    const results = Array.from({ length: 20 }, () => client.request('status'))
    await expect.poll(() => client.unanswered).toBe(20)
    await expect.poll(() => fake.view.session).toBe(1)
    hold.release()
    expect(await Promise.all(results)).toHaveLength(20)
    expect(answered).toEqual(Array.from({ length: 20 }, (_, index) => index + 2))
    expect(client.closed).toBe(false)
  })

  test('an unanswered command times out and the connection is given up', async ({ netd }) => {
    const { fake, client } = await session(netd, {}, { commandTimeoutMs: 150 })
    const hold = fake.holdNext('status')
    const closing = nextEvent(client, 'close')
    await expect(client.request('status')).rejects.toMatchObject({ reason: 'timeout' })
    expect((await closing).reason).toBe('timeout')
    hold.release()
  })

  test('the helper dropping the session rejects what was pending', async ({ netd }) => {
    const { fake, client } = await session(netd)
    const hold = fake.holdNext('status')
    const seen = fake.nextRequest('status')
    const pending = client.request('status')
    await seen
    fake.disconnect()
    await expect(pending).rejects.toMatchObject({ reason: 'eof' })
    expect(client.closed).toBe(true)
    hold.release()
  })

  test('errors carry the code, message and data of the helper', async ({ netd }) => {
    const { client } = await session(netd)
    const error = await client.request('subscribe', { interval_ms: 1 }).catch((e) => e)
    expect(error).toBeInstanceOf(NetdError)
    expect(error).toMatchObject({
      code: 'out_of_range',
      data: { field: 'interval_ms', min: 250, max: 5000 }
    })
    expect(client.closed).toBe(false)
  })
})

test.describe('events', () => {
  test('state, stats and log events are delivered as they come', async ({ netd }) => {
    const { fake, client } = await session(netd)
    const firstStats = nextEvent(client, 'stats')
    await client.request('subscribe')
    expect((await firstStats).totals.adapters_present).toBe(2)
    const nextStats = nextEvent(client, 'stats')
    netd.clock.advance(1000)
    expect((await nextStats).ts).toBe(1759999999500 + 1000)
    const log = nextEvent(client, 'log')
    fake.log('warn', 'IPv6 not captured')
    expect(await log).toEqual({ level: 'warn', message: 'IPv6 not captured' })
    const state = nextEvent(client, 'state')
    await client.request('set_autopause', { enabled: false })
    expect((await state).autopause).toEqual({ enabled: false, status: 'disabled' })
  })

  test('dropped events show in the stats and a seq gap is logged', async ({ netd }) => {
    const lines: string[] = []
    const { fake, client } = await session(netd, {}, { log: (line) => lines.push(line) })
    await client.request('subscribe')
    fake.dropEvents(3)
    const stats = nextEvent(client, 'stats')
    netd.clock.advance(1000)
    expect((await stats).dropped).toBe(3)
    expect(lines.some((line) => line.includes('3 event(s) missing'))).toBe(true)
  })
})

test.describe('quit', () => {
  test('quit waits for the response and the close', async ({ netd }) => {
    const { fake, client } = await session(netd)
    expect(await client.quit()).toBe(true)
    expect(client.closeError?.reason).toBe('quit')
    expect((await fake.exited).code).toBe(0)
  })

  test('a helper that dies during quit still lets quit finish', async ({ netd }) => {
    const { fake, client } = await session(netd)
    fake.holdNext('quit')
    const seen = fake.nextRequest('quit')
    const quitting = client.quit(2000)
    await seen
    fake.crash()
    expect(await quitting).toBe(true)
    expect(client.closed).toBe(true)
  })

  test('a helper that never closes after quit is given up within the budget', async ({ netd }) => {
    const { fake, client } = await session(netd)
    fake.holdNext('quit')
    const started = Date.now()
    expect(await client.quit(300)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(client.closeError?.reason).toBe('local')
  })
})

test.describe('framing', () => {
  async function rawServer(
    serve: (socket: Socket) => void
  ): Promise<{ path: string; close: () => void }> {
    const control = uniqueControlPath()
    const server = createServer((socket) => {
      socket.on('error', () => {})
      serve(socket)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(control.path, () => resolve())
    })
    return {
      path: control.path,
      close: () => {
        server.close()
        control.cleanup()
      }
    }
  }

  for (const [label, frame] of [
    ['a line over the frame limit', 'x'.repeat(70000)],
    ['a line that is not JSON', '{"id":1,'],
    ['a frame that is not an object', '[1,2]'],
    ['a response without ok', '{"id":1,"result":{}}'],
    ['an event without data', '{"event":"state","seq":1}']
  ] as const) {
    test(`${label} from the helper closes the connection with a protocol error`, async () => {
      const server = await rawServer((socket) => socket.write(frame + '\n'))
      try {
        const client = await NetdClient.connect({
          path: server.path,
          clientVersion: CLIENT_VERSION
        })
        const closing = nextEvent(client, 'close')
        expect((await closing).reason).toBe('protocol')
      } finally {
        server.close()
      }
    })
  }

  test('an error with id null rejects what was pending and closes', async () => {
    const server = await rawServer((socket) => {
      socket.on('data', () => {
        socket.end(
          '{"id":null,"ok":false,"error":{"code":"frame_too_large","message":"frame exceeds 65536 bytes"}}\n'
        )
      })
    })
    try {
      const client = await NetdClient.connect({ path: server.path, clientVersion: CLIENT_VERSION })
      await expect(client.handshake()).rejects.toMatchObject({
        reason: 'protocol',
        message: 'frame_too_large: frame exceeds 65536 bytes'
      })
    } finally {
      server.close()
    }
  })

  test('empty lines and unknown events are ignored, split frames are reassembled', async () => {
    const hello =
      '{"id":1,"ok":true,"result":{"protocol":1,"helper_version":"0.2.0","os":"linux","arch":"amd64","pid":1,"instance":"00000000000000000000000000000000","session":1,"auth":{"model":"unix_peer_uid","privilege":"root","authorized_uid":1},"capabilities":[],"limits":{},"capture":{"available":true,"error":null}}}'
    const server = await rawServer((socket) => {
      socket.on('data', () => {
        socket.write('\n\n{"event":"future","seq":1,"data":{}}\n' + hello.slice(0, 40))
        setTimeout(() => socket.write(hello.slice(40) + '\n'), 20)
      })
    })
    try {
      const client = await NetdClient.connect({ path: server.path, clientVersion: CLIENT_VERSION })
      const result = await client.handshake()
      expect(result.helper_version).toBe('0.2.0')
      expect(client.limits.max_in_flight).toBe(16)
      expect(client.closed).toBe(false)
    } finally {
      server.close()
    }
  })
})
