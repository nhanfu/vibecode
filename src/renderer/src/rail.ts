/**
 * The agent sidebar's icon rail: each icon opens its group as a flyout. Clicks, hotkeys and other
 * parts of the app all ask for a group through openRail. A request made while the rail is not on
 * screen waits for it (AgentSplit takes it when it mounts).
 */
export type RailId = 'project' | 'agents' | 'plans'

/** toggle: a group that is already open closes; open: it opens (and stays open) */
export type RailMode = 'toggle' | 'open'

export interface RailRequest {
  id: RailId
  mode: RailMode
}

let pending: RailRequest | null = null

export function openRail(id: RailId, mode: RailMode = 'toggle'): void {
  pending = { id, mode }
  window.dispatchEvent(new CustomEvent<RailRequest>('rail-open', { detail: pending }))
}

/** The request waiting for the rail, cleared once taken. */
export function takeRailRequest(): RailRequest | null {
  const req = pending
  pending = null
  return req
}

/** Closes the flyout of one group (or whichever is open, with no id). */
export function closeRail(id?: RailId): void {
  window.dispatchEvent(new CustomEvent<RailId | undefined>('rail-close', { detail: id }))
}
