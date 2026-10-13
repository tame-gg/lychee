import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const PLEXO_URL = 'https://github.com/anmolkapil/plexo'

/** About Lychee, in the status bar on every platform (macOS also has Lychee › About Lychee). */
export function AboutPopover(): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="hover:text-foreground [-webkit-app-region:no-drag]"
            aria-label="About Lychee"
          />
        }
      >
        About
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] gap-1.5 text-[12.5px]">
        <div className="text-[14px] font-semibold">Lychee</div>
        <div className="text-muted-foreground">A tame.gg project.</div>
        <div>
          Based on{' '}
          <a href={PLEXO_URL} target="_blank" rel="noreferrer" className="underline">
            Plexo
          </a>{' '}
          by Anmol Kapil, MIT license.
        </div>
      </PopoverContent>
    </Popover>
  )
}
