/** Small per-machine preferences kept in localStorage; every access survives storage being blocked. */
export function load<T>(key: string, parse: (v: string) => T, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : parse(v)
  } catch {
    return fallback
  }
}

export function save(key: string, v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(key)
    else localStorage.setItem(key, v)
  } catch {
    /* back to the default next time */
  }
}
