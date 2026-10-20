import {
  Disc3,
  File,
  FileArchive,
  FileText,
  Film,
  Image,
  Magnet,
  Music,
  Package,
  type LucideIcon
} from 'lucide-react'
import { cn } from 'cn'
import type { FileKind } from '../utils/fileKind'

const ICONS: Record<FileKind, LucideIcon> = {
  video: Film,
  audio: Music,
  archive: FileArchive,
  document: FileText,
  program: Package,
  image: Image,
  torrent: Magnet,
  disk: Disc3,
  other: File
}

export function FileKindIcon({
  kind,
  size = 'md',
  className,
  icon
}: {
  kind: FileKind
  size?: 'sm' | 'md' | 'lg'
  className?: string
  icon?: LucideIcon
}): React.JSX.Element {
  const Icon = icon ?? ICONS[kind]
  return (
    <span
      aria-hidden
      data-kind={kind}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md',
        size === 'sm' && 'size-5 [&>svg]:size-3',
        size === 'md' && 'size-8 [&>svg]:size-4',
        size === 'lg' && 'size-10 rounded-lg [&>svg]:size-[18px]',
        className
      )}
      style={{ background: `var(--kind-${kind}-bg)`, color: `var(--kind-${kind})` }}
    >
      <Icon strokeWidth={2} />
    </span>
  )
}
