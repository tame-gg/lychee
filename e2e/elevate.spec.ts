import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  ADMIN_ACCOUNT_MESSAGE,
  ANOTHER_TOOL_MESSAGE,
  MAC_CONTROL,
  MAC_HELPER,
  PERMISSION_MESSAGE,
  appleScriptString,
  connectOnlyLauncher,
  exitStatus,
  helperLocation,
  macAdminAppleScript,
  macAdminShellScript,
  osascriptOutcome,
  type HelperEnvironment
} from '../src/main/network/merge/elevate'

function environment(overrides: Partial<HelperEnvironment>): HelperEnvironment {
  return {
    platform: 'linux',
    arch: 'x64',
    version: '0.2.0',
    packaged: false,
    resourcesPath: '/nonexistent/resources',
    appRoot: '/nonexistent/app',
    env: {},
    ...overrides
  }
}

test.describe('helperLocation', () => {
  let root: string

  test.beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lychee-elevate-'))
  })

  test.afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('a development build uses build/netd/<os>-<arch>', () => {
    const binary = join(root, 'build', 'netd', 'linux-arm64', 'lychee-netd')
    mkdirSync(join(root, 'build', 'netd', 'linux-arm64'), { recursive: true })
    writeFileSync(binary, '', { mode: 0o755 })
    expect(helperLocation(environment({ arch: 'arm64', appRoot: root }))).toEqual({
      binary,
      bundled: binary
    })
    expect(helperLocation(environment({ arch: 'x64', appRoot: root }))).toMatchObject({
      kind: 'failed',
      status: 'unsupported'
    })
  })

  test('a packaged Linux build prefers the system copy, then resources/helper', () => {
    const packaged = join(root, 'resources', 'helper', 'lychee-netd')
    mkdirSync(join(root, 'resources', 'helper'), { recursive: true })
    writeFileSync(packaged, '', { mode: 0o755 })
    const env = environment({ packaged: true, resourcesPath: join(root, 'resources') })
    expect(helperLocation(env)).toEqual({ binary: packaged, bundled: packaged })
  })

  test('a Linux helper this user may not execute is passed over', () => {
    const packaged = join(root, 'resources', 'helper', 'lychee-netd')
    mkdirSync(join(root, 'resources', 'helper'), { recursive: true })
    writeFileSync(packaged, '', { mode: 0o644 })
    const env = environment({ packaged: true, resourcesPath: join(root, 'resources') })
    expect(helperLocation(env)).toMatchObject({ kind: 'failed', status: 'unsupported' })
    chmodSync(packaged, 0o750)
    expect(helperLocation(env)).toEqual({ binary: packaged, bundled: packaged })
  })

  test('Windows on ARM and a build without the helper are unsupported', () => {
    expect(helperLocation(environment({ platform: 'win32', arch: 'arm64' }))).toMatchObject({
      kind: 'failed',
      status: 'unsupported',
      message: expect.stringContaining('Windows on ARM')
    })
    expect(
      helperLocation(environment({ platform: 'win32', packaged: true, resourcesPath: root }))
    ).toMatchObject({ kind: 'failed', status: 'unsupported' })
    const binary = join(root, 'build', 'netd', 'win-x64', 'lychee-netd.exe')
    mkdirSync(join(root, 'build', 'netd', 'win-x64'), { recursive: true })
    writeFileSync(binary, '')
    expect(helperLocation(environment({ platform: 'win32', appRoot: root }))).toEqual({ binary })
  })

  test('macOS installs the bundled helper to the root-owned path', () => {
    expect(helperLocation(environment({ platform: 'darwin' }))).toMatchObject({
      kind: 'failed',
      status: 'unsupported'
    })
    const bundled = join(root, 'resources', 'helper', 'lychee-netd')
    mkdirSync(join(root, 'resources', 'helper'), { recursive: true })
    writeFileSync(bundled, '')
    expect(
      helperLocation(
        environment({ platform: 'darwin', packaged: true, resourcesPath: join(root, 'resources') })
      )
    ).toEqual({ binary: MAC_HELPER, bundled })
  })

  test('other platforms are unsupported', () => {
    expect(helperLocation(environment({ platform: 'freebsd' }))).toMatchObject({
      kind: 'failed',
      status: 'unsupported'
    })
  })
})

test.describe('exitStatus', () => {
  const exit = (code: number | null): { code: number | null; signal: null } => ({
    code,
    signal: null
  })

  test('maps the helper exit codes of spec section 2.7', () => {
    expect(exitStatus(exit(2), 'usage: lychee-netd serve --control <path>\n', 'linux')).toEqual({
      status: 'unavailable',
      message: 'usage: lychee-netd serve --control <path>'
    })
    expect(exitStatus(exit(3), 'error: the network helper needs root\n', 'linux')).toEqual({
      status: 'not_installed',
      message: 'the network helper needs root'
    })
    expect(exitStatus(exit(4), '', 'linux')).toEqual({
      status: 'another_tool',
      message: ANOTHER_TOOL_MESSAGE
    })
    expect(exitStatus(exit(5), 'bind: address already in use\n', 'win32').status).toBe(
      'unavailable'
    )
    expect(exitStatus(exit(6), 'needs_admin: not elevated\n', 'win32')).toEqual({
      status: 'needs_admin',
      message: ADMIN_ACCOUNT_MESSAGE
    })
  })

  test('maps declined elevation prompts to needs_permission', () => {
    for (const code of [126, 127, 1223]) {
      expect(exitStatus(exit(code), '', 'linux').status).toBe('needs_permission')
    }
    expect(exitStatus(exit(-128), 'User canceled.', 'darwin')).toEqual({
      status: 'needs_permission',
      message: PERMISSION_MESSAGE
    })
    expect(exitStatus(exit(1), 'sudo: a password is required\n', 'darwin')).toEqual({
      status: 'not_installed',
      message: 'sudo: a password is required'
    })
    expect(exitStatus(exit(1), 'route add: something broke\n', 'darwin')).toEqual({
      status: 'unavailable',
      message: 'route add: something broke'
    })
    expect(exitStatus(exit(1), '', 'linux')).toEqual({
      status: 'unavailable',
      message: 'the network helper exited with code 1'
    })
  })

  test('uses the last meaningful stderr line, never the listening line', () => {
    expect(
      exitStatus(exit(null), 'listening on /run/lychee-netd/netd.sock\n\n', 'linux').message
    ).toBe('the network helper could not be started')
    expect(exitStatus({ code: null, signal: 'SIGKILL' }, '', 'linux').message).toBe(
      'the network helper was stopped by SIGKILL'
    )
    const long = 'x'.repeat(300)
    expect(exitStatus(exit(5), `first\nerror:   ${long}\n`, 'linux').message).toBe(
      long.slice(0, 200)
    )
  })
})

test('connectOnlyLauncher only names the control path', async () => {
  const result = await connectOnlyLauncher('/tmp/netd.sock').launch()
  expect(result).toMatchObject({ kind: 'launched', path: '/tmp/netd.sock' })
  if (result.kind !== 'launched') throw new Error('unreachable')
  expect(result.process.exit).toBeNull()
  expect(result.process.pid).toBeNull()
  expect(result.verify).toBeUndefined()
  result.process.kill()
})

test.describe('macOS administrator prompt', () => {
  test('the shell script installs a root-owned copy only when asked, then runs it for the user', () => {
    const install = macAdminShellScript({
      bundled: "/Applications/Lychee's Apps/Lychee.app/Contents/Resources/helper/lychee-netd",
      install: true,
      uid: 501
    })
    expect(install.split('; ')).toEqual([
      'set -e',
      "/bin/mkdir -p '/Library/PrivilegedHelperTools'",
      "/usr/sbin/chown root:wheel '/Library/PrivilegedHelperTools'",
      "/bin/chmod 755 '/Library/PrivilegedHelperTools'",
      `/bin/cp '/Applications/Lychee'\\''s Apps/Lychee.app/Contents/Resources/helper/lychee-netd' '${MAC_HELPER}.tmp'`,
      `/usr/sbin/chown root:wheel '${MAC_HELPER}.tmp'`,
      `/bin/chmod 755 '${MAC_HELPER}.tmp'`,
      `/bin/mv -f '${MAC_HELPER}.tmp' '${MAC_HELPER}'`,
      `exec /usr/bin/env SUDO_UID=501 '${MAC_HELPER}' serve --control '${MAC_CONTROL}'`
    ])
    const launchOnly = macAdminShellScript({ bundled: '/x/lychee-netd', install: false, uid: 502 })
    expect(launchOnly).toBe(
      `set -e; exec /usr/bin/env SUDO_UID=502 '${MAC_HELPER}' serve --control '${MAC_CONTROL}'`
    )
    expect(launchOnly).not.toContain('/x/lychee-netd')
  })

  test('the AppleScript quotes the shell script and asks with administrator privileges', () => {
    expect(appleScriptString('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"')
    const script = macAdminAppleScript("echo 'a'")
    expect(script).toBe(
      'do shell script "echo \'a\'" with administrator privileges with prompt "Lychee needs an administrator password to combine your connections."'
    )
  })

  test('the helper exit status is read back from osascript', () => {
    const one = { code: 1, signal: null }
    expect(osascriptOutcome(one, '32:120: execution error: User canceled. (-128)\n')).toEqual({
      exit: { code: -128, signal: null },
      stderr: 'User canceled.'
    })
    expect(
      osascriptOutcome(one, 'execution error: error: the network helper must run as root (3)')
    ).toEqual({
      exit: { code: 3, signal: null },
      stderr: 'error: the network helper must run as root'
    })
    expect(
      osascriptOutcome(one, 'execution error: The command exited with a non-zero status. (4)')
    ).toEqual({
      exit: { code: 4, signal: null },
      stderr: 'The command exited with a non-zero status.'
    })
    expect(osascriptOutcome({ code: 0, signal: null }, '')).toEqual({
      exit: { code: 0, signal: null },
      stderr: ''
    })
    expect(osascriptOutcome(one, 'something else entirely')).toEqual({
      exit: one,
      stderr: 'something else entirely'
    })
  })
})
