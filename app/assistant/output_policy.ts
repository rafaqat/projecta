/**
 * Outbound text rules shared by server and client. Pure module:
 * text is normalised (NFKC, zero-width characters removed) before any rule
 * runs, so look-alike hosts and hidden characters cannot slip past. Links
 * render only for allowlisted hosts with the full domain visible; command
 * blocks that fetch from the network or pipe into a shell are flagged.
 */
export const LINK_HOST_ALLOWLIST = [
  'github.com',
  'www.npmjs.com',
  'nodejs.org',
  'developer.mozilla.org',
]

const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF\u00AD]/g

export function normaliseText(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH, '')
}

export type LinkDecision = { render: 'link'; host: string; href: string } | { render: 'text' }

export function linkDecision(
  href: string,
  allowlist: string[] = LINK_HOST_ALLOWLIST
): LinkDecision {
  let url: URL
  try {
    url = new URL(normaliseText(href))
  } catch {
    return { render: 'text' }
  }
  if (url.protocol !== 'https:' || url.username || url.password) return { render: 'text' }
  const host = url.hostname.toLowerCase()
  return allowlist.includes(host)
    ? { render: 'link', host, href: url.toString() }
    : { render: 'text' }
}

const NETWORK = /\b(curl|wget|nc|ncat|netcat|ssh|scp|ftp|telnet|Invoke-WebRequest|iwr)\b/
const PIPE_TO_SHELL =
  /\|\s*(sudo\s+)?(ba|z|da|k|)sh\b|\|\s*(sudo\s+)?(python|perl|ruby|node)\b|\beval\s*\(|\bbase64\s+(-d|--decode)\b/

export interface CommandFlag {
  flagged: boolean
  reasons: string[]
}

export function flagCommand(block: string): CommandFlag {
  const text = normaliseText(block)
  const reasons: string[] = []
  if (NETWORK.test(text)) reasons.push('network command')
  if (PIPE_TO_SHELL.test(text)) reasons.push('pipes into a shell or interpreter')
  return { flagged: reasons.length > 0, reasons }
}
