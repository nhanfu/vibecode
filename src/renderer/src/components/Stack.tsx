import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, Clock, Code2, Database, FolderOpen, Globe, Pin, PinOff, X } from 'lucide-react'
import {
  basename,
  closeFloat,
  floating,
  leavePanel,
  movePanel,
  PANEL_IDS,
  peekPanel,
  togglePanel,
  togglePin,
  useStore,
  type PanelId
} from '../store'
import { openFolder } from '../actions'
import { COMMANDS } from '../shortcuts'
import { Sidebar } from './Sidebar'
import { CodePanel, DbPanel, WebPanel } from './Editor'
import { AgentsPanel } from './Agents'

/*
 * The title-bar drop-downs as a horizontal stack (store.ts PanelId). A drop-down floats under its
 * button while hovered, or opened by a click / its key until a click elsewhere; a double-click on
 * the button pins it into the stack beside the chat, and another unpins it. Dragging the buttons
 * sideways reorders the stack.
 */

interface PanelMeta {
  label: string
  icon: typeof Code2
  /** the command that shows it (its key is shown in the tooltip) */
  command: string
  size: FloatSize
}

interface FloatSize {
  /** localStorage key */
  key: string
  /** width before it is ever dragged, and after a double-click on the edge */
  initial: () => number
  min: number
}

const PANELS: Record<PanelId, PanelMeta> = {
  project: { label: 'Project', icon: FolderOpen, command: 'sidebar', size: { key: 'vibe.sidebarWidth', initial: () => 300, min: 220 } },
  code: { label: 'Source code', icon: Code2, command: 'viewCode', size: { key: 'vibe.centerWidth', initial: () => Math.round(window.innerWidth * 0.55), min: 360 } },
  web: { label: 'Web', icon: Globe, command: 'viewWeb', size: { key: 'vibe.webWidth', initial: () => Math.round(window.innerWidth * 0.5), min: 320 } },
  db: { label: 'Database', icon: Database, command: 'viewDb', size: { key: 'vibe.dbWidth', initial: () => Math.round(window.innerWidth * 0.5), min: 360 } },
  agents: { label: 'Agents', icon: Bot, command: 'viewAgents', size: { key: 'vibe.agentsWidth', initial: () => 320, min: 240 } }
}

const keysOf = (id: PanelId): string | undefined => COMMANDS.find((c) => c.id === PANELS[id].command)?.keys

/* ---------------- title bar ---------------- */

/** Pixels the pointer moves before a press on a button becomes a drag. */
const DRAG_START = 5
/** A click waits this long for a second one (a double-click pins instead). */
const CLICK_WAIT = 220

export function StackBar(): React.JSX.Element {
  const order = useStore((s) => s.panelOrder)
  const barRef = useRef<HTMLDivElement>(null)
  // the button being dragged, and where it would land (index in the order without it)
  const [drag, setDrag] = useState<{ id: PanelId; to: number } | null>(null)

  /** Where a button dropped at `x` lands: before the first other button whose middle is right of x. */
  const dropIndex = (id: PanelId, x: number): number => {
    const others = [...(barRef.current?.querySelectorAll<HTMLElement>('.stack-btn') ?? [])].filter((b) => b.dataset.panel !== id)
    const i = others.findIndex((b) => {
      const r = b.getBoundingClientRect()
      return x < r.left + r.width / 2
    })
    return i < 0 ? others.length : i
  }

  return (
    <div className={`stack-bar${drag ? ' dragging' : ''}`} ref={barRef} onMouseDown={(e) => e.stopPropagation()}>
      {order.map((id) => {
        const without = order.filter((p) => p !== id)
        // the drop mark goes before the button that will follow the dragged one
        const markBefore = drag && drag.id !== id && without[drag.to] === id
        const markAfter = drag && drag.id !== id && drag.to === without.length && without[without.length - 1] === id
        return (
          <StackButton
            key={id}
            id={id}
            dragging={drag?.id === id}
            mark={markBefore ? 'before' : markAfter ? 'after' : null}
            onDrag={(x) => setDrag({ id, to: dropIndex(id, x) })}
            onDrop={(x) => {
              setDrag(null)
              if (x !== null) movePanel(id, dropIndex(id, x))
            }}
          />
        )
      })}
    </div>
  )
}

function StackButton(props: {
  id: PanelId
  dragging: boolean
  mark: 'before' | 'after' | null
  /** the pointer moved to x while dragging this button */
  onDrag: (x: number) => void
  /** released at x (null: cancelled) */
  onDrop: (x: number | null) => void
}): React.JSX.Element {
  const { id, dragging, mark, onDrag, onDrop } = props
  const meta = PANELS[id]
  const root = useStore((s) => s.root)
  const pinned = useStore((s) => s.pinned.includes(id))
  const shown = useStore((s) => floating(s) === id)
  const files = useStore((s) => (id === 'code' ? s.tabs.length : 0))
  const running = useStore((s) => (id === 'agents' ? s.chats.filter((c) => c.status === 'working').length : 0))
  const [menu, setMenu] = useState(false)
  const clickTimer = useRef<number | undefined>(undefined)
  // a drag ends with a click on the button: that one is not a click
  const dragged = useRef(false)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent): void => {
      if (!(e.target instanceof Element && e.target.closest('.stack-menu'))) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const press = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    const btn = e.currentTarget
    const startX = e.clientX
    let moving = false
    dragged.current = false
    const move = (ev: PointerEvent): void => {
      if (!moving && Math.abs(ev.clientX - startX) < DRAG_START) return
      if (!moving) {
        moving = true
        dragged.current = true
        btn.setPointerCapture(ev.pointerId)
        window.clearTimeout(clickTimer.current)
        closeFloat()
      }
      onDrag(ev.clientX)
    }
    const end = (ev: PointerEvent): void => {
      btn.removeEventListener('pointermove', move)
      btn.removeEventListener('pointerup', end)
      btn.removeEventListener('pointercancel', end)
      if (moving) onDrop(ev.type === 'pointerup' ? ev.clientX : null)
    }
    btn.addEventListener('pointermove', move)
    btn.addEventListener('pointerup', end)
    btn.addEventListener('pointercancel', end)
  }

  const click = (e: React.MouseEvent): void => {
    if (dragged.current) {
      dragged.current = false
      return
    }
    window.clearTimeout(clickTimer.current)
    if (e.detail >= 2) {
      setMenu(false)
      togglePin(id)
      return
    }
    // wait: this may be the first half of a double-click
    clickTimer.current = window.setTimeout(() => {
      if (id === 'project') setMenu((m) => !m)
      else togglePanel(id)
    }, CLICK_WAIT)
  }

  const Icon = meta.icon
  const label = id === 'project' && root ? basename(root) : meta.label
  const keys = keysOf(id)
  const what = id === 'project' ? 'click for folders' : 'click to open'
  return (
    <div className={`stack-btn-wrap${mark ? ` mark-${mark}` : ''}`}>
      <button
        className={`stack-btn${shown ? ' on' : ''}${pinned ? ' pinned' : ''}${dragging ? ' dragging' : ''}`}
        data-panel={id}
        title={`${meta.label}: hover to look, ${what}, double-click to ${pinned ? 'unpin' : 'pin'}, drag to reorder${keys ? ` (${keys})` : ''}`}
        onMouseEnter={() => !dragging && peekPanel(id)}
        onPointerDown={press}
        onClick={click}
      >
        <Icon size={13} />
        <span className="stack-label">{label}</span>
        {files > 0 && <span className="center-count">{files}</span>}
        {running > 0 && <span className="center-count">{running}</span>}
        {pinned ? <Pin size={10} className="stack-pin" /> : <ChevronDown size={11} className="stack-chev" />}
      </button>
      {menu && <FolderMenu close={() => setMenu(false)} />}
    </div>
  )
}

/** The project button's menu: open another folder. */
function FolderMenu({ close }: { close: () => void }): React.JSX.Element {
  const root = useStore((s) => s.root)
  const recent = useStore((s) => s.recent)
  return (
    <div className="menu stack-menu">
      <button
        className="menu-item"
        onClick={() => {
          close()
          openFolder()
        }}
      >
        <FolderOpen size={14} /> Open folder…
      </button>
      {recent.length > 1 && <div className="menu-sep">Recent</div>}
      {recent
        .filter((r) => r !== root)
        .map((r) => (
          <button
            key={r}
            className="menu-item"
            onClick={() => {
              close()
              openFolder(r)
            }}
          >
            <Clock size={14} />
            <span className="menu-item-main">{basename(r)}</span>
            <span className="menu-item-sub">{r}</span>
          </button>
        ))}
    </div>
  )
}

/* ---------------- the stack ---------------- */

/** What counts as "on the floating drop-down": it, the title-bar buttons, and menus / dialogs opened from it. */
const FLOAT_PARTS =
  '.stack-panel.floating, .stack-bar, .menu, .ctx-menu, .overlay, .context-view, .monaco-menu-container, .image-lightbox, .bm-menu, .browser-sugg, .term-image-hover'

/**
 * A hovered drop-down follows the pointer: it hides a moment after the pointer moves onto the rest
 * of the app. That is read from where the pointer moves, not from leaving the drop-down: over a web
 * page the pointer is in the native page and the app sees no event at all (a mouseleave would hide
 * the page you are using). A click elsewhere in the app closes whatever floats.
 */
function useFloatTracking(): void {
  const peeking = useStore((s) => s.peek !== null)
  const shown = useStore((s) => floating(s) !== null)
  useEffect(() => {
    if (!peeking) return
    const move = (e: MouseEvent): void => {
      const t = e.target
      if (t instanceof Element && t.closest(FLOAT_PARTS)) {
        const id = useStore.getState().peek
        if (id) peekPanel(id)
      } else leavePanel()
    }
    window.addEventListener('mousemove', move, true)
    return () => window.removeEventListener('mousemove', move, true)
  }, [peeking])
  useEffect(() => {
    if (!shown) return
    const down = (e: MouseEvent): void => {
      const t = e.target
      if (t instanceof Element && t.closest(FLOAT_PARTS)) return
      closeFloat()
    }
    window.addEventListener('mousedown', down, true)
    // focus moving elsewhere (a click into the chat's terminal, Alt+Tab back…) closes it too
    const focus = (e: FocusEvent): void => {
      const t = e.target
      if (t instanceof Element && !t.closest(FLOAT_PARTS)) closeFloat()
    }
    window.addEventListener('focusin', focus, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('focusin', focus, true)
    }
  }, [shown])
}

/**
 * The workbench: pinned drop-downs side by side in the title bar's order, then the chat (`children`)
 * taking the rest; floating ones over it, under their button. Every drop-down is mounted once, in a
 * fixed place, whatever it does: pinning, floating or reordering only changes its CSS, so editors,
 * pages and scroll positions survive.
 */
export function StackLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  useFloatTracking()
  const shown = useStore((s) => floating(s) !== null)
  return (
    <div className="workbench stack">
      {PANEL_IDS.map((id) => (
        <StackPanel key={id} id={id} />
      ))}
      <div className="stack-main">{children}</div>
      {/* dims the chat behind a floating drop-down; a click on it closes it (useFloatTracking) */}
      <div className={`stack-backdrop${shown ? ' shown' : ''}`} />
    </div>
  )
}

function StackPanel({ id }: { id: PanelId }): React.JSX.Element {
  const meta = PANELS[id]
  const pinned = useStore((s) => s.pinned.includes(id))
  const shown = useStore((s) => floating(s) === id)
  const order = useStore((s) => s.panelOrder.indexOf(id))
  const [width, startResize, resetWidth] = useWidth(meta.size)
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(0)

  // floating: under its title-bar button, kept inside the workbench
  useLayoutEffect(() => {
    if (pinned || !shown) return
    const place = (): void => {
      const box = ref.current?.parentElement?.getBoundingClientRect()
      const btn = document.querySelector(`.stack-btn[data-panel="${id}"]`)?.getBoundingClientRect()
      if (!box || !btn) return
      const w = Math.min(width, box.width)
      setLeft(Math.round(Math.max(0, Math.min(btn.left - box.left, box.width - w))))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [pinned, shown, width, id])

  const Icon = meta.icon
  const keys = keysOf(id)
  return (
    <div
      ref={ref}
      className={`stack-panel ${pinned ? 'pinned' : 'floating'}${shown ? ' shown' : ''}`}
      data-panel={id}
      style={pinned ? { order, flexBasis: width, minWidth: meta.size.min } : { width, left }}
      onMouseEnter={() => !pinned && shown && peekPanel(id)}
    >
      <div className="stack-head">
        <Icon size={12} />
        <span className="stack-head-title">{meta.label}</span>
        {keys && <kbd className="stack-head-keys">{keys}</kbd>}
        <span className="stack-head-spacer" />
        <button className="icon-btn tiny" title={pinned ? 'Unpin: float it again (or double-click its title-bar button)' : 'Pin it beside the chat (or double-click its title-bar button)'} onClick={() => togglePin(id)}>
          {pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>
        {!pinned && (
          <button className="icon-btn tiny" title="Close" onClick={() => closeFloat()}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="stack-body">
        <PanelBody id={id} />
      </div>
      <div className="sidebar-resize" title="Drag to resize · double-click to reset" onPointerDown={startResize} onDoubleClick={resetWidth} />
    </div>
  )
}

function PanelBody({ id }: { id: PanelId }): React.JSX.Element {
  switch (id) {
    case 'project':
      return <Sidebar />
    case 'code':
      return <CodePanel />
    case 'web':
      return <WebPanel />
    case 'db':
      return <DbPanel />
    case 'agents':
      return <AgentsPanel />
  }
}

/** A drop-down's width: dragged on its right edge, remembered; double-click on the edge resets it. */
function useWidth(size: FloatSize): [number, (e: React.PointerEvent<HTMLDivElement>) => void, () => void] {
  const [width, setWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(size.key)) || size.initial()
    } catch {
      return size.initial()
    }
  })
  const save = (w: number | null): void => {
    try {
      if (w === null) localStorage.removeItem(size.key)
      else localStorage.setItem(size.key, String(w))
    } catch {
      /* it resets next time */
    }
  }
  const start = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('dragging')
    const left = handle.parentElement!.getBoundingClientRect().left
    let w = width
    const move = (ev: PointerEvent): void => {
      const max = Math.max(size.min + 20, window.innerWidth * 0.96)
      w = Math.round(Math.min(max, Math.max(size.min, ev.clientX - left)))
      setWidth(w)
    }
    const up = (): void => {
      handle.classList.remove('dragging')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      save(w)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  const reset = (): void => {
    setWidth(size.initial())
    save(null)
  }
  return [width, start, reset]
}
