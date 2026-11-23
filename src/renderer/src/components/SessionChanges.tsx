import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { History } from 'lucide-react'
import { basename, type Chat } from '../store'
import { openFile } from '../actions'
import { writeToTerm } from '../terminals'
import { FileIcon } from './icons'
import { SideGroup } from './SideGroup'
import { useSessionFeed } from './sessionFeed'
import type { FileEdit, SessionFile } from '../../../shared/types'

const readChanges = (sessionId: string): Promise<SessionFile[]> =>
  typeof window.api.sessions.changes === 'function' ? window.api.sessions.changes(sessionId) : Promise.resolve([])
const nothingBusy = (): boolean => false

/** Lines of a replacement, without the empty string a missing side would give. */
const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'))

/** Lines added and removed in one file, counted over every edit (a Write counts as all new). */
function countLines(edits: FileEdit[]): { add: number; del: number } {
  return edits.reduce(
    (t, e) => ({ add: t.add + linesOf(e.new).length, del: t.del + linesOf(e.old).length }),
    { add: 0, del: 0 },
  )
}

/**
 * One edit as a diff. The lines before and after the part that changed are the same on both sides,
 * so only the middle is shown as removed and added.
 */
function editDiff(e: FileEdit): { kind: 'same' | 'add' | 'del'; text: string }[] {
  const a = linesOf(e.old)
  const b = linesOf(e.new)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const out: { kind: 'same' | 'add' | 'del'; text: string }[] = []
  for (const t of a.slice(head, a.length - tail)) out.push({ kind: 'del', text: t })
  for (const t of b.slice(head, b.length - tail)) out.push({ kind: 'add', text: t })
  return out
}

const MAX_PREVIEW_LINES = 240

/** Every edit to one file, as diffs: shown on hover. */
function ChangePreview({ file, at }: { file: SessionFile; at: DOMRect }): React.JSX.Element {
  const top = Math.max(8, Math.min(at.top, window.innerHeight - 320))
  let shown = 0
  // beside the list, kept on screen
  const left = Math.max(8, Math.min(at.right + 8, window.innerWidth - 448))
  return createPortal(
    <div className="session-change-pop" style={{ top, left }}>
      <div className="scp-head" title={file.path}>
        {basename(file.path)}
        <span className="scp-count">{file.edits.length} edit{file.edits.length === 1 ? '' : 's'}</span>
      </div>
      <div className="scp-body">
        {file.edits.map((e, i) => {
          if (shown >= MAX_PREVIEW_LINES) return null
          const lines = e.whole ? linesOf(e.new).map((text) => ({ kind: 'add' as const, text })) : editDiff(e)
          const room = MAX_PREVIEW_LINES - shown
          shown += lines.length
          return (
            <div key={e.id + i} className="scp-edit">
              <div className="scp-edit-tool">
                {e.tool}
                {e.whole ? ' · whole file' : ''}
              </div>
              {lines.slice(0, room).map((l, j) => (
                <div key={j} className={`scp-line ${l.kind}`}>
                  <span className="scp-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                  <span className="scp-text">{l.text || ' '}</span>
                </div>
              ))}
              {lines.length > room && <div className="scp-more">…</div>}
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}

/**
 * The files the active chat's Claude edited, in this chat's transcript. Hover a file for its diff,
 * click to open it in the editor, and Rewind opens Claude's own /rewind in the chat.
 */
export function SessionChanges({ chat, always }: { chat: Chat | undefined; always?: boolean }): React.JSX.Element {
  const files = useSessionFeed(chat?.sessionId, readChanges, nothingBusy)
  const [hover, setHover] = useState<{ path: string; rect: DOMRect } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const enter = (path: string, el: HTMLElement): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setHover({ path, rect: el.getBoundingClientRect() }), 180)
  }
  const leave = (): void => {
    clearTimeout(timer.current)
    setHover(null)
  }
  const hovered = hover && files.find((f) => f.path === hover.path)

  return (
    <SideGroup
      id="session-changes"
      label="Changes"
      count={files.length}
      always={always}
      actions={
        chat?.sessionId ? (
          <button
            className="icon-btn tiny"
            title="Rewind: opens Claude's /rewind in this chat, to roll back its changes"
            onClick={() => writeToTerm(chat.id, '/rewind\r')}
          >
            <History size={12} />
          </button>
        ) : undefined
      }
    >
      {!chat && <div className="tree-empty">Pick a chat to see its changes.</div>}
      {chat && files.length === 0 && <div className="tree-empty">This chat has not edited any file yet.</div>}
      {files.map((f) => {
        const name = basename(f.path)
        const dir = f.path.slice(0, f.path.length - name.length).replace(/[\\/]+$/, '')
        const { add, del } = countLines(f.edits)
        return (
          <div
            key={f.path}
            className="change-row session-change-row"
            onClick={() => openFile(f.path)}
            onMouseEnter={(e) => enter(f.path, e.currentTarget)}
            onMouseLeave={leave}
            title={f.path}
          >
            <FileIcon name={name} />
            <span className="change-name">{name}</span>
            <span className="change-dir">{dir}</span>
            <span className="change-stats">
              {add > 0 && <span className="add">+{add}</span>}
              {del > 0 && <span className="del">−{del}</span>}
            </span>
          </div>
        )
      })}
      {hovered && hover && <ChangePreview file={hovered} at={hover.rect} />}
    </SideGroup>
  )
}
