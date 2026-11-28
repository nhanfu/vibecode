import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Check, Copy, Droplet, Minus, Square, Sun, Moon, X, ChevronDown, ChevronUp, Monitor } from 'lucide-react'
import { useStore } from '../store'
import { StackBar } from './Stack'
import { setTheme, toggleTheme, type ThemeChoice } from '../actions'

/* ================================ Title bar ================================ */

/** Empty parts of the title bar move the window (the drop-down stays pinned to the top edge). */
const NO_DRAG = 'button, input, a, kbd, .menu, .win-controls'
// A double-click is handled here (e.detail === 2), not in onDoubleClick: once the first click
// has started a native drag, Windows maximizes on the second click by itself, and a separate
// dblclick handler then toggled it straight back — the window flickered and the
// maximize/restore button showed the wrong state.
function dragWindow(e: React.MouseEvent): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest(NO_DRAG)) return
  if (e.detail === 2) return window.api.win.toggleMaximize()
  window.api.win.drag(e.button, e.clientX, e.clientY)
}

export function TitleBar(): React.JSX.Element {

  return (
    <div className={window.api.platform === 'darwin' ? 'titlebar mac' : 'titlebar'} onMouseDown={dragWindow}>
      <div className="titlebar-left">
        <StackBar />
      </div>
      <div className="titlebar-right">
        <ThemeToggle />
        <WindowControls />
      </div>
    </div>
  )
}

/** Theme: a click goes light → dark → system → light, like DBX's own toolbar. */
const THEME_ORDER: ThemeChoice[] = ['light', 'dark', 'system']
const THEME_LABEL: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'System (follows the OS)' }
function ThemeToggle(): React.JSX.Element {
  const light = useStore((s) => s.themeResolved === 'light')
  const choice = useStore((s) => (s.settings?.theme as ThemeChoice | undefined) ?? 'system')
  const next = THEME_ORDER[(THEME_ORDER.indexOf(choice) + 1) % THEME_ORDER.length] ?? 'light'
  return (
    <button className="icon-btn" title={`Theme: ${THEME_LABEL[choice]} · click for ${THEME_LABEL[next]}`} onClick={() => void setTheme(next)}>
      {light ? <Moon size={15} /> : <Sun size={15} />}
    </button>
  )
}

/** Window opacity: a button that opens a slider (20–100%). */
function OpacityControl(): React.JSX.Element {
  const saved = useStore((s) => s.settings?.dropOpacity ?? 1)
  const seeThrough = useStore((s) => !!s.settings?.seeThrough)
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState(false)
  const [val, setVal] = useState(saved)
  const ref = useRef<HTMLDivElement>(null)
  // while the slider is open it shows what you drag, not a (possibly older) saved answer
  useEffect(() => {
    if (!open) setVal(saved)
  }, [saved, open])
  const saveSeq = useRef(0)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const save = async (v: number): Promise<void> => {
    setVal(v)
    const my = ++saveSeq.current
    const settings = await window.api.app.setSettings({ dropOpacity: v }).catch(() => null)
    // answers to earlier drags come back late: only the last one counts
    if (settings && my === saveSeq.current) useStore.setState({ settings })
  }
  return (
    <div className="opacity-ctl" ref={ref}>
      <button className={`icon-btn${open ? ' active' : ''}`} title={`Window opacity: ${Math.round(val * 100)}%`} onClick={() => setOpen(!open)}>
        <Droplet size={15} />
      </button>
      {open && (
        <div className="menu opacity-pop">
          <button
            className={`see-through${seeThrough ? ' on' : ''}`}
            onClick={async () => {
              const next = !seeThrough
              const msg = next
                ? 'See-through: the background turns transparent and text stays sharp, like a Linux overlay terminal.\n\nVIBE CODE has to restart.'
                : 'Turn off see-through? VIBE CODE has to restart.'
              if (!window.confirm(msg)) return
              const settings = await window.api.app.setSettings({ seeThrough: next }).catch(() => null)
              if (settings) useStore.setState({ settings })
              if (!(await window.api.app.relaunch())) setPending(true)
            }}
          >
            <span className="see-through-box">{seeThrough && <Check size={11} />}</span>
            See-through (Linux overlay)
          </button>
          {pending && <div className="opacity-note">Dev mode: stop and rerun npm run dev to apply.</div>}
          <div className="opacity-row">
            <span>{seeThrough ? 'Background' : 'Opacity'}</span>
            <b>{Math.round(val * 100)}%</b>
          </div>
          <input type="range" min={seeThrough ? 5 : 20} max={100} step={1} value={Math.round(val * 100)} onChange={(e) => save(Number(e.target.value) / 100)} />
          <div className="opacity-presets">
            {[0.3, 0.5, 0.75, 1].map((p) => (
              <button key={p} className={`chip${Math.abs(val - p) < 0.005 ? ' on' : ''}`} onClick={() => save(p)}>
                {Math.round(p * 100)}%
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ModeSwitch(): React.JSX.Element | null {
  const win = useStore((s) => s.win)
  if (!win) return null
  const drop = win.mode === 'dropdown'
  return (
    <button
      className={`mode-switch${drop ? ' on' : ''}`}
      title={drop ? 'Switch to a normal window' : `Drop-down mode: ${win.hotkey} slides VIBE CODE over any app`}
      onClick={() => window.api.win.setMode(drop ? 'window' : 'dropdown')}
    >
      <ArrowDownToLine size={13} />
      <span>{drop ? 'Drop-down' : 'Guake'}</span>
      {win.hotkeyOk && <kbd>{win.hotkey}</kbd>}
    </button>
  )
}

function WindowControls(): React.JSX.Element | null {
  const win = useStore((s) => s.win)
  if (!win) return null
  // macOS draws its own traffic lights (top-left) — ours would be a second set
  if (window.api.platform === 'darwin' && win.mode !== 'dropdown') return null
  return (
    <div className="win-controls">
      <button className="win-btn" title="Minimize" onClick={() => window.api.win.minimize()}>
        <Minus size={15} />
      </button>
      <button className="win-btn" title={win.maximized ? 'Restore' : 'Maximize'} onClick={() => window.api.win.toggleMaximize()}>
        {win.maximized ? <Copy size={12} style={{ transform: 'scaleX(-1)' }} /> : <Square size={12} />}
      </button>
      <button className="win-btn close" title="Close" onClick={() => window.api.win.close()}>
        <X size={16} />
      </button>
    </div>
  )
}

/* ================================ Status bar ================================ */

/** "1:00 PM" today, "Fri 3:00 AM" later in the week. */
