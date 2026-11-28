import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'

/**
 * A plugin's panel: its sidecar's page, shown in a frame. The sidecar starts on first use. The page's
 * address carries the app's theme (`vibeTheme`) and the plugin's settings file (`vibeSettings`).
 */
export function PluginPane({ id, name }: { id: string; name: string }): React.JSX.Element {
  const [page, setPage] = useState<{ url: string; theme: string; settings?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // the plugin follows the app's theme: a theme change restarts the page with the new theme in its address
  const theme = useStore((s) => s.themeResolved)

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
    if (page.settings) u.searchParams.set('vibeSettings', page.settings)
    return u.toString()
  }, [page])

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
          </div>
        </>
      ) : (
        <p>Starting {name}…</p>
      )}
    </div>
  )
}
