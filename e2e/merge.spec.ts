import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mergeTests } from '@playwright/test'
import type { MergeState } from '../src/shared/types'
import { test as appTest, expect } from './fixtures'
import { test as netdTest } from './netd/harness'

const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string
}

const test = mergeTests(appTest, netdTest).extend<{ appEnv: Record<string, string> }>({
  appEnv: async ({ netd }, use) => {
    await use({ LYCHEE_E2E_NETD: netd.path })
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
