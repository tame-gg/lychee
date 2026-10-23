import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const template = readFileSync(join(root, 'build', 'linux', 'after-remove.sh'), 'utf8')
const macros: Record<string, string> = { executable: 'lychee', sanitizedProductName: 'Lychee' }
const skip = process.platform !== 'linux' ? 'the remove script runs on Linux' : false

function render(source: string): string {
  return source.replace(/\${([a-zA-Z]+)}/g, (_match, name: string) => {
    if (!(name in macros)) throw new Error(`Macro ${name} is not defined`)
    return macros[name]
  })
}

interface Outcome {
  status: number | null
  stderr: string
  helper: boolean
  dir: boolean
}

function run(argument: string, extra: string[] = []): Outcome {
  const work = mkdtempSync(join(tmpdir(), 'lychee-after-remove-'))
  try {
    const dir = join(work, 'usr', 'lib', 'lychee')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'lychee-netd'), 'helper\n', { mode: 0o750 })
    for (const name of extra) writeFileSync(join(dir, name), '')
    const script = join(work, 'after-remove.sh')
    writeFileSync(script, render(template))
    const result = spawnSync(
      'bash',
      ['-c', 'source "$1"; remove_netd "$3" "$2"', 'bash', script, dir, argument],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }
    )
    return {
      status: result.status,
      stderr: result.stderr,
      helper: existsSync(join(dir, 'lychee-netd')),
      dir: existsSync(dir)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

test('the script ends by removing the helper from /usr/lib/lychee', () => {
  const rendered = render(template)
  assert.match(rendered, /^remove_netd "\$1" \/usr\/lib\/lychee$/m)
  assert.ok(rendered.includes("'/opt/Lychee/lychee'"))
})

test(
  'an rpm erase removes the helper and its directory, an rpm upgrade keeps them',
  { skip },
  () => {
    const erase = run('0')
    assert.equal(erase.status, 0, erase.stderr)
    assert.deepEqual([erase.helper, erase.dir], [false, false])
    for (const remaining of ['1', '2']) {
      const upgrade = run(remaining)
      assert.equal(upgrade.status, 0, upgrade.stderr)
      assert.deepEqual([upgrade.helper, upgrade.dir], [true, true], `rpm $1=${remaining}`)
    }
  }
)

test('a deb remove or purge removes the helper, every other dpkg action keeps it', { skip }, () => {
  for (const action of ['remove', 'purge']) {
    const out = run(action)
    assert.equal(out.status, 0, out.stderr)
    assert.deepEqual([out.helper, out.dir], [false, false], action)
  }
  for (const action of [
    'upgrade',
    'failed-upgrade',
    'abort-install',
    'abort-upgrade',
    'disappear'
  ]) {
    const out = run(action)
    assert.equal(out.status, 0, out.stderr)
    assert.deepEqual([out.helper, out.dir], [true, true], action)
  }
})

test(
  'without an argument the helper is removed, and a shared directory is left in place',
  { skip },
  () => {
    const bare = run('')
    assert.equal(bare.status, 0, bare.stderr)
    assert.deepEqual([bare.helper, bare.dir], [false, false])
    const shared = run('remove', ['other-file'])
    assert.equal(shared.status, 0, shared.stderr)
    assert.deepEqual([shared.helper, shared.dir], [false, true])
  }
)
