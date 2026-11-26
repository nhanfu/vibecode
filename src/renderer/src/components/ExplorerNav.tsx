import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import { basename, useStore } from '../store'
import { closeTab, openFileInOverlay, openInlineFile } from '../actions'
import { hasUnsaved } from '../fileModelsLite'
import { FileIcon, FolderIcon } from './icons'
import { sameEntries, useDirChanges, useGitDecorations } from './Sidebar'
import { InlineFile } from './Review'
import { releaseExplorer, setExplorerLive } from '../explorerFocus'
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
/** ms the pointer must stay on empty space before the popups it opened close */
const BLANK_DELAY = 400

/**
 * Left edge of each popup (cols[1:]), or null when a file has no free place. Popups go left to right while
 * they fit. Once the right side is full, each new popup slides left of its parent (cols[k] → popup k-1)
 * until the left edge is full too; then a folder opens over the popup two levels back, and a file has no
 * place (null). Nothing is ever covered except by this sliding.
 */
function popupLefts(cols: Col[], box: { left: number; right: number }, innerWidth: number): number[] | null {
  const limit = innerWidth - 8
  const lefts: number[] = []
  let natural = box.right + GAP
  let fits = true
  for (let k = 0; k < cols.length - 1; k++) {
    const c = cols[k + 1]
    const w = c.kind === 'file' ? FILE_W : POP_W
    if (fits && natural + w <= limit) {
      lefts.push(natural)
      natural += w + GAP
      continue
    }
    fits = false
    const parent = k > 0 ? lefts[k - 1] : box.left
    const slid = parent - GAP - w
    if (slid >= 8) {
      lefts.push(slid)
      continue
    }
    if (c.kind === 'file') return null
    lefts.push(k >= 2 ? lefts[k - 2] : box.right + GAP)
  }
  return lefts
}
const GAP = 6
const PAGE = 300
const NO_DECO = new Map<string, string>()

/**
 * Files of a project, navigated like lf: the project's folder is listed, and a folder or file opened
 * (hover or click on a folder; click, Enter or → on a file) shows in a popup beside it instead of
 * expanding inline. Moving the cursor closes folder popups past it; a file's popup stays until it is
 * closed (×, Esc, ←) or another folder is clicked. `git`: false for a project that is not the open
 * root (its folders get no Changes marks).
 */
export function ExplorerNav({ root, git = true }: { root: string; git?: boolean }): React.JSX.Element {
  const [cols, setCols] = useState<Col[]>([{ kind: 'dir', dir: root, cursor: null }])
  const [active, setActive] = useState(0)
  const [box, setBox] = useState({ top: 0, left: 0, right: 0 })
  const boxRef = useRef<HTMLDivElement>(null)
  const colEls = useRef<(HTMLDivElement | null)[]>([])
  const rootDeco = useGitDecorations()
  const deco = git ? rootDeco : NO_DECO
  const inline = useStore((s) => s.inlineTab)
  // a popup closed by its own × or by a quick open can leave the active index past the end
  const act = Math.min(active, cols.length - 1)
  // each folder's column (and popup) has its own name filter, kept while the folder stays open
  const [filters, setFilters] = useState<Record<string, string>>({})
  const setFilter = (dir: string, text: string): void => setFilters((f) => ({ ...f, [dir]: text }))

  // Ctrl+F inside a Files list focuses the filter of the column that has the focus
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return
      // only the list (or popup) that has the focus; other lists on screen leave it alone
      const col = colEls.current.find((el) => el?.contains(document.activeElement))
      const input = col?.querySelector<HTMLInputElement>('input.explorer-filter')
      if (!input) return
      e.preventDefault()
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

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
      return [...head, keep]
    })
    if (focus) {
      // the popup is fixed beside the list: bring the list into view first, or the popup opens off-screen
      colEls.current[i]?.scrollIntoView({ block: 'nearest' })
      setActive(i + 1)
      focusLater(i + 1)
    }
  }

  /** A file popup with unsaved edits holds its place: a hover does not replace it. */
  const held = (c: Col | undefined): boolean => {
    if (c?.kind !== 'file') return false
    const tab = useStore.getState().tabs.find((t) => t.id === c.tabId)
    return !!tab && tab.kind === 'file' && hasUnsaved(tab.path)
  }

  /** Hover on a folder row: its popup opens, unless it is already open or a file with unsaved edits holds that place. */
  const hoverOpen = (i: number, e: DirEntry): void => {
    const next = latest.current.cols[i + 1]
    if (next?.kind === 'dir' && next.dir === e.path) return
    if (held(next)) return
    openChild(i, e, false)
  }

  /** Hover on a file row: its preview opens beside the list (a click on it keeps it open). */
  const hoverPreview = (i: number, e: DirEntry): void => {
    const next = latest.current.cols[i + 1]
    if (next?.kind === 'file' && next.tabId === 'f:' + e.path.toLowerCase()) return
    if (held(next)) return
    openFileRow(i, e, true)
  }

  /**
   * A file from column i, in a popup beside it: its tab is shown there, not in the overlay. When no free
   * place is left for it, a click opens the file in the editor instead; a hover preview does nothing.
   */
  const openFileRow = (i: number, e: DirEntry, preview = false): void => {
    const candidate: Col[] = [...latest.current.cols.slice(0, i + 1), { kind: 'file', dir: latest.current.cols[i].dir, tabId: 'f:' + e.path.toLowerCase() }]
    if (popupLefts(candidate, box, window.innerWidth) === null) {
      // no room for the file beside the list: a click opens it in the editor, a hover shows nothing
      if (!preview) openFileInOverlay(e.path)
      return
    }
    const tabId = openInlineFile(e.path, preview)
    if (!tabId) return
    setCols((cs) => [
      ...cs.slice(0, i + 1).map((c, k) => (k === i && c.kind === 'dir' ? { ...c, cursor: e } : c)),
      { kind: 'file', dir: cs[i].dir, tabId }
    ])
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

  // the window got smaller and the file popup has no free place any more: it closes, its file stays in the editor
  useEffect(() => {
    const k = cols.findIndex((c) => c.kind === 'file')
    if (k > 0 && popupLefts(cols, box, window.innerWidth) === null) setCols((cs) => cs.slice(0, k))
  }, [box, cols])

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
      releaseExplorer(live)
      // the list is gone (a project folded, a new root): its own file goes with it
      const id = useStore.getState().inlineTab
      if (id && latest.current.cols.some((c) => c.kind === 'file' && c.tabId === id)) void closeTab(id)
    }
  }, [])

  // the box the popups line up with: the top and right edge of this list, kept current while anything scrolls
  useLayoutEffect(() => {
    const measure = (): void => {
      const r = boxRef.current?.getBoundingClientRect()
      if (!r) return
      setBox((b) => (b.top === r.top && b.left === r.left && b.right === r.right ? b : { top: r.top, left: r.left, right: r.right }))
    }
    measure()
    window.addEventListener('resize', measure)
    document.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      document.removeEventListener('scroll', measure, true)
    }
  })

  // every popup runs from its top edge to the bottom of the window, so a row always has a popup beside it
  // to move into; a list scrolled low still leaves them a usable height
  const popTop = Math.max(8, Math.min(box.top, window.innerHeight - 360))
  const widths = cols.slice(1).map((c) => (c.kind === 'file' ? FILE_W : POP_W))
  const lefts = popupLefts(cols, box, window.innerWidth) ?? widths.map(() => box.right + GAP)
  const maxHeight = window.innerHeight - popTop - 8

  // closes the popups opened from column i (and their preview)
  const closeAfter = (i: number): void => {
    if (latest.current.cols.length <= i + 1) return
    setCols((cs) => cs.slice(0, i + 1))
    if (latest.current.active > i) setActive(i)
  }

  /*
   * The pointer on empty space of column i starts a timer that closes what it opened. Crossing from a
   * parent toward its popup passes over empty space for a moment, so the timer only fires when the pointer
   * stays there. A row or another popup under the pointer cancels it.
   */
  const blankTimer = useRef<{ i: number; t: number } | null>(null)
  const cancelBlank = (): void => {
    if (blankTimer.current) window.clearTimeout(blankTimer.current.t)
    blankTimer.current = null
  }
  const pointerOn = (i: number, blank: boolean): void => {
    if (!blank || latest.current.cols.length <= i + 1) return cancelBlank()
    if (blankTimer.current?.i === i) return
    cancelBlank()
    const t = window.setTimeout(() => {
      blankTimer.current = null
      closeAfter(i)
    }, BLANK_DELAY)
    blankTimer.current = { i, t }
  }
  useEffect(() => cancelBlank, [])

  const colProps = (i: number): ColProps => {
    const c = cols[i]
    return {
      onPointer: (blank: boolean) => pointerOn(i, blank),
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
      onPreview: (e) => hoverPreview(i, e),
      onBack: () => back(i),
      filter: filters[c.dir] ?? '',
      onFilter: (text) => setFilter(c.dir, text)
    }
  }

  return (
    <div className="explorer-nav" ref={boxRef}>
      <ExplorerCol {...colProps(0)} root />
      {cols.slice(1).map((c, k) => (
        <Fragment key={`${k + 1}:${c.kind === 'file' ? c.tabId : c.dir}`}>
          {createPortal(
            <div
              className={`explorer-nav explorer-pop${c.kind === 'file' ? ' explorer-file' : ''}`}
              style={{
                left: lefts[k],
                zIndex: 102 + k,
                top: popTop,
                width: widths[k],
                height: maxHeight
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
  onPreview: (e: DirEntry) => void
  onBack: () => void
  /** the pointer is over this column: true on its empty space, false on a row or the filter */
  onPointer: (blank: boolean) => void
  /** this folder's name filter, and how it changes */
  filter: string
  onFilter: (text: string) => void
  root?: boolean
}

function ExplorerCol(p: ColProps): React.JSX.Element {
  const { dir, cursor, openDir, deco, onCursor, onOpen, onFile, onHover, onPreview, onBack, onPointer, filter, onFilter, root } = p
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

  const needle = filter.trim().toLowerCase()
  const visible = items && needle ? items.filter((e) => e.name.toLowerCase().includes(needle)) : items
  // the first row is the cursor until the user moves it
  const cur = visible?.find((e) => e.path === cursor?.path) ?? visible?.[0] ?? null
  useEffect(() => {
    if (cur && cur.path !== cursor?.path) onCursor(cur, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.path, cursor?.path])

  useEffect(() => {
    list.current?.querySelector('.tree-row.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cur?.path])

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const n = visible?.length ?? 0
    const i = visible && cur ? visible.findIndex((x) => x.path === cur.path) : -1
    const pick = (k: number): void => {
      if (visible && n) onCursor(visible[Math.max(0, Math.min(n - 1, k))], false)
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

  const shown = visible?.slice(0, limit) ?? []
  return (
    <div
      className={`explorer-col${root ? ' root' : ''}`}
      tabIndex={0}
      ref={p.colRef}
      onFocus={p.onFocus}
      onKeyDown={onKey}
      onMouseMove={(e) => {
        onPointer(!(e.target as HTMLElement).closest('.tree-row, .explorer-filter-row'))
      }}
    >
      {!root && (
        <div className="explorer-col-head" title={dir}>
          {basename(dir)}
        </div>
      )}
      <div className="explorer-filter-row">
      <input
        className="explorer-filter"
        type="search"
        placeholder="Filter (Ctrl+F)"
        title={`Shows only the entries of ${basename(dir)} whose name matches`}
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && filter) {
            e.preventDefault()
            e.stopPropagation()
            onFilter('')
            return
          }
          e.stopPropagation()
          if (e.key === 'ArrowDown' || e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.closest<HTMLElement>('.explorer-col')?.focus()
          }
        }}
      />
      </div>
      <div className="explorer-list" ref={list}>
        {items === null && <div className="tree-loading" />}
        {items?.length === 0 && <div className="tree-empty">Empty folder</div>}
        {!!items?.length && visible?.length === 0 && <div className="tree-empty">No match</div>}
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
              onMouseEnter={it.isDir ? () => onHover(it) : () => onPreview(it)}
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
        {visible && visible.length > limit && (
          <button className="explorer-more" onClick={() => setLimit((n) => n + PAGE)}>
            {visible.length - limit} more
          </button>
        )}
      </div>
    </div>
  )
}
