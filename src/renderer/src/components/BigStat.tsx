/** The hero band's headline figure: a tracked-out label over one big tabular number and its unit. */
export function BigStat({
  label,
  value,
  unit,
  valueClass,
  note
}: {
  label: string
  value: string | number
  unit?: string
  valueClass: string
  /** Beside the label, e.g. a warning about what holds the value down. */
  note?: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <div className="flex items-center gap-1.5 font-mono text-[10px] leading-none font-medium tracking-[0.2em] text-muted-foreground">
        {label}
        {note}
      </div>
      <div className="flex items-baseline gap-[7px]">
        <div
          className={`font-serif text-[44px] leading-[0.88] font-normal tracking-[-0.01em] tabular-nums ${valueClass}`}
        >
          {value}
        </div>
        {unit && (
          <div className="font-mono text-[12px] leading-none font-medium text-muted-foreground">
            {unit}
          </div>
        )}
      </div>
    </>
  )
}
