import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Collapse } from './motion'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  FolderGit2,
  FolderPlus,
  History,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
  ExternalLink,
  GitCommitHorizontal,
  GitBranch,
  Link2,
  Search
} from 'lucide-react'
import { basename, useStore } from '../store'
import { closeRail } from '../rail'
import { ExplorerNav } from './ExplorerNav'
import { closeChat, loadSessions, openFolder, newChat, newChatIn, openCommitDiff, openDiff, openFile, refreshGit, renameChat } from '../actions'
import { FileIcon, statusLabel } from './icons'
import type { DirEntry, GitBranch as GitBranchInfo, GitCommit, GitCommitFile, GitFile, ProjectGroup } from '../../../shared/types'
import { agentDef } from '../../../shared/agents'
import { NewChatMenu } from './AgentMenu'
import { focusTerm, writeToTerm } from '../terminals'
import { userStore } from '../localPref'

function SectionHeader({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`section-header${title ? '' : ' bare'}`}>
      <span>{title}</span>
      <div className="section-actions">{children}</div>
    </div>
  )
}

/* ================================ Chats ================================ */

function useTick(ms: number): void {
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

const normKey = (p: string): string => p.toLowerCase().replace(/[\\/]+$/, '')

/** The chats of every project, with the folder's own tree beside them in the agent sidebar's Project flyout. */
/** Pick (or make) a folder and start a chat in it. Icon only: the icon says what it does, the title says it in words. */
export function NewProjectButton(): React.JSX.Element {
  const disabled = !useStore((s) => !!s.claude?.found || s.agents.some((a) => a.found))
  return (
    <button
      className="icon-btn new-project"
      disabled={disabled}
      title="New project: pick or make a folder and start a chat in it"
      aria-label="New project"
      onClick={() => openFolder(null, { autoChat: true })}
    >
      <FolderPlus size={15} />
    </button>
  )
}

export function ChatsView(): React.JSX.Element {
  useTick(30000)
  return (
    <div className="scroll">
      <ProjectsTree action={<NewProjectButton />} />
    </div>
  )
}

const EXPANDED_KEY = 'tinjs.expandedProjects'
/** how long the pointer rests on a project row before it opens (passing over a row opens nothing) */
const HOVER_DWELL_MS = 80
/** The one project open in the list (null: none). Older saves kept a list: its first entry is taken. */
function loadExpanded(): string | null {
  try {
    const v: unknown = JSON.parse(userStore.getItem(EXPANDED_KEY) ?? 'null')
    if (typeof v === 'string') return v
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
    return null
  } catch {
    return null
  }
}

// Projects removed from this list. Only the sidebar entry goes; Claude Code's history stays on disk.
const HIDDEN_KEY = 'tinjs.hiddenProjects'
/** Whether the project sidebar has removed this folder from its list (its X button). */
export function isHiddenProject(cwd: string): boolean {
  return loadHidden().has(normKey(cwd))
}

function loadHidden(): Set<string> {
  try {
    return new Set(JSON.parse(userStore.getItem(HIDDEN_KEY) ?? '[]'))
  } catch {
    return new Set()
  }
}

/** Opens a project's row in the project sidebar, as a click on it does (its files show under it). */
export function expandProject(cwd: string): void {
  const key = normKey(cwd)
  try {
    userStore.setItem(EXPANDED_KEY, JSON.stringify(key))
  } catch {
    /* storage unavailable: the event below still opens it */
  }
  window.dispatchEvent(new CustomEvent<string>('project-expand', { detail: key }))
}

/** The files of one project, under its row: only mounted while the project is open (Collapse unmounts closed children). */
function ProjectFiles({ cwd, isRoot }: { cwd: string; isRoot: boolean }): React.JSX.Element {
  // its popups are React children here: keys pressed in them must not reach the project list's arrow keys
  return (
    <div className="proj-files" onKeyDown={(e) => e.stopPropagation()}>
      <ExplorerNav root={cwd} git={isRoot} />
    </div>
  )
}

/** Every project from Claude Code's store (the same list the Claude app shows). A row opens to its files. */
function ProjectsTree({ action }: { action?: React.ReactNode }): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const root = useStore((s) => s.root)
  const chats = useStore((s) => s.chats)
  const [expanded, setExpanded] = useState<string | null>(loadExpanded)
  /** the project a hover is about to open (a short dwell, so passing over a row opens nothing) */
  const hoverTimer = useRef<number | undefined>(undefined)
  const [hidden, setHidden] = useState<Set<string>>(loadHidden)
  const [q, setQ] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** the row the arrow keys are on (marked with data-kbd: React leaves that attribute alone) */
  const kbd = useRef<HTMLElement | null>(null)

  const mark = (el: HTMLElement | null): void => {
    if (kbd.current) delete kbd.current.dataset.kbd
    kbd.current = el
    if (!el) return
    el.dataset.kbd = ''
    el.scrollIntoView({ block: 'nearest' })
  }
  const rows = (): HTMLElement[] => [...(rootRef.current?.querySelectorAll<HTMLElement>('.proj-row') ?? [])]
  const backToChat = (): void => {
    const id = useStore.getState().activeChatId
    if (id) focusTerm(id)
    else (document.activeElement as HTMLElement | null)?.blur()
  }
  const close = (): void => {
    mark(null)
    closeRail('project')
    backToChat()
  }

  // Opened (the Project icon, Ctrl+B, the status-bar count): the cursor goes to the filter, to type or
  // arrow down. The flyout closes with the cursor still in it: the cursor goes back to the chat, not
  // into a box that is gone. (useLayoutEffect: the list is still in the page when its cleanup runs.)
  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [])
  useLayoutEffect(() => {
    const el = rootRef.current
    return () => {
      mark(null)
      window.clearTimeout(hoverTimer.current)
      if (el?.contains(document.activeElement)) backToChat()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** ↑ ↓ move along the projects, → ← open and close one, Enter opens or closes the one under the cursor, Esc clears the filter, then closes. */
  const onKey = (e: React.KeyboardEvent): void => {
    const list = rows()
    const cur = kbd.current && list.includes(kbd.current) ? kbd.current : null
    const i = cur ? list.indexOf(cur) : -1
    const inField = e.target === inputRef.current
    switch (e.key) {
      case 'ArrowDown':
        if (list.length) mark(list[Math.min(i + 1, list.length - 1)])
        break
      case 'ArrowUp':
        if (i <= 0) {
          mark(null)
          inputRef.current?.focus()
        } else mark(list[i - 1])
        break
      case 'ArrowRight':
      case 'ArrowLeft': {
        // in a filter with text, the arrows move the text cursor
        if (!cur || (inField && q)) return
        const open = !!cur.querySelector('.proj-chev.open')
        if (open !== (e.key === 'ArrowRight')) cur.click()
        break
      }
      case 'Enter': {
        // nothing picked yet but a filter typed: the first project it found
        const target = cur ?? (q.trim() ? (list[0] ?? null) : null)
        if (!target) return
        target.click()
        break
      }
      case 'Escape':
        if (q) {
          setQ('')
          mark(null)
        } else close()
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  // the project you're in starts open
  useEffect(() => {
    if (!root) return
    const key = normKey(root)
    setExpanded(key)
  }, [root])

  // a chat's footer asks for its project to be open here (expandProject)
  useEffect(() => {
    const onExpand = (e: Event): void => setExpanded((e as CustomEvent<string>).detail)
    window.addEventListener('project-expand', onExpand)
    return () => window.removeEventListener('project-expand', onExpand)
  }, [])

  useEffect(() => {
    try {
      userStore.setItem(HIDDEN_KEY, JSON.stringify([...hidden]))
    } catch {
      /* storage unavailable */
    }
  }, [hidden])

  useEffect(() => {
    try {
      userStore.setItem(EXPANDED_KEY, JSON.stringify(expanded))
    } catch {
      /* storage unavailable */
    }
  }, [expanded])

  // Open chats the session store doesn't list (yet) still need their project: Codex / Grok / Gemini… chats,
  // and new Claude chats until Claude writes their transcript (only after the first message).
  const slashKey = (p: string): string => normKey(p).replace(/\//g, '\\')
  const known = useMemo(() => new Set(projects.flatMap((g) => g.sessions.map((s) => s.id))), [projects])
  const agentChats = chats.filter((c) => agentDef(c.agent).id !== 'claude' || (!!c.sessionId && !known.has(c.sessionId)))
  const allProjects: ProjectGroup[] = [...projects]
  for (const c of agentChats) {
    if (allProjects.some((g) => slashKey(g.key) === slashKey(c.cwd))) continue
    allProjects.unshift({ key: normKey(c.cwd), cwd: c.cwd, name: basename(c.cwd), updated: c.createdAt, sessions: [] })
  }
  const shownProjects = allProjects.filter((g) => !hidden.has(g.key))
  const needle = q.trim().toLowerCase()
  const visible = needle ? shownProjects.filter((g) => g.name.toLowerCase().includes(needle)) : shownProjects

  return (
    <div className="side-group" ref={rootRef} onKeyDown={onKey}>
      {/* the filter on top, the add button on its right; both stay put while the list scrolls */}
      <div className="tree-filter-row">
        <div className="tree-filter">
          <Search size={12} />
          <input
            ref={inputRef}
            placeholder="Filter projects…  ↑↓ Enter"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              mark(null)
            }}
          />
        </div>
        {action}
      </div>
      <div className="side-group-label">
        Projects
        <span className="sync-pill" title="Read live from ~/.claude/projects — the same store the Claude app uses">
          <Link2 size={10} /> Claude
        </span>
        <button className="icon-btn tiny" title="Refresh" onClick={() => loadSessions()}>
          <RefreshCw size={12} />
        </button>
      </div>

      {visible.length === 0 && <div className="tree-empty">{projects.length ? 'No matching projects' : 'No Claude Code history found yet.'}</div>}

      {visible.map((g) => {
        const open = expanded === g.key
        const isRoot = !!root && normKey(root) === g.key
        const openCount = chats.filter((c) => slashKey(c.cwd) === slashKey(g.key)).length
        return (
          <div key={g.key} className="proj">
            <div
              className={`proj-row${isRoot ? ' current' : ''}`}
              onClick={() => setExpanded((e) => (e === g.key ? null : g.key))}
              onMouseEnter={() => {
                window.clearTimeout(hoverTimer.current)
                hoverTimer.current = window.setTimeout(() => setExpanded(g.key), HOVER_DWELL_MS)
              }}
              onMouseLeave={() => window.clearTimeout(hoverTimer.current)}
              title={g.cwd}
            >
              <span className="proj-name">{g.name}</span>
              <ChevronRight size={13} className={`proj-chev${open ? ' open' : ''}`} />
              {openCount > 0 && <span className="proj-live" title={`${openCount} open`} />}
              <span className="proj-spacer" />
              <button
                className="icon-btn tiny proj-add"
                title="Remove from this list (Claude Code's history is kept)"
                onClick={(e) => {
                  e.stopPropagation()
                  setHidden((h) => new Set(h).add(g.key))
                }}
              >
                <X size={13} />
              </button>
              <NewChatMenu
                className="icon-btn tiny proj-add"
                size={14}
                title={`New chat in ${g.name} — right-click to pick another AI`}
                onPick={(agent) => newChatIn(g.cwd, agent)}
              />
            </div>
            <Collapse open={open}>
              <ProjectFiles cwd={g.cwd} isRoot={isRoot} />
            </Collapse>
          </div>
        )
      })}

      {hidden.size > 0 && !needle && (
        <button className="sess-more" onClick={() => setHidden(new Set())}>
          Show {hidden.size} removed project{hidden.size > 1 ? 's' : ''}
        </button>
      )}
    </div>
  )
}

/** "now", "5m", "3h", "2d", then the date. */
export function shortAgo(t: number): string {
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/* ================================ Explorer ================================ */

export function useGitDecorations(): Map<string, GitFile['status']> {
  // only paths + statuses matter here; +/- counts change on every edit Claude makes, and a new map
  // re-rendered the whole tree each time
  const sig = useStore((s) => s.git.files.map((f) => f.status + f.abs).join('\n'))
  return useMemo(() => {
    const m = new Map<string, GitFile['status']>()
    const files = useStore.getState().git.files
    for (const f of files) {
      const abs = f.abs.replace(/\\/g, '/').toLowerCase()
      m.set(abs, f.status)
      // bubble up to parent folders
      let p = abs
      while (p.includes('/')) {
        p = p.slice(0, p.lastIndexOf('/'))
        if (!m.has(p)) m.set(p, 'M')
      }
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
}

const normDir = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Parent folder of `p`, normalized like normDir. */
const parentOf = (p: string): string => {
  const n = normDir(p)
  return n.slice(0, Math.max(0, n.lastIndexOf('/')))
}

/** Re-renders when a file event touches something directly inside `dir` (not on every change anywhere). */
export function useDirChanges(dir: string): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const key = normDir(dir)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = (e: Event): void => {
      const paths = (e as CustomEvent<string[]>).detail
      if (!paths.some((p) => parentOf(p) === key)) return
      clearTimeout(timer)
      timer = setTimeout(() => setN((x) => x + 1), 100)
    }
    window.addEventListener('fs-changed', onChange)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('fs-changed', onChange)
    }
  }, [dir])
  return n
}

export const sameEntries = (a: DirEntry[] | null, b: DirEntry[]): boolean =>
  !!a && a.length === b.length && a.every((x, i) => x.path === b[i].path && x.isDir === b[i].isDir && x.name === b[i].name)

/* ================================ Changes ================================ */

const statusName: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  U: 'Conflict',
  '?': 'Untracked',
  C: 'Copied'
}

/** Sent to the agent by "Agent commit": commit only, with the same message rules as the Claude panel's commit button. */
const COMMIT_ONLY =
  'Commit all current changes, without pushing. Commit message rules: English, one short subject line only ' +
  '(no body or description), and no Co-Authored-By or any other author/attribution trailer.\r'

/** `embedded`: inside a sidebar group that already has the title (the agent sidebar). */
export function ChangesView({ embedded, focusSearch }: { embedded?: boolean; focusSearch?: boolean }): React.JSX.Element {
  const git = useStore((s) => s.git)
  const root = useStore((s) => s.root)!
  const activeChatId = useStore((s) => s.activeChatId)
  const [q, setQ] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusSearch) searchRef.current?.focus()
  }, [focusSearch])
  const needle = q.trim().toLowerCase()
  // files whose changed lines (added or removed against HEAD) contain the text, found for one needle at a time
  const [contentHits, setContentHits] = useState<{ needle: string; rels: Set<string> } | null>(null)
  useEffect(() => {
    if (!needle) return
    let live = true
    const timer = window.setTimeout(() => {
      Promise.all(
        git.files.map(async (f) => {
          const [before, now] = await Promise.all([
            window.api.git.original(git.root ?? root, f.rel).catch(() => ''),
            f.status === 'D' ? Promise.resolve('') : window.api.fs.readFile(f.abs).then((r) => (r.binary || r.tooLarge ? '' : r.content), () => '')
          ])
          const a = new Set(before.split('\n'))
          const b = new Set(now.split('\n'))
          const changed = [...b.keys()].filter((l) => !a.has(l)).concat([...a.keys()].filter((l) => !b.has(l)))
          return changed.some((l) => l.toLowerCase().includes(needle)) ? f.rel : null
        })
      ).then((rels) => {
        if (live) setContentHits({ needle, rels: new Set(rels.filter((r): r is string => r !== null)) })
      })
    }, 200)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [needle, git.files, git.root, root])
  const contentRels = contentHits?.needle === needle ? contentHits.rels : null
  const files = needle ? git.files.filter((f) => f.rel.toLowerCase().includes(needle) || !!contentRels?.has(f.rel)) : git.files
  const totals = git.files.reduce((a, f) => ({ add: a.add + f.added, del: a.del + f.deleted }), { add: 0, del: 0 })

  if (!git.isRepo) {
    return (
      <>
        {!embedded && <SectionHeader title="Changes" />}
        <div className="empty-state-small">
          <FolderGit2 size={30} strokeWidth={1.4} />
          <h4>Not a Git repository</h4>
          <p>Initialize Git to see exactly what Claude changes, file by file.</p>
          <button
            className="btn btn-primary"
            onClick={async () => {
              await window.api.git.init(root)
              refreshGit()
            }}
          >
            Initialize repository
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <SectionHeader title={embedded ? '' : 'Changes'}>
        <button className="icon-btn" title="Refresh" onClick={() => refreshGit()}>
          <RefreshCw size={14} />
        </button>
      </SectionHeader>
      <div className="changes-summary">
        <BranchPicker root={git.root ?? root} branch={git.branch ?? ''} />
        <div className="changes-counts">
          <span>{git.files.length} files</span>
          <span className="add">+{totals.add}</span>
          <span className="del">−{totals.del}</span>
        </div>
      </div>
      <div className="changes-tools">
        <input
          ref={searchRef}
          className="changes-search"
          type="search"
          placeholder="Filter by name or content"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && q) {
              e.preventDefault()
              e.stopPropagation()
              setQ('')
            }
          }}
        />
        <button
          className="chip"
          disabled={!activeChatId || git.files.length === 0}
          title="Ask the agent in the current chat to commit all changes (no push)"
          onClick={() => {
            if (!activeChatId) return
            writeToTerm(activeChatId, COMMIT_ONLY)
            focusTerm(activeChatId)
          }}
        >
          <GitCommitHorizontal size={12} />
          Agent commit
        </button>
      </div>
      <div className="scroll">
        {git.files.length === 0 && (
          <div className="empty-hint">
            <Sparkles size={18} />
            <p>Working tree clean. Changes Claude makes will show up here instantly.</p>
          </div>
        )}
        {needle && !contentRels && files.length === 0 && <div className="empty-hint"><p>Searching the changes…</p></div>}
        {needle && contentRels && files.length === 0 && <div className="empty-hint"><p>No changed file has “{q.trim()}” in its name or changed lines.</p></div>}
        <ChangeList key={git.root ?? root} files={files} />
        <HistoryList key={git.root ?? root} />
      </div>
    </>
  )
}

/** Rows shown before the next one is loaded when the list end scrolls into view. */
const LIST_PAGE = 40

/** Sits under a list; when it scrolls into view, `onVisible` runs (a new one is mounted per page, so it re-checks). */
function LoadMore({ onVisible }: { onVisible: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onVisible()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [onVisible])
  return <div ref={ref} style={{ height: 1 }} />
}

/** Changed files, a page at a time. */
function ChangeList({ files }: { files: GitFile[] }): React.JSX.Element {
  const [limit, setLimit] = useState(LIST_PAGE)
  const more = useCallback(() => setLimit((n) => n + LIST_PAGE), [])
  return (
    <>
      {files.slice(0, limit).map((f) => (
        <ChangeRow key={f.rel} f={f} />
      ))}
      {files.length > limit && <LoadMore key={limit} onVisible={more} />}
    </>
  )
}

const ChangeRow = memo(function ChangeRow({ f }: { f: GitFile }): React.JSX.Element {
  // a boolean: re-renders only when this file starts / stops being the open diff
  const active = useStore((s) => s.activeTabId === 'd:' + f.abs.toLowerCase())
  const name = f.rel.split('/').pop()!
  const dir = f.rel.slice(0, -name.length - 1)
  const st = f.status === '?' ? 'U' : f.status
  return (
    <div className={`change-row${active ? ' active' : ''}`} onClick={() => openDiff(f.abs, f.rel)} title={`${statusName[f.status]} — ${f.rel}`}>
      <FileIcon name={name} />
      <span className={`change-name${f.status === 'D' ? ' deleted' : ''}`}>{name}</span>
      <span className="change-dir">{dir}</span>
      <span className="change-stats">
        {f.added > 0 && <span className="add">+{f.added}</span>}
        {f.deleted > 0 && <span className="del">−{f.deleted}</span>}
      </span>
      {f.status !== 'D' && (
        <button
          className="icon-btn change-open"
          title="Open file"
          onClick={(e) => {
            e.stopPropagation()
            openFile(f.abs)
          }}
        >
          <ExternalLink size={13} />
        </button>
      )}
      <span className={`change-badge git-${st}`}>{st}</span>
    </div>
  )
})

/** The current branch; click to switch to another one (remote-only branches get a local copy). */
function BranchPicker({ root, branch }: { root: string; branch: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<GitBranchInfo[] | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    setQ('')
    setError('')
    setList(null)
    let live = true
    window.api.git
      .branches(root)
      .then((b) => live && setList(b))
      .catch((e) => live && setError(String(e)))
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      live = false
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open, root])

  const needle = q.trim().toLowerCase()
  const shown = (list ?? []).filter((b) => b.name.toLowerCase().includes(needle))
  const pick = async (b: GitBranchInfo): Promise<void> => {
    if (busy) return
    if (b.current) return setOpen(false)
    setBusy(b.name)
    setError('')
    try {
      await window.api.git.checkout(root, b.name, b.remote)
      setOpen(false)
      refreshGit()
    } catch (e) {
      // e.g. uncommitted changes that the other branch would overwrite: git's own words
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="branch-picker" ref={ref}>
      <button className={`changes-branch${open ? ' open' : ''}`} title="Switch branch" onClick={() => setOpen(!open)}>
        <GitBranch size={13} />
        <span className="branch-name">{branch}</span>
        <ChevronDown size={12} className="branch-caret" />
      </button>
      {open && (
        <div className="branch-menu" role="menu">
          <input
            className="branch-filter"
            autoFocus
            placeholder="Find a branch…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && shown[0] && void pick(shown[0])}
          />
          <div className="branch-list">
            {!list && !error && (
              <div className="branch-note">
                <Loader2 size={12} className="spin" /> Loading…
              </div>
            )}
            {list && !shown.length && <div className="branch-note">No branch matches.</div>}
            {shown.map((b) => (
              <button
                key={(b.remote ? 'r:' : 'l:') + b.name}
                role="menuitemradio"
                aria-checked={b.current}
                className={`branch-item${b.current ? ' on' : ''}`}
                disabled={!!busy}
                title={b.remote ? `Check out ${b.name} as a local branch` : `Switch to ${b.name}`}
                onClick={() => void pick(b)}
              >
                {busy === b.name ? <Loader2 size={13} className="spin" /> : <Check size={13} className="branch-check" />}
                <span className="branch-item-name">{b.name}</span>
                {b.remote && <span className="branch-hint">remote</span>}
              </button>
            ))}
          </div>
          {error && <div className="branch-error">{error}</div>}
        </div>
      )}
    </div>
  )
}

/* ================================ History ================================ */

/** Commits on the current branch, newest first; click one to see the files it touched. */
function HistoryList(): React.JSX.Element | null {
  const gitRoot = useStore((s) => s.git.root)
  const branch = useStore((s) => s.git.branch)
  const [commits, setCommits] = useState<GitCommit[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  // a commit / pull / checkout moves HEAD or a ref even when the working tree status stays the same
  const [refs, setRefs] = useState(0)
  const [shown, setShown] = useState(LIST_PAGE)
  const more = useCallback(() => setShown((n) => n + LIST_PAGE), [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => setRefs((n) => n + 1), 300)
    }
    window.addEventListener('git-changed', onChange)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('git-changed', onChange)
    }
  }, [])

  // refetch when HEAD / a ref moves (new commits, checkout, pull…), not on every working-tree change
  useEffect(() => {
    if (!gitRoot) return
    let live = true
    window.api.git.log(gitRoot).then((c) => live && setCommits(c))
    return () => {
      live = false
    }
  }, [gitRoot, branch, refs])

  if (!gitRoot || !commits) return null
  return (
    <>
      <SectionHeader title={`History${commits.length ? ` · ${commits.length}` : ''}`} />
      {commits.length === 0 && <div className="history-empty">No commits yet.</div>}
      {commits.slice(0, shown).map((c) => (
        <CommitRow key={c.hash} commit={c} gitRoot={gitRoot} open={open === c.hash} toggle={() => setOpen((o) => (o === c.hash ? null : c.hash))} />
      ))}
      {commits.length > shown && <LoadMore key={shown} onVisible={more} />}
    </>
  )
}

function CommitRow({ commit, gitRoot, open, toggle }: { commit: GitCommit; gitRoot: string; open: boolean; toggle: () => void }): React.JSX.Element {
  const [files, setFiles] = useState<GitCommitFile[] | null>(null)
  const activeTabId = useStore((s) => s.activeTabId)
  useEffect(() => {
    if (!open || files) return
    let live = true
    window.api.git.commitFiles(gitRoot, commit.hash).then((f) => live && setFiles(f))
    return () => {
      live = false
    }
  }, [open, files, gitRoot, commit.hash])

  return (
    <>
      <div
        className={`commit-row${open ? ' open' : ''}`}
        onClick={toggle}
        title={`${commit.subject}\n${commit.short} · ${commit.author} · ${new Date(commit.date).toLocaleString()}`}
      >
        <ChevronRight size={12} className={`chev${open ? ' open' : ''}`} />
        <GitCommitHorizontal size={13} className="commit-icon" />
        <div className="commit-text">
          <span className="commit-subject">{commit.subject}</span>
          <span className="commit-meta">
            <span className="commit-hash">{commit.short}</span> · {commit.author} · {shortAgo(commit.date)}
          </span>
        </div>
      </div>
      {open && !files && <div className="tree-loading" />}
      {open && files?.length === 0 && <div className="history-empty">No file changes.</div>}
      {open &&
        files?.map((f) => {
          const name = f.rel.split('/').pop()!
          const dir = f.rel.slice(0, -name.length - 1)
          const active = activeTabId === `c:${commit.hash}:${f.rel}`
          return (
            <div
              key={f.rel}
              className={`change-row commit-file${active ? ' active' : ''}`}
              onClick={() => openCommitDiff(gitRoot, commit, f.rel)}
              title={`${statusName[f.status]} — ${f.rel}`}
            >
              <FileIcon name={name} />
              <span className={`change-name${f.status === 'D' ? ' deleted' : ''}`}>{name}</span>
              <span className="change-dir">{dir}</span>
              <span className="change-stats">
                {f.added > 0 && <span className="add">+{f.added}</span>}
                {f.deleted > 0 && <span className="del">−{f.deleted}</span>}
              </span>
              <span className={`change-badge git-${f.status}`}>{f.status}</span>
            </div>
          )
        })}
    </>
  )
}
