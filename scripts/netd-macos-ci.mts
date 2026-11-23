import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAC_CONTROL,
  MAC_HELPER,
  MAC_LAUNCH_ARGS,
  MAC_SUDOERS,
  macRootOwnedCopyLines,
  macSudoersContent
} from '../src/main/network/merge/macInstall.ts'
import { controlHandshake } from './netd-handshake.mts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundled = join(root, 'build', 'netd', 'mac-arm64', 'lychee-netd')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
const handshake = fileURLToPath(new URL('./netd-handshake.mts', import.meta.url))
const PROBE_USER = 'lycheetest'
const PROBE_SUDOERS = '/etc/sudoers.d/lychee-netd-probe'

function pass(message: string): void {
  console.log(`PASS  ${message}`)
}

function proveExactRule(): void {
  execFileSync('sudo', ['-n', 'dscl', '.', '-create', `/Users/${PROBE_USER}`])
  for (const [key, value] of [
    ['UserShell', '/bin/bash'],
    ['UniqueID', '550'],
    ['PrimaryGroupID', '20'],
    ['NFSHomeDirectory', '/var/empty']
  ] as const) {
    execFileSync('sudo', ['-n', 'dscl', '.', '-create', `/Users/${PROBE_USER}`, key, value])
  }
  const probe = macSudoersContent(PROBE_USER)
  const dir = mkdtempSync(join(tmpdir(), 'lychee-sudoers-probe-'))
  const tmp = join(dir, 'lychee-netd-probe')
  writeFileSync(tmp, probe)
  sudo(['visudo', '-cf', tmp])
  sudo(['install', '-o', 'root', '-g', 'wheel', '-m', '0440', tmp, PROBE_SUDOERS])
  rmSync(dir, { recursive: true, force: true })
  const allowed = spawnSync(
    'sudo',
    ['-n', '-u', PROBE_USER, 'sudo', '-n', '-l', MAC_HELPER, ...MAC_LAUNCH_ARGS],
    {
      encoding: 'utf8'
    }
  )
  if (allowed.status !== 0) {
    throw new Error(`an account with only this rule rejected the exact launch\n${allowed.stderr}`)
  }
  const refusedVersion = spawnSync(
    'sudo',
    ['-n', '-u', PROBE_USER, 'sudo', '-n', '-l', MAC_HELPER, 'version'],
    {
      encoding: 'utf8'
    }
  )
  if (refusedVersion.status === 0) throw new Error('the exact rule accepted version')
  const refusedPath = spawnSync(
    'sudo',
    ['-n', '-u', PROBE_USER, 'sudo', '-n', '-l', MAC_HELPER, 'serve', '--control', '/tmp/x.sock'],
    { encoding: 'utf8' }
  )
  if (refusedPath.status === 0) throw new Error('the exact rule accepted a different control path')
  pass('a user with only this rule is limited to the exact launch')
}

function sudo(args: string[], input?: string): string {
  return execFileSync('sudo', ['-n', ...args], {
    encoding: 'utf8',
    input,
    stdio: input === undefined ? 'inherit' : ['pipe', 'pipe', 'pipe']
  })
}

function posixMode(path: string): string {
  const text = execFileSync('sudo', ['-n', 'stat', '-f', '%u %g %Lp', path], { encoding: 'utf8' })
  const [uid, gid, bits] = text.trim().split(/\s+/)
  return `${uid}:${gid}:${Number.parseInt(bits, 8).toString(8)}`
}

async function waitForSocket(child: ChildProcess, stderr: { text: string }): Promise<void> {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`helper exited ${child.exitCode} before the socket existed\n${stderr.text}`)
    }
    try {
      if (statSync(MAC_CONTROL).isSocket()) return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`control socket was not created\n${stderr.text}`)
}

async function main(): Promise<void> {
  const user = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim()
  const uid = Number(execFileSync('id', ['-u'], { encoding: 'utf8' }).trim())
  const content = macSudoersContent(user)
  const stderr = { text: '' }
  let child: ChildProcess | null = null
  const cleanup = (): void => {
    const found = spawnSync('pgrep', ['-f', 'PrivilegedHelperTools/gg.tame.lychee.netd'], {
      encoding: 'utf8'
    })
    const pids = new Set<string>()
    if (child?.pid) pids.add(String(child.pid))
    if (found.status === 0) {
      for (const pid of found.stdout.trim().split('\n')) if (pid) pids.add(pid)
    }
    for (const pid of pids) spawnSync('sudo', ['-n', 'kill', pid])
    spawnSync('sleep', ['0.5'])
    spawnSync('sudo', [
      '-n',
      'rm',
      '-f',
      MAC_SUDOERS,
      PROBE_SUDOERS,
      MAC_HELPER,
      '/var/run/lychee-netd.lock'
    ])
    spawnSync('sudo', ['-n', 'rm', '-rf', '/var/run/lychee-netd'])
    spawnSync('sudo', ['-n', 'dscl', '.', '-delete', `/Users/${PROBE_USER}`])
  }

  try {
    const script = ['set -e', ...macRootOwnedCopyLines(bundled)].join('\n')
    execFileSync('sudo', ['-n', '/bin/bash', '-c', script], { stdio: 'inherit' })
    if (posixMode(MAC_HELPER) !== '0:0:755') {
      throw new Error(`helper is ${posixMode(MAC_HELPER)}, want root:wheel mode 0755`)
    }
    pass('root-owned helper copy at /Library/PrivilegedHelperTools')

    const dir = mkdtempSync(join(tmpdir(), 'lychee-sudoers-'))
    const tmp = join(dir, 'lychee-netd')
    writeFileSync(tmp, content)
    sudo(['visudo', '-cf', tmp])
    pass('visudo -cf accepts the generated rule')
    sudo(['install', '-o', 'root', '-g', 'wheel', '-m', '0440', tmp, MAC_SUDOERS])
    rmSync(dir, { recursive: true, force: true })
    const installed = execFileSync('sudo', ['-n', 'cat', MAC_SUDOERS], { encoding: 'utf8' })
    if (installed !== content) {
      throw new Error(
        `sudoers bytes differ\n--- installed ---\n${installed}\n--- expected ---\n${content}`
      )
    }
    if (posixMode(MAC_SUDOERS) !== '0:0:440') {
      throw new Error(`sudoers is ${posixMode(MAC_SUDOERS)}, want root:wheel mode 0440`)
    }
    sudo(['visudo', '-cf', MAC_SUDOERS])
    pass('installed sudoers matches macSudoersContent byte for byte')

    sudo(['-l', MAC_HELPER, ...MAC_LAUNCH_ARGS])
    pass('sudo -n accepts the exact launch')
    proveExactRule()

    child = spawn('sudo', ['-n', MAC_HELPER, ...MAC_LAUNCH_ARGS], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.text += chunk.toString('utf8')
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      stderr.text += chunk.toString('utf8')
    })
    await waitForSocket(child, stderr)
    pass('sudo -n launched the helper and it created the control socket')

    const hello = await controlHandshake(MAC_CONTROL, 8000)
    if (!hello?.message.ok || !hello.message.result) throw new Error(hello?.raw ?? stderr.text)
    const result = hello.message.result
    if (result.protocol !== 1) throw new Error(`protocol ${result.protocol}`)
    if (result.helper_version !== version) {
      throw new Error(`helper_version ${result.helper_version}, build ${version}`)
    }
    if (result.auth?.model !== 'unix_peer_uid' || result.auth.authorized_uid !== uid) {
      throw new Error(`auth ${JSON.stringify(result.auth)}, uid ${uid}`)
    }
    pass(`version handshake helper_version ${result.helper_version} authorized_uid ${uid}`)

    const rootHello = spawnSync(
      'sudo',
      ['-n', process.execPath, '--experimental-strip-types', handshake, '--handshake', MAC_CONTROL],
      { encoding: 'utf8' }
    )
    if (rootHello.status !== 2) {
      throw new Error(
        `a root client was not refused (status ${rootHello.status})\n${rootHello.stdout}\n${rootHello.stderr}`
      )
    }
    pass('a different uid (root) is refused on the control socket')
  } finally {
    cleanup()
  }

  if (statExists(MAC_HELPER) || statExists(MAC_SUDOERS) || statExists('/var/run/lychee-netd')) {
    throw new Error('the helper, sudoers file, or runtime directory is still installed')
  }
  pass('helper, sudoers file, and runtime directory are removed')
}

function statExists(path: string): boolean {
  const probe = spawnSync('sudo', ['-n', 'test', '-e', path])
  return probe.status === 0
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  spawnSync('sudo', ['-n', 'rm', '-f', MAC_SUDOERS, MAC_HELPER, '/var/run/lychee-netd.lock'])
  spawnSync('sudo', ['-n', 'rm', '-rf', '/var/run/lychee-netd'])
  process.exit(1)
})
