import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Copy, Download, GitCommitHorizontal, Shield, ShieldOff, History, Plus, RefreshCw, RotateCcw, Sparkles, Play, FastForward, Upload, Paperclip, Square, SquareTerminal, Trash2, X, ExternalLink } from 'lucide-react'
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
  setChatEffort,
  setChatModel,
  setChatPermission,
  folderKey,
  loadProjectBypass,
  toggleProjectBypass
} from '../actions'
import { attachTerm, detachTerm, fitTerm, focusTerm, writeToTerm } from '../terminals'
import { Logo, StatusDot, statusLabel } from './icons'
import { AttachmentTray } from './AttachmentTray'
import { pickAttachments } from '../attachments'
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

/** One click: Claude commits everything and pushes, following our commit-message rules. */
const COMMIT_PUSH =
  'Commit all current changes and push to the remote. Commit message rules: English, one short subject line only ' +
  '(no body or description), and no Co-Authored-By or any other author/attribution trailer.\r'

const PULL =
  'Pull the latest code from the remote for the current branch (git pull). If there are local changes or conflicts, ' +
  'keep my work safe and tell me what happened.\r'

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
    <div className={`claude-split ${node.dir}`}>
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
  const busy = active?.status === 'working' || active?.status === 'starting'

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
          <div className={`quick-bar${busy ? ' busy' : ''}`}>
            {active.status === 'working' && (
              <button
                className="chip chip-stop"
                title="Stop what the AI is doing (Esc)"
                onClick={() => {
                  writeToTerm(active.id, '\x1b')
                  focusTerm(active.id)
                }}
              >
                <Square size={10} fill="currentColor" />
                Stop
              </button>
            )}
            <button
              className="chip"
              title="Attach files — they go with your next message (you can also paste pictures or drag files onto the chat)"
              disabled={active.status === 'exited'}
              onClick={async () => {
                await pickAttachments(active.id, active.cwd)
                focusTerm(active.id)
              }}
            >
              <Paperclip size={12} />
              Attach files
            </button>
            <button
              className="chip"
              title="Ask Claude to commit all changes (English subject line, no description, no co-author) and push"
              onClick={() => {
                writeToTerm(active.id, COMMIT_PUSH)
                focusTerm(active.id)
              }}
            >
              <GitCommitHorizontal size={12} />
              Commit + push
            </button>
            <button
              className="chip"
              title="Ask Claude to pull the latest code from the remote"
              onClick={() => {
                writeToTerm(active.id, PULL)
                focusTerm(active.id)
              }}
            >
              <Download size={12} />
              Pull
            </button>
          </div>
          <ChatStatusBar chat={active} />
          {agentDef(active.agent).id === 'claude' && <ContextBar chat={active} />}
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

/* ---------------- Model / effort / permission pickers ---------------- */

interface Opt {
  value: string
  label: string
  hint?: string
}

export const MODELS: Opt[] = [
  { value: '', label: 'Default', hint: "Claude Code's choice" },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'Most capable' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'Fast, strong' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'Fastest' },
  { value: 'claude-fable-5-2', label: 'Fable 5.2' }
]

const EFFORTS: Opt[] = [
  { value: '', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

const MODES: Opt[] = [
  { value: '', label: 'Ask permissions', hint: 'Default' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Auto-approve file edits' },
  { value: 'plan', label: 'Plan mode', hint: 'Read-only planning' },
  { value: 'bypassPermissions', label: 'Bypass permissions', hint: 'No prompts at all' }
]

/** One-click prompts for the chat's project. */
const ACTIONS = [
  {
    key: 'continue',
    label: 'Continue',
    icon: <FastForward size={12} />,
    title: 'Tell Claude to continue where it stopped',
    prompt: 'continue',
    confirm: ''
  },
  {
    key: 'resume',
    label: 'Resume',
    icon: <History size={12} />,
    title: 'Tell Claude to resume the task that was interrupted',
    prompt: 'resume',
    confirm: ''
  },
  {
    key: 'run',
    label: 'Run App',
    icon: <Play size={12} />,
    title: 'Ask Claude to start this project and give you the local URL',
    prompt:
      "Run this project's app the usual way for this project (backend and frontend if both are needed). Keep it running in the background, check that it responds, and give me the local URL.",
    confirm: ''
  },
  {
    key: 'publish',
    label: 'Publish BE',
    icon: <Upload size={12} />,
    title: 'Ask Claude to build and publish the backend',
    prompt:
      "Publish this project's backend: build it in Release and publish it the way this project is set up to (publish profile or script). Tell me where the output went and whether anything failed.",
    confirm: 'Ask Claude to publish the backend of this project now?'
  }
]

function sendPrompt(id: string, text: string): void {
  writeToTerm(id, text)
  // a separate Enter, so Claude doesn't read it as part of a pasted block
  setTimeout(() => writeToTerm(id, '\r'), 150)
  focusTerm(id)
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

function ChatStatusBar({ chat }: { chat: Chat }): React.JSX.Element {
  const exited = chat.status === 'exited'
  const agent = agentDef(chat.agent)
  const isClaude = agent.id === 'claude'
  // other agents: only "ask" vs their own never-ask flag (Codex --dangerously-bypass…, Gemini --yolo…)
  const modes = isClaude ? MODES : agent.yolo.length ? MODES.filter((m) => !m.value || m.value === 'bypassPermissions') : []
  return (
    <div className="chat-statusbar">
      <div className="sb-actions">
        {ACTIONS.map((a) => (
          <button
            key={a.key}
            className="chip sb-action"
            title={exited ? 'This chat has ended — restart it first' : `${a.label} — ${a.title}`}
            aria-label={a.label}
            disabled={exited}
            onClick={() => {
              if (a.confirm && !window.confirm(a.confirm)) return
              sendPrompt(chat.id, a.prompt)
            }}
          >
            {a.icon}
          </button>
        ))}
      </div>
      {isClaude && <Picker title="Model" options={MODELS} value={chat.model ?? ''} onPick={(v) => setChatModel(chat.id, v)} />}
      {isClaude && <Picker title="Effort" options={EFFORTS} value={chat.effort ?? ''} onPick={(v) => setChatEffort(chat.id, v)} />}
      {modes.length > 0 && (
        <Picker
          title="Permission mode (restarts the chat)"
          options={modes}
          value={chat.permissionMode ?? ''}
          warn={chat.permissionMode === 'bypassPermissions'}
          onPick={(v) => setChatPermission(chat.id, v)}
        />
      )}
    </div>
  )
}

/**
 * Models with a 200k context window: Haiku 4.5 and everything before the 4.6 generation
 * (claude-haiku-4-5-20251001, claude-opus-4-20250514, claude-3-…). Every newer model — Fable,
 * Opus 4.6+, Sonnet 4.6+, Haiku 5.5 and ones not released yet — has 1M.
 */
const SMALL_WINDOW = /-(opus|sonnet|haiku)-4(-[0-5])?(-\d{8})?$|claude-[23]/i

/** How full this chat's context window is, from the last reply in its session file. */
function ContextBar({ chat }: { chat: Chat }): React.JSX.Element {
  const sessionId = chat.sessionId
  const [ctx, setCtx] = useState<{ used: number; model: string } | null>(null)
  useEffect(() => {
    setCtx(null)
    if (!sessionId) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      window.api.sessions
        .context(sessionId)
        .then((c) => alive && setCtx((prev) => (prev && c && prev.used === c.used && prev.model === c.model ? prev : c)))
        .catch(() => {})
    }
    load()
    const off = window.api.sessions.onChanged((ids) => {
      if (!ids.includes(sessionId) && !ids.includes('*')) return
      clearTimeout(timer)
      timer = setTimeout(load, 400)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [sessionId])

  const used = ctx?.used ?? 0
  // the model that wrote the last reply decides (it follows a /model typed in the chat); the
  // `[1m]` suffix only exists on the launch flag. A 200k model already past 200k is on 1M too.
  const small = SMALL_WINDOW.test(ctx?.model || chat.model || '') && !/\[1m\]/i.test(chat.model ?? '')
  const max = small && used <= 200_000 ? 200_000 : 1_000_000
  const pct = Math.min(100, (used / max) * 100)
  const level = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low'
  const k = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
  return (
    <div className="ctx-bar" title={ctx ? `${used.toLocaleString()} of ${max.toLocaleString()} tokens in context` : 'No reply yet'}>
      <span className="ctx-label">Context</span>
      <div className="ctx-track">
        <div className={`ctx-fill ${level}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="ctx-num">
        {ctx ? `${k(used)} / ${k(max)} · ${Math.round(pct)}%` : '—'}
      </span>
    </div>
  )
}

export function Picker(props: { title: string; options: Opt[]; value: string; warn?: boolean; onPick: (v: string) => void }): React.JSX.Element {
  const { title, options, value, warn, onPick } = props
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  const cur = options.find((o) => o.value === value) ?? options[0]
  return (
    <div className="sb-picker" ref={ref}>
      <button className={`sb-btn${open ? ' open' : ''}${warn ? ' warn' : ''}`} title={`${cur.label} — ${title}`} onClick={() => setOpen(!open)}>
        {cur.label}
      </button>
      {open && (
        <div className="sb-menu" role="menu">
          <div className="sb-menu-title">{title}</div>
          {options.map((o) => (
            <button
              key={o.value}
              role="menuitemradio"
              aria-checked={o.value === value}
              className={`sb-item${o.value === value ? ' on' : ''}`}
              onClick={() => {
                setOpen(false)
                if (o.value !== value) onPick(o.value)
              }}
            >
              <Check size={13} className="sb-check" />
              <span className="sb-item-label">{o.label}</span>
              {o.hint && <span className="sb-item-hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
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
