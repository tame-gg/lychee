import { test as base, expect } from '@playwright/test'
import { uniqueControlPath } from './controlPath'
import { FakeClock } from './fakeClock'
import { FakeNetd, startFakeNetd, type FakeNetdOptions } from './fakeNetd'
import type { HelloResult, StateInfo } from './protocol'
import { TestClient } from './testClient'

/** Appendix B's hello request, used verbatim by most tests. */
export const HELLO_ARGS = { protocol: [1], client: 'lychee', client_version: '0.2.0' }

export type Response<T = Record<string, unknown>> =
  | { id: number | null; ok: true; result: T }
  | {
      id: number | null
      ok: false
      error: { code: string; message: string; data?: Record<string, unknown> }
    }

export type Event<T = Record<string, unknown>> = { event: string; seq: number; data: T }

export interface NetdHarness {
  /** A fresh control path for this test. */
  readonly path: string
  /** Starts at 1759999999500, so a hello 500 ms later lands on Appendix B's 1760000000000. */
  readonly clock: FakeClock
  /** Starts the fake with Appendix B's defaults unless overridden. */
  start(options?: Partial<Omit<FakeNetdOptions, 'path' | 'clock'>>): Promise<FakeNetd>
  /** A new raw client connected to `path`; closed at teardown. */
  connect(): Promise<TestClient>
  /** Sends hello (id 1) and reads its response and the state event that follows. */
  hello(
    client: TestClient,
    args?: Record<string, unknown>,
    id?: number
  ): Promise<{ response: Response<HelloResult>; state: Event<StateInfo> }>
  /** start + connect + hello, for tests that only care about commands. */
  session(options?: Partial<Omit<FakeNetdOptions, 'path' | 'clock'>>): Promise<{
    fake: FakeNetd
    client: TestClient
    hello: { response: Response<HelloResult>; state: Event<StateInfo> }
  }>
  /** Waits for one of the fake's events ('grace', 'sessionLost', 'session', 'exit', ...). */
  once<T = unknown>(fake: FakeNetd, event: string, timeoutMs?: number): Promise<T>
}

export const test = base.extend<{ netd: NetdHarness }>({
  // eslint-disable-next-line no-empty-pattern
  netd: async ({}, use) => {
    const control = uniqueControlPath()
    const clock = new FakeClock()
    const fakes: FakeNetd[] = []
    const clients: TestClient[] = []

    const harness: NetdHarness = {
      path: control.path,
      clock,
      async start(options = {}) {
        const fake = await startFakeNetd({ ...options, path: control.path, clock })
        fakes.push(fake)
        return fake
      },
      async connect() {
        const client = await TestClient.connect(control.path)
        clients.push(client)
        return client
      },
      async hello(client, args = HELLO_ARGS, id = 1) {
        await client.request({ id, cmd: 'hello', args })
        const response = await client.readJson<Response<HelloResult>>()
        if (!response.ok)
          return { response, state: { event: 'none', seq: 0, data: {} as StateInfo } }
        const state = await client.readJson<Event<StateInfo>>()
        return { response, state }
      },
      async session(options = {}) {
        const fake = await harness.start(options)
        const client = await harness.connect()
        const hello = await harness.hello(client)
        expect(hello.response.ok, JSON.stringify(hello.response)).toBe(true)
        return { fake, client, hello }
      },
      once<T>(fake: FakeNetd, event: string, timeoutMs = 2000): Promise<T> {
        return new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => {
            fake.off(event, handler)
            reject(new Error(`fake did not emit '${event}' within ${timeoutMs} ms`))
          }, timeoutMs)
          const handler = (value: T): void => {
            clearTimeout(timer)
            resolve(value)
          }
          fake.once(event, handler)
        })
      }
    }

    await use(harness)

    for (const client of clients) client.close()
    for (const fake of fakes) await fake.close()
    control.cleanup()
  }
})

export { expect }

/** The error part of a failed response, with a readable failure when it was a success. */
export function errorOf(res: Response<unknown>): {
  code: string
  message: string
  data?: Record<string, unknown>
} {
  expect(res.ok, `expected an error response, got ${JSON.stringify(res)}`).toBe(false)
  return (res as Extract<Response<unknown>, { ok: false }>).error
}

/** The result of a successful response, with a readable failure when it was an error. */
export function resultOf<T = Record<string, unknown>>(res: Response<T>): T {
  expect(res.ok, `expected a success response, got ${JSON.stringify(res)}`).toBe(true)
  return (res as Extract<Response<T>, { ok: true }>).result
}
