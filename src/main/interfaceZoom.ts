import type { InterfaceSize } from '../shared/types'

/** How much the window's content is zoomed, from the Interface size setting and the scale factor
 * of the display the window is on. Pure, so the mapping is testable without Electron.
 *
 * Zoom only scales what's drawn inside the window: its size stays in DIPs (see windowSize.ts) and
 * is never shrunk by the zoom as well. */

/** Auto's zoom at 150% and at 200% and up; linear in between, none below 150%. */
const AUTO_ZOOM = {
  from: { scaleFactor: 1.5, zoom: 0.9 },
  to: { scaleFactor: 2, zoom: 0.85 }
}

/** Auto: a little smaller on a display the OS scales up a lot (a 4K screen at 150–200%), where
 * text and controls sized for 100% come out bigger than other apps'. A Mac's Retina display is
 * always 2×, and its DIPs are already the size macOS means, so Auto leaves it alone. */
export function autoZoom(scaleFactor: number, platform: NodeJS.Platform): number {
  const { from, to } = AUTO_ZOOM
  if (platform === 'darwin' || !(scaleFactor >= from.scaleFactor)) return 1
  if (scaleFactor >= to.scaleFactor) return to.zoom
  const t = (scaleFactor - from.scaleFactor) / (to.scaleFactor - from.scaleFactor)
  return Math.round((from.zoom + t * (to.zoom - from.zoom)) * 1000) / 1000
}

export function interfaceZoom(
  size: InterfaceSize,
  scaleFactor: number,
  platform: NodeJS.Platform
): number {
  return size === 'auto' ? autoZoom(scaleFactor, platform) : size / 100
}
