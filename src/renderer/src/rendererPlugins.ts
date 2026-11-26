import { COMMANDS, type Command } from './shortcuts'

export interface RendererPluginApi {
  addCommand(command: Command): void
  notify(text: string): void
}

/** Every plugin's renderer module (plugins/<id>/ui.js), bundled with the app and loaded at boot. */
const modules = import.meta.glob<{ activate?: (api: RendererPluginApi) => void }>('../../../plugins/*/ui.js', { eager: true })

export function loadRendererPlugins(): void {
  const api: RendererPluginApi = {
    addCommand: (command) => {
      if (!COMMANDS.some((c) => c.id === command.id)) COMMANDS.push(command)
    },
    notify: (text) => window.alert(text)
  }
  for (const [path, mod] of Object.entries(modules)) {
    try {
      mod.activate?.(api)
    } catch (e) {
      console.error('renderer plugin failed to start:', path, e)
    }
  }
}
