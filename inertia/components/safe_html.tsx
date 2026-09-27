import DOMPurify, { type Config } from 'dompurify'

/**
 * The only component permitted to set inner HTML (INV-06). It exists
 * for syntax-highlighter output, whose markup is sanitised on every render.
 * Scripts, event handlers, forms, iframes and resource-loading elements
 * (img/media/link) are removed, so rendered output cannot fetch a third-party
 * resource and leak the reader's IP or referrer; only http(s) links remain.
 */
const PROFILE: Config = {
  USE_PROFILES: { html: true },
  // Highlighter output is span/code/pre with class names, so forbidding every resource-loading
  // element costs nothing and closes the external-fetch/tracking vector the URI allowlist alone left open.
  FORBID_TAGS: [
    'style',
    'form',
    'input',
    'button',
    'iframe',
    'object',
    'embed',
    'svg',
    'math',
    'img',
    'picture',
    'source',
    'video',
    'audio',
    'track',
    'link',
    'base',
    'map',
    'area',
  ],
  FORBID_ATTR: ['style', 'srcset', 'formaction', 'src', 'poster', 'background'],
  ALLOWED_URI_REGEXP: /^(?:https?:)?\/\//i,
}

export function SafeHtml({ html, className }: { html: string; className?: string }) {
  const sanitised = DOMPurify.sanitize(html, PROFILE)
  return <div className={className} dangerouslySetInnerHTML={{ __html: sanitised }} />
}
