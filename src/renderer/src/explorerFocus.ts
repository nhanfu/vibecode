/**
 * Ctrl+E for the Files list of the agent sidebar (ExplorerNav.tsx). Outside the list it shows the
 * sidebar and puts the cursor in the list; inside it, it opens the folder under the cursor. The list
 * registers itself while it is on screen; a request made before it mounts waits for that.
 */
interface Live {
  openCursor: () => void
  focus: () => void
}

let live: Live | null = null
let wanted = false

export function setExplorerLive(next: Live | null): void {
  live = next
  if (next && wanted) {
    wanted = false
    next.focus()
  }
}

/** A list that unmounts clears the registration only if it is still the one registered. */
export function releaseExplorer(mine: Live): void {
  if (live === mine) live = null
}

export function explorerHasFocus(): boolean {
  return !!document.activeElement?.closest('.explorer-nav')
}

/** `reveal` shows the agent sidebar and its Files group when they are folded or hidden. */
export function explorerCtrlE(reveal: () => void): void {
  if (explorerHasFocus()) {
    live?.openCursor()
    return
  }
  reveal()
  if (live) live.focus()
  else wanted = true
}
