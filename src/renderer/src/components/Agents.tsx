import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Bot, Check, Copy, FolderOpen, LayoutGrid, Plus, RefreshCw, Star } from 'lucide-react'
import { basename, shownLayout, useStore, type Chat } from '../store'
import { chatDragSource, chatDropTarget, defaultAgent, detectClaude, hoverFocus, newChatWith, newLayoutChat, selectChat, setDefaultAgent, setGridLayout, takeGridPickRequest } from '../actions'
import { AGENTS, agentDef, type AgentId } from '../../../shared/agents'
import { COMMANDS } from '../shortcuts'
import { takeRailRequest, type RailId, type RailRequest } from '../rail'
import { isSlot, type Layout } from '../chatLayout'
import { SideGroup } from './SideGroup'
import { ChatsView } from './Sidebar'
import { StatusDot } from './icons'

/** what counts as "on the rail": its icons, the flyout, and the popups beside the flyout */
const RAIL_PARTS = '.agent-rail, .agent-flyout, .explorer-pop, .menu, .ctx-menu, .overlay'

/**
 * The Agent drop-down: a rail of icons on the left, the chat (`children`) on the right. Each icon
 * opens its group as a flyout beside the rail: while the pointer is on an icon, the flyout follows
 * it; a click or a hotkey keeps it open until you click elsewhere, press Esc, or pick the icon again.
 * The chat stays the same element whatever the rail does, so its terminals are never rebuilt.
 */
export function AgentSplit({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [pinned, setPinned] = useState<RailId | null>(null)
  const [hover, setHover] = useState<RailId | null>(null)
  const shown = hover ?? pinned
  // read by the window listeners below, which are set up once per hover or pin
  const hoverRef = useRef<RailId | null>(null)
  const pinnedRef = useRef<RailId | null>(null)
  hoverRef.current = hover
  pinnedRef.current = pinned
  // a file open in the project's Files popup keeps its flyout: leaving or clicking elsewhere would close the file
  const fileOpen = (id: RailId | null): boolean => id === 'project' && useStore.getState().inlineTab !== null

  const apply = (req: RailRequest): void => {
    setHover(null)
    setPinned((p) => (req.mode === 'toggle' && p === req.id ? null : req.id))
  }

  // hotkeys and other parts of the app; a request made before this mounted waits for it
  useEffect(() => {
    const onRequest = (e: Event): void => {
      takeRailRequest()
      apply((e as CustomEvent<RailRequest>).detail)
    }
    const waiting = takeRailRequest()
    if (waiting) apply(waiting)
    const onClose = (e: Event): void => {
      const id = (e as CustomEvent<RailId | undefined>).detail
      setHover((h) => (id === undefined || h === id ? null : h))
      setPinned((p) => (id === undefined || p === id ? null : p))
    }
    window.addEventListener('rail-open', onRequest)
    window.addEventListener('rail-close', onClose)
    return () => {
      window.removeEventListener('rail-open', onRequest)
      window.removeEventListener('rail-close', onClose)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // a hovered icon's flyout closes once the pointer is off the rail and its popups
  useEffect(() => {
    if (hover === null) return
    let timer = 0
    const move = (e: PointerEvent): void => {
      window.clearTimeout(timer)
      const t = e.target
      if (t instanceof Element && t.closest(RAIL_PARTS)) return
      if (fileOpen(hoverRef.current)) return
      timer = window.setTimeout(() => setHover(null), 180)
    }
    window.addEventListener('pointermove', move, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', move, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover !== null])

  // a pinned flyout closes on a click elsewhere, and on Esc (not while typing in a popup or the chat)
  useEffect(() => {
    if (pinned === null) return
    const down = (e: MouseEvent): void => {
      const t = e.target
      if (t instanceof Element && t.closest(RAIL_PARTS)) return
      if (fileOpen(pinnedRef.current)) return
      setPinned(null)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.activeElement?.closest('.explorer-nav, .xterm')) return
      setPinned(null)
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned !== null])

  return (
    <div className="agent-split">
      <AgentRail
        shown={shown}
        pinned={pinned}
        onHover={setHover}
        onPick={(id) => apply({ id, mode: 'toggle' })}
      />
      <div className="agent-chat">{children}</div>
    </div>
  )
}

/** One icon per group. `cmd` is the command that opens it, so the tooltip can show its hotkey. */
const RAIL: { id: RailId; label: string; icon: LucideIcon; cmd: string }[] = [
  { id: 'project', label: 'Project', icon: FolderOpen, cmd: 'railProject' },
  { id: 'agents', label: 'Agents', icon: Bot, cmd: 'railAgents' }
]

function AgentRail({
  shown,
  pinned,
  onHover,
  onPick
}: {
  shown: RailId | null
  pinned: RailId | null
  onHover: (id: RailId) => void
  onPick: (id: RailId) => void
}): React.JSX.Element {
  const railRef = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  const items = RAIL
  const flyoutOpen = shown !== null && items.some((r) => r.id === shown)

  // the flyout hangs from its icon
  useLayoutEffect(() => {
    if (!shown) return
    const btn = railRef.current?.querySelector<HTMLElement>(`[data-rail="${shown}"]`)
    if (btn && btn.offsetTop !== top) setTop(btn.offsetTop)
  }, [shown, top])

  return (
    <div className="agent-rail" ref={railRef}>
      {items.map((r) => {
        const Icon = r.icon
        const keys = COMMANDS.find((c) => c.id === r.cmd)?.keys
        return (
          <button
            key={r.id}
            data-rail={r.id}
            className={`agent-rail-btn${shown === r.id ? ' on' : ''}${pinned === r.id ? ' pinned' : ''}`}
            title={keys ? `${r.label}  (${keys})` : r.label}
            onMouseEnter={() => onHover(r.id)}
            onClick={() => onPick(r.id)}
          >
            <Icon size={15} />
          </button>
        )
      })}
      {flyoutOpen && shown && (
        <div className="agent-flyout" style={{ top, maxHeight: `calc(100% - ${top + 8}px)` }}>
          <RailBody id={shown} />
        </div>
      )}
    </div>
  )
}

/** The Project flyout: the filter with New project beside it, then the chats of every project. Opening it puts the cursor in the filter. */
function ProjectBody(): React.JSX.Element {
  return <ChatsView />
}

function RailBody({ id }: { id: RailId }): React.JSX.Element {
  return (
    <div className="agents-panel agent-flyout-body">
      {id === 'project' && <ProjectBody />}
      {id === 'agents' && <AgentsGroup always />}
    </div>
  )
}

export function AgentsGroup({ always }: { always?: boolean }): React.JSX.Element {
  const claude = useStore((s) => s.claude)
  const found = useStore((s) => s.agents)
  const chats = useStore((s) => s.chats)
  // re-render when the default changes (defaultAgent() reads it)
  useStore((s) => s.preferredAgent)
  const root = useStore((s) => s.root)
  const fallback = defaultAgent()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<AgentId | null>(null)

  const installed = (id: AgentId): boolean => (id === 'claude' ? !!claude?.found : found.some((a) => a.id === id && a.found))
  const chatsOf = (id: AgentId): typeof chats => chats.filter((c) => agentDef(c.agent).id === id)
  const refresh = async (): Promise<void> => {
    setBusy(true)
    await detectClaude().catch(() => {})
    setBusy(false)
  }
  const copy = (id: AgentId, text: string): void => {
    void navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200)
  }

  return (
    <SideGroup
      id="agents"
      label="Agents"
      always={always}
      actions={
        <button className="icon-btn tiny" title="Look for installed agents again" onClick={() => void refresh()}>
          <RefreshCw size={12} className={busy ? 'spin' : ''} />
        </button>
      }
    >
      <LayoutMap />
      {AGENTS.map((a) => {
        const ok = installed(a.id)
        const n = chatsOf(a.id).length
        const isDefault = ok && fallback === a.id
        return (
          <div key={a.id} className={`agent-row${ok ? '' : ' missing'}`}>
            <button
              className={`icon-btn tiny agent-default${isDefault ? ' on' : ''}`}
              title={isDefault ? 'New chats start with this agent' : ok ? 'Start new chats with this agent' : 'Not installed'}
              disabled={!ok}
              onClick={() => setDefaultAgent(a.id)}
            >
              <Star size={13} />
            </button>
            <div className="agent-main">
              <span className="agent-name">{a.label}</span>
              {ok ? (
                <span className="agent-sub">
                  {a.cmd}
                  {n > 0 && ` · ${n} open`}
                </span>
              ) : (
                <button className="agent-install" title="Copy the install command" onClick={() => copy(a.id, a.install)}>
                  {copied === a.id ? <Check size={11} /> : <Copy size={11} />}
                  <code>{a.install}</code>
                </button>
              )}
            </div>
            <button
              className="icon-btn tiny"
              title={!root ? 'Open a folder first' : ok ? `New ${a.label} chat in ${basename(root)}` : 'Not installed'}
              disabled={!ok || !root}
              onClick={() => newChatWith(a.id)}
            >
              <Plus size={14} />
            </button>
          </div>
        )
      })}
    </SideGroup>
  )
}

const GRID_MAX = 4

/**
 * A button that opens a small grid: hover or use the arrow keys to size it (columns × rows), then click
 * or press Enter to give the chats that many cells. Esc closes it.
 */
function GridPick({ title, onPick, listen }: { title: string; onPick: (rows: number, cols: number) => void; listen?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState({ rows: 2, cols: 2 })
  const ref = useRef<HTMLDivElement>(null)
  // keyboard: arrows resize, Enter applies, Esc closes (captured, so the rest of the app does not also get the keys)
  useEffect(() => {
    if (!open) return
    const clamp = (n: number): number => Math.min(GRID_MAX, Math.max(1, n))
    const key = (e: KeyboardEvent): void => {
      const step: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
      const d = step[e.key]
      if (d) {
        e.preventDefault()
        e.stopPropagation()
        setSize((s) => ({ rows: clamp(s.rows + d[0]), cols: clamp(s.cols + d[1]) }))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        onPick(size.rows, size.cols)
        setOpen(false)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, size])
  // the shortcut (Alt+Shift+L) opens the one picker that is listening; it may mount after the request
  useEffect(() => {
    if (!listen) return
    if (takeGridPickRequest()) setOpen(true)
    const onRequest = (): void => {
      if (takeGridPickRequest()) setOpen(true)
    }
    window.addEventListener('grid-pick-open', onRequest)
    return () => window.removeEventListener('grid-pick-open', onRequest)
  }, [listen])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close, true)
    return () => window.removeEventListener('mousedown', close, true)
  }, [open])
  return (
    <div className="grid-pick" ref={ref}>
      <button className="icon-btn tiny" title={title} onClick={() => setOpen((o) => !o)}>
        <LayoutGrid size={13} />
      </button>
      {open && (
        <div className="grid-pick-pop">
          <div className="grid-pick-cells">
            {Array.from({ length: GRID_MAX * GRID_MAX }, (_, i) => {
              const rows = Math.floor(i / GRID_MAX) + 1
              const cols = (i % GRID_MAX) + 1
              const on = rows <= size.rows && cols <= size.cols
              return (
                <button
                  key={i}
                  className={`grid-pick-cell${on ? ' on' : ''}`}
                  title={`${cols} × ${rows}`}
                  onMouseEnter={() => setSize({ rows, cols })}
                  onClick={() => {
                    setSize({ rows, cols })
                    onPick(rows, cols)
                    setOpen(false)
                  }}
                />
              )
            })}
          </div>
          <div className="grid-pick-label">
            {size.cols} columns × {size.rows} rows · ←↑↓→ size, Enter apply
          </div>
        </div>
      )}
    </div>
  )
}

function LayoutTree({ node, chats, activeId }:{ node: Layout | string; chats: Chat[]; activeId: string | null }): React.JSX.Element | null {
  if (typeof node === 'string') {
    if (isSlot(node)) {
      return (
        <div className="layout-map-cell empty" title="Empty cell: drag an agent here" {...chatDropTarget(node)}>
          <span className="layout-map-title">empty</span>
        </div>
      )
    }
    const c = chats.find((x) => x.id === node)
    if (!c) return null
    return (
      <button className={`layout-map-cell${c.id === activeId ? ' on' : ''}`} title={c.title} onClick={() => selectChat(c.id)} {...hoverFocus(c.id)} {...chatDragSource(c.id)} {...chatDropTarget(c.id)}>
        <StatusDot status={c.status} attention={c.attention} />
        <span className="layout-map-title">{c.title}</span>
      </button>
    )
  }
  return (
    <div className={`layout-map-split ${node.dir}`}>
      {node.kids.map((k, i) => (
        <LayoutTree key={i} node={k} chats={chats} activeId={activeId} />
      ))}
    </div>
  )
}

function LayoutMap(): React.JSX.Element {
  const activeId = useStore((s) => s.activeChatId)
  const chats = useStore((s) => s.chats)
  const chatLayouts = useStore((s) => s.chatLayouts)
  const mode = useStore((s) => s.layoutMode)
  // the same layout the chat pane shows: all chats in one grid, or only the active chat's project
  const shown = useMemo(() => shownLayout({ chats, activeChatId: activeId, chatLayouts, layoutMode: mode }), [chats, activeId, chatLayouts, mode])
  const active = chats.find((c) => c.id === activeId)
  return (
    <>
      <div className="layout-bar">
        <div className="layout-bar-tools">
          {mode === 'merged' ? (
            <GridPick title="Grid for all chats (Alt+Shift+L)" listen onPick={(rows, cols) => setGridLayout(rows, cols, null)} />
          ) : (
            active && <GridPick title={`Grid for ${basename(active.cwd)} (Alt+Shift+L)`} listen onPick={(rows, cols) => setGridLayout(rows, cols, active.cwd)} />
          )}
          <button className="icon-btn tiny" title="New chat in the layout (Alt+Shift+C)" onClick={() => newLayoutChat()}>
            <Plus size={14} />
          </button>
        </div>
      </div>
      {shown !== null && (
        <div className="layout-map">
          <LayoutTree node={shown} chats={chats} activeId={activeId} />
        </div>
      )}
    </>
  )
}
