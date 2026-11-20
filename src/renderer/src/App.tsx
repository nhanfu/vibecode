import { useEffect } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { peekSidebar, useStore } from './store'
import { applyTheme, detectClaude, loadSessions, openFolder, refreshGit, showChatBrowser } from './actions'
import { onGlobalKey } from './shortcuts'
import { focusTerm } from './terminals'
import { reloadIfClean } from './fileModelsLite'
import { QuickOpen, StatusBar, TitleBar, Welcome } from './components/Chrome'
import { Sidebar } from './components/Sidebar'
import { EditorArea } from './components/Editor'
import { BottomPanel, ClaudePanel } from './components/Claude'

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
          <div
            className={`sidebar-float${sidebarShown ? ' shown' : ''}`}
            onMouseEnter={() => peekSidebar(true)}
            onMouseLeave={() => peekSidebar(false)}
          >
            <Sidebar />
          </div>
        </div>
      )}
      <StatusBar />
      {quickOpen && <QuickOpen />}
    </div>
  )
}
