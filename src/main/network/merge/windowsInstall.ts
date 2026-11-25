import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

export const WINDOWS_TASK_NAME = '\\lychee-netd'
export const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\lychee-netd-'
export const WINDOWS_WRITE_SIDS = ['S-1-5-18', 'S-1-5-32-544'] as const
export const WINDOWS_OWNER_SIDS = ['S-1-5-18', 'S-1-5-32-544'] as const

const WRITE_BITS =
  0x00000002 |
  0x00000004 |
  0x00000010 |
  0x00000040 |
  0x00000100 |
  0x00010000 |
  0x00040000 |
  0x00080000 |
  0x10000000 |
  0x40000000

const HASH = /^[0-9a-f]{64}$/

export interface AclAce {
  sid: string
  type: string
  rights: number
}

export interface AclReport {
  owner: string
  aces: AclAce[]
}

export function windowsProgramFiles(env: NodeJS.ProcessEnv): string {
  return env.ProgramFiles || 'C:\\Program Files'
}

export function windowsHelperDirectory(programFiles: string): string {
  return win32.join(programFiles, 'Lychee', 'helper')
}

export function windowsPipePath(sid: string): string {
  return WINDOWS_PIPE_PREFIX + sid
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function readWindowsHelperHash(binary: string): string | null {
  const file = `${binary}.sha256`
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8').trim().toLowerCase()
  return HASH.test(text) ? text : null
}

export function writeWindowsHelperHash(binary: string, hash: string): void {
  writeFileSync(`${binary}.sha256`, `${hash.toLowerCase()}\n`)
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function windowsTaskXml(user: string, exe: string, control: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts Lychee's network helper (lychee-netd) at sign-in.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(user)}</UserId><Delay>PT10S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure><Interval>PT1M</Interval><Count>5</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEscape(exe)}</Command><Arguments>serve --control ${xmlEscape(control)}</Arguments></Exec></Actions>
</Task>`
}

export function writeUtf16File(path: string, text: string): void {
  const body = Buffer.from(text, 'utf16le')
  const out = Buffer.alloc(2 + body.length)
  out[0] = 0xff
  out[1] = 0xfe
  body.copy(out, 2)
  writeFileSync(path, out)
}

export function aceGrantsWrite(type: string, rights: number): boolean {
  return type === 'Allow' && (rights & WRITE_BITS) !== 0
}

export function windowsAclProblem(owner: string, aces: readonly AclAce[]): string | null {
  if (!WINDOWS_OWNER_SIDS.includes(owner as (typeof WINDOWS_OWNER_SIDS)[number])) {
    return `owner ${owner} is not SYSTEM or Administrators`
  }
  for (const ace of aces) {
    if (!aceGrantsWrite(ace.type, ace.rights)) continue
    if (!WINDOWS_WRITE_SIDS.includes(ace.sid as (typeof WINDOWS_WRITE_SIDS)[number])) {
      return `${ace.sid} can write`
    }
  }
  return null
}

export function windowsPipeDaclProblem(sddl: string, userSid: string): string | null {
  const text = sddl.replace(/\s+/g, '')
  const header = /^O:([^GD]+?)(?:G:[^D]+)?D:(.*)$/i.exec(text)
  if (!header) return 'security descriptor is not SDDL'
  if (header[1] !== userSid) return `owner ${header[1]} is not ${userSid}`
  if (!header[2].startsWith('P')) return 'DACL is not protected'
  const aces = [...header[2].matchAll(/\(([A-Z]+);([^;]*);([^;]*);([^;]*);([^;]*);([^)]*)\)/gi)]
  if (aces.length !== 2) return `DACL has ${aces.length} ACEs`
  let user = false
  let system = false
  for (const ace of aces) {
    const type = ace[1].toUpperCase()
    const sid = ace[6]
    if (type !== 'A') return `ACE type ${type} for ${sid}`
    if (sid === userSid) user = true
    else if (sid.toUpperCase() === 'SY' || sid === 'S-1-5-18') system = true
    else return `ACE for ${sid}`
  }
  if (!user || !system) return 'DACL is missing the user or SYSTEM'
  return null
}

export function powershellExe(env: NodeJS.ProcessEnv): string {
  return join(
    env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

export function whoamiExe(env: NodeJS.ProcessEnv): string {
  return join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe')
}

export function powershellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.PSModulePath
  return next
}

function run(env: NodeJS.ProcessEnv, file: string, args: string[]): string {
  return execFileSync(file, args, {
    env: powershellEnv(env),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  })
}

export function windowsIsElevated(env: NodeJS.ProcessEnv): boolean {
  try {
    return run(env, whoamiExe(env), ['/groups']).includes('S-1-16-12288')
  } catch {
    return false
  }
}

export function windowsAccount(env: NodeJS.ProcessEnv): string {
  const account = run(env, whoamiExe(env), []).trim()
  if (!account || /[\r\n]/.test(account)) throw new Error('cannot read the Windows account name')
  return account
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function installBody(): string {
  return `
$ErrorActionPreference = 'Stop'
function HashOf([string]$p) {
  (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Lock([string]$p, [string]$grant) {
  & takeown.exe /F $p /A | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "takeown failed for $p ($LASTEXITCODE)" }
  & icacls.exe $p /inheritance:r | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "inheritance failed for $p ($LASTEXITCODE)" }
  & icacls.exe $p /grant:r ("*S-1-5-18:" + $grant) ("*S-1-5-32-544:" + $grant) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "grant failed for $p ($LASTEXITCODE)" }
  & icacls.exe $p /setowner '*S-1-5-32-544' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "setowner failed for $p ($LASTEXITCODE)" }
}
$src = $env:LYCHEE_NETD_SRC
$want = $env:LYCHEE_NETD_SHA256.ToLowerInvariant()
$dest = $env:LYCHEE_NETD_DIR
if ((HashOf $src) -ne $want) {
  [Console]::Error.WriteLine("hash mismatch for $src")
  exit 11
}
$parent = Split-Path -Parent $dest
New-Item -ItemType Directory -Force -Path $parent | Out-Null
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Lock $dest '(OI)(CI)(F)'
$exe = Join-Path $dest 'lychee-netd.exe'
Copy-Item -LiteralPath $src -Destination $exe -Force
$srcDir = Split-Path -Parent $src
foreach ($name in @('wintun.dll', 'wintun-LICENSE.txt')) {
  $from = Join-Path $srcDir $name
  if (Test-Path -LiteralPath $from) {
    Copy-Item -LiteralPath $from -Destination (Join-Path $dest $name) -Force
  }
}
if ($env:LYCHEE_WINTUN_SHA256) {
  $dll = Join-Path $dest 'wintun.dll'
  if (-not (Test-Path -LiteralPath $dll)) { [Console]::Error.WriteLine('wintun.dll is missing'); exit 13 }
  $got = HashOf $dll
  if ($got -ne $env:LYCHEE_WINTUN_SHA256.ToLowerInvariant()) {
    [Console]::Error.WriteLine("wintun.dll hash mismatch: $got")
    exit 13
  }
}
Get-ChildItem -LiteralPath $dest -Force | ForEach-Object { Lock $_.FullName '(F)' }
if ((HashOf $exe) -ne $want) {
  [Console]::Error.WriteLine('installed helper hash mismatch')
  exit 11
}
& schtasks.exe /Create /TN "$env:LYCHEE_NETD_TASK" /XML "$env:LYCHEE_NETD_TASK_XML" /F
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`.trim()
}

function execPowerShell(env: NodeJS.ProcessEnv, command: string): void {
  try {
    execFileSync(
      powershellExe(env),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command
      ],
      { env: powershellEnv(env), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    )
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string }
    const detail = `${failed.stderr ?? ''}${failed.stdout ?? ''}`.trim()
    throw new Error(detail || failed.message || 'powershell failed')
  }
}

export interface WindowsInstallOptions {
  sourceExe: string
  expectedSha256: string
  programFiles: string
  user: string
  sid: string
  env: NodeJS.ProcessEnv
  wintunSha256?: string
}

function installEnv(options: WindowsInstallOptions, xmlPath: string): NodeJS.ProcessEnv {
  const expected = options.expectedSha256.toLowerCase()
  if (!HASH.test(expected)) throw new Error('the helper hash is not a SHA-256')
  return {
    ...options.env,
    LYCHEE_NETD_SRC: options.sourceExe,
    LYCHEE_NETD_SHA256: expected,
    LYCHEE_NETD_DIR: windowsHelperDirectory(options.programFiles),
    LYCHEE_NETD_TASK: WINDOWS_TASK_NAME,
    LYCHEE_NETD_TASK_XML: xmlPath,
    LYCHEE_WINTUN_SHA256: options.wintunSha256 ?? ''
  }
}

export function installWindowsHelper(options: WindowsInstallOptions): void {
  const dest = windowsHelperDirectory(options.programFiles)
  const exe = join(dest, 'lychee-netd.exe')
  const control = windowsPipePath(options.sid)
  const xmlPath = join(tmpdir(), `lychee-netd-task-${process.pid}.xml`)
  writeUtf16File(xmlPath, windowsTaskXml(options.user, exe, control))
  const env = installEnv(options, xmlPath)
  try {
    if (windowsIsElevated(env)) {
      execPowerShell(env, installBody())
    } else {
      const script = join(tmpdir(), `lychee-netd-install-${process.pid}.ps1`)
      const assignments = [
        `$env:LYCHEE_NETD_SRC = ${psQuote(options.sourceExe)}`,
        `$env:LYCHEE_NETD_SHA256 = ${psQuote(options.expectedSha256.toLowerCase())}`,
        `$env:LYCHEE_NETD_DIR = ${psQuote(dest)}`,
        `$env:LYCHEE_NETD_TASK = ${psQuote(WINDOWS_TASK_NAME)}`,
        `$env:LYCHEE_NETD_TASK_XML = ${psQuote(xmlPath)}`,
        `$env:LYCHEE_WINTUN_SHA256 = ${psQuote(options.wintunSha256 ?? '')}`
      ].join('\n')
      writeFileSync(script, `${assignments}\n${installBody()}\n`, 'utf8')
      try {
        const launched = [
          `$p = Start-Process -FilePath ${psQuote(powershellExe(options.env))} -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(script)})`,
          'if ($null -eq $p.ExitCode) { exit 1 }',
          'exit $p.ExitCode'
        ].join('\n')
        execPowerShell(options.env, launched)
      } finally {
        rmSync(script, { force: true })
      }
    }
  } finally {
    rmSync(xmlPath, { force: true })
  }
  assertInstalled(options)
}

function assertInstalled(options: WindowsInstallOptions): void {
  const dest = windowsHelperDirectory(options.programFiles)
  const exe = join(dest, 'lychee-netd.exe')
  const problem = installedAclProblem(dest, options.env)
  if (problem) {
    removeWindowsHelper(options.programFiles, options.env)
    throw new Error(problem)
  }
  const hash = sha256File(exe)
  if (hash !== options.expectedSha256.toLowerCase()) {
    removeWindowsHelper(options.programFiles, options.env)
    throw new Error(`installed helper hash is ${hash}`)
  }
}

export function installedAclProblem(dir: string, env: NodeJS.ProcessEnv): string | null {
  const targets = [dir, ...readdirSync(dir).map((name) => join(dir, name))]
  for (const target of targets) {
    const report = readWindowsAcl(target, env)
    const problem = windowsAclProblem(report.owner, report.aces)
    if (problem) return `${target}: ${problem}`
  }
  return null
}

export function readWindowsAcl(path: string, env: NodeJS.ProcessEnv): AclReport {
  const command = `
$acl = Get-Acl -LiteralPath ${psQuote(path)}
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
Write-Output "owner=$owner"
foreach ($ace in $acl.Access) {
  $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  Write-Output ("ace=" + $sid + "|" + $ace.AccessControlType.ToString() + "|" + [int]$ace.FileSystemRights)
}
`.trim()
  const output = run(env, powershellExe(env), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command
  ])
  const aces: AclAce[] = []
  let owner = ''
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('owner=')) owner = line.slice('owner='.length).trim()
    else if (line.startsWith('ace=')) {
      const [sid, type, rights] = line.slice('ace='.length).split('|')
      aces.push({ sid, type, rights: Number(rights) })
    }
  }
  if (!owner || aces.length === 0) throw new Error(`cannot read the ACL of ${path}`)
  return { owner, aces }
}

export function readPipeSddl(path: string, env: NodeJS.ProcessEnv): string {
  const command = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class LycheePipeSd {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern int GetSecurityInfo(IntPtr handle, int type, int info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint rev, uint secInfo, out IntPtr sddl, out uint len);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr memory);
}
"@
$handle = [LycheePipeSd]::CreateFileW(${psQuote(path)}, 0x20000, 0, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ($handle -eq [IntPtr]::new(-1)) { throw "cannot open the pipe (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
try {
  $owner = [IntPtr]::Zero; $group = [IntPtr]::Zero; $dacl = [IntPtr]::Zero; $sacl = [IntPtr]::Zero; $sd = [IntPtr]::Zero
  $code = [LycheePipeSd]::GetSecurityInfo($handle, 1, 0x5, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$sd)
  if ($code -ne 0) { throw "GetSecurityInfo $code" }
  try {
    $text = [IntPtr]::Zero; $len = 0
    if (-not [LycheePipeSd]::ConvertSecurityDescriptorToStringSecurityDescriptorW($sd, 1, 0x5, [ref]$text, [ref]$len)) {
      throw "cannot format the pipe security descriptor"
    }
    try { [Runtime.InteropServices.Marshal]::PtrToStringUni($text) }
    finally { [LycheePipeSd]::LocalFree($text) | Out-Null }
  } finally { [LycheePipeSd]::LocalFree($sd) | Out-Null }
} finally { [LycheePipeSd]::CloseHandle($handle) | Out-Null }
`.trim()
  return run(env, powershellExe(env), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command
  ]).trim()
}

export function endWindowsHelper(env: NodeJS.ProcessEnv, exe: string): void {
  const command = `
$ErrorActionPreference = 'Continue'
$tn = ${psQuote(WINDOWS_TASK_NAME)}
$info = & schtasks.exe /Query /TN $tn /FO LIST | Out-String
if ($info -match 'Status:\\s+Running') { & schtasks.exe /End /TN $tn | Out-Null }
Get-CimInstance Win32_Process -Filter "Name = 'lychee-netd.exe'" | ForEach-Object {
  if ($_.ExecutablePath -eq ${psQuote(exe)}) {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
`.trim()
  try {
    execPowerShell(env, command)
  } catch {
    return
  }
}

export function startWindowsHelper(env: NodeJS.ProcessEnv, exe: string): number {
  const command = `
$ErrorActionPreference = 'Stop'
& schtasks.exe /Run /TN ${psQuote(WINDOWS_TASK_NAME)}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$want = ${psQuote(exe)}
$deadline = (Get-Date).AddSeconds(20)
do {
  $found = Get-CimInstance Win32_Process -Filter "Name = 'lychee-netd.exe'" | Where-Object { $_.ExecutablePath -eq $want }
  if ($found) { Write-Output @($found)[0].ProcessId; exit 0 }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
& schtasks.exe /Query /TN ${psQuote(WINDOWS_TASK_NAME)} /V /FO LIST
exit 14
`.trim()
  const output = run(env, powershellExe(env), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command
  ])
  const pid = Number(output.trim().split(/\r?\n/).pop())
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error(`the scheduled task did not stay running\n${output}`)
  return pid
}

export function queryWindowsTask(env: NodeJS.ProcessEnv): string {
  return run(env, join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe'), [
    '/Query',
    '/TN',
    WINDOWS_TASK_NAME,
    '/V',
    '/FO',
    'LIST'
  ])
}

export function removeWindowsHelper(programFiles: string, env: NodeJS.ProcessEnv): void {
  const dest = windowsHelperDirectory(programFiles)
  const parent = win32.dirname(dest)
  const command = `
$ErrorActionPreference = 'Continue'
$tn = ${psQuote(WINDOWS_TASK_NAME)}
$info = & schtasks.exe /Query /TN $tn /FO LIST | Out-String
if ($info -match 'Status:\\s+Running') { & schtasks.exe /End /TN $tn | Out-Null }
& schtasks.exe /Delete /TN $tn /F | Out-Null
Get-CimInstance Win32_Process -Filter "Name = 'lychee-netd.exe'" | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath ${psQuote(dest)}) { Remove-Item -LiteralPath ${psQuote(dest)} -Recurse -Force }
if ((Test-Path -LiteralPath ${psQuote(parent)}) -and -not (Get-ChildItem -LiteralPath ${psQuote(parent)} -Force)) {
  Remove-Item -LiteralPath ${psQuote(parent)} -Force
}
`.trim()
  execPowerShell(env, command)
}

export function windowsTaskExit(env: NodeJS.ProcessEnv): number | null {
  try {
    const text = queryWindowsTask(env)
    const line = text.split(/\r?\n/).find((item) => item.startsWith('Last Result:'))
    const value = line?.split(':').slice(1).join(':').trim()
    if (!value) return null
    return value.startsWith('0x') || value.startsWith('0X')
      ? Number.parseInt(value, 16)
      : Number(value)
  } catch {
    return null
  }
}
