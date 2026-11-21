import { useEffect, useState } from 'react'
import { Check, Copy, FolderOpen, GitBranch, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, RotateCcw, Square, Star, Trash2, X } from 'lucide-react'
import { basename, useStore, type Chat } from '../store'
import { closeChat, defaultAgent, detectClaude, newChatWith, restartChat, selectChat, setDefaultAgent } from '../actions'
import { AGENTS, agentDef, type AgentId } from '../../../shared/agents'
import type { SubAgent } from '../../../shared/types'
import { writeToTerm } from '../terminals'
import { StatusDot } from './icons'
import { useSessionFeed } from './sessionFeed'
import { PlansGroup } from './PlansTree'
import { SideGroup } from './SideGroup'
import { SessionChanges } from './SessionChanges'
import { ChangesView, ExplorerView } from './Sidebar'
import { load, save } from '../localPref'

const SIDE_W_KEY = 'vibe.agentSideWidth'
const SIDE_OPEN_KEY = 'vibe.agentSideOpen'
const SIDE_W = 230
/** sub-agents removed from the list (the transcript keeps them) */
const HIDDEN_SUB_KEY = 'vibe.hiddenSubAgents'

/**
 * The Agent drop-down: the agents on the left, the chat (`children`) on the right. The list can be
 * hidden (a thin rail brings it back) and resized from its right edge; both are remembered. The
 * chat stays the same element whatever the list does, so its terminals are never rebuilt.
 */
export function AgentSplit({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(() => load(SIDE_OPEN_KEY, (v) => v !== '0', true))
  const [width, setWidth] = useState(() => load(SIDE_W_KEY, (v) => Number(v) || SIDE_W, SIDE_W))
  const show = (on: boolean): void => {
    setOpen(on)
    save(SIDE_OPEN_KEY, on ? '1' : '0')
  }
  // Show Explorer / Show Source Control: the sidebar has to be open for its group to show
  useEffect(() => {
    const reveal = (): void => show(true)
    window.addEventListener('side-group-reveal', reveal)
    return () => window.removeEventListener('side-group-reveal', reveal)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const resize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('dragging')
    const left = handle.parentElement!.getBoundingClientRect().left
    let w = width
    const move = (ev: PointerEvent): void => {
      w = Math.round(Math.min(480, Math.max(170, ev.clientX - left)))
      setWidth(w)
    }
    const up = (): void => {
      handle.classList.remove('dragging')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      save(SIDE_W_KEY, String(w))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  return (
    <div className="agent-split">
      {open && (
        <div className="agent-side" style={{ width }}>
          <AgentsList onHide={() => show(false)} />
          <div
            className="sidebar-resize"
            title="Drag to resize · double-click to reset"
            onPointerDown={resize}
            onDoubleClick={() => {
              setWidth(SIDE_W)
              save(SIDE_W_KEY, null)
            }}
          />
        </div>
      )}
      {!open && (
        <button className="agent-rail" title="Show the agents" onClick={() => show(true)}>
          <PanelLeftOpen size={14} />
        </button>
      )}
      <div className="agent-chat">{children}</div>
    </div>
  )
}

const readSubAgents = (sessionId: string): Promise<SubAgent[]> =>
  typeof window.api.sessions.subagents === 'function' ? window.api.sessions.subagents(sessionId) : Promise.resolve([])
const anyRunningSub = (list: SubAgent[]): boolean => list.some((a) => a.status === 'running')

function loadHidden(): string[] {
  return load(HIDDEN_SUB_KEY, (v) => {
    const list: unknown = JSON.parse(v)
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  }, [])
}

/**
 * A sub-agent one chat started, one level under that chat. Stop sends Esc to the chat: Claude Code
 * has no way to stop one sub-agent alone, so this stops the chat's whole turn. Remove only hides it
 * from this list.
 */
function SubAgentRow({ agent, onStop, onRemove }: { agent: SubAgent; onStop: () => void; onRemove: () => void }): React.JSX.Element {
  const dot = agent.status === 'running' ? 'working' : agent.status === 'failed' ? 'exited' : 'idle'
  return (
    <div className="sub-agent-row" title={`${agent.kind}\n${agent.description}`}>
      <StatusDot status={dot} />
      <span className="sub-agent-kind">{agent.kind}</span>
      <span className="sub-agent-desc">{agent.description}</span>
      {agent.status === 'running' && (
        <button
          className="icon-btn tiny agent-chat-act always"
          title="Stop: Esc stops this chat's whole turn, sub-agents included"
          onClick={onStop}
        >
          <Square size={10} fill="currentColor" />
        </button>
      )}
      <button className="icon-btn tiny agent-chat-act" title="Remove from the list (the transcript keeps it)" onClick={onRemove}>
        <Trash2 size={12} />
      </button>
    </div>
  )
}

/** A chat under its agent in the Running tree, with the sub-agents it started under it. */
function ChatBranch({ chat: c }: { chat: Chat }): React.JSX.Element {
  const activeChatId = useStore((s) => s.activeChatId)
  const subs = useSessionFeed(c.sessionId, readSubAgents, anyRunningSub)
  const [hidden, setHidden] = useState<string[]>(loadHidden)
  const remove = (id: string): void => {
    // read again: another chat may have hidden some since this one loaded
    const next = [...new Set([...loadHidden(), id])]
    setHidden(next)
    save(HIDDEN_SUB_KEY, JSON.stringify(next))
  }
  return (
    <>
      <div
        className={`sess-row${c.id === activeChatId ? ' active' : ''}`}
        onClick={() => selectChat(c.id)}
        title={`${c.title}\n${c.cwd}`}
      >
        <StatusDot status={c.status} attention={c.attention} />
        <span className="sess-title">{c.title}</span>
        <span className="sess-time">{basename(c.cwd)}</span>
        <button
          className="icon-btn tiny agent-chat-act"
          title="Restart"
          onClick={(e) => {
            e.stopPropagation()
            restartChat(c.id)
          }}
        >
          <RotateCcw size={12} />
        </button>
        <button
          className="icon-btn tiny agent-chat-act"
          title="Close"
          onClick={(e) => {
            e.stopPropagation()
            closeChat(c.id)
          }}
        >
          <X size={12} />
        </button>
      </div>
      {subs
        .filter((a) => !hidden.includes(a.id))
        .map((a) => (
          <SubAgentRow key={a.id} agent={a} onStop={() => writeToTerm(c.id, '\x1b')} onRemove={() => remove(a.id)} />
        ))}
    </>
  )
}

/**
 * Which project and folder the agents work in: the opened folder (name, git branch, full path) and,
 * when the chat you are in runs somewhere else under it, that folder. The hide button lives here.
 */
function ProjectHead({ onHide }: { onHide: () => void }): React.JSX.Element {
  const root = useStore((s) => s.root)
  const branch = useStore((s) => s.git.branch)
  const chatCwd = useStore((s) => s.chats.find((c) => c.id === s.activeChatId)?.cwd)
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const elsewhere = root && chatCwd && norm(chatCwd).toLowerCase() !== norm(root).toLowerCase() ? chatCwd : null
  const rel = elsewhere && root && norm(elsewhere).toLowerCase().startsWith(norm(root).toLowerCase() + '/') ? norm(elsewhere).slice(norm(root).length + 1) : elsewhere
  return (
    <div className="project-head" title={root ?? undefined}>
      <FolderOpen size={14} className="project-icon" />
      <div className="project-main">
        <div className="project-name">
          <span>{root ? basename(root) : 'No folder open'}</span>
          {branch && (
            <span className="project-branch" title="Git branch">
              <GitBranch size={10} />
              {branch}
            </span>
          )}
        </div>
        <div className="project-path">{root ?? 'Open a folder to start chats'}</div>
        {rel && (
          <div className="project-path chat" title={elsewhere ?? undefined}>
            chat in {rel}
          </div>
        )}
      </div>
      <button className="icon-btn tiny" title="Hide the agents" onClick={onHide}>
        <PanelLeftClose size={12} />
      </button>
    </div>
  )
}

/**
 * Every coding agent the app can run (installed or not, which one a plain New chat uses), and the
 * chats running now, by agent.
 */
function AgentsList({ onHide }: { onHide: () => void }): React.JSX.Element {
  const claude = useStore((s) => s.claude)
  const found = useStore((s) => s.agents)
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const root = useStore((s) => s.root)
  const gitChanged = useStore((s) => s.git.files.length)
  // re-render when the default changes (defaultAgent() reads it)
  useStore((s) => s.preferredAgent)
  const fallback = defaultAgent()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<AgentId | null>(null)

  const installed = (id: AgentId): boolean => (id === 'claude' ? !!claude?.found : found.some((a) => a.id === id && a.found))
  const chatsOf = (id: AgentId): typeof chats => chats.filter((c) => agentDef(c.agent).id === id)
  const refresh = async (): Promise<void> => {
    setBusy(true)
    await detectClaude().catch(() => {})
    setBusy(false)
  }
  const copy = (id: AgentId, text: string): void => {
    void navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200)
  }
  const running = AGENTS.filter((a) => chatsOf(a.id).length > 0)

  return (
    <div className="agents-panel">
      <ProjectHead onHide={onHide} />
      <SideGroup
        id="agents"
        label="Agents"
        actions={
          <button className="icon-btn tiny" title="Look for installed agents again" onClick={() => void refresh()}>
            <RefreshCw size={12} className={busy ? 'spin' : ''} />
          </button>
        }
      >
        {AGENTS.map((a) => {
          const ok = installed(a.id)
          const n = chatsOf(a.id).length
          const isDefault = ok && fallback === a.id
          return (
            <div key={a.id} className={`agent-row${ok ? '' : ' missing'}`}>
              <button
                className={`icon-btn tiny agent-default${isDefault ? ' on' : ''}`}
                title={isDefault ? 'New chats start with this agent' : ok ? 'Start new chats with this agent' : 'Not installed'}
                disabled={!ok}
                onClick={() => setDefaultAgent(a.id)}
              >
                <Star size={13} />
              </button>
              <div className="agent-main">
                <span className="agent-name">{a.label}</span>
                {ok ? (
                  <span className="agent-sub">
                    {a.cmd}
                    {n > 0 && ` · ${n} open`}
                  </span>
                ) : (
                  <button className="agent-install" title="Copy the install command" onClick={() => copy(a.id, a.install)}>
                    {copied === a.id ? <Check size={11} /> : <Copy size={11} />}
                    <code>{a.install}</code>
                  </button>
                )}
              </div>
              <button
                className="icon-btn tiny"
                title={!root ? 'Open a folder first' : ok ? `New ${a.label} chat in ${basename(root)}` : 'Not installed'}
                disabled={!ok || !root}
                onClick={() => newChatWith(a.id)}
              >
                <Plus size={14} />
              </button>
            </div>
          )
        })}
      </SideGroup>

      <PlansGroup />

      <SideGroup id="running" label="Running" count={chats.length}>
        {running.length === 0 && <div className="tree-empty">No chats open.</div>}
        {running.map((a) => (
          <div key={a.id} className="agent-chats">
            <div className="agent-chats-head">{a.label}</div>
            {chatsOf(a.id).map((c) => (
              <ChatBranch key={c.id} chat={c} />
            ))}
          </div>
        ))}
      </SideGroup>

      <SessionChanges chat={chats.find((c) => c.id === activeChatId)} />

      {root && (
        <>
          <SideGroup id="git-changes" label="Git changes" count={gitChanged}>
            <div className="embedded-view">
              <ChangesView embedded />
            </div>
          </SideGroup>

          <SideGroup id="files" label="Files">
            <div className="embedded-view">
              <ExplorerView embedded />
            </div>
          </SideGroup>
        </>
      )}
    </div>
  )
}
