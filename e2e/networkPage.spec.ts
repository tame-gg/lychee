import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeTests, type Page } from '@playwright/test'
import type { MergeState } from '../src/shared/types'
import { test, expect } from './fixtures'
import { test as netdTest } from './netd/harness'

// The Network page (plan step L-6): hidden unless asked for, and when shown, wired either to the
// helper (here the fake netd) or to the renderer's own simulation.

const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string
}

const sidebarItem = (page: Page): ReturnType<Page['getByRole']> =>
  page
    .getByRole('navigation', { name: 'Download categories' })
    .getByRole('button', { name: 'Network', exact: true })

async function openNetworkPage(page: Page): Promise<void> {
  await sidebarItem(page).click()
  await expect(page.getByRole('heading', { name: 'Network', exact: true })).toBeVisible()
}

const statusWord = (page: Page): ReturnType<Page['getByRole']> =>
  page.getByRole('status', { name: 'Combining status' })

test('the Network page is hidden by default, and merging stays off', async ({ lychee }) => {
  const page = lychee.page
  await expect(page.getByRole('navigation', { name: 'Download categories' })).toBeVisible()
  await expect(sidebarItem(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.lychee.initialState.networkPage)).toBe('off')
  const state = (await lychee.api.mergeState()) as MergeState
  expect(state).toMatchObject({ status: 'off', settings: { enabled: false } })
})

const helperTest = mergeTests(test, netdTest).extend<{ appEnv: Record<string, string> }>({
  appEnv: async ({ netd }, use) => {
    await use({ LYCHEE_E2E_NETD: netd.path, LYCHEE_NETWORK_PAGE: '1' })
  }
})

helperTest(
  'with the flag on, the page drives the helper: switch, rows, exclusion, errors',
  async ({ lychee, netd }) => {
    const fake = await netd.start({ helperVersion: version })
    const page = lychee.page
    await openNetworkPage(page)
    await expect(statusWord(page)).toHaveText('Off')
    const toggle = page.getByRole('switch', { name: 'Combine connections' })
    await expect(toggle).not.toBeChecked()
    expect(fake.connections, 'nothing contacts the helper until asked').toBe(0)

    await toggle.click()
    await expect(statusWord(page)).toHaveText('Merging')
    const table = page.getByRole('table', { name: 'Connections' })
    await expect(table.getByRole('row', { name: 'en0' })).toBeVisible()
    await expect(table.getByRole('row', { name: 'en7' })).toBeVisible()
    netd.clock.advance(1000)

    await table.getByRole('checkbox', { name: 'Combine en7' }).click()
    await expect.poll(() => fake.view.excluded).toEqual(['en7'])
    await expect(table.getByRole('checkbox', { name: 'Combine en7' })).not.toBeChecked()

    await page
      .getByRole('switch', { name: 'Pause by itself when only one connection works' })
      .click()
    await expect.poll(() => fake.view.autopause).toBe('disabled')

    fake.setOnFailure('route 0.0.0.0/1: file exists')
    await toggle.click()
    await expect(statusWord(page)).toHaveText('Off')
    await toggle.click()
    await expect(statusWord(page)).toHaveText('Error: route 0.0.0.0/1: file exists')

    await page.getByRole('button', { name: 'Downloads' }).click()
    await expect(page.getByRole('heading', { name: 'Network', exact: true })).toHaveCount(0)
  }
)

test.describe('with the simulated helper', () => {
  test.use({ appEnv: { LYCHEE_NETWORK_PAGE: 'mock' } })

  test('renders its connections and never reaches the real controller', async ({ lychee }) => {
    const page = lychee.page
    await openNetworkPage(page)
    await page.getByRole('switch', { name: 'Combine connections' }).click()
    await expect(statusWord(page)).toHaveText('Merging')
    const table = page.getByRole('table', { name: 'Connections' })
    for (const name of ['Wi-Fi', 'Ethernet', 'iPhone USB']) {
      await expect(table.getByRole('row', { name })).toBeVisible()
    }
    await expect(page.getByRole('region', { name: 'Also seen but not used' })).toContainText(
      'tailscale0'
    )
    const state = (await lychee.api.mergeState()) as MergeState
    expect(state).toMatchObject({ status: 'off', settings: { enabled: false } })
  })
})

for (const [outcome, word] of [
  ['not_installed', 'Helper not installed'],
  ['needs_permission', 'Needs permission'],
  ['another_tool', 'Another connection-merging tool is running'],
  ['paused_auto', 'Paused: one connection']
] as const) {
  test.describe(`simulated ${outcome}`, () => {
    test.use({ appEnv: { LYCHEE_NETWORK_PAGE: `mock:${outcome}` } })

    test(`turning combining on shows "${word}"`, async ({ lychee }) => {
      const page = lychee.page
      await openNetworkPage(page)
      await page.getByRole('switch', { name: 'Combine connections' }).click()
      await expect(statusWord(page)).toHaveText(word)
    })
  })
}
