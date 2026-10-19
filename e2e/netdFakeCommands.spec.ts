import type { AdapterSpec, Sampler } from './netd/fakeNetd'
import type { Adapter, Snapshot } from './netd/protocol'
import { errorOf, expect, resultOf, test, type Event, type Response } from './netd/harness'

/** Spec sections 12.4 (commands and state machine) and 12.5 (stats stream). */

type Status = Snapshot & { skipped: Array<{ name: string; reason: string }> }
type Stats = Event<Snapshot & { dropped: number }>

const ADAPTER_KEYS = [
  'name',
  'ip',
  'ip6',
  'present',
  'excluded',
  'state',
  'state6',
  'weight',
  'weight6',
  'weight_mode',
  'peak_bps',
  'peak6_bps',
  'active_flows',
  'total_flows',
  'failed_flows',
  'link_in_bps',
  'link_out_bps',
  'relayed_in_bps',
  'relayed_out_bps',
  'bytes_in',
  'bytes_out'
]

test.describe('commands and state machine (12.4)', () => {
  test('a fresh helper is off with autopause manual_off', async ({ netd }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'status' })
    const status = resultOf(await client.readJson<Response<Status>>())
    expect(status).toMatchObject({
      state: 'off',
      state_since: 1759999999500,
      error: null,
      autopause: { enabled: true, status: 'manual_off' },
      tun: { name: null, open: false },
      skipped: []
    })
    expect(Object.keys(status)).toEqual([
      'ts',
      'state',
      'state_since',
      'error',
      'capture',
      'autopause',
      'ipv6',
      'tun',
      'totals',
      'adapters',
      'discovery_seq',
      'skipped'
    ])
    expect(fake.view.state).toBe('off')
  })

  test('on and off are idempotent and emit state events only on change', async ({ netd }) => {
    const { client } = await netd.session()
    await client.request({ id: 2, cmd: 'on' })
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      seq: 2,
      data: { state: 'starting' }
    })
    expect(await client.readJson()).toMatchObject({ event: 'state', seq: 3, data: { state: 'on' } })
    expect(await client.readJson()).toEqual({ id: 2, ok: true, result: { state: 'on' } })
    await client.request({ id: 3, cmd: 'on' })
    expect(await client.readJson()).toEqual({ id: 3, ok: true, result: { state: 'on' } })
    await client.request({ id: 4, cmd: 'off' })
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      seq: 4,
      data: {
        state: 'off',
        autopause: { status: 'manual_off' },
        tun: { name: 'utun5', open: true }
      }
    })
    expect(await client.readJson()).toEqual({ id: 4, ok: true, result: { state: 'off' } })
    await client.request({ id: 5, cmd: 'off' })
    expect(await client.readJson()).toEqual({ id: 5, ok: true, result: { state: 'off' } })
    expect(await client.quiet(100)).toBe(true)
  })

  test('off removes the adapter when the helper does not keep it', async ({ netd }) => {
    const { client } = await netd.session({
      os: 'linux',
      capabilities: ['link_counters'],
      tunName: 'lychee-netd'
    })
    await client.request({ id: 2, cmd: 'on' })
    await client.readLines(3)
    await client.request({ id: 3, cmd: 'off' })
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      data: { state: 'off', tun: { name: null, open: false } }
    })
  })

  test('on emits starting then on before the response, with state_since and the tun', async ({
    netd
  }) => {
    const { client } = await netd.session()
    netd.clock.advance(1500) // now 1760000001000
    await client.request({ id: 2, cmd: 'on' })
    const starting = await client.readJson<Event<Snapshot>>()
    expect(starting.data).toMatchObject({
      ts: 1760000001000,
      state: 'starting',
      state_since: 1760000001000,
      tun: { name: null, open: false }
    })
    const on = await client.readJson<Event<Snapshot>>()
    expect(on.data).toMatchObject({
      state: 'on',
      state_since: 1760000001000,
      autopause: { enabled: true, status: 'armed' },
      tun: { name: 'utun5', open: true }
    })
    expect(await client.readJson()).toEqual({ id: 2, ok: true, result: { state: 'on' } })
  })

  test('on with a single usable adapter is held; a second usable adapter arms it', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'exclude', args: { adapter: 'en7' } })
    await client.readJson()
    await client.request({ id: 3, cmd: 'on' })
    await client.readJson()
    expect(await client.readJson()).toMatchObject({
      data: { state: 'on', autopause: { status: 'held' } }
    })
    await client.readJson()
    expect(fake.autoPause()).toBe(false) // held: no automatic pause
    await client.request({ id: 4, cmd: 'include', args: { adapter: 'en7' } })
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      data: { autopause: { status: 'armed' } }
    })
    expect(await client.readJson()).toMatchObject({ id: 4, ok: true })
  })

  test('a failing on reports internal and leaves state error until off', async ({ netd }) => {
    const { fake, client } = await netd.session()
    fake.setOnFailure('route 0.0.0.0/1: file exists')
    await client.request({ id: 2, cmd: 'on' })
    expect(await client.readJson()).toMatchObject({ event: 'state', data: { state: 'starting' } })
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      data: {
        state: 'error',
        error: { message: 'route 0.0.0.0/1: file exists' },
        tun: { name: null, open: false }
      }
    })
    expect(await client.readJson()).toEqual({
      id: 2,
      ok: false,
      error: { code: 'internal', message: 'route 0.0.0.0/1: file exists' }
    })
    await client.request({ id: 3, cmd: 'status' })
    expect(resultOf(await client.readJson<Response>())).toMatchObject({ state: 'error' })
    // cleanup is allowed in error.
    await client.request({ id: 4, cmd: 'cleanup' })
    expect(await client.readJson()).toEqual({ id: 4, ok: true, result: {} })
    await client.request({ id: 5, cmd: 'off' })
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      data: { state: 'off', error: null }
    })
    expect(await client.readJson()).toEqual({ id: 5, ok: true, result: { state: 'off' } })
    // A later on succeeds once the fault is gone.
    fake.setOnFailure(null)
    await client.request({ id: 6, cmd: 'on' })
    await client.readLines(2)
    expect(await client.readJson()).toEqual({ id: 6, ok: true, result: { state: 'on' } })
  })

  test('on with no present, non-excluded adapter is no_adapters', async ({ netd }) => {
    const { client } = await netd.session({ adapters: [] })
    await client.request({ id: 2, cmd: 'on' })
    expect(errorOf(await client.readJson<Response>()).code).toBe('no_adapters')
    expect(await client.quiet(50)).toBe(true)
  })

  test('on with every adapter excluded is no_adapters', async ({ netd }) => {
    const { client } = await netd.session()
    for (const [id, adapter] of [
      [2, 'en0'],
      [3, 'en7']
    ] as const) {
      await client.request({ id, cmd: 'exclude', args: { adapter } })
      await client.readJson()
    }
    await client.request({ id: 4, cmd: 'on' })
    expect(errorOf(await client.readJson<Response>()).code).toBe('no_adapters')
  })

  test('on without a capture driver is unsupported_platform; stats still work', async ({
    netd
  }) => {
    const { client, hello } = await netd.session({
      capture: { available: false, error: '/dev/net/tun: no such file or directory' }
    })
    expect(resultOf(hello.response).capture).toEqual({
      available: false,
      error: '/dev/net/tun: no such file or directory'
    })
    await client.request({ id: 2, cmd: 'on' })
    expect(errorOf(await client.readJson<Response>())).toEqual({
      code: 'unsupported_platform',
      message: expect.any(String),
      data: { error: '/dev/net/tun: no such file or directory' }
    })
    await client.request({ id: 3, cmd: 'subscribe' })
    await client.readJson()
    expect(await client.readJson()).toMatchObject({ event: 'stats', data: { state: 'off' } })
  })

  test('autopause statuses: disabled, armed, waiting, manual_off, idle; paused_auto transitions', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'set_autopause', args: { enabled: false } })
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      data: { autopause: { enabled: false, status: 'disabled' } }
    })
    expect(await client.readJson()).toEqual({
      id: 2,
      ok: true,
      result: { enabled: false, status: 'disabled' }
    })
    // Idempotent: no event.
    await client.request({ id: 3, cmd: 'set_autopause', args: { enabled: false } })
    expect(await client.readJson()).toEqual({
      id: 3,
      ok: true,
      result: { enabled: false, status: 'disabled' }
    })
    await client.request({ id: 4, cmd: 'set_autopause', args: { enabled: true } })
    expect(await client.readJson()).toMatchObject({
      data: { state: 'off', autopause: { status: 'manual_off' } }
    })
    expect(await client.readJson()).toEqual({
      id: 4,
      ok: true,
      result: { enabled: true, status: 'manual_off' }
    })

    await client.request({ id: 5, cmd: 'on' })
    await client.readLines(3)
    // The autopauser pauses: paused_auto / waiting; the kept utun stays open.
    expect(fake.autoPause()).toBe(true)
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      data: {
        state: 'paused_auto',
        autopause: { status: 'waiting' },
        tun: { name: 'utun5', open: true }
      }
    })
    await client.request({ id: 6, cmd: 'cleanup' })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'invalid_state',
      data: { state: 'paused_auto' }
    })
    // Disabling while paused_auto: off, but not manual_off.
    await client.request({ id: 7, cmd: 'set_autopause', args: { enabled: false } })
    expect(await client.readJson()).toMatchObject({
      data: { state: 'off', autopause: { status: 'disabled' } }
    })
    expect(await client.readJson()).toEqual({
      id: 7,
      ok: true,
      result: { enabled: false, status: 'disabled' }
    })
    // Enabling while off and not manually off: waits again.
    await client.request({ id: 8, cmd: 'set_autopause', args: { enabled: true } })
    expect(await client.readJson()).toMatchObject({
      data: { state: 'paused_auto', autopause: { status: 'waiting' } }
    })
    expect(await client.readJson()).toEqual({
      id: 8,
      ok: true,
      result: { enabled: true, status: 'waiting' }
    })
    // The autopauser resumes: starting, then on and armed.
    expect(fake.autoResume()).toBe(true)
    expect(await client.readJson()).toMatchObject({ data: { state: 'starting' } })
    expect(await client.readJson()).toMatchObject({
      data: { state: 'on', autopause: { status: 'armed' } }
    })
    // A manual off is final for the autopauser.
    await client.request({ id: 9, cmd: 'off' })
    expect(await client.readJson()).toMatchObject({
      data: { state: 'off', autopause: { status: 'manual_off' } }
    })
    await client.readJson()
    expect(fake.autoResume()).toBe(false)
    // Disabling never changes a running on.
    await client.request({ id: 10, cmd: 'on' })
    await client.readLines(3)
    await client.request({ id: 11, cmd: 'set_autopause', args: { enabled: false } })
    expect(await client.readJson()).toMatchObject({
      data: { state: 'on', autopause: { status: 'disabled' } }
    })
    await client.readJson()
  })

  test('autopause never starts merging without an on request', async ({ netd }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'subscribe' })
    await client.readLines(2)
    netd.clock.advance(60000)
    const frames = await client.readLines(60)
    for (const f of frames)
      expect(JSON.parse(f)).toMatchObject({ event: 'stats', data: { state: 'off' } })
    expect(fake.autoResume()).toBe(false)
    expect(fake.view.state).toBe('off')
  })

  test('set_ipv6 round-trips each mode; effective follows the adapters; invalid is bad_request', async ({
    netd
  }) => {
    const { client } = await netd.session()
    await client.request({ id: 2, cmd: 'set_ipv6', args: { mode: 'on' } })
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      data: { ipv6: { mode: 'on', effective: 'balanced' } }
    })
    expect(await client.readJson()).toEqual({
      id: 2,
      ok: true,
      result: { mode: 'on', effective: 'balanced' }
    })
    await client.request({ id: 3, cmd: 'set_ipv6', args: { mode: 'off' } })
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      data: { ipv6: { mode: 'off', effective: 'refused' } }
    })
    expect(await client.readJson()).toEqual({
      id: 3,
      ok: true,
      result: { mode: 'off', effective: 'refused' }
    })
    // auto with no IPv6 anywhere stays refused: no event (effective unchanged).
    await client.request({ id: 4, cmd: 'set_ipv6', args: { mode: 'auto' } })
    expect(await client.readJson()).toEqual({
      id: 4,
      ok: true,
      result: { mode: 'auto', effective: 'refused' }
    })
    await client.request({ id: 5, cmd: 'set_ipv6', args: { mode: 'yes' } })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'bad_request',
      data: { field: 'mode' }
    })
    await client.request({ id: 6, cmd: 'set_ipv6', args: {} })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'bad_request',
      data: { field: 'mode' }
    })
  })

  test('ipv6 auto is balanced when every usable adapter has IPv6', async ({ netd }) => {
    const v6: AdapterSpec[] = [
      { name: 'eth0', index: 2, ip: '10.0.0.2', ip6: '2001:db8::2', state: 'up', state6: 'up' },
      { name: 'wlan0', index: 3, ip: '10.0.1.2', ip6: '2001:db8:1::2', state: 'up', state6: 'up' }
    ]
    const { fake, client, hello } = await netd.session({ adapters: v6 })
    expect(hello.state.data.ipv6).toMatchObject({ mode: 'auto', effective: 'balanced' })
    fake.updateAdapter('wlan0', { state6: 'down' })
    expect(await client.readJson()).toMatchObject({
      event: 'state',
      data: { ipv6: { effective: 'refused' } }
    })
  })

  test('exclude and include: unknown names, idempotence, skipped names, stats view', async ({
    netd
  }) => {
    const { client } = await netd.session({
      skipped: [{ name: 'utun3', reason: 'looks like a virtual/VPN adapter (name)' }]
    })
    await client.request({ id: 2, cmd: 'exclude', args: { adapter: 'en9' } })
    expect(await client.readJson()).toEqual({
      id: 2,
      ok: false,
      error: {
        code: 'unknown_adapter',
        message: 'no adapter named "en9"',
        data: { adapter: 'en9' }
      }
    })
    await client.request({ id: 3, cmd: 'exclude', args: { adapter: 'en7' } })
    expect(await client.readJson()).toEqual({
      id: 3,
      ok: true,
      result: { adapter: 'en7', excluded: true }
    })
    await client.request({ id: 4, cmd: 'exclude', args: { adapter: 'en7' } })
    expect(await client.readJson()).toEqual({
      id: 4,
      ok: true,
      result: { adapter: 'en7', excluded: true }
    })
    // Excluding a skipped adapter succeeds and only remembers the name.
    await client.request({ id: 5, cmd: 'exclude', args: { adapter: 'utun3' } })
    expect(await client.readJson()).toEqual({
      id: 5,
      ok: true,
      result: { adapter: 'utun3', excluded: true }
    })

    await client.request({ id: 6, cmd: 'status' })
    const status = resultOf(await client.readJson<Response<Status>>())
    const en7 = status.adapters.find((a) => a.name === 'en7')!
    expect(en7).toMatchObject({
      excluded: true,
      state: 'none',
      state6: 'none',
      weight: 0,
      weight6: 0,
      active_flows: 0,
      relayed_in_bps: 0,
      bytes_in: 0
    })
    expect(en7.link_in_bps).toBeGreaterThan(0) // OS counters keep being reported
    expect(status.totals.adapters_present).toBe(2)
    expect(status.totals.adapters_usable).toBe(1)

    await client.request({ id: 7, cmd: 'include', args: { adapter: 'en7' } })
    expect(await client.readJson()).toEqual({
      id: 7,
      ok: true,
      result: { adapter: 'en7', excluded: false }
    })
    await client.request({ id: 8, cmd: 'include', args: { adapter: 'en7' } })
    expect(await client.readJson()).toMatchObject({ id: 8, ok: true })
    await client.request({ id: 9, cmd: 'include', args: { adapter: 'nope' } })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'unknown_adapter',
      data: { adapter: 'nope' }
    })
  })

  test('adapter names are validated and never reach anything but a lookup', async ({ netd }) => {
    const { client } = await netd.session()
    await client.request({ id: 2, cmd: 'exclude', args: { adapter: 'en0; rm -rf /' } })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'unknown_adapter',
      data: { adapter: 'en0; rm -rf /' }
    })
    for (const adapter of ['', 'x'.repeat(257), 'en\u00000', 'en\n0', 'en\u007f']) {
      await client.request({ id: 3, cmd: 'exclude', args: { adapter } })
      expect(errorOf(await client.readJson<Response>()), JSON.stringify(adapter)).toMatchObject({
        code: 'bad_request',
        data: { field: 'adapter' }
      })
    }
    await client.request({ id: 4, cmd: 'exclude', args: { adapter: 5 } })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'bad_request',
      data: { field: 'adapter' }
    })
    // A 256-byte name is fine (unknown, but well-formed).
    await client.request({ id: 5, cmd: 'exclude', args: { adapter: 'x'.repeat(256) } })
    expect(errorOf(await client.readJson<Response>()).code).toBe('unknown_adapter')
  })

  test('set_weight: range, auto, strict types, unknown adapter, weight_mode in stats', async ({
    netd
  }) => {
    const { client } = await netd.session()
    for (const weight of [0.049, 100.1, -1, 0]) {
      await client.request({ id: 2, cmd: 'set_weight', args: { adapter: 'en0', weight } })
      expect(errorOf(await client.readJson<Response>()), String(weight)).toEqual({
        code: 'out_of_range',
        message: expect.any(String),
        data: { field: 'weight', min: 0.05, max: 100 }
      })
    }
    for (const weight of ['Auto', true, null, '3']) {
      await client.request({ id: 3, cmd: 'set_weight', args: { adapter: 'en0', weight } })
      expect(errorOf(await client.readJson<Response>()), JSON.stringify(weight)).toMatchObject({
        code: 'bad_request',
        data: { field: 'weight' }
      })
    }
    await client.request({ id: 4, cmd: 'set_weight', args: { adapter: 'en0' } })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'bad_request',
      data: { field: 'weight' }
    })
    await client.request({ id: 5, cmd: 'set_weight', args: { adapter: 'nope', weight: 3 } })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'unknown_adapter',
      data: { adapter: 'nope' }
    })

    await client.request({ id: 6, cmd: 'set_weight', args: { adapter: 'en0', weight: 3 } })
    expect(await client.readJson()).toEqual({
      id: 6,
      ok: true,
      result: { adapter: 'en0', weight_mode: 'manual', weight: 3 }
    })
    await client.request({ id: 7, cmd: 'set_weight', args: { adapter: 'en7', weight: 0.05 } })
    expect(await client.readJson()).toMatchObject({
      ok: true,
      result: { weight_mode: 'manual', weight: 0.05 }
    })
    await client.request({ id: 8, cmd: 'set_weight', args: { adapter: 'en7', weight: 100 } })
    expect(await client.readJson()).toMatchObject({ ok: true, result: { weight: 100 } })

    await client.request({ id: 9, cmd: 'status' })
    const status = resultOf(await client.readJson<Response<Status>>())
    expect(status.adapters.find((a) => a.name === 'en0')).toMatchObject({
      weight_mode: 'manual',
      weight: 3,
      weight6: 3
    })
    await client.request({ id: 10, cmd: 'list_adapters' })
    const list = resultOf(
      await client.readJson<Response<{ adapters: Array<{ name: string; weight_mode: string }> }>>()
    )
    expect(list.adapters.find((a) => a.name === 'en0')?.weight_mode).toBe('manual')

    await client.request({ id: 11, cmd: 'set_weight', args: { adapter: 'en0', weight: 'auto' } })
    expect(await client.readJson()).toEqual({
      id: 11,
      ok: true,
      result: { adapter: 'en0', weight_mode: 'auto', weight: 1 }
    })
    await client.request({ id: 12, cmd: 'set_weight', args: { adapter: 'en0', weight: 'auto' } })
    expect(await client.readJson()).toMatchObject({
      id: 12,
      ok: true,
      result: { weight_mode: 'auto' }
    })
  })

  test('a manual weight survives the adapter vanishing and can still be changed', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'set_weight', args: { adapter: 'en7', weight: 2 } })
    await client.readJson()
    fake.removeAdapter('en7')
    await client.request({ id: 3, cmd: 'set_weight', args: { adapter: 'en7', weight: 'auto' } })
    expect(await client.readJson()).toMatchObject({
      id: 3,
      ok: true,
      result: { weight_mode: 'auto' }
    })
    await client.request({ id: 4, cmd: 'set_weight', args: { adapter: 'en7', weight: 2 } })
    expect(errorOf(await client.readJson<Response>()).code).toBe('unknown_adapter')
  })

  test('list_adapters returns fields and caps both lists at 64 with truncated', async ({
    netd
  }) => {
    const many: AdapterSpec[] = Array.from({ length: 70 }, (_, i) => ({
      name: `eth${i}`,
      index: i + 2,
      ip: `10.0.${i}.2`,
      ip6: i % 2 ? `2001:db8:${i}::2` : null,
      description: i % 3 ? `NIC ${i}` : null,
      state: 'up',
      state6: i % 2 ? 'up' : 'none'
    }))
    const skipped = Array.from({ length: 70 }, (_, i) => ({
      name: `veth${i}`,
      reason: 'no default gateway (no internet route)'
    }))
    const { client } = await netd.session({ adapters: many, skipped })
    await client.request({ id: 2, cmd: 'exclude', args: { adapter: 'eth1' } })
    await client.readJson()
    await client.request({ id: 3, cmd: 'list_adapters' })
    const result = resultOf(await client.readJson<Response<Record<string, unknown>>>())
    expect(Object.keys(result)).toEqual(['discovery_seq', 'adapters', 'skipped', 'truncated'])
    const adapters = result.adapters as Array<Record<string, unknown>>
    expect(adapters).toHaveLength(64)
    expect(adapters[0]).toEqual({
      name: 'eth0',
      index: 2,
      ip: '10.0.0.2',
      ip6: null,
      excluded: false,
      weight_mode: 'auto',
      description: null
    })
    expect(adapters[1]).toMatchObject({
      name: 'eth1',
      excluded: true,
      description: 'NIC 1',
      ip6: '2001:db8:1::2'
    })
    expect(adapters[63].name).toBe('eth63')
    expect(result.skipped).toHaveLength(64)
    expect(result.truncated).toBe(true)
    // Stats cap the adapter list the same way; totals still cover every present adapter.
    await client.request({ id: 4, cmd: 'status' })
    const status = resultOf(await client.readJson<Response<Status>>())
    expect(status.adapters).toHaveLength(64)
    expect(status.totals.adapters_present).toBe(70)
    expect(status.skipped).toHaveLength(64)
  })

  test('list_adapters omits truncated within the caps and reports skipped reasons', async ({
    netd
  }) => {
    const { client } = await netd.session({
      skipped: [
        { name: 'tailscale0', reason: 'looks like a virtual/VPN adapter (name)' },
        {
          name: 'docker0',
          reason: 'tunnel/virtual interface (software interface type 1, no hardware device)'
        }
      ]
    })
    await client.request({ id: 2, cmd: 'list_adapters' })
    const result = resultOf(await client.readJson<Response<Record<string, unknown>>>())
    expect(result).toEqual({
      discovery_seq: 1,
      adapters: [
        {
          name: 'en0',
          index: 4,
          ip: '192.168.1.23',
          ip6: null,
          excluded: false,
          weight_mode: 'auto',
          description: 'Wi-Fi'
        },
        {
          name: 'en7',
          index: 12,
          ip: '192.168.2.5',
          ip6: null,
          excluded: false,
          weight_mode: 'auto',
          description: 'USB 10/100/1000 LAN'
        }
      ],
      skipped: [
        { name: 'tailscale0', reason: 'looks like a virtual/VPN adapter (name)' },
        {
          name: 'docker0',
          reason: 'tunnel/virtual interface (software interface type 1, no hardware device)'
        }
      ]
    })
  })

  test('cleanup is allowed only while off or error', async ({ netd }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'cleanup' })
    expect(await client.readJson()).toEqual({ id: 2, ok: true, result: {} })
    await client.request({ id: 3, cmd: 'on' })
    await client.readLines(3)
    await client.request({ id: 4, cmd: 'cleanup' })
    expect(await client.readJson()).toEqual({
      id: 4,
      ok: false,
      error: {
        code: 'invalid_state',
        message: 'cleanup is only allowed while off',
        data: { state: 'on' }
      }
    })
    fake.autoPause()
    await client.readJson()
    await client.request({ id: 5, cmd: 'cleanup' })
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'invalid_state',
      data: { state: 'paused_auto' }
    })
    await client.request({ id: 6, cmd: 'off' })
    await client.readLines(2)
    fake.setCleanupFailure('route delete 0.0.0.0/1: operation not permitted')
    await client.request({ id: 7, cmd: 'cleanup' })
    expect(await client.readJson()).toEqual({
      id: 7,
      ok: false,
      error: { code: 'internal', message: 'route delete 0.0.0.0/1: operation not permitted' }
    })
  })
})

test.describe('stats stream (12.5)', () => {
  test('subscribe validates the interval, defaults to 1000 and can be re-timed', async ({
    netd
  }) => {
    const { client } = await netd.session()
    for (const interval_ms of [249, 5001]) {
      await client.request({ id: 2, cmd: 'subscribe', args: { interval_ms } })
      expect(await client.readJson()).toEqual({
        id: 2,
        ok: false,
        error: {
          code: 'out_of_range',
          message: 'interval_ms must be between 250 and 5000',
          data: { field: 'interval_ms', min: 250, max: 5000 }
        }
      })
    }
    for (const interval_ms of [500.5, 1000.0 + 0.5, '1000']) {
      await client.request({ id: 3, cmd: 'subscribe', args: { interval_ms } })
      expect(errorOf(await client.readJson<Response>())).toMatchObject({
        code: 'bad_request',
        data: { field: 'interval_ms' }
      })
    }
    await client.send('{"id":4,"cmd":"subscribe","args":{"interval_ms":1000.0}}\n')
    expect(errorOf(await client.readJson<Response>())).toMatchObject({
      code: 'bad_request',
      data: { field: 'interval_ms' }
    })

    await client.request({ id: 5, cmd: 'subscribe' })
    expect(await client.readJson()).toEqual({ id: 5, ok: true, result: { interval_ms: 1000 } })
    expect(await client.readJson()).toMatchObject({
      event: 'stats',
      seq: 2,
      data: { ts: 1759999999500 }
    })
    netd.clock.advance(999)
    expect(await client.quiet(50)).toBe(true)
    netd.clock.advance(1)
    expect(await client.readJson()).toMatchObject({
      event: 'stats',
      seq: 3,
      data: { ts: 1760000000500 }
    })

    await client.request({ id: 6, cmd: 'subscribe', args: { interval_ms: 250 } })
    expect(await client.readJson()).toEqual({ id: 6, ok: true, result: { interval_ms: 250 } })
    expect(await client.readJson()).toMatchObject({ event: 'stats', seq: 4 })
    netd.clock.advance(1000)
    const seqs = (await client.readLines(4)).map((l) => JSON.parse(l).seq)
    expect(seqs).toEqual([5, 6, 7, 8])

    await client.request({ id: 7, cmd: 'unsubscribe' })
    expect(await client.readJson()).toEqual({ id: 7, ok: true, result: {} })
    netd.clock.advance(5000)
    expect(await client.quiet(100)).toBe(true)
    await client.request({ id: 8, cmd: 'unsubscribe' })
    expect(await client.readJson()).toEqual({ id: 8, ok: true, result: {} })
  })

  test('stats arrive while off, with non-zero link rates and the full Snapshot shape', async ({
    netd
  }) => {
    const { client } = await netd.session()
    await client.request({ id: 2, cmd: 'subscribe' })
    await client.readJson()
    const stats = await client.readJson<Stats>()
    expect(stats.data.state).toBe('off')
    expect(stats.data.totals.link_in_bps).toBeGreaterThan(0)
    expect(Object.keys(stats.data)).toEqual([
      'ts',
      'state',
      'state_since',
      'error',
      'capture',
      'autopause',
      'ipv6',
      'tun',
      'totals',
      'adapters',
      'discovery_seq',
      'dropped'
    ])
    expect(Object.keys(stats.data.totals)).toEqual([
      'link_in_bps',
      'link_out_bps',
      'relayed_in_bps',
      'relayed_out_bps',
      'active_flows',
      'adapters_present',
      'adapters_usable'
    ])
    for (const adapter of stats.data.adapters) expect(Object.keys(adapter)).toEqual(ADAPTER_KEYS)
  })

  test('the sampler drives exact adapter values; rates are truncated to integers', async ({
    netd
  }) => {
    const sampler: Sampler = ({ adapter, tick }) => ({
      weight: adapter.name === 'en0' ? 1 : 0.61,
      weight6: 1,
      peak_bps: 6250000.9,
      peak6_bps: 0,
      active_flows: 23,
      total_flows: 1510 + tick,
      failed_flows: 0,
      link_in_bps: 6100000.5,
      link_out_bps: 250000,
      relayed_in_bps: 5800000,
      relayed_out_bps: 230000,
      bytes_in: 3141592653,
      bytes_out: 271828182
    })
    const { client } = await netd.session({ sampler })
    await client.request({ id: 2, cmd: 'subscribe' })
    await client.readJson()
    const stats = await client.readJson<Stats>()
    expect(stats.data.adapters[0]).toEqual({
      name: 'en0',
      ip: '192.168.1.23',
      ip6: null,
      present: true,
      excluded: false,
      state: 'up',
      state6: 'none',
      weight: 1,
      weight6: 1,
      weight_mode: 'auto',
      peak_bps: 6250000,
      peak6_bps: 0,
      active_flows: 23,
      total_flows: 1510,
      failed_flows: 0,
      link_in_bps: 6100000,
      link_out_bps: 250000,
      relayed_in_bps: 5800000,
      relayed_out_bps: 230000,
      bytes_in: 3141592653,
      bytes_out: 271828182
    })
    expect(stats.data.adapters[1].weight).toBe(0.61)
    netd.clock.advance(1000)
    expect((await client.readJson<Stats>()).data.adapters[0].total_flows).toBe(1511)
  })

  test('totals sum present adapters including excluded ones and skip absent ones', async ({
    netd
  }) => {
    const adapters: AdapterSpec[] = [
      { name: 'a', index: 1, ip: '10.0.0.1', ip6: null, state: 'up', state6: 'none' },
      { name: 'b', index: 2, ip: '10.0.0.2', ip6: null, state: 'up', state6: 'none' },
      {
        name: 'c',
        index: 3,
        ip: '10.0.0.3',
        ip6: null,
        state: 'down',
        state6: 'none',
        present: false
      },
      { name: 'd', index: 4, ip: null, ip6: '2001:db8::4', state: 'none', state6: 'up' }
    ]
    const sampler: Sampler = ({ adapter }) => ({
      link_in_bps: 100 * adapter.index,
      link_out_bps: 10 * adapter.index,
      relayed_in_bps: 5 * adapter.index,
      relayed_out_bps: 1 * adapter.index,
      active_flows: adapter.index
    })
    const { client } = await netd.session({ adapters, sampler })
    await client.request({ id: 2, cmd: 'exclude', args: { adapter: 'b' } })
    await client.readJson()
    await client.request({ id: 3, cmd: 'status' })
    const status = resultOf(await client.readJson<Response<Status>>())
    // a (present) + b (present, excluded: link rates only) + d (present); c is absent.
    expect(status.totals).toEqual({
      link_in_bps: 100 + 200 + 400,
      link_out_bps: 10 + 20 + 40,
      relayed_in_bps: 5 + 20,
      relayed_out_bps: 1 + 4,
      active_flows: 1 + 4,
      adapters_present: 3,
      adapters_usable: 2
    })
    expect(status.adapters.map((a: Adapter) => [a.name, a.present])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
      ['d', true]
    ])
  })

  test('a stats frame with 64 adapters with 256-byte names fits in 65536 bytes', async ({
    netd
  }) => {
    const adapters: AdapterSpec[] = Array.from({ length: 64 }, (_, i) => ({
      name: String(i).padStart(3, '0') + 'n'.repeat(253),
      index: i + 1,
      ip: '192.168.100.100',
      ip6: '2001:0db8:0000:0000:0000:ffff:ffff:ffff',
      state: 'up',
      state6: 'up'
    }))
    const sampler: Sampler = () => ({
      weight: 0.123456789,
      weight6: 0.987654321,
      peak_bps: 9007199254740991,
      peak6_bps: 9007199254740991,
      active_flows: 9007199254740991,
      total_flows: 9007199254740991,
      failed_flows: 9007199254740991,
      link_in_bps: 9007199254740991,
      link_out_bps: 9007199254740991,
      relayed_in_bps: 9007199254740991,
      relayed_out_bps: 9007199254740991,
      bytes_in: 9007199254740991,
      bytes_out: 9007199254740991
    })
    const { client } = await netd.session({ adapters, sampler })
    await client.request({ id: 2, cmd: 'subscribe' })
    await client.readJson()
    const line = await client.readLine()
    const bytes = Buffer.byteLength(line, 'utf8') + 1
    expect(bytes).toBeLessThanOrEqual(65536)
    expect(JSON.parse(line).data.adapters).toHaveLength(64)
    test
      .info()
      .annotations.push({ type: 'frame-size', description: `64 maximal adapters: ${bytes} bytes` })
  })

  test('seq increases by exactly 1 across stats, state and log events', async ({ netd }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'subscribe' })
    expect(await client.readJson()).toMatchObject({ id: 2, ok: true }) // subscribe response
    expect(await client.readJson()).toMatchObject({ event: 'stats', seq: 2 }) // immediate stats
    fake.log('warn', 'IPv6 not captured: operation not permitted') // log, seq 3
    expect(await client.readJson()).toEqual({
      event: 'log',
      seq: 3,
      data: { level: 'warn', message: 'IPv6 not captured: operation not permitted' }
    })
    await client.request({ id: 3, cmd: 'set_ipv6', args: { mode: 'on' } }) // effective changes
    expect(await client.readJson()).toMatchObject({ event: 'state', seq: 4 }) // state, seq 4
    expect(await client.readJson()).toMatchObject({ id: 3, ok: true }) // set_ipv6 response
    netd.clock.advance(1000)
    expect(await client.readJson()).toMatchObject({ event: 'stats', seq: 5 }) // next tick
  })

  test('dropped events consume seq and are reported in the next stats event', async ({ netd }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'subscribe' })
    await client.readJson()
    expect(await client.readJson()).toMatchObject({ seq: 2, data: { dropped: 0 } })
    fake.dropEvents(3)
    netd.clock.advance(1000)
    expect(await client.readJson()).toMatchObject({ event: 'stats', seq: 6, data: { dropped: 3 } })
  })

  test('log events are rate-limited to 20 per second; the rest count as dropped', async ({
    netd
  }) => {
    const { fake, client } = await netd.session()
    await client.request({ id: 2, cmd: 'subscribe' })
    await client.readLines(2)
    for (let i = 0; i < 25; i++) fake.log('warn', `warning ${i}`)
    const logs = (await client.readLines(20)).map((l) => JSON.parse(l))
    expect(logs.every((f) => f.event === 'log')).toBe(true)
    expect(logs[19].seq).toBe(22)
    netd.clock.advance(1000)
    expect(await client.readJson()).toMatchObject({ event: 'stats', seq: 28, data: { dropped: 5 } })
    fake.log('info', 'new second')
    expect(await client.readJson()).toMatchObject({ event: 'log', seq: 29 })
  })
})
