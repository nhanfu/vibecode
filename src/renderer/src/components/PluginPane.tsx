import { useEffect, useMemo, useState } from 'react'
import { useStore, type PluginOpen } from '../store'

/** `vscode-remote://<the page's host><path>`: how the VS Code web client names a file of the machine it runs on. */
const vscodeUri = (host: string, path: string): string => `vscode-remote://${host}${path.split('/').map(encodeURIComponent).join('/')}`

/**
 * VS Code takes the file to open (or two to compare) in the address: `payload`. A diff shows `diffFileSecondary`
 * on the left and `diffFilePrimary` on the right. See review() in actions.ts.
 */
function vscodePayload(host: string, open: PluginOpen): string | null {
  if (open.file) return JSON.stringify([['openFile', vscodeUri(host, open.file)]])
  if (open.diff) return JSON.stringify([['diffFilePrimary', vscodeUri(host, open.diff.right)], ['diffFileSecondary', vscodeUri(host, open.diff.left)]])
  return null
}

/** The tab's name: the file's own name (or both names of a diff). */
function tabLabel(open: PluginOpen): string {
  const name = (path: string): string => path.split('/').pop() || path
  if (open.file) return name(open.file)
  if (open.diff) return `${name(open.diff.left)} ↔ ${name(open.diff.right)}`
  return 'VS Code'
}

interface VscodeTab {
  key: string
  label: string
  src: string
}

/**
 * A plugin's panel: its sidecar's page (src-tauri/src/plugins.rs starts the sidecar on first use),
 * shown in a frame.
 *
 * VS Code is one server for the whole panel: each file asked for opens in a tab of its own, a frame of the
 * same address with its `payload`. Tabs stay mounted, so going back to one does not reload the editor.
 */
export function PluginPane({ id, name }: { id: string; name: string }): React.JSX.Element {
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
  // a file or a change to show (the Files / Changes lists of the agent sidebar), for the VS Code plugin
  const open = useStore((s) => s.pluginOpen[id])
  const [tabs, setTabs] = useState<VscodeTab[]>([])
  const [active, setActive] = useState('main')

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

  // the address without a file: the page's own theme, settings and folder
  const base = useMemo(() => {
    if (!page) return null
    const u = new URL(page.url)
    u.searchParams.set('vibeTheme', page.theme)
    // the plugin's settings file, for pages that take it as their defaults (plugins/vscode/patch-theme.py)
    if (page.settings) u.searchParams.set('vibeSettings', page.settings)
    if (folder) u.searchParams.set('folder', folder)
    return u
  }, [page, folder])

  // a new page (theme change) starts the tabs over; a file asked for adds its tab, or shows the one it has
  useEffect(() => {
    if (!base) return
    if (id !== 'vscode') {
      setTabs([{ key: 'main', label: name, src: base.toString() }])
      return
    }
    const payload = open ? vscodePayload(base.host, open) : null
    if (!open || !payload) {
      setTabs((prev) => (prev.length ? prev : [{ key: 'main', label: 'VS Code', src: base.toString() }]))
      return
    }
    const key = `file-${open.n}`
    const u = new URL(base.toString())
    u.searchParams.set('payload', payload)
    // the same file asked again gets the same tab, brought to the front
    setTabs((prev) => {
      const main = prev.find((t) => t.key === 'main') ?? { key: 'main', label: 'VS Code', src: base.toString() }
      const existing = prev.find((t) => t.key === key)
      const others = prev.filter((t) => t.key !== 'main' && t.key !== key)
      return [main, ...others, existing ?? { key, label: tabLabel(open), src: u.toString() }]
    })
    setActive(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, open, id, name])

  const closeTab = (key: string): void => {
    setTabs((prev) => prev.filter((t) => t.key !== key))
    setActive((a) => (a === key ? 'main' : a))
  }

  if (base && tabs.length) {
    if (id !== 'vscode') return <iframe className="plugin-frame" src={tabs[0].src} title={name} />
    return (
      <div className="plugin-tabs">
        <div className="plugin-tabbar" role="tablist">
          {tabs.map((t) => (
            <div key={t.key} className={`plugin-tab${active === t.key ? ' on' : ''}`} role="tab" aria-selected={active === t.key} onClick={() => setActive(t.key)}>
              <span>{t.label}</span>
              {t.key !== 'main' && (
                <button className="plugin-tab-close" title="Close" onClick={(e) => { e.stopPropagation(); closeTab(t.key) }}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
        {tabs.map((t) => (
          <iframe key={t.key} className="plugin-frame" src={t.src} title={t.label} style={{ display: active === t.key ? 'block' : 'none' }} />
        ))}
      </div>
    )
  }
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
