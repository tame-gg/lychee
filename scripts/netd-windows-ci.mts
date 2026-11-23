import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { controlHandshake, type ControlHello } from './netd-handshake.mts'
import {
  installWindowsHelper,
  installedAclProblem,
  powershellEnv,
  powershellExe,
  queryWindowsTask,
  readPipeSddl,
  readWindowsHelperHash,
  removeWindowsHelper,
  sha256File,
  startWindowsHelper,
  whoamiExe,
  windowsAccount,
  windowsHelperDirectory,
  windowsPipeDaclProblem,
  windowsPipePath,
  windowsProgramFiles,
  windowsTaskXml,
  writeWindowsHelperHash
} from '../src/main/network/merge/windowsInstall.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'build', 'netd', 'win-x64', 'lychee-netd.exe')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
const account = 'lycheeci'
const probeDir = join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'lychee-netd-ci')
const probeTask = 'lychee-netd-needs-admin'

function pass(message: string): void {
  console.log(`PASS  ${message}`)
}

function ps(command: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(
    powershellExe(env),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { env: powershellEnv(env), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  )
}

function currentSid(): string {
  const out = execFileSync(whoamiExe(process.env), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true
  })
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(out)?.[1]
  if (!sid) throw new Error(`cannot read the user SID from ${out}`)
  return sid
}

function password(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = 'Aa1!'
  for (const byte of randomBytes(24)) out += alphabet[byte % alphabet.length]
  return out
}

function fetchWintun(): void {
  const fetch = join(root, 'scripts', 'fetch-wintun.mjs')
  if (!existsSync(fetch)) {
    pass(
      'wintun.dll not fetched (scripts/fetch-wintun.mjs is not on this branch); the helper listens with capture unavailable and this job does not open a TUN'
    )
    return
  }
  execFileSync('node', [fetch, '--out', join(root, 'build', 'netd', 'win-x64')], {
    cwd: root,
    stdio: 'inherit'
  })
  pass('fetched wintun.dll with the pinned script')
}

function proveStandardAccount(secret: string): void {
  mkdirSync(probeDir, { recursive: true })
  copyFileSync(source, join(probeDir, 'lychee-netd.exe'))
  execFileSync('icacls', [probeDir, '/grant', 'Users:(OI)(CI)M'], { windowsHide: true })
  const output = ps(
    `
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security
Start-Service seclogon -ErrorAction SilentlyContinue
$sec = ConvertTo-SecureString $env:LYCHEE_CI_PASS -AsPlainText -Force
if (Get-LocalUser -Name $env:LYCHEE_CI_USER -ErrorAction SilentlyContinue) {
  Remove-LocalUser -Name $env:LYCHEE_CI_USER
}
New-LocalUser -Name $env:LYCHEE_CI_USER -Password $sec -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
$listed = net localgroup Administrators | Out-String
if ($listed -match ('(?m)^\\s*' + [regex]::Escape($env:LYCHEE_CI_USER) + '\\s*$')) {
  throw 'the test account is an administrator'
}
$cred = New-Object System.Management.Automation.PSCredential ("$env:COMPUTERNAME\\$env:LYCHEE_CI_USER", $sec)
$exe = Join-Path $env:LYCHEE_CI_DIR 'lychee-netd.exe'
$errFile = Join-Path $env:LYCHEE_CI_DIR 'stderr.txt'
$codeFile = Join-Path $env:LYCHEE_CI_DIR 'exitcode.txt'
$runner = Join-Path $env:LYCHEE_CI_DIR 'run-as-user.ps1'
$launch = '& ''{0}'' serve --control ''\\\\.\\pipe\\lychee-netd-needs-admin'' 2> ''{1}''' -f $exe, $errFile
$codeLine = 'Set-Content -LiteralPath ''{0}'' -Value $LASTEXITCODE' -f $codeFile
Set-Content -LiteralPath $runner -Encoding ASCII -Value @($launch, $codeLine)
$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$p = Start-Process -FilePath $ps -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$runner) -Credential $cred -WorkingDirectory $env:LYCHEE_CI_DIR -WindowStyle Hidden -PassThru
if (-not $p.WaitForExit(20000)) {
  Stop-Process -Id $p.Id -Force
  throw 'the standard-account helper did not exit'
}
if (-not (Test-Path -LiteralPath $codeFile)) { throw 'the standard account wrote no exit code' }
Write-Output ('exit=' + (Get-Content -LiteralPath $codeFile -Raw).Trim())
if (Test-Path -LiteralPath $errFile) { Get-Content -LiteralPath $errFile }
`.trim(),
    { ...process.env, LYCHEE_CI_PASS: secret, LYCHEE_CI_USER: account, LYCHEE_CI_DIR: probeDir }
  )
  const match = /exit=(\S+)/.exec(output)
  const raw = match?.[1] ?? ''
  const code = raw.startsWith('0x') || raw.startsWith('0X') ? Number.parseInt(raw, 16) : Number(raw)
  if (code !== 6) throw new Error(`standard account exited ${raw || 'nothing'}, want 6\n${output}`)
  pass('a local standard account running lychee-netd serve exits 6 (needs_admin)')
}

function provePipeDenied(pipe: string, secret: string): void {
  const result = join(probeDir, 'pipe-result.txt')
  rmSync(result, { force: true })
  const output = ps(
    `
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security
$sec = ConvertTo-SecureString $env:LYCHEE_CI_PASS -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential ("$env:COMPUTERNAME\\$env:LYCHEE_CI_USER", $sec)
$script = Join-Path $env:LYCHEE_CI_DIR 'open-pipe.ps1'
@'
param([string]$Name, [string]$Result)
$ErrorActionPreference = 'Stop'
try {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Name, 'InOut')
  $client.Connect(4000)
  Set-Content -LiteralPath $Result -Value 'opened'
  exit 0
} catch {
  Set-Content -LiteralPath $Result -Value $_.Exception.Message
  exit 5
}
'@ | Set-Content -LiteralPath $script -Encoding ASCII
$p = Start-Process -FilePath $env:LYCHEE_CI_POWERSHELL -Credential $cred -WorkingDirectory $env:LYCHEE_CI_DIR -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$script,$env:LYCHEE_CI_PIPE,$env:LYCHEE_CI_RESULT)
if (-not $p.WaitForExit(20000)) { Stop-Process -Id $p.Id -Force; throw 'pipe probe timed out' }
Write-Output ('exit=' + $p.ExitCode)
if (Test-Path -LiteralPath $env:LYCHEE_CI_RESULT) { Get-Content -LiteralPath $env:LYCHEE_CI_RESULT }
`.trim(),
    {
      ...process.env,
      LYCHEE_CI_PASS: secret,
      LYCHEE_CI_USER: account,
      LYCHEE_CI_DIR: probeDir,
      LYCHEE_CI_PIPE: pipe.replace(/^\\\\\.\\pipe\\/i, ''),
      LYCHEE_CI_RESULT: result,
      LYCHEE_CI_POWERSHELL: powershellExe(process.env)
    }
  )
  if (output.includes('opened')) throw new Error(`another account opened the pipe\n${output}`)
  const match = /exit=(\S+)/.exec(output)
  const code = Number(match?.[1])
  if (code !== 5) throw new Error(`another account was not denied\n${output}`)
  pass('a different account cannot open the helper pipe')
}

function removeAccount(): void {
  ps(`
$ErrorActionPreference = 'Continue'
& schtasks.exe /Delete /TN ${probeTask} /F | Out-Null
if (Get-LocalUser -Name '${account}' -ErrorAction SilentlyContinue) { Remove-LocalUser -Name '${account}' }
`)
}

async function waitHello(path: string): Promise<ControlHello> {
  const deadline = Date.now() + 20000
  let last = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const hello = await controlHandshake(path, 3000)
      if (hello?.message.ok && hello.message.result?.helper_version) return hello
      last = hello?.raw ?? 'closed without a hello'
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`no hello on ${path}: ${last}`)
}

async function main(): Promise<void> {
  if (!existsSync(source)) throw new Error(`${source} was not built`)
  fetchWintun()
  const hash = sha256File(source)
  writeWindowsHelperHash(source, hash)
  if (readWindowsHelperHash(source) !== hash)
    throw new Error('the sidecar hash does not match the exe')
  pass(`helper sha256 ${hash}`)

  const env = process.env
  const user = windowsAccount(env)
  const sid = currentSid()
  const programFiles = windowsProgramFiles(env)
  const dest = windowsHelperDirectory(programFiles)
  const installed = join(dest, 'lychee-netd.exe')
  const control = windowsPipePath(sid)
  if (!dest.startsWith(programFiles) || !dest.endsWith('\\Lychee\\helper')) {
    throw new Error(`helper directory ${dest} is not %ProgramFiles%\\Lychee\\helper`)
  }
  pass(`install directory ${dest}`)

  const fromGo = execFileSync(
    'go',
    ['run', './scripts/taskxml_windows.go', user, installed, control],
    {
      cwd: join(root, 'native', 'netd'),
      encoding: 'utf8'
    }
  )
  if (fromGo !== windowsTaskXml(user, installed, control)) {
    throw new Error('windowsTaskXml does not match platform.TaskXML')
  }
  pass('scheduled task XML matches the Go helper')

  const secret = password()
  let installedOk = false
  try {
    proveStandardAccount(secret)
    try {
      installWindowsHelper({
        sourceExe: source,
        expectedSha256: '0'.repeat(64),
        programFiles,
        user,
        sid,
        env
      })
      throw new Error('a wrong hash was accepted')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'a wrong hash was accepted') throw error
      if (!/hash mismatch/i.test(message)) throw error
    }
    if (existsSync(dest)) throw new Error('a wrong hash still created the helper directory')
    pass('hash mismatch is refused before the helper is installed')

    const wintun = join(dirname(source), 'wintun.dll')
    let wintunSha256: string | undefined
    if (existsSync(wintun)) {
      const fetch = join(root, 'scripts', 'fetch-wintun.mjs')
      const pinned = existsSync(fetch)
        ? ((await import(pathToFileURL(fetch).href)) as { WINTUN_DLL_SHA256: { amd64: string } })
            .WINTUN_DLL_SHA256.amd64
        : sha256File(wintun)
      if (sha256File(wintun) !== pinned) {
        throw new Error(`wintun.dll is ${sha256File(wintun)}, pinned ${pinned}`)
      }
      wintunSha256 = pinned
    }
    installWindowsHelper({
      sourceExe: source,
      expectedSha256: hash,
      programFiles,
      user,
      sid,
      env,
      wintunSha256
    })
    installedOk = true
    const acl = installedAclProblem(dest, env)
    if (acl) throw new Error(acl)
    if (sha256File(installed) !== hash)
      throw new Error('installed bytes do not match the built helper')
    pass('helper folder owner and ACL allow writes only by SYSTEM and Administrators')
    pass('installed helper hash matches the build')

    try {
      installWindowsHelper({
        sourceExe: source,
        expectedSha256: 'ab'.repeat(32),
        programFiles,
        user,
        sid,
        env
      })
      throw new Error('a later wrong hash was accepted')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'a later wrong hash was accepted') throw error
      if (!/hash mismatch/i.test(message)) throw error
    }
    if (sha256File(installed) !== hash)
      throw new Error('a wrong hash replaced the installed helper')
    pass('a wrong hash does not replace the installed helper')

    const task = queryWindowsTask(env)
    if (!task.includes(installed)) throw new Error(`task does not run ${installed}\n${task}`)
    if (!task.includes(`serve --control ${control}`))
      throw new Error(`task arguments differ\n${task}`)
    if (!/Highest Available/i.test(task)) throw new Error(`task is not Highest Available\n${task}`)
    if (/LOCALAPPDATA/i.test(task)) throw new Error(`task points at a per-user path\n${task}`)
    pass('scheduled task points only at the Program Files helper')

    const pid = startWindowsHelper(env, installed)
    pass(`scheduled task started lychee-netd (${pid})`)
    const hello = await waitHello(control)
    const result = hello.message.result
    if (!result || result.protocol !== 1) throw new Error(`protocol ${result?.protocol}`)
    if (result.helper_version !== version) {
      throw new Error(`helper_version ${result.helper_version}, build ${version}`)
    }
    if (result.auth?.model !== 'windows_pipe_sid' || result.auth.authorized_sid !== sid) {
      throw new Error(`auth ${JSON.stringify(result.auth)}`)
    }
    pass(`version handshake helper_version ${result.helper_version} sid ${sid}`)
    const wantCapture = existsSync(wintun)
    if (Boolean(result.capture?.available) !== wantCapture) {
      throw new Error(
        `capture.available is ${String(result.capture?.available)}, wintun.dll present is ${wantCapture}`
      )
    }
    pass(
      wantCapture
        ? 'wintun.dll is beside the installed helper and capture is available'
        : 'capture is unavailable without wintun.dll; TUN was not opened'
    )

    const sddl = readPipeSddl(control, env)
    const dacl = windowsPipeDaclProblem(sddl, sid)
    if (dacl) throw new Error(`${dacl}\n${sddl}`)
    pass(`pipe DACL ${sddl}`)
    provePipeDenied(control, secret)
  } finally {
    removeWindowsHelper(programFiles, env)
    removeAccount()
    rmSync(probeDir, { recursive: true, force: true })
  }

  if (installedOk) {
    if (existsSync(dest)) throw new Error(`${dest} was not removed`)
    let taskLeft = true
    try {
      queryWindowsTask(env)
    } catch {
      taskLeft = false
    }
    if (taskLeft) throw new Error('the scheduled task was not removed')
    pass('helper directory and scheduled task are gone')
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  try {
    removeWindowsHelper(windowsProgramFiles(process.env), process.env)
  } catch {
    void 0
  }
  try {
    removeAccount()
  } catch {
    void 0
  }
  rmSync(probeDir, { recursive: true, force: true })
  process.exit(1)
})
