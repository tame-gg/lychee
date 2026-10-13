import { BrowserWindow, screen } from 'electron'
import type { InterfaceSize } from '../shared/types'
import { interfaceZoom } from './interfaceZoom'

let interfaceSize: InterfaceSize = 'auto'
const tracked = new Map<BrowserWindow, (zoom: number) => void>()

/** The zoom for a window on `display`. */
export function zoomOn(display: Electron.Display): number {
  return interfaceZoom(interfaceSize, display.scaleFactor, process.platform)
}

/** The zoom for `window`, on the display most of it is on. */
function zoomFor(window: BrowserWindow): number {
  return zoomOn(screen.getDisplayMatching(window.getBounds()))
}

function apply(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const zoom = zoomFor(window)
  if (zoom === window.webContents.getZoomFactor()) return
  window.webContents.setZoomFactor(zoom)
  tracked.get(window)?.(zoom)
}

function applyAll(): void {
  for (const window of tracked.keys()) apply(window)
}

/** Keeps `window`'s zoom (see interfaceZoom.ts) right as it moves to another display, a display's
 * scaling changes, or the setting does. `onZoom` hears each change, for what main draws to match
 * the content (the title bar's window controls). */
export function trackZoom(window: BrowserWindow, onZoom: (zoom: number) => void): void {
  if (tracked.size === 0) {
    screen.on('display-metrics-changed', applyAll)
    screen.on('display-added', applyAll)
    screen.on('display-removed', applyAll)
  }
  tracked.set(window, onZoom)
  // 'move' rather than 'moved', which Linux never sends; apply() is cheap when nothing changed.
  window.on('move', () => apply(window))
  // A new page starts at the default zoom.
  window.webContents.on('did-finish-load', () => apply(window))
  window.on('closed', () => {
    tracked.delete(window)
    if (tracked.size > 0) return
    screen.off('display-metrics-changed', applyAll)
    screen.off('display-added', applyAll)
    screen.off('display-removed', applyAll)
  })
}

export function setInterfaceSize(size: InterfaceSize): void {
  interfaceSize = size
  applyAll()
}
