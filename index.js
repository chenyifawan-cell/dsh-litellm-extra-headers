// dsh-litellm-extra-headers
//
// Host plugin: put an `extra_headers` object into the OpenAI-compatible request
// BODY for model calls that are routed to a configured provider AND sent to a
// configured upstream host.
//
// Why the body and not a request header: a LiteLLM deployment only merges the
// body's `extra_headers` into the upstream request it builds; a client HTTP
// header of the same name is dropped before the upstream call. The companion
// plugin `dsh-opencode-session` therefore has no effect on such a route.
//
// How it works:
//   1. `llm/stream` waterfall: calls whose `options.provider` is one of the
//      configured routes and which carry a `sessionId` run inside an
//      AsyncLocalStorage store holding the header name and its value.
//   2. `globalThis.fetch` is patched once. While a store is active, a request
//      whose URL host is configured and whose init is a JSON POST to
//      `/chat/completions` gets `extra_headers[<header>]` added to its body.
//   3. Both registrations are fiber-scoped ctx effects, so plugin stop /
//      update / unload restores the original fetch and removes the listener.
//
// Everything else passes through byte-identical: other providers, other hosts,
// other methods, non-JSON content types, non-string bodies, unparsable bodies,
// and bodies whose `extra_headers` already carries the configured header.

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'

export const name = 'litellm-extra-headers'

// Activate only after the abstract `llm` service exists, so the waterfall
// event we listen on is already registered by its provider.
export const inject = ['llm']

const DEFAULT_HEADER = 'x-opencode-session'

// Only `application/json` POSTs to a `.../chat/completions` path are rewritten;
// that is the one request shape the OpenAI SDK builds with a string body, and
// the one LiteLLM reads `extra_headers` from.
const CHAT_COMPLETIONS_SUFFIX = '/chat/completions'

function stringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

/**
 * Reduce one configured host to the `host` form of a URL, so that
 * `litellm.internal:4000`, `http://litellm.internal:4000` and
 * `https://litellm.internal:4000/v1` all match the same upstream.
 * @param raw - one entry of the `hosts` config list.
 * @returns the normalized `host[:port]` key, or undefined when unparsable.
 */
export function normalizeHostKey(raw) {
  const text = String(raw).trim()
  if (text.length === 0) return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  try {
    return new URL(candidate).host.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Resolve the row config into the sets and scalars the runtime uses.
 * @param config - the row's `config` object (absent keys are defaults).
 * @returns the resolved settings; `providers` and `hosts` are lowercase key sets.
 */
export function resolveConfig(config = {}) {
  const providers = new Set(stringList(config.providers).map((value) => value.toLowerCase()))
  const hosts = new Set(
    stringList(config.hosts)
      .map((value) => normalizeHostKey(value))
      .filter((value) => value !== undefined),
  )
  const header = typeof config.header === 'string' && config.header.trim().length > 0
    ? config.header.trim()
    : DEFAULT_HEADER
  // session-id: reuse the DSH session id. uuid: process-stable random uuid per
  // DSH session. fixed: the configured literal `value`.
  const mode = config.mode === 'uuid' || config.mode === 'fixed' ? config.mode : 'session-id'
  const value = typeof config.value === 'string' && config.value.length > 0 ? config.value : undefined
  const debug = config.debug === true
  const debugFile = typeof config.debugFile === 'string' && config.debugFile.length > 0
    ? config.debugFile
    : undefined
  return { providers, hosts, header, mode, value, debug, debugFile }
}

/** Derive the opaque header value for one DSH session id. */
export function headerValueFor(sessionId, mode, table, fixedValue) {
  if (mode === 'fixed') return fixedValue
  const raw = String(sessionId)
  if (raw.length === 0) return undefined
  if (mode !== 'uuid') return raw
  let value = table.get(raw)
  if (value === undefined) {
    value = randomUUID()
    table.set(raw, value)
  }
  return value
}

/**
 * Merge `extra_headers[header] = value` into one JSON request body.
 * @param bodyText - the request body exactly as the SDK serialized it.
 * @param header - header name to add.
 * @param value - header value to add.
 * @returns `{ kind: 'inject', body }` with the rewritten JSON text, or
 *   `{ kind: 'keep', reason }` when the body must travel unchanged.
 */
export function injectExtraHeader(bodyText, header, value) {
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return { kind: 'keep', reason: 'body-not-json' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'keep', reason: 'body-not-object' }
  }
  const existing = parsed.extra_headers
  if (existing === undefined || existing === null) {
    return { kind: 'inject', body: JSON.stringify({ ...parsed, extra_headers: { [header]: value } }) }
  }
  if (typeof existing !== 'object' || Array.isArray(existing)) {
    return { kind: 'keep', reason: 'extra-headers-not-object' }
  }
  if (Object.hasOwn(existing, header)) return { kind: 'keep', reason: 'header-present' }
  return {
    kind: 'inject',
    body: JSON.stringify({ ...parsed, extra_headers: { ...existing, [header]: value } }),
  }
}

/** Read the request URL of a string / URL / Request fetch input. */
function requestUrl(input) {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url)
  } catch {
    return undefined
  }
  return undefined
}

/** Read one init header case-insensitively, whatever container carries it. */
function initHeader(init, name) {
  const source = init?.headers
  if (source === undefined || source === null) return undefined
  try {
    return new Headers(source).get(name) ?? undefined
  } catch {
    return undefined
  }
}

/** True for the one request shape this plugin rewrites. */
function isJsonChatCompletionsPost(url, init) {
  if (String(init?.method ?? 'GET').toUpperCase() !== 'POST') return false
  const contentType = initHeader(init, 'content-type')
  if (contentType === undefined || !contentType.toLowerCase().includes('application/json')) return false
  if (typeof init?.body !== 'string') return false
  return url.pathname.toLowerCase().endsWith(CHAT_COMPLETIONS_SUFFIX)
}

/** Copy init headers so a rewritten body never carries a stale content-length. */
function rewrittenHeaders(init) {
  if (init.headers === undefined || init.headers === null) return undefined
  try {
    const headers = new Headers(init.headers)
    headers.delete('content-length')
    return headers
  } catch {
    return undefined
  }
}

/**
 * Build a patched fetch that injects the body `extra_headers` entry while a
 * store is active and the target host is configured.
 * @param original - the fetch to delegate to.
 * @param als - the store the `llm/stream` listener fills per model call.
 * @param options - `header`, `hosts`, and an optional `onDecision` reporter.
 * @returns the patched fetch.
 */
export function patchFetch(original, als, options) {
  const { header, hosts, onDecision } = options
  return function patchedFetch(input, init) {
    const state = als.getStore()
    if (state === undefined) return original.call(this, input, init)
    try {
      const url = requestUrl(input)
      if (url === undefined || !hosts.has(url.host.toLowerCase())) {
        return original.call(this, input, init)
      }
      if (!isJsonChatCompletionsPost(url, init)) return original.call(this, input, init)

      const plan = injectExtraHeader(init.body, header, state.value)
      if (plan.kind === 'keep') {
        onDecision?.({ ...state, event: 'keep', reason: plan.reason, url, body: init.body })
        return original.call(this, input, init)
      }
      onDecision?.({ ...state, event: 'inject', url, body: plan.body })
      const headers = rewrittenHeaders(init)
      return original.call(this, input, headers === undefined ? { ...init, body: plan.body } : { ...init, headers, body: plan.body })
    } catch (error) {
      // A rewriting bug must never take the model call down with it.
      onDecision?.({ ...state, event: 'error', reason: error?.message ?? String(error) })
      return original.call(this, input, init)
    }
  }
}

/**
 * Wrap a downstream async iterable so every pull runs inside the store. The
 * adapter's HTTP request is issued while the stream is pulled, so the store is
 * visible to the patched fetch for exactly that request.
 * @param iterable - the stream returned by `next()`.
 * @param store - the per-call store value.
 * @param als - the AsyncLocalStorage to run the pulls in.
 * @returns the wrapped async iterable.
 */
export function withStore(iterable, store, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      return als.run(store, () => iterator.next())
    },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try {
          return await iterator.return(value)
        } catch {
          // The downstream stream may already be torn down; treat as done.
        }
      }
      return { done: true, value }
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw(error))
      }
      throw error
    },
  }
}

/** Fire-and-forget append of one debug record; failures only log a warning. */
function recordDebug(ctx, file, entry) {
  appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8').catch((error) => {
    ctx.logger.warn('[litellm-extra-headers] debugFile write failed: %s', error?.message ?? String(error))
  })
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  if (resolved.mode === 'fixed' && resolved.value === undefined) {
    throw new Error('[litellm-extra-headers] mode "fixed" requires a non-empty `value`')
  }
  if (resolved.providers.size === 0 || resolved.hosts.size === 0) {
    ctx.logger.warn(
      '[litellm-extra-headers] `providers` and `hosts` must both be listed explicitly; '
      + 'nothing is injected until they are (providers=%d, hosts=%d)',
      resolved.providers.size,
      resolved.hosts.size,
    )
    return
  }

  const als = new AsyncLocalStorage()
  const uuidBySession = new Map()

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger.warn('[litellm-extra-headers] globalThis.fetch is unavailable; cannot inject extra_headers')
    return
  }

  const report = (entry) => {
    const record = {
      ts: new Date().toISOString(),
      provider: entry.provider,
      model: entry.model,
      session: entry.session,
      host: entry.url?.host,
      path: entry.url?.pathname,
      header: resolved.header,
      value: entry.value,
      event: entry.event,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    }
    if (resolved.debugFile !== undefined) recordDebug(ctx, resolved.debugFile, record)
    if (resolved.debug) {
      ctx.logger.info(
        '[litellm-extra-headers] %s %s for %s (%s, session %s)',
        record.event,
        resolved.header,
        entry.url?.host ?? '<unknown host>',
        entry.provider ?? '<unknown provider>',
        entry.session ?? '<unknown session>',
      )
    }
  }

  const patched = patchFetch(originalFetch, als, {
    header: resolved.header,
    hosts: resolved.hosts,
    onDecision: report,
  })

  ctx.effect(() => {
    globalThis.fetch = patched
    ctx.logger.info(
      '[litellm-extra-headers] active for providers [%s] -> hosts [%s] with %s (%s)',
      [...resolved.providers].join(', '),
      [...resolved.hosts].join(', '),
      resolved.header,
      resolved.mode,
    )
    return () => {
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch
    }
  }, 'litellm-extra-headers.fetch-patch')

  ctx.on('llm/stream', (options, next) => {
    if (options === undefined || options === null || typeof options !== 'object') return next()
    if (!resolved.providers.has(String(options.provider).toLowerCase())) return next()
    const sessionId = options.sessionId
    if (sessionId === undefined || sessionId === null) return next()
    const value = headerValueFor(sessionId, resolved.mode, uuidBySession, resolved.value)
    if (value === undefined) return next()

    // `next()` returns the downstream (lazy) stream; the HTTP request happens
    // while it is pulled, so drive its iterator from inside the store.
    const downstream = next()
    if (downstream === undefined || downstream === null) return downstream
    if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream

    const store = {
      value,
      provider: String(options.provider),
      model: options.model === undefined ? undefined : String(options.model),
      session: String(sessionId),
    }
    return withStore(downstream, store, als)
  }, { prepend: true })
}

export default { name, inject, apply }
