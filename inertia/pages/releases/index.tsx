import { Head } from '@inertiajs/react'
import { CircleCheck, Fingerprint, TriangleAlert } from 'lucide-react'
import { PageHeader } from '../../components/shell/page_header'

interface Props {
  workspace: { handle: string; name: string }
  configHash: string
  validatedByRun: string | null
  prompts: Array<{ id: string; version: number; sha256: string }>
  models: { answer: string; scopeClassifier: string }
  embedder: { id: string; revision: string }
  chunker: string
  evidence: string
  lexicalBackend: string
  detectors: { injection: string; redaction: string }
  tools: string[]
  assetsVersion?: string
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_minmax(0,1fr)] items-baseline gap-3 border-t border-line px-4 py-2.5 first:border-t-0">
      <span className="text-content-muted">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  )
}

export default function ReleasesIndex({
  workspace,
  configHash,
  validatedByRun,
  prompts,
  models,
  embedder,
  chunker,
  evidence,
  lexicalBackend,
  detectors,
  tools,
}: Props) {
  void workspace
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-page="releases">
      <Head title="Configuration" />
      <PageHeader
        title={
          <>
            <Fingerprint className="h-3.5 w-3.5 text-content-muted" />
            Configuration
            <span className="font-normal text-content-muted">
              the signed inputs behind every answer
            </span>
          </>
        }
      >
        {validatedByRun ? (
          <span className="badge badge-ok">
            <CircleCheck className="h-3 w-3" />
            Validated
          </span>
        ) : (
          <span className="badge badge-warn">
            <TriangleAlert className="h-3 w-3" />
            Not validated
          </span>
        )}
      </PageHeader>

      <div className="scroll flex-1">
        <div className="mx-auto max-w-[860px] px-6 py-6">
          <div className="overflow-hidden rounded-[10px] outline outline-1 outline-line">
            <Row label="Config hash">
              <code className="mono break-all text-content-primary">{configHash}</code>
            </Row>
            <Row label="Validated by run">
              {validatedByRun ? (
                <code className="mono text-content-secondary">{validatedByRun}</code>
              ) : (
                <span className="text-content-muted">
                  no eval run recorded this hash — the configuration is unvalidated
                </span>
              )}
            </Row>
            <Row label="Answer model">
              <code className="mono text-content-primary">{models.answer}</code>
            </Row>
            <Row label="Scope classifier">
              <code className="mono text-content-secondary">{models.scopeClassifier}</code>
            </Row>
            <Row label="Embedder">
              <code className="mono text-content-secondary">
                {embedder.id} · {embedder.revision.slice(0, 8)}
              </code>
            </Row>
            <Row label="Chunker">
              <code className="mono text-content-secondary">{chunker}</code>
            </Row>
            <Row label="Evidence mode">
              <code className="mono text-content-secondary">{evidence}</code>
            </Row>
            <Row label="Lexical backend">
              <code className="mono text-content-secondary">{lexicalBackend}</code>
            </Row>
            <Row label="Injection detector">
              <code className="mono text-content-secondary">{detectors.injection}</code>
            </Row>
            <Row label="Secret redaction">
              <code className="mono text-content-secondary">{detectors.redaction}</code>
            </Row>
            <Row label="Prompts">
              <span className="flex flex-wrap gap-1.5">
                {prompts.map((p) => (
                  <span key={p.id} className="badge" title={p.sha256}>
                    {p.id} v{p.version}
                  </span>
                ))}
              </span>
            </Row>
            <Row label="Model tools">
              <span className="flex flex-wrap gap-1.5">
                {tools.map((t) => (
                  <code
                    key={t}
                    className="mono rounded bg-hover px-1.5 py-0.5 text-content-secondary"
                  >
                    {t}
                  </code>
                ))}
              </span>
            </Row>
          </div>
          <p className="mt-3 text-xs text-content-muted">
            This hash is signed into the gateway policy; a turn made under a different or unsigned
            configuration is marked on its decision record. Release history is not yet recorded.
          </p>
        </div>
      </div>
    </div>
  )
}
