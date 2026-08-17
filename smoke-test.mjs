// Smoke test for dsh-vision-bridge: verifies the prepareCall/stream patches
// deliver rewritten (image-free) requests to the adapter, unlike the old
// llm/stream waterfall listener whose next() argument this harness ignores.
import { apply } from './lib/index.js'

function makeHarness(resolveModelInfo, { throwOnImage = true } = {}) {
  let received = null
  const disposers = []
  function adapterStream(options) {
    return (async function* () {
      received = options
      const hasImage = options.messages.some((m) =>
        m.content.some((b) => b.type === 'image' || (b.type === 'tool-result' && JSON.stringify(b).includes('"type":"image"'))),
      )
      // Same check the pi-ai adapter performs at dsh-llm-pi-ai stream().
      if (hasImage && throwOnImage) throw new Error('pi-ai model "deepseek-v4-pro" does not support image input')
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  const ctx = {
    logger: { warn: (m) => console.log('  [log]', m) },
    effect(fn, label) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
  }
  ctx.llm = {
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'] }),
    stream(options) {
      return adapterStream(options)
    },
    prepareCall: async (config) => ({ config, stream: (options) => adapterStream(options) }),
  }
  if (resolveModelInfo) ctx.llm.resolveModelInfo = resolveModelInfo
  ctx.attachments = {
    readImage: async (ref) => ({
      data: Buffer.from('fake-bytes'),
      ref: { mediaType: 'image/png', width: 100, height: 50, attachmentId: 'att-1' },
    }),
  }
  ctx.credentials = { resolve: async () => undefined } // no Gemini key -> placeholder path
  ctx.fs = {}
  ctx.tools = { register: (tool) => { console.log('  [tool]', tool?.name ?? 'unnamed'); return () => {} } }
  ctx.systemPrompt = { section: () => () => {} }
  return { ctx, disposers, getReceived: () => received }
}

const imageBlock = {
  type: 'image',
  attachment: { attachmentId: 'att-1', mediaType: 'image/png', width: 100, height: 50 },
}
const imageRequest = {
  provider: 'opencode-go',
  model: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, imageBlock] }],
}

// ── test 1: llm.stream path bridges before the adapter ────────────────────
{
  const { ctx, getReceived } = makeHarness()
  apply(ctx, {})
  const chunks = []
  for await (const c of ctx.llm.stream(imageRequest)) chunks.push(c)
  const blocks = getReceived().messages[0].content
  if (blocks.some((b) => b.type === 'image')) throw new Error('FAIL 1: image block reached the adapter via llm.stream')
  if (!blocks.some((b) => b.type === 'text' && String(b.text).startsWith('[Image (image/png, 100x50)'))) {
    throw new Error('FAIL 1: expected a bridged [Image ...] text block, got ' + JSON.stringify(blocks).slice(0, 200))
  }
  if (chunks.length !== 2) throw new Error('FAIL 1: chunk stream shape changed')
  console.log('PASS 1: llm.stream bridging — ' + String(blocks.find((b) => b.type === 'text' && b.text.startsWith('[Image')).text).slice(0, 100))
}

// ── test 2: prepareCall path bridges before the adapter ───────────────────
{
  const { ctx, getReceived } = makeHarness()
  apply(ctx, {})
  const prepared = await ctx.llm.prepareCall({ provider: 'opencode-go', model: 'deepseek-v4-pro' })
  for await (const _ of prepared.stream(imageRequest)) { /* drain */ }
  const blocks = getReceived().messages[0].content
  if (blocks.some((b) => b.type === 'image')) throw new Error('FAIL 2: image block reached the adapter via prepareCall.stream')
  console.log('PASS 2: prepareCall bridging — blocks: ' + blocks.map((b) => b.type).join(','))
}

// ── test 3: text-only request passes through untouched ────────────────────
{
  const { ctx, getReceived } = makeHarness()
  apply(ctx, {})
  const textRequest = {
    provider: 'opencode-go',
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  }
  for await (const _ of ctx.llm.stream(textRequest)) { /* drain */ }
  if (getReceived().messages[0].content[0].text !== 'hello') throw new Error('FAIL 3: text request altered')
  console.log('PASS 3: text-only request untouched')
}

// ── test 4: vision-capable route passes images through untouched ──────────
{
  const visionCapable = async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  const { ctx, getReceived } = makeHarness(visionCapable, { throwOnImage: false })
  apply(ctx, {})
  for await (const _ of ctx.llm.stream(imageRequest)) { /* drain */ }
  const blocks = getReceived().messages[0].content
  if (!blocks.some((b) => b.type === 'image')) throw new Error('FAIL 4: vision-capable route should keep image blocks')
  console.log('PASS 4: vision-capable route untouched — blocks: ' + blocks.map((b) => b.type).join(','))
}

// ── test 5: nested tool-result images are bridged ─────────────────────────
{
  const { ctx, getReceived } = makeHarness()
  apply(ctx, {})
  const nestedRequest = {
    provider: 'opencode-go',
    model: 'deepseek-v4-pro',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: 't1', content: [{ type: 'text', text: 'file found' }, imageBlock] },
        ],
      },
    ],
  }
  for await (const _ of ctx.llm.stream(nestedRequest)) { /* drain */ }
  const inner = getReceived().messages[0].content[0].content
  if (JSON.stringify(inner).includes('"type":"image"')) throw new Error('FAIL 5: nested image block reached the adapter')
  console.log('PASS 5: nested tool-result bridging — inner blocks: ' + inner.map((b) => b.type).join(','))
}

// ── test 6: groq provider bridges via chat/completions ─────────────────
{
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      async text() {
        return ''
      },
      async json() {
        return { choices: [{ message: { role: 'assistant', content: 'A fake Groq description of a PNG image.' } }] }
      },
    }
  }
  try {
    const { ctx, getReceived } = makeHarness()
    ctx.credentials = { resolve: async (ref) => ({ value: ref === 'GROQ_API_KEY' ? 'gsk_test_123' : undefined }) }
    apply(ctx, { provider: 'groq' })
    for await (const _ of ctx.llm.stream(imageRequest)) {
      /* drain */
    }
    const blocks = getReceived().messages[0].content
    const bridged = blocks.find((b) => b.type === 'text' && b.text.startsWith('[Image'))
    if (!bridged) throw new Error('FAIL 6: expected bridged [Image ...] block from Groq')
    if (!bridged.text.includes('A fake Groq description')) throw new Error('FAIL 6: description content missing')
    if (calls.length !== 1) throw new Error('FAIL 6: expected exactly one fetch call, got ' + calls.length)
    const { url, init } = calls[0]
    if (url !== 'https://api.groq.com/openai/v1/chat/completions') throw new Error('FAIL 6: wrong URL ' + url)
    if (init.headers.authorization !== 'Bearer gsk_test_123') throw new Error('FAIL 6: wrong auth header')
    const payload = JSON.parse(init.body)
    if (payload.model !== 'qwen/qwen3.6-27b') throw new Error('FAIL 6: wrong model ' + payload.model)
    if (payload.reasoning_effort !== 'none') throw new Error('FAIL 6: groq should default to reasoning_effort none')
    if (payload.messages[0].role !== 'system') throw new Error('FAIL 6: system message missing')
    const imagePart = payload.messages[1].content.find((p) => p.type === 'image_url')
    if (!imagePart || !imagePart.image_url.url.startsWith('data:image/png;base64,')) {
      throw new Error('FAIL 6: image_url data-URL part missing')
    }
    console.log('PASS 6: groq provider bridging — ' + bridged.text.slice(0, 100))
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── test 7: generic openai-compatible provider honors baseURL + model ───
{
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      async text() {
        return ''
      },
      async json() {
        return { choices: [{ message: { content: 'Local model description.' } }] }
      },
    }
  }
  try {
    const { ctx, getReceived } = makeHarness()
    ctx.credentials = { resolve: async (ref) => ({ value: ref === 'OPENAI_API_KEY' ? 'sk-test' : undefined }) }
    apply(ctx, { provider: 'openai', baseURL: 'http://localhost:11434/v1', model: 'llava:latest' })
    for await (const _ of ctx.llm.stream(imageRequest)) {
      /* drain */
    }
    const blocks = getReceived().messages[0].content
    const bridged = blocks.find((b) => b.type === 'text' && b.text.startsWith('[Image'))
    if (!bridged || !bridged.text.includes('Local model description')) {
      throw new Error('FAIL 7: openai-compatible bridging failed')
    }
    if (calls[0].url !== 'http://localhost:11434/v1/chat/completions') throw new Error('FAIL 7: wrong URL ' + calls[0].url)
    if (JSON.parse(calls[0].init.body).model !== 'llava:latest') throw new Error('FAIL 7: model override not applied')
    if (JSON.parse(calls[0].init.body).reasoning_effort !== undefined) throw new Error('FAIL 7: openai provider should not send reasoning_effort')
    console.log('PASS 7: openai-compatible provider bridging — ' + bridged.text.slice(0, 100))
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── test 8: gemini provider regression (defaults + AIza auth) ───────────
{
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      async text() {
        return ''
      },
      async json() {
        return { candidates: [{ content: { parts: [{ text: 'Gemini description.' }] } }] }
      },
    }
  }
  try {
    const { ctx, getReceived } = makeHarness()
    ctx.credentials = { resolve: async () => ({ value: 'AIza-test-key' }) }
    apply(ctx, { provider: 'gemini' })
    for await (const _ of ctx.llm.stream(imageRequest)) {
      /* drain */
    }
    const bridged = getReceived().messages[0].content.find((b) => b.type === 'text' && b.text.startsWith('[Image'))
    if (!bridged || !bridged.text.includes('Gemini description')) throw new Error('FAIL 8: gemini bridging failed')
    if (calls[0].url !== 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent') {
      throw new Error('FAIL 8: wrong URL ' + calls[0].url)
    }
    if (calls[0].init.headers['x-goog-api-key'] !== 'AIza-test-key') throw new Error('FAIL 8: wrong gemini auth header')
    console.log('PASS 8: gemini provider regression — ' + bridged.text.slice(0, 100))
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('ALL SMOKE TESTS PASSED')
