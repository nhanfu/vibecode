/**
 * The page's door to the native backend: zero-native's `window.zero` bridge. Each command is a
 * Zig handler registered in native/src/commands/registry.zig, called by the same name the Tauri
 * build used, with the same argument object.
 */
type ZeroBridge = {
  invoke(command: string, payload: unknown): Promise<unknown>
  on(name: string, callback: (detail: unknown) => void): () => void
  dialogs: { openFile(options: OpenFileOptions): Promise<unknown> }
}

export interface OpenFileOptions {
  title?: string
  defaultPath?: string
  allowDirectories?: boolean
  allowMultiple?: boolean
}

/** The desktop's open dialog (zero-native built-in). Resolves to the chosen paths, or null when cancelled. */
export async function openFileDialog(options: OpenFileOptions): Promise<string[] | null> {
  const result = await bridge().dialogs.openFile(options)
  return Array.isArray(result) ? (result as string[]) : null
}

function bridge(): ZeroBridge {
  const zero = (window as unknown as { zero?: ZeroBridge }).zero
  if (!zero) throw new Error('native bridge is not available')
  return zero
}

/** Subscribes to an event the backend sends (Zig `commands.emit`); the listener gets the event's arguments. */
export function listen<T extends unknown[]>(name: string, cb: (...args: T) => void): () => void {
  return bridge().on(name, (detail) => cb(...(detail as T)))
}

export function subscribe(name: string, cb: (detail: unknown) => void): () => void {
  return bridge().on(name, cb)
}

export function invoke<T = unknown>(command: string, payload?: Record<string, unknown> | null): Promise<T> {
  return bridge().invoke(command, payload ?? null).catch((error: unknown) => {
    throw new Error(`${command}: ${error instanceof Error ? error.message : String(error)}`)
  }).then((result) => {
    // a handler's own failure message (Tauri's Err(message)) arrives as { __error }
    if (result && typeof result === 'object' && '__error' in result) throw new Error(String((result as { __error: unknown }).__error))
    return result as T
  })
}

/** Bytes as base64, for a command payload (zero-native payloads are JSON, not raw bodies). */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

/**
 * Stream of messages from one backend call (terminal output). Until the terminal port lands, the
 * backend cannot send to it; the class only keeps the page's type and call shape.
 */
export class Channel<T> {
  onmessage: (message: T) => void = () => {}
}
