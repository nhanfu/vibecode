import { useEffect } from 'react'
import { useStore } from './store'
import { applyTheme, loadPlugins } from './actions'
import { TitleBar } from './components/Chrome'
import { StackLayout } from './components/Stack'

/** Starts the shell: settings, the plugin list, and the window state (kept up to date). */
function useBoot(): void {
  useEffect(() => {
    ;(async () => {
      const [settings] = await Promise.all([window.api.app.settings(), loadPlugins()])
      useStore.setState({ settings })
      applyTheme()
    })()
    window.api.win.state().then((win) => useStore.setState({ win }))
    return window.api.win.onState((win) => useStore.setState({ win }))
  }, [])
}

export default function App(): React.JSX.Element {
  useBoot()
  const dropdown = useStore((s) => s.win?.mode === 'dropdown')
  return (
    <div className={`app${dropdown ? ' mode-dropdown' : ''}`}>
      <TitleBar />
      <StackLayout />
    </div>
  )
}
