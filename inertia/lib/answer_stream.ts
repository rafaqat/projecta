import { FrameDecoder, type AnswerEvent } from '../../app/assistant/protocol'

/**
 * Client side of the answer protocol: one POST, one SSE body, one decoder.
 * Frames that do not decode to a member of the closed union are dropped.
 */
export interface TurnBody {
  question: string
  threadHandle?: string
  regenerate?: { turnHandle: string; invalidEntities: string[] }
}

export interface StreamHandle {
  abort(): void
  done: Promise<void>
}

export function xsrfToken(): string {
  const match = /XSRF-TOKEN=([^;]+)/.exec(document.cookie)
  return match ? decodeURIComponent(match[1]) : ''
}

/**
 * The session no longer authorises this request. An `/api/` route answers 401; if a redirect was
 * issued instead, `fetch` followed the 302 and the final response is an HTML page from another
 * path (`redirected` is true). Either way what we asked for is gone and the client must re-auth.
 */
export function sessionExpired(response: Response): boolean {
  return response.status === 401 || response.redirected
}

/**
 * Re-authenticate in a full-window navigation (not an XHR): the server bounces the document
 * through the identity provider — silent while the SSO session is valid — and returns to this
 * page with a fresh session. Guarded so it fires once.
 */
let reauthenticating = false
export function reauthenticate(): void {
  if (reauthenticating) return
  reauthenticating = true
  // Observable for tests, and a seam for a future in-app re-auth; the default is a reload that
  // bounces the document through the identity provider and back.
  window.dispatchEvent(new Event('cia:reauthenticate'))
  window.location.reload()
}

export function streamTurn(
  url: string,
  body: TurnBody,
  onEvent: (event: AnswerEvent) => void,
  onRejected: (message: string, suggestedQuestions?: string[]) => void,
  /** The build the server answered with; the page reloads when it is not the one it rendered with. */
  onVersion?: (version: string) => void
): StreamHandle {
  const controller = new AbortController()
  const done = (async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-XSRF-TOKEN': xsrfToken(),
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal: controller.signal,
    })
    if (sessionExpired(response)) {
      reauthenticate()
      return
    }
    if (response.status === 422) {
      const payload = (await response.json()) as {
        errors: Array<{ message: string; suggestedQuestions?: string[] }>
      }
      onRejected(payload.errors[0]?.message ?? 'rejected', payload.errors[0]?.suggestedQuestions)
      return
    }
    if (!response.ok || !response.body) {
      onRejected(`request failed (${response.status})`)
      return
    }
    const version = response.headers.get('X-Assets-Version')
    if (version) onVersion?.(version)
    const reader = response.body.getReader()
    const decoder = new FrameDecoder()
    const text = new TextDecoder()
    for (;;) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      for (const event of decoder.push(text.decode(value, { stream: true }))) onEvent(event)
    }
  })()
  return { abort: () => controller.abort(), done }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
