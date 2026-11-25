import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, Search, Shuffle, X } from 'lucide-react'
import { BookmarkBar } from './BrowserBookmarks'
import { useStore } from '../store'
import { HOME_URL, pageLabels, setBrowserSession, setBrowserUrl } from '../actions'
import { SlidePill } from './motion'

/** transitions that never move anything (a slide or scale can move the page, so those still count) */
const COLOR_ONLY = new Set(['background-color', 'color', 'opacity', 'box-shadow', 'border-color', 'outline-color', 'fill', 'stroke', 'text-decoration-color'])

/** Typed text → URL: keep real URLs, add https:// to bare hosts, search everything else. */
function toUrl(input: string): string {
  const t = input.trim()
  if (/^(https?|file):\/\//i.test(t)) return t
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t)) return 'http://' + t
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t)) return 'https://' + t
  return 'https://www.google.com/search?q=' + encodeURIComponent(t)
}

/** The blank start page shows as an empty address bar. */
const display = (url: string): string => (url === HOME_URL ? '' : url)

/**
 * Anything drawn over the page area (menus, dialogs, lightboxes, address suggestions, a title-bar
 * drop-down floating over a pinned Web). The page itself is a native view stacked above the app's
 * HTML, so it steps aside while one is open. The drop-down the page is in doesn't count.
 */
const OVERLAYS = '.overlay, .menu, .ctx-menu, .stack-panel.floating.shown, .image-lightbox, .term-image-hover, .bm-menu'

const overlaps = (a: DOMRect, b: DOMRect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

let labelSeq = 0

export function BrowserTab({
  chatKey,
  tabId,
  active,
  detached = false,
  onScreen
}: {
  chatKey: string
  tabId: string
  /** the open tab of its chat's Web strip (what Claude's browser tools drive) */
  active: boolean
  /** torn off into a panel of its own: live whenever that panel is on screen */
  detached?: boolean
  onScreen: boolean
}): React.JSX.Element {
  const viewRef = useRef<HTMLDivElement>(null)
  const url = useStore((s) => s.browsers[chatKey]?.tabs.find((t) => t.id === tabId)?.url ?? HOME_URL)
  // the native page this tab owns (labels: letters, digits, - _ only)
  const [label] = useState(() => `web-${++labelSeq}-${tabId}`.replace(/[^\w-]/g, '_'))
  useEffect(() => {
    pageLabels.set(tabId, label)
    return () => {
      if (pageLabels.get(tabId) === label) pageLabels.delete(tabId)
    }
  }, [label, tabId])
  // first URL only: later navigation happens inside the page
  const [initial] = useState(url)
  const [address, setAddress] = useState(display(url))
  const addressRef = useRef<HTMLInputElement>(null)
  const shown = useRef(url)
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, fwd: false })
  // blank tab: the native page is hidden and a start page with a random photo shows instead
  const [home, setHome] = useState(url === HOME_URL)

  /*
   * A blank tab puts the cursor in the address bar — without scrolling: focusing an input inside the
   * sliding, overflow-hidden deck made the whole page jump. Not when a chat terminal has the cursor
   * (a new chat opened while on Web keeps typing into the chat).
   */
  useEffect(() => {
    if (!active || display(url)) return
    const el = addressRef.current
    if (!el || el.closest('.center-pane:not(.on)')) return
    const cur = document.activeElement
    if (cur && cur !== document.body && cur.closest('.xterm')) return
    el.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // the native page lives as long as this tab
  useEffect(() => {
    const saved = useStore.getState().browsers[chatKey]?.tabs.find((t) => t.id === tabId)
    const muted = saved?.muted
    void window.api.browser.open(label, chatKey, initial, undefined, saved?.session).then(() => {
      if (muted) void window.api.browser.setMuted(label, true)
    }).catch((e) => console.warn('web open failed:', label, initial, e))
    return () => window.api.browser.close(label)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label])

  // a tab shown again (its component is mounted anew) takes the state its page is in, not the defaults
  useEffect(() => {
    void window.api.browser.lastNav(label).then((n) => {
      if (!n) return
      setLoading(n.loading)
      setNav({ back: n.back, fwd: n.fwd })
    }).catch(() => {})
  }, [label])

  // address bar / buttons follow the page
  useEffect(
    () =>
      window.api.browser.onNav((l, n) => {
        if (l !== label) return
        setLoading(n.loading)
        setNav({ back: n.back, fwd: n.fwd })
        if (!n.url) return
        if (!n.loading || n.url !== HOME_URL) setHome(n.url === HOME_URL)
        if (n.url !== shown.current && !n.loading) window.api.browser.visit(n.url)
        if (n.title) window.api.browser.title(n.url, n.title)
        if (document.activeElement !== addressRef.current) setAddress(display(n.url))
        shown.current = n.url
        setBrowserUrl(chatKey, n.url, tabId, n.title || undefined)
      }),
    [label, chatKey, tabId]
  )

  // the page's history after each finished load, kept with the tab (see web_open's session)
  useEffect(
    () =>
      window.api.browser.onSession((l, session) => {
        if (l === label) setBrowserSession(chatKey, tabId, session)
      }),
    [label, chatKey, tabId]
  )

  // lets this chat's Claude drive the page (browser_* MCP tools): always the tab you're looking at
  useEffect(() => {
    if (active) window.api.browser.setActive(chatKey, label)
  }, [active, chatKey, label])

  // openBrowser(url) from elsewhere in the app: navigate there
  useEffect(() => {
    if (url !== shown.current) {
      shown.current = url
      setAddress(display(url))
      setHome(url === HOME_URL)
      void window.api.browser.navigate(label, url).catch((e) => console.warn('web navigate failed:', label, url, e))
    }
  }, [url, label])

  /*
   * Keep the native page glued to its placeholder. It is shown only while this is the open tab of
   * the chat on screen, the Web view is in front, nothing is drawn over it and the window is not
   * hidden; otherwise it is parked — and the engine throttles, then freezes it.
   */
  const zoom = 1
  // the open tab of the chat on screen, with the Web view in front: only that page is tracked live
  const live = (active || detached) && onScreen
  useEffect(() => {
    const el = viewRef.current
    if (!el) return
    let last = ''
    const place = (): void => {
      if (!live) {
        window.api.browser.place(label, { x: 0, y: 0, w: 0, h: 0 }, zoom, false)
        return
      }
      const r = el.getBoundingClientRect()
      const fits = r.width > 4 && r.height > 4 && document.visibilityState === 'visible' && !el.closest('.browser-tab-pane:not(.on)')
      const covered = fits && [...document.querySelectorAll(OVERLAYS)].some((o) => !o.contains(el) && overlaps(o.getBoundingClientRect(), r))
      const visible = fits && !covered && !home
      const key = visible ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)},${zoom}` : 'off'
      if (key === last) return
      last = key
      window.api.browser.place(label, { x: r.left, y: r.top, w: r.width, h: r.height }, zoom, visible)
    }
    let frame = 0
    const soon = (): void => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0
        place()
      })
    }
    place()
    // parked: nothing to follow. (Every tab of every chat used to watch the whole document, so each
    // terminal redraw made all of them measure the layout.)
    if (!live) return
    const ro = new ResizeObserver(soon)
    ro.observe(el)
    // menus / dialogs opening, panes sliding, the chat switching. Changes inside a terminal or an
    // editor (every line of output, the cursor) can't move the page or cover it: skip those.
    const mo = new MutationObserver((recs) => {
      for (const r of recs) {
        const el = r.target instanceof Element ? r.target : r.target.parentElement
        if (el && !el.closest('.xterm, .monaco-editor')) return soon()
      }
    })
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', soon)
    document.addEventListener('visibilitychange', soon)
    document.addEventListener('transitionend', soon, true)
    // slide-in animations move the placeholder without resizing it: follow it frame by frame while
    // one runs (instead of measuring every 300 ms forever), plus a slow check as a safety net
    let until = 0
    let loop = 0
    const step = (): void => {
      place()
      loop = performance.now() < until ? requestAnimationFrame(step) : 0
    }
    const follow = (e: Event): void => {
      // hover colours and fades can't move the page
      if (e instanceof TransitionEvent && COLOR_ONLY.has(e.propertyName)) return
      until = performance.now() + 700
      if (!loop) loop = requestAnimationFrame(step)
    }
    document.addEventListener('transitionrun', follow, true)
    document.addEventListener('animationstart', follow, true)
    const tick = window.setInterval(place, 1000)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', soon)
      document.removeEventListener('visibilitychange', soon)
      document.removeEventListener('transitionend', soon, true)
      window.clearInterval(tick)
      cancelAnimationFrame(loop)
      document.removeEventListener('transitionrun', follow, true)
      document.removeEventListener('animationstart', follow, true)
    }
  }, [live, label, zoom, home])

  const go = (to = toUrl(address)): void => {
    setAddress(to)
    setHome(to === HOME_URL)
    shown.current = to
    // the tab is no longer blank as of now, not only once the page reports in (a "+" meanwhile
    // reused this tab instead of opening a second one)
    setBrowserUrl(chatKey, to, tabId)
    void window.api.browser.navigate(label, to).catch((e) => console.warn('web navigate failed:', label, to, e))
  }

  return (
    <div className="browser-tab">
      <div className="browser-bar">
        <button className="icon-btn" title="Back" disabled={!nav.back} onClick={() => window.api.browser.back(label)}>
          <ArrowLeft size={15} />
        </button>
        <button className="icon-btn" title="Forward" disabled={!nav.fwd} onClick={() => window.api.browser.forward(label)}>
          <ArrowRight size={15} />
        </button>
        <button className="icon-btn" title={loading ? 'Stop' : 'Reload'} onClick={() => (loading ? window.api.browser.stop(label) : window.api.browser.reload(label))}>
          {loading ? <X size={15} /> : <RotateCw size={14} />}
        </button>
        <div className="browser-address-wrap">
          <input
            ref={addressRef}
            className="browser-address"
            value={address}
            spellCheck={false}
            placeholder="Search or type a URL"
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                go()
                // like a browser: once the address is entered, the keyboard goes into the page
                window.api.browser.focus(label)
              }
            }}
          />
        </div>
        {/* thin bar along the toolbar's bottom edge while the page loads, like other browsers */}
        {loading && (
          <div className="browser-progress" aria-hidden>
            <span />
          </div>
        )}
      </div>
      <BookmarkBar onOpen={(u) => go(u)} />
      <div className="browser-stage">
        {/* placeholder: the native page is laid over this box */}
        <div ref={viewRef} className="browser-view" />
        {home && <StartPage onGo={(text) => go(toUrl(text))} />}
      </div>
    </div>
  )
}

/* ---------------- start page ---------------- */

/** A random landscape photo (Unsplash pictures via picsum.photos, no key needed). */
const randomPhoto = (): string => `https://picsum.photos/seed/${Math.random().toString(36).slice(2, 10)}/1920/1080`

/** Blank tab: a new random photo every time, a clock and a search box — like a browser's new tab page. */
function StartPage({ onGo }: { onGo: (text: string) => void }): React.JSX.Element {
  const [photo, setPhoto] = useState(randomPhoto)
  const [ready, setReady] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [q, setQ] = useState('')

  // show the photo only once it has loaded, so it fades in instead of painting line by line
  useEffect(() => {
    const img = new Image()
    // a shuffle before this one loaded: the older photo must not land last
    img.onload = () => setReady(photo)
    img.src = photo
    return () => {
      img.onload = null
      img.src = ''
    }
  }, [photo])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="start-page">
      <div className={`start-photo${ready ? ' on' : ''}`} style={ready ? { backgroundImage: `url("${ready}")` } : undefined} />
      <div className="start-content">
        <div className="start-clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        <div className="start-date">{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <form
          className="start-search"
          onSubmit={(e) => {
            e.preventDefault()
            if (q.trim()) onGo(q)
          }}
        >
          <Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Google or type a URL" spellCheck={false} />
        </form>
      </div>
      <button className="start-shuffle" title="Another photo" onClick={() => setPhoto(randomPhoto())}>
        <Shuffle size={14} />
      </button>
    </div>
  )
}
