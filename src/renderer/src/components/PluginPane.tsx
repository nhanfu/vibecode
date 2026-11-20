import { useEffect, useState } from 'react'

/**
 * A plugin's panel: its sidecar's page (src-tauri/src/plugins.rs starts the sidecar on first use),
 * shown in a frame. `onFallback` offers the built-in panel the plugin replaces when it will not start.
 */
export function PluginPane({ id, name, onFallback, fallbackLabel }: { id: string; name: string; onFallback?: () => void; fallbackLabel?: string }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let off = false
    setError(null)
    window.api.plugins.start(id).then(
      (r) => !off && setUrl(r.url),
      (e) => !off && setError(String(e))
    )
    return () => {
      off = true
    }
  }, [id, attempt])

  if (url) return <iframe className="plugin-frame" src={url} title={name} />
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
