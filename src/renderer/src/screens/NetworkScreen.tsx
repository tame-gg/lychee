import { MERGE_HISTORY_SECONDS } from '@shared/types'
import { AlertTriangle, ChevronLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BigStat } from '../components/BigStat'
import { CombineDiagram } from '../components/CombineDiagram'
import { HeroBand } from '../components/HeroBand'
import { MERGE_ROW_GRID_COLUMNS, MergeNetworkRow } from '../components/MergeNetworkRow'
import { ScreenFooter } from '../components/ScreenFooter'
import { ThroughputChart } from '../components/ThroughputChart'
import { Button } from '../components/ui/button'
import { Switch } from '../components/ui/switch'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { mergeBackend, useAppStore } from '../store/useAppStore'
import { mergeRows, mergeStatusView, type MergeTone } from '../utils/merge'

const TONE_CLASS: Record<MergeTone, string> = {
  active: 'text-[var(--color-wifi-text)]',
  busy: 'text-muted-foreground',
  idle: 'text-muted-foreground',
  attention: 'text-[var(--color-usb-text)]',
  error: 'text-destructive'
}

const sectionLabelClass =
  'font-mono text-[9.5px] leading-none font-medium tracking-[0.12em] text-muted-foreground uppercase'

function Option({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex items-start justify-between gap-6 py-2.5">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[12.5px] leading-[1.2] font-medium text-foreground">{label}</span>
        <span className="text-[11.5px] leading-[1.35] text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={(next) => onChange(next)} />
    </label>
  )
}

/** Combining connections system-wide (lychee-netd): every app's traffic over every connection at
 * once, as opposed to Lychee's own downloads, which use them without it. The switch, the
 * combined speed and each connection's share, and the few choices the helper has. */
export function NetworkScreen(): React.JSX.Element {
  const merging = useAppStore((store) => store.merging)
  const interfaces = useAppStore((store) => store.interfaces)
  const setView = useAppStore((store) => store.setView)
  const setMerging = useAppStore((store) => store.setMerging)
  const setMergeOptions = useAppStore((store) => store.setMergeOptions)
  const setMergeNetwork = useAppStore((store) => store.setMergeNetwork)
  const setMergeWeight = useAppStore((store) => store.setMergeWeight)
  const formatSpeed = useFormatSpeed()
  const networkVisual = useNetworkVisuals()
  const [repair, setRepair] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null
  })

  useEffect(() => {
    document.title = 'Lychee — Network'
    return () => {
      document.title = 'Lychee'
    }
  }, [])

  const status = mergeStatusView(merging)
  const running = merging.helper !== null && merging.totals !== null
  const merged = merging.status === 'on'
  const rows = mergeRows(merging, interfaces)
  const visuals = rows.map((row) => networkVisual(row.id, row.kind, row.osName))
  // The diagram and chart draw the connections the OS counts traffic on, combined or not.
  const present = rows
    .map((row, index) => ({ row, visual: visuals[index] }))
    .filter(({ row }) => row.adapter?.present)
  const combined = present.filter(({ row }) => !row.excluded)
  const [downValue, downUnit] = running
    ? formatSpeed(merging.totals!.link_in_bps).split(' ')
    : ['—', undefined]
  const problem = status.tone === 'attention' || status.tone === 'error'

  const runRepair = (): void => {
    setRepair({ busy: true, error: null })
    mergeBackend
      .repairNetwork()
      .then(() => setRepair({ busy: false, error: null }))
      .catch((error: unknown) =>
        setRepair({
          busy: false,
          error: (error instanceof Error ? error.message : String(error)).replace(
            /^Error invoking remote method '[^']+': (Error: )?/,
            ''
          )
        })
      )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-border px-5">
        <button
          type="button"
          onClick={() => setView({ name: 'list' })}
          className="-ml-2 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 font-sans text-[15px] leading-none font-medium text-[var(--text-secondary)] hover:text-foreground"
        >
          <ChevronLeft className="size-4.5 shrink-0" />
          <span className="truncate">Downloads</span>
        </button>
        <h1 className="shrink-0 font-sans text-[14px] leading-none font-semibold">Network</h1>
        <div className="flex-1" />
        <span
          role="status"
          aria-label="Combining status"
          className={`min-w-0 truncate font-mono text-[11px] leading-none font-medium ${TONE_CLASS[status.tone]}`}
        >
          {status.label}
        </span>
        <label className="flex shrink-0 items-center gap-2 text-[12.5px] font-medium">
          Combine connections
          <Switch
            checked={merging.settings.enabled}
            onCheckedChange={(on) => setMerging(on)}
            aria-label="Combine connections"
          />
        </label>
      </div>

      <HeroBand>
        <div className="flex items-center gap-[14px]">
          <CombineDiagram
            networks={(present.length > 0
              ? combined
              : rows.map((row, index) => ({ row, visual: visuals[index] }))
            ).map(({ row, visual }) => ({
              solid: visual.solid,
              label: visual.name,
              speedBytesPerSec: row.adapter?.link_in_bps
            }))}
            muted={!running}
            paused={running && !merged}
          />
          <div className="flex min-w-[130px] shrink-0 flex-col gap-[7px]">
            <BigStat
              label="TOTAL ↓"
              value={downValue}
              unit={downUnit}
              valueClass={running ? 'text-foreground' : 'text-muted-foreground'}
            />
            <div className="flex items-center gap-2 font-mono text-[10px] leading-none font-medium tabular-nums text-muted-foreground">
              <span>
                ↑{' '}
                <span className="font-semibold text-foreground">
                  {running ? formatSpeed(merging.totals!.link_out_bps) : '—'}
                </span>
              </span>
              <span className="opacity-35">·</span>
              <span>
                FLOWS{' '}
                <span className="font-semibold text-foreground">
                  {running ? merging.totals!.active_flows : '—'}
                </span>
              </span>
            </div>
            <div
              className={`font-mono text-[10px] leading-none font-medium tracking-[0.08em] uppercase ${TONE_CLASS[status.tone]}`}
            >
              {status.tone === 'error' ? 'Error' : status.label}
            </div>
          </div>
          <div
            className={`ml-auto min-w-0 max-w-[640px] flex-1 transition-opacity duration-200 ${
              running ? 'opacity-100' : 'opacity-45'
            }`}
          >
            <div className="font-mono text-[9.5px] leading-none font-medium tracking-[0.12em] text-muted-foreground">
              ALL APPS · LAST {MERGE_HISTORY_SECONDS}S
            </div>
            <ThroughputChart
              order={present.map(({ row, visual }) => ({
                interfaceId: row.id,
                solid: visual.solid,
                name: visual.name
              }))}
              historyByInterface={merging.history.down}
              endsAt={running ? 'now' : 'pause'}
            />
          </div>
        </div>
      </HeroBand>

      {(status.hint || repair.error) && (
        <div
          role={problem || repair.error ? 'alert' : 'status'}
          className={`flex items-start gap-2 border-b-[0.5px] border-border px-5 py-2.5 text-[12px] leading-[1.4] ${
            problem || repair.error ? 'text-foreground' : 'text-muted-foreground'
          }`}
        >
          {(problem || repair.error) && (
            <AlertTriangle
              aria-hidden
              className={`mt-px size-3.5 shrink-0 ${status.tone === 'error' || repair.error ? 'text-destructive' : 'text-[var(--swatch-amber)]'}`}
            />
          )}
          <span>{repair.error ?? status.hint}</span>
        </div>
      )}
      {merging.status === 'off' && !merging.helper && (
        <p className="border-b-[0.5px] border-border px-5 py-2.5 text-[12px] leading-[1.4] text-muted-foreground">
          Combining sends every app’s traffic over all of the connections below at once. Lychee’s
          own downloads already use them without it.
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-4">
        <div
          role="table"
          aria-label="Connections"
          className="grid gap-x-3"
          style={{ gridTemplateColumns: MERGE_ROW_GRID_COLUMNS }}
        >
          <div
            role="row"
            className="sticky top-0 z-10 col-span-full grid grid-cols-subgrid gap-x-3 border-b border-border bg-background pt-2.5 pb-[7px] font-mono text-[9.5px] leading-none tracking-[0.12em] text-muted-foreground uppercase"
          >
            <div role="columnheader" aria-label="Status" />
            <div role="columnheader">Connection</div>
            <div role="columnheader">Internet</div>
            <div role="columnheader" className="text-right">
              Flows
            </div>
            <div role="columnheader" className="text-right">
              Weight
            </div>
            <div role="columnheader" className="pr-5 text-right">
              Speed
            </div>
          </div>
          {rows.map((row, index) => (
            <MergeNetworkRow
              key={row.id}
              row={row}
              visual={visuals[index]}
              onSwitch={(enabled) => setMergeNetwork(row.id, enabled)}
              onWeight={(weight) => setMergeWeight(row.id, weight)}
            />
          ))}
        </div>
        {rows.length === 0 && (
          <p role="status" className="px-5 py-6 text-center text-[12.5px] text-muted-foreground">
            No connections found.
          </p>
        )}

        {merging.skipped.length > 0 && (
          <section aria-label="Also seen but not used" className="px-5 pt-5">
            <h2 className={sectionLabelClass}>Also seen but not used</h2>
            <ul className="mt-2 flex flex-col gap-1.5">
              {merging.skipped.map((entry) => (
                <li
                  key={entry.name}
                  className="flex items-baseline gap-2 text-[12px] leading-[1.3]"
                >
                  <span className="font-mono text-[11px] font-medium text-[var(--text-secondary)]">
                    {entry.name}
                  </span>
                  <span className="text-muted-foreground">{entry.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="Options" className="px-5 pt-5">
          <h2 className={sectionLabelClass}>Options</h2>
          <div className="mt-1 flex max-w-[560px] flex-col divide-y-[0.5px] divide-border">
            <Option
              label="Pause by itself when only one connection works"
              hint="Combining one connection only slows it down. It picks up again once two work."
              checked={merging.settings.autoPause}
              onChange={(autoPause) => setMergeOptions({ autoPause })}
            />
            <Option
              label="Use IPv6 only when every connection has it"
              hint={
                merging.ipv6?.detail ??
                'Otherwise apps that prefer IPv6 would only use the connections that have it.'
              }
              checked={merging.settings.ipv6 === 'auto'}
              onChange={(auto) => setMergeOptions({ ipv6: auto ? 'auto' : 'on' })}
            />
          </div>
        </section>
      </div>

      <ScreenFooter className="justify-between">
        <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">
          {merging.helper
            ? `Network helper ${merging.helper.version} · ${merging.helper.os}/${merging.helper.arch}`
            : 'Network helper not running'}
        </span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!merging.helper || merging.helperState !== 'off' || repair.busy}
          onClick={runRepair}
        >
          {repair.busy ? 'Repairing…' : 'Repair network settings'}
        </Button>
      </ScreenFooter>
    </div>
  )
}
