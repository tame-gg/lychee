import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch } from 'electron-builder'
import { netdBinaryName, netdTarget } from './netd-target.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const ELF_MACHINE = { x64: 0x3e, arm64: 0xb7 }
const MACHO_CPUTYPE = { x64: 0x01000007, arm64: 0x0100000c }
const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 }

export default async function checkNetdPackage(context) {
  const platform = context.electronPlatformName
  const arch = Arch[context.arch]
  const target = netdTarget(platform, arch)
  const helperDir = join(context.packager.getResourcesDir(context.appOutDir), 'helper')
  if (!existsSync(helperDir)) throw new Error(`Packaged app has no ${helperDir}`)
  const entries = readdirSync(helperDir)
  const binary = join(helperDir, netdBinaryName(platform))

  if (target === 'win-arm64') {
    if (existsSync(binary)) throw new Error(`${binary} must not ship on Windows arm64 yet`)
    if (!entries.includes('UNSUPPORTED'))
      throw new Error(`${helperDir} lacks the UNSUPPORTED marker`)
    return
  }

  if (!existsSync(binary)) throw new Error(`Packaged app lacks the network helper ${binary}`)
  const mode = statSync(binary).mode
  if (platform !== 'win32' && (mode & 0o111) !== 0o111) {
    throw new Error(`${binary} is not executable by everyone (mode ${(mode & 0o777).toString(8)})`)
  }
  checkHeader(binary, platform, arch)
  checkGoBuild(binary, platform, arch)
  checkVersion(binary, platform, arch)
  if (target === 'win-x64') {
    for (const file of ['wintun.dll', 'wintun-LICENSE.txt']) {
      if (!entries.includes(file))
        console.warn(`warning: ${helperDir} lacks ${file} (fetch-wintun.mjs has not landed yet)`)
    }
  }
}

function checkHeader(binary, platform, arch) {
  const header = Buffer.alloc(64)
  const fd = openSync(binary)
  try {
    readSync(fd, header, 0, 64, 0)
  } finally {
    closeSync(fd)
  }
  if (platform === 'linux') {
    if (header.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${binary} is not an ELF binary`)
    const machine = header.readUInt16LE(18)
    if (machine !== ELF_MACHINE[arch]) {
      throw new Error(`${binary} is ELF machine 0x${machine.toString(16)}, expected ${arch}`)
    }
    return
  }
  if (platform === 'darwin' || platform === 'mas') {
    const magic = header.readUInt32LE(0)
    if (magic !== 0xfeedfacf) throw new Error(`${binary} is not a 64-bit Mach-O binary`)
    const cputype = header.readUInt32LE(4)
    if (cputype !== MACHO_CPUTYPE[arch]) {
      throw new Error(`${binary} is Mach-O cputype 0x${cputype.toString(16)}, expected ${arch}`)
    }
    return
  }
  if (platform === 'win32') {
    if (header.readUInt16LE(0) !== 0x5a4d) throw new Error(`${binary} is not a PE binary`)
    const peOffset = header.readUInt32LE(60)
    const pe = Buffer.alloc(6)
    const fd2 = openSync(binary)
    try {
      readSync(fd2, pe, 0, 6, peOffset)
    } finally {
      closeSync(fd2)
    }
    if (pe.readUInt32LE(0) !== 0x00004550) throw new Error(`${binary} has no PE signature`)
    const machine = pe.readUInt16LE(4)
    if (machine !== PE_MACHINE[arch]) {
      throw new Error(`${binary} is PE machine 0x${machine.toString(16)}, expected ${arch}`)
    }
  }
}

function checkGoBuild(binary, platform, arch) {
  let info
  try {
    info = execFileSync('go', ['version', '-m', binary], { encoding: 'utf8' })
  } catch (error) {
    throw new Error(`go version -m ${binary} failed: ${error.message}`)
  }
  if (!/^\s*build\s+CGO_ENABLED=0$/m.test(info)) throw new Error(`${binary} was built with cgo`)
  const goos = /^\s*build\s+GOOS=(\S+)$/m.exec(info)?.[1]
  const goarch = /^\s*build\s+GOARCH=(\S+)$/m.exec(info)?.[1]
  const wantOs = platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : 'darwin'
  const wantArch = arch === 'arm64' ? 'arm64' : 'amd64'
  if (goos !== wantOs || goarch !== wantArch) {
    throw new Error(`${binary} was built for ${goos}/${goarch}, expected ${wantOs}/${wantArch}`)
  }
  if (/fyne\.io\/systray/.test(info)) throw new Error(`${binary} links fyne.io/systray`)
}

function checkVersion(binary, platform, arch) {
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const runnable =
    (platform === 'win32' ? 'win32' : platform === 'linux' ? 'linux' : 'darwin') ===
      process.platform && arch === hostArch
  if (runnable) {
    const stdout = execFileSync(binary, ['version'], { encoding: 'utf8', timeout: 10000 })
    const built = /lychee-netd\s+(\S+)/.exec(stdout)?.[1]
    if (built !== version) {
      throw new Error(`${binary} reports version ${built}, package.json says ${version}`)
    }
    return
  }
  if (!readFileSync(binary).includes(Buffer.from(version))) {
    throw new Error(`${binary} does not carry version ${version}`)
  }
}
