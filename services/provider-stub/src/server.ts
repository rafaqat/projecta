import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Scripted Messages API upstream for deployment conformance (WP-17). It
 * stands where the provider would, behind the real gateway, and answers
 * deterministically from recorded frames: a tool use on a turn's first
 * call, a cited answer once a tool result is present, and a tool-use
 * classification for the scope classifier. `FAIL_EVERY` makes every Nth
 * streamed call fail mid-stream so error surfacing can be asserted.
 */
const PORT = Number(process.env.PORT ?? 9200)
const FAIL_EVERY = Number(process.env.FAIL_EVERY ?? 0)
const here = fileURLToPath(new URL('.', import.meta.url))
const frames = (name: string) => readFileSync(`${here}../frames/${name}.sse`, 'utf8')
const TOOL_USE = frames('tool_use')
const FINAL = frames('final')

interface Body {
  stream?: boolean
  tool_choice?: { type: string; name?: string }
  messages?: Array<{ role: string; content: unknown }>
}

let streamed = 0

function hasToolResult(body: Body): boolean {
  const last = body.messages?.at(-1)
  return (
    Array.isArray(last?.content) &&
    (last!.content as Array<{ type: string }>).some((b) => b.type === 'tool_result')
  )
}

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function streamFrames(res: ServerResponse, text: string, failMidway: boolean) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  const parts = text.split('\n\n').filter(Boolean)
  const cut = failMidway ? Math.floor(parts.length / 2) : parts.length
  for (const frame of parts.slice(0, cut)) res.write(frame + '\n\n')
  if (failMidway) return res.destroy()
  res.end()
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end('{"status":"ok"}')
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end('{"type":"error","error":{"type":"not_found_error"}}')
  }
  let body: Body
  try {
    body = JSON.parse(await read(req)) as Body
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end('{"type":"error","error":{"type":"invalid_request_error"}}')
  }
  if (body.tool_choice?.type === 'tool' && body.tool_choice.name === 'classify') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        id: 'msg_stub_classify',
        type: 'message',
        role: 'assistant',
        model: 'stub',
        content: [
          { type: 'tool_use', id: 'toolu_stub', name: 'classify', input: { label: 'explanation' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    )
  }
  streamed++
  const failMidway = FAIL_EVERY > 0 && streamed % FAIL_EVERY === 0
  streamFrames(res, hasToolResult(body) ? FINAL : TOOL_USE, failMidway)
})

server.listen(PORT, '0.0.0.0', () =>
  console.log(JSON.stringify({ level: 'info', msg: 'provider-stub listening', port: PORT }))
)
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => server.close(() => process.exit(0)))
