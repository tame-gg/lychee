import { connect } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface ControlHello {
  raw: string
  message: {
    ok?: boolean
    result?: {
      protocol?: number
      helper_version?: string
      auth?: { model?: string; authorized_uid?: number; authorized_sid?: string }
      capture?: { available?: boolean }
    }
  }
}

const HELLO =
  '{"id":1,"cmd":"hello","args":{"protocol":[1],"client":"smoke","client_version":"0.0.0"}}\n'

export function controlHandshake(path: string, timeoutMs = 8000): Promise<ControlHello | null> {
  return new Promise((resolveHandshake, reject) => {
    const socket = connect(path)
    let buf = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`timed out talking to ${path}`)), timeoutMs)
    const finish = (error?: Error, value: ControlHello | null = null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolveHandshake(value)
    }
    socket.on('error', (error) => finish(error))
    socket.on('end', () => finish(undefined, null))
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.includes('"helper_version"') || line.includes('"ok"')) {
          try {
            finish(undefined, { raw: line, message: JSON.parse(line) as ControlHello['message'] })
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
          return
        }
        nl = buf.indexOf('\n')
      }
    })
    socket.once('connect', () => {
      socket.write(HELLO)
    })
  })
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return pathToFileURL(resolve(entry)).href === import.meta.url
}

if (isMain()) {
  const flag = process.argv.indexOf('--handshake')
  const path = flag >= 0 ? process.argv[flag + 1] : process.argv[2]
  if (!path) {
    console.error('usage: netd-handshake.mts --handshake <control-path>')
    process.exit(1)
  }
  controlHandshake(path)
    .then((hello) => {
      if (!hello) {
        console.log('refused')
        process.exit(2)
      }
      console.log(hello.raw)
      process.exit(hello.message.ok ? 0 : 1)
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
}
