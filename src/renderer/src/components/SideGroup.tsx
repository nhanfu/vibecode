import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { load, save } from '../localPref'

/** id of the one sidebar group that is open (kept on this machine); null when all are folded */
const OPEN_KEY = 'vibe.sideOpen'
const DEFAULT_OPEN = 'agents'
/** fired on window with the id of the group that opened (null: none), every group listens */
const OPEN_EVENT = 'side-group-open'

const loadOpen = (): string | null =>
  load<string | null>(
    OPEN_KEY,
    (v) => {
      const x: unknown = JSON.parse(v)
      return typeof x === 'string' ? x : null
    },
    DEFAULT_OPEN,
  )

/** Opens one group and folds all the others. */
function openGroup(id: string | null): void {
  save(OPEN_KEY, JSON.stringify(id))
  window.dispatchEvent(new CustomEvent<string | null>(OPEN_EVENT, { detail: id }))
}

/**
 * A sidebar list under a label that folds it: click the label (or Enter / Space on it) to open it.
 * Only one group is open at a time: opening one folds the rest, and clicking the open one folds it.
 * `actions` sit at the right of the label and do not fold it. The open group is remembered.
 * Children are only mounted while the group is open, so nothing inside loads before that.
 */
export function SideGroup(props: {
  id: string
  label: string
  count?: number
  actions?: React.ReactNode
  always?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { id, label, count, actions, always, children } = props
  const [collapsed, setCollapsed] = useState(() => !always && loadOpen() !== id)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (always) return
    const onOpen = (e: Event): void => {
      setCollapsed((e as CustomEvent<string | null>).detail !== id)
    }
    // a command (Show Explorer, Show Source Control) asks for this group: open it and bring it into view
    const reveal = (e: Event): void => {
      if ((e as CustomEvent<string>).detail !== id) return
      openGroup(id)
      requestAnimationFrame(() => box.current?.scrollIntoView({ block: 'nearest' }))
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    window.addEventListener('side-group-reveal', reveal)
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen)
      window.removeEventListener('side-group-reveal', reveal)
    }
  }, [id, always])
  const toggle = (): void => openGroup(collapsed ? id : null)
  return (
    <div className="side-group" ref={box}>
      <div
        className={always ? 'side-group-label' : 'side-group-label collapsible'}
        role={always ? undefined : 'button'}
        tabIndex={always ? undefined : 0}
        aria-expanded={always ? undefined : !collapsed}
        title={always || !collapsed ? undefined : 'Expand'}
        onClick={always ? undefined : toggle}
        onKeyDown={
          always
            ? undefined
            : (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggle()
                }
              }
        }
      >
        {!always && (collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />)}
        {label}
        {count !== undefined && count > 0 && <span className="count">{count}</span>}
        <span className="agent-head-spacer" />
        {actions && (
          <span className="side-group-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </div>
      {!collapsed && children}
    </div>
  )
}
