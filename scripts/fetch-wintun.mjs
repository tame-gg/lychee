import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const WINTUN_VERSION = '0.14.1'
export const WINTUN_ZIP_URL = `https://www.wintun.net/builds/wintun-${WINTUN_VERSION}.zip`
export const WINTUN_ZIP_SHA256 = '07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51'
export const WINTUN_DLL_SHA256 = {
  amd64: 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce',
  arm64: 'f7ba89005544be9d85231a9e0d5f23b2d15b3311667e2dad0debd344918a3f80'
}

const ZIP_ENTRY = {
  amd64: 'wintun/bin/amd64/wintun.dll',
  arm64: 'wintun/bin/arm64/wintun.dll'
}
const LICENSE_ENTRY = 'wintun/LICENSE.txt'
const MAX_ZIP_BYTES = 4 * 1024 * 1024
const referenceLicense = join(root, 'build', 'licenses', 'wintun-LICENSE.txt')
const zipCache = join(root, 'build', 'netd', '.cache', `wintun-${WINTUN_VERSION}.zip`)

export function assertSha256(bytes, expected, label) {
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== expected) {
    throw new Error(`${label} SHA-256 mismatch:\n  expected ${expected}\n  got      ${got}`)
  }
  return got
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
}

function archFromOut(outDir) {
  const base = basename(outDir)
  if (base === 'win-x64') return 'amd64'
  if (base === 'win-arm64') return 'arm64'
  throw new Error(`${outDir} is not win-x64 or win-arm64; pass --arch amd64 or --arch arm64`)
}

function defaultOut(arch) {
  if (arch === 'amd64') return join(root, 'build', 'netd', 'win-x64')
  if (arch === 'arm64') return join(root, 'build', 'netd', 'win-arm64')
  throw new Error(`unknown Wintun arch ${arch}; expected amd64 or arm64`)
}

function targetsFromArgs(argv) {
  let out = null
  const archs = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') {
      out = argv[++i]
      if (!out) throw new Error('--out needs a directory')
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length)
    } else if (arg === '--arch') {
      const value = argv[++i]
      if (!value) throw new Error('--arch needs amd64 or arm64')
      archs.push(
        ...value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      )
    } else if (arg.startsWith('--arch=')) {
      archs.push(
        ...arg
          .slice('--arch='.length)
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      )
    } else {
      throw new Error(`unknown argument ${arg}`)
    }
  }
  for (const arch of archs) {
    if (!ZIP_ENTRY[arch]) throw new Error(`unknown Wintun arch ${arch}; expected amd64 or arm64`)
  }
  if (out && archs.length > 1) throw new Error('--out takes a single --arch')
  if (out) return [{ arch: archs[0] || archFromOut(out), outDir: out }]
  if (archs.length) return archs.map((arch) => ({ arch, outDir: defaultOut(arch) }))
  return [{ arch: 'amd64', outDir: defaultOut('amd64') }]
}

function eocdOffset(buf) {
  const start = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue
    const commentLen = buf.readUInt16LE(i + 20)
    if (i + 22 + commentLen === buf.length) return i
  }
  throw new Error('Wintun zip has no end-of-central-directory record')
}

function openZip(buf) {
  const eocd = eocdOffset(buf)
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw new Error('Wintun zip spans multiple disks')
  }
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('Wintun zip uses ZIP64, which this fetch does not read')
  }
  const entries = new Map()
  let pos = cdOffset
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('Wintun zip has a bad central directory')
    }
    const method = buf.readUInt16LE(pos + 10)
    const compSize = buf.readUInt32LE(pos + 20)
    const uncompSize = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    entries.set(name, { method, compSize, uncompSize, localOffset })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return {
    file(name) {
      const entry = entries.get(name)
      if (!entry) throw new Error(`Wintun zip is missing ${name}`)
      return inflateEntry(buf, name, entry)
    }
  }
}

function inflateEntry(buf, name, entry) {
  const local = entry.localOffset
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) {
    throw new Error(`Wintun zip has a bad local header for ${name}`)
  }
  const flags = buf.readUInt16LE(local + 6)
  const method = buf.readUInt16LE(local + 8)
  let compSize = buf.readUInt32LE(local + 18)
  let uncompSize = buf.readUInt32LE(local + 22)
  const nameLen = buf.readUInt16LE(local + 26)
  const extraLen = buf.readUInt16LE(local + 28)
  if (method !== entry.method) throw new Error(`Wintun zip method mismatch for ${name}`)
  if (flags & 0x08) {
    compSize = entry.compSize
    uncompSize = entry.uncompSize
  } else if (compSize !== entry.compSize || uncompSize !== entry.uncompSize) {
    throw new Error(`Wintun zip size mismatch for ${name}`)
  }
  const start = local + 30 + nameLen + extraLen
  const end = start + compSize
  if (end > buf.length) throw new Error(`Wintun zip is truncated at ${name}`)
  const compressed = buf.subarray(start, end)
  const data =
    method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : null
  if (!data) throw new Error(`Wintun zip method ${method} is unsupported for ${name}`)
  if (data.length !== uncompSize) throw new Error(`Wintun zip inflated size mismatch for ${name}`)
  return data
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
  }
  const host = new URL(response.url).hostname
  if (host !== 'www.wintun.net' && host !== 'wintun.net') {
    throw new Error(`Wintun download redirected to ${response.url}`)
  }
  if (!response.body) throw new Error(`GET ${url} returned an empty body`)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_ZIP_BYTES) {
      await reader.cancel()
      throw new Error(`Wintun zip from ${url} exceeds ${MAX_ZIP_BYTES} bytes`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

async function loadZip() {
  if (existsSync(zipCache)) {
    const cached = readFileSync(zipCache)
    const got = createHash('sha256').update(cached).digest('hex')
    if (got === WINTUN_ZIP_SHA256) {
      console.log(`fetch-wintun: cached ${zipCache} matches ${WINTUN_ZIP_SHA256}`)
      return cached
    }
    console.error(
      `fetch-wintun: cached zip SHA-256 mismatch:\n  expected ${WINTUN_ZIP_SHA256}\n  got      ${got}\nre-downloading ${WINTUN_ZIP_URL}`
    )
  }
  console.log(`fetch-wintun: downloading ${WINTUN_ZIP_URL}`)
  const bytes = await download(WINTUN_ZIP_URL)
  assertSha256(bytes, WINTUN_ZIP_SHA256, `downloaded ${WINTUN_ZIP_URL}`)
  mkdirSync(dirname(zipCache), { recursive: true })
  writeFileSync(zipCache, bytes)
  console.log(`fetch-wintun: ${WINTUN_ZIP_URL} SHA-256 ${WINTUN_ZIP_SHA256} ok`)
  return bytes
}

function alreadyGood(outDir, arch) {
  const dllPath = join(outDir, 'wintun.dll')
  const licensePath = join(outDir, 'wintun-LICENSE.txt')
  if (!existsSync(dllPath) || !existsSync(licensePath) || !existsSync(referenceLicense))
    return false
  const got = createHash('sha256').update(readFileSync(dllPath)).digest('hex')
  if (got !== WINTUN_DLL_SHA256[arch]) return false
  return readFileSync(licensePath).equals(readFileSync(referenceLicense))
}

function place(outDir, arch, zip) {
  const entry = ZIP_ENTRY[arch]
  const expected = WINTUN_DLL_SHA256[arch]
  const dll = zip.file(entry)
  assertSha256(dll, expected, entry)
  if (!existsSync(referenceLicense))
    throw new Error(`missing reference license ${referenceLicense}`)
  const license = zip.file(LICENSE_ENTRY)
  const reference = readFileSync(referenceLicense)
  if (!license.equals(reference)) {
    throw new Error(`Wintun ${LICENSE_ENTRY} does not match the reference copy ${referenceLicense}`)
  }
  mkdirSync(outDir, { recursive: true })
  const dllPath = join(outDir, 'wintun.dll')
  const licensePath = join(outDir, 'wintun-LICENSE.txt')
  writeFileSync(dllPath, dll)
  writeFileSync(licensePath, license)
  assertAuthenticode(dllPath)
  console.log(`fetch-wintun: wrote ${dllPath} (${arch} SHA-256 ${expected})`)
  console.log(`fetch-wintun: wrote ${licensePath}`)
}

function assertAuthenticode(dllPath) {
  if (process.platform !== 'win32') return
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$sig = Get-AuthenticodeSignature -LiteralPath $env:WINTUN_DLL',
    'if ($sig.Status -ne \'Valid\') { throw "Authenticode status is $($sig.Status) for $env:WINTUN_DLL" }',
    '$subject = [string]$sig.SignerCertificate.Subject',
    "if ($subject -notlike '*WireGuard LLC*') { throw \"Authenticode signer is '$subject', expected WireGuard LLC\" }",
    'Write-Output $subject'
  ].join('\n')
  const subject = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      encoding: 'utf8',
      env: { ...process.env, WINTUN_DLL: dllPath },
      windowsHide: true
    }
  ).trim()
  console.log(`fetch-wintun: Authenticode status Valid (${subject})`)
}

async function main() {
  const targets = targetsFromArgs(process.argv.slice(2))
  const pending = []
  for (const target of targets) {
    const dllPath = join(target.outDir, 'wintun.dll')
    if (alreadyGood(target.outDir, target.arch)) {
      assertAuthenticode(dllPath)
      console.log(
        `fetch-wintun: ${dllPath} matches ${WINTUN_DLL_SHA256[target.arch]}; skipping download`
      )
      continue
    }
    pending.push(target)
  }
  if (!pending.length) return
  const zip = openZip(await loadZip())
  for (const target of pending) place(target.outDir, target.arch, zip)
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`fetch-wintun: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  })
}
