import {
  ArrowDownToLine,
  CircleAlert,
  CircleCheck,
  Clock,
  Layers,
  Pause,
  type LucideIcon
} from 'lucide-react'
import type { DownloadFilter } from '../store/useAppStore'

export const STATUS_ENTRIES: {
  value: DownloadFilter
  label: string
  icon: LucideIcon
  color: string
  empty: string
}[] = [
  {
    value: 'all',
    label: 'All downloads',
    icon: Layers,
    color: 'var(--text-secondary)',
    empty: 'No downloads yet'
  },
  {
    value: 'downloading',
    label: 'Downloading',
    icon: ArrowDownToLine,
    color: 'var(--color-accent)',
    empty: 'Nothing downloading'
  },
  {
    value: 'queued',
    label: 'Queued',
    icon: Clock,
    color: 'var(--text-secondary)',
    empty: 'Nothing queued'
  },
  {
    value: 'paused',
    label: 'Paused',
    icon: Pause,
    color: 'var(--text-secondary)',
    empty: 'Nothing paused'
  },
  {
    value: 'failed',
    label: 'Needs attention',
    icon: CircleAlert,
    color: 'var(--color-danger)',
    empty: 'No downloads need attention'
  },
  {
    value: 'finished',
    label: 'Finished',
    icon: CircleCheck,
    color: 'var(--color-success)',
    empty: 'No finished downloads'
  }
]

export const statusEntry = (value: DownloadFilter): (typeof STATUS_ENTRIES)[number] =>
  STATUS_ENTRIES.find((entry) => entry.value === value)!
