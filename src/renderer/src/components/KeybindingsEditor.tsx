import { useEffect, useState } from 'react'
import { Pencil, Search, X } from 'lucide-react'
import { keyLabel, pressOf } from '../keybindings'
import { COMMANDS, allBindings, shortcutRecording, userRules, writeKeybindings, type Command } from '../shortcuts'

/** The key a command runs now: its last rule, as the bindings stand. */
function keyOf(id: string): string | undefined {
  return allBindings().filter((b) => b.command === id).at(-1)?.key
}

/** Other commands whose key is this one, for the warning under a new key. */
function clashes(id: string, key: string): Command[] {
  return COMMANDS.filter((c) => c.id !== id && keyOf(c.id) === key)
}

export function KeybindingsEditor(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [, refresh] = useState(0)

  useEffect(() => {
    const show = (): void => setOpen(true)
    window.addEventListener('open-keybindings', show)
    return () => window.removeEventListener('open-keybindings', show)
  }, [])

  const save = (id: string, key: string | null): void => {
    const old = keyOf(id)
    const rules = userRules()
    if (old) rules.push({ key: old, command: `-${id}` })
    if (key) rules.push({ key, command: id })
    writeKeybindings(rules)
      .then(() => {
        const cmd = COMMANDS.find((c) => c.id === id)
        if (!key) return setNote(`Removed the shortcut of "${cmd?.label}".`)
        const others = clashes(id, key)
        setNote(
          others.length
            ? `${keyLabel(key)} is also used by "${others.map((c) => c.label).join('", "')}". The last rule wins.`
            : `${cmd?.label}: ${keyLabel(key)}`
        )
      })
      .catch((e) => setNote(`Could not save keybindings.json: ${(e as Error).message}`))
      .finally(() => refresh((n) => n + 1))
  }

  useEffect(() => {
    shortcutRecording.on = editing !== null
    if (!editing) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setEditing(null)
      const press = pressOf(e)
      if (!press) return
      const id = editing
      setEditing(null)
      save(id, press)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  useEffect(() => {
    if (!open) return
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !editing) setOpen(false)
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [open, editing])

  if (!open) return null
  const needle = q.trim().toLowerCase()
  const rows = COMMANDS.filter((c) => !needle || `${c.label} ${c.id} ${keyLabel(keyOf(c.id) ?? '')}`.toLowerCase().includes(needle))
  const close = (): void => {
    setEditing(null)
    setOpen(false)
    setNote('')
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="kb-editor" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={15} />
          <input autoFocus placeholder="Search commands or keys…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="icon-btn tiny" title="Close (Esc)" onClick={close}>
            <X size={14} />
          </button>
        </div>
        <div className="kb-note">{editing ? 'Press the new shortcut · Esc cancels' : note || 'Pick a command, then press the keys to give it.'}</div>
        <div className="kb-head">
          <span>Command</span>
          <span>Keys</span>
          <span />
        </div>
        <div className="kb-list">
          {rows.map((c) => {
            const key = keyOf(c.id)
            return (
              <div key={c.id} className={`kb-row${editing === c.id ? ' editing' : ''}`}>
                <span className="kb-name" title={c.id}>
                  {c.label}
                </span>
                <span className="kb-keys">{editing === c.id ? <kbd>…</kbd> : key ? <kbd>{keyLabel(key)}</kbd> : <em>none</em>}</span>
                <span className="kb-actions">
                  <button className="icon-btn tiny" title="Change the shortcut" onClick={() => setEditing(c.id)}>
                    <Pencil size={13} />
                  </button>
                  {key && (
                    <button className="icon-btn tiny" title="Remove the shortcut" onClick={() => save(c.id, null)}>
                      <X size={13} />
                    </button>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
