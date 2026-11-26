import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { SlidePill } from './motion'
import {
  ChevronDown,
  CircleCheck,
  CircleAlert,
  Files,
  FolderOpen,
  GitBranch,
  GitCompare,
  Loader2,
  MessagesSquare,
  PanelLeft,
  PanelBottom,
  Search,
  Clock,
  ArrowDownToLine,
  ChevronUp,
  Minus,
  Square,
  Copy,
  X,
  Link2,
  Check,
  Droplet,
  Globe,
  Code2,
  Moon,
  Sun
} from 'lucide-react'
import { basename, panelShown, togglePanel, useStore, type SidebarView } from '../store'
import { StackBar } from './Stack'
import { defaultAgent, installedAgents, openBrowser, openFile, openFolder, openSession, setDefaultAgent, setTheme, toggleBottom, toggleTheme, type ThemeChoice } from '../actions'
import { agentDef } from '../../../shared/agents'
import { languageOf } from '../fileModelsLite'
import { FileIcon, Logo } from './icons'
import type { UsageLimit } from '../../../shared/types'
import { revealIn } from '../scroll'
import { COMMANDS, pluginCommands, type Command } from '../shortcuts'
import { openRail } from '../rail'

/* ================================ Title bar ================================ */

/** Empty parts of the title bar move the window (the drop-down stays pinned to the top edge). */
const NO_DRAG = 'button, input, a, kbd, .menu, .search-box, .folder-switch, .win-controls'
// A double-click is handled here (e.detail === 2), not in onDoubleClick: once the first click
// has started a native drag, Windows maximizes on the second click by itself, and a separate
// dblclick handler then toggled it straight back — the window flickered and the
// maximize/restore button showed the wrong state.
function dragWindow(e: React.MouseEvent): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest(NO_DRAG)) return
  if (e.detail === 2) return window.api.win.toggleMaximize()
  window.api.win.drag(e.button, e.clientX, e.clientY)
}

export function TitleBar(): React.JSX.Element {
  const root = useStore((s) => s.root)

  return (
    <div className={window.api.platform === 'darwin' ? 'titlebar mac' : 'titlebar'} onMouseDown={dragWindow}>
      <div className="titlebar-left">
        {root && <StackBar />}
      </div>
      {root && (
        <button className="search-box" onClick={() => useStore.setState({ quickOpen: true })}>
          <Search size={13} />
          <span>Search files in {basename(root)}</span>
          <kbd>Ctrl+P</kbd>
        </button>
      )}
      <div className="titlebar-right">
        <ThemeToggle />
        <WindowControls />
      </div>
    </div>
  )
}

/** Theme: a click goes light → dark → system → light, like DBX's own toolbar. */
const THEME_ORDER: ThemeChoice[] = ['light', 'dark', 'system']
const THEME_LABEL: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'System (follows the OS)' }
function ThemeToggle(): React.JSX.Element {
  const light = useStore((s) => s.themeResolved === 'light')
  const choice = useStore((s) => (s.settings?.theme as ThemeChoice | undefined) ?? 'system')
  const next = THEME_ORDER[(THEME_ORDER.indexOf(choice) + 1) % THEME_ORDER.length] ?? 'light'
  return (
    <button className="icon-btn" title={`Theme: ${THEME_LABEL[choice]} · click for ${THEME_LABEL[next]}`} onClick={() => void setTheme(next)}>
      {light ? <Moon size={15} /> : <Sun size={15} />}
    </button>
  )
}

/** Window opacity: a button that opens a slider (20–100%). */
function OpacityControl(): React.JSX.Element {
  const saved = useStore((s) => s.settings?.dropOpacity ?? 1)
  const seeThrough = useStore((s) => !!s.settings?.seeThrough)
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState(false)
  const [val, setVal] = useState(saved)
  const ref = useRef<HTMLDivElement>(null)
  // while the slider is open it shows what you drag, not a (possibly older) saved answer
  useEffect(() => {
    if (!open) setVal(saved)
  }, [saved, open])
  const saveSeq = useRef(0)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const save = async (v: number): Promise<void> => {
    setVal(v)
    const my = ++saveSeq.current
    const settings = await window.api.app.setSettings({ dropOpacity: v }).catch(() => null)
    // answers to earlier drags come back late: only the last one counts
    if (settings && my === saveSeq.current) useStore.setState({ settings })
  }
  return (
    <div className="opacity-ctl" ref={ref}>
      <button className={`icon-btn${open ? ' active' : ''}`} title={`Window opacity: ${Math.round(val * 100)}%`} onClick={() => setOpen(!open)}>
        <Droplet size={15} />
      </button>
      {open && (
        <div className="menu opacity-pop">
          <button
            className={`see-through${seeThrough ? ' on' : ''}`}
            onClick={async () => {
              const next = !seeThrough
              const msg = next
                ? 'See-through: the background turns transparent and text stays sharp, like a Linux overlay terminal.\n\nVIBE CODE has to restart. Open chats close; reopen them from Chats.'
                : 'Turn off see-through? VIBE CODE has to restart. Open chats close; reopen them from Chats.'
              if (!window.confirm(msg)) return
              const settings = await window.api.app.setSettings({ seeThrough: next }).catch(() => null)
              if (settings) useStore.setState({ settings })
              if (!(await window.api.app.relaunch())) setPending(true)
            }}
          >
            <span className="see-through-box">{seeThrough && <Check size={11} />}</span>
            See-through (Linux overlay)
          </button>
          {pending && <div className="opacity-note">Dev mode: stop and rerun npm run dev to apply.</div>}
          <div className="opacity-row">
            <span>{seeThrough ? 'Background' : 'Opacity'}</span>
            <b>{Math.round(val * 100)}%</b>
          </div>
          <input type="range" min={seeThrough ? 5 : 20} max={100} step={1} value={Math.round(val * 100)} onChange={(e) => save(Number(e.target.value) / 100)} />
          <div className="opacity-presets">
            {[0.3, 0.5, 0.75, 1].map((p) => (
              <button key={p} className={`chip${Math.abs(val - p) < 0.005 ? ' on' : ''}`} onClick={() => save(p)}>
                {Math.round(p * 100)}%
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ModeSwitch(): React.JSX.Element | null {
  const win = useStore((s) => s.win)
  if (!win) return null
  const drop = win.mode === 'dropdown'
  return (
    <button
      className={`mode-switch${drop ? ' on' : ''}`}
      title={drop ? 'Switch to a normal window' : `Drop-down mode: ${win.hotkey} slides VIBE CODE over any app`}
      onClick={() => window.api.win.setMode(drop ? 'window' : 'dropdown')}
    >
      <ArrowDownToLine size={13} />
      <span>{drop ? 'Drop-down' : 'Guake'}</span>
      {win.hotkeyOk && <kbd>{win.hotkey}</kbd>}
    </button>
  )
}

function WindowControls(): React.JSX.Element | null {
  const win = useStore((s) => s.win)
  if (!win) return null
  // macOS draws its own traffic lights (top-left) — ours would be a second set
  if (window.api.platform === 'darwin' && win.mode !== 'dropdown') return null
  return (
    <div className="win-controls">
      <button className="win-btn" title="Minimize" onClick={() => window.api.win.minimize()}>
        <Minus size={15} />
      </button>
      <button className="win-btn" title={win.maximized ? 'Restore' : 'Maximize'} onClick={() => window.api.win.toggleMaximize()}>
        {win.maximized ? <Copy size={12} style={{ transform: 'scaleX(-1)' }} /> : <Square size={12} />}
      </button>
      <button className="win-btn close" title="Close" onClick={() => window.api.win.close()}>
        <X size={16} />
      </button>
    </div>
  )
}

/* ================================ Status bar ================================ */

/** "1:00 PM" today, "Fri 3:00 AM" later in the week. */
function resetLabel(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** Plan usage limits (same as Claude's "Plan usage limits" panel), refreshed every 2 minutes. */
function UsageMeters(): React.JSX.Element | null {
  const [limits, setLimits] = useState<UsageLimit[] | null>(null)
  useEffect(() => {
    let live = true
    const load = (): void => {
      // optional call: an app started before this feature has no `usage` bridge until it restarts
      window.api.claude.usage?.().then((l) => live && l && setLimits(l)).catch(() => {})
    }
    load()
    const t = setInterval(load, 120000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])
  return (
    <div className="usage-meters">
      {limits?.map((l) => (
        <div key={l.kind + l.label} className={`usage-meter sev-${l.severity}`} title={`${l.label}: ${l.percent}% used · resets ${resetLabel(l.resetsAt)}`}>
          <span className="usage-label">{l.label}</span>
          <span className="usage-bar">
            <span style={{ width: `${Math.min(100, l.percent)}%` }} />
          </span>
          <span className="usage-pct">{l.percent}%</span>
          {l.resetsAt && <span className="usage-reset">↻ {resetLabel(l.resetsAt)}</span>}
        </div>
      ))}
      <RamMeter />
    </div>
  )
}

/** Machine-wide RAM in use, refreshed every 5 seconds. */
function RamMeter(): React.JSX.Element | null {
  const [mem, setMem] = useState<{ usedBytes: number; totalBytes: number } | null>(null)
  useEffect(() => {
    let live = true
    const load = (): void => {
      window.api.claude.memory?.().then((m) => live && setMem(m)).catch(() => {})
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])
  if (!mem?.totalBytes) return null
  const percent = Math.round((mem.usedBytes / mem.totalBytes) * 100)
  const gb = (b: number): string => (b / 1024 ** 3).toFixed(1)
  const severity = percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal'
  return (
    <div className={`usage-meter sev-${severity}`} title={`RAM: ${gb(mem.usedBytes)} GB of ${gb(mem.totalBytes)} GB in use`}>
      <span className="usage-label">RAM</span>
      <span className="usage-bar">
        <span style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
      <span className="usage-pct">{percent}%</span>
      <span className="usage-reset">
        {gb(mem.usedBytes)}/{gb(mem.totalBytes)} GB
      </span>
    </div>
  )
}

export function StatusBar(): React.JSX.Element {
  const root = useStore((s) => s.root)
  const git = useStore((s) => s.git)
  const claude = useStore((s) => s.claude)
  const working = useStore((s) => s.chats.filter((c) => c.status === 'working').length)
  const total = useStore((s) => s.chats.length)
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {root && (
          <button
            className="sb-item"
            title={`${basename(root)} · ${root}\nClick to open another folder`}
            aria-label={`Project folder ${basename(root)}, open another`}
            onClick={() => void openFolder(null, { autoChat: false })}
          >
            <FolderOpen size={12} />
          </button>
        )}
        {git.isRepo && (
          <span className="sb-item" title={git.root ?? undefined}>
            <GitBranch size={12} /> {git.branch}
            {git.files.length > 0 && <span className="sb-muted">· {git.files.length} changed</span>}
          </span>
        )}
        {total > 0 && (
          <button
            className="sb-item"
            onClick={() => {
              openRail('project', 'open')
            }}
          >
            {working > 0 ? <Loader2 size={12} className="spin" /> : <MessagesSquare size={12} />}
            {working > 0 ? `${working} working` : `${total} chat${total > 1 ? 's' : ''}`}
          </button>
        )}
      </div>
      <UsageMeters />
      <div className="statusbar-right">
        {tab && <span className="sb-item">{languageOf(tab.path)}</span>}
        {tab && <span className="sb-item">UTF-8</span>}
        {claude && <AgentPicker />}
      </div>
    </div>
  )
}

/** Status-bar "AI in use" picker — a plain New chat starts with the agent chosen here. */
function AgentPicker(): React.JSX.Element {
  const claude = useStore((s) => s.claude)
  useStore((s) => s.agents)
  useStore((s) => s.preferredAgent)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const list = installedAgents()
  const cur = defaultAgent()

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', esc, true)
    }
  }, [open])

  if (!cur)
    return (
      <span className="sb-item warn" title={claude?.path ?? ''}>
        <CircleAlert size={12} /> No AI agent found
      </span>
    )
  return (
    <div className="sb-agent" ref={ref}>
      <button className="sb-item ok" title="AI in use — New chat starts with this agent" onClick={() => setOpen((o) => !o)}>
        <CircleCheck size={12} /> {agentDef(cur).label}
        {list.length > 1 && <ChevronUp size={11} />}
      </button>
      {open && list.length > 0 && (
        <div className="menu sb-agent-menu">
          <div className="menu-sep">AI in use</div>
          {list.map((id) => {
            const a = agentDef(id)
            return (
              <button
                key={id}
                className="menu-item"
                onClick={() => {
                  setDefaultAgent(id)
                  setOpen(false)
                }}
              >
                <span className="menu-item-main">{a.label}</span>
                {id === cur ? <Check size={12} /> : <span className="menu-item-sub">{a.cmd}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ================================ Quick open ================================ */

/** `q` and `t` already lower-cased. */
function fuzzy(q: string, t: string): number {
  if (!q) return 1
  const name = t.slice(t.lastIndexOf('/') + 1)
  if (name.startsWith(q)) return 1000 - name.length
  if (name.includes(q)) return 800 - name.length
  if (t.includes(q)) return 500 - t.length
  let ti = 0
  let score = 0
  for (const ch of q) {
    const idx = t.indexOf(ch, ti)
    if (idx < 0) return -1
    score += idx === ti ? 3 : 1
    ti = idx + 1
  }
  return score
}

/**
 * Ctrl+P: files. With ">" first (Ctrl+Shift+P / F1): every command and its shortcut.
 * "@" jumps to a symbol in the open file, ":" to a line.
 */
export function QuickOpen(): React.JSX.Element {
  const root = useStore((s) => s.root)
  const [files, setFiles] = useState<string[]>([])
  const [q, setQ] = useState(() => useStore.getState().quickOpenQuery)
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const commandMode = q.startsWith('>')

  useEffect(() => {
    if (root) window.api.fs.listFiles(root).then(setFiles)
  }, [root])

  // lower-cased once per project, not once per file per keystroke
  const lower = useMemo(() => files.map((f) => f.toLowerCase()), [files])
  // typing stays responsive in big projects: the list catches up a frame later
  const dq = useDeferredValue(q)
  const fileHits = useMemo(() => {
    if (dq.startsWith('>')) return []
    const needle = dq.trim().toLowerCase()
    if (!needle) return files.slice(0, 60)
    const hits: { f: string; s: number }[] = []
    for (let i = 0; i < files.length; i++) {
      const sc = fuzzy(needle, lower[i])
      if (sc >= 0) hits.push({ f: files[i], s: sc })
    }
    return hits
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.f)
  }, [files, lower, dq])
  const plugins = useStore((s) => s.plugins)
  const commandHits = useMemo(() => {
    if (!commandMode) return []
    const all = [...COMMANDS, ...pluginCommands(plugins)]
    const needle = q.slice(1).trim().toLowerCase()
    if (!needle) return all
    return all
      .map((c) => ({ c, s: fuzzy(needle, c.label.toLowerCase()) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
  }, [commandMode, q, plugins])
  const count = commandMode ? commandHits.length : fileHits.length

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    revealIn(listRef.current, listRef.current?.children[sel], { block: 'nearest' })
  }, [sel])

  const close = (): void => useStore.setState({ quickOpen: false, quickOpenQuery: '' })
  const pickFile = (rel: string): void => {
    if (!root) return
    const sep = window.api.platform === 'win32' ? '\\' : '/'
    openFile(root.replace(/[\\/]$/, '') + sep + rel.replace(/[\\/]/g, sep))
    close()
  }
  const runCommand = (c: Command): void => {
    close()
    // after the palette is gone, so focus lands where the command puts it
    setTimeout(c.run)
  }
  const pick = (i: number): void => {
    if (commandMode) {
      if (commandHits[i]) runCommand(commandHits[i])
    } else if (fileHits[i]) pickFile(fileHits[i])
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={15} />
          <input
            autoFocus
            placeholder={commandMode ? 'Type a command…' : 'Search files by name…  (> commands · @ symbol · : line)'}
            value={q}
            onChange={(e) => {
              const v = e.target.value
              // "@" → symbols in the open file, ":" → go to line (as in VS Code)
              if (v === '@' || v === ':') {
                close()
                setTimeout(() => window.dispatchEvent(new Event(v === '@' ? 'go-to-symbol' : 'go-to-line')))
              } else setQ(v)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(s + 1, count - 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(s - 1, 0))
              }
              if (e.key === 'Enter') pick(sel)
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {commandMode
            ? commandHits.map((c, i) => (
                <div key={c.id} className={`palette-row${i === sel ? ' sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => runCommand(c)}>
                  <span className="palette-name">{c.label}</span>
                  {c.keys && <kbd className="palette-keys">{c.keys}</kbd>}
                </div>
              ))
            : fileHits.map((r, i) => {
                const name = r.split('/').pop()!
                return (
                  <div key={r} className={`palette-row${i === sel ? ' sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => pickFile(r)}>
                    <FileIcon name={name} />
                    <span className="palette-name">{name}</span>
                    <span className="palette-dir">{r.slice(0, -name.length - 1)}</span>
                  </div>
                )
              })}
          {count === 0 && (
            <div className="palette-empty">{commandMode ? 'No matching commands' : !root ? 'Open a folder first' : files.length ? 'No matching files' : 'Indexing…'}</div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ================================ Welcome (no folder) ================================ */

export function Welcome(): React.JSX.Element {
  const claude = useStore((s) => s.claude)
  const projects = useStore((s) => s.projects)
  const byRecent = [...projects].sort((a, b) => b.updated - a.updated)
  const totalChats = projects.reduce((n, g) => n + g.sessions.length, 0)
  return (
    <div className="welcome">
      <div className="welcome-bg" />
      <div className="welcome-grid">
        <div className="welcome-inner">
          <div className="glow-orb big">
            <Logo size={84} />
          </div>
          <h1>
            VIBE <span className="h1-accent">CODE</span>
          </h1>
          <p className="welcome-sub">A home for Claude Code. Parallel chats, a real editor, and every change one click away.</p>
          <button className="btn btn-primary btn-lg" onClick={() => openFolder()}>
            <FolderOpen size={17} /> Open a project folder
          </button>
          {claude && !claude.found && (
            <p className="welcome-warn">
              <CircleAlert size={14} /> Claude Code CLI was not found on this machine. You'll get install steps after opening a folder.
            </p>
          )}
        </div>

        {projects.length > 0 && (
          <div className="claude-projects">
            <div className="cp-head">
              <span className="cp-title">
                <Link2 size={13} /> From Claude
              </span>
              <span className="cp-sub">
                {projects.length} projects · {totalChats} chats
              </span>
            </div>
            <div className="cp-list">
              {byRecent.map((g) => (
                <div key={g.key} className="cp-proj">
                  <button className="cp-proj-row" onClick={() => openFolder(g.cwd, { autoChat: false })} title={g.cwd}>
                    <FolderOpen size={15} />
                    <span className="cp-name">{g.name}</span>
                    <span className="cp-count">{g.sessions.length}</span>
                    <span className="cp-path">{g.cwd}</span>
                  </button>
                  {g.sessions.slice(0, 2).map((s) => (
                    <button key={s.id} className="cp-sess" onClick={() => openSession(s)} title={`Resume: ${s.title}`}>
                      <MessagesSquare size={12} />
                      <span className="cp-sess-title">{s.title}</span>
                      <span className="cp-sess-time">{ago(s.updated)}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ago(t: number): string {
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
