import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, shell, Tray } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon-dark.png?asset'
// 16px tray icons; nativeImage loads the @2x file next to each on its own.
import trayIcon from '../../resources/tray.png?asset'
import trayTemplateIcon from '../../resources/trayTemplate.png?asset'
import { registerIpcHandlers } from './ipc/handlers'
import { keepsRunningForBrowser, startBridge } from './browserBridge'
import { acceptedLink, bringForward, linkFromArgs, offerLink } from './openLinks'
import { loadSettings, loadThemeSource, migrateLegacyNetworkPreferences } from './settings'
import { startUpdater } from './updater'
import { testKnobs } from './testKnobs'
import { windowSize } from './windowSize'
import { setInterfaceSize, trackZoom, zoomOn } from './windowZoom'
import type { DownloadManager } from './download/downloadManager'

// In dev mode the app runs as the raw `electron` binary, which otherwise shows "Electron" in
// the Dock tooltip/menu bar — must be set before the app is ready. Packaged builds already get
// this from electron-builder's productName, but setting it here keeps dev and packaged in sync.
app.setName('Lychee')

// Each e2e test runs against its own throwaway userData folder (downloads, manifests, settings).
if (testKnobs.userDataDir) app.setPath('userData', testKnobs.userDataDir)

// One Lychee at a time (per userData folder, so parallel e2e runs each have their own): a second
// launch — a magnet link clicked, a .torrent opened — hands its link to the first and exits.
if (!app.requestSingleInstanceLock()) app.exit(0)

let mainWindow: BrowserWindow | null = null
let downloadManager: DownloadManager | null = null
let quitAfterSuspending = false
let tray: Tray | null = null
/** The window's content zoom (see windowZoom.ts), which the title bar's controls follow. */
let zoom = 1

/** Only once the app is ready. */
function ensureWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  return mainWindow as BrowserWindow
}

/** A link the OS handed over goes to the window's link field (see openLinks.ts). */
function offer(candidate: string): void {
  const link = acceptedLink(candidate)
  if (!link) return
  // Before the app is ready the link waits; the window takes it once it opens.
  offerLink({ url: link }, app.isReady() ? ensureWindow() : null)
}

// A lychee:// link from the browser extension arrives here too, with no link in it.
app.on('second-instance', (_event, argv) => {
  const link = linkFromArgs(argv)
  if (link) return offer(link)
  bringForward(ensureWindow())
})
// macOS hands links over as events, and may do so before the app is ready.
app.on('open-url', (event, url) => {
  event.preventDefault()
  offer(url)
})
app.on('open-file', (event, path) => {
  event.preventDefault()
  offer(path)
})
// Windows and Linux put the first launch's link on its command line.
const launchLink = linkFromArgs(process.argv)
if (launchLink) offer(launchLink)

/** The Windows/Linux window controls, in the title bar's colors (main.css's --bg-secondary and
 * --text) for the theme in use, at its height: TitleBar.tsx's 44px, zoomed with the content. */
function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const dark = nativeTheme.shouldUseDarkColors
  return {
    color: dark ? '#121212' : '#fafafa',
    symbolColor: dark ? '#f2f2f2' : '#1d1d1f',
    height: Math.round(44 * zoom)
  }
}

/** The 14px native buttons centered in the renderer's 32px macOS title bar, zoomed with it. */
function trafficLightPosition(): Electron.Point {
  return { x: 16, y: Math.round((32 * zoom - 14) / 2) }
}

function createWindow(): void {
  const display = screen.getPrimaryDisplay()
  zoom = zoomOn(display)
  mainWindow = new BrowserWindow({
    // Sized from the display it opens on, in DIPs like the work area itself (see windowSize.ts).
    // The content's zoom leaves it be: a smaller interface gets more room, not a smaller window.
    ...windowSize(display.workArea),
    show: false,
    autoHideMenuBar: true,
    title: 'Lychee',
    // Matches the renderer's dark-mode background so a live window resize
    // (which briefly exposes the raw window background) doesn't flash white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    ...(process.platform !== 'darwin' ? { icon } : {}),
    // One title bar on every OS: the renderer's own strip (see TitleBar.tsx), with the OS's
    // window controls over it — macOS's traffic lights, or the minimize/maximize/close that
    // Windows and Linux draw over the strip's right end.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: trafficLightPosition() }
      : { titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      zoomFactor: zoom,
      // A hidden e2e window would otherwise have its timers throttled.
      backgroundThrottling: !testKnobs.hideWindow
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!testKnobs.hideWindow) mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const window = mainWindow
  trackZoom(window, (next) => {
    zoom = next
    if (process.platform === 'darwin') window.setWindowButtonPosition(trafficLightPosition())
    else window.setTitleBarOverlay(titleBarOverlay())
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only hand http(s) links to the OS shell — an arbitrary scheme (e.g. a custom protocol
    // handler) reaching shell.openExternal is a known Electron risk if this ever fires with
    // attacker- or server-influenced data.
    if (/^https?:/i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Electron shows no right-click menu of its own: give every text field Cut/Copy/Paste, and any
  // selected text Copy.
  mainWindow.webContents.on('context-menu', (_, { isEditable, selectionText, editFlags }) => {
    const template: Electron.MenuItemConstructorOptions[] = isEditable
      ? [
          { role: 'cut', enabled: editFlags.canCut },
          { role: 'copy', enabled: editFlags.canCopy },
          { role: 'paste', enabled: editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', enabled: editFlags.canSelectAll }
        ]
      : selectionText.trim()
        ? [{ role: 'copy' }]
        : []
    if (template.length) Menu.buildFromTemplate(template).popup()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('gg.tame.lychee')

  // A failed move keeps the old file, to retry next launch — it must never stop the window opening.
  await migrateLegacyNetworkPreferences().catch((error) =>
    console.error('[lychee] failed to migrate network-preferences.json', error)
  )

  // The macOS About window (Lychee › About Lychee); its copyright comes from electron-builder.yml.
  app.setAboutPanelOptions({
    credits:
      'A tame.gg project. Based on Plexo (https://github.com/anmolkapil/plexo) by Anmol Kapil, MIT license.'
  })

  // Applied before the window is created so the initial background/icon already match —
  // the saved preference otherwise only takes effect on the next 'updated' event.
  nativeTheme.themeSource = await loadThemeSource()
  setInterfaceSize((await loadSettings()).interfaceSize ?? 'auto')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  downloadManager = registerIpcHandlers(() => mainWindow)
  void startBridge({
    manager: downloadManager,
    offer: (link) => offerLink(link, ensureWindow())
  }).catch((error) => console.error('[lychee] browser bridge failed to start', error))
  // Unlike magnet:, lychee:// is Lychee's own, so registering it takes nothing from another app. A
  // development build has no fixed path to register.
  if (app.isPackaged) app.setAsDefaultProtocolClient('lychee')

  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff')
    if (process.platform !== 'darwin') mainWindow?.setTitleBarOverlay(titleBarOverlay())
  })

  createWindow()
  if (testKnobs.hideWindow) app.dock?.hide()
  startUpdater(
    () => mainWindow,
    (await loadSettings()).autoUpdate !== false,
    async () =>
      (await downloadManager?.listDownloads())?.filter(
        (d) => d.state.status === 'downloading' || d.state.status === 'queued'
      ).length ?? 0
  ).catch((error) => console.error('[lychee] updater failed to start', error))

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  if (quitAfterSuspending || !downloadManager) return

  event.preventDefault()

  // Guarantee the process exits even if suspending hangs
  const forceQuitTimeout = setTimeout(() => {
    app.exit(0)
  }, 3000)

  void downloadManager.suspendAll().finally(() => {
    clearTimeout(forceQuitTimeout)
    quitAfterSuspending = true
    app.exit(0)
  })
})

/** The tray icon; on macOS a template image (black + alpha) that the menu bar tints itself. */
function trayImage(): Electron.NativeImage {
  if (process.platform !== 'darwin') return nativeImage.createFromPath(trayIcon)
  const image = nativeImage.createFromPath(trayTemplateIcon)
  image.setTemplateImage(true)
  return image
}

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  if (!keepsRunningForBrowser()) return app.quit()
  // Kept running in the tray, so the browser extension can still reach it.
  if (tray) return
  tray = new Tray(trayImage())
  tray.setToolTip('Lychee')
  tray.on('click', () => bringForward(ensureWindow()))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Lychee', click: () => bringForward(ensureWindow()) },
      { type: 'separator' },
      { label: 'Quit Lychee', click: () => app.quit() }
    ])
  )
})
