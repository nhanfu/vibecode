import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, ChevronsDownUp, RefreshCw } from 'lucide-react'
import { basename, useStore } from '../store'
import { closeTab, openInlineFile } from '../actions'
import { FileIcon, FolderIcon } from './icons'
import { sameEntries, useDirChanges, useGitDecorations } from './Sidebar'
import { InlineFile } from './Review'
import { setExplorerLive } from '../explorerFocus'
import type { DirEntry } from '../../../shared/types'

/**
 * One column on screen: the root folder in the agent sidebar, then one popup beside it per folder
 * or file opened from the column before.
 */
type Col =
  | { kind: 'dir'; dir: string; cursor: DirEntry | null }
  /** a file shown in the popup beside its folder (`dir`): the editor, by the tab it owns */
  | { kind: 'file'; dir: string; tabId: string }

const POP_W = 240
const FILE_W = 560
const GAP = 6
const PAGE = 300
/** popups beside the list at once, folders and a file together; one more closes the oldest */
const MAX_POPUPS = 2

const capPopups = (next: Col[]): Col[] => (next.length - 1 > MAX_POPUPS ? [next[0], ...next.slice(-MAX_POPUPS)] : next)

/**
 * Files in the agent sidebar, navigated like lf: the project's folder is listed in the sidebar, and
 * a folder or file opened (hover or click on a folder; click, Enter or → on a file) shows in a popup
 * beside it instead of expanding inline. Moving the cursor closes folder popups past it; a file's
 * popup stays until it is closed (×, Esc, ←) or another folder is clicked.
 */
export function ExplorerNav({ root }: { root: string }): React.JSX.Element {
  const [cols, setCols] = useState<Col[]>([{ kind: 'dir', dir: root, cursor: null }])
  const [active, setActive] = useState(0)
  const [box, setBox] = useState({ top: 0, right: 0 })
  const boxRef = useRef<HTMLDivElement>(null)
  const colEls = useRef<(HTMLDivElement | null)[]>([])
  const deco = useGitDecorations()
  const inline = useStore((s) => s.inlineTab)
  // a popup closed by its own × or by a quick open can leave the active index past the end
  const act = Math.min(active, cols.length - 1)

  const focusLater = (i: number): void => {
    requestAnimationFrame(() => colEls.current[i]?.focus())
  }

  /** Moves the cursor in column i. Folder popups past it close; a file popup right after it stays. */
  const setCursor = (i: number, e: DirEntry, keepPopups: boolean): void => {
    setCols((cs) => {
      const head = cs.map((c, k) => (k === i && c.kind === 'dir' ? { ...c, cursor: e } : c))
      if (keepPopups) return head
      return head.slice(0, head[i + 1]?.kind === 'file' ? i + 2 : i + 1)
    })
  }

  /** Opens a folder from column i in a popup beside it. A hover (focus false) never replaces a file popup. */
  const openChild = (i: number, e: DirEntry, focus: boolean): void => {
    setCols((cs) => {
      const head = cs.slice(0, i + 1).map((c, k) => (k === i && c.kind === 'dir' ? { ...c, cursor: e } : c))
      const old = cs[i + 1]
      const keep: Col = old?.kind === 'dir' && old.dir === e.path ? old : { kind: 'dir', dir: e.path, cursor: null }
      return capPopups([...head, keep])
    })
    if (focus) {
      // the popup is fixed beside the list: bring the list into view first, or the popup opens off-screen
      colEls.current[i]?.scrollIntoView({ block: 'nearest' })
      setActive(i + 1)
      focusLater(i + 1)
    }
  }

  /** Hover on a folder row: its popup opens, unless it is already open or a file popup holds that place. */
  const hoverOpen = (i: number, e: DirEntry): void => {
    const next = latest.current.cols[i + 1]
    if (next?.kind === 'file' || (next?.kind === 'dir' && next.dir === e.path)) return
    openChild(i, e, false)
  }

  /** A file from column i, in a popup beside it: its tab is shown there, not in the overlay. */
  const openFileRow = (i: number, e: DirEntry): void => {
    const tabId = openInlineFile(e.path)
    if (!tabId) return
    setCols((cs) =>
      capPopups([
        ...cs.slice(0, i + 1).map((c, k) => (k === i && c.kind === 'dir' ? { ...c, cursor: e } : c)),
        { kind: 'file', dir: cs[i].dir, tabId }
      ])
    )
  }

  /** Closes column i (a popup) and goes back to the column that opened it. */
  const back = (i: number): void => {
    if (i === 0) return
    setCols((cs) => cs.slice(0, i))
    setActive(i - 1)
    focusLater(i - 1)
  }

  // read by the Ctrl+E hook and by hover, which can fire at any time
  const latest = useRef({ cols, active: act, openChild, focus: focusLater })
  latest.current = { cols, active: act, openChild, focus: focusLater }

  // a file popup whose tab was closed elsewhere (its own ×, a quick open) goes too
  useEffect(() => {
    const k = cols.findIndex((c) => c.kind === 'file')
    if (k > 0 && cols[k].kind === 'file' && cols[k].tabId !== inline) setCols((cs) => cs.slice(0, k))
  }, [inline, cols])

  // a file popup that goes away (back, Esc, a folder clicked) closes its file too
  const shownFiles = useRef<string[]>([])
  useEffect(() => {
    const now = cols.flatMap((c) => (c.kind === 'file' ? [c.tabId] : []))
    for (const id of shownFiles.current) {
      if (!now.includes(id) && useStore.getState().tabs.some((t) => t.id === id)) void closeTab(id)
    }
    shownFiles.current = now
  }, [cols])

  useEffect(() => {
    const live = {
      openCursor: (): void => {
        const c = latest.current.cols[latest.current.active]
        if (c?.kind === 'dir' && c.cursor?.isDir) latest.current.openChild(latest.current.active, c.cursor, true)
      },
      focus: (): void => latest.current.focus(latest.current.active)
    }
    setExplorerLive(live)
    return () => {
      setExplorerLive(null)
      // the list is gone (another group, a new root): its file goes with it
      const id = useStore.getState().inlineTab
      if (id) void closeTab(id)
    }
  }, [])

  // the box the popups line up with: the top and right edge of this list, kept current while anything scrolls
  useLayoutEffect(() => {
    const measure = (): void => {
      const r = boxRef.current?.getBoundingClientRect()
      if (!r) return
      setBox((b) => (b.top === r.top && b.right === r.right ? b : { top: r.top, right: r.right }))
    }
    measure()
    window.addEventListener('resize', measure)
    document.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      document.removeEventListener('scroll', measure, true)
    }
  })

  // a popup stays on screen even when the list it opens from has scrolled past the window's edge
  const popTop = Math.max(8, Math.min(box.top, window.innerHeight - 200))
  const widths = cols.slice(1).map((c) => (c.kind === 'file' ? FILE_W : POP_W))
  const lefts = widths.map((_, k) => box.right + GAP + widths.slice(0, k).reduce((sum, w) => sum + w + GAP, 0))
  const maxHeight = window.innerHeight - popTop - 8

  const colProps = (i: number): ColProps => {
    const c = cols[i]
    return {
      dir: c.dir,
      cursor: c.kind === 'dir' ? c.cursor : null,
      openDir: cols[i + 1]?.kind === 'dir' ? cols[i + 1].dir : null,
      deco,
      colRef: (el) => {
        colEls.current[i] = el
      },
      onFocus: () => setActive(i),
      onCursor: (e, keep) => setCursor(i, e, keep),
      onOpen: (e, focus) => openChild(i, e, focus),
      onFile: (e) => openFileRow(i, e),
      onHover: (e) => hoverOpen(i, e),
      onBack: () => back(i)
    }
  }

  return (
    <div className="explorer-nav" ref={boxRef}>
      <div className="section-header bare">
        <div className="section-actions">
          <button className="icon-btn" title="Refresh" onClick={() => useStore.setState((s) => ({ fsTick: s.fsTick + 1 }))}>
            <RefreshCw size={14} />
          </button>
          <button className="icon-btn" title="Close the popups" onClick={() => setCols((cs) => cs.slice(0, 1))}>
            <ChevronsDownUp size={14} />
          </button>
        </div>
      </div>
      <ExplorerCol {...colProps(0)} root />
      {cols.slice(1).map((c, k) => (
        <Fragment key={`${k + 1}:${c.kind === 'file' ? c.tabId : c.dir}`}>
          {createPortal(
            <div
              className={`explorer-nav explorer-pop${c.kind === 'file' ? ' explorer-file' : ''}`}
              style={{
                left: lefts[k],
                top: popTop,
                width: widths[k],
                maxHeight,
                ...(c.kind === 'file' ? { height: maxHeight } : {})
              }}
            >
              {c.kind === 'file' ? <InlineFile tabId={c.tabId} /> : <ExplorerCol {...colProps(k + 1)} />}
            </div>,
            document.body
          )}
        </Fragment>
      ))}
    </div>
  )
}

interface ColProps {
  dir: string
  cursor: DirEntry | null
  /** the folder that has a popup open from this column */
  openDir: string | null
  deco: Map<string, string>
  colRef: (el: HTMLDivElement | null) => void
  onFocus: () => void
  onCursor: (e: DirEntry, keepPopups: boolean) => void
  /** a folder opened: from a click or a key (focus) or from a hover (no focus) */
  onOpen: (e: DirEntry, focus: boolean) => void
  onFile: (e: DirEntry) => void
  onHover: (e: DirEntry) => void
  onBack: () => void
  root?: boolean
}

function ExplorerCol(p: ColProps): React.JSX.Element {
  const { dir, cursor, openDir, deco, onCursor, onOpen, onFile, onHover, onBack, root } = p
  const [items, setItems] = useState<DirEntry[] | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const list = useRef<HTMLDivElement>(null)
  // the Refresh button bumps fsTick; file events only reach the folder they touch
  const tick = useStore((s) => s.fsTick)
  const changed = useDirChanges(dir)

  useEffect(() => {
    let alive = true
    window.api.fs
      .readDir(dir)
      .then((r) => alive && setItems((prev) => (sameEntries(prev, r) ? prev : r)))
      .catch(() => alive && setItems([]))
    return () => {
      alive = false
    }
  }, [dir, tick, changed])

  // the first row is the cursor until the user moves it
  const cur = items?.find((e) => e.path === cursor?.path) ?? items?.[0] ?? null
  useEffect(() => {
    if (cur && cur.path !== cursor?.path) onCursor(cur, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.path, cursor?.path])

  useEffect(() => {
    list.current?.querySelector('.tree-row.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cur?.path])

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const n = items?.length ?? 0
    const i = items && cur ? items.findIndex((x) => x.path === cur.path) : -1
    const pick = (k: number): void => {
      if (items && n) onCursor(items[Math.max(0, Math.min(n - 1, k))], false)
    }
    let used = true
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        pick(i + 1)
        break
      case 'ArrowUp':
      case 'k':
        pick(i - 1)
        break
      case 'Home':
      case 'g':
        pick(0)
        break
      case 'End':
      case 'G':
        pick(n - 1)
        break
      case 'ArrowRight':
      case 'l':
      case 'Enter':
        if (!cur) break
        if (cur.isDir) onOpen(cur, true)
        else onFile(cur)
        break
      case 'ArrowLeft':
      case 'h':
      case 'Backspace':
      case 'Escape':
        onBack()
        break
      default:
        used = false
    }
    if (used) e.preventDefault()
  }

  const shown = items?.slice(0, limit) ?? []
  return (
    <div className={`explorer-col${root ? ' root' : ''}`} tabIndex={0} ref={p.colRef} onFocus={p.onFocus} onKeyDown={onKey}>
      <div className="explorer-col-head" title={dir}>
        {basename(dir)}
      </div>
      <div className="explorer-list" ref={list}>
        {items === null && <div className="tree-loading" />}
        {items?.length === 0 && <div className="tree-empty">Empty folder</div>}
        {shown.map((it) => {
          const isCur = cur?.path === it.path
          const open = it.isDir && openDir === it.path
          const status = deco.get(it.path.replace(/\\/g, '/').toLowerCase())
          return (
            <div
              key={it.path}
              className={`tree-row${isCur ? ' cursor' : ''}${open ? ' open' : ''}${status ? ` git-${status === '?' ? 'U' : status}` : ''}`}
              style={{ paddingLeft: 10 }}
              title={it.path}
              onMouseEnter={it.isDir ? () => onHover(it) : undefined}
              onClick={() => (it.isDir ? onOpen(it, true) : (onCursor(it, true), onFile(it)))}
            >
              {it.isDir ? <ChevronRight size={13} className={`chev${open ? ' open' : ''}`} /> : <span className="chev-spacer" />}
              {it.isDir ? <FolderIcon open={open} /> : <FileIcon name={it.name} />}
              <span className="tree-name">{it.name}</span>
              {status && !it.isDir && <span className="tree-status">{status === '?' ? 'U' : status}</span>}
              {status && it.isDir && <span className="tree-dot" />}
            </div>
          )
        })}
        {items && items.length > limit && (
          <button className="explorer-more" onClick={() => setLimit((n) => n + PAGE)}>
            {items.length - limit} more
          </button>
        )}
      </div>
    </div>
  )
}
