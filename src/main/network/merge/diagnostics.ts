import { crc32 } from 'node:zlib'
import type { MergeState } from '../../../shared/types'
import { redactLogLine } from './netdLog'

export interface DiagnosticsOs {
  platform: string
  release: string
  arch: string
}

export interface DiagnosticsLog {
  name: string
  text: string
}

export interface DiagnosticsInput {
  lycheeVersion: string
  home: string
  os: DiagnosticsOs
  state: MergeState
  logs: DiagnosticsLog[]
}

interface ZipEntry {
  name: string
  data: Buffer
}

function redactValue(value: unknown, home: string): unknown {
  if (typeof value === 'string') return redactLogLine(value, home)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, home))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(item, home)
    }
    return out
  }
  return value
}

function redactText(text: string, home: string): string {
  return text
    .split('\n')
    .map((line) => redactLogLine(line, home))
    .join('\n')
}

function statusSnapshot(state: MergeState): Record<string, unknown> {
  return {
    status: state.status,
    message: state.message,
    helperState: state.helperState,
    helper: state.helper,
    capture: state.capture,
    autopause: state.autopause,
    ipv6: state.ipv6,
    tun: state.tun,
    stateSince: state.stateSince,
    totals: state.totals,
    adapters: state.adapters,
    skipped: state.skipped
  }
}

export function diagnosticsDocument(input: DiagnosticsInput): {
  files: { name: string; text: string }[]
} {
  const body = redactValue(
    {
      lycheeVersion: input.lycheeVersion,
      helperVersion: input.state.helper?.version ?? null,
      os: input.os,
      mergeSettings: input.state.settings,
      status: statusSnapshot(input.state)
    },
    input.home
  )
  return {
    files: [
      { name: 'diagnostics.json', text: `${JSON.stringify(body, null, 2)}\n` },
      ...input.logs.map((log) => ({ name: log.name, text: redactText(log.text, input.home) }))
    ]
  }
}

function dosStamp(date: Date): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value & 0xffff)
  return buffer
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

export function zipStore(entries: ZipEntry[], now = new Date()): Buffer {
  const stamp = dosStamp(now)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const sum = crc32(entry.data) >>> 0
    const size = entry.data.length
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(stamp.time),
      u16(stamp.date),
      u32(sum),
      u32(size),
      u32(size),
      u16(name.length),
      u16(0),
      name,
      entry.data
    ])
    locals.push(local)
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(stamp.time),
        u16(stamp.date),
        u32(sum),
        u32(size),
        u32(size),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name
      ])
    )
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0)
  ])
  return Buffer.concat([...locals, central, end])
}

export function buildDiagnosticsZip(input: DiagnosticsInput, now = new Date()): Buffer {
  const document = diagnosticsDocument(input)
  return zipStore(
    document.files.map((file) => ({ name: file.name, data: Buffer.from(file.text) })),
    now
  )
}
