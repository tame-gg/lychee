import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_DOWNLOAD_SCHEDULE } from '../src/shared/downloadSchedule'
import { BLOCK, expect, test, type LycheeApp } from './fixtures'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'
import { seededBytes, sha256 } from './origin'

const schedule = { ...DEFAULT_DOWNLOAD_SCHEDULE, enabled: true }
const at = (day: number, hour: number): number => new Date(2000, 0, day, hour).getTime()

async function clock(lychee: LycheeApp, now: number, wake = true): Promise<void> {
  await lychee.evaluateMain(
    ({ powerMonitor }, value) => {
      Date.now = () => value.now
      if (value.wake) powerMonitor.emit('resume')
    },
    { now, wake }
  )
}

test('scheduled queue holds new downloads and manual resumes; manually paused downloads stay paused @smoke', async ({
  lychee,
  serve
}) => {
  await clock(lychee, at(1, 8))
  await lychee.api.updateSettings({ downloadSchedule: schedule, downloadsAtOnce: 1 })
  const origin = await serve({ size: 24 * BLOCK })
  const first = await lychee.start(origin.url('/first'), origin.sha256)
  const second = await lychee.start(origin.url('/second'), origin.sha256)
  expect((await lychee.byId(first))?.status).toBe('queued')
  expect((await lychee.byId(second))?.bytesDownloaded).toBe(0)
  await lychee.api.pauseDownload(first)
  await lychee.api.resumeDownload(first)
  await expect.poll(async () => (await lychee.byId(first))?.status).toBe('queued')
  await lychee.api.pauseDownload(first)
  await clock(lychee, at(2, 0))
  await expect.poll(async () => (await lychee.byId(second))?.status).toBe('completed')
  expect((await lychee.byId(first))?.status).toBe('paused')
  await lychee.api.resumeDownload(first)
  await expect.poll(async () => (await lychee.byId(first))?.status).toBe('completed')
})

test('the clock cutoff stops active HTTP transfers, preserves progress, and blocks queue draining', async ({
  lychee,
  serve
}) => {
  await clock(lychee, at(1, 0))
  await lychee.api.updateSettings({ downloadSchedule: schedule, downloadsAtOnce: 1 })
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  const id = await lychee.start(origin.url(), origin.sha256)
  await held
  const next = await lychee.start(origin.url('/next'), origin.sha256)
  // No wake event: the main-process timer must enforce the cutoff itself.
  await clock(lychee, at(1, 7), false)
  await expect.poll(async () => (await lychee.byId(id))?.status).toBe('queued')
  const stopped = await lychee.byId(id)
  expect(stopped?.bytesDownloaded).toBeGreaterThan(0)
  expect(stopped?.speedBytesPerSec).toBe(0)
  expect((await lychee.byId(next))?.bytesDownloaded).toBe(0)
  origin.release()
  await clock(lychee, at(2, 0))
  await expect.poll(async () => (await lychee.byId(id))?.status).toBe('completed')
  await expect.poll(async () => (await lychee.byId(next))?.status).toBe('completed')
})

test('scheduled intent survives restart, while expiration stays blocked until disabled', async ({
  lychee,
  serve
}) => {
  await clock(lychee, at(1, 8))
  await lychee.api.updateSettings({ downloadSchedule: { ...schedule, endDate: '2000-01-02' } })
  const origin = await serve({ size: 16 * BLOCK })
  const id = await lychee.start(origin.url(), origin.sha256)
  await lychee.relaunch()
  expect((await lychee.byId(id))?.status).toBe('queued')
  expect((await lychee.byId(id))?.bytesDownloaded).toBe(0)
  await lychee.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await lychee.byId(id))?.status).toBe('completed')
})

test('a restart inside the window continues scheduled work', async ({ lychee, serve }) => {
  const minute = new Date().getHours() * 60 + new Date().getMinutes()
  const open = { ...schedule, startMinute: (minute + 1420) % 1440, endMinute: (minute + 20) % 1440 }
  await lychee.api.updateSettings({ downloadSchedule: open })
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  const id = await lychee.start(origin.url(), origin.sha256)
  await held
  await lychee.quit()
  origin.release()
  await lychee.launch()
  await expect.poll(async () => (await lychee.byId(id))?.status).toBe('completed')
})

test('the cutoff stops torrent peers and uploads; reopening finishes the same file', async ({
  lychee
}) => {
  const swarm = await new Swarm().start()
  try {
    await clock(lychee, at(1, 0))
    await lychee.api.updateSettings({ downloadSchedule: schedule, speedLimit: 128 * 1024 })
    const data = seededBytes(2 * 1024 * 1024, 32)
    const torrent = await swarm.seed([named(data, 'scheduled.bin')], { pieceLength: 64 * 1024 })
    const id = await lychee.start(await torrentFileOnDisk(torrent), sha256(data))
    await lychee.waitUntil((state) => state.bytesDownloaded > 0)
    await clock(lychee, at(1, 7))
    await expect.poll(async () => (await lychee.byId(id))?.status).toBe('queued')
    // Saving a closed window waits for the client to finish closing.
    await lychee.api.updateSettings({ downloadSchedule: schedule })
    const stopped = await lychee.byId(id)
    expect(stopped?.speedBytesPerSec).toBe(0)
    if (stopped?.kind === 'torrent') expect(stopped.uploadSpeedBytesPerSec).toBe(0)
    await clock(lychee, at(2, 0))
    await lychee.api.updateSettings({ speedLimit: undefined })
    await expect
      .poll(async () => (await lychee.byId(id))?.status, { timeout: 30_000 })
      .toBe('completed')
  } finally {
    await swarm.stop()
  }
})

async function openSchedule(lychee: LycheeApp): Promise<void> {
  await lychee.page.getByRole('button', { name: /^\d+ networks?/ }).click()
  await lychee.page.getByRole('button', { name: 'Speed & data limits', exact: true }).click()
  await lychee.page.getByRole('region', { name: 'Download schedule' }).scrollIntoViewIfNeeded()
}

async function chooseTime(lychee: LycheeApp, label: string, time: string): Promise<void> {
  const [hour, minute] = time.split(':')
  for (const [part, value] of [
    ['hour', hour],
    ['minute', minute]
  ]) {
    await lychee.page.getByRole('spinbutton', { name: `${label} ${part}`, exact: true }).fill(value)
  }
}

test('schedule dialog saves, cancels edits, validates times, and restores settings', async ({
  lychee
}, testInfo) => {
  const page = lychee.page
  const indicator = page.getByRole('button', { name: 'Download schedule enabled', exact: true })
  await expect(indicator).toBeHidden()
  await openSchedule(lychee)
  const dialog = page.getByRole('dialog', { name: 'Speed & data limits' })
  await expect(dialog.getByRole('group', { name: 'Start at', exact: true })).toBeHidden()
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).check()
  await chooseTime(lychee, 'Start at', '00:00')
  await chooseTime(lychee, 'Stop at', '00:00')
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await chooseTime(lychee, 'Stop at', '07:00')
  await expect(dialog.locator('input[type="date"], input[type="time"]')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Mon', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await chooseTime(lychee, 'Stop at', '07:13')
  await chooseTime(lychee, 'Stop at', '07:00')
  await dialog.getByRole('button', { name: 'End date', exact: true }).click()
  const calendar = page.getByRole('dialog', { name: 'Choose end date' })
  await calendar.getByRole('button', { name: 'Go to the next month' }).click()
  await page.screenshot({ path: '/tmp/lychee-schedule-calendar.png' })
  // Choose a day in the displayed month, excluding the adjacent months' trailing dates.
  await calendar
    .locator('[data-slot="calendar"] td:not([data-outside]) button')
    .filter({ hasText: /^15$/ })
    .click()
  const endDateLabel = await dialog
    .getByRole('button', { name: 'End date', exact: true })
    .innerText()
  await testInfo.attach('schedule-dialog.png', {
    body: await page.screenshot({ path: '/tmp/lychee-schedule-dialog.png' }),
    contentType: 'image/png'
  })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(indicator).toBeVisible()
  await page.screenshot({ path: '/tmp/lychee-schedule-toolbar.png' })
  await indicator.click()
  await expect(dialog.getByRole('switch', { name: 'Enable download schedule' })).toBeFocused()
  await expect(dialog.getByRole('region', { name: 'Download schedule' })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'End date', exact: true })).toBeInViewport({
    ratio: 1
  })
  await chooseTime(lychee, 'Stop at', '09:00')
  await dialog.getByRole('navigation').getByRole('button').nth(1).click()
  await dialog.getByRole('button', { name: /^All downloads/ }).click()
  await expect(dialog.getByRole('spinbutton', { name: 'Stop at hour', exact: true })).toHaveValue(
    '09'
  )
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await lychee.relaunch()
  await openSchedule(lychee)
  const restored = lychee.page.getByRole('dialog', { name: 'Speed & data limits' })
  await expect(restored.getByRole('switch', { name: 'Enable download schedule' })).toBeChecked()
  await expect(restored.getByRole('spinbutton', { name: 'Stop at hour', exact: true })).toHaveValue(
    '07'
  )
  await expect(restored.getByRole('button', { name: 'End date', exact: true })).toHaveText(
    endDateLabel
  )
  await expect(restored.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await restored.getByRole('button', { name: 'End date', exact: true }).click()
  await lychee.page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(restored.getByRole('button', { name: 'End date', exact: true })).toHaveText(
    'No end date'
  )
  await restored.getByRole('switch', { name: 'Enable download schedule' }).uncheck()
  await restored.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    lychee.page.getByRole('button', { name: 'Download schedule enabled', exact: true })
  ).toBeHidden()
})

test('an overnight schedule remains usable at the minimum window size', async ({ lychee }) => {
  await lychee.evaluateMain(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(720, 620)
  }, null)
  await lychee.page.emulateMedia({ colorScheme: 'dark' })
  await openSchedule(lychee)
  const dialog = lychee.page.getByRole('dialog', { name: 'Speed & data limits' })
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).check()
  await chooseTime(lychee, 'Start at', '22:00')
  const minute = dialog.getByRole('spinbutton', { name: 'Start at minute', exact: true })
  const hour = dialog.getByRole('spinbutton', { name: 'Start at hour', exact: true })
  await minute.focus()
  await lychee.page.keyboard.press('ArrowDown')
  await expect(minute).toHaveValue('59')
  await expect(minute).toHaveAttribute('aria-valuenow', '59')
  await lychee.page.keyboard.press('ArrowUp')
  await expect(minute).toHaveValue('00')
  await lychee.page.keyboard.press('ArrowLeft')
  await expect(hour).toBeFocused()
  await lychee.page.keyboard.press('End')
  await expect(hour).toHaveValue('23')
  await lychee.page.keyboard.press('ArrowUp')
  await expect(hour).toHaveValue('00')
  await hour.evaluate((input) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '21:37')
    input.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
    )
  })
  await expect(hour).toHaveValue('21')
  await expect(minute).toHaveValue('37')
  await hour.focus()
  await lychee.page.keyboard.press('ControlOrMeta+A')
  await hour.pressSequentially('22')
  await expect(minute).toBeFocused()
  await minute.fill('00')
  await minute.fill('75')
  await expect(minute).toHaveValue('00')
  await lychee.page.screenshot({ path: '/tmp/lychee-schedule-time-dark.png' })
  await expect(dialog.getByText('Next day', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded()
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport({
    ratio: 1
  })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
})

test('main refuses invalid schedule changes without clearing the existing window', async ({
  lychee,
  serve
}) => {
  await clock(lychee, at(1, 8))
  await lychee.api.updateSettings({ downloadSchedule: schedule })
  await expect(
    lychee.api.updateSettings({ downloadSchedule: { ...schedule, days: [] } })
  ).rejects.toThrow()
  const origin = await serve({ size: 8 * BLOCK })
  const id = await lychee.start(origin.url(), origin.sha256)
  expect((await lychee.byId(id))?.status).toBe('queued')
  await lychee.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await lychee.byId(id))?.status).toBe('completed')
})

test('quitting during the cutoff saves progress and leaves the restored queue stopped', async ({
  lychee,
  serve
}) => {
  await clock(lychee, at(1, 0))
  await lychee.api.updateSettings({ downloadSchedule: { ...schedule, endDate: '2000-01-02' } })
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  const id = await lychee.start(origin.url(), origin.sha256)
  await held
  await clock(lychee, at(1, 7))
  await lychee.quit()
  origin.release()
  await lychee.launch()
  const restored = await lychee.byId(id)
  expect(restored?.status).toBe('queued')
  expect(restored?.bytesDownloaded).toBeGreaterThan(0)
  await lychee.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await lychee.byId(id))?.status).toBe('completed')
})

test('enabling a closed window adopts active work; a manual pause survives its cutoff and restart', async ({
  lychee,
  serve
}) => {
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  await lychee.api.updateSettings({ downloadsAtOnce: 1 })
  const active = await lychee.start(origin.url('/active'), origin.sha256)
  await held
  const waiting = await lychee.start(origin.url('/waiting'), origin.sha256)
  await clock(lychee, at(1, 8))
  await lychee.api.updateSettings({ downloadSchedule: schedule })
  const stopped = await lychee.byId(active)
  expect(stopped?.status).toBe('queued')
  expect(stopped?.scheduled).toBe(true)
  expect((await lychee.byId(waiting))?.scheduled).toBe(true)
  await lychee.api.pauseDownload(active)
  await lychee.quit()
  origin.release()
  await lychee.launch()
  expect((await lychee.byId(active))?.status).toBe('paused')
  // Whichever local time the app restarted in, the scheduled entry can run when disabled.
  await lychee.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await lychee.byId(waiting))?.status).toBe('completed')
  expect((await lychee.byId(active))?.status).toBe('paused')
  await lychee.api.resumeDownload(active)
  await expect.poll(async () => (await lychee.byId(active))?.status).toBe('completed')
})

test('a malformed saved schedule blocks transfers and can be disabled from settings', async ({
  lychee,
  serve,
  dirs
}) => {
  await clock(lychee, at(1, 8))
  await lychee.api.updateSettings({ downloadSchedule: schedule })
  const origin = await serve({ size: 8 * BLOCK })
  const id = await lychee.start(origin.url(), origin.sha256)
  await lychee.quit()
  await writeFile(
    join(dirs.userData, 'app-settings.json'),
    JSON.stringify({
      downloadSchedule: { ...schedule, days: [] }
    })
  )
  await lychee.launch()
  expect((await lychee.byId(id))?.status).toBe('queued')
  expect((await lychee.byId(id))?.bytesDownloaded).toBe(0)
  await openSchedule(lychee)
  const dialog = lychee.page.getByRole('dialog', { name: 'Speed & data limits' })
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).uncheck()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await lychee.byId(id))?.status).toBe('completed')
})
