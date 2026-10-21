import type {
  MergeOptionsPatch,
  MergeSettings,
  MergeState,
  MergeStatus,
  NetworkPageMode
} from '@shared/types'
import { createMockMergeBackend } from './mockMergeBackend'

/** Everything the Network page and the store's merge slice need from whatever combines the
 * connections, named as window.lychee names it: the helper through the main process, or a
 * simulation of it (see mockMergeBackend.ts). */
export interface MergeBackend {
  mergeState: () => Promise<MergeState>
  /** Every state change, at most about once a second while stats flow. Returns unsubscribe. */
  onMergeState: (callback: (state: MergeState) => void) => () => void
  setMerging: (on: boolean) => Promise<void>
  setMergeOptions: (patch: MergeOptionsPatch) => Promise<void>
  setMergeNetwork: (id: string, enabled: boolean) => Promise<void>
  setMergeWeight: (id: string, weight: number | 'auto') => Promise<void>
  repairNetwork: () => Promise<void>
}

/** The real one: the MergeController in the main process, over IPC. */
export function lycheeMergeBackend(): MergeBackend {
  const api = window.lychee
  return {
    mergeState: () => api.mergeState(),
    onMergeState: (callback) => api.onMergeState(callback),
    setMerging: (on) => api.setMerging(on),
    setMergeOptions: (patch) => api.setMergeOptions(patch),
    setMergeNetwork: (id, enabled) => api.setMergeNetwork(id, enabled),
    setMergeWeight: (id, weight) => api.setMergeWeight(id, weight),
    repairNetwork: () => api.repairNetwork()
  }
}

/** The simulation only when the page asked for it; otherwise the helper, page shown or not. */
export function selectMergeBackend(mode: NetworkPageMode, settings: MergeSettings): MergeBackend {
  if (mode === 'mock' || mode.startsWith('mock:')) {
    const outcome = (mode.slice('mock:'.length) || undefined) as MergeStatus | undefined
    return createMockMergeBackend({ settings, outcome })
  }
  return lycheeMergeBackend()
}
