import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Page } from '@playwright/test'
import { BLOCK, expect, test, treeSha } from './fixtures'
import { seededBytes } from './origin'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'

/** The selection toolbar keeps the next step as buttons; the rest is behind More actions. */
async function openMore(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
}

async function chooseMore(page: Page, name: string | RegExp): Promise<void> {
  await openMore(page)
  await page.getByRole('menuitem', { name }).click()
}

async function stubTrash(
  lychee: import('./fixtures').LycheeApp,
  destination: string
): Promise<void> {
  await mkdir(destination)
  await lychee.evaluateMain(({ shell }, dest) => {
    shell.trashItem = async (path: string): Promise<void> => {
      const { rename } = process.getBuiltinModule('node:fs/promises')
      const { basename, join } = process.getBuiltinModule('node:path')
      await rename(path, join(dest, basename(path)))
    }
  }, destination)
}

test('mixed selection applies actions only to eligible downloads and keeps finished files', async ({
  lychee,
  serve
}) => {
  const complete = await serve({ size: BLOCK })
  await lychee.start(complete.url(), complete.sha256, { fileName: 'finished.bin' })
  const finished = await lychee.waitForStatus('completed')
  const failed = await serve({ size: 16 * BLOCK })
  const held = failed.hold(4 * BLOCK)
  await lychee.start(failed.url(), failed.sha256, { fileName: 'expired.bin' })
  await held
  failed.setRule(() => ({ status: 403 }))
  failed.release()
  await lychee.waitForStatus('error')
  const paused = await serve({ size: 16 * BLOCK })
  const pausedHeld = paused.hold(4 * BLOCK)
  const pausedId = await lychee.start(paused.url(), paused.sha256, { fileName: 'paused.bin' })
  await pausedHeld
  await lychee.api.pauseDownload(pausedId)
  paused.release()
  await lychee.waitForStatus('paused')

  const page = lychee.page
  const beforeSelection = await page
    .getByRole('button', { name: 'Open paused.bin', exact: true })
    .boundingBox()
  await page.getByRole('checkbox', { name: 'Select paused.bin', exact: true }).check()
  const toolbar = page.getByRole('toolbar', { name: 'Selected downloads' })
  await expect(page.getByRole('heading', { level: 1 })).toBeHidden()
  await toolbar.getByRole('button', { name: 'Select all', exact: true }).click()
  await expect(toolbar.getByText('3 selected', { exact: true })).toBeVisible()
  await expect(page.locator('[data-selected=true]')).toHaveCount(3)
  const afterSelection = await page
    .getByRole('button', { name: 'Open paused.bin', exact: true })
    .boundingBox()
  expect(afterSelection?.y).toBe(beforeSelection?.y)
  await expect(page.getByRole('button', { name: 'Resume (1)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Retry/ })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Fix link expired.bin', exact: true })
  ).toBeVisible()
  // Whatever is selected, the toolbar holds its two fixed buttons, the next steps and More.
  await expect(toolbar.getByRole('button')).toHaveText([
    '',
    'Select all',
    'Resume (1)',
    'Cancel downloads (1)',
    ''
  ])
  await openMore(page)
  await expect(
    page.getByRole('menuitem', { name: 'Remove 2 from list', exact: true })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  // A finished and a failed download leave the list together, after asking.
  await chooseMore(page, 'Remove 2 from list')
  const removal = page.getByRole('alertdialog')
  await expect(removal.getByText(/lose the part they already downloaded/)).toBeVisible()
  await removal.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(toolbar.getByText('3 selected', { exact: true })).toBeVisible()
  await chooseMore(page, 'Remove 2 from list')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open finished.bin', exact: true })).toBeHidden()
  expect(existsSync(finished.destinationPath)).toBe(true)
  await expect(toolbar.getByText('1 selected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel downloads (1)', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation.getByText(/part already downloaded will be deleted/)).toBeVisible()
  await confirmation.getByRole('button', { name: 'Keep', exact: true }).click()
  await expect(toolbar.getByText('1 selected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel downloads (1)', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Cancel download', exact: true })
    .click()
  await expect(page.getByText('No downloads yet', { exact: true })).toBeVisible()
  expect(existsSync(finished.destinationPath)).toBe(true)
})

test('missing finished files can leave the list but are excluded from file removal', async ({
  lychee,
  serve
}) => {
  const origin = await serve({ size: BLOCK })
  await lychee.start(origin.url(), origin.sha256)
  const complete = await lychee.waitForStatus('completed')
  // Rename instead of delete so automatic fixture integrity checks can still inspect the bytes.
  const { rename } = await import('node:fs/promises')
  await rename(complete.destinationPath, `${complete.destinationPath}.moved`)
  await lychee.page.reload()
  await lychee.page
    .getByRole('checkbox', { name: `Select ${complete.fileName}`, exact: true })
    .check()
  await expect(lychee.page.getByRole('button', { name: /^Move/ })).toHaveCount(0)
  await lychee.page.getByRole('button', { name: 'Remove from list (1)', exact: true }).click()
  await lychee.page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Remove', exact: true })
    .click()
  await expect(lychee.page.getByText('No downloads yet', { exact: true })).toBeVisible()
  await rename(`${complete.destinationPath}.moved`, complete.destinationPath)
})

test('showing a file that has moved says so in a dialog, not on the page', async ({
  lychee,
  serve
}) => {
  const origin = await serve({ size: BLOCK })
  await lychee.start(origin.url(), origin.sha256)
  const complete = await lychee.waitForStatus('completed')
  const { rename } = await import('node:fs/promises')
  const page = lychee.page
  // Open the menu while the file is still there, then move it: the menu already offers
  // Show in, and only trying it finds the file gone.
  await page.getByRole('button', { name: `Open ${complete.fileName}`, exact: true }).click({
    button: 'right'
  })
  const reveal = page.getByRole('menuitem', { name: /^Show in/ })
  await expect(reveal).toBeVisible()
  await rename(complete.destinationPath, `${complete.destinationPath}.moved`)
  try {
    await reveal.click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog.getByText('Couldn’t show file', { exact: true })).toBeVisible()
    await expect(dialog.getByText('That file is no longer where it was saved.')).toBeVisible()
    await dialog.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(dialog).toBeHidden()
    // Nothing is left behind on the list itself.
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await rename(`${complete.destinationPath}.moved`, complete.destinationPath)
  }
})

test('trashing finished torrent files preserves unrelated files in the torrent folder', async ({
  lychee,
  dirs
}) => {
  const swarm = await new Swarm().start()
  try {
    const files = [named(seededBytes(BLOCK, 81), 'a.bin'), named(seededBytes(BLOCK, 82), 'b.bin')]
    const torrent = await swarm.seed(files, { folder: 'Owned', pieceLength: 16 * 1024 })
    await lychee.start(
      await torrentFileOnDisk(torrent),
      treeSha(
        files.map((data) => ({
          path: (data as { name?: string }).name!,
          data
        }))
      )
    )
    const completed = await lychee.waitForTorrentStatus('completed')
    await writeFile(join(completed.destinationPath, 'personal.txt'), 'keep me')
    const trash = join(dirs.dest, 'test-trash')
    await stubTrash(lychee, trash)
    await lychee.page
      .getByRole('checkbox', { name: `Select ${completed.fileName}`, exact: true })
      .check()
    const trashName = process.platform === 'win32' ? 'Recycle Bin' : 'Trash'
    await chooseMore(lychee.page, `Move file to ${trashName}`)
    await lychee.page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete file', exact: true })
      .click()
    await expect(lychee.page.getByText('No downloads yet', { exact: true })).toBeVisible()
    expect(await readFile(join(completed.destinationPath, 'personal.txt'), 'utf8')).toBe('keep me')
    for (const file of files)
      expect(existsSync(join(trash, basename((file as { name?: string }).name!)))).toBe(true)
  } finally {
    await swarm.stop()
  }
})

test('cancelling an unfinished torrent preserves unrelated files in its folder', async ({
  lychee
}) => {
  const swarm = await new Swarm().start()
  try {
    const files = [
      named(seededBytes(32 * BLOCK, 91), 'a.bin'),
      named(seededBytes(32 * BLOCK, 92), 'b.bin')
    ]
    const torrent = await swarm.seed(files, {
      folder: 'Partial',
      pieceLength: 16 * 1024,
      uploadLimit: 64 * 1024
    })
    const id = await lychee.start(
      await torrentFileOnDisk(torrent),
      treeSha(
        files.map((data) => ({
          path: (data as { name?: string }).name!,
          data
        }))
      )
    )
    await lychee.api.pauseDownload(id)
    const paused = await lychee.waitForTorrentStatus('paused')
    await writeFile(join(paused.destinationPath, 'personal.txt'), 'keep me')
    await lychee.api.removeDownload(id)
    expect(await readFile(join(paused.destinationPath, 'personal.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(join(paused.destinationPath, 'a.bin'))).toBe(false)
    expect(existsSync(join(paused.destinationPath, 'b.bin'))).toBe(false)
  } finally {
    await swarm.stop()
  }
})

test('a removal that fails for one download still removes the rest, and asks again about only that one', async ({
  lychee,
  serve,
  dirs
}) => {
  const first = await serve({ size: BLOCK })
  await lychee.start(first.url(), first.sha256, { fileName: 'goes.bin' })
  await lychee.waitForStatus('completed')
  const second = await serve({ size: BLOCK })
  await lychee.start(second.url(), second.sha256, { fileName: 'stays.bin' })
  await expect
    .poll(async () => (await lychee.all()).filter((d) => d.status === 'completed').length)
    .toBe(2)
  const trashed = join(dirname(dirs.dest), 'test-trash')
  await mkdir(trashed)
  await lychee.evaluateMain(({ shell }, dest) => {
    shell.trashItem = async (path: string): Promise<void> => {
      const { rename } = process.getBuiltinModule('node:fs/promises')
      const { basename, join } = process.getBuiltinModule('node:path')
      if (basename(path) === 'stays.bin') throw new Error('Trash is not available')
      await rename(path, join(dest, basename(path)))
    }
  }, trashed)

  const page = lychee.page
  await page.getByRole('checkbox', { name: 'Select goes.bin', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Select stays.bin', exact: true }).check()
  await page.getByRole('button', { name: /^Move to (Trash|Recycle Bin) \(2\)$/ }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: 'Delete files', exact: true }).click()

  await expect(dialog.getByRole('alert')).toContainText('1 of 2 couldn’t be removed')
  await expect(dialog.getByRole('heading', { name: 'Delete file?' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Select goes.bin' })).toHaveCount(0)
  expect(existsSync(join(trashed, 'goes.bin'))).toBe(true)
})
