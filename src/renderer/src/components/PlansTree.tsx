import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ClipboardList, Circle, ListPlus, Play, Plus, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { defaultAgent, newChat } from '../actions'
import { agentDef } from '../../../shared/agents'
import { load, save } from '../localPref'

/** plans and tasks the user added by hand (kept on this machine) */
const PLANS_KEY = 'vibe.plansTasks'
const OPEN_KEY = 'vibe.plansOpen'

/**
 * A plan holds tasks and other plans; a task is the smallest unit and holds nothing. The array
 * order is the order among siblings.
 */
interface PlanItem {
  id: string
  kind: 'plan' | 'task'
  title: string
  description: string
  /** the plan this sits under (none: top level) */
  parentId?: string
}

type Drop = 'before' | 'after' | 'into'

function isPlanItem(x: unknown): x is PlanItem {
  if (!x || typeof x !== 'object') return false
  const i = x as Partial<PlanItem>
  return typeof i.id === 'string' && typeof i.title === 'string' && (i.kind === 'plan' || i.kind === 'task')
}

function loadPlans(): PlanItem[] {
  return load(PLANS_KEY, (v) => {
    const list: unknown = JSON.parse(v)
    if (!Array.isArray(list)) return []
    // older saves had `planId` and no description
    return list.filter(isPlanItem).map((i) => {
      const old = i as PlanItem & { planId?: string }
      const { planId, ...rest } = old
      return { ...rest, description: typeof old.description === 'string' ? old.description : '', parentId: old.parentId ?? planId }
    })
  }, [])
}

function loadOpen(): string[] {
  return load(OPEN_KEY, (v) => {
    const list: unknown = JSON.parse(v)
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  }, [])
}

/** The plans above an item, outermost first. */
function ancestors(items: PlanItem[], item: PlanItem): PlanItem[] {
  const out: PlanItem[] = []
  const seen = new Set<string>([item.id])
  let p = items.find((i) => i.id === item.parentId)
  while (p && !seen.has(p.id)) {
    out.unshift(p)
    seen.add(p.id)
    p = items.find((i) => i.id === p!.parentId)
  }
  return out
}

/** What the agent is asked: the task, with the plans it sits in for context. */
function taskPrompt(items: PlanItem[], task: PlanItem): string {
  const lines: string[] = []
  const plans = ancestors(items, task)
  if (plans.length) {
    lines.push(`This task belongs to the plan "${plans.map((p) => p.title).join(' > ')}".`)
    for (const p of plans) if (p.description.trim()) lines.push(`Plan "${p.title}": ${p.description.trim()}`)
    lines.push('')
  }
  lines.push(`Task: ${task.title}`)
  if (task.description.trim()) lines.push('', task.description.trim())
  return lines.join('\n')
}

/**
 * The plans and tasks the user adds by hand, as a tree: drag to move (into a plan, or before/after a
 * row), arrow keys to walk it, and a Run button on each task that hands it to the default agent.
 */
export function PlansGroup(): React.JSX.Element {
  const [items, setItems] = useState<PlanItem[]>(loadPlans)
  const [open, setOpen] = useState<string[]>(loadOpen)
  const [sel, setSel] = useState<string | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; at: Drop } | null>(null)
  const root = useStore((s) => s.root)
  // re-render when the default agent changes (defaultAgent() reads it)
  useStore((s) => s.preferredAgent)
  const agent = defaultAgent()
  const treeRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const [focusTitle, setFocusTitle] = useState(false)

  const commit = (next: PlanItem[]): void => {
    setItems(next)
    save(PLANS_KEY, JSON.stringify(next))
  }
  const setExpanded = (id: string, on: boolean): void => {
    setOpen((cur) => {
      const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id)
      save(OPEN_KEY, JSON.stringify(next))
      return next
    })
  }
  const kids = (parentId: string | undefined): PlanItem[] => items.filter((i) => i.parentId === parentId)
  const byId = (id: string | null): PlanItem | undefined => (id ? items.find((i) => i.id === id) : undefined)

  // the rows on screen, in order, with their depth
  const rows: { item: PlanItem; depth: number }[] = []
  const walk = (parentId: string | undefined, depth: number, seen: Set<string>): void => {
    for (const item of kids(parentId)) {
      if (seen.has(item.id)) continue
      rows.push({ item, depth })
      if (item.kind === 'plan' && open.includes(item.id)) walk(item.id, depth + 1, new Set([...seen, item.id]))
    }
  }
  walk(undefined, 0, new Set())
  // anything cut off from the top level (a parent that no longer exists) shows at the top
  const known = new Set(items.map((i) => i.id))
  for (const item of items) if (item.parentId && !known.has(item.parentId) && !rows.some((r) => r.item.id === item.id)) rows.push({ item, depth: 0 })

  const selected = byId(sel)

  useEffect(() => {
    if (!focusTitle) return
    setFocusTitle(false)
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [focusTitle, sel])

  /** Add under `parent` (a plan; none: top level). Plans can nest, tasks cannot hold anything. */
  const add = (kind: PlanItem['kind'], parent?: PlanItem): void => {
    const p = parent?.kind === 'plan' ? parent : undefined
    const item: PlanItem = { id: crypto.randomUUID(), kind, title: kind === 'plan' ? 'New plan' : 'New task', description: '', parentId: p?.id }
    commit([...items, item])
    if (p) setExpanded(p.id, true)
    setSel(item.id)
    setFocusTitle(true)
  }
  /** Add next to the selected row: inside it when it is a plan, beside it when it is a task. */
  const addNear = (kind: PlanItem['kind']): void => {
    const s = selected
    if (!s) return add(kind)
    add(kind, s.kind === 'plan' ? s : byId(s.parentId ?? null))
  }
  const patch = (id: string, change: Partial<PlanItem>): void => commit(items.map((i) => (i.id === id ? { ...i, ...change } : i)))
  const descendants = (id: string): Set<string> => {
    const out = new Set<string>()
    const stack = [id]
    while (stack.length) {
      const cur = stack.pop()!
      for (const k of items) if (k.parentId === cur && !out.has(k.id)) {
        out.add(k.id)
        stack.push(k.id)
      }
    }
    return out
  }
  /** Remove an item; what sat under it moves up to its parent. */
  const remove = (id: string): void => {
    const gone = byId(id)
    if (!gone) return
    const idx = rows.findIndex((r) => r.item.id === id)
    commit(items.filter((i) => i.id !== id).map((i) => (i.parentId === id ? { ...i, parentId: gone.parentId } : i)))
    if (sel === id) setSel((rows[idx + 1] ?? rows[idx - 1])?.item.id ?? null)
  }

  const canDrop = (dragId: string, target: PlanItem, at: Drop): boolean => {
    if (dragId === target.id) return false
    if (at === 'into' && target.kind !== 'plan') return false
    // a plan can't go into itself or what it holds
    return !descendants(dragId).has(target.id)
  }
  const move = (dragId: string, target: PlanItem, at: Drop): void => {
    const moving = byId(dragId)
    if (!moving || !canDrop(dragId, target, at)) return
    const rest = items.filter((i) => i.id !== dragId)
    const parentId = at === 'into' ? target.id : target.parentId
    const moved: PlanItem = { ...moving, parentId }
    let next: PlanItem[]
    if (at === 'into') next = [...rest, moved]
    else {
      const i = rest.findIndex((x) => x.id === target.id)
      next = [...rest.slice(0, at === 'before' ? i : i + 1), moved, ...rest.slice(at === 'before' ? i : i + 1)]
    }
    commit(next)
    if (at === 'into') setExpanded(target.id, true)
    setSel(dragId)
  }
  /** Where over a row the pointer is: the top quarter puts it before, the bottom quarter after, the middle inside a plan. */
  const dropAt = (el: Element, clientY: number, item: PlanItem): Drop => {
    const r = el.getBoundingClientRect()
    const y = (clientY - r.top) / (r.height || 1)
    if (item.kind === 'plan') return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into'
    return y < 0.5 ? 'before' : 'after'
  }
  /**
   * Drag with the pointer, not the HTML5 drag events: the webview's own file-drop handling swallows
   * those. A press that moves a few pixels starts the drag; letting go on a row drops there, on the
   * empty space under the rows drops to the top level.
   */
  const startDrag = (e: React.PointerEvent<HTMLDivElement>, item: PlanItem): void => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return
    const x0 = e.clientX
    const y0 = e.clientY
    let started = false
    let target: { id: string; at: Drop } | 'root' | null = null
    const hit = (ev: PointerEvent): void => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const rowEl = el?.closest<HTMLElement>('.plan-row[data-id]')
      const t = rowEl ? byId(rowEl.dataset.id ?? null) : undefined
      if (rowEl && t) {
        const at = dropAt(rowEl, ev.clientY, t)
        target = canDrop(item.id, t, at) ? { id: t.id, at } : null
      } else target = el?.closest('.plan-tree') ? 'root' : null
      setOver(target && target !== 'root' ? target : null)
    }
    const onMove = (ev: PointerEvent): void => {
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return
        started = true
        setDrag(item.id)
        document.body.style.cursor = 'grabbing'
      }
      hit(ev)
    }
    const end = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      document.body.style.cursor = ''
      if (!started) return
      // the click that follows a drag must not select or toggle anything
      window.addEventListener('click', (c) => c.stopPropagation(), { capture: true, once: true })
      if (ev.type === 'pointerup') {
        if (target === 'root') commit([...items.filter((i) => i.id !== item.id), { ...item, parentId: undefined }])
        else if (target) {
          const t = byId(target.id)
          if (t) move(item.id, t, target.at)
        }
      }
      setDrag(null)
      setOver(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const run = (task: PlanItem): void => {
    if (!root || !agent) return
    setSel(task.id)
    newChat({ agent, title: task.title, pinnedTitle: true, prompt: taskPrompt(items, task) })
  }
  const runBlocked = !root ? 'Open a folder first' : !agent ? 'No coding agent installed' : ''

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return // typing in the details below
    const i = rows.findIndex((r) => r.item.id === sel)
    const cur = i >= 0 ? rows[i].item : undefined
    const go = (n: number): void => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, n))]
      if (r) setSel(r.item.id)
    }
    const key = e.key
    if (key === 'ArrowDown') go(i < 0 ? 0 : i + 1)
    else if (key === 'ArrowUp') go(i < 0 ? 0 : i - 1)
    else if (key === 'Home') go(0)
    else if (key === 'End') go(rows.length - 1)
    else if (key === 'ArrowRight') {
      if (cur?.kind === 'plan') {
        if (!open.includes(cur.id)) setExpanded(cur.id, true)
        else if (kids(cur.id).length) go(i + 1)
      }
    } else if (key === 'ArrowLeft') {
      if (cur?.kind === 'plan' && open.includes(cur.id)) setExpanded(cur.id, false)
      else if (cur?.parentId) setSel(cur.parentId)
    } else if (key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      if (cur?.kind === 'task') run(cur)
    } else if (key === 'Enter' || key === 'F2') {
      if (cur) setFocusTitle(true)
    } else if (key === 'Delete' || key === 'Backspace') {
      if (cur) remove(cur.id)
    } else if (key === 'n' || key === 'N') {
      addNear(e.shiftKey ? 'plan' : 'task')
    } else return
    e.preventDefault()
  }

  useEffect(() => {
    // keep the walked row in view
    treeRef.current?.querySelector('.plan-row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const row = ({ item, depth }: { item: PlanItem; depth: number }): React.JSX.Element => {
    const isPlan = item.kind === 'plan'
    const expanded = isPlan && open.includes(item.id)
    const hint = over?.id === item.id && drag && canDrop(drag, item, over.at) ? ` drop-${over.at}` : ''
    return (
      <div
        key={item.id}
        role="treeitem"
        data-id={item.id}
        aria-level={depth + 1}
        aria-selected={sel === item.id}
        aria-expanded={isPlan ? expanded : undefined}
        className={`plan-row ${item.kind}${sel === item.id ? ' selected' : ''}${drag === item.id ? ' dragging' : ''}${hint}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        title={item.description ? `${item.title}\n\n${item.description}` : item.title}
        onDoubleClick={() => isPlan && setExpanded(item.id, !expanded)}
        onPointerDown={(e) => startDrag(e, item)}
      >
        {isPlan ? (
          <button
            className="plan-chevron"
            tabIndex={-1}
            title={expanded ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(item.id, !expanded)
            }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="plan-chevron" />
        )}
        {isPlan ? <ClipboardList size={12} /> : <Circle size={9} />}
        <span className="plan-title">{item.title}</span>
        {isPlan && kids(item.id).length > 0 && !expanded && <span className="plan-count">{kids(item.id).length}</span>}
        <span className="plan-acts">
          {isPlan && (
            <>
              <button
                className="icon-btn tiny"
                tabIndex={-1}
                title="Add a task in this plan"
                onClick={(e) => {
                  e.stopPropagation()
                  add('task', item)
                }}
              >
                <Plus size={12} />
              </button>
              <button
                className="icon-btn tiny"
                tabIndex={-1}
                title="Add a plan in this plan"
                onClick={(e) => {
                  e.stopPropagation()
                  add('plan', item)
                }}
              >
                <ListPlus size={12} />
              </button>
            </>
          )}
          {!isPlan && (
            <button
              className="icon-btn tiny plan-run"
              tabIndex={-1}
              title={runBlocked || `Run with ${agentDef(agent).label} in a new chat`}
              disabled={!!runBlocked}
              onClick={(e) => {
                e.stopPropagation()
                run(item)
              }}
            >
              <Play size={11} fill="currentColor" />
            </button>
          )}
          <button
            className="icon-btn tiny"
            tabIndex={-1}
            title="Remove"
            onClick={(e) => {
              e.stopPropagation()
              remove(item.id)
            }}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>
    )
  }

  return (
    <div className="side-group">
      <div className="side-group-label">
        Plans & tasks
        <span className="agent-head-spacer" />
        <button className="icon-btn tiny" title="Add a plan" onClick={() => addNear('plan')}>
          <ListPlus size={12} />
        </button>
        <button className="icon-btn tiny" title="Add a task" onClick={() => addNear('task')}>
          <Plus size={12} />
        </button>
      </div>
      {items.length === 0 && <div className="tree-empty">No plans or tasks. Add one with +.</div>}
      {items.length > 0 && (
        <div
          ref={treeRef}
          className="plan-tree"
          role="tree"
          tabIndex={0}
          title={'↑ ↓ walk · → ← open/close · Enter edit · Ctrl+Enter run · N task · Shift+N plan · Del remove'}
          onKeyDown={onKey}
        >
          {rows.map(row)}
        </div>
      )}
      {selected && (
        <div className="plan-detail">
          <div className="plan-detail-kind">
            {selected.kind === 'plan' ? 'Plan' : 'Task'}
            {selected.parentId && byId(selected.parentId) && <> in {byId(selected.parentId)!.title}</>}
          </div>
          <input
            ref={titleRef}
            value={selected.title}
            placeholder={selected.kind === 'plan' ? 'Plan name' : 'Task name'}
            onChange={(e) => patch(selected.id, { title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') treeRef.current?.focus()
            }}
          />
          <textarea
            rows={4}
            value={selected.description}
            placeholder={selected.kind === 'plan' ? 'What this plan is for, and how its tasks fit' : 'What to do, and how to know it is done'}
            onChange={(e) => patch(selected.id, { description: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') treeRef.current?.focus()
              else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && selected.kind === 'task') run(selected)
            }}
          />
          {selected.kind === 'task' && (
            <button className="plan-add plan-run-btn" disabled={!!runBlocked} title={runBlocked} onClick={() => run(selected)}>
              <Play size={11} fill="currentColor" /> Run{agent ? ` with ${agentDef(agent).label}` : ''}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
