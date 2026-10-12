import { TITLE_BAR_HEIGHT } from '../theme'

const isMac = window.lychee.platform === 'darwin'

/** The window's title bar, the same on every OS: its name, centered, on a strip the window is
 * dragged by. The OS's own controls sit over it (see main/index.ts): macOS's traffic lights at
 * the left, Windows' and Linux's minimize/maximize/close at the right. */
export function TitleBar(): React.JSX.Element {
  return (
    <div
      style={{ height: TITLE_BAR_HEIGHT }}
      className={`flex shrink-0 items-center justify-center border-b-[0.5px] border-border bg-card [-webkit-app-region:drag] ${
        // Clear of the controls on either side, so the name stays centered between them.
        isMac ? 'px-[94px]' : 'px-[140px]'
      }`}
    >
      <div className="truncate font-sans text-[11px] leading-none font-semibold tracking-[0.16em] text-[var(--text-tertiary)] uppercase">
        Lychee
      </div>
    </div>
  )
}
