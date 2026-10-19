/**
 * A manual clock for the fake helper. Every timestamp the fake emits (`ts`, `state_since`) and
 * every protocol timer (hello timeout, stats interval, grace period, startup timeout, write stall,
 * scripted command delays) comes from here, so tests never wait in real time and can assert exact
 * frames.
 */

export interface FakeTimer {
  readonly id: number
}

interface Scheduled {
  id: number
  due: number
  /** Insertion order, so timers due at the same instant fire in the order they were set. */
  order: number
  fn: () => void
}

export class FakeClock {
  private current: number
  private nextId = 1
  private timers: Scheduled[] = []

  /** Appendix B's hello happens at 1760000000000; the helper started 500 ms earlier. */
  constructor(start = 1759999999500) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  setTimeout(fn: () => void, ms: number): FakeTimer {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`bad timer delay ${ms}`)
    const id = this.nextId++
    this.timers.push({ id, due: this.current + ms, order: id, fn })
    return { id }
  }

  clearTimeout(timer: FakeTimer | null | undefined): void {
    if (!timer) return
    this.timers = this.timers.filter((t) => t.id !== timer.id)
  }

  /** Number of timers waiting to fire. */
  get pending(): number {
    return this.timers.length
  }

  /**
   * Moves time forward by `ms`, firing every timer that falls due on the way, in due order (ties
   * in insertion order). A timer's callback sees `now()` equal to its due time, and timers it sets
   * fire in the same call if they fall due before the target.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`bad advance ${ms}`)
    const target = this.current + ms
    for (;;) {
      const next = this.timers
        .filter((t) => t.due <= target)
        .sort((a, b) => a.due - b.due || a.order - b.order)[0]
      if (!next) break
      this.timers = this.timers.filter((t) => t.id !== next.id)
      // Never move backwards: a timer that was already overdue (after jumpTo) fires at "now".
      if (next.due > this.current) this.current = next.due
      next.fn()
    }
    this.current = target
  }

  /** Advances until `now()` equals `ts`, firing timers on the way. */
  advanceTo(ts: number): void {
    if (ts < this.current) throw new Error(`cannot advance backwards to ${ts} from ${this.current}`)
    this.advance(ts - this.current)
  }

  /**
   * Sets the time WITHOUT firing anything. Timers that are now overdue fire at the next
   * `advance()`. Appendix B's transcript needs this: its `quit` happens at 1760000020000 with a
   * live 1000 ms subscription and yet shows no stats events in between (see the README and
   * notes/fakenetd-ambiguities.md).
   */
  jumpTo(ts: number): void {
    if (ts < this.current) throw new Error(`cannot jump backwards to ${ts} from ${this.current}`)
    this.current = ts
  }
}
