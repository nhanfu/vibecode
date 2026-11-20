import { useEffect, useState } from 'react'

/**
 * A list read from a chat's session (its background tasks, its sub-agents): read again as the
 * transcript changes, and every few seconds while `busy` says one of them is still running.
 * `read` and `busy` must be stable (module-level) functions.
 */
export function useSessionFeed<T>(sessionId: string | undefined, read: (sessionId: string) => Promise<T[]>, busy: (list: T[]) => boolean): T[] {
  const [list, setList] = useState<T[]>([])
  useEffect(() => {
    setList([])
    if (!sessionId) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    const load = (): void => {
      read(sessionId)
        .then((next) => {
          if (!alive) return
          // same list (a poll while nothing changed): no re-render
          setList((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
          // running ones write output without touching the transcript: keep looking
          clearInterval(poll)
          if (busy(next)) poll = setInterval(load, 3000)
        })
        .catch(() => {})
    }
    load()
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
