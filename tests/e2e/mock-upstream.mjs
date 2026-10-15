// Minimal OpenAI-compatible upstream that records what actually arrived.
//
// It answers `POST /v1/chat/completions` with a one-chunk SSE stream, and keeps
// every request (method, URL, headers, raw body, parsed body) for assertions.

import { createServer } from 'node:http'

function sse(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * Start the recording upstream on an ephemeral loopback port.
 * @returns the port, the recorded requests, and a close function.
 */
export async function startMockUpstream() {
  const requests = []

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let json
      try {
        json = JSON.parse(body)
      } catch {
        json = undefined
      }
      requests.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        headers: req.headers,
        body,
        json,
      })

      if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(sse({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'mock-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }],
      }))
      res.write(sse({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'mock-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    port,
    requests,
    chatRequests: () => requests.filter((entry) => entry.url.startsWith('/v1/chat/completions')),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
