import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import canonicalize from 'canonicalize'
import app from '@adonisjs/core/services/app'
import { REDACTOR_VERSION } from '#app/ingest/secret_redaction'
import { PROMPTS } from '#app/assistant/prompts/index'
import { readOnlyTools } from '#app/assistant/tools'
import { MODELS } from '#app/llm/client'
import { CHUNKER_VERSION } from '#app/parse/chunker'
import { lexicalBackend } from '#app/retrieval/search'

/**
 * configHash (design §9): one hash over everything that shapes an answer,
 * computed at boot from versioned files and pinned identifiers. An answer is
 * tied to the configuration that produced it; a configuration is validated
 * only by a passing eval run that recorded the same hash.
 */
export interface ConfigManifest {
  prompts: Record<string, { version: number; sha256: string }>
  profiles: Record<string, string>
  chunker: string
  embedder: { id: string; revision: string }
  scopePolicySha256: string
  tools: Array<{ name: string; inputSchema: unknown }>
  models: { answer: string; scopeClassifier: string }
  detectors: { injection: string; redaction: string }
  runtime: { lexicalBackend: string; evidence: 'pack' | 'routed' }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * One hash per language profile, keyed by source file. Only the TypeScript
 * sources count: the production image carries them as metaFiles next to the
 * compiled `.js` and `.js.map`, so host and container compute the same
 * configHash and the gateway allowlist matches in both.
 */
/** Which evidence path a turn builds on: the pack, or the question-shape pre-runs. */
export function evidenceMode(): 'pack' | 'routed' {
  // Default `pack` since the StyleSwap comparison of 2026-09-16 (evidence); `routed`
  // stays available until its removal work package.
  return process.env.ASSISTANT_EVIDENCE === 'routed' ? 'routed' : 'pack'
}

/**
 * The config hash of the other evidence path: the signed policy validates both, so
 * the migration's comparison runs each path against the same gateway. The manifest differs only
 * in `runtime.evidence`.
 */
export function otherEvidenceHash(): string {
  const manifest = buildManifest()
  return hashManifest({
    ...manifest,
    runtime: {
      ...manifest.runtime,
      evidence: manifest.runtime.evidence === 'pack' ? 'routed' : 'pack',
    },
  })
}

export function profileHashes(dir: string): Record<string, string> {
  const profiles: Record<string, string> = {}
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.ts')) continue
    profiles[file] = sha256(readFileSync(`${dir}/${file}`, 'utf8'))
  }
  return profiles
}

export function buildManifest(): ConfigManifest {
  const models = JSON.parse(readFileSync(app.makePath('models.lock.json'), 'utf8')) as {
    models: Array<{ id: string; revision: string; role?: string }>
  }
  const embedder = models.models[0]
  const profiles = profileHashes(app.makePath('app/parse/profiles'))
  return {
    prompts: Object.fromEntries(
      Object.entries(PROMPTS).map(([k, p]) => [k, { version: p.version, sha256: p.sha256 }])
    ),
    profiles,
    chunker: CHUNKER_VERSION,
    embedder: { id: embedder.id, revision: embedder.revision },
    scopePolicySha256: sha256(readFileSync(app.makePath('config/scope-policy.json'), 'utf8')),
    tools: readOnlyTools({ scope: { userId: 0 }, commitId: '', evidence: null as never }).map(
      (t) => ({
        name: t.spec.name,
        inputSchema: t.spec.inputSchema,
      })
    ),
    models: { answer: MODELS.answer, scopeClassifier: MODELS.scopeClassifier },
    detectors: {
      injection: process.env.INJECTION_DETECTOR_MODEL ?? 'rules-v1',
      redaction: REDACTOR_VERSION,
    },
    runtime: { lexicalBackend: lexicalBackend(), evidence: evidenceMode() },
  }
}

export function hashManifest(manifest: ConfigManifest): string {
  return sha256(canonicalize(manifest)!)
}

let cached: { manifest: ConfigManifest; hash: string } | undefined
export function configHash(): { manifest: ConfigManifest; hash: string } {
  if (!cached) {
    const manifest = buildManifest()
    cached = { manifest, hash: hashManifest(manifest) }
  }
  return cached
}

/** Eval runs that recorded a passing result for a configHash (evals/runs/*.json with `configHash` and `passed`). */
export function validatedRunFor(hash: string): string | null {
  const dir = app.makePath('evals/runs')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return null
  }
  for (const file of files.sort()) {
    try {
      const run = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as {
        configHash?: string
        passed?: boolean
        id?: string
      }
      if (run.configHash === hash && run.passed) return run.id ?? file
    } catch {
      continue
    }
  }
  return null
}
