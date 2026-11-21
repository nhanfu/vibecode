import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database as DbIcon,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sigma,
  Square,
  Table2,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import type { DbColumn, DbConnection, DbFound, DbObject, DbQueryResult, DbResultSet } from '../../../shared/types'
import { useStore } from '../store'
import { editorOptions, monaco } from '../monaco'
import { useEditorFont } from './EditorFont'
import { userStore } from '../localPref'

/* ---------------- small helpers ---------------- */

const LS = {
  get(key: string): string | null {
    try {
      return userStore.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, v: string): void {
    try {
      userStore.setItem(key, v)
    } catch {
      /* storage unavailable */
    }
  }
}

const bracket = (n: string): string => `[${n.replace(/]/g, ']]')}]`
const errText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const NUMERIC = /^(int|bigint|smallint|tinyint|decimal|numeric|money|smallmoney|float|real|bit)$/i

/** server / database / user of a connection string, for showing (never the password). */
function connSummary(conn: string): { server: string; database: string; user: string } {
  const get = (re: RegExp): string => re.exec(conn)?.[2]?.trim().replace(/^["']|["']$/g, '') ?? ''
  return {
    server: get(/(^|;)\s*(?:server|data source|address|addr)\s*=\s*([^;]*)/i),
    database: get(/(^|;)\s*(?:database|initial catalog)\s*=\s*([^;]*)/i),
    user: get(/(^|;)\s*(?:user id|uid|user)\s*=\s*([^;]*)/i)
  }
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  return typeof v === 'string' ? v : JSON.stringify(v)
}

function toCsv(r: DbResultSet): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = cellText(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [r.columns.map((c) => esc(c.name)).join(','), ...r.rows.map((row) => row.map(esc).join(','))].join('\r\n')
}

function toJson(r: DbResultSet): string {
  return JSON.stringify(
    r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name || `col${i + 1}`, row[i]]))),
    null,
    2
  )
}

/* ---------------- the tab ---------------- */

interface DbNode {
  loading?: boolean
  error?: string
  databases?: string[]
}
interface ObjNode {
  loading?: boolean
  error?: string
  objects?: DbObject[]
}

export function DatabasePane(): React.JSX.Element {
  const [conns, setConns] = useState<DbConnection[]>([])
  const [activeId, setActiveId] = useState<string | null>(() => LS.get('vibe.db.active'))
  const [database, setDatabase] = useState<string>(() => LS.get('vibe.db.database') ?? '')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [dbs, setDbs] = useState<Record<string, DbNode>>({})
  const [objs, setObjs] = useState<Record<string, ObjNode>>({})
  const [editing, setEditing] = useState<DbConnection | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  // the SQL text lives in Monaco + this ref, not in state: a keystroke used to re-render the whole
  // tab (tree, results grid) and rewrite the saved layout
  const sqlRef = useRef(activeId ? (LS.get(`vibe.db.sql.${activeId}`) ?? '') : '')
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  const runSeq = useRef(0)
  const [result, setResult] = useState<DbQueryResult | null>(null)
  // each result mounts a fresh Results (its tab / selected cell start over)
  const [resultKey, setResultKey] = useState(0)
  const [maxRows, setMaxRows] = useState(() => Number(LS.get('vibe.db.maxRows')) || 1000)
  const sideLayout = useDefaultLayout({ id: 'vibe-db-side', storage: userStore })
  const splitLayout = useDefaultLayout({ id: 'vibe-db-split', storage: userStore })
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const font = useEditorFont()
  const theme = useStore((s) => (s.themeResolved === 'light' ? 'studio-light' : 'studio-dark'))
  const active = conns.find((c) => c.id === activeId) ?? null
  const sqlOptions = useMemo(
    () => ({ ...editorOptions, ...font, minimap: { enabled: false }, stickyScroll: { enabled: false }, padding: { top: 10, bottom: 10 } }),
    [font]
  )

  const reload = useCallback(async () => {
    const list = await window.api.db.list().catch(() => [] as DbConnection[])
    setConns(list)
    return list
  }, [])

  useEffect(() => {
    reload().then((list) => {
      if (!list.some((c) => c.id === activeId)) setActiveId(list[0]?.id ?? null)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (activeId) LS.set('vibe.db.active', activeId)
  }, [activeId])
  useEffect(() => LS.set('vibe.db.database', database), [database])
  useEffect(() => LS.set('vibe.db.maxRows', String(maxRows)), [maxRows])

  // each connection keeps its own SQL text
  const setSql = (text: string): void => {
    sqlRef.current = text
    const ed = editorRef.current
    if (ed && ed.getValue() !== text) ed.setValue(text)
  }
  const onSqlChange = (v?: string): void => {
    sqlRef.current = v ?? ''
    if (activeId) LS.set(`vibe.db.sql.${activeId}`, sqlRef.current)
  }
  useEffect(() => {
    setSql(activeId ? (LS.get(`vibe.db.sql.${activeId}`) ?? '') : '')
    // a query still running is for the old connection: its rows must not land under this one
    if (runningRef.current) {
      window.api.db.cancel()
      runSeq.current++
      runningRef.current = false
      setRunning(false)
    }
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const loadDbs = useCallback(async (id: string, force = false) => {
    if (!force && dbs[id]?.databases) return dbs[id].databases!
    setDbs((d) => ({ ...d, [id]: { loading: true } }))
    try {
      const list = await window.api.db.databases(id)
      setDbs((d) => ({ ...d, [id]: { databases: list } }))
      return list
    } catch (e) {
      setDbs((d) => ({ ...d, [id]: { error: errText(e) } }))
      return []
    }
  }, [dbs])

  const loadObjs = async (id: string, name: string, force = false): Promise<void> => {
    const key = `${id}/${name}`
    if (!force && objs[key]?.objects) return
    setObjs((o) => ({ ...o, [key]: { loading: true } }))
    try {
      const list = await window.api.db.objects(id, name)
      setObjs((o) => ({ ...o, [key]: { objects: list } }))
    } catch (e) {
      setObjs((o) => ({ ...o, [key]: { error: errText(e) } }))
    }
  }

  // the active connection's databases feed the toolbar picker
  useEffect(() => {
    if (!active) return
    loadDbs(active.id).then((list) => {
      if (database && list.includes(database)) return
      setDatabase(active.database && list.includes(active.database) ? active.database : '')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id])

  const run = useCallback(
    async (text?: string, conn = activeId, db = database) => {
      // a ref, not `running`: two Ctrl+Enter within one frame both passed the state check
      if (!conn || runningRef.current) return
      const ed = editorRef.current
      const sel = ed?.getSelection()
      const picked = !text && ed && sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) : undefined
      const q = (text ?? picked ?? sqlRef.current).trim()
      if (!q) return
      const my = ++runSeq.current
      runningRef.current = true
      setRunning(true)
      let r: DbQueryResult
      try {
        r = await window.api.db.query(conn, q, db || undefined, maxRows)
      } catch (e) {
        r = { ok: false, error: errText(e), results: [], messages: [], affected: -1, ms: 0 }
      }
      // switched connection meanwhile: that run was dropped
      if (my !== runSeq.current) return
      runningRef.current = false
      setRunning(false)
      setResult(r)
      setResultKey((k) => k + 1)
    },
    [activeId, database, maxRows]
  )
  const runRef = useRef(run)
  runRef.current = run

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    if (editor.getValue() !== sqlRef.current) editor.setValue(sqlRef.current)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current())
    editor.addCommand(monaco.KeyCode.F5, () => runRef.current())
  }

  const openTable = (c: DbConnection, db: string, o: DbObject): void => {
    setActiveId(c.id)
    setDatabase(db)
    const name = `${bracket(o.schema)}.${bracket(o.name)}`
    const q = o.type === 'P' ? `EXEC ${name} ` : o.type === 'U' || o.type === 'V' ? `SELECT TOP (100) * FROM ${name};` : `SELECT * FROM ${name}();`
    setSql(q)
    if (o.type === 'U' || o.type === 'V') setTimeout(() => runRef.current(q, c.id, db), 0)
    else setTimeout(() => editorRef.current?.focus(), 0)
  }

  const remove = async (c: DbConnection): Promise<void> => {
    if (!window.confirm(`Remove the connection "${c.name}"?`)) return
    const list = await window.api.db.remove(c.id)
    setConns(list)
    if (activeId === c.id) setActiveId(list[0]?.id ?? null)
  }

  return (
    <>
    <Group orientation="horizontal" className="db-pane" defaultLayout={sideLayout.defaultLayout} onLayoutChanged={sideLayout.onLayoutChanged}>
      <Panel id="side" defaultSize="30%" minSize="16%" maxSize="60%" className="db-side">
        <div className="db-side-head">
          <span>Connections</span>
          <button className="icon-btn" title="Import from SSMS or project files" onClick={() => setImporting(true)}>
            <Download size={14} />
          </button>
          <button className="icon-btn accent" title="New connection" onClick={() => setEditing('new')}>
            <Plus size={15} />
          </button>
        </div>
        <div className="db-tree">
          {conns.length === 0 && (
            <div className="db-empty-side">
              <DbIcon size={22} />
              <p>No connections yet.</p>
              <button className="btn btn-primary btn-sm" onClick={() => setImporting(true)}>
                <Download size={13} /> Import from SSMS / project
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing('new')}>
                <Plus size={13} /> New connection
              </button>
            </div>
          )}
          {conns.map((c) => (
            <ConnNode
              key={c.id}
              conn={c}
              active={c.id === activeId}
              open={!!open[c.id]}
              node={dbs[c.id]}
              objs={objs}
              open2={open}
              onToggle={() => {
                setActiveId(c.id)
                setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))
                if (!open[c.id]) loadDbs(c.id)
              }}
              onToggleDb={(db) => {
                const k = `${c.id}/${db}`
                setOpen((o) => ({ ...o, [k]: !o[k] }))
                if (!open[k]) loadObjs(c.id, db)
              }}
              onRefresh={() => loadDbs(c.id, true)}
              onRefreshDb={(db) => loadObjs(c.id, db, true)}
              onPickDb={(db) => {
                setActiveId(c.id)
                setDatabase(db)
              }}
              onOpen={(db, o) => openTable(c, db, o)}
              onEdit={() => setEditing(c)}
              onRemove={() => remove(c)}
            />
          ))}
        </div>
      </Panel>
      <Separator className="db-resize-v" />

      <Panel id="main" minSize="30%" className="db-main">
        {!active ? (
          <div className="db-placeholder">
            <Server size={28} />
            <h3>SQL Server</h3>
            <p>Connect to a database to browse tables and run queries. Claude can query the same connections from any chat.</p>
            <div className="db-placeholder-actions">
              <button className="btn btn-primary" onClick={() => setImporting(true)}>
                <Download size={14} /> Import from SSMS / project
              </button>
              <button className="btn btn-ghost" onClick={() => setEditing('new')}>
                <Plus size={14} /> New connection
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="db-toolbar">
              <span className="db-conn-pill" title={`${active.server}${active.user ? ` · ${active.user}` : ''}`}>
                <DbIcon size={13} /> {active.name}
              </span>
              <select className="db-select" value={database} onChange={(e) => setDatabase(e.target.value)} title="Database">
                <option value="">{active.database ? `${active.database} (default)` : '(default database)'}</option>
                {(dbs[active.id]?.databases ?? []).filter((d) => d !== active.database).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              {running ? (
                <button className="btn btn-sm db-stop" onClick={() => window.api.db.cancel()}>
                  <Square size={12} /> Stop
                </button>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={() => run()} title="Run the selection, or everything (Ctrl+Enter / F5)">
                  <Play size={12} /> Run <kbd className="db-wide">Ctrl+Enter</kbd>
                </button>
              )}
              <div className="db-toolbar-fill" />
              <label className="db-maxrows" title="Rows to keep per result set">
                <span className="db-wide">Max rows</span>
                <select value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))}>
                  {[100, 1000, 5000, 20000].map((n) => (
                    <option key={n} value={n}>
                      {n.toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              {active.claudeReadOnly && (
                <span className="db-ro" title="Claude's queries on this connection are always rolled back">
                  <ShieldCheck size={13} /> <span className="db-wide">Claude: read-only</span>
                </span>
              )}
            </div>
            <Group orientation="vertical" className="db-split" defaultLayout={splitLayout.defaultLayout} onLayoutChanged={splitLayout.onLayoutChanged}>
              <Panel id="sql" defaultSize="42%" minSize="15%">
                <div className="db-editor">
                  <Editor
                    language="sql"
                    theme={theme}
                    defaultValue={sqlRef.current}
                    onChange={onSqlChange}
                    onMount={onMount}
                    options={sqlOptions}
                  />
                </div>
              </Panel>
              <Separator className="db-resize" />
              <Panel id="results" minSize="15%">
                <Results key={resultKey} result={result} running={running} />
              </Panel>
            </Group>
          </>
        )}
      </Panel>
    </Group>

      {editing && (
        <ConnectionDialog
          conn={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(list, id) => {
            setConns(list)
            setActiveId(id ?? list[list.length - 1]?.id ?? null)
            if (id) setDbs((d) => ({ ...d, [id]: {} }))
            setEditing(null)
          }}
        />
      )}
      {importing && (
        <ImportDialog
          existing={conns}
          onClose={() => setImporting(false)}
          onDone={(list) => {
            setConns(list)
            if (!activeId && list[0]) setActiveId(list[0].id)
            setImporting(false)
          }}
        />
      )}
    </>
  )
}

/* ---------------- tree ---------------- */

const GROUPS: { types: DbObject['type'][]; label: string; icon: React.JSX.Element }[] = [
  { types: ['U'], label: 'Tables', icon: <Table2 size={13} /> },
  { types: ['V'], label: 'Views', icon: <Eye size={13} /> },
  { types: ['P'], label: 'Procedures', icon: <Zap size={13} /> },
  { types: ['FN', 'IF', 'TF'], label: 'Functions', icon: <Sigma size={13} /> }
]

function ConnNode(props: {
  conn: DbConnection
  active: boolean
  open: boolean
  node?: DbNode
  objs: Record<string, ObjNode>
  open2: Record<string, boolean>
  onToggle: () => void
  onToggleDb: (db: string) => void
  onRefresh: () => void
  onRefreshDb: (db: string) => void
  onPickDb: (db: string) => void
  onOpen: (db: string, o: DbObject) => void
  onEdit: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { conn: c, node } = props
  return (
    <div className="db-node">
      <div className={`db-row db-conn${props.active ? ' active' : ''}`} onClick={props.onToggle} title={`${c.server}${c.user ? ` · ${c.user}` : ' · Windows auth'}`}>
        {props.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Server size={14} className="db-conn-icon" />
        <span className="db-row-text">
          <span className="db-row-name">{c.name}</span>
          <span className="db-row-sub">{c.server}</span>
        </span>
        <span className="db-row-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="Refresh" onClick={props.onRefresh}>
            <RefreshCw size={12} />
          </button>
          <button className="icon-btn" title="Edit" onClick={props.onEdit}>
            <Pencil size={12} />
          </button>
          <button className="icon-btn" title="Remove" onClick={props.onRemove}>
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      {props.open && (
        <div className="db-children">
          {node?.loading && <div className="db-note"><Loader2 size={12} className="spin" /> Connecting…</div>}
          {node?.error && <div className="db-note error">{node.error}</div>}
          {node?.databases?.map((db) => (
            <DbNodeView
              key={db}
              conn={c}
              db={db}
              open={!!props.open2[`${c.id}/${db}`]}
              node={props.objs[`${c.id}/${db}`]}
              onToggle={() => {
                props.onPickDb(db)
                props.onToggleDb(db)
              }}
              onRefresh={() => props.onRefreshDb(db)}
              onOpen={(o) => props.onOpen(db, o)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DbNodeView(props: { conn: DbConnection; db: string; open: boolean; node?: ObjNode; onToggle: () => void; onRefresh: () => void; onOpen: (o: DbObject) => void }): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({ Tables: true })
  const [cols, setCols] = useState<Record<string, DbColumn[] | string | null>>({})
  const list = props.node?.objects ?? []
  const f = filter.trim().toLowerCase()
  const shown = f ? list.filter((o) => `${o.schema}.${o.name}`.toLowerCase().includes(f)) : list

  const toggleCols = async (o: DbObject): Promise<void> => {
    const k = `${o.schema}.${o.name}`
    if (cols[k] !== undefined) {
      setCols((c) => {
        const n = { ...c }
        delete n[k]
        return n
      })
      return
    }
    setCols((c) => ({ ...c, [k]: null }))
    try {
      const r = await window.api.db.columns(props.conn.id, props.db, o.schema, o.name)
      setCols((c) => ({ ...c, [k]: r }))
    } catch (e) {
      setCols((c) => ({ ...c, [k]: errText(e) }))
    }
  }

  return (
    <div className="db-node">
      <div className="db-row db-db" onClick={props.onToggle}>
        {props.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <DbIcon size={13} className="db-db-icon" />
        <span className="db-row-name">{props.db}</span>
        <span className="db-row-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="Refresh" onClick={props.onRefresh}>
            <RefreshCw size={12} />
          </button>
        </span>
      </div>
      {props.open && (
        <div className="db-children">
          {props.node?.loading && <div className="db-note"><Loader2 size={12} className="spin" /> Loading…</div>}
          {props.node?.error && <div className="db-note error">{props.node.error}</div>}
          {list.length > 12 && (
            <div className="db-filter">
              <Search size={12} />
              <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              {filter && (
                <button className="icon-btn" onClick={() => setFilter('')}>
                  <X size={11} />
                </button>
              )}
            </div>
          )}
          {props.node?.objects && !list.length && <div className="db-note">No tables.</div>}
          {GROUPS.map((g) => {
            const items = shown.filter((o) => g.types.includes(o.type))
            if (!items.length) return null
            const isOpen = !!f || !!groupOpen[g.label]
            return (
              <div key={g.label} className="db-node">
                <div className="db-row db-group" onClick={() => setGroupOpen((s) => ({ ...s, [g.label]: !s[g.label] }))}>
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="db-row-name">{g.label}</span>
                  <span className="db-count">{items.length}</span>
                </div>
                {isOpen && (
                  <div className="db-children">
                    {items.slice(0, 1500).map((o) => {
                      const k = `${o.schema}.${o.name}`
                      const c = cols[k]
                      const hasCols = o.type === 'U' || o.type === 'V'
                      return (
                        <div key={k} className="db-node">
                          <div className="db-row db-obj" title={o.type === 'U' || o.type === 'V' ? `Show the first 100 rows of ${k}` : k} onClick={() => props.onOpen(o)}>
                            {hasCols ? (
                              <span
                                className="db-twisty"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleCols(o)
                                }}
                              >
                                {c !== undefined ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                              </span>
                            ) : (
                              <span className="db-twisty" />
                            )}
                            {g.icon}
                            <span className="db-row-name">
                              {o.schema !== 'dbo' && <span className="db-schema">{o.schema}.</span>}
                              {o.name}
                            </span>
                          </div>
                          {c !== undefined && (
                            <div className="db-children db-cols">
                              {c === null && <div className="db-note"><Loader2 size={12} className="spin" /></div>}
                              {typeof c === 'string' && <div className="db-note error">{c}</div>}
                              {Array.isArray(c) &&
                                c.map((col) => (
                                  <div key={col.name} className="db-col" title={col.ref ? `→ ${col.ref}` : undefined}>
                                    {col.pk ? <KeyRound size={11} className="db-pk" /> : col.ref ? <Link2 size={11} className="db-fk" /> : <span className="db-col-dot" />}
                                    <span className="db-col-name">{col.name}</span>
                                    <span className="db-col-type">
                                      {col.type}
                                      {col.nullable ? '' : ' not null'}
                                    </span>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ---------------- results ---------------- */

/** Keyed per result by the pane, so a new result starts on its own first tab with nothing selected. */
const Results = memo(function Results({ result, running }: { result: DbQueryResult | null; running: boolean }): React.JSX.Element {
  const [tab, setTab] = useState(() => (result && !result.ok && !result.results.length ? -1 : 0))
  const [copied, setCopied] = useState('')
  const [sel, setSel] = useState<[number, number] | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const copy = useCallback((what: string, text: string): void => {
    navigator.clipboard.writeText(text)
    setCopied(what)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(''), 1200)
  }, [])
  const copyCell = useCallback((v: string) => copy('cell', v), [copy])
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  if (!result)
    return (
      <div className="db-results db-results-empty">
        {running ? (
          <>
            <Loader2 size={18} className="spin" /> Running…
          </>
        ) : (
          <>Results show here. Click a table on the left, or write SQL and press Ctrl+Enter.</>
        )}
      </div>
    )

  const sets = result.results
  const cur = tab >= 0 ? sets[tab] : undefined
  const hasMessages = result.messages.length > 0 || !result.ok || result.affected >= 0

  return (
    <div className="db-results">
      <div className="db-results-bar">
        {sets.map((r, i) => (
          <button key={i} className={`db-rtab${tab === i ? ' on' : ''}`} onClick={() => (setTab(i), setSel(null))}>
            Result {sets.length > 1 ? i + 1 : ''}
            <span className="db-rtab-count">
              {r.rows.length.toLocaleString()}
              {r.truncated ? '+' : ''}
            </span>
          </button>
        ))}
        {hasMessages && (
          <button className={`db-rtab${tab === -1 ? ' on' : ''}${result.ok ? '' : ' error'}`} onClick={() => (setTab(-1), setSel(null))}>
            Messages
          </button>
        )}
        <div className="db-toolbar-fill" />
        {cur && (
          <>
            <button className="chip" onClick={() => copy('csv', toCsv(cur))} title="Copy this result as CSV">
              {copied === 'csv' ? <Check size={12} /> : <Copy size={12} />} CSV
            </button>
            <button className="chip" onClick={() => copy('json', toJson(cur))} title="Copy this result as JSON">
              {copied === 'json' ? <Check size={12} /> : <Copy size={12} />} JSON
            </button>
          </>
        )}
        <span className={`db-status${result.ok ? '' : ' error'}`}>
          {running ? (
            <>
              <Loader2 size={12} className="spin" /> Running…
            </>
          ) : result.ok ? (
            <>
              <Check size={12} />
              {cur ? `${cur.rows.length.toLocaleString()} row${cur.rows.length === 1 ? '' : 's'}${cur.truncated ? ' (limit reached)' : ''}` : result.affected >= 0 ? `${result.affected} affected` : 'Done'}
              {' · '}
              {result.ms} ms
            </>
          ) : (
            <>
              <X size={12} /> Error · {result.ms} ms
            </>
          )}
        </span>
      </div>
      {tab === -1 || !cur ? (
        <div className="db-messages">
          {!result.ok && <pre className="db-error">{result.error}</pre>}
          {result.messages.map((m, i) => (
            <pre key={i}>{m}</pre>
          ))}
          {result.affected >= 0 && <pre>({result.affected} row{result.affected === 1 ? '' : 's'} affected)</pre>}
          {result.ok && !result.messages.length && result.affected < 0 && !sets.length && <pre>Commands completed successfully.</pre>}
        </div>
      ) : (
        <Grid
          key={tab}
          set={cur}
          sel={sel}
          onSel={setSel}
          onCopyCell={copyCell}
        />
      )}
    </div>
  )
})

/** results grid: row height (keep in step with `.db-grid.virtual` in styles.css), row-number column width */
const ROW_H = 22
const RN_W = 52
const CHUNK = 20
/** above this many rows the grid renders only what's in view */
const VIRTUAL_MIN = 300

/** Column widths from the header and a sample of the values (monospace 12px ≈ 7.3px a character). */
function columnWidths(set: DbResultSet): number[] {
  const sample = set.rows.length > 1000 ? set.rows.slice(0, 1000) : set.rows
  return set.columns.map((c, i) => {
    let chars = (c.name || '(no name)').length + c.type.length * 0.75 + 1
    for (const row of sample) {
      const len = Math.min(48, cellText(row[i]).length)
      if (len > chars) chars = len
    }
    return Math.round(Math.min(360, Math.max(56, chars * 7.3 + 22)))
  })
}

function Grid({ set, sel, onSel, onCopyCell }: { set: DbResultSet; sel: [number, number] | null; onSel: (s: [number, number] | null) => void; onCopyCell: (v: string) => void }): React.JSX.Element {
  const numeric = useMemo(() => set.columns.map((c) => NUMERIC.test(c.type)), [set])
  const n = set.rows.length
  // Big results render only the rows in view (plus a margin): 20k rows × every column used to be
  // laid out up front and froze the tab. Rows have a fixed height (CSS), and columns fixed widths
  // estimated from their text, so nothing shifts while scrolling.
  const virtual = n > VIRTUAL_MIN
  const widths = useMemo(() => (virtual ? columnWidths(set) : null), [virtual, set])
  const wrapRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState<[number, number]>([0, Math.min(n, 120)])
  // the real row height (CSS asks for ROW_H; measured so the spacers can never drift from it)
  const [rowH, setRowH] = useState(ROW_H)
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!virtual || !el) return
    const tr = el.querySelector<HTMLElement>('tbody tr:not([aria-hidden])')
    if (tr && tr.offsetHeight && tr.offsetHeight !== rowH) return setRowH(tr.offsetHeight)
    let raf = 0
    const update = (): void => {
      raf = 0
      // whole chunks, so a scroll of a row or two doesn't re-render the window
      const first = Math.max(0, Math.floor(el.scrollTop / rowH / CHUNK) * CHUNK - CHUNK)
      const last = Math.min(n, (Math.ceil((el.scrollTop + el.clientHeight) / rowH / CHUNK) + 1) * CHUNK)
      setRange((r) => (r[0] === first && r[1] === last ? r : [first, last]))
    }
    const soon = (): void => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    el.addEventListener('scroll', soon, { passive: true })
    const ro = new ResizeObserver(soon)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', soon)
      ro.disconnect()
    }
  }, [virtual, n, rowH])
  const [from, to] = virtual ? range : [0, n]
  const spacer = (h: number): React.JSX.Element | null =>
    h > 0 ? (
      <tr aria-hidden>
        <td className="db-spacer" colSpan={set.columns.length + 1} style={{ height: h }} />
      </tr>
    ) : null
  return (
    <div
      ref={wrapRef}
      className="db-grid-wrap"
      tabIndex={0}
      onKeyDown={(e) => {
        if (sel && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
          e.preventDefault()
          onCopyCell(cellText(set.rows[sel[0]][sel[1]]))
        }
      }}
    >
      <table className={`db-grid${virtual ? ' virtual' : ''}`} style={widths ? { width: widths.reduce((a, b) => a + b, RN_W) } : undefined}>
        {widths && (
          <colgroup>
            <col style={{ width: RN_W }} />
            {widths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            <th className="db-rn">#</th>
            {set.columns.map((c, i) => (
              <th key={i} title={c.type}>
                {c.name || <i>(no name)</i>}
                <span className="db-th-type">{c.type}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spacer(from * rowH)}
          {set.rows.slice(from, to).map((row, i) => {
            const r = from + i
            return <GridRow key={r} row={row} r={r} selCol={sel && sel[0] === r ? sel[1] : -1} numeric={numeric} onSel={onSel} onCopyCell={onCopyCell} />
          })}
          {spacer((n - to) * rowH)}
        </tbody>
      </table>
      {set.rows.length === 0 && <div className="db-grid-empty">No rows.</div>}
    </div>
  )
}

/** One row; memoized so selecting a cell re-renders only the rows it leaves and enters (results go up to 20k rows). */
const GridRow = memo(function GridRow(props: {
  row: unknown[]
  r: number
  selCol: number
  numeric: boolean[]
  onSel: (s: [number, number]) => void
  onCopyCell: (v: string) => void
}): React.JSX.Element {
  const { row, r, selCol, numeric, onSel, onCopyCell } = props
  return (
    <tr>
      <td className="db-rn">{r + 1}</td>
      {row.map((v, c) => {
        const t = cellText(v)
        return (
          <td
            key={c}
            className={`${v === null ? 'null ' : ''}${numeric[c] ? 'num ' : ''}${c === selCol ? 'sel' : ''}`}
            title={t.length > 40 ? t.slice(0, 2000) : undefined}
            onClick={() => onSel([r, c])}
            onDoubleClick={() => onCopyCell(t)}
          >
            {t.length > 300 ? t.slice(0, 300) + '…' : t}
          </td>
        )
      })}
    </tr>
  )
})

/* ---------------- add / edit connection ---------------- */

function ConnectionDialog({ conn, onClose, onSaved }: { conn: DbConnection | null; onClose: () => void; onSaved: (list: DbConnection[], id?: string) => void }): React.JSX.Element {
  const [name, setName] = useState(conn?.name ?? '')
  const [mode, setMode] = useState<'fields' | 'string'>('fields')
  const [server, setServer] = useState('')
  const [windowsAuth, setWindowsAuth] = useState(false)
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [database, setDatabase] = useState('')
  const [trustCert, setTrustCert] = useState(true)
  const [encrypt, setEncrypt] = useState(false)
  const [connStr, setConnStr] = useState('')
  const [readOnly, setReadOnly] = useState(conn?.claudeReadOnly ?? true)
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; text?: string }>({})
  const [saving, setSaving] = useState(false)

  const fillFrom = async (cs: string): Promise<void> => {
    const kv = await window.api.db.parseConn(cs)
    const g = (...k: string[]): string => k.map((x) => kv[x]).find((x) => x !== undefined) ?? ''
    setServer(g('server', 'data source', 'address', 'addr', 'network address'))
    setDatabase(g('database', 'initial catalog'))
    setWindowsAuth(/^(true|yes|sspi)$/i.test(g('integrated security', 'trusted_connection')))
    setUser(g('user id', 'uid', 'user'))
    setPassword(g('password', 'pwd'))
    setTrustCert(!/^(false|no)$/i.test(g('trustservercertificate', 'trust server certificate') || 'true'))
    setEncrypt(/^(true|yes|mandatory|strict)$/i.test(g('encrypt')))
    // anything the fields can't show: keep editing it as a string
    const known = new Set(['server', 'data source', 'address', 'addr', 'network address', 'database', 'initial catalog', 'integrated security', 'trusted_connection', 'user id', 'uid', 'user', 'password', 'pwd', 'trustservercertificate', 'trust server certificate', 'encrypt'])
    if (Object.keys(kv).some((k) => !known.has(k))) setMode('string')
  }

  useEffect(() => {
    if (!conn) return
    window.api.db.get(conn.id).then((c) => {
      if (!c) return
      setConnStr(c.conn)
      fillFrom(c.conn).catch(() => setMode('string'))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id])

  const current = async (): Promise<string> =>
    mode === 'string' ? connStr.trim() : window.api.db.buildConn({ server: server.trim(), database: database.trim(), windowsAuth, user: user.trim(), password, trustCert, encrypt })

  const switchMode = async (m: 'fields' | 'string'): Promise<void> => {
    if (m === mode) return
    if (m === 'string') setConnStr(await current())
    else await fillFrom(connStr)
    setMode(m)
  }

  const doTest = async (): Promise<void> => {
    setTest({ busy: true })
    try {
      const r = await window.api.db.test(await current())
      setTest({ ok: r.ok, text: r.ok ? r.version : r.error })
    } catch (e) {
      setTest({ ok: false, text: errText(e) })
    }
  }

  const save = async (): Promise<void> => {
    const cs = await current()
    if (!cs || (mode === 'fields' && !server.trim())) return
    setSaving(true)
    const fallback = connSummary(cs)
    try {
      const list = await window.api.db.save({ id: conn?.id, name: name.trim() || fallback.database || fallback.server, conn: cs, claudeReadOnly: readOnly })
      onSaved(list, conn?.id ?? list[list.length - 1]?.id)
    } catch (e) {
      // the button used to stay disabled for good, with no word of what went wrong
      setTest({ ok: false, text: errText(e) })
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="db-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="db-dialog-head">
          <Server size={16} />
          <span>{conn ? 'Edit connection' : 'New SQL Server connection'}</span>
          <button className="icon-btn" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="db-dialog-body">
          <label className="db-field">
            <span>Name</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. TMS dev" />
          </label>
          <div className="seg db-mode">
            <button className={mode === 'fields' ? 'on' : ''} onClick={() => switchMode('fields')}>
              Connection properties
            </button>
            <button className={mode === 'string' ? 'on' : ''} onClick={() => switchMode('string')}>
              Connection string
            </button>
          </div>
          {mode === 'fields' ? (
            <>
              <label className="db-field">
                <span>Server name</span>
                <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="host,port   or   (localdb)\MSSQLLocalDB" spellCheck={false} />
              </label>
              <label className="db-field">
                <span>Authentication</span>
                <select value={windowsAuth ? 'win' : 'sql'} onChange={(e) => setWindowsAuth(e.target.value === 'win')}>
                  <option value="sql">SQL Server Authentication</option>
                  <option value="win">Windows Authentication</option>
                </select>
              </label>
              {!windowsAuth && (
                <>
                  <label className="db-field">
                    <span>User name</span>
                    <input value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} autoComplete="off" />
                  </label>
                  <label className="db-field">
                    <span>Password</span>
                    <span className="db-pwd">
                      <input type={showPwd ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                      <button className="icon-btn" type="button" title={showPwd ? 'Hide' : 'Show'} onClick={() => setShowPwd(!showPwd)}>
                        {showPwd ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    </span>
                  </label>
                </>
              )}
              <label className="db-field">
                <span>Database</span>
                <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="<default>" spellCheck={false} />
              </label>
              <div className="db-checks">
                <label>
                  <input type="checkbox" checked={trustCert} onChange={(e) => setTrustCert(e.target.checked)} /> Trust server certificate
                </label>
                <label>
                  <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} /> Encrypt
                </label>
              </div>
            </>
          ) : (
            <label className="db-field">
              <span>Connection string</span>
              <textarea
                value={connStr}
                onChange={(e) => setConnStr(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder="Server=host,1433;Database=mydb;User ID=sa;Password=...;TrustServerCertificate=True"
              />
            </label>
          )}
          <label className="db-claude-ro">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            <span>
              <b>Claude: read-only</b>
              <small>Claude's queries run inside a transaction that is always rolled back. Your own queries here are not affected.</small>
            </span>
          </label>
          {(test.busy || test.text) && (
            <div className={`db-test${test.busy ? '' : test.ok ? ' ok' : ' error'}`}>
              {test.busy ? <Loader2 size={13} className="spin" /> : test.ok ? <Check size={13} /> : <X size={13} />}
              <span>{test.busy ? 'Connecting…' : test.text}</span>
            </div>
          )}
        </div>
        <div className="db-dialog-foot">
          <button className="btn btn-ghost btn-sm" onClick={doTest} disabled={test.busy}>
            Test connection
          </button>
          <div className="db-toolbar-fill" />
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || (mode === 'fields' ? !server.trim() : !connStr.trim())}>
            {conn ? 'Save' : 'Add connection'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- import from SSMS / project ---------------- */

function ImportDialog({ existing, onClose, onDone }: { existing: DbConnection[]; onClose: () => void; onDone: (list: DbConnection[]) => void }): React.JSX.Element {
  const folder = useStore((s) => s.chats.find((c) => c.id === s.activeChatId)?.cwd ?? s.root ?? '')
  const [source, setSource] = useState<'ssms' | 'project'>('ssms')
  const [found, setFound] = useState<Record<string, { busy?: boolean; error?: string; items?: DbFound[] }>>({})
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)

  const have = useMemo(
    () => new Set(existing.map((c) => `${c.server}|${c.database}|${c.user}`.toLowerCase())),
    [existing]
  )
  const keyOf = (f: DbFound): string => {
    const s = connSummary(f.conn)
    return `${s.server}|${s.database}|${s.user}`.toLowerCase()
  }

  useEffect(() => {
    if (found[source]) return
    setFound((f) => ({ ...f, [source]: { busy: true } }))
    const p = source === 'ssms' ? window.api.db.scanSsms() : window.api.db.scanProject(folder)
    p.then((items) => setFound((f) => ({ ...f, [source]: { items } }))).catch((e) => setFound((f) => ({ ...f, [source]: { error: errText(e) } })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  const cur = found[source]
  const q = filter.trim().toLowerCase()
  const items = (cur?.items ?? []).filter((f) => !q || `${f.name} ${connSummary(f.conn).server} ${f.file}`.toLowerCase().includes(q))
  const id = (f: DbFound): string => `${source}:${f.file}:${f.name}:${f.conn.length}`
  const addable = items.filter((f) => !have.has(keyOf(f)))

  const add = async (): Promise<void> => {
    const all = [...(found.ssms?.items ?? []).map((f) => ({ f, s: 'ssms' })), ...(found.project?.items ?? []).map((f) => ({ f, s: 'project' }))]
    const list = all.filter(({ f, s }) => picked.has(`${s}:${f.file}:${f.name}:${f.conn.length}`)).map(({ f }) => f)
    if (!list.length) return
    setSaving(true)
    try {
      onDone(await window.api.db.saveMany(list.map((f) => ({ name: f.name, conn: f.conn, claudeReadOnly: true }))))
    } catch (e) {
      setSaving(false)
      window.alert(errText(e))
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="db-dialog db-import" onMouseDown={(e) => e.stopPropagation()}>
        <div className="db-dialog-head">
          <Download size={16} />
          <span>Import connections</span>
          <button className="icon-btn" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="db-dialog-body">
          <div className="seg db-mode">
            <button className={source === 'ssms' ? 'on' : ''} onClick={() => setSource('ssms')}>
              SQL Server Management Studio
            </button>
            <button className={source === 'project' ? 'on' : ''} onClick={() => setSource('project')}>
              Project files
            </button>
          </div>
          <p className="db-import-hint">
            {source === 'ssms'
              ? 'Recent connections saved in SSMS, with the passwords SSMS remembered (from Windows Credential Manager).'
              : `Connection strings in appsettings*.json, *.config and .env files under ${folder || '(no folder open)'}.`}
          </p>
          <div className="db-filter db-import-filter">
            <Search size={12} />
            <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {addable.length > 0 && (
              <button
                className="db-link"
                onClick={() =>
                  setPicked((p) => {
                    const n = new Set(p)
                    const allOn = addable.every((f) => n.has(id(f)))
                    for (const f of addable) allOn ? n.delete(id(f)) : n.add(id(f))
                    return n
                  })
                }
              >
                {addable.every((f) => picked.has(id(f))) ? 'Select none' : 'Select all'}
              </button>
            )}
          </div>
          <div className="db-import-list">
            {cur?.busy && <div className="db-note"><Loader2 size={13} className="spin" /> Looking…</div>}
            {cur?.error && <div className="db-note error">{cur.error}</div>}
            {cur?.items && !items.length && <div className="db-note">Nothing found.</div>}
            {items.map((f) => {
              const s = connSummary(f.conn)
              const added = have.has(keyOf(f))
              const on = picked.has(id(f))
              return (
                <label key={id(f)} className={`db-import-row${added ? ' added' : ''}${on ? ' on' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={added}
                    checked={added || on}
                    onChange={() =>
                      setPicked((p) => {
                        const n = new Set(p)
                        on ? n.delete(id(f)) : n.add(id(f))
                        return n
                      })
                    }
                  />
                  <Server size={14} className="db-conn-icon" />
                  <span className="db-row-text">
                    <span className="db-row-name">{f.name}</span>
                    <span className="db-row-sub">
                      {s.server}
                      {s.database ? ` / ${s.database}` : ''}
                      {s.user ? ` · ${s.user}` : /integrated security|trusted_connection/i.test(f.conn) ? ' · Windows auth' : ''}
                    </span>
                  </span>
                  <span className="db-import-tags">
                    {added && <span className="db-tag">added</span>}
                    {f.needsPassword && <span className="db-tag warn" title="SSMS has no saved password for this login — edit the connection after importing">no password</span>}
                    <span className="db-tag dim" title={f.file}>{f.file.length > 28 ? '…' + f.file.slice(-27) : f.file}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </div>
        <div className="db-dialog-foot">
          <span className="db-import-note">
            <ShieldCheck size={13} /> Imported as read-only for Claude · passwords stored encrypted (Windows DPAPI)
          </span>
          <div className="db-toolbar-fill" />
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={add} disabled={!picked.size || saving}>
            Add {picked.size || ''} connection{picked.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}
