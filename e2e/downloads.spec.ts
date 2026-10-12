import { createRequire } from 'node:module'
import { expect, test } from '@playwright/test'

// M. Release files: what each file is called and which one a visitor is offered. The logic lives
// in release/downloads.js, which the release-notes script also uses.

interface Asset {
  os: 'mac' | 'win' | 'linux'
  arch: 'arm64' | 'x64' | 'any'
  kind: string
  title: string
  detail: string
  file: string
  url: string
  recommended: boolean
}
interface Model {
  groups: { os: string; label: string; rows: Asset[]; notes: string[] }[]
  primary: { asset: Asset; title: string; meta: string } | null
  alternates: { text: string; asset: Asset }[]
  hint: string | null
  desktop: boolean
  empty: boolean
}
interface Env {
  os: string
  arch: 'arm64' | 'x64' | null
}
const D = createRequire(__filename)('../release/downloads.js').LycheeDownloads as {
  describe: (name: string) => Omit<Asset, 'file' | 'url' | 'recommended'> | null
  detectEnvironment: (
    nav: { userAgent: string; platform: string; maxTouchPoints?: number },
    hint?: { architecture: string } | null
  ) => Env
  build: (release: unknown, env: Env) => Model
  markdown: (files: { name: string; size: number; url: string }[], site: string) => string
}

// What a release actually contains (rc.7's file names), plus what electron-builder leaves lying
// around in dist/ that must never be offered.
const SHIPPED = [
  'lychee-1.0.0-rc.7-arm64.AppImage',
  'lychee-1.0.0-rc.7-arm64.dmg',
  'lychee-1.0.0-rc.7-setup.exe',
  'lychee-1.0.0-rc.7-x64.dmg',
  'lychee-1.0.0-rc.7-x86_64.AppImage',
  'lychee_1.0.0-rc.7_amd64.deb',
  'lychee_1.0.0-rc.7_arm64.deb'
]
const NOISE = [
  'latest.yml',
  'latest-mac.yml',
  'lychee-1.0.0-rc.7-arm64.dmg.blockmap',
  'lychee-1.0.0-rc.7-setup.exe.blockmap',
  'lychee_1.0.0-rc.7_amd64.snap',
  'Lychee-1.0.0-rc.4-arm64-mac.zip'
]
const BASE = 'https://github.com/tame-gg/lychee/releases/download/v1.0.0-rc.7/'
const release = (names: string[] = [...SHIPPED, ...NOISE]): unknown => ({
  tag_name: 'v1.0.0-rc.7',
  prerelease: true,
  published_at: '2026-09-19T08:34:03Z',
  assets: names.map((name, i) => ({
    name,
    size: (90 + i) * 1048576,
    browser_download_url: BASE + name
  }))
})

// Browsers as they really introduce themselves. Note that Chrome on an Apple silicon Mac still
// says "Intel" in its user agent — only its client hints tell the truth.
const BROWSERS = {
  chromeMac: {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'MacIntel'
  },
  safariMac: {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    platform: 'MacIntel'
  },
  firefoxLinux: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    platform: 'Linux x86_64'
  },
  chromeLinuxArm: {
    userAgent:
      'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'Linux aarch64'
  },
  chromeWindows: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'Win32'
  },
  iphone: {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone'
  },
  ipadDesktopMode: {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 5
  },
  android: {
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv81'
  },
  chromeOs: {
    userAgent:
      'Mozilla/5.0 (X11; CrOS x86_64 15662.76.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'Linux x86_64'
  }
} as const

test.describe('what each file is', () => {
  const expected: Record<string, [string, string, string]> = {
    'lychee-1.0.0-rc.7-arm64.dmg': ['mac', 'arm64', 'Apple silicon'],
    'lychee-1.0.0-rc.7-x64.dmg': ['mac', 'x64', 'Intel'],
    'lychee-1.0.0-rc.7-setup.exe': ['win', 'any', 'Windows 10 and 11'],
    'lychee-1.0.0-rc.7-x86_64.AppImage': ['linux', 'x64', 'AppImage · x86_64'],
    'lychee-1.0.0-rc.7-arm64.AppImage': ['linux', 'arm64', 'AppImage · ARM64'],
    'lychee_1.0.0-rc.7_amd64.deb': ['linux', 'x64', 'Debian / Ubuntu · x86_64'],
    'lychee_1.0.0-rc.7_arm64.deb': ['linux', 'arm64', 'Debian / Ubuntu · ARM64']
  }

  for (const [file, [os, arch, title]] of Object.entries(expected)) {
    test(`${file} → ${title}`, () => {
      expect(D.describe(file)).toMatchObject({ os, arch, title })
    })
  }

  test('update metadata, blockmaps, snaps and zips are never offered', () => {
    for (const name of NOISE) expect(D.describe(name), name).toBeNull()
  })

  test('a Windows installer with an architecture in its name is described as that one', () => {
    expect(D.describe('lychee-2.0.0-x64-setup.exe')).toMatchObject({
      arch: 'x64',
      title: 'Windows · x64'
    })
    expect(D.describe('lychee-2.0.0-arm64-setup.exe')).toMatchObject({ arch: 'arm64' })
  })
})

test.describe('which browser is on which system', () => {
  const nav = (b: { userAgent: string; platform: string; maxTouchPoints?: number }): typeof b => b

  test('a Mac stays undecided unless the browser says what chip it has', () => {
    expect(D.detectEnvironment(nav(BROWSERS.safariMac))).toEqual({ os: 'mac', arch: null })
    expect(D.detectEnvironment(nav(BROWSERS.chromeMac), null)).toEqual({ os: 'mac', arch: null })
    expect(D.detectEnvironment(nav(BROWSERS.chromeMac), { architecture: 'arm' })).toEqual({
      os: 'mac',
      arch: 'arm64'
    })
    expect(D.detectEnvironment(nav(BROWSERS.chromeMac), { architecture: 'x86' })).toEqual({
      os: 'mac',
      arch: 'x64'
    })
  })

  test('Linux says its architecture in the platform string', () => {
    expect(D.detectEnvironment(nav(BROWSERS.firefoxLinux))).toEqual({ os: 'linux', arch: 'x64' })
    expect(D.detectEnvironment(nav(BROWSERS.chromeLinuxArm))).toEqual({
      os: 'linux',
      arch: 'arm64'
    })
  })

  test('Windows, phones, tablets and Chromebooks', () => {
    expect(D.detectEnvironment(nav(BROWSERS.chromeWindows)).os).toBe('win')
    expect(D.detectEnvironment(nav(BROWSERS.iphone))).toEqual({ os: 'mobile', arch: 'arm64' })
    expect(D.detectEnvironment(nav(BROWSERS.android))).toEqual({ os: 'mobile', arch: 'arm64' }) // not Linux
    expect(D.detectEnvironment(nav(BROWSERS.ipadDesktopMode))).toEqual({
      os: 'mobile',
      arch: 'arm64'
    }) // not a Mac
    expect(D.detectEnvironment(nav(BROWSERS.chromeOs)).os).toBe('other') // not Linux
  })
})

test.describe('which download is offered', () => {
  const offered = (env: Env): string | undefined => D.build(release(), env).primary?.asset.file

  test('the right build for every system we can identify', () => {
    expect(offered({ os: 'win', arch: null })).toBe('lychee-1.0.0-rc.7-setup.exe')
    expect(offered({ os: 'mac', arch: 'arm64' })).toBe('lychee-1.0.0-rc.7-arm64.dmg')
    expect(offered({ os: 'mac', arch: 'x64' })).toBe('lychee-1.0.0-rc.7-x64.dmg')
    expect(offered({ os: 'linux', arch: 'x64' })).toBe('lychee-1.0.0-rc.7-x86_64.AppImage')
    expect(offered({ os: 'linux', arch: 'arm64' })).toBe('lychee-1.0.0-rc.7-arm64.AppImage')
  })

  test('an undecided Mac gets Apple silicon, with the Intel build one click away and a hint', () => {
    const model = D.build(release(), { os: 'mac', arch: null })
    expect(model.primary?.asset.arch).toBe('arm64')
    expect(model.alternates.map((a) => a.asset.file)).toEqual(['lychee-1.0.0-rc.7-x64.dmg'])
    expect(model.hint).toMatch(/About This Mac/)
  })

  test('a build for a detected chip is never swapped for the other one', () => {
    for (const arch of ['arm64', 'x64'] as const) {
      for (const os of ['mac', 'linux'] as const) {
        expect(D.build(release(), { os, arch }).primary?.asset.arch).toBe(arch)
      }
    }
  })

  test('Linux offers the .deb beside the AppImage, of the same architecture', () => {
    const arm = D.build(release(), { os: 'linux', arch: 'arm64' })
    expect(arm.alternates.map((a) => a.asset.file)).toEqual(['lychee_1.0.0-rc.7_arm64.deb'])
    const unknown = D.build(release(), { os: 'linux', arch: null })
    expect(unknown.alternates.map((a) => a.asset.file)).toEqual([
      'lychee_1.0.0-rc.7_amd64.deb',
      'lychee-1.0.0-rc.7-arm64.AppImage'
    ])
  })

  test('phones and other systems get no download button, and every file is still listed', () => {
    const model = D.build(release(), { os: 'mobile', arch: null })
    expect(model.primary).toBeNull()
    expect(model.desktop).toBe(false)
    expect(model.groups.flatMap((g) => g.rows)).toHaveLength(SHIPPED.length)
  })

  test('a release missing a platform leaves it out, and a Windows-only visitor still gets the installer', () => {
    const windowsOnly = release(['lychee-1.0.0-rc.7-setup.exe'])
    expect(D.build(windowsOnly, { os: 'win', arch: null }).primary?.asset.os).toBe('win')
    expect(D.build(windowsOnly, { os: 'mac', arch: null }).primary).toBeNull()
    expect(D.build(windowsOnly, { os: 'mac', arch: null }).groups.map((g) => g.os)).toEqual(['win'])
    expect(D.build({ assets: [] }, { os: 'win', arch: null }).empty).toBe(true)
  })

  test('grouped by OS, in a fixed order, one row recommended unless the CPU is a guess', () => {
    const model = D.build(release(), { os: 'linux', arch: 'x64' })
    expect(model.groups.map((g) => `${g.label}:${g.rows.length}`)).toEqual([
      'macOS:2',
      'Windows:1',
      'Linux:4'
    ])
    expect(model.groups[2].rows.map((r) => r.file)).toEqual([
      'lychee-1.0.0-rc.7-x86_64.AppImage',
      'lychee_1.0.0-rc.7_amd64.deb',
      'lychee-1.0.0-rc.7-arm64.AppImage',
      'lychee_1.0.0-rc.7_arm64.deb'
    ])
    expect(model.groups.flatMap((g) => g.rows).filter((r) => r.recommended)).toHaveLength(1)
    const guessed = D.build(release(), { os: 'mac', arch: null })
    expect(guessed.groups.flatMap((g) => g.rows).filter((r) => r.recommended)).toHaveLength(0)
    for (const group of model.groups) expect(group.notes.length).toBeGreaterThan(0)
  })

  test('release notes list every shipped file, once, under its name, and nothing else', () => {
    const files = SHIPPED.concat(NOISE).map((name) => ({
      name,
      size: 100 * 1048576,
      url: BASE + name
    }))
    const text = D.markdown(files, 'https://tame.gg/projects/lychee/')
    for (const name of SHIPPED) expect(text.split(BASE + name + ')')).toHaveLength(2)
    for (const name of NOISE) expect(text).not.toContain(name)
    expect(text).toContain('[Apple silicon]')
    expect(text).toContain('https://tame.gg/projects/lychee/#downloads')
    expect(text).not.toContain('notarized')
  })
})

// --- the page itself -----------------------------------------------------------------------
