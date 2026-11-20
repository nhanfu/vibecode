import { useEffect, useState } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { peekSidebar, useStore } from './store'
import { applyTheme, detectClaude, followChatSession, loadSessions, openFolder, refreshGit, showChatBrowser } from './actions'
import { onGlobalKey } from './shortcuts'
import { focusTerm } from './terminals'
import { reloadIfClean } from './fileModelsLite'
import { QuickOpen, StatusBar, TitleBar, Welcome } from './components/Chrome'
import { Sidebar } from './components/Sidebar'
import { EditorArea } from './components/Editor'
import { BottomPanel, ClaudePanel } from './components/Claude'

const SIDEBAR_W_KEY = 'vibe.sidebarWidth'
const SIDEBAR_W = 300

/** The floating sidebar's width: dragged on its right edge, remembered; double-click resets it. */
function useSidebarWidth(): [number, (e: React.PointerEvent<HTMLDivElement>) => void, () => void] {
  const [width, setWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(SIDEBAR_W_KEY)) || SIDEBAR_W
    } catch {
      return SIDEBAR_W
    }
  })
  const save = (w: number): void => {
    try {
      localStorage.setItem(SIDEBAR_W_KEY, String(w))
    } catch {
      /* it resets next time */
    }
  }
  const start = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('dragging')
    const left = handle.parentElement!.getBoundingClientRect().left
    let w = width
    const move = (ev: PointerEvent): void => {
      const max = Math.max(240, Math.min(760, window.innerWidth * 0.8))
      w = Math.round(Math.min(max, Math.max(220, ev.clientX - left)))
      setWidth(w)
    }
    const up = (): void => {
      handle.classList.remove('dragging')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      save(w)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  const reset = (): void => {
    setWidth(SIDEBAR_W)
    save(SIDEBAR_W)
  }
  return [width, start, reset]
}

function useGlobalKeys(): void {
  useEffect(() => {
    // capture phase: runs before xterm / monaco swallow the keystroke (see shortcuts.ts)
    window.addEventListener('keydown', onGlobalKey, true)
    return () => window.removeEventListener('keydown', onGlobalKey, true)
  }, [])
  // "new Zalo task" notification clicked → show the Zalo tab
  useEffect(() => window.api.zalo.onShowTasks(() => useStore.setState({ centerView: 'zalo' })), [])
}

function useBoot(): void {
  useEffect(() => {
    ;(async () => {
      const [settings] = await Promise.all([window.api.app.settings(), detectClaude()])
      useStore.setState({ recent: settings.recentFolders, settings })
      applyTheme()
      if (settings.lastFolder) openFolder(settings.lastFolder).catch(() => {})
    })()

    window.api.win.state().then((win) => useStore.setState({ win }))
    loadSessions()

    const offs = [
      window.api.fs.onChanged((paths) => {
        refreshGit()
        // the explorer's folders listen to 'fs-changed' and re-read only the ones touched
        for (const p of paths) reloadIfClean(p)
        window.dispatchEvent(new CustomEvent('fs-changed', { detail: paths }))
      }),
      window.api.fs.onGitChanged(() => {
        refreshGit()
        window.dispatchEvent(new Event('git-changed'))
      }),
      window.api.sessions.onChanged(loadSessions),
      window.api.sessions.onChatSession(followChatSession),
      window.api.browser.onOpen(showChatBrowser),
      window.api.win.onState((win) => useStore.setState({ win })),
      // drop-down just slid in → put the cursor straight into the active chat
      window.api.win.onShown(() => {
        const id = useStore.getState().activeChatId
        if (id) focusTerm(id)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])
}

function Handle({ dir }: { dir: 'h' | 'v' }): React.JSX.Element {
  return <Separator className={`resize-handle ${dir}`} />
}

export default function App(): React.JSX.Element {
  useBoot()
  useGlobalKeys()
  const root = useStore((s) => s.root)
  const sidebarShown = useStore((s) => s.sidebarOpen || s.sidebarHover)
  const [sidebarW, startResize, resetWidth] = useSidebarWidth()
  const bottomOpen = useStore((s) => s.bottomOpen)
  // a click or focus outside the floating sidebar hides it (its own menus and the title-bar toggle don't count)
  useEffect(() => {
    if (!sidebarShown) return
    const outside = (e: Event): void => {
      const t = e.target as Element | null
      if (t instanceof Element && t.closest('.sidebar-float, .menu, .ctx-menu, .sidebar-toggle')) return
      useStore.setState({ sidebarOpen: false, sidebarHover: false })
    }
    window.addEventListener('mousedown', outside, true)
    window.addEventListener('focusin', outside, true)
    return () => {
      window.removeEventListener('mousedown', outside, true)
      window.removeEventListener('focusin', outside, true)
    }
  }, [sidebarShown])
  const quickOpen = useStore((s) => s.quickOpen)
  const dropdown = useStore((s) => s.win?.mode === 'dropdown')
  // layouts are remembered per set of visible panels (the bottom panel can be toggled; the sidebar floats over)
  const layoutH = useDefaultLayout({ id: 'layout-h', panelIds: ['center', 'claude'], storage: localStorage })
  const layoutV = useDefaultLayout({ id: 'layout-v', panelIds: bottomOpen ? ['editor', 'bottom'] : ['editor'], storage: localStorage })

  return (
    <div className={`app${dropdown ? ' mode-dropdown' : ''}`}>
      <TitleBar />
      {!root ? (
        <Welcome />
      ) : (
        <div className="workbench">
          <Group orientation="horizontal" className="panels" defaultLayout={layoutH.defaultLayout} onLayoutChanged={layoutH.onLayoutChanged}>
            <Panel id="center" defaultSize="45%" minSize="20%">
              <Group orientation="vertical" defaultLayout={layoutV.defaultLayout} onLayoutChanged={layoutV.onLayoutChanged}>
                <Panel id="editor" defaultSize="68%" minSize="20%">
                  <EditorArea />
                </Panel>
                {bottomOpen && (
                  <>
                    <Handle dir="v" />
                    <Panel id="bottom" defaultSize="32%" minSize="12%">
                      <BottomPanel />
                    </Panel>
                  </>
                )}
              </Group>
            </Panel>
            <Handle dir="h" />
            <Panel id="claude" defaultSize="36%" minSize="22%">
              <ClaudePanel />
            </Panel>
          </Group>
          {/* dims the workbench behind the sidebar; a click on it closes the sidebar (see above) */}
          <div className={`sidebar-backdrop${sidebarShown ? ' shown' : ''}`} />
          <div
            className={`sidebar-float${sidebarShown ? ' shown' : ''}`}
            style={{ width: sidebarW }}
            onMouseEnter={() => peekSidebar(true)}
            onMouseLeave={() => peekSidebar(false)}
          >
            <Sidebar />
            <div className="sidebar-resize" title="Drag to resize · double-click to reset" onPointerDown={startResize} onDoubleClick={resetWidth} />
          </div>
        </div>
      )}
      <StatusBar />
      {quickOpen && <QuickOpen />}
    </div>
  )
}
