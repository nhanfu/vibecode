import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Copy, Shield, ShieldOff, History, Plus, RefreshCw, RotateCcw, Sparkles, SquareTerminal, Trash2, X, ExternalLink } from 'lucide-react'
import { shownLayout, useStore, type Chat } from '../store'
import { layoutIds, type Layout } from '../chatLayout'
import { SlidePill, useEnterAnimation } from './motion'
import {
  closeChat,
  closeShell,
  defaultAgent,
  detectClaude,
  newChat,
  newChatWith,
  newShell,
  renameChat,
  restartChat,
  hoverFocus,
  hoverPane,
  selectChat,
  folderKey,
  loadProjectBypass,
  toggleProjectBypass
} from '../actions'
import { attachTerm, detachTerm, fitTerm, focusTerm, writeToTerm } from '../terminals'
import { Logo, StatusDot, statusLabel } from './icons'
import { AttachmentTray } from './AttachmentTray'
import { NewChatMenu } from './AgentMenu'
import { AGENTS, agentDef } from '../../../shared/agents'

export function TerminalView({ id, autoFocus = true }: { id: string; autoFocus?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current!
    attachTerm(id, el, autoFocus)
    // A fit that changes the column count re-wraps the whole scrollback: while a panel is dragged,
    // at most ~12 a second (the last size always gets one), not one every frame.
    let raf = 0
    let last = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = (): void => {
      last = performance.now()
      fitTerm(id)
    }
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      const wait = 80 - (performance.now() - last)
      if (wait <= 0) raf = requestAnimationFrame(run)
      else timer = setTimeout(() => (raf = requestAnimationFrame(run)), wait)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      detachTerm(id)
    }
  }, [id, autoFocus])
  return <div className="term-view" ref={ref} onMouseDown={() => setTimeout(() => focusTerm(id), 0)} />
}

/* ================================ Claude panel ================================ */

export function ClaudePanel(): React.JSX.Element {
  const activeId = useStore((s) => s.activeChatId)
  const chats = useStore((s) => s.chats)
  const chatLayouts = useStore((s) => s.chatLayouts)
  const layoutMode = useStore((s) => s.layoutMode)
  const shown = useMemo(() => shownLayout({ chats, activeChatId: activeId, chatLayouts, layoutMode }), [chats, activeId, chatLayouts, layoutMode])
  const hasActive = useStore((s) => s.chats.some((c) => c.id === s.activeChatId))
  const claude = useStore((s) => s.claude)
  // Codex / Gemini… alone is enough to chat; the install card is for when no agent is there at all
  const anyAgent = useStore((s) => !!s.claude?.found || s.agents.some((a) => a.found))
  return (
    <div className="claude-panel">
      {claude && !anyAgent && <InstallCard />}
      {anyAgent && !hasActive && <NoChat />}
      {shown !== null && (
        <div className={`claude-row${typeof shown === 'string' ? '' : ' split'}`}>
          <LayoutNode node={shown} activeId={activeId} />
        </div>
      )}
    </div>
  )
}

function LayoutNode({ node, activeId }: { node: Layout | string; activeId: string | null }): React.JSX.Element {
  if (typeof node === 'string') return <ChatColumn id={node} current={node === activeId} />
  return (
    <div className={`claude-split ${node.dir}${node.dir === 'col' && node.kids.length > 3 ? ' tall' : ''}`}>
      {node.kids.map((k) => (
        <div className="claude-cell" key={layoutIds(k)[0]}>
          <LayoutNode node={k} activeId={activeId} />
        </div>
      ))}
    </div>
  )
}

function ChatColumn({ id, current }: { id: string; current: boolean }): React.JSX.Element {
  const active = useStore((s) => s.chats.find((c) => c.id === id) ?? null)
  const activeId = active?.id ?? null
  // switching chats: the new conversation eases in
  const termFrame = useRef<HTMLDivElement>(null)
  useEnterAnimation(termFrame, activeId)

  // the bar over the quick actions: moving while the chat works, green once that run has finished

  // Chats are picked from the sidebar, so there is no tab strip here — just the open chat's title row.
  return (
    <div
      className={`claude-col${current ? ' current' : ''}`}
      onPointerDownCapture={() => {
        if (!current) selectChat(id)
      }}
      {...hoverFocus(id, hoverPane)}
    >
      {active && (
        <>
          <div className="chat-titlebar">
            <div className="chat-titlebar-main">
              <StatusDot status={active.status} attention={active.attention} />
              <ChatTitle chat={active} />
              {agentDef(active.agent).id !== 'claude' && <span className="chat-agent">{agentDef(active.agent).label}</span>}
              <span className={`chat-state s-${active.status}`}>{statusLabel[active.status]}</span>
            </div>
            <div className="chat-titlebar-actions">
              {active.status === 'exited' && (
                <button className="btn btn-ghost btn-sm" onClick={() => restartChat(active.id)}>
                  <RefreshCw size={13} /> Restart
                </button>
              )}
              {agentDef(active.agent).id === 'claude' && <BypassProjectButton chat={active} />}
              <NewChatMenu title="New chat with the default agent (Ctrl+Shift+N) — right-click to pick another AI" onPick={newChatWith} />
              <button className="icon-btn" title="Close chat (it stays in the sidebar history)" onClick={() => closeChat(active.id)}>
                <X size={15} />
              </button>
            </div>
          </div>
          <div className="term-frame" ref={termFrame}>
            <div className="term-layer">
              <TerminalView id={active.id} />
            </div>
          </div>
          <AttachmentTray chatId={active.id} />
        </>
      )}
    </div>
  )
}

/** One click: Claude never asks for permission anywhere in this chat's project. */
function BypassProjectButton({ chat }: { chat: Chat }): React.JSX.Element {
  const on = useStore((s) => !!s.projectBypass[folderKey(chat.cwd)])
  useEffect(() => {
    loadProjectBypass(chat.cwd)
  }, [chat.cwd])
  return (
    <button
      className={`btn btn-sm bypass-btn${on ? ' on' : ''}`}
      title={on ? `Bypass is on for ${chat.cwd} — click to turn off` : `Bypass permissions for the whole project ${chat.cwd}`}
      onClick={() => toggleProjectBypass(chat.id)}
    >
      {on ? <ShieldOff size={13} /> : <Shield size={13} />}
      <span className="bypass-label">{on ? 'Project bypassed' : 'Bypass project'}</span>
    </button>
  )
}

function ChatTitle({ chat }: { chat: Chat }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const finish = (): void => {
    if (draft !== null && !cancelled.current) renameChat(chat.id, draft)
    cancelled.current = false
    setDraft(null)
  }
  if (draft === null)
    return (
      <span className="chat-titlebar-title" title="Click to rename" onClick={() => setDraft(chat.title)}>
        {chat.title}
      </span>
    )
  return (
    <input
      className="chat-titlebar-input"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish()
        else if (e.key === 'Escape') {
          cancelled.current = true
          finish()
        }
      }}
      onBlur={finish}
    />
  )
}

function NoChat(): React.JSX.Element {
  const agents = useStore((s) => s.agents)
  const claudeFound = useStore((s) => !!s.claude?.found)
  useStore((s) => s.preferredAgent)
  const def = agentDef(defaultAgent())
  const others = AGENTS.filter((a) => a.id !== def.id && (a.id === 'claude' ? claudeFound : agents.some((x) => x.id === a.id && x.found)))
  return (
    <div className="no-chat">
      <div className="glow-orb">
        <Logo size={56} />
      </div>
      <h3>What should we build?</h3>
      <p>Each chat runs its own {def.label} session in this folder. Run several in parallel and hop between them.</p>
      <div className="no-chat-actions">
        <button className="btn btn-primary btn-lg" onClick={() => newChat()}>
          <Sparkles size={16} /> New chat{def.id !== 'claude' ? ` · ${def.label}` : ''}
        </button>
        {claudeFound && (
          <>
            <button className="btn btn-ghost" onClick={() => newChat({ args: ['--continue'], title: 'Continued chat' })}>
              <RotateCcw size={14} /> Continue last
            </button>
            <button className="btn btn-ghost" onClick={() => newChat({ args: ['--resume'], title: 'Resume…' })}>
              <History size={14} /> Resume…
            </button>
          </>
        )}
      </div>
      {others.length > 0 && (
        <div className="no-chat-actions no-chat-agents">
          {others.map((a) => (
            <button key={a.id} className="btn btn-ghost btn-sm" onClick={() => newChatWith(a.id)}>
              <Plus size={13} /> {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function InstallCard(): React.JSX.Element {
  const cmd = 'npm install -g @anthropic-ai/claude-code'
  return (
    <div className="no-chat">
      <div className="glow-orb dim">
        <Logo size={56} />
      </div>
      <h3>Claude Code isn't installed</h3>
      <p>VIBE CODE runs the <code>claude</code> command-line tool. Install it, then sign in once from a terminal.</p>
      <div className="code-line">
        <code>{cmd}</code>
        <button className="icon-btn" title="Copy" onClick={() => navigator.clipboard.writeText(cmd)}>
          <Copy size={14} />
        </button>
      </div>
      <div className="no-chat-actions">
        <button
          className="btn btn-primary"
          onClick={() => {
            newShell()
            setTimeout(() => {
              const id = useStore.getState().activeShellId
              if (id) writeToTerm(id, cmd + '\r')
            }, 900)
          }}
        >
          <SquareTerminal size={15} /> Install in terminal
        </button>
        <button className="btn btn-ghost" onClick={() => detectClaude()}>
          <RefreshCw size={14} /> I've installed it
        </button>
        <button className="btn btn-ghost" onClick={() => window.api.app.openExternal('https://docs.claude.com/en/docs/claude-code/setup')}>
          <ExternalLink size={14} /> Docs
        </button>
      </div>
    </div>
  )
}

/* ================================ Bottom terminal panel ================================ */

export function BottomPanel(): React.JSX.Element {
  const shells = useStore((s) => s.shells)
  const activeId = useStore((s) => s.activeShellId)
  return (
    <div className="bottom-panel">
      <div className="bottom-header">
        <div className="bottom-tabs">
          <span className="bottom-label">Terminal</span>
          <SlidePill />
          {shells.map((sh) => (
            <button
              key={sh.id}
              className={`bottom-tab${sh.id === activeId ? ' active' : ''}${sh.exited ? ' exited' : ''}`}
              onClick={() => useStore.setState({ activeShellId: sh.id })}
            >
              <SquareTerminal size={13} />
              <span>{sh.title}</span>
              <X
                size={12}
                className="bottom-tab-x"
                onClick={(e) => {
                  e.stopPropagation()
                  closeShell(sh.id)
                }}
              />
            </button>
          ))}
        </div>
        <div className="section-actions">
          <button className="icon-btn" title="New terminal" onClick={() => newShell()}>
            <Plus size={15} />
          </button>
          {activeId && (
            <button className="icon-btn" title="Kill terminal" onClick={() => closeShell(activeId)}>
              <Trash2 size={14} />
            </button>
          )}
          <button className="icon-btn" title="Hide panel (Ctrl+`)" onClick={() => useStore.setState({ bottomOpen: false })}>
            <ChevronDown size={15} />
          </button>
        </div>
      </div>
      <div className="term-frame bottom">{activeId && <TerminalView id={activeId} />}</div>
    </div>
  )
}
