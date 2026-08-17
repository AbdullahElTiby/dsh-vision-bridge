// live-test-groq.mjs — one-shot verification that Groq's FREE-tier vision
// works for the bridge, and which free models do NOT accept images.
//
//   node live-test-groq.mjs
//
// Reads GROQ_API_KEY from the environment or from
// ~/.dsh/.credentials.yaml (the same place the plugin looks). Phase 1 hits
// Groq directly with a generated 32x32 PNG; phase 2 drives the real plugin
// (lib/index.js) end to end so the whole bridge path is exercised live.
// Prints token usage and Groq's x-ratelimit-* headers so you can watch
// free-plan limits (RPM/RPD/TPM/TPD).
//
// Live findings (2026-08): only qwen/qwen3.6-27b accepts image_url parts on
// the free tier. openai/gpt-oss-* on Groq are served text-only — the API
// rejects array content with "messages[1].content must be a string" — and
// the llama models are text-only by design.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { apply } from './lib/index.js'

const BASE = 'https://api.groq.com/openai/v1'

function readKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim()
  try {
    const yaml = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const m = yaml.match(/^GROQ_API_KEY:\s*['"]?([^'"\r\n]+)/m)
    if (m) return m[1].trim()
  } catch {
    /* ignore */
  }
  return null
}

// ---- tiny PNG generator (pure Node, no deps): 32x32 with colored blocks --
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng() {
  const w = 32
  const h = 32
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      let r = 255, g = 255, b = 255
      if (y < 16 && x < 16) [r, g, b] = [220, 40, 40] // red quadrant
      else if (y < 16) [r, g, b] = [40, 160, 40] // green quadrant
      else if (x < 16) [r, g, b] = [40, 80, 220] // blue quadrant
      else [r, g, b] = [240, 200, 40] // yellow quadrant
      const o = y * (w * 4 + 1) + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const PNG = makePng()
const PNG_B64 = PNG.toString('base64')

async function describe(model, { reasoning = false } = {}) {
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${readKey()}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are the vision module of a text-only model. Describe the image precisely; transcribe all text. Do not invent details.',
        },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }],
        },
      ],
      max_tokens: 256,
      temperature: 0.4,
      ...(reasoning ? { reasoning_effort: 'none' } : {}), // same default the bridge sends for groq
    }),
  })
  const rateHeaders = {
    'req-limit': response.headers.get('x-ratelimit-limit-requests'),
    'req-remaining': response.headers.get('x-ratelimit-remaining-requests'),
    'tok-limit': response.headers.get('x-ratelimit-limit-tokens'),
    'tok-remaining': response.headers.get('x-ratelimit-remaining-tokens'),
    'reset-tokens': response.headers.get('x-ratelimit-reset-tokens'),
  }
  const body = await response.json()
  return { status: response.status, rateHeaders, body }
}

const key = readKey()
if (!key) {
  console.error(
    'No GROQ_API_KEY found. Set the env var or add GROQ_API_KEY: gsk_… to ~/.dsh/.credentials.yaml, then re-run.',
  )
  process.exit(1)
}

// ── phase 1: direct API calls ───────────────────────────────────────────
console.log('=== Phase 1: direct Groq calls with a 32x32 PNG ===')
console.log('--- qwen/qwen3.6-27b (expect 200 + real description) ---')
for (const model of ['qwen/qwen3.6-27b']) {
  const { status, rateHeaders, body } = await describe(model, { reasoning: true })
  const text = body?.choices?.[0]?.message?.content
  console.log(`  HTTP ${status} | usage ${JSON.stringify(body?.usage ?? {})}`)
  console.log(`  limits ${JSON.stringify(rateHeaders)}`)
  console.log(`  reply: ${String(text ?? JSON.stringify(body).slice(0, 140)).replace(/\n/g, ' ').slice(0, 300)}`)
}

console.log('--- models that cannot see (expect 400) ---')
for (const model of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
  const { status, body } = await describe(model)
  const err = body?.error?.message ?? JSON.stringify(body).slice(0, 140)
  console.log(`  ${model} -> HTTP ${status}: ${String(err).slice(0, 120)}`)
}

// ── phase 2: the real plugin, end to end ────────────────────────────────
console.log('\n=== Phase 2: dsh-vision-bridge plugin, end to end ===')
function makeHarness() {
  const disposers = []
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
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    prepareCall: async (config) => ({ config, stream: () => (async function* () {})() }),
  }
  ctx.attachments = {
    readImage: async (ref) => ({ data: PNG, ref: { mediaType: 'image/png', width: 32, height: 32, attachmentId: 'live-1' } }),
  }
  ctx.credentials = { resolve: async () => ({ value: readKey() }) }
  ctx.fs = {}
  ctx.tools = { register: () => () => {} }
  ctx.systemPrompt = { section: () => () => {} }
  return ctx
}

let received = null
const ctx = makeHarness()
const originalStream = ctx.llm.stream.bind(ctx.llm)
ctx.llm.stream = function (options) {
  return (async function* () {
    received = options
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}
apply(ctx, { provider: 'groq', model: 'qwen/qwen3.6-27b' })
const imageRequest = {
  provider: 'opencode-go',
  model: 'deepseek-v4-pro',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what do you see in this image?' },
        { type: 'image', attachment: { attachmentId: 'live-1', mediaType: 'image/png', width: 32, height: 32 } },
      ],
    },
  ],
}
for await (const _ of ctx.llm.stream(imageRequest)) {
  /* drain */
}
const blocks = received.messages[0].content
const bridged = blocks.find((b) => b.type === 'text' && b.text.startsWith('[Image'))
if (!bridged) {
  console.error('PHASE 2 FAILED: no [Image ...] block — adapter received:', JSON.stringify(blocks).slice(0, 400))
  process.exit(1)
}
console.log('  bridged block reached the adapter:')
console.log('  ' + bridged.text.replace(/\n/g, ' ').slice(0, 500))
console.log('\nRESULT: Groq free-tier vision works through the bridge with qwen/qwen3.6-27b.')
