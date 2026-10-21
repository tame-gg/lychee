import type { NetworkInterfaceKind } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { assignNetworkColors, resolveNetworkVisual, type NetworkVisual } from '../theme'
import { guessKind } from '../utils/merge'

export type ResolveNetworkVisual = (
  id: string,
  kind: NetworkInterfaceKind,
  osName: string
) => NetworkVisual

/** Colors are assigned across every known network at once (detected interfaces, any a download,
 * running or finished, used, and any the network helper reports), so each screen agrees on which
 * network is which color. */
export function useNetworkVisuals(): ResolveNetworkVisual {
  const interfaces = useAppStore((store) => store.interfaces)
  const downloads = useAppStore((store) => store.downloads)
  const history = useAppStore((store) => store.history)
  const preferences = useAppStore((store) => store.networkPreferences)
  // As one string, so a stats push with the same adapters re-renders nothing.
  const mergeAdapters = useAppStore((store) =>
    store.merging.adapters.map((adapter) => adapter.name).join('\n')
  )

  const networks = new Map<string, NetworkInterfaceKind>()
  for (const iface of interfaces) networks.set(iface.id, iface.kind)
  for (const download of [...Object.values(downloads), ...history]) {
    for (const network of download.networks) {
      if (!networks.has(network.id)) networks.set(network.id, network.kind)
    }
  }
  for (const name of mergeAdapters ? mergeAdapters.split('\n') : []) {
    if (!networks.has(name)) networks.set(name, guessKind(name))
  }
  const colors = assignNetworkColors(networks, preferences)

  return (id, kind, osName) =>
    resolveNetworkVisual(kind, osName, preferences[id], colors.get(id) ?? 'teal')
}
