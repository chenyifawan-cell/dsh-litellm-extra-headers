// Behavior tests for dsh-litellm-extra-headers.
//
// Run with: npm test   (node --test tests/)
//
// The suite pins the three things the plugin must never get wrong:
//   1. the body is rewritten only for a listed provider + listed host + a
//      POST /chat/completions carrying a JSON string body;
//   2. an existing `extra_headers` entry survives (merge, never overwrite);
//   3. install and dispose are exactly symmetric on `globalThis.fetch`.

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  headerValueFor,
  injectExtraHeader,
  normalizeHostKey,
  patchFetch,
  resolveConfig,
  withStore,
} from '../index.js'
import { AsyncLocalStorage } from 'node:async_hooks'

const URL_UNDER_TEST = 'http://litellm.internal:4000/v1/chat/completions'
const CHAT_BODY = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true })

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** A fetch stand-in that records every call and answers with a tiny stream. */
function recordingFetch(response = 'ok') {
  const calls = []
  const impl = async (input, init) => {
    calls.push({ input: String(input), init })
    return {
      ok: true,
      status: 200,
      async text() {
        return response
      },
    }
  }
  return { calls, impl }
}

/** Stand-in ctx: collects effects and waterfall listeners, like cordis does. */
function fakeCtx() {
  const disposers = []
  const listeners = []
  const logs = []
  const logger = {
    info: (...args) => logs.push({ level: 'info', args }),
    warn: (...args) => logs.push({ level: 'warn', args }),
    error: (...args) => logs.push({ level: 'error', args }),
  }
  return {
    logger,
    logs,
    listeners,
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
    on(event, callback, options) {
      listeners.push({ event, callback, options })
    },
    disposeAll() {
      for (const dispose of disposers.reverse()) dispose?.()
    },
  }
}

function jsonBodyOf(call) {
  return JSON.parse(call.init.body)
}

describe('injectExtraHeader', () => {
  it('adds extra_headers and keeps every other field intact', () => {
    const plan = injectExtraHeader(CHAT_BODY, 'x-opencode-session', 'sess-1')
    assert.equal(plan.kind, 'inject')
    assert.deepEqual(JSON.parse(plan.body), {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      extra_headers: { 'x-opencode-session': 'sess-1' },
    })
  })

  it('merges into an existing extra_headers object instead of replacing it', () => {
    const body = JSON.stringify({ model: 'm', extra_headers: { 'x-trace': 'abc' } })
    const plan = injectExtraHeader(body, 'x-opencode-session', 'sess-1')
    assert.equal(plan.kind, 'inject')
    assert.deepEqual(JSON.parse(plan.body).extra_headers, {
      'x-trace': 'abc',
      'x-opencode-session': 'sess-1',
    })
  })

  it('never overwrites a header the caller already set', () => {
    const body = JSON.stringify({ model: 'm', extra_headers: { 'x-opencode-session': 'caller-value' } })
    assert.deepEqual(injectExtraHeader(body, 'x-opencode-session', 'sess-1'), {
      kind: 'keep',
      reason: 'header-present',
    })
  })

  it('passes through bodies it cannot safely rewrite', () => {
    assert.deepEqual(injectExtraHeader('not json at all', 'h', 'v'), { kind: 'keep', reason: 'body-not-json' })
    assert.deepEqual(injectExtraHeader('[1,2,3]', 'h', 'v'), { kind: 'keep', reason: 'body-not-object' })
    assert.deepEqual(injectExtraHeader('null', 'h', 'v'), { kind: 'keep', reason: 'body-not-object' })
    assert.deepEqual(injectExtraHeader(JSON.stringify({ extra_headers: 'nope' }), 'h', 'v'), {
      kind: 'keep',
      reason: 'extra-headers-not-object',
    })
    assert.deepEqual(injectExtraHeader(JSON.stringify({ extra_headers: [] }), 'h', 'v'), {
      kind: 'keep',
      reason: 'extra-headers-not-object',
    })
  })
})

describe('resolveConfig / normalizeHostKey', () => {
  it('normalizes host spellings to one host:port key', () => {
    assert.equal(normalizeHostKey('litellm.internal:4000'), 'litellm.internal:4000')
    assert.equal(normalizeHostKey('http://litellm.internal:4000/v1'), 'litellm.internal:4000')
    assert.equal(normalizeHostKey('HTTPS://GW.EXAMPLE.COM/'), 'gw.example.com')
    assert.equal(normalizeHostKey('[::1]:54000'), '[::1]:54000')
    assert.equal(normalizeHostKey('   '), undefined)
    assert.equal(normalizeHostKey('http://'), undefined)
  })

  it('applies documented defaults and drops unusable entries', () => {
    const resolved = resolveConfig({ providers: ['GWDS', ' go ', 7, ''], hosts: ['http://127.0.0.1:5599/v1'] })
    assert.deepEqual([...resolved.providers], ['gwds', 'go'])
    assert.deepEqual([...resolved.hosts], ['127.0.0.1:5599'])
    assert.equal(resolved.header, 'x-opencode-session')
    assert.equal(resolved.mode, 'session-id')
    assert.equal(resolved.debug, false)
    assert.equal(resolved.debugFile, undefined)
  })

  it('treats an unknown mode as session-id and keeps an explicit one', () => {
    assert.equal(resolveConfig({ mode: 'nonsense' }).mode, 'session-id')
    assert.equal(resolveConfig({ mode: 'fixed', value: 'v' }).mode, 'fixed')
    assert.equal(resolveConfig({ mode: 'uuid' }).mode, 'uuid')
  })

  it('derives values per mode', () => {
    const table = new Map()
    assert.equal(headerValueFor('sess-1', 'session-id', table, undefined), 'sess-1')
    assert.equal(headerValueFor('sess-1', 'fixed', table, 'literal'), 'literal')
    const first = headerValueFor('sess-1', 'uuid', table, undefined)
    assert.equal(headerValueFor('sess-1', 'uuid', table, undefined), first)
    assert.notEqual(headerValueFor('sess-2', 'uuid', table, undefined), first)
    assert.equal(headerValueFor('', 'session-id', table, undefined), undefined)
  })
})

describe('patchFetch', () => {
  const options = { header: 'x-opencode-session', hosts: new Set(['litellm.internal:4000']) }

  function patchedWith(state) {
    const als = new AsyncLocalStorage()
    const { calls, impl } = recordingFetch()
    const patched = patchFetch(impl, als, options)
    return { calls, patched, run: (fn) => (state === undefined ? fn() : als.run(state, fn)) }
  }

  const store = { value: 'sess-1', provider: 'gwds', model: 'm', session: 'sess-1' }
  const post = (overrides = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
    body: CHAT_BODY,
    ...overrides,
  })

  it('injects for a listed host on a JSON chat/completions POST', async () => {
    const { calls, patched, run } = patchedWith(store)
    await run(() => patched(URL_UNDER_TEST, post()))
    assert.equal(calls.length, 1)
    assert.deepEqual(jsonBodyOf(calls[0]).extra_headers, { 'x-opencode-session': 'sess-1' })
    assert.equal(jsonBodyOf(calls[0]).model, 'm')
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer k')
  })

  it('leaves the request byte-identical when no model call is streaming', async () => {
    const { calls, patched, run } = patchedWith(undefined)
    await run(() => patched(URL_UNDER_TEST, post()))
    assert.equal(calls[0].init.body, CHAT_BODY)
  })

  it('leaves other hosts, methods, paths, content types and body kinds alone', async () => {
    const cases = [
      ['http://litellm.internal:4001/v1/chat/completions', post()],
      ['http://other.example.com/v1/chat/completions', post()],
      [URL_UNDER_TEST, post({ method: 'GET' })],
      ['http://litellm.internal:4000/v1/embeddings', post()],
      [URL_UNDER_TEST, post({ headers: { 'content-type': 'text/plain' } })],
      [URL_UNDER_TEST, post({ body: new URLSearchParams({ a: '1' }) })],
      [URL_UNDER_TEST, post({ body: undefined })],
    ]
    for (const [url, init] of cases) {
      const { calls, patched, run } = patchedWith(store)
      await run(() => patched(url, init))
      assert.equal(calls[0].init.body, init.body, `body changed for ${url} ${JSON.stringify(init.method ?? '')}`)
    }
  })

  it('drops a stale content-length when it rewrites the body', async () => {
    const { calls, patched, run } = patchedWith(store)
    await run(() => patched(URL_UNDER_TEST, post({ headers: { 'content-type': 'application/json', 'content-length': '9999' } })))
    assert.equal(new Headers(calls[0].init.headers).get('content-length'), null)
    assert.equal(new Headers(calls[0].init.headers).get('content-type'), 'application/json')
  })

  it('reports and skips a body that already carries the header', async () => {
    const als = new AsyncLocalStorage()
    const { calls, impl } = recordingFetch()
    const decisions = []
    const patched = patchFetch(impl, als, { ...options, onDecision: (entry) => decisions.push(entry) })
    const body = JSON.stringify({ model: 'm', extra_headers: { 'x-opencode-session': 'caller' } })
    await als.run(store, () => patched(URL_UNDER_TEST, post({ body })))
    assert.equal(calls[0].init.body, body)
    assert.equal(decisions[0].event, 'keep')
    assert.equal(decisions[0].reason, 'header-present')
  })

  it('never lets a rewriting failure take the request down', async () => {
    const als = new AsyncLocalStorage()
    const { calls, impl } = recordingFetch()
    const decisions = []
    const patched = patchFetch(impl, als, { ...options, onDecision: (entry) => decisions.push(entry) })
    const hostile = {
      get method() {
        throw new Error('boom')
      },
      headers: { 'content-type': 'application/json' },
      body: CHAT_BODY,
    }
    await als.run(store, () => patched(URL_UNDER_TEST, hostile))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init, hostile)
    assert.equal(decisions[0].event, 'error')
    assert.match(decisions[0].reason, /boom/)
  })
})

describe('store propagation through the stream', () => {
  it('reaches a fetch issued while the downstream stream is pulled', async () => {
    const als = new AsyncLocalStorage()
    const { calls, impl } = recordingFetch()
    const patched = patchFetch(impl, als, {
      header: 'x-opencode-session',
      hosts: new Set(['litellm.internal:4000']),
    })
    globalThis.fetch = patched

    // A stand-in adapter: the HTTP call happens inside the generator body, the
    // way the openai SDK issues it after the stream starts being pulled.
    async function* adapter() {
      await new Promise((resolve) => setTimeout(resolve, 1))
      const response = await globalThis.fetch(URL_UNDER_TEST, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: CHAT_BODY,
      })
      yield await response.text()
    }

    const store = { value: 'sess-1', provider: 'gwds', model: 'm', session: 'sess-1' }
    const chunks = []
    for await (const chunk of withStore(adapter(), store, als)) chunks.push(chunk)

    assert.deepEqual(chunks, ['ok'])
    assert.deepEqual(jsonBodyOf(calls[0]).extra_headers, { 'x-opencode-session': 'sess-1' })

    // Outside the store the patch stays inert.
    await globalThis.fetch(URL_UNDER_TEST, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: CHAT_BODY,
    })
    assert.equal(calls[1].init.body, CHAT_BODY)
  })
})

describe('apply', () => {
  const config = { providers: ['gwds', 'go'], hosts: ['litellm.internal:4000'] }

  function install(extra = {}) {
    const { calls, impl } = recordingFetch()
    globalThis.fetch = impl
    const ctx = fakeCtx()
    apply(ctx, { ...config, ...extra })
    const listener = ctx.listeners.find((entry) => entry.event === 'llm/stream')
    return { calls, ctx, listener, installedOver: impl }
  }

  /** Drive one llm/stream call through the registered waterfall listener. */
  async function streamOnce(listener, options) {
    const downstream = async function* () {
      const response = await globalThis.fetch(URL_UNDER_TEST, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: CHAT_BODY,
      })
      yield await response.text()
    }
    const result = []
    for await (const chunk of listener.callback(options, () => downstream())) result.push(chunk)
    return result
  }

  it('patches fetch, wraps listed providers, and restores both on dispose', async () => {
    const { calls, ctx, listener, installedOver } = install()
    assert.notEqual(globalThis.fetch, installedOver)
    assert.equal(listener.options.prepend, true)

    assert.deepEqual(await streamOnce(listener, { provider: 'gwds', model: 'm', sessionId: 'sess-1' }), ['ok'])
    assert.deepEqual(jsonBodyOf(calls[0]).extra_headers, { 'x-opencode-session': 'sess-1' })

    // A route that is not listed (and a call that carries no session) must not
    // be touched.
    await streamOnce(listener, { provider: 'opencode-go', model: 'm', sessionId: 'sess-1' })
    assert.equal(calls[1].init.body, CHAT_BODY)
    await streamOnce(listener, { provider: 'gwds', model: 'm' })
    assert.equal(calls[2].init.body, CHAT_BODY)

    ctx.disposeAll()
    assert.equal(globalThis.fetch, installedOver)
  })

  it('uses the configured literal in fixed mode and refuses fixed without a value', () => {
    const { calls, ctx, listener } = install({ mode: 'fixed', value: 'pinned' })
    assert.ok(listener)
    void streamOnce(listener, { provider: 'go', model: 'm', sessionId: 'sess-9' }).then(() => {
      assert.deepEqual(jsonBodyOf(calls[0]).extra_headers, { 'x-opencode-session': 'pinned' })
      ctx.disposeAll()
    })
    assert.throws(() => apply(fakeCtx(), { ...config, mode: 'fixed' }), /requires a non-empty `value`/)
  })

  it('stays inert without an explicit provider and host list', () => {
    for (const partial of [{}, { providers: ['gwds'] }, { hosts: ['litellm.internal:4000'] }]) {
      const ctx = fakeCtx()
      const before = globalThis.fetch
      apply(ctx, partial)
      assert.equal(globalThis.fetch, before)
      assert.equal(ctx.listeners.length, 0)
      assert.equal(ctx.logs.at(-1).level, 'warn')
    }
  })

  it('writes one JSON line per decision to debugFile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'litellm-extra-headers-'))
    const file = join(dir, 'debug.ndjson')
    try {
      const { ctx, listener } = install({ debugFile: file })
      await streamOnce(listener, { provider: 'gwds', model: 'm', sessionId: 'sess-1' })

      let lines = []
      for (let attempt = 0; attempt < 50 && lines.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean)
      }
      assert.equal(lines.length, 1)
      const record = JSON.parse(lines[0])
      assert.equal(record.event, 'inject')
      assert.equal(record.provider, 'gwds')
      assert.equal(record.session, 'sess-1')
      assert.equal(record.host, 'litellm.internal:4000')
      assert.equal(record.path, '/v1/chat/completions')
      assert.equal(record.header, 'x-opencode-session')
      assert.equal(record.value, 'sess-1')
      assert.ok(record.ts)
      ctx.disposeAll()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
