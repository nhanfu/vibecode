import { useEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Activity, Bot, Check, Copy, FileDiff, Files, FolderOpen, GitBranch, ListTodo, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, RotateCcw, Square, Star, Trash2, X } from 'lucide-react'
import { basename, useStore, type Chat } from '../store'
import { agentGroups, closeChat, defaultAgent, detectClaude, newChatWith, openFolder, restartChat, selectChat, setDefaultAgent } from '../actions'
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
  // Show Explorer / Show Source Control: the sidebar has to be open for its group to show. A closed
  // sidebar has no groups to hear the request, so it is made again once they exist.
  const openNow = useRef(open)
  openNow.current = open
  useEffect(() => {
    const reveal = (e: Event): void => {
      if (openNow.current) return
      show(true)
      setTimeout(() => window.dispatchEvent(new CustomEvent('side-group-reveal', { detail: (e as CustomEvent<string>).detail })), 60)
    }
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
      {!open && <AgentRail onShow={() => show(true)} />}
      <div className="agent-chat">{children}</div>
    </div>
  )
}

type RailId = 'project' | 'agents' | 'plans' | 'running' | 'changes' | 'git' | 'files'
const RAIL: { id: RailId; label: string; icon: LucideIcon; group?: string }[] = [
  { id: 'project', label: 'Project', icon: FolderOpen },
  { id: 'agents', label: 'Agents', icon: Bot, group: 'agents' },
  { id: 'plans', label: 'Plans & tasks', icon: ListTodo, group: 'plans' },
  { id: 'running', label: 'Running', icon: Activity, group: 'running' },
  { id: 'changes', label: 'Changes', icon: FileDiff, group: 'session-changes' },
  { id: 'git', label: 'Git changes', icon: GitBranch, group: 'git-changes' },
  { id: 'files', label: 'Files', icon: Files, group: 'files' }
]

function AgentRail({ onShow }: { onShow: () => void }): React.JSX.Element {
  const root = useStore((s) => s.root)
  const [hover, setHover] = useState<{ id: RailId; top: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const keep = (): void => window.clearTimeout(timer.current)
  const enter = (id: RailId, el: HTMLElement): void => {
    keep()
    setHover({ id, top: el.offsetTop })
  }
  const leave = (): void => {
    keep()
    timer.current = window.setTimeout(() => setHover(null), 180)
  }
  const open = (r: (typeof RAIL)[number]): void => {
    setHover(null)
    if (r.group) window.dispatchEvent(new CustomEvent('side-group-reveal', { detail: r.group }))
    else onShow()
  }
  const items = RAIL.filter((r) => root || (r.id !== 'git' && r.id !== 'files'))
  const flyout = hover && items.some((r) => r.id === hover.id) ? hover : null
  return (
    <div className="agent-rail" onMouseEnter={keep} onMouseLeave={leave}>
      <button className="agent-rail-btn" title="Show the agents" onClick={onShow}>
        <PanelLeftOpen size={15} />
      </button>
      <div className="agent-rail-sep" />
      {items.map((r) => {
        const Icon = r.icon
        return (
          <button
            key={r.id}
            className={`agent-rail-btn${flyout?.id === r.id ? ' on' : ''}`}
            title={r.label}
            onMouseEnter={(e) => enter(r.id, e.currentTarget)}
            onClick={() => open(r)}
          >
            <Icon size={15} />
          </button>
        )
      })}
      {flyout && (
        <div className="agent-flyout" style={{ top: flyout.top, maxHeight: `calc(100% - ${flyout.top + 8}px)` }}>
          <RailBody id={flyout.id} />
        </div>
      )}
    </div>
  )
}

function RailBody({ id }: { id: RailId }): React.JSX.Element {
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId))
  return (
    <div className="agents-panel agent-flyout-body">
      {id === 'project' && <ProjectHead />}
      {id === 'agents' && <AgentsGroup always />}
      {id === 'plans' && <PlansGroup always />}
      {id === 'running' && <RunningGroup always />}
      {id === 'changes' && <SessionChanges chat={chat} always />}
      {id === 'git' && <GitGroup always />}
      {id === 'files' && <FilesGroup always />}
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
function ProjectHead({ onHide }: { onHide?: () => void }): React.JSX.Element {
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
      <button className="icon-btn tiny" title="Open folder (Ctrl+Shift+O)" onClick={() => void openFolder(null, { autoChat: true })}>
        <FolderOpen size={12} />
      </button>
      {onHide && (
        <button className="icon-btn tiny" title="Hide the agents" onClick={onHide}>
          <PanelLeftClose size={12} />
        </button>
      )}
    </div>
  )
}

export function AgentsGroup({ always }: { always?: boolean }): React.JSX.Element {
  const claude = useStore((s) => s.claude)
  const found = useStore((s) => s.agents)
  const chats = useStore((s) => s.chats)
  // re-render when the default changes (defaultAgent() reads it)
  useStore((s) => s.preferredAgent)
  const root = useStore((s) => s.root)
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

  return (
    <SideGroup
      id="agents"
      label="Agents"
      always={always}
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
  )
}

export function RunningGroup({ always }: { always?: boolean }): React.JSX.Element {
  const chats = useStore((s) => s.chats)
  const groups = agentGroups(chats)
  return (
    <SideGroup id="running" label="Running" count={chats.length} always={always}>
      {groups.length === 0 && <div className="tree-empty">No chats open.</div>}
      {groups.map((g) => (
        <div key={g.key} className="agent-chats">
          <div className="agent-chats-head" title={g.cwd}>
            {agentDef(g.agent).label} · {basename(g.cwd)}
          </div>
          {g.chats.map((c) => (
            <ChatBranch key={c.id} chat={c} />
          ))}
        </div>
      ))}
    </SideGroup>
  )
}

export function GitGroup({ always }: { always?: boolean }): React.JSX.Element {
  const gitChanged = useStore((s) => s.git.files.length)
  return (
    <SideGroup id="git-changes" label="Git changes" count={gitChanged} always={always}>
      <div className="embedded-view">
        <ChangesView embedded />
      </div>
    </SideGroup>
  )
}

export function FilesGroup({ always }: { always?: boolean }): React.JSX.Element {
  return (
    <SideGroup id="files" label="Files" always={always}>
      <div className="embedded-view">
        <ExplorerView embedded />
      </div>
    </SideGroup>
  )
}

function AgentsList({ onHide }: { onHide: () => void }): React.JSX.Element {
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const root = useStore((s) => s.root)
  return (
    <div className="agents-panel">
      <ProjectHead onHide={onHide} />
      <AgentsGroup />
      <PlansGroup />
      <RunningGroup />
      <SessionChanges chat={chats.find((c) => c.id === activeChatId)} />
      {root && (
        <>
          <GitGroup />
          <FilesGroup />
        </>
      )}
    </div>
  )
}
