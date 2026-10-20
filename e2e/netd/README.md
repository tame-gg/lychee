# Fake `lychee-netd` (test only)

A TypeScript fake of the privileged network helper `lychee-netd serve --control <path>`, speaking the
control channel of [`docs/netd-control-channel.md`](../../docs/netd-control-channel.md) over a real
Unix socket or Windows named pipe. It exists so the IPC client
(`src/main/network/merge/netdClient.ts`) and the controller above it (`mergeController.ts`, plan
item L-3) can be tested against exact, scripted frames without a Go toolchain, a TUN adapter, or any
privilege.

**It is not shipped.** `electron-builder.yml` excludes `e2e/**`; the asar contains none of it. It is
also **not** the real client — the client is written against this fake, not the other way round.

Everything is driven by a manual clock, so tests never wait real seconds for the 5 s hello timeout,
the 10 s grace period or the 30 s startup/stall timers. The protocol types live in
[`protocol.ts`](./protocol.ts) (copied from the spec's Appendix C, no `src/` import).

## Files

| File             | What it is                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `fakeNetd.ts`    | the helper: framing, hello, the 14 commands, events, state machine, grace/startup/stall timers, scripting controls |
| `fakeClock.ts`   | `FakeClock` — `now()`, `setTimeout`, `advance(ms)`, `advanceTo(ts)`, `jumpTo(ts)`                                  |
| `controlPath.ts` | `uniqueControlPath()` — a per-test temp-dir socket (Unix) or `\\.\pipe\lychee-netd-test-<random>` (Windows)        |
| `testClient.ts`  | `TestClient` — a dumb raw client: send bytes, read lines with a timeout, `expectEof()`                             |
| `fakeLaunch.ts`  | `fakeNetdLaunch({ outcome })` — simulates launch exit codes (2.7) and the Windows pipe dead ends (2.4, 10.6)       |
| `harness.ts`     | a Playwright `test` fixture (`netd`) that wires a clock, control path, and teardown together                       |

## Starting the fake in a test

Use the `netd` fixture from `harness.ts` (it owns the clock, the control path, and cleanup):

```ts
import { expect, test, resultOf } from './netd/harness'

test('turns merging on', async ({ netd }) => {
  const { client } = await netd.session() // start + connect + hello (Appendix B defaults)
  await client.request({ id: 2, cmd: 'on' })
  await client.readJson() // state: starting
  await client.readJson() // state: on
  expect(resultOf(await client.readJson())).toEqual({ state: 'on' })
})
```

`netd.start(options?)` starts the fake, `netd.connect()` returns a `TestClient`, `netd.hello(client)`
does the handshake and returns the hello response plus the `state` event that follows it.
`netd.session(options?)` does all three. The default identity reproduces Appendix B (darwin/arm64,
pid 5120, instance `3f9c2a7e…`, uid 501, capabilities `link_counters`+`keep_adapter_on_off`, adapters
`en0` and `en7`). Override any of it through the options (`os`, `arch`, `auth`, `capabilities`,
`adapters`, `skipped`, `clientPid`, `tunName`, `supportedProtocols`, `capture`, …).

## The clock

The fake takes all time from `FakeClock`. Tests move time themselves:

```ts
netd.clock.advance(5000) // fire every timer due in the next 5 s (hello timeout, stats ticks, …)
netd.clock.advanceTo(1760000001350) // advance to an absolute ts
netd.clock.jumpTo(1760000020000) // set the clock WITHOUT firing timers (see Appendix B replay)
```

The clock starts at `1759999999500`; a hello 500 ms later lands on Appendix B's first `ts`
(`1760000000000`). Stats ticks, the hello timeout, the grace period, the startup timeout, the write
stall and scripted command delays are all clock timers.

## Scripting the engine

On a running `FakeNetd`:

- **Adapters.** `addAdapter(spec)`, `removeAdapter(name)`, `updateAdapter(name, patch)` (link up/down
  via `state`/`state6`, address changes, `present: false` for "vanished with active flows"),
  `setSkipped([...])`.
- **Stats values.** `setSampler((ctx) => Partial<AdapterCounters>)` — called per adapter per snapshot
  with `{ tick, ts, adapter, state, excluded }`; the fake truncates rates to integers and fills in an
  excluded adapter's zeros. The default sampler gives each adapter a steady, index-derived rate.
- **Capture / failures.** `setCapture(available, error?)`, `setOnFailure(message | null)` (every later
  `on` fails with `internal` and that message, state `error`), `setCleanupFailure(message | null)`.
- **Timing.** `setDelay(cmd, ms)` delays a command by fake-clock time (for `on`, between the
  `starting` and `on` events); `holdNext(cmd)` returns `{ release() }` to hold the next such command
  in real time until the test releases it.
- **Autopause.** `autoPause()` / `autoResume()` drive the `paused_auto` transitions (10.1's timers are
  informative; these make them explicit and observable).
- **Events.** `log(level, message)` emits a `log` event (rate-limited to 20/s of fake time);
  `dropEvents(n)` simulates backpressure (`seq` advances, `dropped` grows).
- **Faults.** `disconnect()` drops the session (grace starts), `crash(code?)` destroys everything
  without a response and exits with `code`, `setRejectPeers(true)` makes every connection close with
  zero bytes.

Observe via `fake.view` (state, autopause, excluded, weights, session number, subscription interval,
grace/exited flags), `fake.exited` (resolves with `{ code }`), `fake.nextRequest(cmd)`,
`fake.waitForConnections(n)`, and the events `'session'`, `'sessionLost'`, `'grace'`, `'writeStall'`,
`'exit'`, `'request'`, `'response'`, `'rejected'`.

## Launch outcomes (process-level, not frames)

`fakeNetdLaunch({ outcome, path, ...identity })` models what starting the helper can come to, for
client tests that need the exit codes and Windows pipe dead ends rather than a live session:

| `outcome`                                                                 | Meaning                                                | `exitCode` / `connect`                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `serve`                                                                   | the helper runs; a `FakeNetd` listens on `path`        | `null` until it exits; `connect.ok` with the server pid/SID    |
| `usage` / `refused` / `another_tool` / `transport_failed` / `needs_admin` | exit 2 / 3 / 4 / 5 / 6 (section 2.7)                   | that code, one-line `stderr`, nothing listening                |
| `peer_rejected`                                                           | runs, but the peer check fails (3.3)                   | connections get EOF with zero bytes                            |
| `access_denied`                                                           | Windows 2.4 rule 1: alive but belongs to another admin | `connect.error` `EACCES`, nothing on `path`                    |
| `squatted`                                                                | Windows 2.4 rule 6: another process owns the name      | `connect.ok` with a foreign pid/SID, accepts and never answers |

The returned object exposes `exitCode`, `stderr`, `exited`, `netd` (the live fake for `serve`/
`peer_rejected`), `connect`, and `kill()`. Where the spec leaves the handling to the client, this only
exposes the raw outcome; it does not decide "needs admin" vs "unavailable".

## Running the specs

```bash
LYCHEE_E2E_SKIP_BUILD=1 npx playwright test e2e/netdFakeAppendixB.spec.ts \
  e2e/netdFakeFraming.spec.ts e2e/netdFakeCommands.spec.ts e2e/netdFakeScripting.spec.ts \
  e2e/netdClient.spec.ts e2e/mergeController.spec.ts
```

`LYCHEE_E2E_SKIP_BUILD=1` is required: these specs are pure Node and must not trigger the Electron
build that `playwright.config.ts`'s global setup otherwise runs. Add `--repeat-each=5` to check for
flakiness (there is none; the fake clock makes them deterministic).

`netdClient.spec.ts` drives the real client against the fake, including a replay of Appendix B that
checks the frames the client sends and receives byte for byte. `mergeController.spec.ts` drives the
controller with `fakeNetdLaunch` standing in for the launcher: launch outcomes, settings
re-application, reconnects within the grace period, crashes and shutdown.

## The app against the fake

`e2e/merge.spec.ts` runs the built app with `LYCHEE_E2E_NETD=<control path>`: the app then connects
to the fake listening there instead of launching a helper (the knob is ignored by a packaged build,
like every other `testKnobs` entry). The fake must report the app's own `package.json` version as
`helperVersion`, or the app refuses it as out of date.

Spec-ambiguity decisions are written up in `notes/fakenetd-ambiguities.md`, kept outside the repo
under the `s1/` work root (sibling of this checkout), alongside this task's planning notes.
