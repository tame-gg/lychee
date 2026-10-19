import { expect, test } from './netd/harness'

/**
 * Replays Appendix B of docs/netd-control-channel.md against the fake helper, byte for byte.
 * Every `>` line is sent exactly as printed. Every `<` line printed in full must come back as the
 * identical string; lines the appendix elides with `...` must start with, contain in order, and
 * end with the fragments that are shown. The test records which lines were exact and which were
 * partial, and asserts the counts so the record cannot drift silently.
 */

/** A `<` line of the appendix: the full string, or the fragments shown around `...`. */
type Expected = { exact: string } | { fragments: string[] }

interface Replay {
  exact: number
  partial: number
  log: string[]
}

function check(line: string, expected: Expected, replay: Replay): void {
  if ('exact' in expected) {
    expect(line).toBe(expected.exact)
    replay.exact++
    replay.log.push(`exact   ${line.slice(0, 72)}`)
    return
  }
  const { fragments } = expected
  expect(line.startsWith(fragments[0]), `line should start with ${fragments[0]}\n${line}`).toBe(
    true
  )
  expect(
    line.endsWith(fragments[fragments.length - 1]),
    `line should end with ${fragments.at(-1)}\n${line}`
  ).toBe(true)
  let from = 0
  for (const fragment of fragments) {
    const at = line.indexOf(fragment, from)
    expect(at, `fragment ${fragment} not found in order in\n${line}`).toBeGreaterThanOrEqual(0)
    from = at + fragment.length
  }
  replay.partial++
  replay.log.push(`partial ${line.slice(0, 72)}`)
}

test('Appendix B main session replays byte for byte', async ({ netd }) => {
  const { clock } = netd
  // The helper started 500 ms before the client's hello: state_since 1759999999500.
  expect(clock.now()).toBe(1759999999500)
  const fake = await netd.start()
  const replay: Replay = { exact: 0, partial: 0, log: [] }

  clock.advance(500)
  const client = await netd.connect()

  await client.send(
    '{"id":1,"cmd":"hello","args":{"protocol":[1],"client":"lychee","client_version":"0.2.0"}}\n'
  )
  check(
    await client.readLine(),
    {
      exact:
        '{"id":1,"ok":true,"result":{"protocol":1,"helper_version":"0.2.0","os":"darwin","arch":"arm64","pid":5120,"instance":"3f9c2a7e5b1d4c6a8e0f1a2b3c4d5e6f","session":1,"auth":{"model":"unix_peer_uid","privilege":"root","authorized_uid":501},"capabilities":["link_counters","keep_adapter_on_off"],"limits":{"max_frame":65536,"max_in_flight":16,"hello_timeout_ms":5000,"grace_ms":10000,"startup_timeout_ms":30000,"stats_interval_ms":{"min":250,"max":5000,"default":1000},"weight":{"min":0.05,"max":100}},"capture":{"available":true,"error":null}}}'
    },
    replay
  )
  check(
    await client.readLine(),
    {
      exact:
        '{"event":"state","seq":1,"data":{"ts":1760000000000,"state":"off","state_since":1759999999500,"error":null,"capture":{"available":true,"error":null},"autopause":{"enabled":true,"status":"manual_off"},"ipv6":{"mode":"auto","effective":"refused","detail":"auto: refused, apps fall back to IPv4 so every adapter is used (not every adapter has IPv6)"},"tun":{"name":null,"open":false}}}'
    },
    replay
  )

  clock.advance(10)
  await client.send('{"id":2,"cmd":"subscribe","args":{"interval_ms":1000}}\n')
  check(
    await client.readLine(),
    { exact: '{"id":2,"ok":true,"result":{"interval_ms":1000}}' },
    replay
  )
  check(
    await client.readLine(),
    {
      fragments: [
        '{"event":"stats","seq":2,"data":{"ts":1760000000010,"state":"off",',
        '"adapters":[{"name":"en0",',
        '},{"name":"en7",',
        '}],"discovery_seq":1,"dropped":0}}'
      ]
    },
    replay
  )

  await client.send('{"id":3,"cmd":"set_ipv6","args":{"mode":"auto"}}\n')
  check(
    await client.readLine(),
    { exact: '{"id":3,"ok":true,"result":{"mode":"auto","effective":"refused"}}' },
    replay
  )

  await client.send('{"id":4,"cmd":"exclude","args":{"adapter":"en7"}}\n')
  check(
    await client.readLine(),
    { exact: '{"id":4,"ok":true,"result":{"adapter":"en7","excluded":true}}' },
    replay
  )

  // `on` at 1760000001000 takes 350 ms: `starting` at once, `on` when tun.On returns.
  clock.advance(990)
  fake.setDelay('on', 350)
  await client.send('{"id":5,"cmd":"on"}\n')
  check(
    await client.readLine(),
    {
      fragments: ['{"event":"state","seq":3,"data":{"ts":1760000001000,"state":"starting",', '}}']
    },
    replay
  )
  clock.advance(350)
  check(
    await client.readLine(),
    {
      fragments: [
        '{"event":"state","seq":4,"data":{"ts":1760000001350,"state":"on","state_since":1760000001350,',
        '"autopause":{"enabled":true,"status":"held"},"tun":{"name":"utun5","open":true}}}'
      ]
    },
    replay
  )
  check(await client.readLine(), { exact: '{"id":5,"ok":true,"result":{"state":"on"}}' }, replay)
  check(
    await client.readLine(),
    { fragments: ['{"event":"stats","seq":5,"data":{', '"state":"on",', '}}'] },
    replay
  )

  await client.send('{"id":6,"cmd":"exclude","args":{"adapter":"en9"}}\n')
  check(
    await client.readLine(),
    {
      exact:
        '{"id":6,"ok":false,"error":{"code":"unknown_adapter","message":"no adapter named \\"en9\\"","data":{"adapter":"en9"}}}'
    },
    replay
  )

  await client.send('{"id":7,"cmd":"cleanup"}\n')
  check(
    await client.readLine(),
    {
      exact:
        '{"id":7,"ok":false,"error":{"code":"invalid_state","message":"cleanup is only allowed while off","data":{"state":"on"}}}'
    },
    replay
  )

  // The appendix quits at 1760000020000 and shows no stats events before it although the 1000 ms
  // subscription is live: jump the clock without firing the ticker (see the ambiguity notes).
  clock.jumpTo(1760000020000)
  await client.send('{"id":8,"cmd":"quit"}\n')
  check(
    await client.readLine(),
    {
      fragments: [
        '{"event":"state","seq":6,"data":{"ts":1760000020000,"state":"off",',
        '"tun":{"name":null,"open":false}}}'
      ]
    },
    replay
  )
  check(await client.readLine(), { exact: '{"id":8,"ok":true,"result":{}}' }, replay)
  await client.expectEof()
  expect((await fake.exited).code).toBe(0)

  // Nine lines are printed in full in the appendix, five are elided.
  expect(replay.exact).toBe(9)
  expect(replay.partial).toBe(5)
  test.info().annotations.push({
    type: 'appendix-b',
    description: `${replay.exact} lines matched exactly, ${replay.partial} matched the shown fragments:\n${replay.log.join('\n')}`
  })
  console.log(
    `Appendix B replay: ${replay.exact} exact, ${replay.partial} partial\n  ${replay.log.join('\n  ')}`
  )

  // After quit no new session is accepted: the socket is gone.
  await expect(netd.connect()).rejects.toThrow()
})

test('Appendix B refused second client replays byte for byte', async ({ netd }) => {
  const { client: first } = await netd.session()
  const second = await netd.connect()
  await second.send(
    '{"id":1,"cmd":"hello","args":{"protocol":[1],"client":"lychee","client_version":"0.2.0"}}\n'
  )
  expect(await second.readLine()).toBe(
    '{"id":1,"ok":false,"error":{"code":"busy","message":"another client session is active","data":{"session_pid":4098}}}'
  )
  await second.expectEof()

  // The first session is unaffected.
  await first.request({ id: 2, cmd: 'status' })
  expect(await first.readJson()).toMatchObject({ id: 2, ok: true })
})

test('Appendix B wrong uid receives nothing and sees EOF', async ({ netd }) => {
  await netd.start({ rejectPeers: true })
  const client = await netd.connect()
  await client.expectEof()
  expect(client.bytesReceived).toBe(0)

  // Even a client that talks first gets nothing back.
  const talker = await netd.connect()
  await talker
    .send(
      '{"id":1,"cmd":"hello","args":{"protocol":[1],"client":"lychee","client_version":"0.2.0"}}\n'
    )
    .catch(() => {})
  await talker.expectEof()
  expect(talker.bytesReceived).toBe(0)
})
