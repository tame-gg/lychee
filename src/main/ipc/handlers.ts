import { existsSync, readFileSync } from 'node:fs'
import { mkdir, stat, statfs, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import {
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type { IpcContract } from '../../shared/ipc-contract'
import { DEFAULT_MERGE_SETTINGS } from '../../shared/mergeSettings'
import {
  DEFAULT_SLOW_MODE_SPEED,
  DOWNLOADS_AT_ONCE,
  type InitialState,
  type MergeState,
  type ThemeSource
} from '../../shared/types'
import { DownloadManager } from '../download/downloadManager'
import { getDefaultDownloadsDir, getHomeDir } from '../download/paths'
import { listHistory } from '../download/history'
import { probeUrl } from '../download/probe'
import { deviceBindingSupported } from '../network/deviceBinding'
import { setDiagnosticsExporter } from '../diagnosticsAction'
import { buildDiagnosticsZip } from '../network/merge/diagnostics'
import { connectOnlyLauncher, NativeLauncher } from '../network/merge/elevate'
import { MergeController } from '../network/merge/mergeController'
import {
  NETD_LOG_NAME,
  NETD_LOG_ROTATIONS,
  NetdLog,
  netdLogsDirectory,
  redactLogLine
} from '../network/merge/netdLog'
import { pendingLink, pendingLinks, releaseLink } from '../openLinks'
import { NetworkMonitor, setReportedTunName } from '../network/interfaces'
import { loadSettings, saveSettings } from '../settings'
import { testKnobs } from '../testKnobs'
import { showUpdateMenu, updateState } from '../updater'
import { setInterfaceSize } from '../windowZoom'

async function openNetworkSettings(): Promise<void> {
  if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:network-status')
  } else if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.network')
  } else if (process.platform === 'linux') {
    try {
      const { exec } = await import('node:child_process')
      exec('gnome-control-center network || nm-connection-editor || true')
    } catch {
      // Best-effort
    }
  }
}

/** Typed wrapper around ipcMain.handle — the channel name picks its args/result shape out of
 * IpcContract, so a handler here that doesn't match what lycheeApi (preload) actually calls is a
 * compile error instead of a silent runtime mismatch. */
function handle<K extends keyof IpcContract>(
  channel: K,
  listener: (
    event: IpcMainInvokeEvent,
    ...args: IpcContract[K]['args']
  ) => IpcContract[K]['result'] | Promise<IpcContract[K]['result']>
): void {
  ipcMain.handle(
    IpcChannels[channel],
    listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  )
}

const DESTINATION_CHECK_MS = 300
const HELPER_PROMPT_MS = 180_000

async function freeSpace(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

export interface RegisteredHandlers {
  manager: DownloadManager
  merge: MergeController
}

export function registerIpcHandlers(
  getWindow: () => BrowserWindow | null,
  onMergeState?: (state: MergeState) => void
): RegisteredHandlers {
  // The main process keeps the network list, for downloads and the window alike.
  const networks = new NetworkMonitor((list) => {
    manager.networksChanged()
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IpcChannels.networksChanged, list)
  })
  const manager = new DownloadManager(getWindow, networks)
  let reportedTunName: string | null = null
  const logsDirectory = netdLogsDirectory(app.getPath('userData'))
  const home = app.getPath('home')
  const netdLog = new NetdLog(logsDirectory, home)
  const logNetd = (line: string): void => {
    netdLog.write(line)
    console.log(`[lychee-netd] ${redactLogLine(line, home)}`)
  }
  const merge = new MergeController({
    launcher: testKnobs.netdControlPath
      ? connectOnlyLauncher(testKnobs.netdControlPath)
      : new NativeLauncher(
          {
            platform: process.platform,
            arch: process.arch,
            version: app.getVersion(),
            packaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            appRoot: app.getAppPath(),
            env: process.env,
            uid: process.getuid?.()
          },
          logNetd
        ),
    version: app.getVersion(),
    timing: testKnobs.netdControlPath ? undefined : { connectTimeoutMs: HELPER_PROMPT_MS },
    settings: {
      load: async () => (await loadSettings()).merge ?? DEFAULT_MERGE_SETTINGS,
      save: (settings) => saveSettings({ merge: settings })
    },
    push: (state) => {
      const tunName = state.tun?.open ? state.tun.name : null
      if (tunName !== reportedTunName) {
        reportedTunName = tunName
        setReportedTunName(tunName)
        void networks.refresh()
      }
      onMergeState?.(state)
      const window = getWindow()
      if (window && !window.isDestroyed())
        window.webContents.send(IpcChannels.mergeStateChanged, state)
    },
    log: logNetd
  })
  manager.setLimitsListener(() => {
    void merge.syncLimitedNetworks(manager.limitFacts())
  })
  void merge
    .start()
    .catch((error) => console.error('[lychee] network helper failed to start', error))
  // Waking from sleep, the networks may have changed without a poll in between to see it.
  powerMonitor.on('resume', () => {
    manager.systemResumed()
    void networks.refresh()
  })

  handle('listInterfaces', () => networks.refresh())

  // Started now so it has settled before the first download needs it.
  const bindingSupport = deviceBindingSupported()
  handle('deviceBindingSupported', async () => bindingSupport)

  // The app only ever assigns 'light'/'dark' to nativeTheme.themeSource (main/index.ts's startup
  // call to loadThemeSource() never resolves to 'system') — narrow Electron's wider type here
  // rather than widening our own ThemeSource just to match it.
  const currentThemeSource = (): ThemeSource =>
    nativeTheme.themeSource === 'dark' ? 'dark' : 'light'

  handle('updateSettings', async (_event, patch) => {
    // The settings main also applies — before saving, so a failed write still switches the
    // window to the theme the toggle now shows.
    if (patch?.themeSource === 'light' || patch?.themeSource === 'dark') {
      nativeTheme.themeSource = patch.themeSource
    }
    await saveSettings(patch)
    // Read back rather than taken from the patch: what was saved is what passed the checks.
    const settings = await loadSettings()
    if (patch && 'interfaceSize' in patch) setInterfaceSize(settings.interfaceSize ?? 'auto')
    await manager.applySettings(settings)
  })

  // Answered via sendSync from the preload, which blocks the page until returnValue is set — so a
  // throw here must still reply (with no saved values) rather than leave the window never showing.
  ipcMain.on(IpcChannels.getInitialState, async (event) => {
    try {
      const settings = await loadSettings()
      const { destinationDir } = settings
      // Capped: a folder on a dropped network share can take many seconds to answer, and launch
      // waits on this reply — past the cap it's treated as gone and Downloads is used instead.
      const destinationExists =
        destinationDir !== undefined &&
        (await Promise.race([
          stat(destinationDir).then(
            (stats) => stats.isDirectory(),
            () => false
          ),
          new Promise<boolean>((resolve) => setTimeout(resolve, DESTINATION_CHECK_MS, false))
        ]))
      event.returnValue = {
        downloadSchedule: settings.downloadSchedule,
        homeDir: getHomeDir(),
        downloadsDir: getDefaultDownloadsDir(),
        themeSource: currentThemeSource(),
        networkPreferences: settings.networkPreferences ?? {},
        downloadsAtOnce: settings.downloadsAtOnce ?? DOWNLOADS_AT_ONCE.default,
        speedLimit: settings.speedLimit,
        slowMode: settings.slowMode ?? false,
        slowModeSpeed: settings.slowModeSpeed ?? DEFAULT_SLOW_MODE_SPEED,
        speedUnit: settings.speedUnit ?? 'bytes',
        interfaceSize: settings.interfaceSize ?? 'auto',
        sidebarCollapsed: settings.sidebarCollapsed ?? false,
        destinationDir: destinationExists ? destinationDir : undefined,
        merge: settings.merge ?? DEFAULT_MERGE_SETTINGS,
        networkPage:
          testKnobs.networkPage ?? (settings.showNetworkPage === false ? 'off' : 'helper')
      } satisfies InitialState
    } catch (error) {
      console.error('[lychee] failed to read initial state', error)
      // No getPath() here — it may be what threw. An empty destination just keeps Start disabled.
      event.returnValue = {
        homeDir: '',
        downloadsDir: '',
        themeSource: currentThemeSource(),
        networkPreferences: {},
        downloadsAtOnce: DOWNLOADS_AT_ONCE.default,
        slowMode: false,
        slowModeSpeed: DEFAULT_SLOW_MODE_SPEED,
        speedUnit: 'bytes',
        interfaceSize: 'auto',
        sidebarCollapsed: false,
        merge: DEFAULT_MERGE_SETTINGS,
        networkPage: testKnobs.networkPage ?? 'helper'
      } satisfies InitialState
    }
  })

  handle('openNetworkSettings', async () => {
    await openNetworkSettings()
  })

  handle('probeUrl', async (_event, url) => probeUrl(url))

  handle('chooseDestinationFolder', async (_event, defaultPath) => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle('chooseTorrentFile', async () => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'Torrent', extensions: ['torrent'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle('pendingLinks', async () => pendingLinks())
  handle('resumeFromLink', async (_event, linkId, downloadId) => {
    const link = pendingLink(linkId)
    if (link?.probe?.kind !== 'http') throw new Error('That download is no longer waiting.')
    await manager.relink(downloadId, link.probe.finalUrl, {
      probe: link.probe,
      browser: link.browser
    })
    releaseLink(linkId)
  })
  handle('dismissLink', async (_event, id) => releaseLink(id))

  handle('readClipboardText', async () => clipboard.readText())

  handle('revealDownload', async (_event, id) => manager.reveal(id))

  handle('openDownload', async (_event, id) => manager.open(id))

  // The browser's sign-in is attached here, so it never passes through the window.
  handle('startDownload', async (_event, request, linkId) => {
    const browser = linkId === undefined ? undefined : pendingLink(linkId)?.browser
    const id = await manager.start(
      browser && request.kind === 'http' ? { ...request, browser } : request
    )
    if (linkId !== undefined) releaseLink(linkId)
    return id
  })

  handle('listDownloads', async () => manager.listDownloads())

  handle('listHistory', async () => listHistory())

  handle('clearHistory', async () => manager.clearHistory())

  handle('networkUsage', async () => manager.limits.usedByPeriod())
  handle('resetNetworkUsage', async (_event, id) => manager.resetNetworkUsage(id))

  handle('freeSpace', async (_event, dir) => freeSpace(dir))

  handle('torrentFiles', async (_event, id) => manager.torrentFiles(id))
  handle('chooseTorrentFiles', async (_event, id, selected) =>
    manager.chooseTorrentFiles(id, selected)
  )

  handle('pauseDownload', async (_event, id) => {
    await manager.pause(id)
  })

  handle('resumeDownload', async (_event, id) => {
    manager.resume(id)
  })

  handle('relinkDownload', async (_event, id, url) => manager.relink(id, url))

  handle('setDownloadNetwork', async (_event, id, networkId, enabled) => {
    await manager.setNetworkEnabled(id, networkId, enabled)
  })

  handle('cancelDownload', async (_event, id) => manager.cancel(id))

  handle('removeDownload', async (_event, id, options) =>
    manager.remove(id, options?.trashFile === true)
  )

  handle('updateState', () => updateState())
  handle('showUpdateMenu', () => showUpdateMenu())

  handle('mergeState', () => merge.state())
  const pushOnFailure = (command: Promise<void>): Promise<void> =>
    command.catch((error: unknown) => {
      merge.pushState()
      throw error
    })
  handle('setMerging', (_event, on) => pushOnFailure(merge.setMerging(on === true)))
  handle('setMergeOptions', (_event, patch) => pushOnFailure(merge.setOptions(patch ?? {})))
  handle('setMergeNetwork', (_event, id, enabled) =>
    pushOnFailure(merge.setNetwork(id, enabled === true))
  )
  handle('setMergeWeight', (_event, id, weight) => pushOnFailure(merge.setWeight(id, weight)))
  handle('repairNetwork', () => merge.repair())

  const exportDiagnostics = async (): Promise<string | null> => {
    const target = await diagnosticsTarget(getWindow())
    if (!target) return null
    const logs = readNetdLogs(logsDirectory)
    const bytes = buildDiagnosticsZip({
      lycheeVersion: app.getVersion(),
      home,
      os: { platform: process.platform, release: release(), arch: process.arch },
      state: merge.state(),
      logs
    })
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    return target
  }
  setDiagnosticsExporter(exportDiagnostics)
  handle('exportDiagnostics', () => exportDiagnostics())

  return { manager, merge }
}

function readNetdLogs(dir: string): { name: string; text: string }[] {
  const names = [NETD_LOG_NAME]
  for (let index = 1; index <= NETD_LOG_ROTATIONS; index++) names.push(`${NETD_LOG_NAME}.${index}`)
  const logs: { name: string; text: string }[] = []
  for (const name of names) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    logs.push({ name, text: readFileSync(path, 'utf8') })
  }
  return logs
}

async function diagnosticsTarget(window: BrowserWindow | null): Promise<string | null> {
  if (testKnobs.diagnosticsPath) return testKnobs.diagnosticsPath
  const options: Electron.SaveDialogOptions = {
    title: 'Export diagnostics',
    defaultPath: 'lychee-diagnostics.zip',
    filters: [{ name: 'Zip archive', extensions: ['zip'] }]
  }
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  return result.filePath
}
