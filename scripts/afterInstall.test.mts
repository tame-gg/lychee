import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const template = readFileSync(join(root, 'build', 'linux', 'after-install.sh'), 'utf8')
const macros: Record<string, string> = { executable: 'lychee', sanitizedProductName: 'Lychee' }
const skip =
  process.platform !== 'linux'
    ? 'the install script runs on Linux'
    : spawnSync('fakeroot', ['--version']).status === 0
      ? false
      : 'fakeroot is not installed'

function render(source: string): string {
  return source.replace(/\${([a-zA-Z]+)}/g, (_match, name: string) => {
    if (!(name in macros)) throw new Error(`Macro ${name} is not defined`)
    return macros[name]
  })
}

interface Scenario {
  group?: string
  passwd?: string[]
  env?: Record<string, string>
  loginDefs?: string
  failing?: string[]
  source?: boolean
  installed?: string
}

interface Outcome {
  stdout: string
  stderr: string
  status: number | null
  calls: string[]
  group: string
  stat: string[]
  target: string | null
  tmpLeft: boolean
  dir: string
}

const stubs: Record<string, string> = {
  getent: `
case $1 in
  group) awk -F: -v g="$2" '$1 == g { print; found = 1 } END { exit found ? 0 : 2 }' "$STATE/group" ;;
  passwd) awk -F: -v u="$2" '$3 == u { print; found = 1 } END { exit found ? 0 : 2 }' "$STATE/passwd" ;;
  *) exit 1 ;;
esac
`,
  groupadd: `
echo "groupadd $*" >> "$STATE/calls"
if [ -e "$STATE/groupadd-fails" ]; then echo 'groupadd: cannot lock /etc/group' >&2; exit 10; fi
echo "$2:x:987:" >> "$STATE/group"
`,
  gpasswd: `
echo "gpasswd $*" >> "$STATE/calls"
if [ -e "$STATE/gpasswd-fails" ]; then echo 'gpasswd: cannot lock /etc/group' >&2; exit 1; fi
awk -F: -v g="$3" -v u="$2" 'BEGIN { OFS = ":" } $1 == g { $4 = ($4 == "" ? u : $4 "," u) } { print }' "$STATE/group" > "$STATE/group.new"
mv "$STATE/group.new" "$STATE/group"
echo "Adding user $2 to group $3"
`,
  setcap: `
echo "setcap $*" >> "$STATE/calls"
if [ -e "$STATE/setcap-fails" ]; then echo 'Failed to set capabilities' >&2; exit 1; fi
`,
  'update-alternatives': 'echo "update-alternatives $*" >> "$STATE/calls"\n',
  'update-mime-database': 'echo "update-mime-database $*" >> "$STATE/calls"\n',
  'update-desktop-database': 'echo "update-desktop-database $*" >> "$STATE/calls"\n',
  apparmor_status: 'echo "apparmor_status $*" >> "$STATE/calls"\nexit 1\n'
}

function run(scenario: Scenario): Outcome {
  const work = mkdtempSync(join(tmpdir(), 'lychee-after-install-'))
  try {
    const bin = join(work, 'bin')
    const state = join(work, 'state')
    const dir = join(work, 'usr', 'lib', 'lychee')
    const source = join(work, 'opt', 'helper', 'lychee-netd')
    const target = join(dir, 'lychee-netd')
    mkdirSync(bin)
    mkdirSync(state)
    mkdirSync(dirname(source), { recursive: true })
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}`, { mode: 0o755 })
    }
    writeFileSync(join(state, 'group'), scenario.group ? `${scenario.group}\n` : '')
    writeFileSync(
      join(state, 'passwd'),
      (scenario.passwd ?? ['box:x:1000:1000::/home/box:/bin/bash']).map((l) => `${l}\n`).join('')
    )
    writeFileSync(join(state, 'calls'), '')
    if (scenario.loginDefs !== undefined)
      writeFileSync(join(state, 'login.defs'), scenario.loginDefs)
    for (const tool of scenario.failing ?? []) writeFileSync(join(state, `${tool}-fails`), '')
    if (scenario.source !== false) writeFileSync(source, 'helper build 2\n', { mode: 0o755 })
    if (scenario.installed !== undefined) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(target, scenario.installed, { mode: 0o755 })
    }
    const script = join(work, 'after-install.sh')
    writeFileSync(script, render(template))
    const shell = [
      'source "$1"',
      'LOGIN_DEFS="$4/login.defs"',
      'install_netd "$2" "$3"',
      'status=$?',
      'stat -c "%n %u:%g:%a" "$3" "$3/lychee-netd" > "$4/stat" 2>/dev/null',
      'exit $status'
    ].join('\n')
    const result = spawnSync(
      'fakeroot',
      ['--', 'bash', '-c', shell, 'bash', script, source, dir, state],
      {
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, STATE: state, ...scenario.env }
      }
    )
    const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      calls: read(join(state, 'calls')).split('\n').filter(Boolean),
      group: read(join(state, 'group')).trim(),
      stat: read(join(state, 'stat'))
        .split('\n')
        .filter(Boolean)
        .map((line) => line.replace(`${dir}/lychee-netd`, 'HELPER').replace(dir, 'DIR')),
      target: existsSync(target) ? readFileSync(target, 'utf8') : null,
      tmpLeft: existsSync(`${target}.tmp`),
      dir
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const caps = (out: Outcome): string => `setcap cap_net_admin,cap_net_raw+ep ${out.dir}/lychee-netd`

test('every macro in the script is one electron-builder defines', () => {
  const rendered = render(template)
  assert.match(
    rendered,
    /^install_netd '\/opt\/Lychee\/resources\/helper\/lychee-netd' \/usr\/lib\/lychee$/m
  )
  assert.ok(rendered.includes("'/usr/bin/lychee'"))
  assert.throws(() => render("echo '${nope}'"), /Macro nope is not defined/)
})

test(
  'a first install creates the group, installs root:lychee 0750 with capabilities, and adds the installing user',
  { skip },
  () => {
    const out = run({ env: { SUDO_UID: '1000' } })
    assert.equal(out.status, 0, out.stderr)
    assert.deepEqual(out.calls, ['groupadd --system lychee', caps(out), 'gpasswd -a box lychee'])
    assert.deepEqual(out.stat, ['DIR 0:0:755', 'HELPER 0:987:750'])
    assert.equal(out.target, 'helper build 2\n')
    assert.equal(out.tmpLeft, false)
    assert.equal(out.group, 'lychee:x:987:box')
    assert.match(out.stdout, /added box to the lychee group/)
  }
)

test(
  'an upgrade keeps the group and its members, replaces the helper and re-applies capabilities',
  { skip },
  () => {
    const out = run({
      group: 'lychee:x:987:box',
      env: { SUDO_UID: '1000' },
      installed: 'helper build 1\n'
    })
    assert.equal(out.status, 0, out.stderr)
    assert.deepEqual(out.calls, [caps(out)])
    assert.deepEqual(out.stat, ['DIR 0:0:755', 'HELPER 0:987:750'])
    assert.equal(out.target, 'helper build 2\n')
    assert.equal(out.group, 'lychee:x:987:box')
    assert.doesNotMatch(out.stdout, /added/)
  }
)

test('the installing user comes from SUDO_UID or PKEXEC_UID, never root or junk', { skip }, () => {
  const passwd = ['box:x:1000:1000::/home/box:/bin/bash', 'alice:x:1001:1001::/home/alice:/bin/sh']
  const viaPkexec = run({
    group: 'lychee:x:987:',
    passwd,
    env: { SUDO_UID: '0', PKEXEC_UID: '1001' }
  })
  assert.deepEqual(viaPkexec.calls, [caps(viaPkexec), 'gpasswd -a alice lychee'])
  const junk = run({
    group: 'lychee:x:987:',
    passwd,
    env: { SUDO_UID: '12abc', PKEXEC_UID: '4242' }
  })
  assert.deepEqual(junk.calls, [caps(junk)])
  assert.match(junk.stdout, /sudo gpasswd -a \$USER lychee/)
  const noUid = run({ group: 'lychee:x:987:', passwd })
  assert.deepEqual(noUid.calls, [caps(noUid)])
  assert.deepEqual(noUid.stat, ['DIR 0:0:755', 'HELPER 0:987:750'])
  assert.match(noUid.stdout, /sudo gpasswd -a \$USER lychee/)
})

test('root and nobody are never added to the group', { skip }, () => {
  const passwd = [
    'root:x:0:0:root:/root:/bin/bash',
    'box:x:1000:1000::/home/box:/bin/bash',
    'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin'
  ]
  const out = run({ group: 'lychee:x:987:', passwd, env: { SUDO_UID: '0', PKEXEC_UID: '65534' } })
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(out.calls, [caps(out)])
  assert.equal(out.group, 'lychee:x:987:')
  assert.match(out.stdout, /sudo gpasswd -a \$USER lychee/)
})

test('a system account below UID_MIN is skipped for the next candidate', { skip }, () => {
  const passwd = [
    'svc:x:999:999:service:/var/lib/svc:/usr/sbin/nologin',
    'box:x:1000:1000::/home/box:/bin/bash'
  ]
  const onlySystem = run({ group: 'lychee:x:987:', passwd, env: { SUDO_UID: '999' } })
  assert.deepEqual(onlySystem.calls, [caps(onlySystem)])
  assert.equal(onlySystem.group, 'lychee:x:987:')
  assert.match(onlySystem.stdout, /sudo gpasswd -a \$USER lychee/)
  const thenUser = run({
    group: 'lychee:x:987:',
    passwd,
    env: { SUDO_UID: '999', PKEXEC_UID: '1000' },
    loginDefs: '# UID_MIN 500\nUID_MAX\t60000\n\n'
  })
  assert.deepEqual(thenUser.calls, [caps(thenUser), 'gpasswd -a box lychee'])
  assert.equal(thenUser.group, 'lychee:x:987:box')
})

test('UID_MIN from login.defs decides which accounts are regular users', { skip }, () => {
  const passwd = [
    'carol:x:600:600::/home/carol:/bin/sh',
    'box:x:1000:1000::/home/box:/bin/bash',
    'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin'
  ]
  const raised = run({
    group: 'lychee:x:987:',
    passwd,
    env: { SUDO_UID: '1000' },
    loginDefs: 'UID_MIN 1000\n#UID_MIN 500\nUID_MIN\t\t2000\n'
  })
  assert.deepEqual(raised.calls, [caps(raised)])
  assert.equal(raised.group, 'lychee:x:987:')
  const lowered = run({
    group: 'lychee:x:987:',
    passwd,
    env: { SUDO_UID: '600' },
    loginDefs: 'UID_MIN   500\n'
  })
  assert.deepEqual(lowered.calls, [caps(lowered), 'gpasswd -a carol lychee'])
  assert.equal(lowered.group, 'lychee:x:987:carol')
  const stillNobody = run({
    group: 'lychee:x:987:',
    passwd,
    env: { PKEXEC_UID: '65534' },
    loginDefs: 'UID_MIN 500\n'
  })
  assert.deepEqual(stillNobody.calls, [caps(stillNobody)])
  const junk = run({
    group: 'lychee:x:987:',
    passwd,
    env: { SUDO_UID: '600' },
    loginDefs: 'UID_MIN five-hundred\n'
  })
  assert.deepEqual(junk.calls, [caps(junk)])
})

test('without the group the helper is not installed and an old copy is removed', { skip }, () => {
  const out = run({
    env: { SUDO_UID: '1000' },
    failing: ['groupadd'],
    installed: 'helper build 1\n'
  })
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(out.calls, ['groupadd --system lychee'])
  assert.equal(out.target, null)
  assert.match(out.stdout, /could not create the lychee group/)
})

test('failures to grant the group or set capabilities are reported with the fix', { skip }, () => {
  const noGrant = run({ env: { SUDO_UID: '1000' }, failing: ['gpasswd'] })
  assert.deepEqual(noGrant.stat, ['DIR 0:0:755', 'HELPER 0:987:750'])
  assert.match(
    noGrant.stdout,
    /could not add box to the lychee group; run: sudo gpasswd -a box lychee/
  )
  const noCaps = run({ env: { SUDO_UID: '1000' }, failing: ['setcap'] })
  assert.deepEqual(noCaps.stat, ['DIR 0:0:755', 'HELPER 0:987:750'])
  assert.match(
    noCaps.stdout,
    /setcap failed; combining connections will ask for an administrator password/
  )
})

test('a package without the helper changes nothing', { skip }, () => {
  const out = run({ env: { SUDO_UID: '1000' }, source: false })
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(out.calls, [])
  assert.deepEqual(out.stat, [])
  assert.equal(out.target, null)
})
