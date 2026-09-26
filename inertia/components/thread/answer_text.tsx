import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import { MARKER, splitMarkers, type InlineKind } from '../../../app/assistant/answer_layout'
import { flagCommand, linkDecision } from '../../../app/assistant/output_policy'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, string> }
}

/**
 * Inline citation and verification markers (answer_layout.ts) become `span` elements tagged with
 * what they stand for; `renderInline` draws them. Markers inside code stay text-free: they are
 * never placed inside an open fence, and inline code is left untouched.
 */
function inlineMarkers() {
  const walk = (node: MdNode) => {
    if (!node.children) return
    const out: MdNode[] = []
    for (const child of node.children) {
      if (child.type === 'text' && child.value?.includes(MARKER)) {
        for (const part of splitMarkers(child.value)) {
          if (typeof part === 'string') out.push({ type: 'text', value: part })
          else
            out.push({
              type: 'inlineMarker',
              data: {
                hName: 'span',
                hProperties: { dataInlineKind: part.kind, dataInlineRef: part.ref },
              },
            })
        }
      } else {
        walk(child)
        out.push(child)
      }
    }
    node.children = out
  }
  return (tree: MdNode) => walk(tree)
}

/**
 * Model text rendered as markdown with raw HTML disabled. Links
 * become anchors only for allowlisted hosts, with the full domain shown;
 * everything else is inert text. Command blocks that fetch or pipe into a
 * shell carry a flag. The rules evaluate a normalised copy (NFKC, zero-width
 * removed); the text on screen is the released bytes (WP-19, BL-02).
 */
export function AnswerText({
  text,
  kind,
  renderInline,
}: {
  text: string
  kind: 'text' | 'background'
  /** Draws an inline citation chip or verification icon; absent, markers render nothing. */
  renderInline?: (kind: InlineKind, ref: string) => ReactNode
}) {
  return (
    <div
      className={kind === 'background' ? 'background-segment' : 'answer-text'}
      data-segment={kind}
    >
      {kind === 'background' ? <span className="badge badge-muted">Background</span> : null}
      <Markdown
        skipHtml
        remarkPlugins={[inlineMarkers]}
        components={{
          span: ({ node: _node, children, ...props }) => {
            const inlineKind = (props as Record<string, unknown>)['data-inline-kind']
            const inlineRef = (props as Record<string, unknown>)['data-inline-ref']
            if (
              inlineKind === 'citation' ||
              inlineKind === 'verification' ||
              inlineKind === 'pills'
            )
              return renderInline ? <>{renderInline(inlineKind, String(inlineRef))}</> : null
            return <span {...props}>{children}</span>
          },
          a: ({ href, children }) => {
            const decision = linkDecision(href ?? '')
            if (decision.render === 'text') return <span className="inert-link">{children}</span>
            return (
              <a href={decision.href} rel="noopener noreferrer nofollow">
                {children} <span className="muted">({decision.host})</span>
              </a>
            )
          },
          code: ({ className, children }) => {
            const source = String(children)
            const block = className?.startsWith('language-') || source.includes('\n')
            if (!block) return <code>{source}</code>
            const flag = flagCommand(source)
            return (
              <div className="code-block" data-flagged={String(flag.flagged)}>
                {flag.flagged ? (
                  <span className="badge badge-bad">Flagged: {flag.reasons.join(', ')}</span>
                ) : null}
                <pre>
                  <code>{source}</code>
                </pre>
              </div>
            )
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}
