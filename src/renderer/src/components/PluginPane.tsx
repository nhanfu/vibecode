import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'

/**
 * A plugin's panel: its sidecar's page (src-tauri/src/plugins.rs starts the sidecar on first use),
 * shown in a frame. `onFallback` offers the built-in panel the plugin replaces when it will not start.
 */
export function PluginPane({ id, name, onFallback, fallbackLabel }: { id: string; name: string; onFallback?: () => void; fallbackLabel?: string }): React.JSX.Element {
  // the page on screen, with the theme it was loaded for
  const [page, setPage] = useState<{ url: string; theme: string; settings?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // the plugin follows the app's theme: the resolved one travels in the address (see plugins/dbx/patch-theme.py),
  // and a plugin with a theme setting gets it written before its page loads (src-tauri plugin_start).
  // The page is only swapped once that write is done, so it loads with the new theme already in its settings.
  const theme = useStore((s) => s.themeResolved)
  const plugin = useStore((s) => s.plugins.find((p) => p.id === id))
  // a plugin whose panel asks for it opens the project folder the sidebar shows
  const root = useStore((s) => s.root)
  const folder = plugin?.panel?.folder ? root : null

  useEffect(() => {
    let off = false
    setError(null)
    window.api.plugins.start(id, theme === 'light').then(
      (r) => !off && setPage({ url: r.url, theme, settings: r.settings }),
      (e) => !off && setError(String(e))
    )
    return () => {
      off = true
    }
  }, [id, attempt, theme])

  const src = useMemo(() => {
    if (!page) return null
    const u = new URL(page.url)
    u.searchParams.set('vibeTheme', page.theme)
    // the plugin's settings file, for pages that take it as their defaults (plugins/vscode/patch-theme.py)
    if (page.settings) u.searchParams.set('vibeSettings', page.settings)
    if (folder) u.searchParams.set('folder', folder)
    return u.toString()
  }, [page, folder])

  if (src) return <iframe className="plugin-frame" src={src} title={name} />
  return (
    <div className="plugin-status">
      {error ? (
        <>
          <p>{error}</p>
          <div className="plugin-actions">
            <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
            {onFallback && (
              <button className="btn" onClick={onFallback}>
                {fallbackLabel ?? 'Use the built-in panel'}
              </button>
            )}
          </div>
        </>
      ) : (
        <p>Starting {name}…</p>
      )}
    </div>
  )
}
