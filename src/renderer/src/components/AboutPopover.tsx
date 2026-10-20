import { INTERFACE_SIZES } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { LycheeMark } from './LycheeMark'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

const PLEXO_URL = 'https://github.com/anmolkapil/plexo'
const TAME_URL = 'https://tame.gg'
const REPO_URL = 'https://github.com/tame-gg/lychee'

/** Auto, or a fixed zoom for the window's content (see main/interfaceZoom.ts). Set once, so it
 * lives here rather than in the status bar with the toggles flipped day to day. */
function InterfaceSizeToggle(): React.JSX.Element {
  const interfaceSize = useAppStore((store) => store.interfaceSize)
  const setInterfaceSize = useAppStore((store) => store.setInterfaceSize)
  return (
    <div className="flex flex-col gap-1.5">
      <div id="interface-size-label" className="font-medium">
        Interface size
      </div>
      <ToggleGroup
        aria-labelledby="interface-size-label"
        value={[String(interfaceSize)]}
        onValueChange={(values) => {
          // Clicking the pressed one would unpress it; one size is always on.
          const size = INTERFACE_SIZES.find((option) => String(option) === values[0])
          if (size !== undefined) setInterfaceSize(size)
        }}
        size="xs"
        spacing={0.5}
        className="h-[28px] w-full rounded-[6px] border-[0.5px] border-border p-0.5"
      >
        {INTERFACE_SIZES.map((size) => (
          <ToggleGroupItem
            key={size}
            value={String(size)}
            className="h-full flex-1 rounded-[4px] px-1.5 text-[12px] font-medium text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground"
          >
            {size === 'auto' ? 'Auto' : `${size}%`}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="text-[11.5px] text-muted-foreground">
        Auto makes it a little smaller on displays scaled to 150% or more.
      </div>
    </div>
  )
}

/** About Lychee, in the status bar on every platform (macOS also has Lychee › About Lychee), with
 * the Interface size setting. */
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
        <div className="font-serif text-[20px] leading-[24px] font-normal text-muted-foreground">
          A{' '}
          <a
            href={TAME_URL}
            target="_blank"
            rel="noreferrer"
            className="text-foreground decoration-1 underline-offset-[3px] hover:underline"
          >
            tame<span className="tame-gg">.gg</span>
          </a>{' '}
          project
        </div>
        <div className="mt-1 flex items-center gap-2.5">
          <LycheeMark size={40} className="shrink-0" />
          <div className="flex flex-col">
            <div className="text-[14px] font-semibold">Lychee</div>
            <div className="font-mono text-[11.5px] text-muted-foreground">
              Version {__APP_VERSION__}
            </div>
          </div>
        </div>
        <div>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="underline">
            Source on GitHub
          </a>
        </div>
        <div>
          Based on{' '}
          <a href={PLEXO_URL} target="_blank" rel="noreferrer" className="underline">
            Plexo
          </a>{' '}
          by Anmol Kapil, MIT license.
        </div>
        <div className="my-1.5 border-t-[0.5px] border-border" />
        <InterfaceSizeToggle />
      </PopoverContent>
    </Popover>
  )
}
