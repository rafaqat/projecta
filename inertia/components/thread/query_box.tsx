import { useState } from 'react'
import { ArrowUp, GitBranch, GitCommitHorizontal, Square } from 'lucide-react'
import { formatUsd } from './answer'

/**
 * Layer 1 of: the box shows what can be asked (repository @ commit),
 * offers deterministic suggested questions from the index, and caps input.
 * No attachments: comparison uses "find similar" on a citation.
 */
export interface QueryBoxProps {
  repository: string
  commitSha: string | null
  suggestedQuestions: string[]
  inputCap: number
  busy: boolean
  onAsk: (question: string) => void
  onStop: () => void
  /** What the next question is likely to cost: the reader's recent turns, or the budgets. */
  estimate?: { usd: number; basis: 'recent' | 'budget'; priceVersion: string } | null
}

export function QueryBox({
  repository,
  commitSha,
  suggestedQuestions,
  inputCap,
  busy,
  onAsk,
  onStop,
  estimate,
}: QueryBoxProps) {
  const [question, setQuestion] = useState('')
  const submit = () => {
    if (question.trim() && !busy) {
      onAsk(question)
      setQuestion('')
    }
  }
  return (
    <form
      className="query-box mx-auto w-full max-w-[700px]"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {suggestedQuestions.length ? (
        <ul className="suggestions mb-2.5" data-suggested>
          {suggestedQuestions.map((q) => (
            <li key={q}>
              <button type="button" disabled={busy} onClick={() => onAsk(q)}>
                {q}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="card px-3.5 pb-2 pt-2.5">
        <textarea
          name="question"
          value={question}
          rows={2}
          disabled={!commitSha}
          placeholder={commitSha ? 'Ask a question about this repository' : 'Not indexed yet'}
          aria-label="Ask a question"
          className="w-full resize-none border-0 bg-transparent pb-2 text-[14px] text-content-primary outline-none placeholder:text-content-muted"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="outline-ring inline-flex h-6 min-w-0 items-center gap-1 whitespace-nowrap px-2 text-xs text-content-secondary"
            data-scope-pill
            title={`${repository}${commitSha ? ` @ ${commitSha.slice(0, 7)}` : ''}`}
          >
            <GitBranch className="h-3 w-3 shrink-0" />
            <code className="min-w-0 truncate">{repository}</code>
            <span className="shrink-0 text-content-muted">@</span>
            <GitCommitHorizontal className="h-3 w-3 shrink-0" />
            <code className="shrink-0">{commitSha ? commitSha.slice(0, 7) : 'not indexed'}</code>
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs text-content-muted">
            {estimate ? (
              <span
                className="mr-3"
                data-estimate={estimate.usd}
                title={
                  estimate.basis === 'recent'
                    ? `median of your recent questions here · prices ${estimate.priceVersion}`
                    : `from the answer budgets, before any question of yours · prices ${estimate.priceVersion}`
                }
              >
                ≈ {formatUsd(estimate.usd)} per question
              </span>
            ) : null}
            {question.length}/{inputCap}
          </span>
          <div className="flex-1" />
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              className="ghost outline-ring inline-flex h-7 items-center gap-1.5 px-2 text-content-primary"
            >
              <Square className="h-3 w-3 fill-current" />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Ask"
              disabled={!commitSha || !question.trim()}
              className="grid h-7 w-7 place-items-center rounded-lg bg-content-primary text-content-inverted disabled:opacity-35"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </form>
  )
}
