import { useState } from 'react'
import { Check, Copy, Plus, RefreshCw, RotateCcw, Star, X } from 'lucide-react'
import { basename, useStore } from '../store'
import { closeChat, defaultAgent, detectClaude, newChatWith, restartChat, selectChat, setDefaultAgent } from '../actions'
import { AGENTS, agentDef, type AgentId } from '../../../shared/agents'
import { StatusDot } from './icons'

/**
 * The Agents drop-down: every coding agent the app can run (installed or not, which one a plain
 * New chat uses), and the chats running now, by agent.
 */
export function AgentsPanel(): React.JSX.Element {
  const claude = useStore((s) => s.claude)
  const found = useStore((s) => s.agents)
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const root = useStore((s) => s.root)
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
      <div className="side-group">
        <div className="side-group-label">
          Agents
          <button className="icon-btn tiny" title="Look for installed agents again" onClick={() => void refresh()}>
            <RefreshCw size={12} className={busy ? 'spin' : ''} />
          </button>
        </div>
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
      </div>

      <div className="side-group">
        <div className="side-group-label">
          Running
          {chats.length > 0 && <span className="count">{chats.length}</span>}
        </div>
        {running.length === 0 && <div className="tree-empty">No chats open.</div>}
        {running.map((a) => (
          <div key={a.id} className="agent-chats">
            <div className="agent-chats-head">{a.label}</div>
            {chatsOf(a.id).map((c) => (
              <div
                key={c.id}
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
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
