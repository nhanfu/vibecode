import { useEffect } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { useStore } from './store'
import { applyTheme, detectClaude, followChatSession, loadPlugins, loadSessions, openFolder, refreshGit, restoreChats, showChatBrowser } from './actions'
import { onGlobalKey, runNativeShortcut, webKeyFromNative } from './shortcuts'
import { focusTerm } from './terminals'
import { reloadIfClean } from './fileModelsLite'
import { QuickOpen, StatusBar, TitleBar, Welcome } from './components/Chrome'
import { KeybindingsEditor } from './components/KeybindingsEditor'
import { StackLayout } from './components/Stack'
import { ReviewPopup } from './components/Review'
import { BottomPanel, ClaudePanel } from './components/Claude'
import { userStore } from './localPref'
import { Loader2 } from 'lucide-react'

/** Shown while the chats a restore brought back are still starting (after a reload or a restart). */
function ResumeNotice(): React.JSX.Element | null {
  const ids = useStore((s) => s.resumingIds)
  const starting = useStore((s) => s.chats.filter((c) => ids.includes(c.id) && c.status === 'starting').length)
  if (!ids.length || !starting) return null
  return (
    <div className="resume-notice" role="status">
      <Loader2 size={14} className="spin" />
      Resuming {starting} {starting === 1 ? 'chat' : 'chats'}…
    </div>
  )
}

function useGlobalKeys(): void {
  useEffect(() => {
    // capture phase: runs before xterm / monaco swallow the keystroke (see shortcuts.ts)
    window.addEventListener('keydown', onGlobalKey, true)
    return () => window.removeEventListener('keydown', onGlobalKey, true)
  }, [])
}

function useBoot(): void {
  useEffect(() => {
    ;(async () => {
      const [settings] = await Promise.all([window.api.app.settings(), detectClaude(), loadPlugins()])
      useStore.setState({ recent: settings.recentFolders, settings })
      applyTheme()
      if (settings.lastFolder) await openFolder(settings.lastFolder, { autoChat: false }).catch(() => {})
      await restoreChats().catch(() => {})
      // nothing to bring back: start with a fresh chat, as before
      if (settings.lastFolder && !useStore.getState().chats.length) openFolder(settings.lastFolder).catch(() => {})
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
      window.api.browser.onKey((_label, key, shift) => webKeyFromNative(key, shift)),
      window.api.browser.onShortcut(runNativeShortcut),
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
  const bottomOpen = useStore((s) => s.bottomOpen)
  const quickOpen = useStore((s) => s.quickOpen)
  const dropdown = useStore((s) => s.win?.mode === 'dropdown')
  // remembered per set of visible panels: the bottom panel can be toggled (the title-bar drop-downs
  // float over the chat or sit beside it, see Stack.tsx)
  const layout = useDefaultLayout({ id: 'layout-main', panelIds: bottomOpen ? ['claude', 'bottom'] : ['claude'], storage: userStore })

  return (
    <div className={`app${dropdown ? ' mode-dropdown' : ''}`}>
      <TitleBar />
      <ResumeNotice />
      {!root ? (
        <Welcome />
      ) : (
        <StackLayout>
          <Group orientation="vertical" className="panels" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
            <Panel id="claude" defaultSize="70%" minSize="20%">
              <ClaudePanel />
            </Panel>
            {bottomOpen && (
              <>
                <Handle dir="v" />
                <Panel id="bottom" defaultSize="30%" minSize="12%">
                  <BottomPanel />
                </Panel>
              </>
            )}
          </Group>
        </StackLayout>
      )}
      <StatusBar />
      {quickOpen && <QuickOpen />}
      <KeybindingsEditor />
      <ReviewPopup />
    </div>
  )
}
