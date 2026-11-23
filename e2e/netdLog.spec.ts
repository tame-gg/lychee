import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { initialMergeState, DEFAULT_MERGE_SETTINGS } from '../src/shared/mergeSettings'
import { buildDiagnosticsZip } from '../src/main/network/merge/diagnostics'
import { NetdLog } from '../src/main/network/merge/netdLog'

test('the netd log rotates once it passes the size cap and redacts secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lychee-netd-log-'))
  try {
    const log = new NetdLog(dir, '/home/person', 120, 2)
    for (let index = 0; index < 30; index++) {
      log.write(`n=${index} token=sekrit see /home/person/notes`)
    }
    const current = readFileSync(log.file, 'utf8')
    expect(current).not.toContain('sekrit')
    expect(current).not.toContain('/home/person')
    expect(current).toContain('token=[redacted]')
    expect(current).toContain('~/notes')
    expect(statSync(log.file).size).toBeLessThanOrEqual(120 + 200)
    expect(statSync(join(dir, 'lychee-netd.log.1')).size).toBeGreaterThan(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a diagnostics zip is a real archive of the log, versions, settings and status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lychee-netd-zip-'))
  const zipPath = join(dir, 'diagnostics.zip')
  try {
    const state = initialMergeState({ ...DEFAULT_MERGE_SETTINGS, enabled: true })
    const zip = buildDiagnosticsZip({
      lycheeVersion: '0.1.2',
      home: '/home/person',
      os: { platform: 'linux', release: 'test', arch: 'x64' },
      state,
      logs: [{ name: 'lychee-netd.log', text: 'path /home/person/x token=sekrit\n' }]
    })
    writeFileSync(zipPath, zip)
    const run = spawnSync(
      'python3',
      [
        '-c',
        'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n: z.read(n).decode() for n in z.namelist()}))',
        zipPath
      ],
      { encoding: 'utf8' }
    )
    expect(run.status, run.stderr).toBe(0)
    const entries = JSON.parse(run.stdout) as Record<string, string>
    expect(Object.keys(entries).sort()).toEqual(['diagnostics.json', 'lychee-netd.log'])
    const dumped = Object.values(entries).join('\n')
    expect(dumped).not.toContain('/home/person')
    expect(dumped).not.toContain('sekrit')
    expect(dumped).toContain('token=[redacted]')
    const doc = JSON.parse(entries['diagnostics.json']) as {
      lycheeVersion: string
      helperVersion: string | null
      os: { platform: string }
      mergeSettings: { enabled: boolean }
      status: { status: string; history?: unknown }
    }
    expect(doc).toMatchObject({
      lycheeVersion: '0.1.2',
      helperVersion: null,
      os: { platform: 'linux' },
      mergeSettings: { enabled: true },
      status: { status: 'off' }
    })
    expect(doc.status.history).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
