import { syncPluginPanels, useStore } from './store'
import type { PluginInfo } from '../../shared/types'

const st = useStore.getState

/* ---------------- Theme ---------------- */

/** The theme the app shows: 'light' and 'dark' as chosen; 'system' follows the OS. */
export type ThemeChoice = 'light' | 'dark' | 'system'

function osPrefersLight(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches
  } catch {
    return false
  }
}

/** Dark (slate-blue, the default) or light; pushes it to the page, the terminals, the editor and see-through. */
export function applyTheme(): void {
  const choice = (st().settings?.theme as ThemeChoice | undefined) ?? 'system'
  const light = choice === 'light' || (choice === 'system' && osPrefersLight())
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
    if (st().themeResolved !== (light ? 'light' : 'dark')) useStore.setState({ themeResolved: light ? 'light' : 'dark' })
  applyGlass()
}

// 'system': the OS switching light/dark switches the app too
try {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ((st().settings?.theme ?? 'system') === 'system') applyTheme()
  })
} catch {
  /* no media queries: the choice stays as it was */
}

export async function setTheme(theme: ThemeChoice): Promise<void> {
  const settings = await window.api.app.setSettings({ theme }).catch(() => null)
  if (settings) useStore.setState({ settings })
  applyTheme()
}

export async function toggleTheme(): Promise<void> {
  await setTheme(st().themeResolved === 'light' ? 'dark' : 'light')
}

/* ---------------- See-through (Linux-style overlay) ---------------- */

const GLASS_VARS = ['--bg-0', '--bg-1', '--bg-2', '--bg-term', '--frame', '--band', '--band-2']

/**
 * In see-through mode the window itself is transparent; fade the page's backgrounds so the
 * desktop shows through while text stays fully solid. The base layer gets the chosen opacity,
 * panels on top only a tint so stacked layers don't add back up to solid. Below 50% the text
 * gets a heavier halo (data-glass-low) so it stays readable over any wallpaper.
 */
export function applyGlass(): void {
  const root = document.documentElement
  for (const v of GLASS_VARS) root.style.removeProperty(v)
  document.body.style.removeProperty('background')
  const s = st().settings
  const on = !!s?.seeThrough
  const light = root.dataset.theme === 'light'
  // a soft halo keeps text readable whatever shows through (light halo for dark text, and vice versa)
  if (on) root.dataset.glass = light ? 'light' : 'dark'
  else delete root.dataset.glass
  if (!on || !s) {
    delete root.dataset.glassLow
    return
  }
  const a = Math.min(1, Math.max(0.05, s.dropOpacity))
  if (a < 0.5) root.dataset.glassLow = ''
  else delete root.dataset.glassLow
  const cs = getComputedStyle(root)
  const read = (v: string): string => cs.getPropertyValue(v).trim()
  const base = read('--frame') || read('--bg-0')
  const mix = (c: string, k: number): string => `color-mix(in srgb, ${c} ${Math.round(Math.min(1, k) * 100)}%, transparent)`
  document.body.style.background = mix(base, a)
  // light panels need a bit more body than dark ones: dark text over a dark desktop is the hard case
  const panel = light ? 0.6 : 0.45
  // the terminal and editor are dense text drawn on a canvas (no halo possible): keep a floor
  // under them so they stay readable however see-through the rest of the window is
  const floor: Record<string, number> = light ? { '--bg-term': 0.5, '--bg-2': 0.45 } : { '--bg-term': 0.35, '--bg-2': 0.3 }
  for (const v of GLASS_VARS) {
    const c = read(v)
    if (c) root.style.setProperty(v, mix(c, Math.max(a * panel, floor[v] ?? 0)))
  }
}

useStore.subscribe((s, prev) => {
  if (s.settings !== prev.settings) applyTheme()
})

/* ---------------- Plugins ---------------- */

export async function loadPlugins(): Promise<void> {
  const plugins: PluginInfo[] = await window.api.plugins.list().catch(() => [])
  useStore.setState({ plugins })
  syncPluginPanels(plugins)
}
