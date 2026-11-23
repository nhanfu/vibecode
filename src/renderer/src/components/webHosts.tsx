import { useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { BrowserTab } from './Browser'
import { browserKey } from '../actions'
import { panelShown, useStore } from '../store'

/*
 * A web tab's page (its address bar and the native view behind it) is built once, inside a host
 * element that belongs to no panel. A pane in the Web drop-down, or the panel of a tab torn off
 * into its own title-bar button, only adopts that element, so moving a tab between the two never
 * rebuilds the page (it would reload).
 */
const hosts = new Map<string, HTMLElement>()

function hostOf(tabId: string): HTMLElement {
  let h = hosts.get(tabId)
  if (!h) {
    h = document.createElement('div')
    h.style.display = 'contents'
    hosts.set(tabId, h)
  }
  return h
}

/** An empty pane that takes the tab's page into itself while it is mounted. */
export function Adopt({ tabId, className }: { tabId: string; className?: string }): React.JSX.Element {
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) el.appendChild(hostOf(tabId))
    },
    [tabId]
  )
  return <div ref={ref} className={className} />
}

/** Every tab of every chat, mounted for as long as the tab exists, wherever its pane is. */
export function TabHosts(): React.JSX.Element {
  const browsers = useStore((s) => s.browsers)
  const activeChatId = useStore((s) => s.activeChatId)
  const pinned = useStore((s) => s.pinned)
  const floatOpen = useStore((s) => s.floatOpen)
  const peek = useStore((s) => s.peek)
  const fullscreen = useStore((s) => s.fullscreen)
  const panels = { pinned, floatOpen, peek, fullscreen }
  const webShown = panelShown(panels, 'web')
  const current = browserKey(activeChatId)

  const live = new Set(Object.values(browsers).flatMap((b) => b.tabs.map((t) => t.id)))
  useEffect(() => {
    for (const id of hosts.keys()) {
      if (!live.has(id)) {
        hosts.get(id)?.remove()
        hosts.delete(id)
      }
    }
  })

  return (
    <>
      {Object.entries(browsers).flatMap(([key, b]) =>
        b.tabs.map((t) =>
          createPortal(
            <BrowserTab
              chatKey={key}
              tabId={t.id}
              active={t.id === b.active}
              detached={!!t.detached}
              onScreen={t.detached ? panelShown(panels, `page:${t.id}`) : webShown && key === current}
            />,
            hostOf(t.id),
            t.id
          )
        )
      )}
    </>
  )
}
