import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { IKoffiLib } from 'koffi'

const execFileAsync = promisify(execFile)

type KoffiFunction = ReturnType<IKoffiLib['func']>

const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const OPEN_EXISTING = 3
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x0008
const TOKEN_USER = 1
const INVALID_HANDLE = BigInt.asUintN(64, -1n)
const ADMINISTRATORS_SID = 'S-1-5-32-544'

export const ERROR_FILE_NOT_FOUND = 2
export const ERROR_ACCESS_DENIED = 5
export const ERROR_PIPE_BUSY = 231

export class WindowsError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(`${message} (Windows error ${code})`)
    this.name = 'WindowsError'
    this.code = code
  }
}

interface Native {
  address: (handle: unknown) => bigint
  decodePointer: (buffer: Buffer) => unknown
  decodeWide: (pointer: unknown) => string
  createFile: KoffiFunction
  getLastError: KoffiFunction
  closeHandle: KoffiFunction
  openProcess: KoffiFunction
  getNamedPipeServerProcessId: KoffiFunction
  localFree: KoffiFunction
  openProcessToken: KoffiFunction
  getTokenInformation: KoffiFunction
  convertSidToStringSid: KoffiFunction
}

let native: Promise<Native> | null = null

function load(): Promise<Native> {
  native ??= (async () => {
    const { default: koffi } = await import('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    const advapi32 = koffi.load('advapi32.dll')
    return {
      address: (handle) => koffi.address(handle),
      decodePointer: (buffer) => koffi.decode(buffer, 'void *'),
      decodeWide: (pointer) => String(koffi.decode(pointer, 'char16_t *')),
      createFile: kernel32.func(
        'void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *template)'
      ),
      getLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
      closeHandle: kernel32.func('int __stdcall CloseHandle(void *handle)'),
      openProcess: kernel32.func(
        'void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'
      ),
      getNamedPipeServerProcessId: kernel32.func(
        'int __stdcall GetNamedPipeServerProcessId(void *pipe, _Out_ uint32_t *pid)'
      ),
      localFree: kernel32.func('void * __stdcall LocalFree(void *memory)'),
      openProcessToken: advapi32.func(
        'int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)'
      ),
      getTokenInformation: advapi32.func(
        'int __stdcall GetTokenInformation(void *token, int kind, _Out_ void *info, uint32_t size, _Out_ uint32_t *needed)'
      ),
      convertSidToStringSid: advapi32.func(
        'int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)'
      )
    }
  })()
  return native
}

function processUserSid(lib: Native, pid: number): string {
  const process = lib.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (lib.address(process) === 0n) {
    throw new WindowsError(lib.getLastError(), `cannot open process ${pid}`)
  }
  try {
    const tokenOut: unknown[] = [null]
    if (!lib.openProcessToken(process, TOKEN_QUERY, tokenOut)) {
      throw new WindowsError(lib.getLastError(), `cannot open the token of process ${pid}`)
    }
    const token = tokenOut[0]
    try {
      const info = Buffer.alloc(512)
      const needed = [0]
      if (!lib.getTokenInformation(token, TOKEN_USER, info, info.length, needed)) {
        throw new WindowsError(lib.getLastError(), `cannot read the user of process ${pid}`)
      }
      const textOut: unknown[] = [null]
      if (!lib.convertSidToStringSid(lib.decodePointer(info), textOut)) {
        throw new WindowsError(lib.getLastError(), `cannot format the SID of process ${pid}`)
      }
      const sid = lib.decodeWide(textOut[0])
      lib.localFree(textOut[0])
      return sid
    } finally {
      lib.closeHandle(token)
    }
  } finally {
    lib.closeHandle(process)
  }
}

export async function pipeServerIdentity(path: string): Promise<{ pid: number; sid: string }> {
  const lib = await load()
  const handle = lib.createFile(path, GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, 0, null)
  if (lib.address(handle) === INVALID_HANDLE) {
    throw new WindowsError(lib.getLastError(), `cannot open ${path}`)
  }
  try {
    const pidOut = [0]
    if (!lib.getNamedPipeServerProcessId(handle, pidOut)) {
      throw new WindowsError(lib.getLastError(), `cannot read the server process of ${path}`)
    }
    const pid = pidOut[0]
    return { pid, sid: processUserSid(lib, pid) }
  } finally {
    lib.closeHandle(handle)
  }
}

export interface WindowsIdentity {
  sid: string
  administrator: boolean
}

export function systemTool(env: NodeJS.ProcessEnv, ...segments: string[]): string {
  return join(env.SystemRoot ?? 'C:\\Windows', 'System32', ...segments)
}

export async function windowsIdentity(env: NodeJS.ProcessEnv): Promise<WindowsIdentity> {
  const whoami = systemTool(env, 'whoami.exe')
  const options = { windowsHide: true, timeout: 5000, encoding: 'utf8' as const }
  const { stdout: user } = await execFileAsync(whoami, ['/user', '/fo', 'csv', '/nh'], options)
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(user)?.[1]
  if (!sid) throw new Error('cannot read the user SID')
  const { stdout: groups } = await execFileAsync(whoami, ['/groups', '/fo', 'csv', '/nh'], options)
  return { sid, administrator: groups.includes(`"${ADMINISTRATORS_SID}"`) }
}
