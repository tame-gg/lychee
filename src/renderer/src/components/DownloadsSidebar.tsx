import { cn } from 'cn'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useAppStore, type DownloadFilter } from '../store/useAppStore'
import type { ListCounts } from '../utils/downloadList'
import { FILE_KINDS, type FileKind } from '../utils/fileKind'
import { FileKindIcon } from './FileKindIcon'
import { STATUS_ENTRIES } from './statusEntries'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

function Item({
  active,
  onClick,
  count,
  label,
  collapsed,
  children
}: {
  active: boolean
  onClick: () => void
  count: number
  label: string
  collapsed: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const button = (
    <button
      type="button"
      aria-pressed={active}
      aria-label={collapsed ? `${label}, ${count}` : undefined}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full shrink-0 items-center rounded-md text-[12.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
        collapsed ? 'justify-center' : 'gap-2.5 px-2 text-left',
        active
          ? 'bg-primary/10 text-foreground hover:bg-primary/15'
          : 'text-[var(--text-secondary)] hover:bg-secondary hover:text-foreground'
      )}
    >
      {children}
      {!collapsed && (
        <span
          className={cn(
            'font-mono text-[11px] tabular-nums',
            count === 0 ? 'text-muted-foreground/60' : 'text-muted-foreground'
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
  if (!collapsed) return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right">
        {label} ({count})
      </TooltipContent>
    </Tooltip>
  )
}

const labelClass =
  'px-2 pt-4 pb-1.5 font-mono text-[10px] leading-none font-medium tracking-[0.16em] text-muted-foreground uppercase'

export function DownloadsSidebar({
  counts,
  filter,
  kind,
  onFilter,
  onKind
}: {
  counts: ListCounts
  filter: DownloadFilter
  kind: FileKind | null
  onFilter: (filter: DownloadFilter) => void
  onKind: (kind: FileKind | null) => void
}): React.JSX.Element {
  const collapsed = useAppStore((store) => store.sidebarCollapsed)
  const setCollapsed = useAppStore((store) => store.setSidebarCollapsed)
  const Toggle = collapsed ? PanelLeftOpen : PanelLeftClose
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  const section = (text: string): React.JSX.Element =>
    collapsed ? (
      <div aria-hidden className="mx-2 my-2 h-px shrink-0 bg-border" />
    ) : (
      <h2 className={labelClass}>{text}</h2>
    )
  return (
    <nav
      aria-label="Download categories"
      className={cn(
        'flex shrink-0 flex-col gap-0.5 overflow-x-hidden overflow-y-auto border-r-[0.5px] border-border bg-card p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        collapsed ? 'w-[52px]' : 'w-[188px]'
      )}
    >
      <div className={cn('flex shrink-0 items-center', collapsed ? 'justify-center' : 'pl-2')}>
        {!collapsed && (
          <span className="flex-1 font-mono text-[10px] leading-none font-medium tracking-[0.16em] text-muted-foreground uppercase">
            Status
          </span>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => setCollapsed(!collapsed)}
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Toggle aria-hidden className="size-4" />
              </button>
            }
          />
          <TooltipContent side="right">{toggleLabel}</TooltipContent>
        </Tooltip>
      </div>
      {collapsed && section('Status')}
      {STATUS_ENTRIES.map((entry) => {
        const Icon = entry.icon
        return (
          <Item
            key={entry.value}
            active={filter === entry.value}
            count={counts.statuses[entry.value]}
            label={entry.label}
            collapsed={collapsed}
            onClick={() => onFilter(entry.value)}
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <Icon aria-hidden className="size-4" style={{ color: entry.color }} />
            </span>
            {!collapsed && <span className="min-w-0 flex-1 truncate">{entry.label}</span>}
          </Item>
        )
      })}
      {section('File type')}
      {FILE_KINDS.map((entry) => (
        <Item
          key={entry.kind}
          active={kind === entry.kind}
          count={counts.kinds[entry.kind]}
          label={entry.label}
          collapsed={collapsed}
          onClick={() => onKind(kind === entry.kind ? null : entry.kind)}
        >
          <FileKindIcon kind={entry.kind} size="sm" />
          {!collapsed && <span className="min-w-0 flex-1 truncate">{entry.label}</span>}
        </Item>
      ))}
    </nav>
  )
}
