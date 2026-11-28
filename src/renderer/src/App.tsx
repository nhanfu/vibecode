import { useEffect } from 'react'
import { useStore } from './store'
import { applyTheme, loadPlugins } from './actions'
import { loadKeybindings, onGlobalKey } from './shortcuts'
import { TitleBar } from './components/Chrome'
import { KeybindingsEditor } from './components/KeybindingsEditor'
import { StackLayout } from './components/Stack'

/** Starts the shell: settings, the plugin list, and the window state (kept up to date). */
function useGlobalKeys(): void {
  useEffect(() => {
    // capture phase: runs before the terminal and the inputs swallow the keystroke
    window.addEventListener('keydown', onGlobalKey, true)
    // keys a plugin's page passes up (plugins/herdr/web/index.html): the app runs them as its own
    const fromPlugin = (e: MessageEvent): void => {
      const k = e.data?.vibeKey as { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean } | undefined
      if (!k || !/^http:\/\/127\.0\.0\.1:\d+$/.test(e.origin)) return
      onGlobalKey(new KeyboardEvent('keydown', k))
    }
    window.addEventListener('message', fromPlugin)
    return () => {
      window.removeEventListener('keydown', onGlobalKey, true)
      window.removeEventListener('message', fromPlugin)
    }
  }, [])
}

function useBoot(): void {
  useEffect(() => {
    ;(async () => {
      const [settings] = await Promise.all([window.api.app.settings(), loadPlugins(), loadKeybindings()])
      useStore.setState({ settings })
      applyTheme()
    })()
    window.api.win.state().then((win) => useStore.setState({ win }))
    return window.api.win.onState((win) => useStore.setState({ win }))
  }, [])
}

export default function App(): React.JSX.Element {
  useBoot()
  useGlobalKeys()
  const dropdown = useStore((s) => s.win?.mode === 'dropdown')
  return (
    <div className={`app${dropdown ? ' mode-dropdown' : ''}`}>
      <TitleBar />
      <StackLayout />
      <KeybindingsEditor />
    </div>
  )
}
