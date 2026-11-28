import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ExternalLink, FolderOpen, RefreshCw, ScrollText } from 'lucide-react'
import { loadPlugins } from '../actions'
import { openFileDialog } from '../nativeBridge'
import { panelShown, useStore } from '../store'
import type { PluginInfo, PluginOffer } from '../../../shared/types'
import { PluginPane } from './PluginPane'

/**
 * The Plugins panel: what is installed (start / stop, turn off, autostart, logs, remove), what the
 * registry offers (install, update) and installing from a folder, an archive or a link. The work is
 * done in src-tauri/src/plugins.rs; see docs/plugins.md.
 */

type Notice = { kind: 'ok' | 'bad'; text: string } | null

const STATUS_LABEL: Record<PluginInfo['status'], string> = {
  running: 'Running',
  starting: 'Starting…',
  stopped: 'Stopped',
  error: 'Failed',
  disabled: 'Off',
  unavailable: 'Not available',
  ready: 'Ready'
}

const SOURCE_LABEL: Record<PluginInfo['source'], string> = { bundled: 'Bundled', user: 'Installed', dev: 'Development' }

/** `1.2.10` is newer than `1.2.9`. */
function newer(a: string, b: string): boolean {
  const parts = (v: string): number[] => v.replace(/^v/, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

const isLink = (s: string): boolean => /^https?:\/\//i.test(s.trim())

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Installing runs a program from somewhere: ask, naming where. */
function confirmInstall(what: string, from: string, verified: boolean): boolean {
  return window.confirm(
    `Install ${what}${from ? ` from ${from}` : ''}?\n\nA plugin is a program that runs on this computer with your permissions. Only install plugins you trust.` +
      (verified ? '' : '\n\nNo checksum was given, so the download cannot be verified.')
  )
}

export function PluginManager(): React.JSX.Element {
  const plugins = useStore((s) => s.plugins)
  const shown = useStore((s) => panelShown(s, 'plugins'))
  const [tab, setTab] = useState<'installed' | 'browse'>('installed')
  const [page, setPage] = useState<PluginInfo | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())

  // statuses change by themselves (a sidecar starts, exits): look again while the panel is on screen
  useEffect(() => {
    if (!shown) return
    void loadPlugins()
    const t = window.setInterval(() => void loadPlugins(), 2000)
    return () => window.clearInterval(t)
  }, [shown])

  const run = useCallback(async (id: string, job: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy((b) => new Set(b).add(id))
    setNotice(null)
    try {
      await job()
      if (done) setNotice({ kind: 'ok', text: done })
      return true
    } catch (e) {
      setNotice({ kind: 'bad', text: String(e) })
      return false
    } finally {
      await loadPlugins()
      setBusy((b) => {
        const n = new Set(b)
        n.delete(id)
        return n
      })
    }
  }, [])

  if (page) {
    const live = plugins.find((p) => p.id === page.id)
    return (
      <div className="pm pm-page">
        <div className="pm-bar">
          <button className="pm-back" onClick={() => setPage(null)}>
            <ArrowLeft size={13} /> Plugins
          </button>
          <b>{page.name}</b>
        </div>
        <div className="pm-frame">{live?.enabled ? <PluginPane id={page.id} name={page.name} /> : <p className="pm-empty">{page.name} is off.</p>}</div>
      </div>
    )
  }

  return (
    <div className="pm">
      <div className="pm-tabs">
        <button className={tab === 'installed' ? 'on' : ''} onClick={() => setTab('installed')}>
          Installed <span className="pm-count">{plugins.length}</span>
        </button>
        <button className={tab === 'browse' ? 'on' : ''} onClick={() => setTab('browse')}>
          Browse
        </button>
      </div>
      <InstallBar run={run} onInstalled={() => setTab('installed')} />
      {notice && (
        <div className={`pm-notice ${notice.kind}`} onClick={() => setNotice(null)} title="Click to dismiss">
          {notice.text}
        </div>
      )}
      <div className="pm-body">
        {tab === 'installed' ? (
          plugins.length === 0 ? (
            <p className="pm-empty">No plugins yet. Install one from a folder, an archive or a link above, or look in Browse.</p>
          ) : (
            plugins.map((p) => <PluginCard key={p.id} p={p} busy={busy.has(p.id)} run={run} open={() => setPage(p)} />)
          )
        ) : (
          <Browse plugins={plugins} busy={busy} run={run} />
        )}
      </div>
    </div>
  )
}

type Run = (id: string, job: () => Promise<unknown>, done?: string) => Promise<boolean>

/** A folder, an archive file or a link; for a link, an optional SHA-256 to check the download against. */
function InstallBar({ run, onInstalled }: { run: Run; onInstalled: () => void }): React.JSX.Element {
  const [source, setSource] = useState('')
  const [sha, setSha] = useState('')
  const link = isLink(source)
  const input = useRef<HTMLInputElement>(null)

  const install = async (): Promise<void> => {
    const src = source.trim()
    if (!src) return input.current?.focus()
    const checksum = link ? sha.trim() : ''
    if (!confirmInstall('this plugin', link ? hostOf(src) : src, !link || !!checksum)) return
    if (await run('_install', () => window.api.plugins.install(src, checksum || null), 'Installed.')) {
      setSource('')
      setSha('')
      onInstalled()
    }
  }
  const choose = async (): Promise<void> => {
    const dir = await openFileDialog({ title: 'Install a plugin folder', allowDirectories: true }).catch(() => null)
    if (dir?.[0]) setSource(dir[0])
  }

  return (
    <div className="pm-install">
      <div className="pm-row">
        <input
          ref={input}
          className="pm-input"
          placeholder="Folder, .zip / .tar.gz file, or https link"
          value={source}
          spellCheck={false}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void install()}
        />
        <button className="pm-btn" title="Choose a folder" onClick={() => void choose()}>
          <FolderOpen size={13} />
        </button>
        <button className="pm-btn primary" onClick={() => void install()} disabled={!source.trim()}>
          <Download size={13} /> Install
        </button>
      </div>
      {link && <input className="pm-input" placeholder="SHA-256 of the download (optional, recommended)" value={sha} spellCheck={false} onChange={(e) => setSha(e.target.value)} />}
    </div>
  )
}

function PluginCard({ p, busy, run, open }: { p: PluginInfo; busy: boolean; run: Run; open: () => void }): React.JSX.Element {
  const [logs, setLogs] = useState(false)
  const [more, setMore] = useState(false)
  const api = window.api.plugins
  const canOpen = p.enabled && p.available && p.hasSidecar
  const live = p.status === 'running' || p.status === 'starting'

  const remove = async (): Promise<void> => {
    if (p.source !== 'user') {
      // shipped or development: only hidden from the app, its files stay
      if (!window.confirm(`Remove ${p.name} from the app? Its files are kept; installing it again brings it back.`)) return
      await run(p.id, () => api.uninstall(p.id, false), `${p.name} removed.`)
      return
    }
    if (!window.confirm(`Remove ${p.name}?`)) return
    const purge = window.confirm(`Also delete the data ${p.name} saved (its settings, connections, databases)?\n\nOK deletes it, Cancel keeps it.`)
    await run(p.id, () => api.uninstall(p.id, purge), `${p.name} removed.`)
  }

  return (
    <div className={`pm-card${p.enabled ? '' : ' off'}`}>
      <div className="pm-head">
        <span className={`pm-dot ${p.status}`} />
        <div className="pm-title">
          <b>{p.name}</b>
          <span className="pm-ver">{p.version && `v${p.version}`}</span>
          <span className={`pm-badge ${p.source}`}>{SOURCE_LABEL[p.source]}</span>
          {p.overrides && <span className="pm-badge" title="Hides a copy of this plugin found in another folder">overrides another copy</span>}
        </div>
        <span className={`pm-status ${p.status}`}>{STATUS_LABEL[p.status]}</span>
      </div>
      {p.description && <div className="pm-desc">{p.description}</div>}
      {p.error && <div className="pm-error">{p.error}</div>}
      <div className="pm-actions">
        {canOpen && (
          <button
            className="pm-btn primary"
            disabled={busy}
            onClick={open}
            title="Open its page here"
          >
            <ExternalLink size={13} /> Open
          </button>
        )}
        {p.hasSidecar && p.enabled && p.available && (
          <>
            {live ? (
              <button className="pm-btn" disabled={busy} onClick={() => void run(p.id, () => api.stop(p.id))}>
                Stop
              </button>
            ) : (
              <button className="pm-btn" disabled={busy} onClick={() => void run(p.id, () => api.restart(p.id))}>
                Start
              </button>
            )}
            {live && (
              <button className="pm-btn" disabled={busy} title="Stop and start again" onClick={() => void run(p.id, () => api.restart(p.id))}>
                <RefreshCw size={13} /> Restart
              </button>
            )}
          </>
        )}
        <button className="pm-btn" disabled={busy} onClick={() => void run(p.id, () => api.set(p.id, { enabled: !p.enabled }))}>
          {p.enabled ? 'Turn off' : 'Turn on'}
        </button>
        {p.hasSidecar && (
          <button className={`pm-btn${logs ? ' on' : ''}`} onClick={() => setLogs((v) => !v)} title="What it printed">
            <ScrollText size={13} /> Logs
          </button>
        )}
        <button className={`pm-btn${more ? ' on' : ''}`} onClick={() => setMore((v) => !v)}>
          Details
        </button>
        <button className="pm-btn danger" disabled={busy} onClick={() => void remove()}>
          Remove
        </button>
      </div>
      {more && (
        <div className="pm-more">
          <dl>
            {p.license && (
              <>
                <dt>License</dt>
                <dd>{p.license}</dd>
              </>
            )}
            {p.homepage && (
              <>
                <dt>Homepage</dt>
                <dd>
                  <a
                    href={p.homepage}
                    onClick={(e) => {
                      e.preventDefault()
                      void window.api.app.openExternal(p.homepage)
                    }}
                  >
                    {p.homepage}
                  </a>
                </dd>
              </>
            )}
            {p.panel && (
              <>
                <dt>Panel</dt>
                <dd>{p.panel.title}</dd>
              </>
            )}
            {p.mcpName && (
              <>
                <dt>MCP server</dt>
                <dd>{p.mcpName} (MCP server)</dd>
              </>
            )}
            {p.platforms.length > 0 && (
              <>
                <dt>Systems</dt>
                <dd>{p.platforms.join(', ')}</dd>
              </>
            )}
            {p.port && (
              <>
                <dt>Port</dt>
                <dd>127.0.0.1:{p.port}</dd>
              </>
            )}
          </dl>
          {p.hasSidecar && (
            <label className="pm-check">
              <input type="checkbox" checked={p.autostart} disabled={busy} onChange={(e) => void run(p.id, () => api.set(p.id, { autostart: e.target.checked }))} />
              Start with the app
            </label>
          )}
        </div>
      )}
      {logs && <Logs id={p.id} />}
    </div>
  )
}

function Logs({ id }: { id: string }): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => {
    let off = false
    const pull = (): void => {
      window.api.plugins.logs(id).then((l) => !off && setLines(l), () => {})
    }
    pull()
    const t = window.setInterval(pull, 1500)
    return () => {
      off = true
      window.clearInterval(t)
    }
  }, [id])
  // stay at the bottom while new lines arrive, unless scrolled up to read
  useEffect(() => {
    const el = box.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 40) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <pre ref={box} className="pm-logs">
      {lines.length ? lines.join('\n') : 'Nothing printed yet.'}
    </pre>
  )
}

function Browse({ plugins, busy, run }: { plugins: PluginInfo[]; busy: Set<string>; run: Run }): React.JSX.Element {
  const [offers, setOffers] = useState<PluginOffer[] | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [edit, setEdit] = useState(false)
  const [draft, setDraft] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let off = false
    setError(null)
    setOffers(null)
    window.api.plugins.registry().then(
      (r) => {
        if (off) return
        setOffers(r.entries)
        setUrl(r.url)
      },
      (e) => {
        if (off) return
        setError(String(e))
        window.api.plugins.registryUrl().then((u) => !off && setUrl(u), () => {})
      }
    )
    return () => {
      off = true
    }
  }, [attempt])

  const saveUrl = async (): Promise<void> => {
    await window.api.plugins.registryUrl(draft).catch(() => {})
    setEdit(false)
    setAttempt((n) => n + 1)
  }

  return (
    <>
      <div className="pm-registry">
        <span title={url}>Registry: {url ? hostOf(url) : '…'}</span>
        <button className="pm-link" onClick={() => (setDraft(url), setEdit((v) => !v))}>
          change
        </button>
        <button className="pm-link" onClick={() => setAttempt((n) => n + 1)}>
          refresh
        </button>
      </div>
      {edit && (
        <div className="pm-row pm-pad">
          <input className="pm-input" value={draft} placeholder="https://…/index.json (empty: the default)" spellCheck={false} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void saveUrl()} />
          <button className="pm-btn primary" onClick={() => void saveUrl()}>
            Save
          </button>
        </div>
      )}
      {error && <p className="pm-empty">{error}</p>}
      {!error && offers === null && <p className="pm-empty">Loading…</p>}
      {offers?.length === 0 && <p className="pm-empty">The registry has no plugins yet.</p>}
      {offers?.map((o) => {
        const have = plugins.find((p) => p.id === o.id)
        const update = have && o.version && newer(o.version, have.version)
        return (
          <div key={o.id} className="pm-card">
            <div className="pm-head">
              <div className="pm-title">
                <b>{o.name}</b>
                <span className="pm-ver">{o.version && `v${o.version}`}</span>
                {o.license && <span className="pm-badge">{o.license}</span>}
              </div>
              {have && !update && <span className="pm-status running">Installed</span>}
            </div>
            {o.description && <div className="pm-desc">{o.description}</div>}
            {!o.compatible && <div className="pm-error">Not for this system or app version{o.platforms.length ? ` (${o.platforms.join(', ')})` : ''}.</div>}
            {!o.sha256 && <div className="pm-warn">No checksum in the registry: the download cannot be verified.</div>}
            <div className="pm-actions">
              {(!have || update) && (
                <button
                  className="pm-btn primary"
                  disabled={!o.compatible || busy.has(o.id)}
                  onClick={() => {
                    if (!confirmInstall(`${o.name}${o.version ? ` ${o.version}` : ''}`, hostOf(o.url), !!o.sha256)) return
                    void run(o.id, () => window.api.plugins.install(o.url, o.sha256), `${o.name} ${update ? 'updated' : 'installed'}.`)
                  }}
                >
                  <Download size={13} /> {update ? `Update to v${o.version}` : 'Install'}
                </button>
              )}
              {o.homepage && (
                <button className="pm-btn" onClick={() => void window.api.app.openExternal(o.homepage)}>
                  Homepage
                </button>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
