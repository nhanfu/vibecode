import { useEffect, useState } from 'react'

/** A list read again within this time is taken from the cache: hovering a group twice reads once */
const FRESH_MS = 5000
/** while something in the list is still running, it is read again this often */
const POLL_MS = 3000

interface Entry {
  list: unknown[]
  at: number
  inflight?: Promise<unknown[]>
}

/** Per reader (a module-level function), per session: the last list read and the read in progress. */
const caches = new WeakMap<object, Map<string, Entry>>()
const EMPTY: never[] = []

const cacheOf = (read: object): Map<string, Entry> => {
  let m = caches.get(read)
  if (!m) {
    m = new Map()
    caches.set(read, m)
  }
  return m
}

/** Reads a session's list, sharing one read in progress between every caller that asks for it. */
function readOnce<T>(read: (sessionId: string) => Promise<T[]>, sessionId: string): Promise<T[]> {
  const m = cacheOf(read)
  const e = m.get(sessionId)
  if (e?.inflight) return e.inflight as Promise<T[]>
  const p = read(sessionId).then((next) => {
    // same list as before: keep the old array, so nothing re-renders
    const prev = m.get(sessionId)?.list as T[] | undefined
    const list = prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next
    m.set(sessionId, { list, at: Date.now() })
    return list
  })
  m.set(sessionId, { list: e?.list ?? EMPTY, at: e?.at ?? 0, inflight: p })
  p.catch(() => m.set(sessionId, { list: e?.list ?? EMPTY, at: e?.at ?? 0 }))
  return p
}

/**
 * A list read from a chat's session (its background tasks, its sub-agents): read again as the
 * transcript changes, and every few seconds while `busy` says one of them is still running. The
 * last list is kept per session, so a component that mounts again shows it at once and reads only
 * when it is older than FRESH_MS. `read` and `busy` must be stable (module-level) functions.
 */
export function useSessionFeed<T>(sessionId: string | undefined, read: (sessionId: string) => Promise<T[]>, busy: (list: T[]) => boolean): T[] {
  const [list, setList] = useState<T[]>(() => (sessionId ? ((cacheOf(read).get(sessionId)?.list as T[] | undefined) ?? EMPTY) : EMPTY))
  useEffect(() => {
    if (!sessionId) {
      setList(EMPTY)
      return
    }
    const cached = cacheOf(read).get(sessionId)
    setList((cached?.list as T[] | undefined) ?? EMPTY)
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    const load = (): void => {
      readOnce(read, sessionId)
        .then((next) => {
          if (!alive) return
          setList(next)
          // running ones write output without touching the transcript: keep looking
          clearInterval(poll)
          if (busy(next)) poll = setInterval(load, POLL_MS)
        })
        .catch(() => {})
    }
    const fresh = cached && !cached.inflight && Date.now() - cached.at < FRESH_MS
    if (fresh) {
      if (busy(cached.list as T[])) poll = setInterval(load, POLL_MS)
    } else load()
    const off = window.api.sessions.onChanged((ids) => {
      if (!ids.includes(sessionId) && !ids.includes('*')) return
      clearTimeout(timer)
      timer = setTimeout(load, 700)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      clearInterval(poll)
      off()
    }
  }, [sessionId, read, busy])
  return list
}
