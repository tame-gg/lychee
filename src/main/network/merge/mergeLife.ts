import type { MergeState, MergeStatus } from '../../../shared/types'

const ALIVE: ReadonlySet<MergeStatus> = new Set(['on', 'paused_auto', 'starting', 'reconnecting'])

export function mergeKeepsAlive(state: MergeState): boolean {
  return state.settings.enabled && ALIVE.has(state.status)
}

export function mergeTrayLabel(state: MergeState): string {
  switch (state.status) {
    case 'on':
      return 'Merging'
    case 'paused_auto':
      return 'Paused: one connection'
    case 'starting':
      return 'Starting…'
    case 'reconnecting':
      return 'Reconnecting…'
    case 'stopped':
      return 'Helper stopped unexpectedly'
    default:
      return 'Off'
  }
}
