import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Bot, Code2, Database, FolderOpen, Globe, MoveHorizontal, PanelTop, Pin, PinOff, Power, Puzzle, Terminal, X } from 'lucide-react'
import {
  basename,
  closeFloat,
  floating,
  isPluginPanel,
  leavePanel,
  movePanel,
  PANEL_IDS,
  peekPanel,
  showPanel,
  togglePanel,
  togglePin,
  toggleFullscreen,
  useStore,
  type PanelId,
  type StaticPanelId
} from '../store'
import { loadPlugins } from '../actions'
import { PluginManager } from './PluginManager'
import { PluginPane } from './PluginPane'
import { TerminalPane } from './TerminalPane'
import { userStore } from '../localPref'

/*
 * The title-bar drop-downs as a horizontal stack (store.ts PanelId). A drop-down floats under its
 * button while hovered, or opened by a click / its key until a click elsewhere; a double-click on
 * the button pins it into the stack, and another unpins it. Right-click on a button has the same
 * and more (move, reset width), like a tab in Chrome. Dragging the buttons sideways reorders the
 * stack.
 */

interface PanelMeta {
  label: string
  icon: typeof Code2
  /** the command that shows it (its key is shown in the tooltip) */
  command: string
  size: FloatSize
}

interface FloatSize {
  /** key in the saved preferences */
  key: string
  /** width before it is ever dragged, and after a double-click on the edge */
  initial: () => number
  min: number
}

const PANELS: Record<StaticPanelId, PanelMeta> = {
  plugins: { label: 'Plugins', icon: Puzzle, command: 'viewPlugins', size: { key: 'vibe.pluginsWidth', initial: () => Math.round(window.innerWidth * 0.4), min: 340 } },
  terminal: { label: 'Terminal', icon: Terminal, command: 'viewTerminal', size: { key: 'vibe.terminalWidth', initial: () => Math.round(window.innerWidth * 0.5), min: 360 } }
}

/** Icons a plugin can name in its manifest (`panel.icon`). */
const PLUGIN_ICONS: Record<string, typeof Code2> = { code: Code2, database: Database, globe: Globe, folder: FolderOpen, bot: Bot, terminal: Terminal, puzzle: Puzzle }

/** A plugin's panel: titled and iconed as its manifest says. */
const pluginMeta = (id: PanelId): PanelMeta => {
  const plugin = useStore.getState().plugins.find((p) => `plugin:${p.id}` === id)
  return {
    label: plugin?.panel?.title ?? plugin?.name ?? 'Plugin',
    icon: PLUGIN_ICONS[plugin?.panel?.icon ?? ''] ?? Puzzle,
    command: '',
    size: { key: `vibe.${id}Width`, initial: () => Math.round(window.innerWidth * 0.45), min: 320 }
  }
}

const metaOf = (id: PanelId): PanelMeta => (isPluginPanel(id) ? pluginMeta(id) : PANELS[id])


/* ---------------- title bar ---------------- */

/** Pixels the pointer moves before a press on a button becomes a drag. */
const DRAG_START = 5
/** A click waits this long for a second one (a double-click pins instead). */
const CLICK_WAIT = 220

/** A title-bar button's place on screen when a drag began. */
type Spot = { id: string; left: number; width: number }

export function StackBar(): React.JSX.Element {
  const order = useStore((s) => s.panelOrder)
  const barRef = useRef<HTMLDivElement>(null)
  // the button being dragged: where it would land (index among the others), the pointer, and the drag's start
  const [drag, setDrag] = useState<{ id: PanelId; to: number; x: number; y: number; spots: Spot[] } | null>(null)
  // read by the pointer handlers, which were created before the state changed
  const dragRef = useRef<{ id: PanelId; spots: Spot[] } | null>(null)

  /** Measured before any button moves: the drag starts from these places. */
  const measure = (): Spot[] =>
    [...(barRef.current?.querySelectorAll<HTMLElement>('.stack-btn') ?? [])].map((b) => {
      const r = b.getBoundingClientRect()
      return { id: b.dataset.panel ?? '', left: r.left, width: r.width }
    })

  /** Where a button released at `x` lands among the others: before the first one whose middle is right of x. */
  const slotAt = (spots: Spot[], id: PanelId, x: number): number => {
    const others = spots.filter((s) => s.id !== id)
    const i = others.findIndex((s) => x < s.left + s.width / 2)
    return i < 0 ? others.length : i
  }

  const dropAt = (id: PanelId, x: number): number => slotAt(dragRef.current?.spots ?? measure(), id, x)

  const step = drag ? (drag.spots.length > 1 ? drag.spots[1].left - drag.spots[0].left : drag.spots[0]?.width ?? 0) : 0

  /** How far a button moves while another is dragged: it takes the slot it would have after the drop. */
  const shiftOf = (id: PanelId): number => {
    if (!drag) return 0
    const others = order.filter((p) => p !== drag.id)
    const from = order.indexOf(id)
    const wi = others.indexOf(id)
    const to = id === drag.id ? drag.to : wi < drag.to ? wi : wi + 1
    return (to - from) * step
  }

  return (
    <div className={`stack-bar${drag ? ' dragging' : ''}`} ref={barRef} onMouseDown={(e) => e.stopPropagation()}>
      {order.map((id) => (
        <StackButton
          key={id}
          id={id}
          dragging={drag?.id === id}
          shift={shiftOf(id)}
          moving={drag !== null}
          onDrag={(x, y) => {
            if (dragRef.current?.id !== id) dragRef.current = { id, spots: measure() }
            const spots = dragRef.current.spots
            setDrag({ id, to: slotAt(spots, id, x), x, y, spots })
          }}
          onDrop={(x) => {
            const to = x === null ? null : dropAt(id, x)
            dragRef.current = null
            setDrag(null)
            if (to !== null) movePanel(id, to)
          }}
        />
      ))}
      {drag &&
        createPortal(
          <div className="stack-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden>
            {(() => {
              const Icon = metaOf(drag.id).icon
              return <Icon size={13} />
            })()}
          </div>,
          document.body
        )}
    </div>
  )
}

function StackButton(props: {
  id: PanelId
  dragging: boolean
  /** px it moves to make room (or to take the dragged button's slot) */
  shift: number
  /** a drag is on: moves animate */
  moving: boolean
  /** the pointer moved to (x, y) while dragging this button */
  onDrag: (x: number, y: number) => void
  /** released at x (null: cancelled) */
  onDrop: (x: number | null) => void
}): React.JSX.Element {
  const { id, dragging, shift, moving, onDrag, onDrop } = props
  const meta = metaOf(id)
  const pinned = useStore((s) => s.pinned.includes(id))
  const shown = useStore((s) => floating(s) === id)
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null)
  const clickTimer = useRef<number | undefined>(undefined)
  // a drag ends with a click on the button: that one is not a click
  const dragged = useRef(false)


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
      onDrag(ev.clientX, ev.clientY)
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
      togglePin(id)
      return
    }
    // wait: this may be the first half of a double-click
    clickTimer.current = window.setTimeout(() => togglePanel(id), CLICK_WAIT)
  }

  const Icon = meta.icon
  const label = meta.label
  const what = 'click to open'
  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    window.clearTimeout(clickTimer.current)
    setCtx({ x: e.clientX, y: e.clientY })
  }
  return (
    <div className="stack-btn-wrap" style={{ transform: shift ? `translateX(${shift}px)` : undefined, transition: moving ? 'transform 0.18s ease' : 'none' }}>
      <button
        className={`stack-btn${shown ? ' on' : ''}${pinned ? ' pinned' : ''}${dragging ? ' dragging' : ''}`}
        data-panel={id}
        aria-label={label}
        title={`${label}: hover to look, ${what}, double-click to ${pinned ? 'unpin' : 'pin'}, right-click for more, drag to reorder`}
        onMouseEnter={() => !dragging && peekPanel(id)}
        onPointerDown={press}
        onClick={click}
        onContextMenu={openMenu}
      >
        <Icon size={13} />
      </button>
      {ctx && <StackMenu id={id} x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} />}
    </div>
  )
}

/** Right-click on a title-bar button: pin, open / close, move, reset width (like a tab in Chrome). */
function StackMenu({ id, x, y, onClose }: { id: PanelId; x: number; y: number; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<React.CSSProperties>({ left: x, top: y, visibility: 'hidden' })
  const pinned = useStore((s) => s.pinned.includes(id))
  const open = useStore((s) => floating(s) === id)
  const order = useStore((s) => s.panelOrder)
  const at = order.indexOf(id)
  const pluginId = id.startsWith('plugin:') ? id.slice('plugin:'.length) : null
  const pluginRunning = useStore((s) => (pluginId ? s.plugins.find((p) => p.id === pluginId)?.status === 'running' : false))

  // kept on screen, measured before paint so it never jumps
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
  }, [x, y])

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const run = (f: () => void) => (): void => {
    onClose()
    f()
  }
  type Item = { icon: React.ReactNode; label: string; hint?: string; tip?: string; act: () => void; off?: boolean } | 'sep'
  const items: Item[] = [
    pinned
      ? { icon: <PinOff size={14} />, label: 'Unpin', hint: 'Double-click', act: () => togglePin(id) }
      : { icon: <Pin size={14} />, label: 'Pin', hint: 'Double-click', act: () => togglePin(id) },
    // a pinned one is always on screen: nothing to open or close
    ...(pinned
      ? []
      : [
          open
            ? { icon: <X size={14} />, label: 'Close', act: () => closeFloat() }
            : { icon: <PanelTop size={14} />, label: 'Open', act: () => showPanel(id) }
        ]),
    'sep',
    { icon: <ArrowLeft size={14} />, label: 'Move left', act: () => movePanel(id, at - 1), off: at <= 0 },
    { icon: <ArrowRight size={14} />, label: 'Move right', act: () => movePanel(id, at + 1), off: at >= order.length - 1 },
    'sep',
    { icon: <MoveHorizontal size={14} />, label: 'Reset width', act: () => window.dispatchEvent(new CustomEvent('stack-reset-width', { detail: id })) },
    ...(pluginId
      ? [
          'sep' as const,
          {
            icon: <Power size={14} />,
            label: 'Stop process',
            tip: 'Stops this plugin’s server. Start it again from Plugins.',
            off: !pluginRunning,
            act: () => void window.api.plugins.stop(pluginId).then(loadPlugins, () => {})
          }
        ]
      : []),
  ]

  // portal to <body>: inside the title bar a transformed / blurred ancestor breaks position:fixed
  return createPortal(
    <div ref={ref} className="menu ctx-menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={`sep${i}`} className="ctx-divider" />
        ) : (
          <button key={it.label} className="menu-item" disabled={it.off} title={it.tip} onClick={run(it.act)}>
            {it.icon}
            <span className="menu-item-main">{it.label}</span>
            {it.hint && <span className="menu-item-sub ctx-hint">{it.hint}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

/** What counts as "on the floating drop-down": it, the title-bar buttons, and menus / dialogs opened from it. */
const FLOAT_PARTS =
  '.stack-panel.floating, .stack-bar, .menu, .ctx-menu, .overlay, .context-view, .monaco-menu-container, .image-lightbox, .term-image-hover, .plan-pop, .explorer-pop'

/**
 * A hovered drop-down follows the pointer: it hides a moment after the pointer moves onto the rest
 * of the app. That is read from where the pointer moves, not from leaving the drop-down. A click
 * elsewhere in the app closes whatever floats.
 */
function useFloatTracking(): void {
  const peeking = useStore((s) => s.peek !== null)
  const shown = useStore((s) => floating(s) !== null)
  useEffect(() => {
    if (!peeking) return
    const move = (e: MouseEvent): void => {
      const t = e.target
      // on a title-bar button, that button decides: another unpinned one floats instead, a pinned
      // one hides what floats (the bar as a whole only bridges the gap between buttons)
      const btn = t instanceof Element ? t.closest<HTMLElement>('.stack-btn[data-panel]') : null
      if (btn) return peekPanel(btn.dataset.panel as PanelId)
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
    // focus moving elsewhere (a click into a terminal, Alt+Tab back…) closes it too
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
 * The workbench: pinned drop-downs side by side in the title bar's order, the last one (
 * when it is pinned) stretched over the rest; floating ones over them, under their button. Every
 * drop-down is mounted once, in a fixed place, whatever it does: pinning, floating or reordering
 * only changes its CSS, so the terminals, editors and scroll positions survive.
 */
export function StackLayout(): React.JSX.Element {
  useFloatTracking()
  const shown = useStore((s) => floating(s) !== null)
  const pinned = useStore((s) => s.pinned)
  const order = useStore((s) => s.panelOrder)
  const fullscreen = useStore((s) => s.fullscreen)
  const panels: PanelId[] = [...PANEL_IDS, ...order.filter(isPluginPanel)]
  const full = fullscreen && panels.includes(fullscreen) ? fullscreen : null
  // the one that takes the room left: the last pinned one
  const fill = [...order].reverse().find((p) => pinned.includes(p))
  /*
   * Who resizes whom. The stretched one has no width to drag. A drop-down left of it is dragged by
   * its own right edge; one right of it is dragged by its left edge, which is the right edge of the
   * pinned one before it (the window's edge, where the last one ends, can't be dragged).
   */
  const line = order.filter((p) => pinned.includes(p))
  const fillAt = fill ? line.indexOf(fill) : -1
  const controls = (id: PanelId): PanelId | null => {
    const next = line[line.indexOf(id) + 1]
    return next && line.indexOf(next) > fillAt ? next : null
  }
  return (
    <div className="workbench stack">
      {panels.map((id) => (
        <StackPanel
          key={id}
          id={id}
          fill={id === fill}
          afterFill={pinned.includes(id) && fillAt >= 0 && line.indexOf(id) > fillAt}
          controls={!full && pinned.includes(id) ? controls(id) : null}
          full={full === null ? null : full === id ? 'self' : 'behind'}
        >
          {isPluginPanel(id) ? (
            <PluginPane id={id.slice('plugin:'.length)} name={metaOf(id).label} />
          ) : id === 'terminal' ? (
            // the built-in terminal: the engine (libghostty-vt) runs the user's shell in the app's own process
            <TerminalPane command={[]} panel="terminal" />
          ) : (
            <PluginManager />
          )}
        </StackPanel>
      ))}
      {/* the way out of full screen that never depends on a key: a plugin's page takes the keys while it has focus */}
      {full && (
        <button className="stack-exit-full" onClick={() => toggleFullscreen(full)} title="Leave full screen (F11 or Escape)">
          Exit full screen
        </button>
      )}
      {!fill && !full && <div className="stack-empty">Hover a button in the title bar to look at it, double-click it to pin it here.</div>}
      {/* dims what is behind a floating drop-down; a click on it closes it (useFloatTracking) */}
      <div className={`stack-backdrop${shown ? ' shown' : ''}`} />
    </div>
  )
}

function StackPanel(props: {
  id: PanelId
  fill: boolean
  /** pinned, right of the stretched one: dragged by its left edge, from the panel before it */
  afterFill: boolean
  /** the pinned drop-down whose left edge is this one's right edge */
  controls: PanelId | null
  full: 'self' | 'behind' | null
  children: React.ReactNode
}): React.JSX.Element {
  const { id, fill, afterFill, controls, full, children } = props
  const meta = metaOf(id)
  const pinned = useStore((s) => s.pinned.includes(id))
  const shown = useStore((s) => floating(s) === id) || full === 'self'
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

  // the panel before this one drags this one's left edge: it hands the press over
  useEffect(() => {
    const begin = (e: Event): void => {
      const d = (e as CustomEvent<{ id: PanelId; event: React.PointerEvent<HTMLDivElement> }>).detail
      if (d.id === id && ref.current) startResize(d.event, ref.current)
    }
    window.addEventListener('stack-resize-start', begin)
    return () => window.removeEventListener('stack-resize-start', begin)
  })

  // "Reset width" in the button's right-click menu
  useEffect(() => {
    const reset = (e: Event): void => {
      if ((e as CustomEvent<PanelId>).detail === id) resetWidth()
    }
    window.addEventListener('stack-reset-width', reset)
    return () => window.removeEventListener('stack-reset-width', reset)
  }, [id, resetWidth])

  return (
    <div
      ref={ref}
      className={`stack-panel ${pinned ? 'pinned' : 'floating'}${shown ? ' shown' : ''}${pinned && fill ? ' fill' : ''}${full === 'self' ? ' fullscreen' : full === 'behind' ? ' behind' : ''}`}
      data-panel={id}
      style={full === 'self' ? undefined : pinned ? { order, flexBasis: width, minWidth: meta.size.min } : { width, left }}
      onMouseEnter={() => !pinned && shown && peekPanel(id)}
    >
      <div className="stack-body">{children}</div>
      {/* the stretched one has no width of its own to drag; one right of it is dragged from the panel before it */}
      {!full && !(pinned && (fill || afterFill)) && (
        <div className="sidebar-resize" title="Drag to resize · double-click to reset" onPointerDown={(e) => startResize(e)} onDoubleClick={resetWidth} />
      )}
      {controls && (
        <div
          className="sidebar-resize"
          title="Drag to resize · double-click to reset"
          onPointerDown={(e) => window.dispatchEvent(new CustomEvent('stack-resize-start', { detail: { id: controls, event: e } }))}
          onDoubleClick={() => window.dispatchEvent(new CustomEvent('stack-reset-width', { detail: controls }))}
        />
      )}
    </div>
  )
}

/** A drop-down's width: dragged on its right edge, remembered; double-click on the edge resets it. */
function useWidth(size: FloatSize): [number, (e: React.PointerEvent<HTMLDivElement>, leftOf?: HTMLElement) => void, () => void] {
  const [width, setWidth] = useState(() => {
    try {
      return Number(userStore.getItem(size.key)) || size.initial()
    } catch {
      return size.initial()
    }
  })
  const save = (w: number | null): void => {
    try {
      if (w === null) userStore.removeItem(size.key)
      else userStore.setItem(size.key, String(w))
    } catch {
      /* it resets next time */
    }
  }
  /** `leftOf`: the drop-down is dragged by its left edge (the handle belongs to the one before it) */
  const start = (e: React.PointerEvent<HTMLDivElement>, leftOf?: HTMLElement): void => {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('dragging')
    const box = (leftOf ?? handle.parentElement!).getBoundingClientRect()
    let w = width
    const move = (ev: PointerEvent): void => {
      const max = Math.max(size.min + 20, window.innerWidth * 0.96)
      w = Math.round(Math.min(max, Math.max(size.min, leftOf ? box.right - ev.clientX : ev.clientX - box.left)))
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
