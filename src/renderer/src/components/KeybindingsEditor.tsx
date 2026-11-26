import { useEffect, useMemo, useState } from 'react'
import { Copy, FileText, Pencil, Plus, RotateCcw, Search, X } from 'lucide-react'
import { keyLabel, pressOf } from '../keybindings'
import { openFile } from '../actions'
import { COMMANDS, allBindings, shortcutRecording, userRules, writeKeybindings, type Command } from '../shortcuts'

interface Row {
  uid: string
  cmd: Command
  key?: string
  when?: string
  user: boolean
}

type Sort = 'command' | 'key' | 'when' | 'source'

/** Every binding as its own row, and one row for each command that has none. */
function buildRows(): Row[] {
  const rows: Row[] = []
  const bound = new Set<string>()
  for (const b of allBindings()) {
    const cmd = COMMANDS.find((c) => c.id === b.command)
    if (!cmd) continue
    bound.add(cmd.id)
    rows.push({ uid: `${b.command}|${b.key}|${b.when ?? ''}|${b.user}`, cmd, key: b.key, when: b.when, user: b.user })
  }
  for (const cmd of COMMANDS) if (!bound.has(cmd.id)) rows.push({ uid: `${cmd.id}|none`, cmd, user: false })
  return rows
}

/** Filter words: @source:user|default, @command:…, @key:…, @when:…; anything else matches name, id, key or when. */
function matches(row: Row, query: string): boolean {
  for (const t of query.trim().split(/\s+/).filter(Boolean)) {
    const lower = t.toLowerCase()
    if (lower.startsWith('@source:')) {
      const want = lower.slice(8)
      if (want && (row.user ? 'user' : 'default') !== want) return false
    } else if (lower.startsWith('@command:')) {
      if (!`${row.cmd.id} ${row.cmd.label}`.toLowerCase().includes(lower.slice(9))) return false
    } else if (lower.startsWith('@key:')) {
      if (!(row.key ? keyLabel(row.key) : '').toLowerCase().includes(lower.slice(5))) return false
    } else if (lower.startsWith('@when:')) {
      if (!(row.when ?? '').toLowerCase().includes(lower.slice(6))) return false
    } else {
      const hay = `${row.cmd.label} ${row.cmd.id} ${row.key ? keyLabel(row.key) : ''} ${row.when ?? ''}`.toLowerCase()
      if (!hay.includes(lower)) return false
    }
  }
  return true
}

function sortValue(row: Row, by: Sort): string {
  if (by === 'command') return row.cmd.label.toLowerCase()
  if (by === 'key') return row.key ? keyLabel(row.key).toLowerCase() : '￿'
  if (by === 'when') return row.when ?? '￿'
  return row.user ? 'user' : 'default'
}

export function KeybindingsEditor(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ by: Sort; asc: boolean }>({ by: 'command', asc: true })
  // a row being given a key: the command, and the binding it replaces (none = a new one)
  const [recording, setRecording] = useState<{ cmd: string; replaces?: { key: string; when?: string } } | null>(null)
  const [whenEdit, setWhenEdit] = useState<{ uid: string; value: string } | null>(null)
  const [note, setNote] = useState('')
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const show = (): void => setOpen(true)
    window.addEventListener('open-keybindings', show)
    return () => window.removeEventListener('open-keybindings', show)
  }, [])

  const rows = useMemo(() => buildRows(), [version, open])
  const shown = useMemo(() => {
    const list = rows.filter((r) => matches(r, q))
    const dir = sort.asc ? 1 : -1
    return list.sort((a, b) => sortValue(a, sort.by).localeCompare(sortValue(b, sort.by)) * dir)
  }, [rows, q, sort])

  /** Rules are appended after the ones already there; a later rule overrides an earlier one. */
  const apply = (rules: ReturnType<typeof userRules>, done: string): void => {
    writeKeybindings(rules)
      .then(() => setNote(done))
      .catch((e) => setNote(`Could not save keybindings.json: ${(e as Error).message}`))
      .finally(() => setVersion((n) => n + 1))
  }

  const removeBinding = (row: Row): void => {
    const rules = userRules()
    rules.push({ key: row.key ?? '', command: `-${row.cmd.id}`, ...(row.when ? { when: row.when } : {}) })
    apply(rules, `Removed "${row.cmd.label}"${row.key ? ` (${keyLabel(row.key)})` : ''}.`)
  }

  const reset = (cmd: Command): void => {
    const rules = userRules().filter((r) => r.command !== cmd.id && r.command !== `-${cmd.id}`)
    apply(rules, `"${cmd.label}" is back to its default.`)
  }

  const bindKey = (cmd: string, key: string, replaces?: { key: string; when?: string }): void => {
    const rules = userRules()
    if (replaces) rules.push({ key: replaces.key, command: `-${cmd}`, ...(replaces.when ? { when: replaces.when } : {}) })
    rules.push({ key, command: cmd, ...(replaces?.when ? { when: replaces.when } : {}) })
    const label = COMMANDS.find((c) => c.id === cmd)?.label ?? cmd
    const clash = allBindings().filter((b) => b.key === key && b.command !== cmd)
    const names = [...new Set(clash.map((b) => COMMANDS.find((c) => c.id === b.command)?.label ?? b.command))]
    apply(rules, names.length ? `${label}: ${keyLabel(key)}. Also bound to "${names.join('", "')}"; the last rule wins.` : `${label}: ${keyLabel(key)}.`)
  }

  const setWhen = (row: Row, when: string): void => {
    const next = when.trim() || undefined
    const rules = userRules()
    if (row.key) rules.push({ key: row.key, command: `-${row.cmd.id}`, ...(row.when ? { when: row.when } : {}) })
    if (row.key) rules.push({ key: row.key, command: row.cmd.id, ...(next ? { when: next } : {}) })
    apply(rules, `"${row.cmd.label}": when ${next ? `"${next}"` : 'always'}.`)
  }

  useEffect(() => {
    shortcutRecording.on = recording !== null
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(null)
      const press = pressOf(e)
      if (!press) return
      const r = recording
      setRecording(null)
      bindKey(r.cmd, press, r.replaces)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording])

  useEffect(() => {
    if (!open) return
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !recording && !whenEdit) close()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recording, whenEdit])

  if (!open) return null
  const close = (): void => {
    setRecording(null)
    setWhenEdit(null)
    setOpen(false)
    setNote('')
    setQ('')
  }
  const head = (label: string, by: Sort): React.JSX.Element => (
    <button className="kb-sort" onClick={() => setSort((s) => ({ by, asc: s.by === by ? !s.asc : true }))}>
      {label}
      {sort.by === by && <span>{sort.asc ? ' ▲' : ' ▼'}</span>}
    </button>
  )
  const recordingLabel = recording ? COMMANDS.find((c) => c.id === recording.cmd)?.label : ''
  const userCount = userRules().length

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="kb-editor" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={15} />
          <input
            autoFocus
            placeholder="Search. Try @source:user, @key:ctrl, @when:editor, @command:sidebar"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn btn-sm" title="Open keybindings.json" onClick={() => void window.api.keybindings.path().then(openFile)}>
            <FileText size={13} /> keybindings.json
          </button>
          <button className="icon-btn tiny" title="Close (Esc)" onClick={close}>
            <X size={14} />
          </button>
        </div>
        <div className="kb-note">
          {recording ? `Press the new shortcut for "${recordingLabel}" · Esc cancels` : note || `${shown.length} of ${rows.length} · ${userCount} user rule${userCount === 1 ? '' : 's'} in keybindings.json`}
        </div>
        <div className="kb-head">
          {head('Command', 'command')}
          {head('Keybinding', 'key')}
          {head('When', 'when')}
          {head('Source', 'source')}
          <span />
        </div>
        <div className="kb-list">
          {shown.map((r) => {
            const editingWhen = whenEdit?.uid === r.uid
            const hasUser = userRules().some((u) => u.command === r.cmd.id || u.command === `-${r.cmd.id}`)
            return (
              <div key={r.uid} className={`kb-row${recording?.cmd === r.cmd.id && recording.replaces?.key === r.key ? ' editing' : ''}`}>
                <span className="kb-name" title={r.cmd.id} onDoubleClick={() => navigator.clipboard?.writeText(r.cmd.id)}>
                  {r.cmd.label}
                  <small>{r.cmd.id}</small>
                </span>
                <span className="kb-keys">{r.key ? <kbd>{keyLabel(r.key)}</kbd> : <em>none</em>}</span>
                <span className="kb-when">
                  {editingWhen ? (
                    <input
                      autoFocus
                      value={whenEdit.value}
                      placeholder="e.g. !terminalFocus && chatFocus"
                      onChange={(e) => setWhenEdit({ uid: r.uid, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          setWhenEdit(null)
                          setWhen(r, whenEdit.value)
                        }
                        if (e.key === 'Escape') setWhenEdit(null)
                      }}
                      onBlur={() => setWhenEdit(null)}
                    />
                  ) : (
                    <code title="Click to edit the when clause" onClick={() => r.key && setWhenEdit({ uid: r.uid, value: r.when ?? '' })}>
                      {r.when ?? ''}
                    </code>
                  )}
                </span>
                <span className="kb-source">{r.key ? (r.user ? 'User' : 'Default') : ''}</span>
                <span className="kb-actions">
                  <button
                    className="icon-btn tiny"
                    title={r.key ? 'Change this keybinding' : 'Add a keybinding'}
                    onClick={() => setRecording({ cmd: r.cmd.id, replaces: r.key ? { key: r.key, when: r.when } : undefined })}
                  >
                    {r.key ? <Pencil size={13} /> : <Plus size={13} />}
                  </button>
                  {r.key && (
                    <button className="icon-btn tiny" title="Remove this keybinding" onClick={() => removeBinding(r)}>
                      <X size={13} />
                    </button>
                  )}
                  {hasUser && (
                    <button className="icon-btn tiny" title="Reset to default" onClick={() => reset(r.cmd)}>
                      <RotateCcw size={13} />
                    </button>
                  )}
                  {r.key && (
                    <button className="icon-btn tiny" title={`Show all commands bound to ${keyLabel(r.key)}`} onClick={() => setQ(`@key:${keyLabel(r.key!)}`)}>
                      <Search size={13} />
                    </button>
                  )}
                  <button className="icon-btn tiny" title="Copy the command id" onClick={() => void navigator.clipboard?.writeText(r.cmd.id)}>
                    <Copy size={13} />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
