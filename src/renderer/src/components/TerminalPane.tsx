import { useEffect, useRef } from 'react'
import { panelShown, useStore, type PanelId } from '../store'

/**
 * A native terminal in a panel: the app draws it (a GTK widget over this window), so this element only reserves
 * the place. The pane is shown while the panel is shown (pinned, floating open, or full screen) and this element
 * is on the window; otherwise it is hidden. The program keeps running while the pane is hidden.
 */
export function TerminalPane({ command, panel }: { command: string[]; panel: PanelId }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // the CSS of a panel does not hide a native widget: the store says whether the panel is on screen
  const shown = useStore((s) => panelShown(s, panel))
  const place = useRef<() => void>(() => undefined)
  const key = command.join('\u0000')

  // the program starts the first time the pane is needed (opening again keeps the same pane)
  useEffect(() => {
    void window.api.terminal
      .open(command)
      .then(() => place.current())
      .catch(() => undefined)
    // the command is the pane's identity: a different command is a different pane
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // hidden when the pane goes away (a panel closed for good, or the app's page changed)
  useEffect(() => {
    return () => {
      void window.api.terminal.frame({ x: 0, y: 0, width: 0, height: 0, visible: false }).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let gone = false

    // the frame is sent only when it changed: it is a bridge call
    let last = ''
    place.current = (): void => {
      if (gone) return
      const r = el.getBoundingClientRect()
      // a panel sliding away keeps its size: the box must also be on the window, or the pane would be drawn
      // at the window's edge
      const onWindow = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight
      const visible = shown && onWindow
      const rect = { x: r.left, y: r.top, width: r.width, height: r.height, visible }
      const next = `${rect.x},${rect.y},${rect.width},${rect.height},${visible}`
      if (next === last) return
      last = next
      void window.api.terminal.frame(rect).catch(() => undefined)
    }
    const update = place.current
    update()

    const ro = new ResizeObserver(update)
    ro.observe(el)
    // a panel sliding in moves the element without resizing it: its transition end is the moment to look again
    document.addEventListener('transitionend', update, true)
    window.addEventListener('resize', update)

    return () => {
      gone = true
      ro.disconnect()
      document.removeEventListener('transitionend', update, true)
      window.removeEventListener('resize', update)
    }
  }, [shown])

  return <div ref={ref} className="terminal-pane" />
}
