import { expect, test } from '@playwright/test'
import { DEFAULT_MAX, DESIGN_MIN, windowSize } from '../src/main/windowSize'

// Work areas in DIPs, as Electron's `screen` reports them: the screen's pixels divided by its
// scale factor, less the taskbar.
const WORK_AREAS = {
  '1366×768 at 100%': { width: 1366, height: 728 },
  '1366×768 at 150%': { width: 911, height: 472 },
  '1920×1080 at 100%': { width: 1920, height: 1040 },
  '1920×1080 at 150%': { width: 1280, height: 680 },
  '1920×1080 at 200%': { width: 960, height: 500 },
  '2560×1440 at 150%': { width: 1707, height: 920 },
  '3840×2160 at 150%': { width: 2560, height: 1400 },
  '3840×2160 at 200%': { width: 1920, height: 1040 },
  '3840×2160 at 100%': { width: 3840, height: 2120 }
}

test.describe('the window’s size @smoke', () => {
  test('fits the work area, at least the design minimum where there is room for it', () => {
    for (const [name, area] of Object.entries(WORK_AREAS)) {
      const size = windowSize(area)
      expect(size.width, name).toBeLessThanOrEqual(area.width)
      expect(size.height, name).toBeLessThanOrEqual(area.height)
      expect(size.width, name).toBeLessThanOrEqual(DEFAULT_MAX.width)
      expect(size.height, name).toBeLessThanOrEqual(DEFAULT_MAX.height)
      expect(size.width, name).toBeGreaterThanOrEqual(size.minWidth)
      expect(size.height, name).toBeGreaterThanOrEqual(size.minHeight)
      expect(size.minWidth, name).toBe(Math.min(DESIGN_MIN.width, area.width))
      expect(size.minHeight, name).toBe(Math.min(DESIGN_MIN.height, area.height))
    }
  })

  test('is the same share of the screen at any scale: never scaled by the scale factor again', () => {
    // A 4K screen at 200% has the work area of a 1080p one at 100%, so the same window in DIPs,
    // which the OS draws twice as big in pixels: the same part of the screen.
    expect(windowSize(WORK_AREAS['3840×2160 at 200%'])).toEqual(
      windowSize(WORK_AREAS['1920×1080 at 100%'])
    )
    expect(windowSize(WORK_AREAS['1920×1080 at 100%'])).toEqual({
      width: 900,
      height: 720,
      minWidth: 720,
      minHeight: 620
    })
    // 1080p at 200%: less room than the design minimum, so the window fits rather than overflows.
    expect(windowSize(WORK_AREAS['1920×1080 at 200%'])).toEqual({
      width: 720,
      height: 500,
      minWidth: 720,
      minHeight: 500
    })
  })
})
