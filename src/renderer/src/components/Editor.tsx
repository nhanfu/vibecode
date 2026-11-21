import { createPortal } from 'react-dom'
import { Suspense, lazy, memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SiteIcon } from './SiteIcon'
import { Columns2, Database, FileDiff, FileText, Rows2, X, Command, GitCompare, Globe, MessageSquarePlus, Plus, Search } from 'lucide-react'
import { fileUri, panelShown, useStore, type EditorTab } from '../store'
import { HOME_URL, browserKey, closeBrowserTab, closeTab, detachBrowserTab, ensureBrowser, newBrowserTab, openBrowser, openFile, selectBrowserTab } from '../actions'
import { Adopt } from './webHosts'
import { SlidePill } from './motion'
import { ChangesView, ExplorerView } from './Sidebar'
import { FileIcon, Logo } from './icons'
import { EditorFontButton } from './EditorFont'
// heavy parts load on first use: Monaco (~4 MB) only when a file or diff opens
const FileEditor = lazy(() => import('./MonacoViews').then((m) => ({ default: m.FileEditor })))
const DiffView = lazy(() => import('./MonacoViews').then((m) => ({ default: m.DiffView })))
const PluginPane = lazy(() => import('./PluginPane').then((m) => ({ default: m.PluginPane })))
const DatabasePane = lazy(() => import('./Database').then((m) => ({ default: m.DatabasePane })))
import { revealIn } from '../scroll'
import { userStore } from '../localPref'

/*
 * Source code, Web and Database: three of the title-bar drop-downs (Stack.tsx), each floating over
 * the chat or pinned beside it. A drop-down that isn't on screen stays mounted and laid out, only
 * hidden: display:none would drop scroll positions, make Monaco re-measure on return and replay
 * every animation inside.
 */

/** Source code: the whole project of the open chat — file tree on the left, files on the right. */
export function CodePanel(): React.JSX.Element {
  return (
    <div className="center-area">
      <div className="center-pane code-pane on">
        <CodeSide />
        <CodeArea />
      </div>
    </div>
  )
}

/** Database: mounts the first time it is shown, then stays (keeps its SQL, results and open tree). */
export function DbPanel(): React.JSX.Element {
  const shown = useStore((s) => panelShown(s, 'db'))
  const [seen, setSeen] = useState(shown)
  useEffect(() => {
    if (shown) setSeen(true)
  }, [shown])
  // a plugin can take the Database panel over (DBX); the built-in SQL Server panel stays one click away
  const plugin = useStore((s) => s.plugins.find((p) => p.available && p.enabled && p.panel?.replaces === 'db'))
  const [pick, setPick] = useState<'plugin' | 'builtin' | null>(() => {
    try {
      const v = userStore.getItem('vibe.db.engine')
      return v === 'plugin' || v === 'builtin' ? v : null
    } catch {
      return null
    }
  })
  const engine = plugin && pick !== 'builtin' ? 'plugin' : 'builtin'
  const choose = (e: 'plugin' | 'builtin'): void => {
    setPick(e)
    try {
      userStore.setItem('vibe.db.engine', e)
    } catch {
      /* private mode */
    }
  }
  return (
    <div className="center-area">
      {seen && (
        <div className="center-pane db-host on db-engine-host">
          {plugin && (
            <div className="db-engine-bar">
              <button className={engine === 'plugin' ? 'on' : ''} onClick={() => choose('plugin')}>
                {plugin.name}
              </button>
              <button className={engine === 'builtin' ? 'on' : ''} onClick={() => choose('builtin')}>
                Classic SQL Server
              </button>
            </div>
          )}
          <div className="db-engine-body">
            <Suspense fallback={null}>
              {engine === 'plugin' && plugin ? (
                <PluginPane id={plugin.id} name={plugin.name} onFallback={() => choose('builtin')} fallbackLabel="Use the classic SQL Server panel" />
              ) : (
                <DatabasePane />
              )}
            </Suspense>
          </div>
        </div>
      )}
    </div>
  )
}

/** Web: one browser per chat, every tab kept alive so pages survive switching chats. */
export function WebPanel(): React.JSX.Element {
  const shown = useStore((s) => panelShown(s, 'web'))
  const key = useStore((s) => browserKey(s.activeChatId))
  const browsers = useStore((s) => s.browsers)
  // shown (or the chat switched while it is): that chat gets its own browser, before paint (no
  // empty frame). Only created here: hovering the Web button must not open anything else.
  useLayoutEffect(() => {
    if (shown && !browsers[key]) ensureBrowser(key)
  }, [shown, key, browsers])
  return (
    <div className="center-area">
      {Object.keys(browsers).map((k) => (
        <div key={k} className={`center-pane browser-host${k === key ? ' on' : ''}`}>
          <WebTabs chatKey={k} />
        </div>
      ))}
    </div>
  )
}

/** A chat's browser: its tab strip and one page per tab. */
function WebTabs({ chatKey }: { chatKey: string }): React.JSX.Element | null {
  const b = useStore((s) => s.browsers[chatKey])
  // a tab being dragged: `out` once the pointer is above the strip (letting go there tears it off)
  const [tear, setTear] = useState<{ id: string; out: boolean; x: number; y: number } | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  // tabs on their way out: they shrink away first, then really close
  const [closing, setClosing] = useState<Set<string>>(new Set())
  const close = (id: string): void => {
    if (closing.has(id)) return
    setClosing((c) => new Set(c).add(id))
    setTimeout(() => {
      closeBrowserTab(chatKey, id)
      setClosing((c) => {
        const n = new Set(c)
        n.delete(id)
        return n
      })
    }, 200)
  }

  useEffect(() => {
    revealIn(stripRef.current, stripRef.current?.querySelector('.tab.active'), { inline: 'nearest', smooth: true })
  }, [b?.active, b?.tabs.length])

  /**
   * Drag a tab up out of the strip and let go: it becomes a title-bar button of its own. Pointer
   * events (the webview's file-drop handling swallows HTML5 drags).
   */
  const startTear = (e: React.PointerEvent<HTMLDivElement>, id: string): void => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return
    const x0 = e.clientX
    const y0 = e.clientY
    let started = false
    const above = (y: number): boolean => y < (stripRef.current?.getBoundingClientRect().top ?? 0) - 6
    const move = (ev: PointerEvent): void => {
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return
        started = true
        document.body.style.cursor = 'grabbing'
      }
      setTear({ id, out: above(ev.clientY), x: ev.clientX, y: ev.clientY })
    }
    const end = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      document.body.style.cursor = ''
      setTear(null)
      if (!started) return
      // the click after a drag must not select the tab
      window.addEventListener('click', (c) => c.stopPropagation(), { capture: true, once: true })
      if (ev.type === 'pointerup' && above(ev.clientY)) detachBrowserTab(chatKey, id)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  if (!b) return null
  const strip = b.tabs.filter((t) => !t.detached)
  const activeIdx = strip.findIndex((t) => t.id === b.active)
  return (
    <>
      <div className="tab-strip web-tab-strip" ref={stripRef} onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}>
        <SlidePill className="tab-pill" />
        {strip.map((t) => (
          <div
            key={t.id}
            className={`tab${t.id === b.active ? ' active' : ''}${closing.has(t.id) ? ' closing' : ''}${tear?.id === t.id ? ' tearing' : ''}`}
            onPointerDown={(e) => startTear(e, t.id)}
            onClick={() => selectBrowserTab(chatKey, t.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                close(t.id)
              }
            }}
            title={t.url === HOME_URL ? 'New tab' : `${t.url}\nDrag it up to the title bar to open it as its own tab`}
          >
            <SiteIcon url={t.url} />
            <span className="tab-title">{t.title || (t.url === HOME_URL ? 'New tab' : t.url.replace(/^https?:\/\//, ''))}</span>
            <button
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                close(t.id)
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="icon-btn tab-strip-btn" title="New tab" onClick={() => newBrowserTab(chatKey, undefined, false)}>
          <Plus size={15} />
        </button>
        <div className="tab-strip-fill" />
      </div>
      {/* every page stays laid out (no display:none → no re-layout flash); the open one slides in */}
      <div className="browser-deck">
        {strip.map((t, i) => (
          <Adopt key={t.id} tabId={t.id} className={`browser-tab-pane ${i === activeIdx ? 'on' : i < activeIdx ? 'left' : 'right'}`} />
        ))}
      </div>
      {tear?.out &&
        createPortal(
          <div className="tab-tear-hint" style={{ left: tear.x + 14, top: tear.y + 14 }}>
            Let go to open it as its own tab
          </div>,
          document.body
        )}
    </>
  )
}

/** Left column of Source code: the project's files, or its Git changes (click one for the diff). */
// memo (no props): EditorArea re-renders whenever any web page changes its address or title
const CodeSide = memo(function CodeSide(): React.JSX.Element {
  // in the store: Ctrl+Shift+E / Ctrl+Shift+G switch it
  const side = useStore((s) => s.codeSide)
  const setSide = (codeSide: 'files' | 'changes'): void => useStore.setState({ codeSide })
  const changed = useStore((s) => s.git.files.length)
  const hasRoot = useStore((s) => !!s.root)
  return (
    <div className="sidebar code-tree">
      <div className="code-side-switch">
        <SlidePill />
        <button className={side === 'files' ? 'on' : ''} onClick={() => setSide('files')}>
          <FileText size={13} /> Files
        </button>
        <button className={side === 'changes' ? 'on' : ''} onClick={() => setSide('changes')}>
          <GitCompare size={13} /> Changes
          {changed > 0 && <span className="center-count">{changed}</span>}
        </button>
      </div>
      {hasRoot && (side === 'files' ? <ExplorerView /> : <ChangesView />)}
    </div>
  )
})

const CodeArea = memo(function CodeArea(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeId) ?? null
  const stripRef = useRef<HTMLDivElement>(null)
  // The file editor and the diff view both stay mounted once used (the other one is just hidden):
  // going file ↔ diff no longer builds a new Monaco editor on every click.
  const fileId = useRef<string | null>(null)
  const diffId = useRef<string | null>(null)
  if (active?.kind === 'file') fileId.current = active.id
  if (active?.kind === 'diff') diffId.current = active.id
  const fileTab = tabs.find((t): t is Extract<EditorTab, { kind: 'file' }> => t.kind === 'file' && t.id === fileId.current)
  const diffTab = tabs.find((t): t is Extract<EditorTab, { kind: 'diff' }> => t.kind === 'diff' && t.id === diffId.current)

  useEffect(() => {
    revealIn(stripRef.current, stripRef.current?.querySelector('.tab.active'), { inline: 'nearest', smooth: true })
  }, [activeId])

  return (
    <div className="editor-area">
      {tabs.length > 0 && (
        <div className="tab-row">
        <div className="tab-strip" ref={stripRef} onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}>
          <SlidePill className="tab-pill" />
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab${t.id === activeId ? ' active' : ''}${t.kind === 'diff' ? ' diff' : ''}`}
              onClick={() => useStore.setState({ activeTabId: t.id })}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  closeTab(t.id)
                }
              }}
              title={t.path}
            >
              {t.kind === 'diff' ? <FileDiff size={14} color="#5aa9ff" /> : <FileIcon name={t.title} size={14} />}
              <span className="tab-title">{t.title}</span>
              {t.kind === 'diff' && <span className="tab-tag">diff</span>}
              <button
                className={`tab-close${t.kind === 'file' && t.dirty ? ' dirty' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <div className="tab-strip-fill" />
        </div>
        <EditorFontButton />
        </div>
      )}
      <div className="editor-body">
        {!active && <EmptyEditor />}
        <Suspense fallback={null}>
          {/* no key: one editor serves every file tab, one diff view every diff tab */}
          {fileTab && (
            <div className={`editor-layer${active === fileTab ? ' on' : ''}`} inert={active !== fileTab}>
              <FileEditor tab={fileTab} />
            </div>
          )}
          {diffTab && (
            <div className={`editor-layer${active === diffTab ? ' on' : ''}`} inert={active !== diffTab}>
              <DiffView tab={diffTab} />
            </div>
          )}
        </Suspense>
      </div>
    </div>
  )
})

/* ================================ Empty state ================================ */

function EmptyEditor(): React.JSX.Element {
  const rows: [React.ReactNode, string, string][] = [
    [<Search size={14} key="s" />, 'Go to file', 'Ctrl+P'],
    [<MessageSquarePlus size={14} key="n" />, 'New chat', 'Ctrl+Shift+N'],
    [<GitCompare size={14} key="g" />, 'Show changes', 'Ctrl+Shift+G'],
    [<Command size={14} key="t" />, 'Toggle terminal', 'Ctrl+`'],
    [<Command size={14} key="b" />, 'Toggle sidebar', 'Ctrl+B']
  ]
  return (
    <div className="empty-editor">
      <div className="empty-logo">
        <Logo size={64} />
      </div>
      <button className="btn btn-primary btn-lg" onClick={() => openBrowser()}>
        <Globe size={16} /> Open browser
      </button>
      <div className="shortcut-list">
        {rows.map(([icon, label, key]) => (
          <div key={label} className="shortcut-row">
            <span className="shortcut-label">
              {icon} {label}
            </span>
            <kbd>{key}</kbd>
          </div>
        ))}
      </div>
    </div>
  )
}
