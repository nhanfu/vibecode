// Types shared by the native backend (native/src/commands) and the renderer.

export type WindowMode = 'window' | 'dropdown'
export type ThemePref = 'system' | 'light' | 'dark' | 'blue'

export interface AppSettings {
  mode: WindowMode
  hotkey: string
  /** drop-down height as a fraction of the screen work area */
  dropHeight: number
  dropOpacity: number
  hideOnBlur: boolean
  theme: ThemePref
  /** Linux-style overlay: transparent window background, text stays solid (needs a relaunch) */
  seeThrough: boolean
  /** start (hidden in the tray) when Windows signs in — undefined = on */
  openAtLogin?: boolean
}

export interface WindowState {
  mode: WindowMode
  maximized: boolean
  hotkey: string
  hotkeyOk: boolean
}

/** A plugin found on this machine (plugins/<id>/plugin.json, see docs/plugins.md). */
export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  license: string
  homepage: string
  /** a panel the plugin brings (`replaces` is no longer read: there are no built-in panels left to take over) */
  panel: { title: string; icon: string; replaces?: string; folder?: boolean } | null
  /** ready to run (its program is built / installed) */
  available: boolean
  /** brings an MCP server to every chat */
  mcp: boolean
  mcpName: string | null
  /** bundled with the app, installed by the user, or from $VIBE_PLUGINS_DIR */
  source: 'bundled' | 'user' | 'dev'
  /** hides a copy of the same id found in another folder */
  overrides: boolean
  enabled: boolean
  hasSidecar: boolean
  /** opens a program of its own (the Open button): see docs/plugins.md, `launch` */
  hasLaunch: boolean
  /** a native library the app loads into its process, and the command its panel runs (see docs/plugins.md) */
  native: { library: string; command: string[] } | null
  /** has a settings file the command palette can open */
  hasSettings: boolean
  /** starts with the app */
  autostart: boolean
  status: 'running' | 'starting' | 'stopped' | 'error' | 'disabled' | 'unavailable' | 'ready'
  /** why it is unavailable or failed */
  error: string | null
  port: number | null
  platforms: string[]
}

/** A plugin on offer in the registry's index.json. */
export interface PluginOffer {
  id: string
  name: string
  version: string
  description: string
  license: string
  homepage: string
  /** the .zip / .tar.gz to install from */
  url: string
  sha256: string | null
  minAppVersion: string
  platforms: string[]
  /** works on this system and app version */
  compatible: boolean
}
