import type { DownloadState, FinishedDownload } from '@shared/types'
import type { DownloadFilter } from '../store/useAppStore'
import { isFinished } from './downloadActions'
import { FILE_KINDS, kindOfDownload, type FileKind } from './fileKind'

export type DownloadStatusKey = Exclude<DownloadFilter, 'all'>

export function statusOf(item: DownloadState | FinishedDownload): DownloadStatusKey {
  if (isFinished(item)) return 'finished'
  switch (item.status) {
    case 'completed':
      return 'finished'
    case 'error':
      return 'failed'
    case 'downloading':
    case 'queued':
      return item.status
    default:
      return 'paused'
  }
}

export function matchesFilter(
  item: DownloadState | FinishedDownload,
  filter: DownloadFilter,
  kind: FileKind | null
): boolean {
  return (
    (filter === 'all' || statusOf(item) === filter) &&
    (kind === null || kindOfDownload(item) === kind)
  )
}

export interface ListCounts {
  statuses: Record<DownloadFilter, number>
  kinds: Record<FileKind, number>
}

export function countItems(items: (DownloadState | FinishedDownload)[]): ListCounts {
  const statuses: Record<DownloadFilter, number> = {
    all: items.length,
    downloading: 0,
    queued: 0,
    paused: 0,
    failed: 0,
    finished: 0
  }
  const kinds = Object.fromEntries(FILE_KINDS.map(({ kind }) => [kind, 0])) as Record<
    FileKind,
    number
  >
  for (const item of items) {
    statuses[statusOf(item)]++
    kinds[kindOfDownload(item)]++
  }
  return { statuses, kinds }
}
