import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Cross-compiles native/netd into build/netd/<electron-builder os>-<arch>/ for every packaged
// target, with no cgo so the binaries carry no host dependency. The output directory names use
// electron-builder's ${os}-${arch} vocabulary so extraResources can copy them directly (L-2).

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const netdDir = join(root, 'native', 'netd')
const outRoot = join(root, 'build', 'netd')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Each target maps a Go GOOS/GOARCH to electron-builder's directory name.
const targets = [
  { goos: 'linux', goarch: 'amd64', dir: 'linux-x64' },
  { goos: 'linux', goarch: 'arm64', dir: 'linux-arm64' },
  { goos: 'darwin', goarch: 'amd64', dir: 'mac-x64' },
  { goos: 'darwin', goarch: 'arm64', dir: 'mac-arm64' },
  { goos: 'windows', goarch: 'amd64', dir: 'win-x64' }
]

const requested = parseTargets(process.argv.slice(2))
const known = [...targets.map((t) => t.dir), 'win-arm64']
if (requested && !known.some((dir) => requested.has(dir))) {
  console.error(`No matching --target; known targets: ${known.join(', ')}`)
  process.exit(1)
}
const selected = requested ? targets.filter((t) => requested.has(t.dir)) : targets

for (const t of selected) {
  const outDir = join(outRoot, t.dir)
  mkdirSync(outDir, { recursive: true })
  const binary = t.goos === 'windows' ? 'lychee-netd.exe' : 'lychee-netd'
  const outPath = join(outDir, binary)
  console.log(`building ${t.goos}/${t.goarch} -> build/netd/${t.dir}/${binary}`)
  execFileSync(
    'go',
    [
      'build',
      '-trimpath',
      '-buildvcs=false',
      '-ldflags',
      `-s -w -X main.version=${version}`,
      '-o',
      outPath,
      './cmd/lychee-netd'
    ],
    {
      cwd: netdDir,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0', GOOS: t.goos, GOARCH: t.goarch }
    }
  )
  if (t.dir === 'win-x64') {
    ensureWintun(outDir, requested !== null)
  }
}

// Windows arm64 ships without the helper for now (amd64 only). A well-defined empty helper folder
// with an UNSUPPORTED marker lets the app show "Unsupported here" instead of failing at launch.
if (!requested || requested.has('win-arm64')) {
  const armDir = join(outRoot, 'win-arm64')
  mkdirSync(armDir, { recursive: true })
  rmSync(join(armDir, 'lychee-netd.exe'), { force: true })
  writeFileSync(
    join(armDir, 'UNSUPPORTED'),
    'lychee-netd is not built for Windows arm64 yet; the Network page shows "Unsupported here".\n'
  )
}

console.log('build-netd: done')

function parseTargets(argv) {
  const out = new Set()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') {
      const v = argv[++i]
      if (v) v.split(',').forEach((x) => out.add(x.trim()))
    } else if (a.startsWith('--target=')) {
      a.slice('--target='.length)
        .split(',')
        .forEach((x) => out.add(x.trim()))
    } else if (a === '--host') {
      out.add(hostTarget())
    }
  }
  return out.size ? out : null
}

function hostTarget() {
  const os = { linux: 'linux', darwin: 'mac', win32: 'win' }[process.platform]
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (!os) {
    console.error(`lychee-netd has no build for ${process.platform}`)
    process.exit(1)
  }
  return `${os}-${arch}`
}

// Wintun is fetched and verified in L-2 (scripts/fetch-wintun.mjs).
function ensureWintun(outDir, required) {
  const fetch = join(root, 'scripts', 'fetch-wintun.mjs')
  if (existsSync(fetch)) {
    execFileSync('node', [fetch, '--out', outDir], { cwd: root, stdio: 'inherit' })
  }
  const dll = join(outDir, 'wintun.dll')
  if (existsSync(dll)) return
  const reason = `${dll} is missing; a Windows helper cannot ship without Wintun (scripts/fetch-wintun.mjs has not landed, and no wintun.dll was placed there by hand)`
  if (!required) {
    console.warn(`build-netd: warning: ${reason}; the win-x64 helper is incomplete`)
    return
  }
  console.error(`build-netd: ${reason}`)
  process.exit(1)
}
