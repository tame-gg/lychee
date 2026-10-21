import type {
  MergeAdapter,
  MergeLinkState,
  MergeState,
  MergeStatus,
  NetworkInterfaceInfo,
  NetworkInterfaceKind
} from '@shared/types'

/** How a status reads: `active` merging, `idle` nothing to do, `busy` on its way, `attention`
 * something only the user can sort out, `error` it went wrong. */
export type MergeTone = 'active' | 'idle' | 'busy' | 'attention' | 'error'

export interface MergeStatusView {
  /** The status word beside the switch, and the sidebar dot's tooltip. */
  label: string
  tone: MergeTone
  /** A sentence under it saying what is going on or what to do, when there's more to say. */
  hint: string | null
}

const STATUS: Record<MergeStatus, { label: string; tone: MergeTone; hint: string | null }> = {
  off: { label: 'Off', tone: 'idle', hint: null },
  starting: { label: 'Starting…', tone: 'busy', hint: null },
  on: { label: 'Merging', tone: 'active', hint: null },
  paused_auto: {
    label: 'Paused: one connection',
    tone: 'idle',
    hint: 'Only one connection works right now. Combining picks up again once two do.'
  },
  error: { label: 'Error', tone: 'error', hint: null },
  reconnecting: { label: 'Reconnecting…', tone: 'busy', hint: null },
  stopped: {
    label: 'Helper stopped',
    tone: 'error',
    hint: 'Switch combining off and on to start it again.'
  },
  needs_permission: {
    label: 'Needs permission',
    tone: 'attention',
    hint: 'Combining connections needs an administrator’s approval. Switch it on again to be asked again.'
  },
  needs_admin: { label: 'Needs an administrator account', tone: 'attention', hint: null },
  not_installed: {
    label: 'Helper not installed',
    tone: 'attention',
    hint: 'The network helper that combines connections isn’t set up on this computer.'
  },
  out_of_date: {
    label: 'Helper out of date',
    tone: 'attention',
    hint: 'Update Lychee, or reinstall it, to get a network helper that matches.'
  },
  unsupported: {
    label: 'Unsupported here',
    tone: 'attention',
    hint: 'This computer can’t combine connections system-wide.'
  },
  another_tool: {
    label: 'Another connection-merging tool is running',
    tone: 'attention',
    hint: 'Quit or uninstall the other tool, then switch combining on again.'
  },
  unavailable: { label: 'Helper unavailable', tone: 'error', hint: null }
}

/** Every status word in one place: the page, the sidebar and the tests read them from here. */
export function mergeStatusView(
  state: Pick<MergeState, 'status' | 'message' | 'helper'>
): MergeStatusView {
  const entry = STATUS[state.status] ?? STATUS.unavailable
  const message = state.message?.trim() || null
  if (state.status === 'error') {
    return { ...entry, label: message ? `Error: ${message}` : 'Error', hint: null }
  }
  // Before a helper has answered, starting one may be waiting on the OS's administrator prompt.
  if (state.status === 'starting' && !state.helper) {
    return { ...entry, hint: 'Your computer may ask for an administrator’s password.' }
  }
  return { ...entry, hint: message && message !== entry.hint ? message : entry.hint }
}

/** The sidebar dot: teal merging, amber needing the user, red failed, grey otherwise. */
export function mergeToneColor(tone: MergeTone): string {
  switch (tone) {
    case 'active':
      return 'var(--color-wifi)'
    case 'attention':
      return 'var(--swatch-amber)'
    case 'error':
      return 'var(--color-danger)'
    default:
      return 'var(--icon-muted)'
  }
}

/** The kind of an adapter the helper names that Lychee's own list doesn't have (yet), from its
 * name, as the test interface list guesses it. */
export function guessKind(name: string): NetworkInterfaceKind {
  const lower = name.toLowerCase()
  if (/wi-?fi|wlan|wlp|airport|wireless/.test(lower)) return 'wifi'
  if (/usb|iphone|android|rndis|tether|enx/.test(lower)) return 'usb'
  return 'ethernet'
}

/** The helper's own adapter, which must never be offered as a connection to combine (L-5 hides it
 * from the interface list for good; until then, here). */
export function isMergeTun(iface: NetworkInterfaceInfo, tunName: string | null): boolean {
  if (tunName && iface.id === tunName) return true
  if (iface.id === 'lychee-netd') return true
  return iface.addresses.some(
    (address) =>
      address.address.startsWith('198.18.0.') ||
      address.address.toLowerCase().startsWith('fd6e:6d65:7267:')
  )
}

/** One row of the page: an adapter the helper reports, or before it has run, a network Lychee
 * sees — keyed by name, which is the interface id on every OS. */
export interface MergeRowModel {
  id: string
  kind: NetworkInterfaceKind
  osName: string
  adapter: MergeAdapter | null
  /** In the saved exclusion list: changes at once on a click, the helper's flag a tick later. */
  excluded: boolean
  /** A pinned weight, from the settings. */
  manualWeight: number | undefined
}

export function mergeRows(
  merging: MergeState,
  interfaces: NetworkInterfaceInfo[]
): MergeRowModel[] {
  const byId = new Map(interfaces.map((iface) => [iface.id, iface]))
  const row = (id: string, adapter: MergeAdapter | null): MergeRowModel => {
    const iface = byId.get(id)
    return {
      id,
      kind: iface?.kind ?? guessKind(id),
      osName: iface?.displayName ?? id,
      adapter,
      excluded: merging.settings.excluded.includes(id),
      manualWeight: merging.settings.weights[id]
    }
  }
  if (merging.adapters.length > 0) {
    return merging.adapters
      .filter((adapter) => adapter.present || adapter.active_flows > 0)
      .map((adapter) => row(adapter.name, adapter))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  return interfaces
    .filter((iface) => !isMergeTun(iface, merging.tun?.name ?? null))
    .map((iface) => row(iface.id, null))
}

export const LINK_STATE_TEXT: Record<MergeLinkState, string> = {
  none: '—',
  checking: 'Checking…',
  up: 'Online',
  down: 'No internet'
}

/** A weight as the table shows it: "1.0×", two decimals below one. */
export function formatWeight(weight: number): string {
  return `${weight >= 1 ? weight.toFixed(1) : weight.toFixed(2)}×`
}
