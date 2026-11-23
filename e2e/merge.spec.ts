import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mergeTests } from '@playwright/test'
import type { MergeState, NetworkInterfaceInfo } from '../src/shared/types'
import { test as appTest, expect } from './fixtures'
import { test as netdTest } from './netd/harness'

const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string
}

const test = mergeTests(appTest, netdTest).extend<{ appEnv: Record<string, string> }>({
  appEnv: async ({ netd, dirs }, use) => {
    await use({
      LYCHEE_E2E_NETD: netd.path,
      LYCHEE_E2E_DIAGNOSTICS: join(dirs.userData, 'diagnostics.zip')
    })
  }
})

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('merging is off by default and the helper is never contacted', async ({ lychee, netd }) => {
  const fake = await netd.start({ helperVersion: version })
  const state = (await lychee.api.mergeState()) as MergeState
  expect(state).toMatchObject({ status: 'off', settings: { enabled: false }, helper: null })
  await settle(500)
  expect(fake.connections).toBe(0)
})

test('turning merging on through window.lychee drives the helper, reports its state and saves the choice', async ({
  lychee,
  netd
}) => {
  const fake = await netd.start({ helperVersion: version })

  await lychee.api.setMerging(true)
  await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('on')
  const on = (await lychee.api.mergeState()) as MergeState
  expect(on.helper).toMatchObject({ version, pid: 5120 })
  expect(on.adapters.map((adapter) => adapter.name)).toEqual(['en0', 'en7'])
  expect(on.tun).toEqual({ name: 'utun5', open: true })
  expect(fake.view).toMatchObject({ state: 'on', session: 1, subscriptionMs: 1000 })

  netd.clock.advance(1000)
  netd.clock.advance(1000)
  await expect
    .poll(async () => ((await lychee.api.mergeState()) as MergeState).history.down.en0?.length)
    .toBe(3)

  await lychee.api.setMergeNetwork('en7', false)
  await lychee.api.setMergeOptions({ autoPause: false })
  await expect.poll(() => fake.view.excluded).toEqual(['en7'])
  expect(fake.view.autopause).toBe('disabled')

  const settingsPath = join(lychee.dirs.userData, 'app-settings.json')
  await expect
    .poll(async () => JSON.parse(await readFile(settingsPath, 'utf8')).merge)
    .toEqual({ enabled: true, ipv6: 'auto', autoPause: false, excluded: ['en7'], weights: {} })

  await lychee.api.setMerging(false)
  await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('off')
  expect(fake.view.state).toBe('off')

  await lychee.quit()
  expect((await fake.exited).code).toBe(0)
})

test('with merging enabled, the app starts the helper at launch, applies its settings and quits it on exit', async ({
  lychee,
  netd
}) => {
  const first = await netd.start({ helperVersion: version })
  await lychee.api.setMerging(true)
  await lychee.api.setMergeNetwork('en7', false)
  await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('on')
  await lychee.quit()
  expect((await first.exited).code).toBe(0)

  const second = await netd.start({ helperVersion: version })
  await lychee.launch()
  await expect
    .poll(async () => ((await lychee.api.mergeState()) as MergeState).status, { timeout: 15000 })
    .toBe('on')
  expect(second.view).toMatchObject({ state: 'on', excluded: ['en7'] })
  const state = (await lychee.api.mergeState()) as MergeState
  expect(state.settings).toMatchObject({ enabled: true, excluded: ['en7'] })

  second.setOnFailure('route 0.0.0.0/1: file exists')
  await lychee.api.setMerging(false)
  await lychee.api.setMerging(true)
  await expect
    .poll(async () => ((await lychee.api.mergeState()) as MergeState).status)
    .toBe('error')
  expect(((await lychee.api.mergeState()) as MergeState).message).toBe(
    'route 0.0.0.0/1: file exists'
  )

  await lychee.quit()
  expect((await second.exited).code).toBe(0)
})

test('a helper that vanishes is reported as stopped, with the history kept', async ({
  lychee,
  netd
}) => {
  const fake = await netd.start({ helperVersion: version })
  await lychee.api.setMerging(true)
  await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('on')
  netd.clock.advance(1000)
  await expect
    .poll(async () => ((await lychee.api.mergeState()) as MergeState).history.down.en0?.length)
    .toBe(2)
  fake.crash()
  await expect
    .poll(async () => ((await lychee.api.mergeState()) as MergeState).status, { timeout: 15000 })
    .toBe('stopped')
  const state = (await lychee.api.mergeState()) as MergeState
  expect(state.history.down.en0).toHaveLength(2)
  expect(state.settings.enabled).toBe(true)
})

const tunTest = test.extend({
  appEnv: async ({ netd }, use) => {
    await use({
      LYCHEE_E2E_NETD: netd.path,
      LYCHEE_E2E_INTERFACES:
        'wifi=192.0.2.2,utun5=192.0.2.9,lychee-netd=198.18.0.1,tun9=fd6e:6d65:7267::1'
    })
  }
})

test('a dropped session reconnects within the grace period and merging stays on', async ({
  lychee,
  netd
}) => {
  const fake = await netd.start({ helperVersion: version })
  await lychee.api.setMerging(true)
  await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('on')
  const instance = ((await lychee.api.mergeState()) as MergeState).helper?.instance
  fake.disconnect()
  await expect.poll(() => fake.view.session).toBe(2)
  await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('on')
  const state = (await lychee.api.mergeState()) as MergeState
  expect(state.helper?.instance).toBe(instance)
  expect(fake.view).toMatchObject({ state: 'on', exited: false, graceRunning: false })
})

test('a helper that exits with a code is stopped, with that code mapped and the history kept', async ({
  lychee,
  netd
}) => {
  const fake = await netd.start({ helperVersion: version })
  await lychee.api.setMerging(true)
  await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('on')
  netd.clock.advance(1000)
  await expect
    .poll(async () => ((await lychee.api.mergeState()) as MergeState).history.down.en0?.length)
    .toBe(2)
  writeFileSync(`${netd.path}.exit`, '4\nanother connection-merging tool is running\n')
  fake.crash(4)
  await expect
    .poll(async () => ((await lychee.api.mergeState()) as MergeState).status, { timeout: 15000 })
    .toBe('stopped')
  const state = (await lychee.api.mergeState()) as MergeState
  expect(state.message).toBe(
    'Helper stopped unexpectedly: another connection-merging tool is running'
  )
  expect(state.history.down.en0).toHaveLength(2)
  expect(state.settings.enabled).toBe(true)
})

test('quit sends quit before the app exits, and a held quit still ends within 3s', async ({
  lychee,
  netd
}) => {
  const fake = await netd.start({ helperVersion: version })
  await lychee.api.setMerging(true)
  await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('on')
  const logsDir = await lychee.evaluateMain(({ app }) => app.getPath('userData'), null)
  const order: string[] = []
  fake.on('request', (req: { cmd: string }) => {
    if (req.cmd === 'quit') order.push('quit')
  })
  fake.on('exit', () => order.push('helper-exit'))
  const started = Date.now()
  await lychee.quit()
  order.push('app-exit')
  expect(order).toEqual(['quit', 'helper-exit', 'app-exit'])
  expect(Date.now() - started).toBeLessThan(3000)
  const log = readFileSync(join(logsDir, 'logs', 'lychee-netd.log'), 'utf8')
  expect(log.indexOf('quit: sending')).toBeGreaterThanOrEqual(0)
  expect(log.indexOf('quit: acknowledged')).toBeGreaterThan(log.indexOf('quit: sending'))

  const again = await netd.start({ helperVersion: version })
  await lychee.launch()
  await lychee.api.setMerging(true)
  await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('on')
  again.holdNext('quit')
  const held = Date.now()
  await lychee.quit()
  expect(Date.now() - held).toBeLessThan(3000)
})

test('closing the last window while merging keeps Lychee and the helper until the tray quits', async ({
  lychee,
  netd
}) => {
  const fake = await netd.start({ helperVersion: version })
  await lychee.api.setMerging(true)
  await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('on')
  await lychee.evaluateMain(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.close()
  }, null)
  await expect.poll(() => fake.view.exited).toBe(false)
  expect(lychee.electronApp.process().exitCode).toBeNull()
  await expect
    .poll(() =>
      lychee.evaluateMain(({ app, BrowserWindow }) => {
        const hook = (app as unknown as { __lycheeTray?: { labels: string[] } }).__lycheeTray
        return hook
          ? hook.labels.join('|')
          : `missing (${BrowserWindow.getAllWindows().length} windows)`
      }, null)
    )
    .toContain('Stop merging and quit')
  const labels = (await lychee.evaluateMain(({ app }) => {
    const hook = (app as unknown as { __lycheeTray?: { labels: string[] } }).__lycheeTray
    return hook?.labels ?? []
  }, null)) as string[]
  expect(labels).toContain('Merging')
  expect(labels).toContain('Stop merging and quit')
  expect(labels).toContain('Export diagnostics')
  expect(labels).not.toContain('Quit Lychee')
  const child = lychee.electronApp.process()
  const appExit = new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode)
    else child.once('exit', (code) => resolve(code))
  })
  const started = Date.now()
  await lychee
    .evaluateMain(({ app }) => {
      const hook = (app as unknown as { __lycheeTray?: { click: (label: string) => void } })
        .__lycheeTray
      hook?.click('Stop merging and quit')
    }, null)
    .catch(() => {})
  const code = await Promise.race([
    appExit,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('quit timed out')), 5000)
    )
  ])
  expect(code).toBe(0)
  expect(Date.now() - started).toBeLessThan(3000)
  expect((await fake.exited).code).toBe(0)
  const saved = JSON.parse(
    readFileSync(join(lychee.dirs.userData, 'app-settings.json'), 'utf8')
  ) as { merge: { enabled: boolean } }
  expect(saved.merge.enabled).toBe(false)
  const next = await netd.start({ helperVersion: version })
  await lychee.launch()
  await settle(500)
  const restarted = (await lychee.api.mergeState()) as MergeState
  expect(restarted.settings.enabled).toBe(false)
  expect(restarted.status).toBe('off')
  expect(next.connections).toBe(0)
})

function zipEntries(path: string): Record<string, string> {
  const run = spawnSync(
    'python3',
    [
      '-c',
      'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n: z.read(n).decode() for n in z.namelist()}))',
      path
    ],
    { encoding: 'utf8' }
  )
  expect(run.status, run.stderr).toBe(0)
  return JSON.parse(run.stdout) as Record<string, string>
}

test('the netd log and diagnostics export redact home paths and skip payload dumps', async ({
  lychee,
  netd
}) => {
  const fake = await netd.start({ helperVersion: version })
  await lychee.api.setMerging(true)
  await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('on')
  const home = homedir()
  fake.log('warn', `token=supersecret path ${home}/Library/Lychee payload ${'ab'.repeat(70)}`)
  const logPath = join(lychee.dirs.userData, 'logs', 'lychee-netd.log')
  await expect.poll(() => readFileSync(logPath, 'utf8')).toContain('helper warn:')
  const log = readFileSync(logPath, 'utf8')
  expect(log).not.toContain(home)
  expect(log).not.toContain('supersecret')
  expect(log).toContain('token=[redacted]')
  expect(log).toContain('[payload omitted]')
  expect(log).toContain('session ready')

  const menuLabels = await lychee.evaluateMain(({ Menu }) => {
    const found: string[] = []
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) {
        if (item.label) found.push(item.label)
        if (item.submenu) walk(item.submenu.items)
      }
    }
    const menu = Menu.getApplicationMenu()
    if (menu) walk(menu.items)
    return found
  }, null)
  expect(menuLabels).toContain('Export diagnostics')
  await lychee.evaluateMain(({ Menu }) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === 'Export diagnostics') return item
        const nested = item.submenu ? walk(item.submenu.items) : undefined
        if (nested) return nested
      }
      return undefined
    }
    const menu = Menu.getApplicationMenu()
    const item = menu ? walk(menu.items) : undefined
    if (!item) throw new Error('Export diagnostics is not in the menu')
    item.click()
  }, null)
  const zipPath = join(lychee.dirs.userData, 'diagnostics.zip')
  await expect.poll(() => readFileSync(zipPath).length).toBeGreaterThan(0)

  await lychee.page
    .getByRole('navigation', { name: 'Download categories' })
    .getByRole('button', { name: 'Network', exact: true })
    .click()
  await lychee.page.getByRole('button', { name: 'Export diagnostics' }).click()
  await expect(lychee.page.getByText('Diagnostics saved')).toBeVisible()

  const entries = zipEntries(zipPath)
  expect(Object.keys(entries).sort()).toEqual(['diagnostics.json', 'lychee-netd.log'])
  const dumped = Object.values(entries).join('\n')
  expect(dumped).not.toContain(home)
  expect(dumped).not.toContain('supersecret')
  expect(dumped).toContain('[payload omitted]')
  const doc = JSON.parse(entries['diagnostics.json']) as {
    lycheeVersion: string
    helperVersion: string
    os: { platform: string; arch: string }
    mergeSettings: { enabled: boolean }
    status: { status: string; history?: unknown; adapters: unknown[] }
  }
  expect(doc.lycheeVersion).toBe(version)
  expect(doc.helperVersion).toBe(version)
  expect(doc.os.platform).toBe(process.platform)
  expect(doc.os.arch).toBe(process.arch)
  expect(doc.mergeSettings.enabled).toBe(true)
  expect(doc.status.status).toBe('on')
  expect(doc.status.history).toBeUndefined()
  expect(doc.status.adapters).toHaveLength(2)
})

tunTest(
  "the helper's TUN adapter is never one of the networks: by its name, its addresses, or the name the helper reports",
  async ({ lychee, netd }) => {
    await netd.start({ helperVersion: version, capabilities: ['link_counters'] })
    const ids = async (): Promise<string[]> =>
      ((await lychee.api.listInterfaces()) as NetworkInterfaceInfo[]).map((iface) => iface.id)
    expect(await ids()).toEqual(['wifi', 'utun5'])

    await lychee.api.setMerging(true)
    await expect.poll(async () => ((await lychee.api.mergeState()) as MergeState).status).toBe('on')
    expect(((await lychee.api.mergeState()) as MergeState).tun).toEqual({
      name: 'utun5',
      open: true
    })
    await expect.poll(ids).toEqual(['wifi'])

    await lychee.api.setMerging(false)
    await expect
      .poll(async () => ((await lychee.api.mergeState()) as MergeState).status)
      .toBe('off')
    expect(((await lychee.api.mergeState()) as MergeState).tun).toEqual({ name: null, open: false })
    await expect.poll(ids).toEqual(['wifi', 'utun5'])
  }
)
