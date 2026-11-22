/**
 * The page's door to the native backend: zero-native's `window.zero` bridge. Each command is a
 * Zig handler registered in native/src/commands/registry.zig, called by the same name the Tauri
 * build used, with the same argument object.
 */
type ZeroBridge = { invoke(command: string, payload: unknown): Promise<unknown> }

export function invoke<T = unknown>(command: string, payload?: Record<string, unknown> | null): Promise<T> {
  const zero = (window as unknown as { zero?: ZeroBridge }).zero
  if (!zero) return Promise.reject(new Error('native bridge is not available'))
  return zero.invoke(command, payload ?? null) as Promise<T>
}

/** Bytes as base64, for a command payload (zero-native payloads are JSON, not raw bodies). */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}
