import type { MergeSettings, MergeState } from './types'

export const DEFAULT_MERGE_SETTINGS: MergeSettings = {
  enabled: false,
  ipv6: 'auto',
  autoPause: true,
  excluded: [],
  weights: {}
}

export const MERGE_WEIGHT = { min: 0.05, max: 100 } as const
export const MERGE_ADAPTER_NAME_BYTES = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validAdapterName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (new TextEncoder().encode(value).length > MERGE_ADAPTER_NAME_BYTES) return false
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

export function validWeight(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MERGE_WEIGHT.min &&
    value <= MERGE_WEIGHT.max
  )
}

export function sanitizeMergeSettings(parsed: unknown): MergeSettings {
  const settings: MergeSettings = { ...DEFAULT_MERGE_SETTINGS, excluded: [], weights: {} }
  if (!isRecord(parsed)) return settings
  if (parsed.enabled === true) settings.enabled = true
  if (parsed.ipv6 === 'on' || parsed.ipv6 === 'off') settings.ipv6 = parsed.ipv6
  if (parsed.autoPause === false) settings.autoPause = false
  if (Array.isArray(parsed.excluded)) {
    settings.excluded = [...new Set(parsed.excluded.filter(validAdapterName))]
  }
  if (isRecord(parsed.weights)) {
    for (const [name, weight] of Object.entries(parsed.weights)) {
      if (validAdapterName(name) && validWeight(weight)) settings.weights[name] = weight
    }
  }
  return settings
}

export function initialMergeState(settings: MergeSettings): MergeState {
  return {
    seq: 0,
    status: 'off',
    message: null,
    settings,
    helper: null,
    helperState: null,
    capture: null,
    autopause: null,
    ipv6: null,
    tun: null,
    stateSince: null,
    totals: null,
    adapters: [],
    skipped: [],
    discoverySeq: 0,
    history: { down: {}, up: {} }
  }
}
