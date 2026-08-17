// live-test-groq.mjs — one-shot verification that Groq's FREE-tier vision
// models work for the bridge, and which free models do NOT accept images.
//
//   node live-test-groq.mjs
//
// Reads GROQ_API_KEY from the environment or from
// ~/.dsh/.credentials.yaml (the same place the plugin looks). Makes one
// tiny image call per model and prints the response snippet, token usage,
// and Groq's x-ratelimit-* headers so you can watch free-plan limits
// (RPM/RPD/TPM/TPD). Free plan: 30 RPM / 1K RPD / 8K TPM / 200K TPD per
// model — the 1x1 PNG used here costs ~1-2K prompt tokens per call, well
// inside limits even with the 120B model.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

// 1x1 transparent PNG (a real image, so Groq exercises the vision path).
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function describe(model) {
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
          content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1PX}` } }],
        },
      ],
      max_tokens: 256,
      temperature: 0.4,
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

function header(t) {
  console.log(`\n=== ${t} ===`)
}

const key = readKey()
if (!key) {
  console.error(
    'No GROQ_API_KEY found. Set the env var or add GROQ_API_KEY: gsk_… to ~/.dsh/.credentials.yaml, then re-run.',
  )
  process.exit(1)
}

header('Vision-capable models on the free tier (should succeed)')
for (const model of ['qwen/qwen3.6-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b']) {
  const { status, rateHeaders, body } = await describe(model)
  const text = body?.choices?.[0]?.message?.content ?? JSON.stringify(body).slice(0, 120)
  console.log(`  ${model}`)
  console.log(`    HTTP ${status} | usage ${JSON.stringify(body?.usage ?? {})}`)
  console.log(`    limits ${JSON.stringify(rateHeaders)}`)
  console.log(`    vision reply: ${String(text).replace(/\n/g, ' ').slice(0, 160)}`)
}

header('Text-only models on the free tier (should be rejected — proof they cannot see)')
for (const model of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
  const { status, rateHeaders, body } = await describe(model)
  const err = body?.error?.message ?? JSON.stringify(body).slice(0, 120)
  console.log(`  ${model} -> HTTP ${status}: ${String(err).slice(0, 140)}`)
  console.log(`    limits ${JSON.stringify(rateHeaders)}`)
}

console.log('\nDone. All three vision models should answer 200; text-only models 400.')
