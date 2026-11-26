import { Suspense, lazy, useEffect } from 'react'
import { FileDiff, X } from 'lucide-react'
import { useStore } from '../store'
import { closeTab } from '../actions'
import { FileIcon } from './icons'
import { EditorFontButton } from './EditorFont'

// Monaco (~4 MB) loads the first time the popup opens
const FileEditor = lazy(() => import('./MonacoViews').then((m) => ({ default: m.FileEditor })))
const DiffView = lazy(() => import('./MonacoViews').then((m) => ({ default: m.DiffView })))

/** The file editor for a popup beside the Files explorer: the same editor as the overlay, without its backdrop. */
export function InlineFile({ tabId }: { tabId: string }): React.JSX.Element | null {
  const tab = useStore((s) => s.tabs.find((t) => t.id === tabId))
  if (!tab || tab.kind !== 'file') return null
  return (
    <>
      <div className="review-head">
        <FileIcon name={tab.title} size={14} />
        <span className="review-title">{tab.title}</span>
        <span className="review-spacer" />
        <EditorFontButton />
        <button className="icon-btn" title="Close the file" onClick={() => void closeTab(tab.id)}>
          <X size={15} />
        </button>
      </div>
      <div className="editor-body">
        <Suspense fallback={null}>
          <div className="editor-layer on">
            <FileEditor tab={tab} />
          </div>
        </Suspense>
      </div>
    </>
  )
}

/**
 * Reviewing and editing one file or one change, in a popup over the app. It is what a click on a
 * file or a change shows when the VS Code plugin is not there to do it (see `review` in actions.ts):
 * `tabs` holds the one file on show, and closing the popup closes it (asking first about unsaved
 * edits). Esc, a click outside it or Ctrl+W close it.
 */
export function ReviewPopup(): React.JSX.Element | null {
  const tab = useStore((s) => s.tabs[0])
  const inline = useStore((s) => s.inlineTab)
  const id = tab?.id
  // Esc, from wherever the cursor is, unless the editor used it (to close its find box, a suggestion…)
  useEffect(() => {
    if (!id) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) void closeTab(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id])
  // a file shown in the Files explorer's popup (InlineFile) is not in the overlay as well
  if (!tab || tab.id === inline) return null
  const close = (): void => void closeTab(tab.id)
  return (
    <div className="overlay review-overlay" onMouseDown={close}>
      <div className="review-popup" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={tab.title}>
        <div className="review-head">
          {tab.kind === 'diff' ? <FileDiff size={14} color="#5aa9ff" /> : <FileIcon name={tab.title} size={14} />}
          <span className="review-title">{tab.title}</span>
          {tab.kind === 'diff' && <span className="tab-tag">{tab.commit ? 'commit' : 'changes'}</span>}
          <span className="review-spacer" />
          <EditorFontButton />
          <button className="icon-btn" title="Close (Esc)" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="editor-body">
          <Suspense fallback={null}>
            <div className="editor-layer on">{tab.kind === 'file' ? <FileEditor tab={tab} /> : <DiffView tab={tab} />}</div>
          </Suspense>
        </div>
      </div>
    </div>
  )
}
