import { invoke } from './nativeBridge'

/** Sends the page's uncaught errors to the terminal (native `client_log`), so a blank window can be diagnosed. */
export function reportErrors(): void {
  const send = (message: string): void => {
    void invoke('client_log', { message }).catch(() => {})
  }
  window.addEventListener('error', (e) => send(`error: ${e.message} at ${e.filename}:${e.lineno}`))
  window.addEventListener('unhandledrejection', (e) => send(`rejection: ${String(e.reason)}`))
}

reportErrors()
