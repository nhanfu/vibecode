import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, ChevronsDownUp, RefreshCw } from 'lucide-react'
import { basename, useStore } from '../store'
import { openFile } from '../actions'
import { FileIcon, FolderIcon } from './icons'
import { sameEntries, useDirChanges, useGitDecorations } from './Sidebar'
import { setExplorerLive } from '../explorerFocus'
import type { DirEntry } from '../../../shared/types'

/** One folder on screen: the root in the agent sidebar, then one popup beside it per folder opened. */
interface Col {
  dir: string
  /** the row the cursor is on; the popup after this column is the folder under it, if one is open */
  cursor: DirEntry | null
}

const POP_W = 240
const GAP = 6
const PAGE = 300

/**
 * Files in the agent sidebar, navigated like lf: the project's folder is listed in the sidebar, and
 * a folder opened (click, Enter, →, l) shows its contents in a popup beside it instead of expanding
 * inline. Moving the cursor on a row closes the popups past it; ← / h / Backspace / Esc closes the
 * popup you are in and goes back to the one that opened it.
 */
export function ExplorerNav({ root }: { root: string }): React.JSX.Element {
  const [cols, setCols] = useState<Col[]>([{ dir: root, cursor: null }])
  const [active, setActive] = useState(0)
  const [box, setBox] = useState({ top: 0, right: 0 })
  const boxRef = useRef<HTMLDivElement>(null)
  const colEls = useRef<(HTMLDivElement | null)[]>([])
  const deco = useGitDecorations()

  const focusLater = (i: number): void => {
    requestAnimationFrame(() => colEls.current[i]?.focus())
  }

  /** Moves the cursor in column i. Without `keepPopups` the popups past it close: they follow the cursor. */
  const setCursor = (i: number, e: DirEntry, keepPopups: boolean): void => {
    setCols((cs) => cs.map((c, k) => (k === i ? { ...c, cursor: e } : c)).slice(0, keepPopups ? undefined : i + 1))
  }

  /** Opens a folder from column i in a popup beside it (the popup that was there stays if it is this folder). */
  const openChild = (i: number, e: DirEntry): void => {
    setCols((cs) => {
      const head = cs.slice(0, i + 1).map((c, k) => (k === i ? { ...c, cursor: e } : c))
      const old = cs[i + 1]
      return [...head, old && old.dir === e.path ? old : { dir: e.path, cursor: null }]
    })
    // the popup is fixed beside the list: bring the list into view first, or the popup opens off-screen
    colEls.current[i]?.scrollIntoView({ block: 'nearest' })
    setActive(i + 1)
    focusLater(i + 1)
  }

  /** Closes column i (a popup) and goes back to the column that opened it. */
  const back = (i: number): void => {
    if (i === 0) return
    setCols((cs) => cs.slice(0, i))
    setActive(i - 1)
    focusLater(i - 1)
  }

  // read by the Ctrl+E hook, which can fire at any time
  const latest = useRef({ cols, active, openChild, focus: focusLater })
  latest.current = { cols, active, openChild, focus: focusLater }

  useEffect(() => {
    const live = {
      openCursor: (): void => {
        const { cols: now, active: a } = latest.current
        const c = now[a]?.cursor
        if (c?.isDir) latest.current.openChild(a, c)
      },
      focus: (): void => latest.current.focus(latest.current.active)
    }
    setExplorerLive(live)
    return () => setExplorerLive(null)
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

  const colProps = (i: number): ColProps => ({
    index: i,
    dir: cols[i].dir,
    cursor: cols[i].cursor,
    openDir: cols[i + 1]?.dir ?? null,
    deco,
    colRef: (el) => {
      colEls.current[i] = el
    },
    onFocus: () => setActive(i),
    onCursor: (e, keep) => setCursor(i, e, keep),
    onOpen: (e) => openChild(i, e),
    onBack: () => back(i)
  })

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
      {cols.slice(1).map((_, k) => (
        <Fragment key={k + 1}>
          {createPortal(
            <div
              className="explorer-nav explorer-pop"
              style={{
                left: box.right + GAP + k * (POP_W + GAP),
                top: popTop,
                width: POP_W,
                maxHeight: window.innerHeight - popTop - 8
              }}
            >
              <ExplorerCol {...colProps(k + 1)} />
            </div>,
            document.body
          )}
        </Fragment>
      ))}
    </div>
  )
}

interface ColProps {
  index: number
  dir: string
  cursor: DirEntry | null
  /** the folder that has a popup open from this column */
  openDir: string | null
  deco: Map<string, string>
  colRef: (el: HTMLDivElement | null) => void
  onFocus: () => void
  onCursor: (e: DirEntry, keepPopups: boolean) => void
  onOpen: (e: DirEntry) => void
  onBack: () => void
  root?: boolean
}

function ExplorerCol(p: ColProps & { root?: boolean }): React.JSX.Element {
  const { dir, cursor, openDir, deco, onCursor, onOpen, onBack, root } = p
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
        if (cur.isDir) onOpen(cur)
        else openFile(cur.path)
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
              onClick={() => (it.isDir ? onOpen(it) : (onCursor(it, false), openFile(it.path)))}
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
