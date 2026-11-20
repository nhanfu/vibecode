import { Suspense, lazy, memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Columns2, Database, FileDiff, FileText, Rows2, X, Command, GitCompare, Globe, MessageSquarePlus, Plus, Search } from 'lucide-react'
import { fileUri, panelShown, useStore, type EditorTab } from '../store'
import { HOME_URL, browserKey, closeBrowserTab, closeTab, ensureBrowser, newBrowserTab, openBrowser, openFile, selectBrowserTab } from '../actions'
import { BrowserTab } from './Browser'
import { SlidePill } from './motion'
import { ChangesView, ExplorerView } from './Sidebar'
import { FileIcon, Logo } from './icons'
import { EditorFontButton } from './EditorFont'
// heavy parts load on first use: Monaco (~4 MB) only when a file or diff opens
const FileEditor = lazy(() => import('./MonacoViews').then((m) => ({ default: m.FileEditor })))
const DiffView = lazy(() => import('./MonacoViews').then((m) => ({ default: m.DiffView })))
const DatabasePane = lazy(() => import('./Database').then((m) => ({ default: m.DatabasePane })))
import { revealIn } from '../scroll'

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
  return (
    <div className="center-area">
      {seen && (
        <div className="center-pane db-host on">
          <Suspense fallback={null}>
            <DatabasePane />
          </Suspense>
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
  // on screen: the Web panel is showing, for this chat (a hidden panel parks the native pages)
  const shown = useStore((s) => panelShown(s, 'web') && browserKey(s.activeChatId) === chatKey)
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

  if (!b) return null
  const activeIdx = b.tabs.findIndex((t) => t.id === b.active)
  return (
    <>
      <div className="tab-strip web-tab-strip" ref={stripRef} onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}>
        <SlidePill className="tab-pill" />
        {b.tabs.map((t) => (
          <div
            key={t.id}
            className={`tab${t.id === b.active ? ' active' : ''}${closing.has(t.id) ? ' closing' : ''}`}
            onClick={() => selectBrowserTab(chatKey, t.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                close(t.id)
              }
            }}
            title={t.url === HOME_URL ? 'New tab' : t.url}
          >
            <Globe size={13} />
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
        <button className="icon-btn tab-strip-btn" title="New tab" onClick={() => newBrowserTab(chatKey)}>
          <Plus size={15} />
        </button>
        <div className="tab-strip-fill" />
      </div>
      {/* every page stays laid out (no display:none → no re-layout flash); the open one slides in */}
      <div className="browser-deck">
        {b.tabs.map((t, i) => (
          <div key={t.id} className={`browser-tab-pane ${i === activeIdx ? 'on' : i < activeIdx ? 'left' : 'right'}`}>
            <BrowserTab chatKey={chatKey} tabId={t.id} active={t.id === b.active} onScreen={shown} />
          </div>
        ))}
      </div>
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
