import { invoke } from '@tauri-apps/api/core'

/**
 * The user's preferences and saved UI state (plans, open chats, panel sizes…). They live in the
 * DuckDB file in the data folder (see userdb.rs); this is a synchronous in-memory copy of it, loaded
 * once at startup by `hydrateUserStore()` and written back in the background. It has the shape of
 * `Storage`, so it replaces `localStorage` everywhere, including libraries that take one.
 */
const cache = new Map<string, string>()
const pending = new Map<string, string | null>()
let timer: ReturnType<typeof setTimeout> | null = null

/** Saved lists with a table of their own (plan_items, open_chats, web_pages); everything else is a key in ui_prefs. */
const TABLES: Record<string, string> = { 'vibe.plansTasks': 'plans', 'vibe.openChats': 'chats', 'vibe.pages': 'pages' }

function flush(): void {
  timer = null
  if (!pending.size) return
  const prefs: Record<string, string | null> = {}
  for (const [k, v] of pending) {
    const table = TABLES[k]
    if (table) invoke('userdb_save', { table, json: v ?? '[]' }).catch(() => {})
    else prefs[k] = v
  }
  pending.clear()
  if (Object.keys(prefs).length) invoke('userdb_prefs_write', { entries: prefs }).catch(() => {})
}

function queue(key: string, value: string | null): void {
  pending.set(key, value)
  timer ??= setTimeout(flush, 150)
}

/** Keys the page kept in localStorage before the database: copied across once. */
const LEGACY = /^(vibe\.|tinjs\.|vibe-|layout-|react-resizable-panels:)/
const MIGRATED = '_migrated'

export async function hydrateUserStore(): Promise<void> {
  // shells of a page that was reloaded are stopped; the chats' terminals keep running (in ptyd) and
  // the chats that come back attach to them
  await invoke('pty_page_reset').catch(() => {})
  try {
    const snap = await invoke<{ prefs: Record<string, string>; plans: string; chats: string; pages: string }>('userdb_snapshot')
    for (const [k, v] of Object.entries(snap.prefs)) cache.set(k, v)
    for (const [key, table] of Object.entries(TABLES)) {
      const v = snap[table as 'plans' | 'chats' | 'pages']
      if (v && v !== '[]') cache.set(key, v)
    }
  } catch {
    /* no database: preferences last for this run only */
  }
  if (cache.has(MIGRATED)) return
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      const v = k === null ? null : localStorage.getItem(k)
      if (k && v !== null && LEGACY.test(k) && !cache.has(k)) {
        cache.set(k, v)
        queue(k, v)
      }
    }
  } catch {
    /* storage unavailable */
  }
  cache.set(MIGRATED, '1')
  queue(MIGRATED, '1')
}

// the window can close inside the 150 ms: send what is waiting
window.addEventListener('pagehide', flush)

export const userStore = {
  getItem: (key: string): string | null => cache.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    cache.set(key, String(value))
    queue(key, String(value))
  },
  removeItem: (key: string): void => {
    cache.delete(key)
    queue(key, null)
  }
}

/** Small preferences; every access survives a missing database. */
export function load<T>(key: string, parse: (v: string) => T, fallback: T): T {
  try {
    const v = userStore.getItem(key)
    return v === null ? fallback : parse(v)
  } catch {
    return fallback
  }
}

export function save(key: string, v: string | null): void {
  if (v === null) userStore.removeItem(key)
  else userStore.setItem(key, v)
}
