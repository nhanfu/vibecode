import { useState } from 'react'
import { Compass } from 'lucide-react'

/** Sites whose /favicon.ico did not load: not asked again this session. */
const noIcon = new Set<string>()

/** The origin of an http(s) page, or null (a blank tab, a file, a bad URL). */
function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

/**
 * The little picture at the start of a web tab: the site's own favicon (its /favicon.ico, fetched
 * straight from the site and never through a third party), else a compass.
 */
export function SiteIcon({ url, size = 14 }: { url: string; size?: number }): React.JSX.Element {
  const origin = originOf(url)
  const [, bump] = useState(0)
  if (!origin || noIcon.has(origin)) return <Compass className="site-icon" size={size} />
  return (
    <img
      className="site-icon"
      src={`${origin}/favicon.ico`}
      width={size}
      height={size}
      alt=""
      draggable={false}
      referrerPolicy="no-referrer"
      onError={() => {
        noIcon.add(origin)
        bump((n) => n + 1)
      }}
    />
  )
}
