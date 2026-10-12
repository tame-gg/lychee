import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BLOCK, expect, test, treeSha, type LycheeApp } from './fixtures'
import { seededBytes } from './origin'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'

/** Hold the actual history save, rather than relying on a quick click landing in its window. */
async function holdHistoryWrite(lychee: LycheeApp): Promise<void> {
  await lychee.evaluateMain(() => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const { basename } = process.getBuiltinModule('node:path')
    const original = fs.rename
    const globals = globalThis as Record<string, unknown>
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    globals.__releaseHistory = () => {
      fs.rename = original
      release()
    }
    fs.rename = async (...args: Parameters<typeof original>) => {
      if (basename(String(args[1])) === 'history.json') {
        globals.__historyHeld = true
        await held
      }
      return original(...args)
    }
  }, null)
}

async function releaseHistoryWrite(lychee: LycheeApp): Promise<void> {
  await lychee.evaluateMain(() => {
    const globals = globalThis as Record<string, unknown>
    if (typeof globals.__releaseHistory === 'function') globals.__releaseHistory()
  }, null)
}

async function waitForHistoryWrite(lychee: LycheeApp): Promise<void> {
  await expect
    .poll(() =>
      lychee.evaluateMain(() => (globalThis as Record<string, unknown>).__historyHeld, null)
    )
    .toBe(true)
}

async function stubTrash(lychee: LycheeApp, destination: string): Promise<void> {
  await mkdir(destination)
  await lychee.evaluateMain(({ shell }, dest) => {
    shell.trashItem = async (path: string): Promise<void> => {
      const { rename } = process.getBuiltinModule('node:fs/promises')
      const { basename, join } = process.getBuiltinModule('node:path')
      await rename(path, join(dest, basename(path)))
    }
  }, destination)
}

test.describe('removal during completion @smoke', () => {
  for (const action of ['remove', 'clear', 'trash'] as const) {
    test(`${action} waits for the pending history save and stays removed after restart`, async ({
      lychee,
      serve,
      dirs
    }) => {
      const trash = join(dirs.dest, 'test-trash')
      if (action === 'trash') await stubTrash(lychee, trash)
      await holdHistoryWrite(lychee)
      try {
        const origin = await serve({ size: BLOCK })
        const id = await lychee.start(origin.url(), origin.sha256)
        await waitForHistoryWrite(lychee)
        const completed = (await lychee.api.listDownloads()).find(
          (entry) => entry.state.id === id
        )!.state
        expect(completed.status).toBe('completed')

        const removing =
          action === 'clear'
            ? lychee.api.clearHistory()
            : lychee.api.removeDownload(id, { trashFile: action === 'trash' })
        // Sent after removal on the same renderer IPC connection: removal has reached main.
        await lychee.api.listDownloads()
        await releaseHistoryWrite(lychee)
        await removing

        expect((await lychee.api.listHistory()).find((entry) => entry.id === id)).toBeUndefined()
        expect(
          (await lychee.api.listDownloads()).find((entry) => entry.state.id === id)
        ).toBeUndefined()
        expect(existsSync(completed.destinationPath)).toBe(action !== 'trash')
        if (action === 'trash') expect(existsSync(join(trash, completed.fileName))).toBe(true)
        await lychee.relaunch()
        expect(await lychee.all()).toEqual([])
      } finally {
        if (lychee.alive) await releaseHistoryWrite(lychee).catch(() => {})
      }
    })
  }

  test('trashing a just-finished torrent waits for its owned-file history record', async ({
    lychee,
    dirs
  }) => {
    const swarm = await new Swarm().start()
    try {
      const files = [
        named(seededBytes(BLOCK, 121), 'a.bin'),
        named(seededBytes(BLOCK, 122), 'b.bin')
      ]
      const torrent = await swarm.seed(files, { folder: 'Finished', pieceLength: 16 * 1024 })
      const trash = join(dirs.dest, 'test-trash')
      await stubTrash(lychee, trash)
      await holdHistoryWrite(lychee)
      const id = await lychee.start(
        await torrentFileOnDisk(torrent),
        treeSha(files.map((data) => ({ path: (data as { name?: string }).name!, data })))
      )
      await waitForHistoryWrite(lychee)
      const completed = (await lychee.api.listDownloads()).find(
        (entry) => entry.state.id === id
      )!.state
      await writeFile(join(completed.destinationPath, 'personal.txt'), 'keep me')
      const removing = lychee.api.removeDownload(id, { trashFile: true })
      await lychee.api.listDownloads()
      await releaseHistoryWrite(lychee)
      await removing

      expect(await readFile(join(completed.destinationPath, 'personal.txt'), 'utf8')).toBe(
        'keep me'
      )
      for (const name of ['a.bin', 'b.bin']) {
        expect(existsSync(join(completed.destinationPath, name))).toBe(false)
        expect(existsSync(join(trash, name))).toBe(true)
      }
      expect(await lychee.all()).toEqual([])
    } finally {
      if (lychee.alive) await releaseHistoryWrite(lychee).catch(() => {})
      await swarm.stop()
    }
  })
})

test('failed torrent cancellation stays visible across restart and can be retried @smoke', async ({
  lychee,
  dirs
}) => {
  const swarm = await new Swarm().start()
  try {
    const files = [
      named(seededBytes(32 * BLOCK, 111), 'a.bin'),
      named(seededBytes(32 * BLOCK, 112), 'b.bin')
    ]
    const torrent = await swarm.seed(files, {
      folder: 'Partial',
      pieceLength: 16 * 1024,
      uploadLimit: 64 * 1024
    })
    const id = await lychee.start(
      await torrentFileOnDisk(torrent),
      treeSha(files.map((data) => ({ path: (data as { name?: string }).name!, data })))
    )
    await lychee.api.pauseDownload(id)
    const paused = await lychee.waitForTorrentStatus('paused')
    await writeFile(join(paused.destinationPath, 'personal.txt'), 'keep me')
    const original = paused.destinationPath + '.original'
    await rename(paused.destinationPath, original)
    await symlink(original, paused.destinationPath, 'junction')

    await expect(lychee.api.removeDownload(id)).rejects.toThrow(/folder is now a link/)
    const failed = await lychee.waitForTorrentStatus('error')
    expect(failed.error).toMatch(/folder is now a link/)
    expect(failed.resumable).toBe(false)
    const row = lychee.page.getByRole('button', { name: `Open ${paused.fileName}`, exact: true })
    await expect(row).toBeVisible()
    expect(
      lychee.sessions
        .flat()
        .filter((state) => state.id === id)
        .some((state) => state.status === 'cancelled')
    ).toBe(false)
    const manifest = join(dirs.userData, 'downloads', id, 'manifest.json')
    expect(JSON.parse(await readFile(manifest, 'utf8')).state.status).toBe('error')

    await lychee.relaunch()
    await expect(
      lychee.page.getByRole('button', { name: `Open ${paused.fileName}`, exact: true })
    ).toBeVisible()
    expect((await lychee.waitForTorrentStatus('error')).error).toMatch(/folder is now a link/)
    await unlink(paused.destinationPath)
    await rename(original, paused.destinationPath)
    await lychee.api.removeDownload(id)
    expect(await lychee.all()).toEqual([])
    expect(existsSync(manifest)).toBe(false)
    expect(await readFile(join(paused.destinationPath, 'personal.txt'), 'utf8')).toBe('keep me')
    for (const name of ['a.bin', 'b.bin'])
      expect(existsSync(join(paused.destinationPath, name))).toBe(false)
  } finally {
    await swarm.stop()
  }
})

test('cleanup failure keeps an active HTTP download visible and blocks resume during cancellation @smoke', async ({
  lychee,
  serve,
  dirs
}) => {
  const origin = await serve({ size: 24 * BLOCK })
  const reached = origin.hold(7 * BLOCK)
  const id = await lychee.start(origin.url(), origin.sha256)
  await reached
  const state = (await lychee.currentHttp())!
  const staging = `${state.destinationPath}.lychee`
  await lychee.evaluateMain((_electron, path) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const original = fs.rm
    const globals = globalThis as Record<string, unknown>
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    globals.__releaseDiscard = () => {
      fs.rm = original
      release()
    }
    fs.rm = async (...args: Parameters<typeof original>) => {
      if (args[0] === path) {
        globals.__discardHeld = true
        await held
        throw Object.assign(new Error('Permission denied removing partial data'), {
          code: 'EACCES'
        })
      }
      return original(...args)
    }
  }, staging)
  try {
    const removing = lychee.api.removeDownload(id).then(
      () => null,
      (error: Error) => error.message
    )
    await expect
      .poll(() =>
        lychee.evaluateMain(() => (globalThis as Record<string, unknown>).__discardHeld, null)
      )
      .toBe(true)
    const alsoRemoving = lychee.api.removeDownload(id).then(
      () => null,
      (error: Error) => error.message
    )
    await lychee.api.resumeDownload(id)
    expect(
      (await lychee.api.listDownloads()).find((entry) => entry.state.id === id)?.state.status
    ).toBe('paused')
    await expect(
      lychee.page.getByRole('button', { name: `Open ${state.fileName}`, exact: true })
    ).toBeVisible()
    await lychee.evaluateMain(() => {
      ;((globalThis as Record<string, unknown>).__releaseDiscard as () => void)()
    }, null)
    expect(await removing).toMatch(/Permission denied/)
    expect(await alsoRemoving).toMatch(/Permission denied/)
    const failed = await lychee.waitForHttpStatus('error')
    expect(failed.resumable).toBe(false)
    expect(existsSync(staging)).toBe(true)
    expect(
      lychee.sessions
        .flat()
        .filter((entry) => entry.id === id)
        .some((entry) => entry.status === 'cancelled')
    ).toBe(false)
    expect(
      JSON.parse(await readFile(join(dirs.userData, 'downloads', id, 'manifest.json'), 'utf8'))
        .state.status
    ).toBe('error')
    await lychee.api.removeDownload(id)
    expect(existsSync(staging)).toBe(false)
    expect(await lychee.all()).toEqual([])
  } finally {
    if (lychee.alive)
      await lychee
        .evaluateMain(() => {
          ;((globalThis as Record<string, unknown>).__releaseDiscard as () => void)()
        }, null)
        .catch(() => {})
    origin.release()
  }
})
