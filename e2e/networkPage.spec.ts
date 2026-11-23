import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mergeTests, type Page } from '@playwright/test'
import type { HttpDownloadUpdate, MergeState } from '../src/shared/types'
import { test, expect } from './fixtures'
import { test as netdTest } from './netd/harness'

// The Network page (plan step L-6): shown unless turned off, and wired either to the helper (here
// the fake netd) or to the renderer's own simulation.

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

test('the Network page is shown by default, and merging stays off', async ({ lychee }) => {
  const page = lychee.page
  await expect(sidebarItem(page)).toBeVisible()
  expect(await page.evaluate(() => window.lychee.initialState.networkPage)).toBe('helper')
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

helperTest(
  'a change the helper refuses goes back, and the page says why',
  async ({ lychee, netd }) => {
    await netd.start({ helperVersion: version })
    const page = lychee.page
    await openNetworkPage(page)
    await page.getByRole('switch', { name: 'Combine connections' }).click()
    await expect(statusWord(page)).toHaveText('Merging')
    const checkbox = page
      .getByRole('table', { name: 'Connections' })
      .getByRole('checkbox', { name: 'Combine en7' })
    await expect(checkbox).toBeChecked()

    await lychee.evaluateMain(({ ipcMain }) => {
      ipcMain.removeHandler('merge:set-network')
      ipcMain.handle('merge:set-network', () => {
        throw new Error('the helper refused')
      })
    }, null)
    await checkbox.click()
    await expect(page.getByRole('alert')).toHaveText('the helper refused')
    await expect(checkbox).toBeChecked()
    const state = (await lychee.api.mergeState()) as MergeState
    expect(state.settings.excluded).toEqual([])
  }
)

test.describe('with the simulated helper', () => {
  test.use({ appEnv: { LYCHEE_NETWORK_PAGE: 'mock' } })

  test('renders its connections and never reaches the real controller', async ({ lychee }) => {
    const page = lychee.page
    await openNetworkPage(page)
    await expect(page.getByRole('button', { name: 'Repair network settings' })).toBeEnabled()
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

helperTest(
  'each row says how much of that connection is Lychee, from the helper rates',
  async ({ lychee, netd }) => {
    const fake = await netd.start({
      helperVersion: version,
      sampler: ({ adapter }) => ({
        link_in_bps: adapter.name === 'en0' ? 400_000 : 250_000,
        link_out_bps: 8_000
      })
    })
    const page = lychee.page
    await openNetworkPage(page)
    await page.getByRole('switch', { name: 'Combine connections' }).click()
    await expect(statusWord(page)).toHaveText('Merging')
    const table = page.getByRole('table', { name: 'Connections' })
    const en0 = table.getByRole('row', { name: 'en0' })
    const en7 = table.getByRole('row', { name: 'en7' })
    await expect(en0).toContainText('Lychee 0 B/s of 390.6 KB/s')
    await expect(en7).toContainText('Lychee 0 B/s of 244.1 KB/s')

    const update: HttpDownloadUpdate = {
      seq: 1,
      blocks: [],
      state: {
        id: 'lychee-share',
        kind: 'http',
        url: 'https://example.test/file.bin',
        fileName: 'file.bin',
        destinationPath: '/tmp/file.bin',
        totalBytes: 1000,
        bytesDownloaded: 100,
        speedBytesPerSec: 125_000,
        status: 'downloading',
        startedAt: 1,
        networks: [
          {
            id: 'en0',
            label: 'en0',
            kind: 'ethernet',
            enabled: true,
            status: 'on',
            bytesDownloaded: 100,
            speedBytesPerSec: 125_000,
            retries: 0,
            transfer: 'http'
          }
        ],
        streams: [],
        peakStreams: 1,
        totalBlocks: 0,
        blockSizeBytes: 1024
      }
    }
    await lychee.evaluateMain(({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('download:updated', payload)
    }, update)
    await expect(en0).toContainText('Lychee 122.1 KB/s of 390.6 KB/s')
    await expect(en7).toContainText('Lychee 0 B/s of 244.1 KB/s')

    await page
      .getByRole('checkbox', {
        name: 'Leave en0 out of combining when it is metered or its data limit is reached'
      })
      .click()
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(join(lychee.dirs.userData, 'app-settings.json'), 'utf8')
        ) as {
          networkPreferences?: { en0?: { excludeFromMergeWhenLimited?: boolean } }
        }
        return saved.networkPreferences?.en0?.excludeFromMergeWhenLimited
      })
      .toBe(true)

    await page.evaluate(async () => {
      await window.lychee.updateSettings({
        networkPreferences: { en0: { metered: true, excludeFromMergeWhenLimited: true } }
      })
    })
    await expect(en0).toContainText('Left out of combining: this connection is metered')
    await expect(page.getByRole('checkbox', { name: 'Combine en0' })).not.toBeChecked()
    await expect.poll(() => fake.view.excluded).toContain('en0')
  }
)

for (const [outcome, word] of [
  ['not_installed', 'Helper not installed'],
  ['needs_permission', 'Needs permission'],
  ['another_tool', 'Another connection-merging tool is running'],
  ['exit_node', 'Tailscale exit node'],
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
