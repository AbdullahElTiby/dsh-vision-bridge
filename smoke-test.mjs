// Smoke test for dsh-vision-bridge: verifies the prepareCall/stream patches
// deliver rewritten (image-free) requests to the adapter, unlike the old
// llm/stream waterfall listener whose next() argument this harness ignores.
import { apply } from 'file:///C:/Users/abdul/.dsh/profiles/node_modules/dsh-vision-bridge/lib/index.js'

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

console.log('ALL SMOKE TESTS PASSED')
