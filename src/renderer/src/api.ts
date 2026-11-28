/**
 * `window.api`: the renderer's only door to the native backend. Every call is a command (`invoke`), and
 * every `on…` is an event from the backend.
 */
import { invoke, listen } from './nativeBridge'
import type { AppSettings, PluginInfo, PluginOffer, WindowMode, WindowState } from '../../shared/types'

type Off = () => void

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): Off {
  return listen<T>(channel, cb)
}

const platform: 'win32' | 'darwin' | 'linux' = navigator.userAgent.includes('Windows') ? 'win32' : navigator.userAgent.includes('Mac') ? 'darwin' : 'linux'

export const api = {
  platform,
  plugins: {
    list: (): Promise<PluginInfo[]> => invoke('plugin_list'),
    /** starts the plugin's sidecar if needed; the address of its page */
    start: (id: string, light?: boolean): Promise<{ url: string; settings?: string }> => invoke('plugin_start', { id, light: light ?? null }),
    /** the plugin's settings file (created when missing) */
    settingsFile: (id: string): Promise<string> => invoke('plugin_settings_file', { id }),
    stop: (id: string): Promise<void> => invoke('plugin_stop', { id }),
    restart: (id: string): Promise<void> => invoke('plugin_restart', { id }),
    /** turn on / off, or choose whether it starts with the app */
    set: (id: string, patch: { enabled?: boolean; autostart?: boolean }): Promise<void> => invoke('plugin_set', { id, ...patch }),
    logs: (id: string): Promise<string[]> => invoke('plugin_logs', { id }),
    /** from a folder, a .zip / .tar.gz, or an https link to one; the plugin's id */
    install: (source: string, sha256?: string | null): Promise<string> => invoke('plugin_install', { source, sha256: sha256 ?? null }),
    uninstall: (id: string, purge: boolean): Promise<void> => invoke('plugin_uninstall', { id, purge }),
    registry: (): Promise<{ url: string; entries: PluginOffer[] }> => invoke('plugin_registry'),
    /** the registry address in use (`set` changes it; empty: back to the default) */
    registryUrl: (set?: string): Promise<string> => invoke('plugin_registry_url', { set })
  },
  win: {
    state: (): Promise<WindowState> => invoke('win_state'),
    minimize: (): void => void invoke('win_minimize'),
    toggleMaximize: (): void => void invoke('win_toggle_maximize'),
    drag: (button: number, x: number, y: number): void => void invoke('win_drag', { button, x, y }),
    close: (): void => void invoke('win_close'),
    setMode: (mode: WindowMode): void => void invoke('win_set_mode', { mode }),
    onState: (cb: (s: WindowState) => void): Off => on('win:state', cb)
  },
  app: {
    settings: (): Promise<AppSettings> => invoke('app_settings'),
    setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => invoke('app_set_settings', { patch }),
    openExternal: (url: string): Promise<void> => invoke('app_open_external', { url }),
    relaunch: (): Promise<boolean> => invoke('app_relaunch')
  }
}

declare global {
  interface Window {
    api: typeof api
  }
}

window.api = api
