import { createPortal } from 'react-dom'
import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SiteIcon } from './SiteIcon'
import { Database, X, Globe, Plus } from 'lucide-react'
import { panelShown, useStore } from '../store'
import { HOME_URL, browserKey, closeBrowserTab, detachBrowserTab, ensureBrowser, moveBrowserTab, newBrowserTab, openBrowser, selectBrowserTab } from '../actions'
import { Adopt } from './webHosts'
import { SlidePill } from './motion'
// heavy parts load on first use
const PluginPane = lazy(() => import('./PluginPane').then((m) => ({ default: m.PluginPane })))
const DatabasePane = lazy(() => import('./Database').then((m) => ({ default: m.DatabasePane })))
import { revealIn } from '../scroll'
import { userStore } from '../localPref'

/*
 * Web and Database: two of the title-bar drop-downs (Stack.tsx), each floating over
 * the chat or pinned beside it. A drop-down that isn't on screen stays mounted and laid out, only
 * hidden: display:none would drop scroll positions, make Monaco re-measure on return and replay
 * every animation inside.
 */

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
/** A page's address without the scheme and "www.": the fallback name of a tab with no title yet. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

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
    // along the strip the tab moves to the place under the pointer; above it, it is torn off
    const reorder = (x: number): void => {
      const els = Array.from(stripRef.current?.querySelectorAll<HTMLElement>('.tab[data-tab]') ?? [])
      let to = 0
      for (const el of els) {
        if (el.dataset.tab === id) continue
        const r = el.getBoundingClientRect()
        if (x > r.left + r.width / 2) to++
      }
      moveBrowserTab(chatKey, id, to)
    }
    const move = (ev: PointerEvent): void => {
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return
        started = true
        document.body.style.cursor = 'grabbing'
      }
      if (!above(ev.clientY)) reorder(ev.clientX)
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
            data-tab={t.id}
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
            <span className="tab-title">{t.title || (t.url === HOME_URL ? 'New tab' : hostOf(t.url))}</span>
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
