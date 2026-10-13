import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { DESIGN_MIN, windowSize } from '../src/main/windowSize'
import { BLOCK, expect, interfacesEnv, NETWORKS, test, treeSha } from './fixtures'
import { seededBytes } from './origin'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'

// G. A handful of journeys through the real UI, to prove the screens are wired to the main
// process. Download correctness is covered far more thoroughly by the API-level specs; these
// only need to show that clicking the buttons drives it.

const SIZE = 24 * BLOCK

/** The destination picker and "Reveal in Finder" go through native OS UI — replace both. */
async function stubNativeUi(
  lychee: import('./fixtures').LycheeApp,
  destination: string
): Promise<void> {
  await lychee.evaluateMain(({ dialog, shell }, dest) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
    const revealed: string[] = []
    ;(globalThis as Record<string, unknown>).__revealed = revealed
    shell.showItemInFolder = (path: string) => void revealed.push(path)
  }, destination)
}

test('Show in Finder on a download in progress shows its staging file', async ({
  lychee,
  serve,
  dirs
}) => {
  const origin = await serve({ size: SIZE })
  await stubNativeUi(lychee, dirs.dest)
  const reached = origin.hold(6 * BLOCK)
  const id = await lychee.start(origin.url(), origin.sha256)
  await reached
  const { destinationPath } = (await lychee.api.listDownloads()).find(
    (entry) => entry.state.id === id
  )!.state
  // The final file isn't there yet: what's on disk is `<name>.lychee`.
  expect(await lychee.api.revealDownload(id)).toBe(true)
  expect(
    await lychee.evaluateMain(() => (globalThis as Record<string, unknown>).__revealed, null)
  ).toEqual([`${destinationPath}.lychee`])
  origin.release()
})

test.describe('a torrent through the UI', () => {
  // This journey inspects a peer row, not network reassignment. Keep one network stable;
  // routing across networks and globally unique peer IDs are checked by torrent specs/invariants.
  test.use({ appEnv: { LYCHEE_E2E_INTERFACES: interfacesEnv({ a: NETWORKS.a }) } })
  test('choose its files, watch its peers, finish', async ({ lychee, dirs }) => {
    const swarm = await new Swarm().start()
    try {
      const files = ['a.bin', 'b.bin', 'c.bin'].map((name, index) =>
        named(seededBytes(1024 * 1024, 81 + index), name)
      )
      // Two seeders, slow enough to look at the download while it runs.
      const options = { folder: 'Trio', pieceLength: 64 * 1024, uploadLimit: 200 * 1024 }
      await swarm.seed(files, options)
      const torrent = await swarm.seed(files, options)
      await stubNativeUi(lychee, dirs.dest)
      const page = lychee.page

      const link = await lychee.newDownload()
      await page.getByRole('button', { name: 'Change' }).click()
      await link.fill(await torrentFileOnDisk(torrent))
      await page.getByRole('checkbox', { name: /b\.bin/ }).click()
      await lychee.expectNextDownload(
        treeSha(
          [files[0], files[2]].map((data) => ({ path: (data as { name?: string }).name!, data }))
        )
      )
      // Started: its own screen opens.
      await page.getByRole('button', { name: 'Download' }).click()

      // Running: its connections are peers, and its blocks pieces.
      const peers = page.getByRole('button', { name: /^\d+ peers?/ }).first()
      await expect(peers).toBeVisible()
      await peers.click()
      // Numbered by connection, so whichever peers are connected now.
      const peerRow = page
        .getByRole('row')
        .filter({ hasText: /Peer #\d+/ })
        .first()
      await expect(peerRow).toBeVisible()
      // Only what isn't the usual gets a word: no badge for a peer that's sending.
      await expect(peerRow).not.toContainText(/RECEIVING|CONNECTED|ACTIVE/)
      await expect(peerRow).not.toContainText('Peer connection')
      // Its share of what its network's peers have sent.
      await expect(peerRow).toContainText(/\d+%/)
      // Read out in words, not only shown as an arrow; upload only once something was sent.
      await expect(peerRow).toContainText('Receiving at')
      await expect(peerRow).not.toContainText('Sending at')
      await expect(peerRow.getByRole('cell')).toHaveCount(6)
      // What it runs. A peer has no progress of its own: a dash, not a bar.
      await expect(peerRow).toContainText('WebTorrent')
      await expect(peerRow.getByRole('progressbar')).toHaveCount(0)
      // Each rendered peer has its own number.
      const numbers = (await page.getByText(/^Peer #\d+$/).allTextContents()).map((text) =>
        text.trim()
      )
      expect(numbers.length).toBeGreaterThan(0)
      expect(new Set(numbers).size).toBe(numbers.length)
      const networks = page.getByRole('table', { name: 'Networks' })
      await expect(networks.getByRole('columnheader', { name: 'Verified' })).toHaveCount(0)
      await expect(
        networks.getByRole('columnheader', { name: 'Progress', exact: true })
      ).toBeVisible()
      await expect(networks.getByRole('progressbar').first()).toBeVisible()
      await expect(
        page.getByRole('progressbar', { name: 'Download progress', exact: true })
      ).toHaveCount(0)
      await expect(peerRow).not.toContainText(/Piece #/)
      await expect(page.getByText(/^\d+ pieces · /)).toBeVisible()
      // Each network's upload, even before anything is sent; nothing at the top. A peer that has
      // sent nothing carries no upload line, and no arrows: a lone download figure needs none.
      await expect(page.getByText(/^UP \d/)).toHaveCount(0)
      await expect(networks.getByText(/Uploading at/).first()).toBeAttached()
      await expect(peerRow).not.toContainText('↑')
      await expect(peerRow).not.toContainText('↓')

      // Done: two of its three files, with what fetched them.
      await expect(page.getByRole('button', { name: /Show in (Finder|folder)/ })).toBeVisible({
        timeout: 60_000
      })
      await expect(page.getByText(/^2 of 3 files · /)).toBeVisible()
      await expect(page.getByText('Peers', { exact: true })).toBeVisible()
      await expect(page.getByText(/^written in \d+ pieces · uploaded /)).toBeVisible()
    } finally {
      await swarm.stop()
    }
  })
})

test.describe('UI journeys @smoke', () => {
  test('minimum window keeps download controls and a network row in view', async ({
    lychee,
    serve
  }) => {
    const minimum = await lychee.evaluateMain(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const opened = window.getSize()
      const [width, height] = window.getMinimumSize()
      window.setSize(width, height)
      const { workArea } = screen.getPrimaryDisplay()
      return { opened, workArea, minimum: [width, height], size: window.getSize() }
    }, null)
    // Opened at the size worked out from the display's work area, in DIPs as it is.
    const expected = windowSize(minimum.workArea)
    expect(minimum.opened).toEqual([expected.width, expected.height])
    // The test display is big enough for the design's own minimum.
    expect(minimum.minimum).toEqual([DESIGN_MIN.width, DESIGN_MIN.height])
    expect(minimum.size).toEqual(minimum.minimum)
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(0)
    await lychee.start(origin.url(), origin.sha256)
    await reached
    const page = lychee.page
    await page.getByRole('button', { name: 'Open test.bin', exact: true }).click()
    // An empty bar is still a progress indicator: its track and accessible value must exist
    // before the server sends the first byte.
    const progress = page.getByRole('table', { name: 'Networks' }).getByRole('progressbar').first()
    await expect(progress).toHaveAttribute('aria-valuenow', '0')
    await expect(progress).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(page.getByRole('button', { name: 'More actions', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(page.getByRole('columnheader', { name: 'Network', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(
      page.getByRole('table', { name: 'Networks' }).getByRole('checkbox').first()
    ).toBeInViewport({ ratio: 1 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeInViewport({
      ratio: 1
    })
    origin.release()
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await lychee.waitForHttpStatus('completed')
    await expect(page.getByRole('button', { name: /Show in (Finder|folder)/ })).toBeInViewport({
      ratio: 1
    })
  })

  test('paste a link, start, pause, resume, finish, reveal the file', async ({
    lychee,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: SIZE })
    await stubNativeUi(lychee, dirs.dest)
    const page = lychee.page

    const link = await lychee.newDownload()
    await page.getByRole('button', { name: 'Change' }).click()
    await link.fill(origin.url())
    const start = page.getByRole('button', { name: 'Download' })
    await expect(start).toBeEnabled()
    await page.getByRole('group', { name: 'Streams' }).getByRole('button', { name: '8' }).click()

    const reached = origin.hold(6 * BLOCK)
    await lychee.expectNextDownload(origin.sha256)
    await start.click()
    await reached
    // The streams picked in the dialog reach the download.
    const { id } = (await lychee.current())!
    const manifestPath = join(dirs.userData, 'downloads', id, 'manifest.json')
    await expect
      .poll(async () => JSON.parse(await readFile(manifestPath, 'utf-8')).requestPayload)
      .toMatchObject({ streamsPerNetwork: 8 })
    // Started: its own screen opens.
    await page.getByRole('button', { name: 'Pause' }).click()
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Progress', exact: true })).toBeVisible()
    // An HTTP download's connections are streams, and its blocks chunks.
    await expect(page.getByRole('button', { name: /^\d+ streams?/ }).first()).toBeVisible()
    await expect(page.getByText(/^\d+ chunks · /)).toBeVisible()
    origin.release()
    await page.getByRole('button', { name: 'Resume' }).click()

    const reveal = page.getByRole('button', { name: /Show in (Finder|folder)/ })
    await expect(reveal).toBeVisible()
    await expect(page.getByText('Streams', { exact: true })).toBeVisible()
    await expect(page.getByText(/^written in \d+ chunks/)).toBeVisible()
    await reveal.click()
    const { destinationPath } = (await lychee.current())!
    await expect
      .poll(() =>
        lychee.evaluateMain(() => (globalThis as Record<string, unknown>).__revealed, null)
      )
      .toEqual([destinationPath])
  })

  test('delete through the confirmation dialog, then download it again', async ({
    lychee,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: SIZE })
    await stubNativeUi(lychee, dirs.dest)
    const page = lychee.page
    let link = await lychee.newDownload()
    await page.getByRole('button', { name: 'Change' }).click()
    await link.fill(origin.url())

    const reached = origin.hold(6 * BLOCK)
    await page.getByRole('button', { name: 'Download' }).click()
    await reached
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Cancel download' }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancel download', exact: true })
      .click()
    origin.release()
    // Gone, with what it had downloaded.
    await expect(page.getByText('No downloads yet')).toBeVisible()

    link = await lychee.newDownload()
    await link.fill(origin.url())
    await lychee.expectNextDownload(origin.sha256)
    await page.getByRole('button', { name: 'Download' }).click({ timeout: 5000 })
    await lychee.waitForStatus('completed')
  })

  test('a download’s own screen: two buttons, the ways out behind More, from the keyboard', async ({
    lychee,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    const page = lychee.page
    const reveal = /^Show in (Finder|folder)$/
    const trashName = process.platform === 'win32' ? 'Recycle Bin' : 'Trash'
    const header = page.getByRole('button', { name: 'Downloads', exact: true }).locator('..')

    const reached = origin.hold(6 * BLOCK)
    await lychee.start(origin.url(), origin.sha256)
    await reached
    await page.getByRole('button', { name: 'Open test.bin', exact: true }).click()
    // Going: Show in folder beside Pause, the main one; Cancel only in the menu.
    await expect(header.getByRole('button')).toHaveText(['Downloads', reveal, 'Pause', ''])
    const more = header.getByRole('button', { name: 'More actions', exact: true })
    await expect(more).toHaveAttribute('aria-haspopup', 'menu')
    await more.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(menu.getByRole('menuitem')).toHaveText(['Cancel download'])
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Cancel download' })).toBeFocused()
    await page.keyboard.press('Enter')
    // Asked first; kept.
    const confirmation = page.getByRole('alertdialog')
    await expect(confirmation).toContainText('Cancel download?')
    await confirmation.getByRole('button', { name: 'Keep', exact: true }).click()
    await expect(confirmation).toBeHidden()
    origin.release()
    await lychee.waitForHttpStatus('completed')

    // Finished: Open beside Show in folder; Remove and Move to Trash in the menu.
    await expect(header.getByRole('button')).toHaveText(['Downloads', 'Open', reveal, ''])
    await more.focus()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Remove from list',
      `Move file to ${trashName}`
    ])
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(more).toBeFocused()
    await more.click()
    await menu.getByRole('menuitem', { name: `Move file to ${trashName}` }).click()
    await expect(confirmation).toContainText('Delete file?')
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await more.click()
    await menu.getByRole('menuitem', { name: 'Remove from list' }).click()
    await confirmation.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByText('No downloads yet')).toBeVisible()
  })

  test('a link the server rejects shows the error and keeps Download disabled', async ({
    lychee,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    origin.setRule(() => ({ status: 404 }))
    const page = lychee.page
    await (await lychee.newDownload()).fill(origin.url())
    await expect(page.getByText(/couldn’t be found/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download' })).toBeDisabled()
  })

  test('a completed download is shown again after a restart', async ({ lychee, serve }) => {
    const origin = await serve({ size: SIZE })
    await lychee.start(origin.url(), origin.sha256)
    const { fileName } = await lychee.waitForStatus('completed')
    await lychee.relaunch()
    // Listed under Finished; opened, it shows as it did when it finished.
    await lychee.page.getByRole('button', { name: `Open ${fileName}` }).click()
    await expect(lychee.page.getByRole('button', { name: /Show in (Finder|folder)/ })).toBeVisible()
  })
})

// What a user sets is still set after they reload or restart — checked only through what they see.
test.describe('settings @smoke', () => {
  test('every choice survives a reload and a restart, even made right before', async ({
    lychee,
    dirs
  }) => {
    const page = (): Page => lychee.page
    const themeToggle = page().getByRole('button', { name: /^Switch to (dark|light) theme$/ })
    // After switching, the toggle offers to switch back.
    const labelAfterSwitch = (await themeToggle.getAttribute('aria-label'))!.includes('dark')
      ? 'Switch to light theme'
      : 'Switch to dark theme'
    await themeToggle.click()

    await stubNativeUi(lychee, dirs.dest)
    await lychee.newDownload()
    await page().getByRole('button', { name: 'Change' }).click()
    const destinationRow = (): Locator => page().getByText('Save to', { exact: true }).locator('..')
    const chosenDestination = await destinationRow().innerText()
    await page().keyboard.press('Escape')
    // A function: the window, and so the page, is a new one after a relaunch.
    const networksMenu = (): Locator =>
      page()
        .getByRole('button', { name: /network/ })
        .first()
        .first()
    await networksMenu().click()
    await page().getByRole('button', { name: 'Edit network' }).first().click()
    await page().getByRole('textbox', { name: 'Name' }).fill('Office fibre')
    await page().getByRole('button', { name: 'Violet' }).click()
    await page().getByRole('button', { name: 'Done' }).click()
    await page().keyboard.press('Escape')

    const expectAllKept = async (): Promise<void> => {
      await expect(page().getByRole('button', { name: labelAfterSwitch })).toBeVisible()
      await lychee.newDownload()
      await expect(destinationRow()).toHaveText(chosenDestination, { useInnerText: true })
      // Presentation may abbreviate home; persistence must retain the usable absolute path.
      const saved = JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
      expect(saved.destinationDir).toBe(dirs.dest)
      await page().keyboard.press('Escape')
      await networksMenu().click()
      await expect(page().getByText('Office fibre')).toBeVisible()
      await page().getByRole('button', { name: 'Edit network' }).first().click()
      await expect(page().getByRole('button', { name: 'Violet' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await page().keyboard.press('Escape')
      await page().keyboard.press('Escape')
    }

    // No waiting for saves: a user doesn't either.
    await page().reload()
    await expectAllKept()
    await lychee.relaunch()
    await expectAllKept()
  })

  test('Interface size zooms the content, not the window, and survives a restart', async ({
    lychee,
    dirs
  }) => {
    const window = (): Promise<{ zoom: number; bounds: Electron.Rectangle }> =>
      lychee.electronApp.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]
        return { zoom: w.webContents.getZoomFactor(), bounds: w.getBounds() }
      })
    const choose = async (name: string): Promise<void> => {
      await lychee.page.getByRole('button', { name: 'About Lychee' }).click()
      await lychee.page.getByRole('button', { name, exact: true }).click()
      await lychee.page.keyboard.press('Escape')
    }
    const pressed = async (name: string): Promise<void> => {
      await lychee.page.getByRole('button', { name: 'About Lychee' }).click()
      await expect(lychee.page.getByRole('button', { name, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await lychee.page.keyboard.press('Escape')
    }

    // Xvfb's display is at 100%, where Auto leaves the content alone.
    const before = await window()
    expect(before.zoom).toBe(1)
    await pressed('Auto')

    await choose('80%')
    await expect.poll(async () => (await window()).zoom).toBe(0.8)
    expect((await window()).bounds).toEqual(before.bounds)

    await lychee.relaunch()
    await pressed('80%')
    await expect.poll(async () => (await window()).zoom).toBe(0.8)

    await choose('Auto')
    await expect.poll(async () => (await window()).zoom).toBe(1)
    await expect
      .poll(async () =>
        JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
      )
      .not.toHaveProperty('interfaceSize')
  })

  test('a broken settings file falls back to what a fresh install shows', async ({
    lychee,
    dirs
  }) => {
    const settingsPath = join(dirs.userData, 'app-settings.json')
    // New download's "Save to" row, as the user sees it — compared whole, so no platform's idea
    // of the default folder is baked into the test.
    const choices = async (): Promise<string> => {
      await lychee.newDownload()
      const row = await lychee.page.getByText('Save to', { exact: true }).locator('..').innerText()
      await lychee.page.keyboard.press('Escape')
      return row
    }
    const fresh = await choices()

    await lychee.quit()
    await writeFile(settingsPath, '{"destinationDir": "/')
    await lychee.launch()
    expect(await choices()).toEqual(fresh)

    await lychee.quit()
    await writeFile(settingsPath, JSON.stringify({ destinationDir: join(dirs.dest, 'unplugged') }))
    await lychee.launch()
    expect(await choices()).toEqual(fresh)
  })
})

test.describe('no networks', () => {
  test.use({ appEnv: { LYCHEE_E2E_INTERFACES: '' } })

  test('a network appearing makes the list ready for downloads @smoke', async ({ lychee }) => {
    await expect(lychee.page.getByText('No networks connected')).toBeVisible()
    // A manual scan is safe while the list stays empty. Once an interface appears, the
    // background monitor can remove this button before Playwright finishes clicking it.
    await lychee.page.getByRole('button', { name: 'Scan again' }).click()
    await expect(lychee.page.getByText('No networks connected')).toBeVisible()
    await lychee.evaluateMain(
      (_electron, value) => {
        process.env['LYCHEE_E2E_INTERFACES'] = value
      },
      interfacesEnv({ a: NETWORKS['a'] })
    )
    await expect(lychee.page.getByText('No downloads yet')).toBeVisible()
  })
})
