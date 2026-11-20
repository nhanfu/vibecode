import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { load, save } from '../localPref'

/** ids of the sidebar groups the user folded (kept on this machine) */
const COLLAPSED_KEY = 'vibe.sideCollapsed'

const loadCollapsed = (): string[] =>
  load(COLLAPSED_KEY, (v) => {
    const list: unknown = JSON.parse(v)
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  }, [])

/**
 * A sidebar list under a label that folds it: click the label (or Enter / Space on it) to collapse
 * or expand. `actions` sit at the right of the label and do not fold it. The state is remembered.
 */
export function SideGroup(props: {
  id: string
  label: string
  count?: number
  actions?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const { id, label, count, actions, children } = props
  const [collapsed, setCollapsed] = useState(() => loadCollapsed().includes(id))
  const toggle = (): void => {
    // read again: another group may have been folded since this one loaded
    const rest = loadCollapsed().filter((x) => x !== id)
    const next = collapsed ? rest : [...rest, id]
    setCollapsed(!collapsed)
    save(COLLAPSED_KEY, JSON.stringify(next))
  }
  return (
    <div className="side-group">
      <div
        className="side-group-label collapsible"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand' : 'Collapse'}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
      >
        {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
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
