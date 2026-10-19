import { LIMITS } from './netd/protocol'
import type { TestClient } from './netd/testClient'
import { HELLO_ARGS, errorOf, expect, resultOf, test, type Response } from './netd/harness'

/** Spec sections 12.2 (framing and decoding) and 12.3 (handshake and sessions). */

test.describe('framing and decoding (12.2)', () => {
  test('a line over 65536 bytes gets frame_too_large with id null, then EOF', async ({ netd }) => {
    const { client } = await netd.session()
    // Detected before the newline arrives.
    await client.send('x'.repeat(65537))
    const res = await client.readJson<Response>()
    expect(res).toEqual({
      id: null,
      ok: false,
      error: { code: 'frame_too_large', message: expect.stringContaining('65536') }
    })
    await client.expectEof()
  })

  test('a frame of exactly 65536 bytes including the newline is accepted', async ({ netd }) => {
    const { client } = await netd.session()
    const frame = '{"id":2,"cmd":"status"}'
    await client.send(frame + ' '.repeat(LIMITS.max_frame - 1 - frame.length) + '\n')
    expect(await client.readJson()).toMatchObject({ id: 2, ok: true })
    // One byte more is too large even when the newline is present.
    await client.send(frame + ' '.repeat(LIMITS.max_frame - frame.length) + '\n')
    expect(errorOf(await client.readJson<Response>()).code).toBe('frame_too_large')
    await client.expectEof()
  })

  test('invalid JSON gets bad_request, EOF', async ({ netd }) => {
    const { client } = await netd.session()
    await client.send('{"id":1,\n')
    expect(await client.readJson()).toEqual({
      id: null,
      ok: false,
      error: { code: 'bad_request', message: expect.any(String) }
    })
    await client.expectEof()
  })

  test('a non-object frame gets bad_request, EOF', async ({ netd }) => {
    const fake = await netd.start()
    for (const frame of ['[1,2]', '"x"', 'null', '42']) {
      const client = await netd.connect()
      await netd.hello(client)
      await client.send(frame + '\n')
      expect(errorOf(await client.readJson<Response>()).code).toBe('bad_request')
      await client.expectEof()
      // The session dropped: the grace period runs until the next hello.
      expect(fake.view.graceRunning).toBe(true)
    }
  })

  test('invalid UTF-8 and NUL bytes get bad_request, EOF', async ({ netd }) => {
    {
      const { client } = await netd.session()
      await client.send(
        Buffer.concat([
          Buffer.from('{"id":2,"cmd":"exclude","args":{"adapter":"'),
          Buffer.from([0xff, 0xfe]),
          Buffer.from('"}}\n')
        ])
      )
      expect(errorOf(await client.readJson<Response>()).code).toBe('bad_request')
      await client.expectEof()
    }
    {
      const client = await netd.connect()
      await netd.hello(client)
      await client.send(
        Buffer.concat([Buffer.from('{"id":2,"cmd":"status"}'), Buffer.from([0]), Buffer.from('\n')])
      )
      expect(errorOf(await client.readJson<Response>()).code).toBe('bad_request')
      await client.expectEof()
    }
  })

  test('empty lines are ignored', async ({ netd }) => {
    const { client } = await netd.session()
    await client.send('\n\n{"id":2,"cmd":"status"}\n\n')
    expect(await client.readJson()).toMatchObject({ id: 2, ok: true })
    expect(await client.quiet(100)).toBe(true)
  })

  test('an unknown top-level field is unknown_field with a dotted path; connection stays open', async ({
    netd
  }) => {
    const { client } = await netd.session()
    await client.send('{"id":2,"cmd":"status","extra":1}\n')
    expect(await client.readJson()).toEqual({
      id: 2,
      ok: false,
      error: { code: 'unknown_field', message: expect.any(String), data: { field: 'extra' } }
    })
    await client.request({ id: 3, cmd: 'status' })
    expect(await client.readJson()).toMatchObject({ id: 3, ok: true })
  })

  test('an unknown argument field is unknown_field args.<name>', async ({ netd }) => {
    const { client } = await netd.session()
    await client.request({ id: 2, cmd: 'subscribe', args: { interval: 1 } })
    expect(errorOf(await client.readJson<Response>())).toEqual({
      code: 'unknown_field',
      message: expect.any(String),
      data: { field: 'args.interval' }
    })
    // Commands without arguments reject any argument the same way.
    await client.request({ id: 3, cmd: 'status', args: { verbose: true } })
    expect(errorOf(await client.readJson<Response>()).data).toEqual({ field: 'args.verbose' })
  })

  test('wrong argument types are bad_request with the field; connection stays open', async ({
    netd
  }) => {
    const { client } = await netd.session()
    for (const enabled of ['yes', 1, null, [true]]) {
      await client.request({ id: 2, cmd: 'set_autopause', args: { enabled } })
      const err = errorOf(await client.readJson<Response>())
      expect(err.code).toBe('bad_request')
      expect(err.data).toEqual({ field: 'enabled' })
    }
    await client.request({ id: 3, cmd: 'set_autopause', args: {} })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'bad_request',
      data: { field: 'enabled' }
    })
    await client.request({ id: 4, cmd: 'status' })
    expect(await client.readJson()).toMatchObject({ id: 4, ok: true })
  })

  test('a missing, zero, negative, float, string or oversized id is bad_request, EOF', async ({
    netd
  }) => {
    const frames = [
      '{"cmd":"status"}',
      '{"id":0,"cmd":"status"}',
      '{"id":-1,"cmd":"status"}',
      '{"id":1.5,"cmd":"status"}',
      '{"id":2.0,"cmd":"status"}',
      '{"id":"2","cmd":"status"}',
      '{"id":null,"cmd":"status"}',
      '{"id":9007199254740992,"cmd":"status"}'
    ]
    await netd.start()
    for (const frame of frames) {
      const client = await netd.connect()
      await netd.hello(client)
      await client.send(frame + '\n')
      expect(await client.readJson(), frame).toEqual({
        id: null,
        ok: false,
        error: { code: 'bad_request', message: expect.any(String) }
      })
      await client.expectEof()
    }
  })

  test('a missing cmd or non-object args is bad_request with the id, EOF', async ({ netd }) => {
    await netd.start()
    for (const frame of [
      '{"id":2}',
      '{"id":2,"cmd":5}',
      '{"id":2,"cmd":"status","args":[]}',
      '{"id":2,"cmd":"status","args":"x"}',
      '{"id":2,"cmd":"status","args":null}'
    ]) {
      const client = await netd.connect()
      await netd.hello(client)
      await client.send(frame + '\n')
      expect(await client.readJson(), frame).toMatchObject({
        id: 2,
        ok: false,
        error: { code: 'bad_request' }
      })
      await client.expectEof()
    }
  })

  test('reusing an unanswered id is bad_request, EOF; an answered id may be reused', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 1, cmd: 'status' }) // hello's id, already answered
    expect(await client.readJson()).toMatchObject({ id: 1, ok: true })
    const hold = fake.holdNext('status')
    await client.request({ id: 7, cmd: 'status' })
    await fake.nextRequest('status')
    await client.request({ id: 7, cmd: 'status' })
    expect(await client.readJson()).toMatchObject({
      id: 7,
      ok: false,
      error: { code: 'bad_request' }
    })
    await client.expectEof()
    hold.release()
  })

  test('an unknown command is unknown_command with data.cmd; connection stays open', async ({
    netd
  }) => {
    const { client } = await netd.session()
    for (const cmd of ['Status', 'reboot', '']) {
      await client.request({ id: 2, cmd })
      expect(errorOf(await client.readJson<Response>())).toEqual({
        code: 'unknown_command',
        message: expect.any(String),
        data: { cmd }
      })
    }
    await client.request({ id: 3, cmd: 'status' })
    expect(await client.readJson()).toMatchObject({ id: 3, ok: true })
  })

  test('the 17th unanswered request is too_many_requests, EOF', async ({ netd }) => {
    const { fake, client } = await netd.session()
    const hold = fake.holdNext('status')
    let batch = ''
    for (let id = 1; id <= 17; id++) batch += JSON.stringify({ id, cmd: 'status' }) + '\n'
    await client.send(batch)
    expect(await client.readJson()).toEqual({
      id: 17,
      ok: false,
      error: { code: 'too_many_requests', message: expect.any(String) }
    })
    await client.expectEof()
    hold.release()
    // 16 unanswered requests are fine.
    const client2 = await netd.connect()
    await netd.hello(client2)
    const hold2 = fake.holdNext('status')
    batch = ''
    for (let id = 1; id <= 16; id++) batch += JSON.stringify({ id, cmd: 'status' }) + '\n'
    await client2.send(batch)
    await fake.nextRequest('status')
    expect(await client2.quiet(100)).toBe(true)
    hold2.release()
    const lines = await client2.readLines(16)
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([...Array(16).keys()].map((i) => i + 1))
  })

  test('responses come in request order even when the first command is slow', async ({ netd }) => {
    const { fake, client } = await netd.session()
    fake.setDelay('on', 500)
    await client.send(
      JSON.stringify({ id: 5, cmd: 'on' }) +
        '\n' +
        JSON.stringify({ id: 3, cmd: 'status' }) +
        '\n' +
        JSON.stringify({ id: 9, cmd: 'list_adapters' }) +
        '\n'
    )
    expect(await client.readJson()).toMatchObject({ event: 'state', data: { state: 'starting' } })
    expect(await client.quiet(100)).toBe(true)
    netd.clock.advance(500)
    expect(await client.readJson()).toMatchObject({ event: 'state', data: { state: 'on' } })
    const ids = (await client.readLines(3)).map((l) => JSON.parse(l).id)
    expect(ids).toEqual([5, 3, 9])
  })
})

test.describe('handshake and sessions (12.3)', () => {
  test('a first request other than hello is hello_required, EOF', async ({ netd }) => {
    await netd.start()
    const client = await netd.connect()
    await client.request({ id: 1, cmd: 'status' })
    expect(await client.readJson()).toEqual({
      id: 1,
      ok: false,
      error: { code: 'hello_required', message: expect.any(String) }
    })
    await client.expectEof()
  })

  test('every error before hello closes the connection', async ({ netd }) => {
    await netd.start()
    for (const frame of [
      '{"id":1,"cmd":"hello","args":{"protocol":[1],"client":"lychee","client_version":"0.2.0"},"x":1}',
      '{"id":1,"cmd":"hello","args":{"protocol":[1],"client":"lychee","client_version":"0.2.0","extra":1}}',
      '{"id":1,"cmd":"hello","args":{"protocol":[1],"client":"lychee"}}'
    ]) {
      const client = await netd.connect()
      await client.send(frame + '\n')
      const err = errorOf(await client.readJson<Response>())
      expect(['unknown_field', 'bad_request']).toContain(err.code)
      await client.expectEof()
    }
  })

  test('no hello within 5000 ms closes with hello_required', async ({ netd }) => {
    const fake = await netd.start()
    const client = await netd.connect()
    await fake.waitForConnections(1)
    netd.clock.advance(4999)
    expect(await client.quiet(50)).toBe(true)
    netd.clock.advance(1)
    expect(await client.readJson()).toEqual({
      id: null,
      ok: false,
      error: { code: 'hello_required', message: expect.any(String) }
    })
    await client.expectEof()
  })

  test('no common protocol version is version_unsupported with data.supported, EOF', async ({
    netd
  }) => {
    await netd.start()
    const client = await netd.connect()
    const { response } = await netd.hello(client, { ...HELLO_ARGS, protocol: [2] })
    expect(response).toEqual({
      id: 1,
      ok: false,
      error: { code: 'version_unsupported', message: expect.any(String), data: { supported: [1] } }
    })
    await client.expectEof()
  })

  test('negotiation picks the highest common version', async ({ netd }) => {
    {
      await netd.start()
      const client = await netd.connect()
      const { response } = await netd.hello(client, { ...HELLO_ARGS, protocol: [1, 7] })
      expect(resultOf(response).protocol).toBe(1)
    }
  })

  test('negotiation on a helper speaking several versions', async ({ netd }) => {
    await netd.start({ supportedProtocols: [1, 2, 3] })
    const client = await netd.connect()
    const { response } = await netd.hello(client, { ...HELLO_ARGS, protocol: [7, 3, 1] })
    expect(resultOf(response).protocol).toBe(3)
  })

  test('hello argument validation is bad_request with the field, EOF', async ({ netd }) => {
    await netd.start()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...HELLO_ARGS, client: 'a b' }, 'client'],
      [{ ...HELLO_ARGS, client: '' }, 'client'],
      [{ ...HELLO_ARGS, client: 'x'.repeat(33) }, 'client'],
      [{ ...HELLO_ARGS, client_version: '0.2.0/beta' }, 'client_version'],
      [{ ...HELLO_ARGS, protocol: [] }, 'protocol'],
      [{ ...HELLO_ARGS, protocol: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, 'protocol'],
      [{ ...HELLO_ARGS, protocol: [1, 1] }, 'protocol'],
      [{ ...HELLO_ARGS, protocol: [0] }, 'protocol'],
      [{ ...HELLO_ARGS, protocol: [1001] }, 'protocol'],
      [{ ...HELLO_ARGS, protocol: [1.5] }, 'protocol'],
      [{ ...HELLO_ARGS, protocol: ['1'] }, 'protocol'],
      [{ ...HELLO_ARGS, protocol: 1 }, 'protocol'],
      [{ client: 'lychee', client_version: '0.2.0' }, 'protocol']
    ]
    for (const [args, field] of cases) {
      const client = await netd.connect()
      const { response } = await netd.hello(client, args)
      expect(errorOf(response), JSON.stringify(args)).toMatchObject({
        code: 'bad_request',
        data: { field }
      })
      await client.expectEof()
    }
  })

  test('the hello result carries every field of section 5.2 with the documented types', async ({
    netd
  }) => {
    const { hello } = await netd.session()
    const result = resultOf(hello.response)
    expect(result).toEqual({
      protocol: 1,
      helper_version: '0.2.0',
      os: 'darwin',
      arch: 'arm64',
      pid: 5120,
      instance: expect.stringMatching(/^[0-9a-f]{32}$/),
      session: 1,
      auth: { model: 'unix_peer_uid', privilege: 'root', authorized_uid: 501 },
      capabilities: ['link_counters', 'keep_adapter_on_off'],
      limits: {
        max_frame: 65536,
        max_in_flight: 16,
        hello_timeout_ms: 5000,
        grace_ms: 10000,
        startup_timeout_ms: 30000,
        stats_interval_ms: { min: 250, max: 5000, default: 1000 },
        weight: { min: 0.05, max: 100 }
      },
      capture: { available: true, error: null }
    })
    expect(Object.keys(result)).toEqual([
      'protocol',
      'helper_version',
      'os',
      'arch',
      'pid',
      'instance',
      'session',
      'auth',
      'capabilities',
      'limits',
      'capture'
    ])
  })

  test('a Windows identity reports windows_pipe_sid and the authorized SID', async ({ netd }) => {
    const sid = 'S-1-5-21-1004336348-1177238915-682003330-1001'
    const { hello } = await netd.session({
      os: 'windows',
      arch: 'amd64',
      auth: { model: 'windows_pipe_sid', privilege: 'elevated', authorized_sid: sid },
      tunName: 'lychee-netd',
      capabilities: ['link_counters']
    })
    expect(resultOf(hello.response)).toMatchObject({
      os: 'windows',
      auth: { model: 'windows_pipe_sid', privilege: 'elevated', authorized_sid: sid }
    })
  })

  test('the first frame after the hello response is a state event with seq 1', async ({ netd }) => {
    const { hello } = await netd.session()
    expect(hello.state).toEqual({
      event: 'state',
      seq: 1,
      data: {
        ts: 1759999999500,
        state: 'off',
        state_since: 1759999999500,
        error: null,
        capture: { available: true, error: null },
        autopause: { enabled: true, status: 'manual_off' },
        ipv6: {
          mode: 'auto',
          effective: 'refused',
          detail: expect.stringContaining('auto: refused')
        },
        tun: { name: null, open: false }
      }
    })
    expect(Object.keys(hello.state.data)).toEqual([
      'ts',
      'state',
      'state_since',
      'error',
      'capture',
      'autopause',
      'ipv6',
      'tun'
    ])
  })

  test('a second hello on a session is invalid_state; the session continues', async ({ netd }) => {
    const { client } = await netd.session()
    await client.request({ id: 2, cmd: 'hello', args: HELLO_ARGS })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'invalid_state',
      data: { state: 'off' }
    })
    await client.request({ id: 3, cmd: 'status' })
    expect(await client.readJson()).toMatchObject({ id: 3, ok: true })
  })

  test('a second connection gets busy with the session pid; the first is unaffected', async ({
    netd
  }) => {
    const { client } = await netd.session({ clientPid: 31337 })
    const second = await netd.connect()
    const { response } = await netd.hello(second)
    expect(response).toEqual({
      id: 1,
      ok: false,
      error: {
        code: 'busy',
        message: 'another client session is active',
        data: { session_pid: 31337 }
      }
    })
    await second.expectEof()
    await client.request({ id: 2, cmd: 'status' })
    expect(await client.readJson()).toMatchObject({ id: 2, ok: true })
    // A later connection can take over once the session ends.
    client.close()
    const third = await netd.connect()
    expect(resultOf((await netd.hello(third)).response).session).toBe(2)
  })

  test('a fifth connection awaiting hello is closed without bytes', async ({ netd }) => {
    const fake = await netd.start()
    const pending: TestClient[] = []
    for (let i = 1; i <= 4; i++) {
      pending.push(await netd.connect())
      await fake.waitForConnections(i)
    }
    const fifth = await netd.connect()
    await fifth.expectEof()
    expect(fifth.bytesReceived).toBe(0)
    // The four are still fine; one of them can become the session.
    const { response } = await netd.hello(pending[3])
    expect(resultOf(response).session).toBe(1)
    // With one slot free again, a new connection is accepted.
    const sixth = await netd.connect()
    await fake.waitForConnections(6)
    expect(await sixth.quiet(50)).toBe(true)
  })

  test('a session that drops without quit exits the helper after the 10 s grace period', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'on' })
    await client.readLines(3)
    expect(fake.view.state).toBe('on')
    const grace = netd.once(fake, 'grace')
    client.close()
    await grace
    netd.clock.advance(9999)
    expect(fake.view.exited).toBe(false)
    netd.clock.advance(1)
    expect((await fake.exited).code).toBe(0)
    expect(fake.view.state).toBe('off')
    await expect(netd.connect()).rejects.toThrow()
  })

  test('a reconnect within the grace period finds the same instance and its state', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'subscribe' })
    await client.readLines(2)
    await client.request({ id: 3, cmd: 'on' })
    await client.readLines(3)
    await client.request({ id: 4, cmd: 'exclude', args: { adapter: 'en7' } })
    await client.readJson()
    await client.request({ id: 5, cmd: 'set_weight', args: { adapter: 'en0', weight: 3 } })
    await client.readJson()
    await client.request({ id: 6, cmd: 'set_ipv6', args: { mode: 'off' } })
    await client.readJson()

    const grace = netd.once(fake, 'grace')
    client.close()
    await grace
    netd.clock.advance(9000)

    const again = await netd.connect()
    const { response, state } = await netd.hello(again)
    const result = resultOf(response)
    expect(result.instance).toBe('3f9c2a7e5b1d4c6a8e0f1a2b3c4d5e6f')
    expect(result.session).toBe(2)
    expect(state).toMatchObject({ seq: 1, data: { state: 'on', ipv6: { mode: 'off' } } })
    await again.request({ id: 2, cmd: 'status' })
    const status = resultOf(await again.readJson<Response>())
    expect(status.state).toBe('on')
    const adapters = status.adapters as Array<Record<string, unknown>>
    expect(adapters.find((a) => a.name === 'en7')).toMatchObject({ excluded: true })
    expect(adapters.find((a) => a.name === 'en0')).toMatchObject({
      weight_mode: 'manual',
      weight: 3
    })
    // No subscription carries over: a few intervals pass without stats.
    netd.clock.advance(3000)
    expect(await again.quiet(100)).toBe(true)
    expect(fake.view.graceRunning).toBe(false)
  })

  test('a connection that fails hello during the grace period restarts the full 10 s', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    const grace = netd.once(fake, 'grace')
    client.close()
    await grace
    netd.clock.advance(8000)
    const retry = await netd.connect()
    await fake.waitForConnections(2)
    expect(fake.view.graceRunning).toBe(false)
    const graceAgain = netd.once(fake, 'grace')
    await retry.send('garbage\n')
    expect(errorOf(await retry.readJson<Response>()).code).toBe('bad_request')
    await retry.expectEof()
    await graceAgain
    netd.clock.advance(9999)
    expect(fake.view.exited).toBe(false)
    netd.clock.advance(1)
    expect((await fake.exited).code).toBe(0)
  })

  test('with no client for 30 s the helper exits 0', async ({ netd }) => {
    const fake = await netd.start()
    netd.clock.advance(29999)
    expect(fake.view.exited).toBe(false)
    netd.clock.advance(1)
    expect((await fake.exited).code).toBe(0)
  })

  test('the first accepted connection cancels the startup timer', async ({ netd }) => {
    const fake = await netd.start()
    const client = await netd.connect()
    await fake.waitForConnections(1)
    netd.clock.advance(30000)
    expect(fake.view.exited).toBe(false)
    // (The connection itself timed out on hello at 5 s.)
    expect(errorOf(await client.readJson<Response>()).code).toBe('hello_required')
  })

  test('quit answers, closes the connection and exits 0; nothing listens afterwards', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    // Off with no adapter open: quit changes nothing, so no state event precedes the response.
    await client.request({ id: 2, cmd: 'quit' })
    expect(await client.readJson()).toEqual({ id: 2, ok: true, result: {} })
    await client.expectEof()
    expect((await fake.exited).code).toBe(0)
    await expect(netd.connect()).rejects.toThrow()
  })

  test('quit while on turns off first: state event, response, EOF', async ({ netd }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'on' })
    await client.readLines(3)
    const other = await netd.connect() // a pending connection is closed too
    await fake.waitForConnections(2)
    await client.request({ id: 3, cmd: 'quit' })
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      seq: 4,
      data: { state: 'off', autopause: { status: 'manual_off' }, tun: { name: null, open: false } }
    })
    expect(await client.readJson()).toEqual({ id: 3, ok: true, result: {} })
    await client.expectEof()
    await other.expectEof()
    expect((await fake.exited).code).toBe(0)
  })
})
