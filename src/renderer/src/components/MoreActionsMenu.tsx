import { Ellipsis } from 'lucide-react'
import { Fragment } from 'react'
import type { AvailableAction } from '../utils/downloadActions'
import { useDownloadActions } from './downloadActionsContext'
import { ACTION_META, menuLabel } from './downloadActionMeta'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** "More actions": on the selection toolbar, what the right-click menu offers for the selection,
 * less what has a button of its own (same items, names, order and groups); on a download's own
 * screen, the ways out of it. Destructive ones are red here, and only here, and still ask before
 * they do anything. Nothing, when there's nothing to offer. */
export function MoreActionsMenu({
  groups,
  disabled = false,
  size = 'icon-sm'
}: {
  groups: AvailableAction[][]
  disabled?: boolean
  /** To sit level with the buttons beside it. */
  size?: 'icon-sm' | 'icon'
}): React.JSX.Element | null {
  const { perform } = useDownloadActions()
  if (groups.length === 0) return null
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size={size}
                  variant="secondary"
                  aria-label="More actions"
                  disabled={disabled}
                >
                  <Ellipsis />
                </Button>
              }
            />
          }
        />
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        {groups.map((group, index) => (
          <Fragment key={group[0].id}>
            {index > 0 && <DropdownMenuSeparator />}
            {group.map(({ id, targets }) => {
              const meta = ACTION_META[id]
              return (
                <DropdownMenuItem
                  key={id}
                  variant={meta.destructive ? 'destructive' : 'default'}
                  onClick={() => void perform(id, targets)}
                >
                  <meta.icon aria-hidden />
                  {menuLabel(id, targets)}
                </DropdownMenuItem>
              )
            })}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
