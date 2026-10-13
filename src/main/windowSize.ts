/** Window sizes, all in DIPs (device-independent pixels): Electron's BrowserWindow sizes and
 * `screen` work areas are already in DIPs, and the OS multiplies them by the display's scale
 * factor (150%, 200%, …) itself, as it does CSS px. Nothing here may multiply by `scaleFactor`
 * again, or a 200% display gets a window four times the size. */

interface Size {
  width: number
  height: number
}

/** The smallest the window is designed for: room under the download screen's pinned block grid
 * for a network row and a few of its rows. */
export const DESIGN_MIN: Size = { width: 720, height: 620 }

/** Bigger than this, the screens only gain empty space: their content is laid out at fixed
 * widths, and a wider window just opens gaps. */
export const DEFAULT_MAX: Size = { width: 900, height: 720 }

/** What part of the work area a new window takes, before the clamps above. */
const SHARE = { width: 0.55, height: 0.8 }

export interface WindowSize extends Size {
  minWidth: number
  minHeight: number
}

/** The window's opening and minimum size for a display whose work area (the screen less the
 * taskbar or Dock) is `workArea` DIPs. A share of the work area, between the design's minimum
 * and DEFAULT_MAX, and never more than the work area itself: on a small or highly scaled display
 * (1366×768 at 150% is 911×~480 DIPs) the minimum gives way rather than push the window, and
 * its footer, off the screen. */
export function windowSize(workArea: Size): WindowSize {
  const minWidth = Math.min(DESIGN_MIN.width, workArea.width)
  const minHeight = Math.min(DESIGN_MIN.height, workArea.height)
  const fit = (share: number, area: number, min: number, max: number): number =>
    Math.min(area, Math.max(min, Math.min(max, Math.round(area * share))))
  return {
    width: fit(SHARE.width, workArea.width, minWidth, DEFAULT_MAX.width),
    height: fit(SHARE.height, workArea.height, minHeight, DEFAULT_MAX.height),
    minWidth,
    minHeight
  }
}
