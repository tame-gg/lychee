import { Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { DEFAULT_MERGE_SETTINGS } from '../src/shared/mergeSettings'
import type { MergeSettings, MergeState } from '../src/shared/types'
import {
  ADMIN_ACCOUNT_MESSAGE,
  type HelperExit,
  type HelperProcess,
  type Launcher,
  type LaunchResult
} from '../src/main/network/merge/elevate'
import {
  BUSY_MESSAGE,
  MergeController,
  NO_ADAPTERS_MESSAGE,
  STOPPED_MESSAGE,
  type MergeTiming
} from '../src/main/network/merge/mergeController'
import {
  fakeNetdLaunch,
  type FakeNetdProcess,
  type LaunchOptions,
  type LaunchOutcome
} from './netd/fakeLaunch'
import type { FakeNetd } from './netd/fakeNetd'
import { expect, test as base, type NetdHarness } from './netd/harness'

const VERSION = '0.2.0'

function wrap(proc: FakeNetdProcess): HelperProcess {
  let exit: HelperExit | null = null
  const exited = proc.exited.then((info) => {
    exit = { code: info.code, signal: null }
    return exit
  })
  return {
    get pid() {
      return proc.pid
    },
    get exit() {
      return exit
    },
    exited,
    get stderr() {
      return proc.stderr
    },
    kill: () => void proc.kill()
  }
}

class ScriptedLauncher implements Launcher {
  readonly processes: FakeNetdProcess[] = []
  calls = 0
  outcomes: LaunchOutcome[] = ['serve']
  options: Partial<LaunchOptions> = {}

  constructor(private readonly netd: NetdHarness) {}

  get fake(): FakeNetd {
    const current = this.processes.at(-1)?.netd
    if (!current) throw new Error('no fake helper is running')
    return current
  }

  async launch(): Promise<LaunchResult> {
    const outcome = this.outcomes[Math.min(this.calls, this.outcomes.length - 1)]
    this.calls++
    const proc = await fakeNetdLaunch({
      helperVersion: VERSION,
      ...this.options,
      outcome,
      path: this.netd.path,
      clock: this.netd.clock
    })
    this.processes.push(proc)
    const launched: LaunchResult = { kind: 'launched', path: proc.path, process: wrap(proc) }
    if (outcome === 'squatted') {
      launched.verify = async () => {
        throw new Error(
          `the pipe belongs to another process (pid ${proc.connect.kind === 'ok' ? proc.connect.serverPid : '?'})`
        )
      }
    }
    return launched
  }
}

interface Harness {
  launcher: ScriptedLauncher
  controller: MergeController
  pushes: MergeState[]
  saved: MergeSettings[]
  logs: string[]
  stored: () => MergeSettings
  status: () => string
}

interface HarnessOptions {
  settings?: Partial<MergeSettings>
  timing?: Partial<MergeTiming>
  platform?: NodeJS.Platform
  connect?: (path: string) => Socket
}

const test = base.extend<{ make: (options?: HarnessOptions) => Harness }>({
  make: async ({ netd }, use) => {
    const made: Harness[] = []
    await use((options = {}) => {
      const launcher = new ScriptedLauncher(netd)
      const pushes: MergeState[] = []
      const saved: MergeSettings[] = []
      const logs: string[] = []
      let stored: MergeSettings = { ...DEFAULT_MERGE_SETTINGS, ...options.settings }
      const controller = new MergeController({
        launcher,
        version: VERSION,
        settings: {
          load: async () => stored,
          save: async (settings) => {
            stored = settings
            saved.push(settings)
          }
        },
        push: (state) => pushes.push(state),
        log: (line) => logs.push(line),
        platform: options.platform ?? 'linux',
        connect: options.connect,
        timing: {
          connectRetryMs: 20,
          connectTimeoutMs: 1500,
          reconnectEveryMs: 40,
          graceMs: 800,
          pushEveryMs: 100,
          quitTimeoutMs: 300,
          commandTimeoutMs: 2000,
          longCommandTimeoutMs: 2000,
          ...options.timing
        }
      })
      const harness: Harness = {
        launcher,
        controller,
        pushes,
        saved,
        logs,
        stored: () => stored,
        status: () => controller.state().status
      }
      made.push(harness)
      return harness
    })
    for (const harness of made) {
      await harness.controller.shutdown()
      for (const proc of harness.launcher.processes) await proc.kill()
    }
  }
})

function requests(harness: Harness): string[] {
  const seen: string[] = []
  harness.launcher.fake.on('request', (req: { cmd: string }) => seen.push(req.cmd))
  return seen
}

test('merging is off by default and nothing is launched', async ({ make }) => {
  const h = make()
  await h.controller.start()
  expect(h.launcher.calls).toBe(0)
  expect(h.controller.state()).toMatchObject({
    status: 'off',
    message: null,
    settings: { enabled: false, ipv6: 'auto', autoPause: true },
    helper: null,
    adapters: []
  })
  expect(h.pushes).toHaveLength(1)
})

test('turning merging on launches the helper, applies the saved settings and turns it on', async ({
  make,
  netd
}) => {
  const h = make({
    settings: { ipv6: 'off', autoPause: false, excluded: ['en7'], weights: { en0: 3 } }
  })
  await h.controller.start()
  const seen: string[] = []
  const original = h.launcher.launch.bind(h.launcher)
  h.launcher.launch = async () => {
    const result = await original()
    if (result.kind === 'launched') seen.push(...requests(h).splice(0))
    h.launcher.fake.on('request', (req: { cmd: string }) => seen.push(req.cmd))
    return result
  }

  await h.controller.setMerging(true)

  expect(h.launcher.calls).toBe(1)
  expect(h.status()).toBe('on')
  expect(seen).toEqual([
    'hello',
    'subscribe',
    'status',
    'set_ipv6',
    'set_autopause',
    'exclude',
    'set_weight',
    'on'
  ])
  expect(h.launcher.fake.view).toMatchObject({
    state: 'on',
    autopause: 'disabled',
    excluded: ['en7'],
    weights: { en0: 3 },
    subscriptionMs: 1000
  })
  expect(h.stored().enabled).toBe(true)
  const statuses = h.pushes.map((push) => push.status)
  expect(statuses.filter((status, index) => status !== statuses[index - 1])).toEqual([
    'off',
    'starting',
    'on'
  ])

  const state = h.controller.state()
  expect(state.helper).toMatchObject({ version: VERSION, pid: 5120, os: 'darwin', arch: 'arm64' })
  expect(state.adapters.map((adapter) => adapter.name)).toEqual(['en0', 'en7'])
  expect(state.ipv6?.mode).toBe('off')
  expect(state.autopause).toEqual({ enabled: false, status: 'disabled' })
  expect(state.tun).toEqual({ name: 'utun5', open: true })

  netd.clock.advance(1000)
  netd.clock.advance(1000)
  await expect.poll(() => h.controller.state().history.down.en0?.length).toBe(3)
  const latest = h.controller.state()
  expect(latest.history.up.en7).toHaveLength(3)
  expect(latest.totals?.adapters_present).toBe(2)
})

test('with merging enabled, start launches the helper and turns merging on', async ({ make }) => {
  const h = make({ settings: { enabled: true } })
  await h.controller.start()
  expect(h.launcher.calls).toBe(1)
  expect(h.status()).toBe('on')
  expect(h.launcher.fake.view.state).toBe('on')
})

test('turning merging off sends off and keeps the helper for its stats', async ({ make }) => {
  const h = make()
  await h.controller.start()
  await h.controller.setMerging(true)
  await h.controller.setMerging(false)
  expect(h.status()).toBe('off')
  expect(h.launcher.fake.view).toMatchObject({ state: 'off', autopause: 'manual_off' })
  expect(h.launcher.processes[0].exitCode).toBeNull()
  expect(h.stored().enabled).toBe(false)
  await h.controller.setMerging(true)
  expect(h.launcher.calls).toBe(1)
  expect(h.status()).toBe('on')
})

test.describe('launch outcomes', () => {
  const cases: Array<[LaunchOutcome, string, string]> = [
    ['usage', 'unavailable', 'usage: lychee-netd serve --control <path>'],
    ['refused', 'not_installed', 'permission_denied: lychee-netd needs root'],
    ['another_tool', 'another_tool', 'another connection-merging tool is running'],
    ['transport_failed', 'unavailable', 'cannot create control transport'],
    ['needs_admin', 'needs_admin', ADMIN_ACCOUNT_MESSAGE],
    ['peer_rejected', 'unavailable', 'did not answer'],
    ['squatted', 'unavailable', 'belongs to another process (pid 7777)']
  ]
  for (const [outcome, status, message] of cases) {
    test(`${outcome} is reported as ${status}`, async ({ make }) => {
      const h = make()
      h.launcher.outcomes = [outcome]
      await h.controller.start()
      await h.controller.setMerging(true)
      expect(h.status()).toBe(status)
      expect(h.controller.state().message).toContain(message)
      expect(h.stored().enabled).toBe(true)
    })
  }

  test('a pipe the user cannot open on Windows means the helper belongs to another administrator', async ({
    make
  }) => {
    const h = make({
      platform: 'win32',
      connect: () => {
        const socket = new Socket()
        process.nextTick(() =>
          socket.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }))
        )
        return socket
      }
    })
    await h.controller.start()
    await h.controller.setMerging(true)
    expect(h.status()).toBe('needs_admin')
    expect(h.controller.state().message).toBe(ADMIN_ACCOUNT_MESSAGE)
  })

  test('a launched helper that exits before it listens is mapped by its exit code', async ({
    make
  }) => {
    const h = make()
    await h.controller.start()
    const original = h.launcher.launch.bind(h.launcher)
    h.launcher.launch = async () => {
      const result = await original()
      h.launcher.fake.crash(4)
      return result
    }
    await h.controller.setMerging(true)
    expect(h.status()).toBe('another_tool')
    expect(h.launcher.calls).toBe(1)
  })

  test('a helper of another version is out of date and is told to quit', async ({ make }) => {
    const h = make()
    h.launcher.options = { helperVersion: '0.1.0' }
    await h.controller.start()
    await h.controller.setMerging(true)
    expect(h.status()).toBe('out_of_date')
    expect(h.controller.state().message).toContain('0.1.0')
    expect(h.controller.state().message).toContain(VERSION)
    expect((await h.launcher.processes[0].exited).code).toBe(0)
  })

  test('a helper already taken by another client is unavailable', async ({ make, netd }) => {
    const h = make()
    await h.controller.start()
    const other = make()
    await other.controller.start()
    await other.controller.setMerging(true)
    expect(other.status()).toBe('on')
    h.launcher.launch = async () => ({
      kind: 'launched',
      path: netd.path,
      process: wrap(other.launcher.processes[0])
    })
    await h.controller.setMerging(true)
    expect(h.status()).toBe('unavailable')
    expect(h.controller.state().message).toBe(BUSY_MESSAGE)
  })
})

test.describe('helper errors', () => {
  test('a failed on is shown as an error until merging is turned off', async ({ make }) => {
    const h = make()
    await h.controller.start()
    const original = h.launcher.launch.bind(h.launcher)
    h.launcher.launch = async () => {
      const result = await original()
      h.launcher.fake.setOnFailure('route 0.0.0.0/1: file exists')
      return result
    }
    await h.controller.setMerging(true)
    expect(h.status()).toBe('error')
    expect(h.controller.state().message).toBe('route 0.0.0.0/1: file exists')
    await h.controller.setMerging(false)
    expect(h.status()).toBe('off')
    expect(h.controller.state().message).toBeNull()
  })

  test('no capture driver is unsupported, with the driver message', async ({ make }) => {
    const h = make()
    h.launcher.options = { capture: { available: false, error: 'no /dev/net/tun' } }
    await h.controller.start()
    await h.controller.setMerging(true)
    expect(h.status()).toBe('unsupported')
    expect(h.controller.state().message).toBe('no /dev/net/tun')
    expect(h.controller.state().capture).toEqual({ available: false, error: 'no /dev/net/tun' })
  })

  test('no usable adapter is an error with a plain message', async ({ make }) => {
    const h = make()
    h.launcher.options = { adapters: [] }
    await h.controller.start()
    await h.controller.setMerging(true)
    expect(h.status()).toBe('error')
    expect(h.controller.state().message).toBe(NO_ADAPTERS_MESSAGE)
  })
})

test.describe('options', () => {
  test('options, networks and weights reach the helper and are saved', async ({ make }) => {
    const h = make()
    await h.controller.start()
    await h.controller.setMerging(true)
    const fake = h.launcher.fake

    await h.controller.setOptions({ ipv6: 'on', autoPause: false })
    expect(fake.view.autopause).toBe('disabled')
    expect(h.controller.state().ipv6?.mode).toBe('on')
    expect(h.stored()).toMatchObject({ ipv6: 'on', autoPause: false })

    await h.controller.setNetwork('en7', false)
    expect(fake.view.excluded).toEqual(['en7'])
    expect(h.stored().excluded).toEqual(['en7'])
    await h.controller.setNetwork('en7', true)
    expect(fake.view.excluded).toEqual([])
    expect(h.stored().excluded).toEqual([])

    await h.controller.setWeight('en0', 2.5)
    expect(fake.view.weights).toEqual({ en0: 2.5 })
    expect(h.stored().weights).toEqual({ en0: 2.5 })
    await h.controller.setWeight('en0', 'auto')
    expect(fake.view.weights).toEqual({})
    expect(h.stored().weights).toEqual({})

    await h.controller.setNetwork('en9', false)
    expect(h.stored().excluded).toEqual(['en9'])
    expect(fake.view.excluded).toEqual([])

    await expect(h.controller.setWeight('en0', 1000)).rejects.toThrow('Weight out of range')
    await expect(h.controller.setNetwork('bad\nname', false)).rejects.toThrow('Unknown network')
  })

  test('a saved exclusion is re-sent when its adapter appears', async ({ make, netd }) => {
    const h = make({ settings: { excluded: ['en9'] } })
    await h.controller.start()
    await h.controller.setMerging(true)
    const fake = h.launcher.fake
    expect(fake.view.excluded).toEqual([])
    fake.addAdapter({
      name: 'en9',
      index: 20,
      ip: '10.0.0.2',
      ip6: null,
      state: 'up',
      state6: 'none'
    })
    netd.clock.advance(1000)
    await expect.poll(() => fake.view.excluded).toEqual(['en9'])
    await expect
      .poll(() => h.controller.state().adapters.map((a) => a.name))
      .toEqual(['en0', 'en7', 'en9'])
  })

  test('options are saved even while no helper runs', async ({ make }) => {
    const h = make()
    await h.controller.start()
    await h.controller.setOptions({ ipv6: 'off' })
    await h.controller.setNetwork('en7', false)
    await h.controller.setWeight('en0', 4)
    expect(h.launcher.calls).toBe(0)
    expect(h.stored()).toMatchObject({ ipv6: 'off', excluded: ['en7'], weights: { en0: 4 } })
    expect(h.controller.state().settings).toMatchObject({ ipv6: 'off', excluded: ['en7'] })
  })

  test('repair runs cleanup only while off', async ({ make }) => {
    const h = make()
    await h.controller.start()
    await h.controller.setMerging(true)
    await expect(h.controller.repair()).rejects.toThrow('cleanup is only allowed while off')
    await h.controller.setMerging(false)
    await expect(h.controller.repair()).resolves.toBeUndefined()
  })
})

test.describe('reconnect', () => {
  test('a dropped session is reconnected within the grace period with its state intact', async ({
    make
  }) => {
    const h = make()
    await h.controller.start()
    await h.controller.setMerging(true)
    const fake = h.launcher.fake
    const instance = h.controller.state().helper?.instance
    const seen = requests(h)
    fake.disconnect()
    await expect.poll(() => fake.view.session).toBe(2)
    await expect.poll(() => h.status()).toBe('on')
    expect(seen).toEqual(['hello', 'subscribe', 'status'])
    expect(h.controller.state().helper?.instance).toBe(instance)
    expect(h.pushes.map((push) => push.status).slice(-2)).toEqual(['reconnecting', 'on'])
  })

  test('a crashed helper is reported as stopped, the history is kept and the next enable relaunches', async ({
    make,
    netd
  }) => {
    const h = make()
    await h.controller.start()
    await h.controller.setMerging(true)
    netd.clock.advance(1000)
    await expect.poll(() => h.controller.state().history.down.en0?.length).toBe(2)
    h.launcher.fake.crash()
    await expect.poll(() => h.status()).toBe('stopped')
    expect(h.controller.state().message).toBe(STOPPED_MESSAGE)
    expect(h.controller.state().history.down.en0).toHaveLength(2)
    expect(h.controller.state().helper).toBeNull()
    expect(h.stored().enabled).toBe(true)

    await h.controller.setMerging(true)
    expect(h.launcher.calls).toBe(2)
    expect(h.status()).toBe('on')
    expect(h.launcher.fake.view.state).toBe('on')
  })

  test('a helper that stays unreachable past the grace period is reported as stopped', async ({
    make
  }) => {
    const h = make()
    await h.controller.start()
    await h.controller.setMerging(true)
    const fake = h.launcher.fake
    fake.setRejectPeers(true)
    fake.disconnect()
    await expect.poll(() => h.status()).toBe('reconnecting')
    await expect.poll(() => h.status(), { timeout: 5000 }).toBe('stopped')
    expect(fake.connections).toBeGreaterThan(3)
  })

  test('a new helper after a crash gets the settings applied again', async ({ make }) => {
    const h = make({ settings: { ipv6: 'off', excluded: ['en7'] } })
    await h.controller.start()
    await h.controller.setMerging(true)
    h.launcher.fake.crash()
    await expect.poll(() => h.status()).toBe('stopped')
    await h.controller.setMerging(true)
    expect(h.launcher.fake.view).toMatchObject({ state: 'on', excluded: ['en7'] })
    expect(h.controller.state().ipv6?.mode).toBe('off')
  })
})

test.describe('pushes', () => {
  test('stats are pushed at most once per interval, status changes at once', async ({
    make,
    netd
  }) => {
    const h = make({ timing: { pushEveryMs: 300 } })
    await h.controller.start()
    await h.controller.setMerging(true)
    await sleep(350)
    const before = h.pushes.length
    for (let tick = 0; tick < 5; tick++) netd.clock.advance(1000)
    expect(h.pushes.length - before).toBeLessThanOrEqual(1)
    await sleep(400)
    expect(h.pushes.length - before).toBeLessThanOrEqual(2)
    expect(h.pushes.at(-1)?.history.down.en0?.length).toBe(
      h.controller.state().history.down.en0?.length
    )
    const seqs = h.pushes.map((push) => push.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)

    const count = h.pushes.length
    await h.controller.setMerging(false)
    expect(h.pushes.length).toBeGreaterThan(count)
    expect(h.pushes.at(-1)?.status).toBe('off')
  })
})

test.describe('shutdown', () => {
  test('shutdown tells the helper to quit and waits for it', async ({ make }) => {
    const h = make()
    await h.controller.start()
    await h.controller.setMerging(true)
    await h.controller.shutdown()
    expect((await h.launcher.processes[0].exited).code).toBe(0)
    expect(h.launcher.fake.view.exited).toBe(true)
  })

  test('a helper that ignores quit is killed within the budget', async ({ make }) => {
    const h = make({ timing: { quitTimeoutMs: 200 } })
    await h.controller.start()
    await h.controller.setMerging(true)
    h.launcher.fake.holdNext('quit')
    const started = Date.now()
    await h.controller.shutdown()
    expect(Date.now() - started).toBeLessThan(1500)
    expect((await h.launcher.processes[0].exited).code).toBeNull()
  })

  test('commands after shutdown do nothing', async ({ make }) => {
    const h = make()
    await h.controller.start()
    await h.controller.shutdown()
    await h.controller.setMerging(true)
    expect(h.launcher.calls).toBe(0)
  })
})
