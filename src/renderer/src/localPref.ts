/**
 * The user's preferences (theme, panel order and pins, …), kept in the browser's localStorage of the app.
 * Reads and writes never throw: storage can be blocked, and then the preference lasts for this run only.
 */
export const userStore = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  removeItem(key: string): void {
    try {
      localStorage.removeItem(key)
    } catch {
      /* nothing kept */
    }
  },
  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* not kept */
    }
  }
}
