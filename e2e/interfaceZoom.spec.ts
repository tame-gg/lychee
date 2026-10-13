import { expect, test } from '@playwright/test'
import { autoZoom, interfaceZoom } from '../src/main/interfaceZoom'

test.describe('the interface zoom @smoke', () => {
  test('Auto: none below 150%, 0.9 at 150%, 0.85 at 200% and up, in step between', () => {
    expect(autoZoom(1, 'win32')).toBe(1)
    expect(autoZoom(1.25, 'win32')).toBe(1)
    expect(autoZoom(1.49, 'win32')).toBe(1)
    expect(autoZoom(1.5, 'win32')).toBe(0.9)
    expect(autoZoom(1.75, 'win32')).toBe(0.875)
    expect(autoZoom(2, 'win32')).toBe(0.85)
    expect(autoZoom(2.5, 'win32')).toBe(0.85)
    expect(autoZoom(3, 'linux')).toBe(0.85)
    let previous = 1
    for (let scale = 1; scale <= 4; scale += 0.05) {
      const zoom = autoZoom(scale, 'win32')
      expect(zoom, `${scale}`).toBeLessThanOrEqual(previous)
      expect(zoom, `${scale}`).toBeGreaterThanOrEqual(0.85)
      previous = zoom
    }
  })

  test('Auto leaves a Mac’s Retina display alone, and a bad scale factor', () => {
    expect(autoZoom(2, 'darwin')).toBe(1)
    expect(autoZoom(Number.NaN, 'win32')).toBe(1)
    expect(autoZoom(0, 'win32')).toBe(1)
  })

  test('a percentage is that zoom on any display', () => {
    for (const scale of [1, 1.5, 2]) {
      for (const platform of ['win32', 'darwin'] as const) {
        expect(interfaceZoom(100, scale, platform)).toBe(1)
        expect(interfaceZoom(90, scale, platform)).toBe(0.9)
        expect(interfaceZoom(80, scale, platform)).toBe(0.8)
      }
    }
    expect(interfaceZoom('auto', 2, 'win32')).toBe(0.85)
  })
})
