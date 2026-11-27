import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Copy, FolderOpen, FolderPlus, FolderX, GitBranch, GripVertical, History, Loader2, Plus, RefreshCw, RotateCcw, Sparkles, SquareTerminal, Trash2, Upload, X, ExternalLink } from 'lucide-react'
import { basename, shownLayout, useStore, type Chat } from '../store'
import type { SessionInfo } from '../../../shared/types'
import { isHiddenProject, shortAgo } from './Sidebar'
import { isSlot, layoutIds, type Layout } from '../chatLayout'
import { SlidePill, useEnterAnimation } from './motion'
import {
  closeChat,
  closeShell,
  defaultAgent,
  detectClaude,
  newChat,
  newChatWith,
  newShell,
  renameChat,
  restartChat,
  chatDragSource,
  chatDropTarget,
  hoverFocus,
  hoverPane,
  openFileInOverlay,
  openFolder,
  openSession,
  selectChat
} from '../actions'
import { attachTerm, detachTerm, fitTerm, focusTerm, writeToTerm } from '../terminals'
import { Logo, StatusDot, statusLabel } from './icons'
import { AttachmentTray } from './AttachmentTray'
import { ExplorerNav } from './ExplorerNav'
import { COMMANDS } from '../shortcuts'
import { AGENTS, agentDef } from '../../../shared/agents'
import type { GitFile, GitState } from '../../../shared/types'
import { attachTokens, sideBySide, type DiffCell, type DiffRow, type LineTokens } from '../sideDiff'

export function TerminalView({ id, autoFocus = true }: { id: string; autoFocus?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current!
    attachTerm(id, el, autoFocus)
    // A fit that changes the column count re-wraps the whole scrollback: while a panel is dragged,
    // at most ~12 a second (the last size always gets one), not one every frame.
    let raf = 0
    let last = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = (): void => {
      last = performance.now()
      fitTerm(id)
    }
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      const wait = 80 - (performance.now() - last)
      if (wait <= 0) raf = requestAnimationFrame(run)
      else timer = setTimeout(() => (raf = requestAnimationFrame(run)), wait)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      detachTerm(id)
    }
  }, [id, autoFocus])
  return <div className="term-view" ref={ref} onMouseDown={() => setTimeout(() => focusTerm(id), 0)} />
}

/* ================================ Claude panel ================================ */

/** A chat's folder follows its shell: `cd` in the shell moves the chat (and its git panel) to the new folder. */
const SHELL_CWD_POLL_MS = 2000
const sameFolder = (a: string, b: string): boolean => a.toLowerCase().replace(/[\\/]+$/, '') === b.toLowerCase().replace(/[\\/]+$/, '')

function useShellFolders(): void {
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      if (!useStore.getState().chats.length) return
      window.api.pty
        .cwds()
        .then((list) => {
          if (!alive) return
          const moved = list.filter(({ id, cwd }) => {
            const c = useStore.getState().chats.find((x) => x.id === id)
            return !!c && !sameFolder(c.cwd, cwd)
          })
          if (!moved.length) return
          useStore.setState((s) => ({
            chats: s.chats.map((c) => {
              const hit = moved.find((m) => m.id === c.id)
              return hit ? { ...c, cwd: hit.cwd } : c
            })
          }))
        })
        .catch(() => {})
    }
    tick()
    const timer = window.setInterval(tick, SHELL_CWD_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])
}

export function ClaudePanel(): React.JSX.Element {
  useShellFolders()
  const activeId = useStore((s) => s.activeChatId)
  const chats = useStore((s) => s.chats)
  const chatLayouts = useStore((s) => s.chatLayouts)
  const layoutMode = useStore((s) => s.layoutMode)
  const shown = useMemo(() => shownLayout({ chats, activeChatId: activeId, chatLayouts, layoutMode }), [chats, activeId, chatLayouts, layoutMode])
  const hasActive = useStore((s) => s.chats.some((c) => c.id === s.activeChatId))
  const claude = useStore((s) => s.claude)
  // Codex / Gemini… alone is enough to chat; the install card is for when no agent is there at all
  const anyAgent = useStore((s) => !!s.claude?.found || s.agents.some((a) => a.found))
  return (
    <div className="claude-panel">
      {claude && !anyAgent && <InstallCard />}
      {anyAgent && !hasActive && <NoChat />}
      {shown !== null && (
        <div className={`claude-row${typeof shown === 'string' ? '' : ' split'}`}>
          <LayoutNode node={shown} activeId={activeId} />
        </div>
      )}
    </div>
  )
}

function LayoutNode({ node, activeId }: { node: Layout | string; activeId: string | null }): React.JSX.Element {
  if (typeof node === 'string') return isSlot(node) ? <EmptyColumn id={node} /> : <ChatColumn id={node} current={node === activeId} />
  return (
    <div className={`claude-split ${node.dir}${node.dir === 'col' && node.kids.length > 2 ? ' tall' : ''}`}>
      {node.kids.map((k) => (
        <div className="claude-cell" key={layoutIds(k)[0]}>
          <LayoutNode node={k} activeId={activeId} />
        </div>
      ))}
    </div>
  )
}

/** An empty cell of a grid: drop an agent on it to move that agent here. */
function EmptyColumn({ id }: { id: string }): React.JSX.Element {
  return (
    <div className="claude-col empty" {...chatDropTarget(id)}>
      <div className="claude-empty-hint">Drag an agent here</div>
    </div>
  )
}

function ChatColumn({ id, current }: { id: string; current: boolean }): React.JSX.Element {
  const active = useStore((s) => s.chats.find((c) => c.id === id) ?? null)
  const activeId = active?.id ?? null
  // switching chats: the new conversation eases in
  const termFrame = useRef<HTMLDivElement>(null)
  useEnterAnimation(termFrame, activeId)

  // the bar over the quick actions: moving while the chat works, green once that run has finished

  // Chats are picked from the sidebar, so there is no tab strip here — just the open chat's title row.
  return (
    <div
      className={`claude-col${current ? ' current' : ''}`}
      onPointerDownCapture={() => {
        if (!current) selectChat(id)
      }}
      {...hoverFocus(id, hoverPane)}
      {...chatDropTarget(id)}
    >
      {active && (
        <>
          <div className="chat-titlebar">
            <div className="chat-titlebar-main">
              <span className="chat-grip" title="Drag onto another pane to swap places" {...chatDragSource(active.id)}>
                <GripVertical size={13} />
              </span>
              <StatusDot status={active.status} attention={active.attention} />
              <FolderSwitch chat={active} />
              <ChatTitle chat={active} />
              <ChatHistory chat={active} />
              {agentDef(active.agent).id !== 'claude' && <span className="chat-agent">{agentDef(active.agent).label}</span>}
            </div>
            <div className="chat-titlebar-actions">
              {active.status === 'exited' && (
                <button className="btn btn-ghost btn-sm" onClick={() => restartChat(active.id)}>
                  <RefreshCw size={13} /> Restart
                </button>
              )}
              <AddAgentMenu />
              <button className="icon-btn" title="Close chat (it stays in the sidebar history)" onClick={() => closeChat(active.id)}>
                <X size={15} />
              </button>
            </div>
          </div>
          <div className="term-frame" ref={termFrame}>
            <div className="term-layer">
              <TerminalView id={active.id} />
            </div>
          </div>
          <AttachmentTray chatId={active.id} />
          <ChatSide cwd={active.cwd} />
        </>
      )}
    </div>
  )
}

/** ms the pointer must be away from the strip and its panel before the panel closes */
const SIDE_CLOSE_DELAY = 350

/**
 * The chat's bottom strip: its folder tree and its git changes, both rooted at the chat's own folder.
 * Hovering an icon opens its panel over the chat (the chat keeps its place); the panel closes once the
 * pointer has been away from it for a moment. A click on the icon toggles it.
 */
function ChatSide({ cwd }: { cwd: string }): React.JSX.Element {
  const [shown, setShown] = useState<'folder' | 'git' | null>(null)
  const [hovered, setHovered] = useState<GitFile | null>(null)
  const [git] = useFolderGit(cwd)
  const root = useStore((s) => s.root)
  const changed = git?.files.length ?? 0
  const closeTimer = useRef(0)
  const stripRef = useRef<HTMLDivElement>(null)
  const same = (a: string | null): boolean => !!a && a.toLowerCase().replace(/[\\/]+$/, '') === cwd.toLowerCase().replace(/[\\/]+$/, '')

  // while a panel is open: the pointer over the strip, the panel, the diff beside it or a popup of the folder tree keeps it
  useEffect(() => {
    if (!shown) {
      setHovered(null)
      return
    }
    const onMove = (e: MouseEvent): void => {
      const inside = (e.target as Element | null)?.closest?.('.chat-side, .chat-side-pop, .chat-diff-pop, .explorer-pop')
      if (inside) {
        window.clearTimeout(closeTimer.current)
        closeTimer.current = 0
      } else if (!closeTimer.current) {
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = 0
          setShown(null)
        }, SIDE_CLOSE_DELAY)
      }
    }
    document.addEventListener('mousemove', onMove)
    return () => {
      document.removeEventListener('mousemove', onMove)
      window.clearTimeout(closeTimer.current)
      closeTimer.current = 0
    }
  }, [shown])

  return (
    <>
      <div className="chat-side" ref={stripRef}>
        <button
          className={`icon-btn tiny${shown === 'folder' ? ' on' : ''}`}
          aria-label="Files of this chat's folder"
          aria-pressed={shown === 'folder'}
          title={`Files of ${cwd}`}
          onMouseEnter={() => setShown('folder')}
          onClick={() => setShown(shown === 'folder' ? null : 'folder')}
        >
          <FolderOpen size={14} />
        </button>
        <button
          className={`icon-btn tiny${shown === 'git' ? ' on' : ''}`}
          aria-label="Git changes of this chat's folder"
          aria-pressed={shown === 'git'}
          title="Git changes"
          onMouseEnter={() => setShown('git')}
          onClick={() => setShown(shown === 'git' ? null : 'git')}
        >
          <GitBranch size={14} />
          {changed > 0 && <span className="chat-side-badge">{changed > 99 ? '99+' : changed}</span>}
        </button>
        {git?.isRepo && (
          <span className="chat-side-branch" title={`Branch: ${git.branch ?? 'detached'}`}>
            {git.branch ?? 'detached'}
          </span>
        )}
      </div>
      {shown && (
        <div className={`chat-side-pop ${shown === 'folder' ? 'is-folder' : 'is-git'}`} onKeyDown={(e) => e.stopPropagation()}>
          {shown === 'folder' ? <ExplorerNav root={cwd} git={same(root)} /> : <ChatChanges cwd={cwd} onHover={setHovered} />}
        </div>
      )}
      {shown === 'git' && hovered && <ChatDiff repo={git?.root ?? cwd} file={hovered} strip={stripRef} />}
    </>
  )
}

/** Counts up whenever a file or git change is reported (the watched project's events, or a Refresh). */
function useFsNonce(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const bump = (): void => setN((x) => x + 1)
    window.addEventListener('git-changed', bump)
    window.addEventListener('fs-changed', bump)
    return () => {
      window.removeEventListener('git-changed', bump)
      window.removeEventListener('fs-changed', bump)
    }
  }, [])
  return n
}

/** How often a chat's git state is read on its own: the watch only covers the project folder, not every chat's. */
const FOLDER_GIT_POLL_MS = 6000

/** The git state of one folder (not the project's): read on start, on file events, after an action, and on a timer. */
function useFolderGit(cwd: string): [GitState | null, () => void] {
  const [git, setGit] = useState<GitState | null>(null)
  const [nonce, setNonce] = useState(0)
  const fsNonce = useFsNonce()
  useEffect(() => {
    let alive = true
    const load = (): void => {
      if (document.visibilityState !== 'visible') return
      window.api.git
        .state(cwd)
        .then((g) => alive && setGit(g))
        .catch(() => alive && setGit({ isRepo: false, root: null, branch: null, files: [] }))
    }
    load()
    const timer = window.setInterval(load, FOLDER_GIT_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [cwd, nonce, fsNonce])
  return [git, () => setNonce((n) => n + 1)]
}

/** The changes of one folder: commit and push them, revert one file or all, hover a file to review it. */
function ChatChanges({ cwd, onHover }: { cwd: string; onHover: (f: GitFile | null) => void }): React.JSX.Element {
  const [git, reload] = useFolderGit(cwd)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const repo = git?.root ?? cwd

  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      reload()
    }
  }

  const commitAndPush = (): void => {
    const message = msg.trim()
    if (!message || busy) return
    void (async () => {
      setBusy('commit')
      setError(null)
      try {
        await window.api.git.commit(repo, message, true)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setBusy(null)
        reload()
        return
      }
      setMsg('')
      setBusy('push')
      try {
        await window.api.git.push(repo)
      } catch (e) {
        setError(`Committed, but the push failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      setBusy(null)
      reload()
    })()
  }

  const revertAll = (): void => {
    if (!git?.files.length || busy) return
    if (!window.confirm(`Revert all ${git.files.length} changes in ${repo}? Uncommitted work is lost.`)) return
    void run('revert', () => window.api.git.revertAll(repo))
  }

  const revertFile = (f: GitFile): void => {
    if (busy) return
    if (!window.confirm(`Revert ${f.rel}? Its uncommitted changes are lost.`)) return
    void run('revert', () => window.api.git.revertFile(repo, f.rel, f.status === '?'))
  }

  if (!git) return <Loading label="Reading git…" />
  if (!git.isRepo) return <div className="tree-empty">Not a git repository</div>
  return (
    <div className="chat-changes">
      <div className="chat-changes-head">
        <span title={cwd}>{basename(cwd)}</span>
        <span className="chat-changes-branch">{git.branch ?? 'detached'}</span>
        <span className="chat-changes-spacer" />
        <button className="icon-btn tiny" title="Revert all changes" aria-label="Revert all changes" disabled={!git.files.length || !!busy} onClick={revertAll}>
          <RotateCcw size={13} />
        </button>
      </div>
      <div className="chat-commit">
        <input
          className="chat-commit-msg"
          placeholder="Commit message"
          value={msg}
          disabled={!!busy}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commitAndPush()
          }}
        />
        <button
          className="icon-btn tiny"
          title={busy === 'push' ? 'Pushing…' : 'Commit all changes and push'}
          aria-label="Commit and push"
          disabled={!msg.trim() || !git.files.length || !!busy}
          onClick={commitAndPush}
        >
          <Upload size={13} />
        </button>
      </div>
      {error && <div className="chat-changes-error">{error}</div>}
      {git.files.length === 0 && <div className="tree-empty">Working tree clean</div>}
      {git.files.map((f) => (
        <div
          key={f.abs}
          className="change-row chat-change"
          title={f.rel}
          onMouseEnter={() => onHover(f)}
          onClick={() => openFileInOverlay(f.abs)}
        >
          <span className="tree-status">{f.status === '?' ? 'U' : f.status}</span>
          <span className="tree-name">{f.rel}</span>
          <button
            className="icon-btn tiny chat-change-revert"
            title={`Revert ${f.rel}`}
            aria-label={`Revert ${f.rel}`}
            disabled={!!busy}
            onClick={(e) => {
              e.stopPropagation()
              revertFile(f)
            }}
          >
            <RotateCcw size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** The panel's place in the window, and where the diff goes beside it (right if it fits, else left). */
function diffPlace(strip: HTMLElement): { left: number; top: number; width: number; height: number } {
  const col = (strip.parentElement ?? strip).getBoundingClientRect()
  const panelRight = col.left + 8 + Math.min(360, col.width - 16)
  const bottom = strip.getBoundingClientRect().top - 6
  const height = Math.max(160, Math.min(480, bottom - 8))
  const top = Math.max(8, bottom - height)
  const want = 680
  const rightRoom = window.innerWidth - 8 - (panelRight + 8)
  if (rightRoom >= 420) return { left: panelRight + 8, top, width: Math.min(want, rightRoom), height }
  const leftRoom = col.left - 16
  const width = Math.max(240, Math.min(want, leftRoom))
  return { left: Math.max(8, col.left - 8 - width), top, width, height }
}

/** ms the pointer must rest on a file before its diff loads */
const DIFF_HOVER_DELAY = 120
/** the last few diffs shown, by file: coming back to a file is instant while it has not changed */
const diffCache = new Map<string, { old: string; cur: string; rows: DiffRow[] }>()
function rememberDiff(key: string, value: { old: string; cur: string; rows: DiffRow[] }): void {
  diffCache.delete(key)
  diffCache.set(key, value)
  if (diffCache.size > 24) diffCache.delete(diffCache.keys().next().value as string)
}

/** The folder name in the title bar: a menu of the projects you have opened, to jump to one, and a button to open another. */
function FolderSwitch({ chat }: { chat: Chat }): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const chats = useStore((s) => s.chats)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  // the project list of the sidebar (minus the ones it removed), plus any folder with an open chat that the list does not know yet
  const list = useMemo(() => {
    const seen = new Set(projects.map((p) => p.cwd.toLowerCase()))
    const extra = chats.map((c) => c.cwd).filter((cwd, i, all) => all.indexOf(cwd) === i && !seen.has(cwd.toLowerCase()))
    return [...projects.map((p) => ({ cwd: p.cwd, name: p.name })), ...extra.map((cwd) => ({ cwd, name: basename(cwd) }))].filter(
      (p) => !isHiddenProject(p.cwd) || sameFolder(p.cwd, chat.cwd)
    )
  // read again each time the menu opens, so a project removed from the sidebar is gone from it
  }, [projects, chats, open, chat.cwd])
  const pick = (cwd: string): void => {
    setOpen(false)
    const open = chats.find((c) => sameFolder(c.cwd, cwd))
    if (open) selectChat(open.id)
    else newChat({ cwd })
  }
  return (
    <div className="chat-switch" ref={ref}>
      <button className="chat-folder" title={chat.cwd} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {basename(chat.cwd)}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="chat-switch-menu" role="menu">
          {list.map((p) => (
            <button
              key={p.cwd}
              role="menuitem"
              className={`chat-switch-item${sameFolder(p.cwd, chat.cwd) ? ' on' : ''}`}
              title={p.cwd}
              onClick={() => pick(p.cwd)}
            >
              <FolderOpen size={13} />
              <span className="chat-switch-title">{p.name}</span>
              <span className="chat-switch-path">{p.cwd}</span>
            </button>
          ))}
          <div className="chat-switch-sep" />
          <button
            role="menuitem"
            className="chat-switch-item"
            onClick={() => {
              setOpen(false)
              void openFolder(null, { autoChat: true })
            }}
          >
            <FolderPlus size={13} />
            <span className="chat-switch-title">Open another project…</span>
          </button>
        </div>
      )}
    </div>
  )
}

/** The three groups of a folder's history, by the state of its chat: working, waiting for you, or completed. */
const HISTORY_GROUPS: { key: string; label: string; of: (s: SessionInfo, chats: Chat[]) => string }[] = [
  {
    key: 'working',
    label: 'Working',
    of: (s, chats) => {
      const live = chats.find((c) => c.sessionId === s.id)
      return live && (live.status === 'working' || live.status === 'starting') ? 'working' : ''
    }
  },
  {
    key: 'input',
    label: 'Need input',
    of: (s, chats) => {
      const live = chats.find((c) => c.sessionId === s.id)
      return live && live.status === 'idle' ? 'input' : ''
    }
  },
  {
    key: 'completed',
    label: 'Completed',
    of: (s, chats) => {
      const live = chats.find((c) => c.sessionId === s.id)
      return !live || live.status === 'exited' ? 'completed' : ''
    }
  }
]

/** The history of this chat's folder (its past Claude sessions), from the title bar; a click resumes one. */
function ChatHistory({ chat }: { chat: Chat }): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const chats = useStore((s) => s.chats)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  // sessions that ran in this folder (a worktree's roll up to its repo, so match either folder)
  const history = useMemo(
    () =>
      projects
        .flatMap((g) => g.sessions)
        .filter((s) => sameFolder(s.cwd, chat.cwd) || sameFolder(s.projectCwd, chat.cwd))
        .sort((a, b) => b.updated - a.updated),
    [projects, chat.cwd]
  )
      const renderItem = (s: SessionInfo): React.JSX.Element => {
        const live = chats.find((c) => c.sessionId === s.id)
        // the state: a live chat shows its status dot; a closed one a hollow ring; a missing folder a crossed folder
        const state = !s.cwdExists
          ? { label: 'Folder no longer exists', icon: <FolderX size={12} className="hist-state" /> }
          : live
            ? { label: `Open · ${statusLabel[live.status]}`, icon: <StatusDot status={live.status} attention={live.attention} /> }
            : { label: 'Closed', icon: <span className="hist-state hist-ring" /> }
        return (
          <button
            key={s.id}
            role="menuitem"
            className="chat-switch-item"
            title={`${s.title}\n${state.label}`}
            disabled={!s.cwdExists && !live}
            onClick={() => {
              setOpen(false)
              void openSession(s)
            }}
          >
            {state.icon}
            <span className="chat-switch-title">{s.title || 'Untitled chat'}</span>
            <span className="chat-switch-path">{shortAgo(s.updated)}</span>
          </button>
        )
      }
  return (
    <div className="chat-switch chat-switch-chats" ref={ref}>
      <button className="icon-btn tiny" title="History of this folder" aria-label="History of this folder" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <History size={13} />
      </button>
      {open && (
        <div className="chat-switch-menu" role="menu">
          {history.length === 0 && <div className="tree-empty">No earlier chats in this folder</div>}
          {HISTORY_GROUPS.map((g) => {
            const items = history.filter((s) => g.of(s, chats) === g.key)
            if (!items.length) return null
            return (
              <div key={g.key} className="chat-switch-section">
                <div className="chat-switch-section-head">
                  {g.label} <span>{items.length}</span>
                </div>
                {items.map((s) => renderItem(s))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** A visible wait: a spinner and what is being read. */
function Loading({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="chat-loading">
      <Loader2 size={14} className="spin" />
      <span>{label}</span>
    </div>
  )
}

/** The file's changes side by side (HEAD on the left, the working copy on the right), beside the panel while its row is hovered. */
function ChatDiff({ repo, file, strip }: { repo: string; file: GitFile; strip: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const [rows, setRows] = useState<DiffRow[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [place, setPlace] = useState(() => (strip.current ? diffPlace(strip.current) : { left: 8, top: 8, width: 420, height: 320 }))
  const tick = useFsNonce()

  useLayoutEffect(() => {
    const update = (): void => {
      if (strip.current) setPlace(diffPlace(strip.current))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [strip, file.abs])

  useEffect(() => {
    let alive = true
    setRows(null)
    setNote(null)
    // hovering across rows passes over files: load only the one that stays under the pointer
    const timer = window.setTimeout(async () => {
      try {
        const before = file.status === '?' ? '' : await window.api.git.show(repo, 'HEAD', file.rel).catch(() => '')
        const cur =
          file.status === 'D'
            ? { content: '', binary: false, tooLarge: false }
            : await window.api.fs.readFile(file.abs).catch(() => ({ content: '', binary: false, tooLarge: false }))
        if (!alive) return
        if (cur.binary) return setNote('Binary file: no preview')
        if (cur.tooLarge) return setNote('File too large to preview')
        // the same file, unchanged since it was last shown: its rows (and colours) are kept
        const hit = diffCache.get(file.abs)
        if (hit && hit.old === before && hit.cur === cur.content) return setRows(hit.rows)
        const r = sideBySide(before, cur.content)
        if (!r) return setNote('Too big to compare side by side')
        setRows(r)
        const { monaco, languageFor } = await import('../monaco')
        const lang = languageFor(file.rel)
        if (lang) {
          attachTokens(r, monaco.editor.tokenize(before, lang) as LineTokens[], monaco.editor.tokenize(cur.content, lang) as LineTokens[])
        }
        rememberDiff(file.abs, { old: before, cur: cur.content, rows: r })
        if (alive) setRows([...r])
      } catch (e) {
        if (alive) setNote(e instanceof Error ? e.message : String(e))
      }
    }, DIFF_HOVER_DELAY)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [repo, file.abs, file.rel, file.status, tick])

  return (
    <div className="chat-diff-pop" style={place} onKeyDown={(e) => e.stopPropagation()}>
      <div className="chat-diff-head" title={file.rel}>
        <span className="chat-diff-name">{file.rel}</span>
        {rows && (
          <span className="chat-diff-count">
            <span className="cd-plus">+{rows.filter((r) => r.right.kind === 'add').length}</span>
            <span className="cd-minus">−{rows.filter((r) => r.left.kind === 'del').length}</span>
          </span>
        )}
      </div>
      <div className="chat-diff">
        <div className="cd-row cd-labels">
          <div className="cd-cell">HEAD</div>
          <div className="cd-cell cd-right">Working copy</div>
        </div>
        {!rows && !note && <Loading label="Loading diff…" />}
        {note && <div className="tree-empty">{note}</div>}
        {rows?.map((r, i) => (
          <div key={i} className="cd-row">
            <DiffCellView cell={r.left} />
            <DiffCellView cell={r.right} side="right" />
          </div>
        ))}
        {rows?.length === 0 && <div className="tree-empty">No changes</div>}
      </div>
    </div>
  )
}

function DiffCellView({ cell, side }: { cell: DiffCell; side?: 'right' }): React.JSX.Element {
  const sign = cell.kind === 'add' ? '+' : cell.kind === 'del' ? '−' : ''
  return (
    <div className={`cd-cell cd-${cell.kind}${side ? ' cd-right' : ''}`}>
      <span className="cd-n">{cell.n ?? ''}</span>
      <span className="cd-sign">{sign}</span>
      <span className="cd-t">
        {cell.tokens ? cell.tokens.map((t, i) => (t.cls ? <span key={i} className={`tk-${t.cls}`}>{t.text}</span> : t.text)) : cell.text}
      </span>
    </div>
  )
}

const ADD_PLACES = [
  { label: 'Split vertical (side by side)', command: 'newLayoutChat' },
  { label: 'Split horizontal (stacked)', command: 'newLayoutBelow' },
  { label: 'New column (right edge of layout)', command: 'newLayoutColumn' },
  { label: 'New row (bottom of layout)', command: 'newLayoutRow' }
]

function AddAgentMenu(): React.JSX.Element {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' })
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!at) return
    const r = menu.current?.getBoundingClientRect()
    if (!r) return
    setPos({
      position: 'fixed',
      top: at.y,
      left: Math.max(4, Math.min(at.x - r.width, window.innerWidth - r.width - 4))
    })
  }, [at])
  useEffect(() => {
    if (!at) return
    const close = (e: MouseEvent): void => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setAt(null)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAt(null)
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', esc, true)
    }
  }, [at])
  return (
    <>
      <button
        ref={btn}
        className="icon-btn accent"
        title="Add an agent: beside, below, or as a new row or column"
        onClick={() => {
          if (at) return setAt(null)
          const r = btn.current!.getBoundingClientRect()
          setPos({ visibility: 'hidden' })
          setAt({ x: r.right, y: r.bottom + 4 })
        }}
      >
        <Plus size={16} />
      </button>
      {at &&
        createPortal(
          <div
            ref={menu}
            className="menu ctx-menu agent-menu"
            style={pos}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="menu-sep">Add an agent</div>
            {ADD_PLACES.map((p) => {
              const cmd = COMMANDS.find((c) => c.id === p.command)
              return (
                <button
                  key={p.command}
                  className="menu-item"
                  onClick={() => {
                    setAt(null)
                    cmd?.run()
                  }}
                >
                  <span className="menu-item-main">{p.label}</span>
                  <span className="menu-item-sub">{cmd?.keys ?? ''}</span>
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}

function ChatTitle({ chat }: { chat: Chat }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const finish = (): void => {
    if (draft !== null && !cancelled.current) renameChat(chat.id, draft)
    cancelled.current = false
    setDraft(null)
  }
  if (draft === null)
    return (
      <span className="chat-titlebar-title" title="Click to rename" onClick={() => setDraft(chat.title)}>
        {chat.title}
      </span>
    )
  return (
    <input
      className="chat-titlebar-input"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish()
        else if (e.key === 'Escape') {
          cancelled.current = true
          finish()
        }
      }}
      onBlur={finish}
    />
  )
}

function NoChat(): React.JSX.Element {
  const agents = useStore((s) => s.agents)
  const claudeFound = useStore((s) => !!s.claude?.found)
  useStore((s) => s.preferredAgent)
  const def = agentDef(defaultAgent())
  const others = AGENTS.filter((a) => a.id !== def.id && (a.id === 'claude' ? claudeFound : agents.some((x) => x.id === a.id && x.found)))
  return (
    <div className="no-chat">
      <div className="glow-orb">
        <Logo size={56} />
      </div>
      <h3>What should we build?</h3>
      <p>Each chat runs its own {def.label} session in this folder. Run several in parallel and hop between them.</p>
      <div className="no-chat-actions">
        <button className="btn btn-primary btn-lg" onClick={() => newChat()}>
          <Sparkles size={16} /> New chat{def.id !== 'claude' ? ` · ${def.label}` : ''}
        </button>
        {claudeFound && (
          <>
            <button className="btn btn-ghost" onClick={() => newChat({ args: ['--continue'], title: 'Continued chat' })}>
              <RotateCcw size={14} /> Continue last
            </button>
            <button className="btn btn-ghost" onClick={() => newChat({ args: ['--resume'], title: 'Resume…' })}>
              <History size={14} /> Resume…
            </button>
          </>
        )}
      </div>
      {others.length > 0 && (
        <div className="no-chat-actions no-chat-agents">
          {others.map((a) => (
            <button key={a.id} className="btn btn-ghost btn-sm" onClick={() => newChatWith(a.id)}>
              <Plus size={13} /> {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function InstallCard(): React.JSX.Element {
  const cmd = 'npm install -g @anthropic-ai/claude-code'
  return (
    <div className="no-chat">
      <div className="glow-orb dim">
        <Logo size={56} />
      </div>
      <h3>Claude Code isn't installed</h3>
      <p>VIBE CODE runs the <code>claude</code> command-line tool. Install it, then sign in once from a terminal.</p>
      <div className="code-line">
        <code>{cmd}</code>
        <button className="icon-btn" title="Copy" onClick={() => navigator.clipboard.writeText(cmd)}>
          <Copy size={14} />
        </button>
      </div>
      <div className="no-chat-actions">
        <button
          className="btn btn-primary"
          onClick={() => {
            newShell()
            setTimeout(() => {
              const id = useStore.getState().activeShellId
              if (id) writeToTerm(id, cmd + '\r')
            }, 900)
          }}
        >
          <SquareTerminal size={15} /> Install in terminal
        </button>
        <button className="btn btn-ghost" onClick={() => detectClaude()}>
          <RefreshCw size={14} /> I've installed it
        </button>
        <button className="btn btn-ghost" onClick={() => window.api.app.openExternal('https://docs.claude.com/en/docs/claude-code/setup')}>
          <ExternalLink size={14} /> Docs
        </button>
      </div>
    </div>
  )
}

/* ================================ Bottom terminal panel ================================ */

export function BottomPanel(): React.JSX.Element {
  const shells = useStore((s) => s.shells)
  const activeId = useStore((s) => s.activeShellId)
  return (
    <div className="bottom-panel">
      <div className="bottom-header">
        <div className="bottom-tabs">
          <span className="bottom-label">Terminal</span>
          <SlidePill />
          {shells.map((sh) => (
            <button
              key={sh.id}
              className={`bottom-tab${sh.id === activeId ? ' active' : ''}${sh.exited ? ' exited' : ''}`}
              onClick={() => useStore.setState({ activeShellId: sh.id })}
            >
              <SquareTerminal size={13} />
              <span>{sh.title}</span>
              <X
                size={12}
                className="bottom-tab-x"
                onClick={(e) => {
                  e.stopPropagation()
                  closeShell(sh.id)
                }}
              />
            </button>
          ))}
        </div>
        <div className="section-actions">
          <button className="icon-btn" title="New terminal" onClick={() => newShell()}>
            <Plus size={15} />
          </button>
          {activeId && (
            <button className="icon-btn" title="Kill terminal" onClick={() => closeShell(activeId)}>
              <Trash2 size={14} />
            </button>
          )}
          <button className="icon-btn" title="Hide panel (Ctrl+`)" onClick={() => useStore.setState({ bottomOpen: false })}>
            <ChevronDown size={15} />
          </button>
        </div>
      </div>
      <div className="term-frame bottom">{activeId && <TerminalView id={activeId} />}</div>
    </div>
  )
}
