import { clearAttachments } from './attachments'
import { PAGES_KEY, SHARED_BROWSER_KEY, basename, saveBrowserShared, openPatch, panelShown, panelPlugins, pluginPanelId, showPanel, syncPluginPanels, uid, useStore, type ChatBrowser, type PagePanelId, type Chat, type EditorTab, type LayoutMode, type WebTab } from './store'
import { createTerm, disposeTerm, focusTerm, onTerminalEvents, readScreen, restartTerm, setTerminalClear, setTerminalTheme, writeToTerm, readScreenTail } from './terminals'
import { disposeModel, hasUnsaved } from './fileModelsLite'
import type { SessionInfo } from '../../shared/types'
import { AGENTS, agentDef, type AgentId } from '../../shared/agents'
import { userStore } from './localPref'
import { joinLayout, layoutIds, layoutKey, mapLeaves, removeLayout, replaceLayout, type Dir, type Layout } from './chatLayout'

const st = useStore.getState
const lastData = new Map<string, number>()

/* ---------------- Activity tracking: infer chat status from PTY output ---------------- */

/**
 * Claude Code redraws its screen even while idle (cursor, hints, focus), so "output arrived" isn't
 * "working". It shows "esc to interrupt" in its footer exactly while it is busy — use that.
 */
/**
 * Chats whose output changed since their status was last read. One shared ticker looks at them
 * once output has settled for 200 ms — instead of a timer per chat re-armed on every chunk, which
 * with many busy chats meant thousands of timers a second.
 */
const statusDirty = new Set<string>()

function readStatus(id: string): void {
  const chat = st().chats.find((c) => c.id === id)
  if (!chat || chat.status === 'exited') return
  const busy = /esc to (interrupt|cancel)/i.test(readScreenTail(id, 8))
  if (busy) blankChats.delete(id)
  if (busy && chat.status !== 'working') st().patchChat(id, { status: 'working' })
  if (!busy && chat.status !== 'idle') {
    // finished work while you were looking elsewhere → needs a look
    st().patchChat(id, { status: 'idle', attention: chat.status === 'working' && id !== st().activeChatId })
    // a turn just ended (maybe with a commit or checkout): the Changes panel catches up even if a
    // file event went missing
    if (chat.status === 'working') refreshGit()
  }
}

function checkStatus(id: string): void {
  statusDirty.add(id)
}

setInterval(() => {
  if (!statusDirty.size) return
  const now = Date.now()
  for (const id of statusDirty) {
    if (now - (lastData.get(id) ?? 0) < 200) continue
    statusDirty.delete(id)
    readStatus(id)
  }
}, 100)

/** Chats past Claude Code's startup prompts: their output is no longer scanned for them. */
const settled = new Set<string>()

onTerminalEvents({
  activity: (id) => {
    if (!st().chats.some((c) => c.id === id)) return
    lastData.set(id, Date.now())
    checkStatus(id)
  },
  title: (id, raw) => {
    // Claude Code sets the terminal title to a short task summary, often prefixed by a spinner glyph.
    const title = raw.replace(/^[\s✳✶✻✽✢·*⠀-⣿]+/u, '').trim()
    if (!title || /^(claude|claude code|codex|grok|gemini|qwen|copilot|opencode|powershell|pwsh|windows powershell)$/i.test(title) || /\.exe$/i.test(title)) return
    const chat = st().chats.find((c) => c.id === id)
    // the agent names its task once you've sent something: the chat is no longer blank
    blankChats.delete(id)
    // once the session store has a title for this chat, that one wins (see loadSessions)
    const known = chat?.sessionId && st().projects.some((g) => g.sessions.some((s) => s.id === chat.sessionId))
    if (chat && !chat.pinnedTitle && !known) st().patchChat(id, { title })
    const shell = st().shells.find((s) => s.id === id)
    if (shell) st().patchShell(id, { title })
  },
  exit: (id, code) => {
    const chat = st().chats.find((c) => c.id === id)
    // -1: you typed into a chat whose process had already died; bring it straight back
    if (chat && code === -1) {
      if (chat.status !== 'starting') restartChat(id)
      return
    }
    if (chat) st().patchChat(id, { status: 'exited' })
    if (st().shells.some((s) => s.id === id)) st().patchShell(id, { exited: true })
  },
  // Typing into an ended chat brings it back (resumes the same conversation) instead of doing nothing.
  input: (id, data) => {
    const chat = st().chats.find((c) => c.id === id)
    if (!chat || chat.status !== 'exited') return false
    // ignore focus/mouse reports the terminal sends on its own
    if (data.startsWith('\x1b[I') || data.startsWith('\x1b[O') || data.startsWith('\x1b[<')) return true
    restartChat(id)
    return true
  },
  // A link clicked in a chat opens in that chat's Web tab (from a shell: the current chat's).
  link: (id, url) => {
    const chatId = st().chats.some((c) => c.id === id) ? id : st().activeChatId
    newBrowserTab(browserKey(chatId), url)
  },
  // A local dev server showing up in a chat's output becomes that chat's Web page.
  data: (id, data) => {
    const chat = st().chats.find((c) => c.id === id)
    if (!chat) return
    // Startup prompts: the trust-folder question is always answered "Yes" (you only open your own
    // projects here); the bypass warning too when the chat or its project runs in bypass mode.
    const bypass = !!st().projectBypass[folderKey(chat.cwd)] || chat.permissionMode === 'bypassPermissions'
    if (agentDef(chat.agent).id === 'claude' && !settled.has(id)) answerStartupDialog(id, bypass)
    if (pendingDraft.has(id)) typeDraftWhenReady(id)
    const text = ((outTail.get(id) ?? '') + data.replace(ANSI, '')).slice(-400)
    outTail.set(id, text)
    const seen = seenLocal.get(id) ?? new Set<string>()
    for (const m of text.matchAll(LOCAL_URL)) {
      const url = m[0].replace(/[.,;:]+$/, '').replace('://0.0.0.0', '://localhost')
      if (seen.has(url)) continue
      seen.add(url)
      seenLocal.set(id, seen)
      setBrowserUrl(browserKey(id), url)
    }
  }
})

/* ---------------- Bypass permissions for a whole project ---------------- */

export const folderKey = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

export async function loadProjectBypass(folder: string): Promise<void> {
  const on = await window.api.claude.getProjectBypass(folder).catch(() => false)
  useStore.setState((s) => ({ projectBypass: { ...s.projectBypass, [folderKey(folder)]: on } }))
}

/**
 * Turn bypass on/off for the chat's project: Claude Code's own per-project setting, then restart
 * that project's open chats so they pick it up.
 */
export async function toggleProjectBypass(chatId: string): Promise<void> {
  const chat = st().chats.find((c) => c.id === chatId)
  if (!chat) return
  const key = folderKey(chat.cwd)
  const on = !st().projectBypass[key]
  const msg = on
    ? `Bypass permissions for the whole project?\n\n${chat.cwd}\n\nClaude will run commands and edit files here without asking. The trust-folder and bypass warnings are answered "Yes" for you. Saved in .claude/settings.local.json, so it also applies when you run claude from a terminal.\n\nOpen chats in this project restart.`
    : `Turn off bypass for ${chat.cwd}?\n\nClaude asks for permission again. Open chats in this project restart.`
  if (!window.confirm(msg)) return
  try {
    await window.api.claude.setProjectBypass(chat.cwd, on)
  } catch (e) {
    window.alert(`Couldn't update .claude/settings.local.json in this project:\n${(e as Error).message}`)
    return
  }
  useStore.setState((s) => ({ projectBypass: { ...s.projectBypass, [key]: on } }))
  for (const c of st().chats.filter((x) => folderKey(x.cwd) === key)) {
    st().patchChat(c.id, { permissionMode: on ? 'bypassPermissions' : undefined })
    restartChat(c.id)
  }
}

const dialogTimer = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * On a bypassed project, say "Yes" to Claude Code's trust-folder / bypass-warning prompts.
 * xterm draws asynchronously, so look at the screen a moment after output settles (not inside
 * the data event), and look again after each key we send — the prompt may not redraw otherwise.
 */
function answerStartupDialog(id: string, acceptBypass: boolean, tries = 0): void {
  clearTimeout(dialogTimer.get(id))
  dialogTimer.set(
    id,
    setTimeout(() => {
      dialogTimer.delete(id)
      if (!st().chats.some((c) => c.id === id)) return
      const screen = readScreen(id)
      // the input box is up and no prompt is waiting: startup is over for this process
      if (!/Enter to confirm/i.test(screen) && /for shortcuts|shift\+tab|─{10,}/i.test(screen)) {
        settled.add(id)
        return
      }
      const yes = acceptBypass ? /Yes, I trust this folder|Yes, I accept/i : /Yes, I trust this folder/i
      if (!/Enter to confirm/i.test(screen) || !yes.test(screen)) return
      // Look only at the two option lines — other lines (your own "> message" echoes) can carry a
      // ">" too, and pressing Enter while "No, exit" is highlighted would quit Claude.
      const lines = screen.split('\n')
      const pointer = /^\s*[❯>›▶]\s/
      const yesLine = [...lines].reverse().find((l) => /Yes, I (trust this folder|accept)/i.test(l)) ?? ''
      const noLine = [...lines].reverse().find((l) => /No, exit/i.test(l)) ?? ''
      if (pointer.test(yesLine) && !pointer.test(noLine)) writeToTerm(id, '\r')
      else if (pointer.test(noLine)) writeToTerm(id, '\x1b[B')
      else return // can't tell which option is selected: leave it to you
      if (tries < 6) answerStartupDialog(id, acceptBypass, tries + 1)
    }, tries ? 450 : 250)
  )
}

/** text to type into a new chat's input box (not sent) once Claude is ready for it */
const pendingDraft = new Map<string, string>()
const draftTimer = new Map<string, ReturnType<typeof setTimeout>>()
function typeDraftWhenReady(id: string): void {
  clearTimeout(draftTimer.get(id))
  draftTimer.set(
    id,
    setTimeout(() => {
      draftTimer.delete(id)
      const text = pendingDraft.get(id)
      if (!text || !st().chats.some((c) => c.id === id)) return pendingDraft.delete(id)
      const screen = readScreen(id)
      // still on a startup dialog, or the input box isn't drawn yet
      if (/Enter to confirm/i.test(screen) || !/for shortcuts|shift\+tab|bypass permissions|─{10,}/i.test(screen)) return
      pendingDraft.delete(id)
      writeToTerm(id, text)
      focusTerm(id)
    }, 600)
  )
}

/* eslint-disable no-control-regex */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)(?::\d{2,5})(?:\/[^\s'"<>)\]]*)?/g
/** last bit of each chat's output (URLs can arrive split across chunks) and local URLs already used */
const outTail = new Map<string, string>()
const seenLocal = new Map<string, Set<string>>()

setInterval(() => {
  const now = Date.now()
  for (const c of st().chats) {
    if (c.status !== 'working') continue
    // quiet for a while: look at the footer again (it decides, not the silence)
    if (now - (lastData.get(c.id) ?? 0) > 1600) checkStatus(c.id)
  }
}, 500)

/* ---------------- Theme ---------------- */

/** Dark (slate-blue, the default) or light; pushes it to the page, terminals, editor and see-through. */
/** The theme the app shows: 'light' and 'dark' as chosen; 'system' follows the OS. */
export type ThemeChoice = 'light' | 'dark' | 'system'

function osPrefersLight(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches
  } catch {
    return false
  }
}

export function applyTheme(): void {
  const choice = (st().settings?.theme as ThemeChoice | undefined) ?? 'system'
  const light = choice === 'light' || (choice === 'system' && osPrefersLight())
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
  setTerminalTheme(light)
  if (st().themeResolved !== (light ? 'light' : 'dark')) useStore.setState({ themeResolved: light ? 'light' : 'dark' })
  applyGlass()
  // web pages follow the app's theme (Dark Reader, see browser.rs)
  void window.api.browser.setDark(!light).catch(() => {})
}

// 'system': the OS switching light/dark switches the app too
try {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ((st().settings?.theme ?? 'system') === 'system') applyTheme()
  })
} catch {
  /* no media queries: the choice stays as it was */
}

export async function setTheme(theme: ThemeChoice): Promise<void> {
  const settings = await window.api.app.setSettings({ theme }).catch(() => null)
  if (settings) useStore.setState({ settings })
  applyTheme()
}

export async function toggleTheme(): Promise<void> {
  await setTheme(st().themeResolved === 'light' ? 'dark' : 'light')
}

/* ---------------- See-through (Linux-style overlay) ---------------- */

const GLASS_VARS = ['--bg-0', '--bg-1', '--bg-2', '--bg-term', '--frame', '--band', '--band-2']

/**
 * In see-through mode the window itself is transparent; fade the page's backgrounds so the
 * desktop shows through while text stays fully solid. The base layer gets the chosen opacity,
 * panels on top only a tint so stacked layers don't add back up to solid. Below 50% the text
 * gets a heavier halo (data-glass-low) so it stays readable over any wallpaper.
 */
export function applyGlass(): void {
  const root = document.documentElement
  for (const v of GLASS_VARS) root.style.removeProperty(v)
  document.body.style.removeProperty('background')
  const s = st().settings
  const on = !!s?.seeThrough
  const light = root.dataset.theme === 'light'
  setTerminalClear(on)
  // a soft halo keeps text readable whatever shows through (light halo for dark text, and vice versa)
  if (on) root.dataset.glass = light ? 'light' : 'dark'
  else delete root.dataset.glass
  if (!on || !s) {
    delete root.dataset.glassLow
    return
  }
  const a = Math.min(1, Math.max(0.05, s.dropOpacity))
  if (a < 0.5) root.dataset.glassLow = ''
  else delete root.dataset.glassLow
  const cs = getComputedStyle(root)
  const read = (v: string): string => cs.getPropertyValue(v).trim()
  const base = read('--frame') || read('--bg-0')
  const mix = (c: string, k: number): string => `color-mix(in srgb, ${c} ${Math.round(Math.min(1, k) * 100)}%, transparent)`
  document.body.style.background = mix(base, a)
  // light panels need a bit more body than dark ones: dark text over a dark desktop is the hard case
  const panel = light ? 0.6 : 0.45
  // the terminal and editor are dense text drawn on a canvas (no halo possible): keep a floor
  // under them so they stay readable however see-through the rest of the window is
  const floor: Record<string, number> = light ? { '--bg-term': 0.5, '--bg-2': 0.45 } : { '--bg-term': 0.35, '--bg-2': 0.3 }
  for (const v of GLASS_VARS) {
    const c = read(v)
    if (c) root.style.setProperty(v, mix(c, Math.max(a * panel, floor[v] ?? 0)))
  }
}

useStore.subscribe((s, prev) => {
  if (s.settings !== prev.settings) applyTheme()
})

/* ---------------- Folder ---------------- */

const samePath = (a: string, b: string): boolean =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

let openSeq = 0
export async function openFolder(folder?: string | null, opts: { autoChat?: boolean } = {}): Promise<void> {
  // clicking through chats of different projects fires several of these: only the last one may win,
  // or the root and the file watcher could end up on a project you already left
  const seq = ++openSeq
  const f = folder ?? (await window.api.app.pickFolder())
  if (!f || seq !== openSeq) return
  const s = await window.api.app.rememberFolder(f)
  if (seq !== openSeq) return
  const same = st().root && samePath(st().root!, f)
  let tabs = st().tabs
  if (!same) {
    // the old project's tabs close (their editor models freed), except files with unsaved edits
    tabs = tabs.filter((t) => t.kind === 'file' && hasUnsaved(t.path))
    for (const t of st().tabs) if (t.kind === 'file' && !tabs.includes(t)) disposeModel(t.path)
  }
  useStore.setState({ root: f, recent: s.recentFolders, ...(same ? {} : { tabs, activeTabId: tabs[0]?.id ?? null, git: { isRepo: false, root: null, branch: null, files: [] } }) })
  await window.api.fs.watch(f)
  if (seq !== openSeq) return
  refreshGit()
  const autoChat = opts.autoChat ?? true
  if (autoChat && installedAgents().length && !st().chats.some((c) => samePath(c.cwd, f))) newChat()
}

/* ---------------- Claude session store (shared with the Claude app) ---------------- */

/**
 * A chat's Claude Code reported the session it is writing to (a hook on each prompt). It moves to a
 * new one on /clear, /resume, and when Claude Code forks the session (a chat sent to the background,
 * or picked up after the app restarted); without this the sidebar kept marking the old one, showed
 * the new one as a separate conversation, and a restart resumed the old one.
 */
export function followChatSession(chatId: string, sessionId: string): void {
  const c = st().chats.find((x) => x.id === chatId)
  if (!c || c.sessionId === sessionId) return
  st().patchChat(chatId, { sessionId })
  loadSessions()
}

let sessTimer: ReturnType<typeof setTimeout> | null = null
let lastProjects = ''
export function loadSessions(): void {
  if (sessTimer) clearTimeout(sessTimer)
  sessTimer = setTimeout(async () => {
    const projects = await window.api.sessions.list().catch(() => null)
    if (!projects) return
    // Claude writes its transcripts all the time; most pings change nothing in the list
    const json = JSON.stringify(projects)
    if (json === lastProjects) return
    lastProjects = json
    // a working chat changes only its own session: the others keep their objects, so their
    // (memoized) sidebar rows don't re-render
    const prev = new Map(st().projects.flatMap((g) => g.sessions.map((s) => [s.id, s] as const)))
    const same = (a: SessionInfo, b: SessionInfo): boolean => (Object.keys(b) as (keyof SessionInfo)[]).every((k) => a[k] === b[k])
    for (const g of projects) g.sessions = g.sessions.map((s) => (prev.has(s.id) && same(prev.get(s.id)!, s) ? prev.get(s.id)! : s))
    useStore.setState({ projects })
    // Titles Claude generates (or that were renamed in the Claude app) flow into open chats.
    const byId = new Map(projects.flatMap((g) => g.sessions.map((s) => [s.id, s] as const)))
    for (const c of st().chats) {
      const s = c.sessionId ? byId.get(c.sessionId) : undefined
      if (s && !c.pinnedTitle && s.title && s.title !== c.title) st().patchChat(c.id, { title: s.title })
    }
  }, 50)
}

/** Open a session from ~/.claude/projects: jump to its live chat, or resume it in a new one. */
export async function openSession(s: SessionInfo): Promise<void> {
  const live = st().chats.find((c) => c.sessionId === s.id)
  if (live) return selectChat(live.id)
  if (!s.cwdExists) {
    window.alert(`The folder for this chat no longer exists:\n${s.cwd}`)
    return
  }
  if (!st().root || !samePath(st().root!, s.projectCwd)) await openFolder(s.projectCwd, { autoChat: false })
  newChat({ cwd: s.cwd, args: ['--resume', s.id], title: s.title, sessionId: s.id, pinnedTitle: true })
}

/** New chat inside a project from the sidebar tree. */
export async function newChatIn(projectCwd: string, agent: AgentId): Promise<void> {
  if (!st().root || !samePath(st().root!, projectCwd)) await openFolder(projectCwd, { autoChat: false })
  newChatWith(agent)
}

/** Coding agents found on this machine, in menu order (Claude Code first). */
export function installedAgents(): AgentId[] {
  const { claude, agents } = st()
  return AGENTS.filter((a) => (a.id === 'claude' ? !!claude?.found : agents.some((x) => x.id === a.id && x.found))).map((a) => a.id)
}

const AGENT_KEY = 'vibe.newChatAgent'

/** What a plain "New chat" runs: the agent picked as "in use" while it's still installed, else the first installed. */
export function defaultAgent(): AgentId | undefined {
  const ok = installedAgents()
  const last = st().preferredAgent
  return ok.find((id) => id === last) ?? ok[0]
}

/** Mark an agent as the one in use: plain "New chat" starts with it from now on. */
export function setDefaultAgent(agent: AgentId): void {
  try {
    userStore.setItem(AGENT_KEY, agent)
  } catch {
    /* storage unavailable */
  }
  useStore.setState({ preferredAgent: agent })
}

/** New chat with an agent picked from a menu; that agent becomes the default for the next plain "New chat". */
export function newChatWith(agent: AgentId): void {
  setDefaultAgent(agent)
  newChat({ agent })
}

export async function loadPlugins(): Promise<void> {
  const plugins = await window.api.plugins.list().catch(() => [])
  useStore.setState({ plugins })
  syncPluginPanels(plugins)
}

export async function detectClaude(): Promise<void> {
  const [claude, agents] = await Promise.all([window.api.claude.detect(), window.api.claude.agents().catch(() => [])])
  useStore.setState({ claude, agents })
}

// Throttled, not debounced: with several chats editing, file events never pause for long, and a
// timer reset on each one held the Changes panel back until they all stopped.
let gitTimer: ReturnType<typeof setTimeout> | null = null
let gitBusy = false
let gitAgain = false
export function refreshGit(): void {
  if (gitTimer) return // the pending run starts after this change, so it sees it
  gitTimer = setTimeout(async () => {
    gitTimer = null
    // one `git status` at a time; a change during it gets one more run afterwards
    if (gitBusy) {
      gitAgain = true
      return
    }
    gitBusy = true
    try {
      const root = st().root
      if (!root) return
      const git = await window.api.git.state(root).catch(() => null)
      // unchanged status (most file events): keep the same object, so nothing re-renders or re-fetches
      if (!git || st().root !== root || JSON.stringify(git) === JSON.stringify(st().git)) return
      useStore.setState({ git })
    } finally {
      gitBusy = false
      if (gitAgain) {
        gitAgain = false
        refreshGit()
      }
    }
  }, 150)
}

/* ---------------- Chats ---------------- */

interface NewChatOpts {
  /** the id of a chat restored from the previous run: its terminal may still be running (ptyd) */
  id?: string
  /** attach to that terminal when it is still there, start `args` when it is not */
  reuse?: boolean
  cwd?: string
  args?: string[]
  title?: string
  sessionId?: string
  pinnedTitle?: boolean
  /** coding agent to run — default Claude Code */
  agent?: AgentId
  /** carried over when a chat is restored from the previous run */
  model?: string
  effort?: string
  permissionMode?: string
  /** first message, sent as soon as Claude starts (one line) */
  prompt?: string
  /** first message typed into the input box but not sent: you finish and send it yourself */
  draft?: string
}

/**
 * Plain new chats nothing has been sent in yet. Another plain "New chat" in the same folder with the
 * same agent goes back to one of these instead of piling up empty "Chat 1, Chat 2…".
 */
const blankChats = new Set<string>()

function findBlankChat(cwd: string, agentId: AgentId): Chat | undefined {
  const known = new Set(st().projects.flatMap((g) => g.sessions.map((s) => s.id)))
  return st().chats.find(
    (c) =>
      blankChats.has(c.id) &&
      c.status !== 'exited' &&
      c.status !== 'working' &&
      (c.agent ?? 'claude') === agentId &&
      samePath(c.cwd, cwd) &&
      !(c.sessionId && known.has(c.sessionId))
  )
}

export function newChat(opts: NewChatOpts = {}): void {
  const cwd = opts.cwd ?? st().root
  if (!cwd) return
  // a plain new chat (not a resume / continue) runs the default installed agent
  const fresh = !opts.args?.length && !opts.sessionId
  const agent = agentDef(opts.agent ?? (fresh ? defaultAgent() : undefined))
  const blank = fresh && !opts.prompt && !opts.draft && !opts.title
  if (blank) {
    const reuse = findBlankChat(cwd, agent.id)
    if (reuse) return selectChat(reuse.id)
  }
  if (agent.id !== 'claude') return newAgentChat(cwd, agent.id, opts, blank)
  let args = opts.args ?? []
  let sessionId = opts.sessionId
  // "Continue" = the newest session of this folder: resume it by id, so the sidebar can match the chat
  if (!sessionId && args.includes('--continue')) {
    const last = st()
      .projects.flatMap((g) => g.sessions)
      .filter((s) => samePath(s.cwd, cwd))
      .sort((a, b) => b.updated - a.updated)[0]
    if (last) {
      sessionId = last.id
      args = args.map((a) => (a === '--continue' ? '--resume' : a))
      args.splice(args.indexOf('--resume') + 1, 0, last.id)
    }
  }
  // Fresh chats get an id we choose, so the sidebar can match them to the session store.
  if (!sessionId && !args.some((a) => a === '--resume' || a === '--continue' || a === '-r' || a === '-c')) {
    sessionId = crypto.randomUUID()
    args = [...args, '--session-id', sessionId]
  }
  const model = 'model' in opts ? opts.model || undefined : defaultModel()
  const effort = opts.effort ?? remembered(EFFORT_KEY, NEW_CHAT_DEFAULTS.effort)
  const permissionMode = opts.permissionMode ?? remembered(PERMISSION_KEY, NEW_CHAT_DEFAULTS.permissionMode)
  args = [...args, ...launchFlags({ model, effort, permissionMode })]
  if (opts.prompt) args = [...args, opts.prompt]
  const n = st().chats.length + 1
  const chat: Chat = {
    id: opts.id ?? 'chat-' + uid(),
    title: opts.title ?? `Chat ${n}`,
    pinnedTitle: opts.pinnedTitle ?? false,
    cwd,
    status: 'starting',
    attention: false,
    createdAt: Date.now(),
    claudeArgs: args,
    sessionId,
    model,
    effort,
    permissionMode
  }
  if (opts.draft) pendingDraft.set(chat.id, opts.draft)
  if (blank) blankChats.add(chat.id)
  createTerm({ id: chat.id, cwd: chat.cwd, kind: 'claude', claudeArgs: args, reuse: opts.reuse })
  useStore.setState((s) => ({ chats: [...s.chats, chat], activeChatId: chat.id, ...browserForNewChat(s, chat.id), ...openPatch('agents') }))
}

/**
 * A chat running another coding agent (Codex, Grok, Gemini…). It has no Claude session id, model
 * or effort; it only starts in bypass mode like Claude chats do, when the agent has such a flag.
 */
function newAgentChat(cwd: string, agentId: AgentId, opts: NewChatOpts, blank: boolean): void {
  const agent = agentDef(agentId)
  // Other agents only know default or bypass, so a Claude-only mode (plan, accept edits…) falls back to default.
  const last = remembered(PERMISSION_KEY, NEW_CHAT_DEFAULTS.permissionMode)
  const permissionMode = agent.yolo.length && last === 'bypassPermissions' ? last : undefined
  const args = [...(opts.args ?? []), ...agentFlags(agentId, permissionMode), ...(opts.prompt ? [opts.prompt] : [])]
  const n = st().chats.filter((c) => c.agent === agentId).length + 1
  const chat: Chat = {
    id: opts.id ?? 'chat-' + uid(),
    title: opts.title ?? `${agent.label} ${n}`,
    pinnedTitle: opts.pinnedTitle ?? false,
    cwd,
    status: 'starting',
    attention: false,
    createdAt: Date.now(),
    agent: agentId,
    claudeArgs: args,
    permissionMode
  }
  if (blank) blankChats.add(chat.id)
  createTerm({ id: chat.id, cwd, kind: 'claude', agent: agentId, claudeArgs: args, reuse: opts.reuse })
  useStore.setState((s) => ({ chats: [...s.chats, chat], activeChatId: chat.id, ...browserForNewChat(s, chat.id), ...openPatch('agents') }))
}

const agentFlags = (agentId: AgentId | undefined, permissionMode?: string): string[] =>
  permissionMode === 'bypassPermissions' ? agentDef(agentId).yolo : []

/** What every new chat starts with, unless another value was picked last: Opus 5.5, medium effort, bypass permissions. */
const NEW_CHAT_DEFAULTS = { effort: 'medium', permissionMode: 'bypassPermissions' }

const MODEL_KEY = 'vibe.newChatModel'
export function defaultModel(): string | undefined {
  return remembered(MODEL_KEY, '')
}
export function setDefaultModel(model: string): void {
  remember(MODEL_KEY, model)
  useStore.setState({ newChatModel: model })
}
const EFFORT_KEY = 'vibe.newChatEffort'
const PERMISSION_KEY = 'vibe.newChatPermission'
/** The value last picked in a chat's menu ('' = Claude Code's default), else the fallback. */
function remembered(key: string, fallback: string): string | undefined {
  try {
    const m = userStore.getItem(key)
    if (m !== null) return m || undefined
  } catch {
    /* storage unavailable */
  }
  return fallback || undefined
}

/** New chats start with what was just picked. */
function remember(key: string, value: string): void {
  try {
    userStore.setItem(key, value)
  } catch {
    /* they keep the default */
  }
}

/** CLI flags that carry a chat's model, effort and permission mode across (re)starts. */
function launchFlags(c: { model?: string; effort?: string; permissionMode?: string }): string[] {
  const out: string[] = []
  if (c.model) out.push('--model', c.model)
  if (c.effort) out.push('--effort', c.effort)
  if (c.permissionMode) out.push('--permission-mode', c.permissionMode)
  return out
}

/** Switch model live (`/model`) for this chat. */
export function setChatModel(id: string, model: string): void {
  writeToTerm(id, `/model ${model || 'default'}\r`)
  st().patchChat(id, { model: model || undefined })
  setDefaultModel(model)
  focusTerm(id)
}

/** Switch reasoning effort live (`/effort`) for this chat. */
export function setChatEffort(id: string, effort: string): void {
  writeToTerm(id, `/effort ${effort || 'auto'}\r`)
  st().patchChat(id, { effort: effort || undefined })
  remember(EFFORT_KEY, effort)
  focusTerm(id)
}

/** Permission mode is a launch flag: resume the same conversation with the new mode. */
export function setChatPermission(id: string, mode: string): void {
  const c = st().chats.find((x) => x.id === id)
  if (!c) return
  if (c.status === 'working' && !window.confirm(`${agentDef(c.agent).label} is still working. Restart this chat with the new permission mode?`)) return
  st().patchChat(id, { permissionMode: mode || undefined })
  remember(PERMISSION_KEY, mode)
  restartChat(id)
}

function layoutWith(n: Layout | null, id: string, active: string | null): Layout | string {
  if (!n) return id
  const ids = layoutIds(n)
  if (ids.includes(id)) return n
  if (active && ids.includes(active)) return replaceLayout(n, active, id)
  return n
}

function withLayout(all: Record<string, Layout>, cwd: string, layout: Layout | null): Record<string, Layout> {
  const key = layoutKey(cwd)
  const next = { ...all }
  if (layout === null) delete next[key]
  else next[key] = layout
  return next
}

export function setLayoutMode(mode: LayoutMode): void {
  remember(LAYOUT_MODE_KEY, mode)
  useStore.setState({ layoutMode: mode })
}

export function newLayoutChat(): void {
  const s = st()
  const active = s.chats.find((c) => c.id === s.activeChatId)
  const before = s.activeChatId
  newChat(active ? { cwd: active.cwd } : {})
  const id = st().activeChatId
  if (!id || id === before || st().layoutMode === 'merged') return
  const chat = st().chats.find((c) => c.id === id)
  if (!chat) return
  const sameProject = !!active && layoutKey(active.cwd) === layoutKey(chat.cwd)
  useStore.setState((x) => ({
    chatLayouts: withLayout(x.chatLayouts, chat.cwd, joinLayout(x.chatLayouts[layoutKey(chat.cwd)] ?? null, sameProject ? active!.id : null, id, 'row'))
  }))
}

export function selectChat(id: string): void {
  const chat = st().chats.find((c) => c.id === id)
  // the chat comes on screen: the Agent drop-down floats open unless it is pinned
  const { chatLayouts, activeChatId } = st()
  const chatLayoutsNext = chat ? withLayout(chatLayouts, chat.cwd, layoutWith(chatLayouts[layoutKey(chat.cwd)] ?? null, id, activeChatId)) : chatLayouts
  useStore.setState({ activeChatId: id, chatLayouts: chatLayoutsNext, ...openPatch('agents') })
  if (chat?.attention) st().patchChat(id, { attention: false })
  // Explorer / Changes follow the chat you're looking at.
  if (chat) {
    const proj = st().projects.find((g) => g.sessions.some((s) => s.id === chat.sessionId))
    const folder = proj?.cwd ?? chat.cwd
    if (st().root && !samePath(st().root!, folder) && !samePath(st().root!, chat.cwd)) openFolder(folder, { autoChat: false })
  }
  setTimeout(() => focusTerm(id), 0)
}

let hoverTimer: number | undefined

/** Hovering a chat makes it the active one, after a short dwell so passing over it does not switch. */
export function hoverChat(id: string): void {
  const chat = st().chats.find((c) => c.id === id)
  if (!chat || st().activeChatId === id) return
  const { chatLayouts, activeChatId } = st()
  const chatLayoutsNext = withLayout(chatLayouts, chat.cwd, layoutWith(chatLayouts[layoutKey(chat.cwd)] ?? null, id, activeChatId))
  useStore.setState({ activeChatId: id, chatLayouts: chatLayoutsNext })
}

/** Mouse handlers for a chat row: hover focuses it, leaving before the dwell cancels. */
export function hoverFocus(id: string): { onMouseEnter: () => void; onMouseLeave: () => void } {
  return {
    onMouseEnter: () => {
      window.clearTimeout(hoverTimer)
      hoverTimer = window.setTimeout(() => hoverChat(id), 200)
    },
    onMouseLeave: () => window.clearTimeout(hoverTimer),
  }
}

export function closeChat(id: string): void {
  disposeTerm(id)
  clearAttachments(id)
  forgetTerm(id)
  settled.delete(id)
  pendingDraft.delete(id)
  seenLocal.delete(id)
  clearTimeout(dialogTimer.get(id))
  dialogTimer.delete(id)
  clearTimeout(draftTimer.get(id))
  draftTimer.delete(id)
  useStore.setState((s) => {
    const idx = s.chats.findIndex((c) => c.id === id)
    const chats = s.chats.filter((c) => c.id !== id)
    const activeChatId =
      s.activeChatId === id ? (chats[Math.min(idx, chats.length - 1)]?.id ?? null) : s.activeChatId
    let chatLayouts = s.chatLayouts
    const closing = s.chats.find((c) => c.id === id)
    const cur = closing ? (chatLayouts[layoutKey(closing.cwd)] ?? null) : null
    if (closing && cur && layoutIds(cur).includes(id)) {
      const activeChat = chats.find((c) => c.id === activeChatId)
      const takes = !!activeChat && layoutKey(activeChat.cwd) === layoutKey(closing.cwd) && !layoutIds(cur).includes(activeChat.id)
      chatLayouts = withLayout(chatLayouts, closing.cwd, takes ? replaceLayout(cur, id, activeChat!.id) : removeLayout(cur, id))
    }
    // the chat's browser page goes with it; torn-off pages are user data and stay
    const browsers = { ...s.browsers }
    const kept = (browsers[id]?.tabs ?? []).filter((t) => t.detached)
    delete browsers[id]
    if (kept.length) {
      const pool = browsers[PAGES_KEY]
      browsers[PAGES_KEY] = { tabs: [...(pool?.tabs ?? []), ...kept], active: pool?.active ?? kept[0].id }
    }
    return { chats, activeChatId, browsers, chatLayouts }
  })
}

export function duplicateChat(dir: Dir = 'row'): void {
  const s = st()
  const c = s.chats.find((x) => x.id === s.activeChatId)
  if (!c) return
  const original = c.id
  newChat({ agent: agentDef(c.agent).id, cwd: c.cwd, title: `${c.title} copy` })
  const id = st().activeChatId
  if (!id || id === original) return
  useStore.setState((x) => ({
    chatLayouts: withLayout(x.chatLayouts, c.cwd, joinLayout(x.chatLayouts[layoutKey(c.cwd)] ?? null, original, id, dir))
  }))
}

export function restartChat(id: string): void {
  const c = st().chats.find((x) => x.id === id)
  if (!c) return
  st().patchChat(id, { status: 'starting' })
  settled.delete(id)
  if (agentDef(c.agent).id !== 'claude') {
    // other agents: pick their last conversation back up where they can, else start fresh
    restartTerm(id, { claudeArgs: [...agentDef(c.agent).resume, ...agentFlags(c.agent, c.permissionMode)] })
    return
  }
  // a chat that never got past startup has nothing to resume: start that same session fresh
  const saved = !!c.sessionId && st().projects.some((g) => g.sessions.some((s) => s.id === c.sessionId))
  const base = c.sessionId ? (saved ? ['--resume', c.sessionId] : ['--session-id', c.sessionId]) : ['--continue']
  restartTerm(id, { claudeArgs: [...base, ...launchFlags(c)] })
}

export function renameChat(id: string, title: string): void {
  const t = title.trim()
  if (t) st().patchChat(id, { title: t, pinnedTitle: true })
}

/** Per-terminal bookkeeping of the output handlers, dropped when a chat / shell closes. */
function forgetTerm(id: string): void {
  lastData.delete(id)
  statusDirty.delete(id)
  outTail.delete(id)
}

/* ---------------- Shells (bottom panel) ---------------- */

export function newShell(): void {
  const root = st().root
  if (!root) return
  const id = 'sh-' + uid()
  createTerm({ id, cwd: root, kind: 'shell' })
  useStore.setState((s) => ({
    shells: [...s.shells, { id, title: 'terminal', cwd: root, exited: false }],
    activeShellId: id,
    bottomOpen: true
  }))
}

export function closeShell(id: string): void {
  disposeTerm(id)
  forgetTerm(id)
  useStore.setState((s) => {
    const shells = s.shells.filter((x) => x.id !== id)
    return {
      shells,
      activeShellId: s.activeShellId === id ? (shells[shells.length - 1]?.id ?? null) : s.activeShellId,
      bottomOpen: shells.length > 0 && s.bottomOpen
    }
  })
}

export function toggleBottom(): void {
  const s = st()
  if (!s.bottomOpen && s.shells.length === 0) return newShell()
  useStore.setState({ bottomOpen: !s.bottomOpen })
}

/* ---------------- Reviewing files and changes ---------------- */

/*
 * A file or a change is shown in VS Code when its plugin is on and can run (its panel opens on that
 * file, or on a diff of the two versions); without it, in a popup with a Monaco editor to review and
 * edit it (components/Review.tsx). There are no editor tabs: the popup holds one file at a time
 * (`tabs` has at most one entry, the one on show).
 */

const VSCODE = 'vscode'

// the VS Code panel exists (store.ts panelPlugins): on, able to run, with a page
const vscodeReady = (): boolean => panelPlugins(st().plugins).some((p) => p.id === VSCODE)

function showInPopup(tab: EditorTab): void {
  const shown = st().tabs[0]
  if (shown && shown.id !== tab.id && !closeTab(shown.id)) return
  useStore.setState({ tabs: [tab], activeTabId: tab.id, inlineTab: null })
}

/**
 * A file for the popup beside the Files explorer: always in the app (never VS Code), and not in the
 * overlay. Returns the tab's id, or null when the shown file's unsaved edits were not discarded.
 */
export function openInlineFile(path: string, preview = false): string | null {
  const id = 'f:' + path.toLowerCase()
  const shown = st().tabs[0]
  // a hover preview never takes the place of a file with unsaved edits, and never asks about them
  if (preview && shown?.kind === 'file' && shown.id !== id && hasUnsaved(shown.path)) return null
  if (shown && shown.id !== id && !closeTab(shown.id)) return null
  const tab: EditorTab = { id, kind: 'file', path, title: basename(path), dirty: false }
  useStore.setState({ tabs: [tab], activeTabId: id, inlineTab: id })
  return id
}

function showInVSCode(open: { file?: string; diff?: { left: string; right: string } }): void {
  useStore.setState((s) => ({ pluginOpen: { ...s.pluginOpen, [VSCODE]: { ...open, n: (s.pluginOpen[VSCODE]?.n ?? 0) + 1 } } }))
  showPanel(pluginPanelId(VSCODE))
}

/** Both versions of a change as files VS Code can open: the working copy itself, the older one a snapshot. */
async function diffFiles(tab: Extract<EditorTab, { kind: 'diff' }>): Promise<{ left: string; right: string }> {
  const root = st().git.root ?? st().root
  if (!root) throw new Error('no folder')
  const rel = tab.rel
  if (tab.commit) {
    const { hash, short } = tab.commit
    const [left, right] = await Promise.all([
      window.api.git.snapshot(root, `${hash}^`, rel, `${short}-before`),
      window.api.git.snapshot(root, hash, rel, short)
    ])
    return { left, right }
  }
  const left = await window.api.git.snapshot(root, 'HEAD', rel, 'HEAD')
  // a deleted file has no working copy: its right side is empty
  const exists = await window.api.fs.readFile(tab.path).then(() => true, () => false)
  const right = exists ? tab.path : await window.api.git.snapshot(root, 'HEAD-none', rel, 'deleted')
  return { left, right }
}

function review(tab: EditorTab): void {
  if (!vscodeReady()) return showInPopup(tab)
  if (tab.kind === 'file') return showInVSCode({ file: tab.path })
  diffFiles(tab).then((diff) => showInVSCode({ diff }), () => showInPopup(tab))
}

export function openFile(path: string): void {
  review({ id: 'f:' + path.toLowerCase(), kind: 'file', path, title: basename(path), dirty: false })
}

export const HOME_URL = 'about:blank'

/** Browser key for the chat you're looking at — every chat keeps its own page. */
export const browserKey = (activeChatId: string | null): string => (useStore.getState().browserShared ? SHARED_BROWSER_KEY : activeChatId ?? '_')

const blankTab = (url = HOME_URL): WebTab => ({ id: 'w-' + uid(), url, title: '' })

/**
 * A chat opened while the Web tab is showing gets its browser in the same state update, so the
 * Web pane never renders a frame with no page in it (that empty frame made the layout jump).
 */
function browserForNewChat(s: ReturnType<typeof st>, chatId: string): Partial<ReturnType<typeof st>> {
  if (!panelShown(s, 'web') || s.browsers[chatId]) return {}
  const t = blankTab()
  return { browsers: { ...s.browsers, [chatId]: { tabs: [t], active: t.id } } }
}

/** Give a chat its first (blank) page, without showing or hiding anything. */
export function ensureBrowser(key: string): void {
  useStore.setState((s) => {
    if (s.browsers[key]) return s
    const t = blankTab()
    return { browsers: { ...s.browsers, [key]: { tabs: [t], active: t.id } } }
  })
}

/** Show the Web tab for the current chat (optionally at a URL, in the tab you're on). */
export function openBrowser(url?: string): void {
  const key = browserKey(st().activeChatId)
  if (!st().browsers[key]) newBrowserTab(key, url)
  else if (url) setBrowserUrl(key, url)
  showPanel('web')
}

/**
 * A new tab in a chat's browser, and show it. Opening a URL (the app, Claude) reuses the open tab
 * while it is still blank; the "+" button (`reuseBlank` false) always adds one, like a browser.
 */
export function newBrowserTab(key: string, url?: string, reuseBlank = true): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    const cur = b?.tabs.find((t) => t.id === b.active)
    if (reuseBlank && b && cur && cur.url === HOME_URL) {
      if (!url) return openPatch('web')
      return { ...openPatch('web'), browsers: { ...s.browsers, [key]: { ...b, tabs: b.tabs.map((t) => (t === cur ? { ...t, url } : t)) } } }
    }
    const tab = blankTab(url)
    return { ...openPatch('web'), browsers: { ...s.browsers, [key]: { tabs: [...(b?.tabs ?? []), tab], active: tab.id } } }
  })
}

/** Ctrl+Shift+T in the Web tabs: the last closed page again, in the chat you are in. */
export function reopenClosedWebTab(): void {
  const key = browserKey(st().activeChatId)
  const last = closedWebTabs.pop()
  if (last) newBrowserTab(key, last.url, false)
}

/** Ctrl+T: a new blank tab in the chat's Web panel, and the panel shows. */
export function newWebTab(): void {
  newBrowserTab(browserKey(st().activeChatId), undefined, false)
}

/** Move a Web tab to a position among the open tabs (drag along the strip). */
export function moveBrowserTab(key: string, id: string, to: number): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    const tab = b?.tabs.find((t) => t.id === id)
    if (!b || !tab || tab.detached) return s
    const others = b.tabs.filter((t) => t.id !== id)
    const open = others.filter((t) => !t.detached)
    const anchor = open[Math.min(Math.max(to, 0), open.length)]
    const at = anchor ? others.indexOf(anchor) : open.length ? others.indexOf(open[open.length - 1]) + 1 : others.length
    const tabs = [...others.slice(0, at), tab, ...others.slice(at)]
    if (tabs.every((t, i) => t === b.tabs[i])) return s
    return { browsers: { ...s.browsers, [key]: { ...b, tabs } } }
  })
}

/** Ctrl+Tab / Ctrl+Shift+Tab: the next (or previous) Web tab of the chat on screen, wrapping around. */
export function cycleWebTab(step: 1 | -1): void {
  const key = browserKey(st().activeChatId)
  const b = st().browsers[key]
  const strip = (b?.tabs ?? []).filter((t) => !t.detached)
  if (!b || strip.length === 0) return
  const at = strip.findIndex((t) => t.id === b.active)
  const next = strip[(at < 0 ? 0 : at + step + strip.length) % strip.length]
  if (next) selectBrowserTab(key, next.id)
}

/** Alt+Left / Alt+Right: back or forward in the Web tab on screen (when the page itself does not have the focus). */
export function stepBrowserHistory(step: 1 | -1): void {
  const key = browserKey(st().activeChatId)
  const b = st().browsers[key]
  const tab = b?.tabs.find((t) => t.id === b.active)
  const label = tab ? pageLabels.get(tab.id) : undefined
  if (!label) return
  if (step < 0) window.api.browser.back(label)
  else window.api.browser.forward(label)
}

export function selectBrowserTab(key: string, id: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    return b && b.active !== id ? { browsers: { ...s.browsers, [key]: { ...b, active: id } } } : s
  })
}

/** Web tabs closed lately, newest last (Ctrl+Shift+T brings the last one back). */
const closedWebTabs: { url: string; title: string }[] = []

/** Close one tab; closing the last one leaves a blank tab. */
export function closeBrowserTab(key: string, id: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    if (!b) return s
    const gone = b.tabs.find((t) => t.id === id)
    if (gone && !gone.detached && gone.url !== HOME_URL) {
      closedWebTabs.push({ url: gone.url, title: gone.title })
      if (closedWebTabs.length > 30) closedWebTabs.shift()
    }
    let tabs = b.tabs.filter((t) => t.id !== id)
    // the strip needs a tab of its own: torn-off ones don't count
    if (key !== PAGES_KEY && !tabs.some((t) => !t.detached)) tabs = [...tabs, blankTab()]
    const open = tabs.filter((t) => !t.detached)
    if (!open.length) {
      const page = `page:${id}` as PagePanelId
      return {
        browsers: { ...s.browsers, [key]: { tabs, active: tabs[0]?.id ?? '' } },
        panelOrder: s.panelOrder.filter((p) => p !== page),
        pinned: s.pinned.filter((p) => p !== page)
      }
    }
    const was = b.tabs.filter((t) => !t.detached).findIndex((t) => t.id === id)
    const active = b.active === id ? open[Math.min(Math.max(was, 0), open.length - 1)].id : b.active
    const page = `page:${id}` as PagePanelId
    return {
      browsers: { ...s.browsers, [key]: { tabs, active } },
      panelOrder: s.panelOrder.filter((p) => p !== page),
      pinned: s.pinned.filter((p) => p !== page)
    }
  })
}

/**
 * Close every tab of this chat, leaving a single blank one. Torn-off pages are title-bar buttons
 * shared by all chats, so the torn-off pages of the other chats go too; their ordinary tabs stay.
 */
export function closeAllBrowserTabs(key: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    if (!b) return s
    const torn = Object.values(s.browsers).flatMap((x) => x.tabs.filter((t) => t.detached))
    const pages = new Set([...b.tabs, ...torn].map((t) => `page:${t.id}`))
    const blank = blankTab()
    const browsers = { ...s.browsers, [key]: { tabs: [blank], active: blank.id } }
    if (key !== PAGES_KEY) delete browsers[PAGES_KEY]
    for (const [k, other] of Object.entries(browsers)) {
      if (k === key) continue
      const kept = other.tabs.filter((t) => !t.detached)
      if (kept.length === other.tabs.length) continue
      const tabs = kept.length ? kept : [blankTab()]
      browsers[k] = { tabs, active: tabs.some((t) => t.id === other.active) ? other.active : tabs[0].id }
    }
    return {
      browsers,
      panelOrder: s.panelOrder.filter((p) => !pages.has(p)),
      pinned: s.pinned.filter((p) => !pages.has(p))
    }
  })
}

/**
 * Tear a tab off the Web drop-down into a title-bar button of its own (a panel next to the others:
 * pin it, move it, resize it). The page keeps running, it is only shown somewhere else.
 */
export function detachBrowserTab(key: string, id: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    const tab = b?.tabs.find((t) => t.id === id)
    if (!b || !tab || tab.detached) return s
    let tabs = b.tabs.map((t) => (t.id === id ? { ...t, detached: true } : t))
    let active = b.active
    if (!tabs.some((t) => !t.detached)) {
      const blank = blankTab()
      tabs = [...tabs, blank]
      active = blank.id
    } else if (active === id) {
      const open = b.tabs.filter((t) => !t.detached)
      const before = open.findIndex((t) => t.id === id)
      const next = tabs.filter((t) => !t.detached)
      active = next[Math.min(Math.max(before, 0), next.length - 1)].id
    }
    const page = `page:${id}` as PagePanelId
    const at = s.panelOrder.indexOf('web')
    const order = s.panelOrder.filter((p) => p !== page)
    order.splice(at < 0 ? order.length : at + 1, 0, page)
    return {
      browsers: { ...s.browsers, [key]: { tabs, active } },
      panelOrder: order,
      pinned: s.pinned.includes(page) ? s.pinned : [...s.pinned, page],
      floatOpen: null,
      peek: null
    }
  })
}

/** Put a torn-off tab back among the Web tabs. */
export function attachBrowserTab(key: string, id: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    const page = `page:${id}` as PagePanelId
    const tab = b?.tabs.find((t) => t.id === id)
    if (!b || !tab) return s
    if (key === PAGES_KEY) {
      // restored from an earlier run: it joins the Web tabs of the chat you are in
      const to = browserKey(s.activeChatId)
      const dest = s.browsers[to] ?? { tabs: [], active: '' }
      const rest = b.tabs.filter((t) => t.id !== id)
      const browsers = { ...s.browsers, [to]: { tabs: [...dest.tabs, { ...tab, detached: false }], active: id } }
      if (rest.length) browsers[PAGES_KEY] = { tabs: rest, active: rest[0].id }
      else delete browsers[PAGES_KEY]
      return { ...openPatch('web'), browsers, panelOrder: s.panelOrder.filter((p) => p !== page), pinned: s.pinned.filter((p) => p !== page) }
    }
    return {
      ...openPatch('web'),
      browsers: { ...s.browsers, [key]: { tabs: b.tabs.map((t) => (t.id === id ? { ...t, detached: false } : t)), active: id } },
      panelOrder: s.panelOrder.filter((p) => p !== page),
      pinned: s.pinned.filter((p) => p !== page)
    }
  })
}

/** A chat's Claude used its browser tools: give that chat a Web tab (the drop-down stays as it is: floating, it would cover the chat). */
export function showChatBrowser(chatId: string): void {
  useStore.setState((s) => {
    if (s.browsers[chatId]) return s
    const t = blankTab()
    return { browsers: { ...s.browsers, [chatId]: { tabs: [t], active: t.id } } }
  })
}

/** Keep a tab's page history (base64, from the native side) so it comes back after a restart. */
export function setBrowserSession(key: string, tabId: string, session: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    if (!b) return s
    return { browsers: { ...s.browsers, [key]: { ...b, tabs: b.tabs.map((t) => (t.id === tabId ? { ...t, session } : t)) } } }
  })
}

/** Point a tab (default: the chat's open tab) at a URL / record its title. */
export function setBrowserUrl(key: string, url: string, tabId?: string, title?: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    if (!b) {
      const t = blankTab(url)
      return { browsers: { ...s.browsers, [key]: { tabs: [t], active: t.id } } }
    }
    const id = tabId ?? b.active
    const cur = b.tabs.find((t) => t.id === id)
    if (!cur || (cur.url === url && (title === undefined || cur.title === title))) return s
    // a new address has a title of its own: the old page's title must not stay on the tab
    const tabs = b.tabs.map((t) => (t === cur ? { ...t, url, title: title ?? (url === cur.url ? t.title : '') } : t))
    return { browsers: { ...s.browsers, [key]: { ...b, tabs } } }
  })
}

export function openDiff(abs: string, rel: string): void {
  review({ id: 'd:' + abs.toLowerCase(), kind: 'diff', path: abs, rel, title: basename(abs) })
}

/** A file as one commit changed it (commit vs its parent). */
export function openCommitDiff(gitRoot: string, commit: { hash: string; short: string; subject: string }, rel: string): void {
  const abs = gitRoot.replace(/[\\/]+$/, '') + '/' + rel
  review({ id: `c:${commit.hash}:${rel}`, kind: 'diff', path: abs, rel, title: `${basename(rel)} @${commit.short}`, commit })
}

/** Close the popup's file (asks first when it has unsaved edits); false when it stays open. */
export function closeTab(id: string): boolean {
  const tab = st().tabs.find((t) => t.id === id)
  if (tab?.kind === 'file') {
    if (hasUnsaved(tab.path) && !window.confirm(`Discard unsaved changes to ${tab.title}?`)) return false
    disposeModel(tab.path)
  }
  useStore.setState((s) => {
    const tabs = s.tabs.filter((t) => t.id !== id)
    return { tabs, activeTabId: s.activeTabId === id ? (tabs[0]?.id ?? null) : s.activeTabId, inlineTab: s.inlineTab === id ? null : s.inlineTab }
  })
  return true
}

/** Next / previous chat in the sidebar's order. */
export function cycleChat(step: 1 | -1): void {
  const { chats, activeChatId } = st()
  if (!chats.length) return
  const i = chats.findIndex((c) => c.id === activeChatId)
  selectChat(chats[(i + step + chats.length) % chats.length].id)
}


/* ---------------- Open chats survive quitting the app ---------------- */

const OPEN_CHATS_KEY = 'vibe.openChats'
const CHAT_LAYOUTS_KEY = 'vibe.chatLayouts'
const LAYOUT_MODE_KEY = 'vibe.layoutMode'
interface SavedChat {
  /** the chat's id, which is also the id of its terminal in ptyd */
  id?: string
  cwd: string
  title: string
  pinnedTitle: boolean
  agent?: AgentId
  sessionId?: string
  model?: string
  effort?: string
  permissionMode?: string
  active?: boolean
}
let persistChats = false

/** Remember the open chats (each one's Claude session lives in ~/.claude/projects) so the next start brings them back. */
function saveOpenChats(): void {
  if (!persistChats) return
  const { chats, activeChatId } = st()
  const list: SavedChat[] = chats.map((c) => ({
    id: c.id,
    cwd: c.cwd,
    title: c.title,
    pinnedTitle: c.pinnedTitle,
    agent: c.agent,
    sessionId: c.sessionId,
    model: c.model,
    effort: c.effort,
    permissionMode: c.permissionMode,
    active: c.id === activeChatId
  }))
  try {
    userStore.setItem(OPEN_CHATS_KEY, JSON.stringify(list))
    userStore.setItem(CHAT_LAYOUTS_KEY, JSON.stringify(st().chatLayouts))
  } catch {
    /* nothing to restore next time */
  }
}

/** Reopen the chats that were open when the app quit, each resuming its own conversation. */
export async function restoreChats(): Promise<void> {
  let saved: SavedChat[] = []
  // the list of chats was read properly (an empty one counts): only then is a terminal nobody claims an orphan
  let savedOk = false
  try {
    const v = JSON.parse(userStore.getItem(OPEN_CHATS_KEY) ?? 'null')
    if (Array.isArray(v)) {
      saved = v.filter((c) => c && typeof c.cwd === 'string')
      savedOk = true
    }
  } catch {
    /* nothing saved */
  }
  const projects = (await window.api.sessions.list().catch(() => null)) ?? []
  const known = new Set(projects.flatMap((g) => g.sessions.map((x) => x.id)))
  // chats whose terminal is still running (ptyd keeps them when the app is closed): they come back as
  // they are, attached to that terminal, even a chat nothing was said in yet
  const listed = await window.api.pty.list().catch(() => null)
  const running = new Set(listed ?? [])
  const claimed = new Set<string>()
  let activeId: string | null = null
  const came = new Map<string, string>()
  const modelOf = new Map<string, string>()
  await Promise.all(
    saved.map(async (c) => {
      if (!c.sessionId) return
      const r = await window.api.sessions.context(c.sessionId).catch(() => null)
      if (r?.model) modelOf.set(c.sessionId, r.model)
    })
  )
  // one chat per session: a session already open (or listed twice) is not opened again
  const opened = new Set(st().chats.map((c) => c.sessionId).filter(Boolean))
  for (const c of saved) {
    const agent = agentDef(c.agent)
    // its terminal is still there: the chat keeps its id (that is the terminal's name) and attaches
    const alive = !!c.id && running.has(c.id)
    const same = alive ? { id: c.id, reuse: true } : {}
    if (alive && c.id) claimed.add(c.id)
    if (agent.id === 'claude') {
      // a chat nothing was ever said in left no session to resume (unless its terminal is still running)
      if (!alive && (!c.sessionId || !known.has(c.sessionId))) continue
      if (c.sessionId && opened.has(c.sessionId)) continue
      if (c.sessionId) opened.add(c.sessionId)
      newChat({ ...same, cwd: c.cwd, args: c.sessionId ? ['--resume', c.sessionId] : [], sessionId: c.sessionId, title: c.title, pinnedTitle: c.pinnedTitle, model: (c.sessionId && modelOf.get(c.sessionId)) || c.model, effort: c.effort, permissionMode: c.permissionMode })
    } else {
      newChat({ ...same, cwd: c.cwd, agent: agent.id, args: [...agent.resume], title: c.title, pinnedTitle: c.pinnedTitle })
    }
    if (c.active) activeId = st().activeChatId
    if (c.id && st().activeChatId) came.set(c.id, st().activeChatId!)
  }
  let savedLayouts: Record<string, Layout> = {}
  try {
    const v = JSON.parse(userStore.getItem(CHAT_LAYOUTS_KEY) ?? 'null')
    if (v && typeof v === 'object') savedLayouts = v
  } catch {
    savedLayouts = {}
  }
  const restoredLayouts: Record<string, Layout> = {}
  for (const [key, tree] of Object.entries(savedLayouts)) {
    const r = mapLeaves(tree, (old) => came.get(String(old)) ?? null)
    if (r) restoredLayouts[key] = r
  }
  useStore.setState({ chatLayouts: restoredLayouts, layoutMode: userStore.getItem(LAYOUT_MODE_KEY) === 'merged' ? 'merged' : 'project' })
  if (activeId) selectChat(activeId)
  // terminals no chat claims (the chat was closed while the app was away, or never saved) would run for ever
  if (savedOk && listed) for (const id of running) if (!claimed.has(id) || !st().chats.some((c) => c.id === id)) window.api.pty.kill(id)
  persistChats = true
  saveOpenChats()
  useStore.subscribe((s, prev) => {
    if (s.chats !== prev.chats || s.activeChatId !== prev.activeChatId || s.chatLayouts !== prev.chatLayouts) saveOpenChats()
  })
}

/** The native page of each Web tab, by tab id (registered by the tab's Browser component). */
export const pageLabels = new Map<string, string>()

export function reloadBrowserTab(id: string): void {
  const label = pageLabels.get(id)
  if (label) window.api.browser.reload(label)
}

export function setBrowserTabMuted(key: string, id: string, muted: boolean): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    if (!b) return s
    return { browsers: { ...s.browsers, [key]: { ...b, tabs: b.tabs.map((t) => (t.id === id ? { ...t, muted } : t)) } } }
  })
  const label = pageLabels.get(id)
  if (label) window.api.browser.setMuted(label, muted)
}

export function toggleBrowserTabPin(key: string, id: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    if (!b) return s
    const tabs = b.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))
    return { browsers: { ...s.browsers, [key]: { ...b, tabs: [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)] } } }
  })
}

/** A new tab right after `id` in the strip: its page is `url` (blank when none). */
export function openTabToRight(key: string, id: string, url?: string): void {
  const strip = (st().browsers[key]?.tabs ?? []).filter((t) => !t.detached)
  const at = strip.findIndex((t) => t.id === id)
  newBrowserTab(key, url, false)
  const created = st().browsers[key]?.active
  if (created && at >= 0) moveBrowserTab(key, created, at + 1)
}

export function closeOtherBrowserTabs(key: string, id: string): void {
  const others = (st().browsers[key]?.tabs ?? []).filter((t) => !t.detached && t.id !== id)
  for (const t of others) closeBrowserTab(key, t.id)
}

export function closeBrowserTabsToRight(key: string, id: string): void {
  const strip = (st().browsers[key]?.tabs ?? []).filter((t) => !t.detached)
  const at = strip.findIndex((t) => t.id === id)
  for (const t of strip.slice(at + 1)) closeBrowserTab(key, t.id)
}

/**
 * Group by chat / Singleton: switching merges the tabs (nothing is dropped). Singleton gathers every chat's
 * tabs into one set, each remembering its chat; back to Group by chat, each tab goes home to its chat again.
 */
export function setBrowserMode(shared: boolean): void {
  useStore.setState((s) => {
    if (s.browserShared === shared) return s
    const current = s.activeChatId ?? '_'
    const browsers: Record<string, ChatBrowser> = { ...s.browsers }
    if (shared) {
      const keys = Object.keys(browsers).filter((k) => k !== SHARED_BROWSER_KEY && k !== PAGES_KEY)
      const tabs = keys.flatMap((k) => (browsers[k]?.tabs ?? []).map((t) => ({ ...t, home: t.home ?? k })))
      const wanted = browsers[current]?.active
      for (const k of keys) delete browsers[k]
      if (tabs.length) browsers[SHARED_BROWSER_KEY] = { tabs, active: tabs.find((t) => t.id === wanted)?.id ?? tabs[0].id }
    } else {
      const merged = browsers[SHARED_BROWSER_KEY]
      delete browsers[SHARED_BROWSER_KEY]
      if (merged) {
        const groups = new Map<string, WebTab[]>()
        for (const t of merged.tabs) {
          const home = t.home ?? current
          const { home: _home, ...rest } = t
          groups.set(home, [...(groups.get(home) ?? []), rest])
        }
        for (const [k, tabs] of groups) {
          const existing = browsers[k]?.tabs ?? []
          const all = [...existing, ...tabs.filter((t) => !existing.some((e) => e.id === t.id))]
          browsers[k] = { tabs: all, active: tabs.find((t) => t.id === merged.active)?.id ?? all[0].id }
        }
      }
    }
    return { browserShared: shared, browsers }
  })
  saveBrowserShared(shared)
}

/** Open chats grouped by AI tool and worktree folder (one group per pair), in the order they were opened. */
export interface AgentGroup {
  key: string
  agent: AgentId
  cwd: string
  chats: Chat[]
}
export function agentGroups(chats: Chat[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>()
  for (const c of chats) {
    const agent = agentDef(c.agent).id
    const key = `${agent}\n${c.cwd}`
    const g = groups.get(key) ?? { key, agent, cwd: c.cwd, chats: [] }
    g.chats.push(c)
    groups.set(key, g)
  }
  return [...groups.values()]
}

/** Alt+Shift+Up / Alt+Shift+Down: the previous or next open agent, in the order the agents panel shows them. */
export function cycleAgent(step: 1 | -1): void {
  const list = agentGroups(st().chats).flatMap((g) => g.chats)
  if (!list.length) return
  const i = list.findIndex((c) => c.id === st().activeChatId)
  selectChat(list[(i < 0 ? 0 : i + step + list.length) % list.length].id)
}

/** Alt+Up / Alt+Down: the first agent of the previous or next group (AI tool + worktree). */
export function cycleAgentGroup(step: 1 | -1): void {
  const groups = agentGroups(st().chats)
  if (!groups.length) return
  const active = st().activeChatId
  const at = groups.findIndex((g) => g.chats.some((c) => c.id === active))
  const next = groups[(at < 0 ? 0 : at + step + groups.length) % groups.length]
  if (next.chats[0]) selectChat(next.chats[0].id)
}
