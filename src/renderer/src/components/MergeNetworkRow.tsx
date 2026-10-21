import { MERGE_WEIGHT } from '@shared/mergeSettings'
import type { NetworkInterfaceKind } from '@shared/types'
import { EthernetPort, Usb, Wifi } from 'lucide-react'
import { useState } from 'react'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { DANGER, type NetworkVisual } from '../theme'
import { formatWeight, LINK_STATE_TEXT, type MergeRowModel } from '../utils/merge'
import { NetworkEditPopover } from './NetworkEditPopover'
import { TruncatedText } from './TruncatedText'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

// Status dot · Network · Internet · Flows · Weight · Speed, with the 20px gutters inside the
// first and last tracks as NETWORK_ROW_GRID_COLUMNS has them.
export const MERGE_ROW_GRID_COLUMNS =
  '30px minmax(200px, max-content) 1fr 56px 92px minmax(132px, max-content)'

const rowClass = 'col-span-full grid grid-cols-subgrid items-center gap-3'

const fieldLabelClass =
  'font-mono text-[9px] leading-none font-medium tracking-[0.12em] text-muted-foreground uppercase'

const KIND_ICON: Record<NetworkInterfaceKind, typeof Wifi> = {
  wifi: Wifi,
  usb: Usb,
  ethernet: EthernetPort,
  bridge: EthernetPort,
  other: EthernetPort
}

/** The weight cell: what the scheduler gives this connection now, and a popover to pin it. */
function WeightCell({
  row,
  visual,
  onWeight
}: {
  row: MergeRowModel
  visual: NetworkVisual
  onWeight: (weight: number | 'auto') => void
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const adapter = row.adapter
  const pinned = row.manualWeight !== undefined
  const shown = pinned ? row.manualWeight! : adapter && !row.excluded ? adapter.weight : null
  const parsed = Number(draft)
  const valid = draft.trim() !== '' && parsed >= MERGE_WEIGHT.min && parsed <= MERGE_WEIGHT.max

  const pin = (): void => {
    if (!valid) return
    onWeight(parsed)
    setOpen(false)
  }

  return (
    <div role="cell" className="flex justify-end">
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setDraft(String(row.manualWeight ?? adapter?.weight ?? 1))
          setOpen(next)
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    aria-label={`Weight of ${visual.name}`}
                    disabled={row.excluded}
                    className="h-auto cursor-default rounded-[4px] border-[0.5px] bg-card px-[7px] py-[3px] font-mono text-[10.5px] leading-none font-medium tabular-nums text-[var(--text-secondary)] dark:bg-card"
                  >
                    {shown === null ? '—' : formatWeight(shown)}
                    <span className="text-[9px] text-muted-foreground">
                      {pinned ? 'pinned' : 'auto'}
                    </span>
                  </Button>
                }
              />
            }
          />
          <TooltipContent>
            {adapter && adapter.peak_bps > 0
              ? `Measured at up to ${formatSpeed(adapter.peak_bps)} through the helper`
              : 'Not measured yet'}
          </TooltipContent>
        </Tooltip>
        <PopoverContent aria-label={`Weight of ${visual.name}`} className="w-60 gap-3 p-3">
          <div className="flex flex-col gap-[6px]">
            <label htmlFor={`merge-weight-${row.id}`} className={fieldLabelClass}>
              Weight
            </label>
            <input
              id={`merge-weight-${row.id}`}
              type="number"
              min={MERGE_WEIGHT.min}
              max={MERGE_WEIGHT.max}
              step={0.05}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') pin()
              }}
              autoFocus
              aria-invalid={!valid}
              className="rounded-[6px] border border-input bg-background px-[9px] py-1.5 font-mono text-[12px] leading-[1.3] text-foreground tabular-nums outline-none focus-visible:border-ring aria-invalid:border-destructive"
            />
            <p className="text-[11px] leading-[1.35] text-muted-foreground">
              How much new traffic this connection takes compared with the others. Automatic follows
              the speed measured on it.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={!pinned}
              onClick={() => {
                onWeight('auto')
                setOpen(false)
              }}
            >
              Automatic
            </Button>
            <Button type="button" size="xs" disabled={!valid} onClick={pin}>
              Pin
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** One connection on the Network page: whether it's combined, whether it reaches the internet,
 * how much of the traffic it takes and how fast it is going — the OS's own counters, every app's
 * traffic, not only Lychee's. */
export function MergeNetworkRow({
  row,
  visual,
  onSwitch,
  onWeight
}: {
  row: MergeRowModel
  visual: NetworkVisual
  onSwitch: (enabled: boolean) => void
  onWeight: (weight: number | 'auto') => void
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const adapter = row.adapter
  const used = !row.excluded
  const relaying = used && (adapter?.relayed_in_bps ?? 0) + (adapter?.relayed_out_bps ?? 0) > 0
  const down = used && adapter?.state === 'down' && adapter.state6 !== 'up'
  const moving = (adapter?.link_in_bps ?? 0) > 0
  const Icon = KIND_ICON[row.kind]
  const internet = !adapter
    ? '—'
    : row.excluded
      ? 'Not used'
      : adapter.state === 'none' && adapter.state6 !== 'none'
        ? LINK_STATE_TEXT[adapter.state6]
        : LINK_STATE_TEXT[adapter.state]

  return (
    <div
      role="row"
      aria-label={visual.name}
      className={`${rowClass} border-t-[0.5px] border-[var(--border-subtle)] py-[11px]`}
    >
      <div
        role="cell"
        aria-label={down ? 'No internet' : relaying ? 'Combining' : used ? 'Idle' : 'Not used'}
        className="ml-5 size-2 rounded-full"
        style={{
          background: down ? DANGER : used ? visual.solid : 'var(--icon-muted)',
          animation: relaying ? 'lychee-glow 1.8s infinite' : undefined,
          opacity: relaying || down ? 1 : 0.65
        }}
      />
      <div role="cell" className="flex min-w-0 items-center gap-[6px]">
        <Checkbox
          checked={used}
          onCheckedChange={(checked) => onSwitch(checked)}
          aria-label={`Combine ${visual.name}`}
          className="shrink-0 data-checked:border-transparent"
          style={used ? { background: visual.solid, color: visual.onSolid } : undefined}
        />
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <TruncatedText
          text={visual.name}
          className={`font-sans text-[12.5px] leading-[1.2] font-semibold ${used ? 'text-foreground' : 'text-[var(--text-secondary)]'}`}
        />
        <NetworkEditPopover interfaceId={row.id} interfaceKind={row.kind} osName={row.osName} />
        {visual.name !== row.osName && (
          <span className="rounded-[3px] border-[0.5px] border-border bg-secondary px-[4.5px] py-[1.5px] font-mono text-[9px] leading-none whitespace-nowrap text-muted-foreground">
            {row.osName}
          </span>
        )}
      </div>
      <div
        role="cell"
        className={`flex min-w-0 items-center gap-1.5 font-mono text-[11px] leading-none whitespace-nowrap ${down ? 'text-destructive' : 'text-[var(--text-secondary)]'}`}
      >
        <Tooltip disabled={!adapter?.ip}>
          <TooltipTrigger render={<span className="truncate">{internet}</span>} />
          <TooltipContent>{[adapter?.ip, adapter?.ip6].filter(Boolean).join(' · ')}</TooltipContent>
        </Tooltip>
        {used && adapter?.state6 === 'up' && (
          <span
            className="rounded-[3px] border-[0.5px] px-[4px] py-[1.5px] text-[9px] leading-none"
            style={{ background: visual.bg, borderColor: visual.border, color: visual.text }}
          >
            +IPv6
          </span>
        )}
      </div>
      <div role="cell" className="text-right font-mono text-[11px] leading-none tabular-nums">
        {adapter && used ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span tabIndex={0} className="rounded-sm text-foreground outline-none">
                  {adapter.active_flows}
                </span>
              }
            />
            <TooltipContent>
              {adapter.active_flows} open now · {adapter.total_flows} in all
              {adapter.failed_flows > 0 ? ` · ${adapter.failed_flows} failed` : ''}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
      <WeightCell row={row} visual={visual} onWeight={onWeight} />
      <div
        role="cell"
        className="pr-5 text-right font-mono text-[11px] leading-[1.35] font-semibold whitespace-nowrap tabular-nums"
        style={{ color: moving ? visual.text : 'var(--text-tertiary)' }}
      >
        <div>
          <span className="sr-only">Receiving at </span>
          <span aria-hidden>↓ </span>
          {adapter ? formatSpeed(adapter.link_in_bps) : '—'}
        </div>
        <div className="font-medium text-muted-foreground">
          <span className="sr-only">Sending at </span>
          <span aria-hidden>↑ </span>
          {adapter ? formatSpeed(adapter.link_out_bps) : '—'}
        </div>
      </div>
    </div>
  )
}
