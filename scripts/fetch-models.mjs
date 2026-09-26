#!/usr/bin/env node
// Downloads model files at build time, pinned by repository revision and
// SHA-256 (ADR-027, SEC-24). Only ONNX, safetensors and tokenizer/config
// JSON are allowed; anything else, a hash mismatch or a missing pin fails
// the build. Run with --write-lock once, review the resulting hashes, and
// commit models.lock.json; runtime never downloads. Grammar wasm files
// (build-plan §4) are pinned by exact release URL and SHA-256 the same way.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const LOCK = process.env.MODELS_LOCK ?? 'models.lock.json'
const ROOT = process.env.MODELS_DIR ?? 'models'
// `.py`: the model server's pinned architecture code (ADR-040), fetched and hashed like weights
// and executed only in that container; a lock entry for it is reviewed by a person (SEC-24).
const ALLOWED_EXTENSIONS = new Set(['.onnx', '.safetensors', '.json', '.txt', '.model', '.py'])
// MODELS_RUNTIME=onnx (the Node images): the torch runtime's files — safetensors weights and the
// pinned architecture code — are the model server's alone (ADR-040) and are neither fetched nor
// copied; they added a gigabyte to every image and filled the CI runner's disk.
const TORCH_ONLY = new Set(['.safetensors', '.py'])
const onnxOnly = process.env.MODELS_RUNTIME === 'onnx'
const GRAMMAR_HOST = 'https://github.com/'
const writeLock = process.argv.includes('--write-lock')

/** SHA-256 of a file, streamed: weights files are too large to hold in memory. */
async function sha256Of(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) hash.update(chunk)
  })
  return hash.digest('hex')
}

const lock = JSON.parse(readFileSync(LOCK, 'utf8'))
let failed = false

for (const model of lock.models) {
  if (!/^[0-9a-f]{40}$/.test(model.revision)) {
    console.error(`${model.id}: revision must be a 40-character commit SHA`)
    process.exit(2)
  }
  for (const file of model.files) {
    if (onnxOnly && TORCH_ONLY.has(extname(file.path))) continue
    if (!ALLOWED_EXTENSIONS.has(extname(file.path))) {
      console.error(`${model.id}/${file.path}: format not allowed`)
      failed = true
      continue
    }
    const target = join(ROOT, model.id, file.path)
    if (!existsSync(target) || writeLock) {
      // Streamed to disk: a weights file is hundreds of megabytes and must never be buffered whole.
      const url = `https://huggingface.co/${model.id}/resolve/${model.revision}/${file.path}`
      const response = await fetch(url)
      if (!response.ok || !response.body) {
        console.error(`${url}: HTTP ${response.status}`)
        failed = true
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
    }
    const sha256 = await sha256Of(target)
    if (writeLock) {
      file.sha256 = sha256
      console.log(`${model.id}/${file.path}: ${sha256}`)
    } else if (!file.sha256 || file.sha256 !== sha256) {
      console.error(`${model.id}/${file.path}: SHA-256 ${sha256} does not match the pin ${file.sha256 ?? '(none)'}`)
      failed = true
    } else {
      console.log(`${model.id}/${file.path}: ok`)
    }
  }
}

for (const grammar of lock.grammars ?? []) {
  if (!grammar.url.startsWith(GRAMMAR_HOST) || extname(grammar.path) !== '.wasm') {
    console.error(`${grammar.id}: grammar must be a .wasm release asset on ${GRAMMAR_HOST}`)
    failed = true
    continue
  }
  const target = join(ROOT, grammar.path)
  if (!existsSync(target) || writeLock) {
    const response = await fetch(grammar.url)
    if (!response.ok || !response.body) {
      console.error(`${grammar.url}: HTTP ${response.status}`)
      failed = true
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
  }
  const sha256 = await sha256Of(target)
  if (writeLock) {
    grammar.sha256 = sha256
    console.log(`${grammar.id}: ${sha256}`)
  } else if (grammar.sha256 !== sha256) {
    console.error(`${grammar.id}: SHA-256 ${sha256} does not match the pin ${grammar.sha256 ?? '(none)'}`)
    failed = true
  } else {
    console.log(`${grammar.id}: ok`)
  }
}

if (writeLock) writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n')
process.exit(failed ? 1 : 0)
