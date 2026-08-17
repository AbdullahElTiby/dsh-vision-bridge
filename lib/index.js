/**
 * dsh-vision-bridge — give text-only models (DeepSeek and any provider route
 * that does not declare image input) the ability to "see" images.
 *
 * Host-plane plugin:
 *   1. Wraps the two LLM dispatch entry points — `llm.prepareCall` (the agent
 *      loop's prepared-call path) and `llm.stream` (session titles,
 *      compaction, unprepared loops) — so that before the adapter stream is
 *      built, every image block in the request (including nested tool-result
 *      images) is described by a pluggable vision model — Gemini, Groq, or
 *      any OpenAI-compatible endpoint — and replaced with a text block
 *      carrying the description. The session history and UI keep the
 *      real image; only the model request is rewritten. Routes that genuinely
 *      declare image input are passed through untouched.
 *
 *      Why method patching instead of the `llm/stream` waterfall: in this
 *      harness build the waterfall ignores arguments passed to `next()`
 *      (every listener always receives the original args) and `dsh-llm`'s
 *      default handler closes over the original options object. A listener
 *      therefore can wrap the chunk stream but can never replace the request
 *      the adapter receives — so a waterfall-only bridge silently loses its
 *      rewrite and the text-only adapter throws
 *      `UNSUPPORTED_CONTENT` ("does not support image input").
 *   2. Patches `llm.resolveModelInfo` so bridged routes report `image` input
 *      as well — this admits image uploads in chat, model switches with
 *      images already in the session, and the built-in fs `read_image` tool
 *      for text-only routes (the bridge makes those images legible).
 *   3. Registers the `describe_image` tool so the model can inspect image
 *      files on disk on demand.
 *   4. Contributes a system-prompt section explaining the bridge.
 *
 * Descriptions are cached per attachment id, so history images are described
 * once per session instead of on every model call.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
const name = 'vision-bridge'
/** Hard dependencies this plugin contributes to the host registries. */
const inject = ['llm', 'attachments', 'credentials', 'fs', 'tools', 'systemPrompt']

const DEFAULTS = {
  provider: 'gemini',
  model: undefined,
  apiKeyRef: undefined,
  endpoint: undefined,
  baseURL: undefined,
  maxOutputTokens: 1024,
  temperature: 0.4,
  timeoutMs: 30000,
  maxImageBytes: 15 * 1024 * 1024,
  admitImages: true,
  tool: true,
  systemSection: true,
  cacheSize: 256,
}

/**
 * Per-provider defaults. `provider` selects the transport; `model`,
 * `apiKeyRef` and `baseURL`/`endpoint` fall back to these when not set on
 * the row.
 *
 * - gemini  — Google Generative Language REST API (generateContent).
 * - groq    — Groq's OpenAI-compatible chat completions. The free tier
 *             includes the vision-capable qwen/qwen3.6-27b, openai/gpt-oss-20b
 *             and openai/gpt-oss-120b (see README for free-plan limits).
 * - openai  — any OpenAI-compatible chat completions endpoint (OpenAI,
 *             OpenRouter, Ollama, LM Studio, …) via baseURL.
 */
const PROVIDER_DEFAULTS = {
  gemini: {
    model: 'gemini-2.5-flash',
    apiKeyRef: 'GEMINI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  },
  groq: {
    model: 'qwen/qwen3.6-27b',
    apiKeyRef: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
  },
  openai: {
    model: 'gpt-4o-mini',
    apiKeyRef: 'OPENAI_API_KEY',
    baseURL: 'https://api.openai.com/v1',
  },
}

/** Extensions `describe_image` accepts; magic-byte validation stays at the attachment service. */
const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** System instruction for the vision model: produce a description a blind model can use. */
const SYSTEM_INSTRUCTION =
  'You are the vision module of a text-only language model. Describe the provided image precisely and exhaustively so a model that cannot see it can answer questions about it. Transcribe ALL visible text verbatim (documents, labels, signs, UI elements, error messages, screenshots). Describe people, objects, scenes, layout, colors, and anything relevant to the user\'s question. If the user asks a question the image can answer, answer it in the description. Do not invent details; if something is unclear, say so.'

/** Same recursive image walk the harness uses for its image policies. */
function contentHasImage(blocks) {
  return blocks.some(
    (block) => block.type === 'image' || (block.type === 'tool-result' && contentHasImage(block.content)),
  )
}

/**
 * The plugin body. Row config (all optional) is documented in the package
 * README; defaults above cover every key.
 */
function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const { llm, attachments, credentials, fs, tools, systemPrompt } = ctx
  const log = (message) => {
    if (ctx.logger !== undefined) ctx.logger.warn(`vision-bridge: ${message}`)
    else console.error(`vision-bridge: ${message}`)
  }

  // ── route modality: bridged = the route cannot see images ────────────────
  const originalResolveModelInfo = llm.resolveModelInfo
  const modalityCache = new Map()
  async function routeBridged(provider, model, signal) {
    const key = `${provider}\u0000${model}`
    const cached = modalityCache.get(key)
    if (cached !== undefined) return cached
    let bridged = true
    try {
      const info = await originalResolveModelInfo.call(llm, provider, model, signal)
      bridged = info.inputModalities === undefined || !info.inputModalities.includes('image')
    } catch (error) {
      log(`cannot resolve model info for ${provider}/${model}; bridging images anyway: ${String(error?.message ?? error)}`)
    }
    if (modalityCache.size >= 512) modalityCache.clear()
    modalityCache.set(key, bridged)
    return bridged
  }

  // ── vision provider resolution ──────────────────────────────────────────
  const provider = String(cfg.provider ?? 'gemini').toLowerCase()
  const providerDefaults = PROVIDER_DEFAULTS[provider]
  if (providerDefaults === undefined) {
    log(
      `unknown provider "${provider}"; falling back to gemini (valid: ${Object.keys(PROVIDER_DEFAULTS).join(', ')})`,
    )
  }
  const providerName = providerDefaults === undefined ? 'gemini' : provider
  const defaults = PROVIDER_DEFAULTS[providerName]
  const visionModel = cfg.model ?? defaults.model
  const visionKeyRef = cfg.apiKeyRef ?? defaults.apiKeyRef
  const visionBaseURL =
    providerName === 'gemini'
      ? (cfg.endpoint ?? defaults.baseURL)
      : (cfg.baseURL ?? cfg.endpoint ?? defaults.baseURL)

  // ── vision calls ─────────────────────────────────────────────────────────
  let keyMissingLogged = false
  async function visionKey() {
    const resolved = await credentials.resolve(visionKeyRef)
    const key = resolved?.value
    if (!key && !keyMissingLogged) {
      keyMissingLogged = true
      log(
        `no "${visionKeyRef}" credential; images will be replaced with failure placeholders until one is set (env, ~/.dsh/.credentials.yaml, or .env)`,
      )
    }
    return key
  }

  /** Timeout controller combined with the caller's signal; always clear the timer. */
  function abortSignalWithTimeout(signal, what) {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`vision-bridge ${what} call timed out`)),
      cfg.timeoutMs,
    )
    const callSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    return { callSignal, clear: () => clearTimeout(timer) }
  }

  /**
   * Auth headers for the Gemini REST API. Values starting with `AIza` are
   * treated as Google API keys (`x-goog-api-key`); any other value is sent as
   * an OAuth bearer token (`Authorization: Bearer ...`), which the v1beta
   * endpoint also accepts.
   */
  function authHeaders(key) {
    const headers = { 'content-type': 'application/json' }
    if (key.startsWith('AIza')) headers['x-goog-api-key'] = key
    else headers.authorization = `Bearer ${key}`
    return headers
  }

  /**
   * Describe one image (or several) with a Gemini model.
   * @param images - [{ data: base64 string, mediaType }]
   * @param question - optional user question to answer.
   * @param key - resolved API credential.
   * @param signal - caller cancellation.
   */
  async function geminiDescribe(images, question, key, signal) {
    const parts = []
    const prompt = (question ?? '').trim()
    if (prompt.length > 0) parts.push({ text: prompt })
    for (const image of images) parts.push({ inline_data: { mime_type: image.mediaType, data: image.data } })
    const { callSignal, clear } = abortSignalWithTimeout(signal, `${providerName} ${visionModel}`)
    try {
      const response = await fetch(
        `${visionBaseURL}/models/${encodeURIComponent(visionModel)}:generateContent`,
        {
          method: 'POST',
          headers: authHeaders(key),
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
            contents: [{ role: 'user', parts }],
            generationConfig: { maxOutputTokens: cfg.maxOutputTokens, temperature: cfg.temperature },
          }),
          signal: callSignal,
        },
      )
      if (!response.ok) {
        let detail = ''
        try {
          detail = (await response.text()).slice(0, 200)
        } catch {
          /* ignore body read failure */
        }
        throw new Error(`Gemini HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      const payload = await response.json()
      const text = (payload.candidates?.[0]?.content?.parts ?? [])
        .filter((part) => typeof part?.text === 'string' && part.text.length > 0)
        .map((part) => part.text)
        .join('\n')
      if (!text) throw new Error('Gemini returned no text')
      return text
    } finally {
      clear()
    }
  }

  /**
   * Describe one image (or several) with an OpenAI-compatible chat
   * completions endpoint (Groq, OpenAI, OpenRouter, Ollama, LM Studio, …).
   * Images ride as data-URL `image_url` parts and the system instruction
   * becomes a system message. Pointing a text-only model here yields an
   * HTTP 400 ("does not support image input") which surfaces as a
   * placeholder — pick a vision-capable model instead.
   */
  async function openaiDescribe(images, question, key, signal) {
    const prompt = (question ?? '').trim()
    const content = []
    if (prompt.length > 0) content.push({ type: 'text', text: prompt })
    for (const image of images) {
      content.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } })
    }
    const { callSignal, clear } = abortSignalWithTimeout(signal, `${providerName} ${visionModel}`)
    try {
      const response = await fetch(`${visionBaseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: /^Bearer\s+/i.test(key) ? key : `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: visionModel,
          messages: [
            { role: 'system', content: SYSTEM_INSTRUCTION },
            { role: 'user', content },
          ],
          max_tokens: cfg.maxOutputTokens,
          temperature: cfg.temperature,
        }),
        signal: callSignal,
      })
      if (!response.ok) {
        let detail = ''
        try {
          detail = (await response.text()).slice(0, 200)
        } catch {
          /* ignore body read failure */
        }
        throw new Error(`${providerName} HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      const payload = await response.json()
      const text = payload.choices?.[0]?.message?.content
      if (typeof text !== 'string' || text.trim().length === 0) throw new Error(`${providerName} returned no text`)
      return text
    } finally {
      clear()
    }
  }

  /**
   * Describe with whichever provider the row configures.
   * @param images - [{ data: base64 string, mediaType }]
   * @param question - optional user question to answer.
   * @param signal - caller cancellation.
   */
  async function visionDescribe(images, question, signal) {
    const key = await visionKey()
    if (!key) throw new Error(`missing ${visionKeyRef} credential`)
    return providerName === 'gemini'
      ? geminiDescribe(images, question, key, signal)
      : openaiDescribe(images, question, key, signal)
  }

  // ── per-attachment description cache (LRU-ish) ───────────────────────────
  const cache = new Map()
  function cachedDescription(key) {
    const value = cache.get(key)
    if (value !== undefined) {
      cache.delete(key)
      cache.set(key, value)
    }
    return value
  }
  function rememberDescription(key, value) {
    if (cache.size >= cfg.cacheSize) cache.delete(cache.keys().next().value)
    cache.set(key, value)
  }

  // ── message rewrite: image blocks -> description text blocks ─────────────
  /**
   * Rewrite one message's content. All images of one message are described in
   * the context of that message's own text (for the latest message this is
   * the user's question). One vision call per image, cached per attachment.
   */
  async function describeMessage(message, signal) {
    const images = []
    const walk = (blocks, path) => {
      blocks.forEach((block, index) => {
        if (block.type === 'image') images.push({ block, path: [...path, index] })
        else if (block.type === 'tool-result') walk(block.content, [...path, index, 'content'])
      })
    }
    walk(message.content, [])
    if (images.length === 0) return { changed: false, content: message.content }

    const question = message.content
      .filter((block) => block.type === 'text' && block.text.length > 0)
      .map((block) => block.text)
      .join('\n')
      .slice(0, 4000)

    const replacements = new Map() // image block object -> description text
    for (const image of images) {
      const ref = image.block.attachment
      const cacheKey = ref?.attachmentId === undefined ? null : String(ref.attachmentId)
      const hit = cacheKey === null ? undefined : cachedDescription(cacheKey)
      if (hit !== undefined) {
        replacements.set(image.block, hit)
        continue
      }
      let description
      try {
        const stored = await attachments.readImage(ref, signal)
        const bytes = stored.data
        if (bytes.byteLength > cfg.maxImageBytes) {
          description = `image is ${bytes.byteLength} bytes, over the ${cfg.maxImageBytes}-byte vision-bridge limit`
        } else {
          description = await visionDescribe(
            [{ data: Buffer.from(bytes).toString('base64'), mediaType: stored.ref.mediaType }],
            question,
            signal,
          )
        }
      } catch (error) {
        description = `description unavailable: ${String(error?.message ?? error)}`
      }
      if (cacheKey !== null && !description.startsWith('description unavailable')) {
        rememberDescription(cacheKey, description)
      }
      replacements.set(image.block, description)
    }

    const rebuild = (blocks) => {
      let changed = false
      const next = []
      for (const block of blocks) {
        if (block.type === 'image') {
          const description = replacements.get(block)
          if (description !== undefined) {
            const mediaType = block.attachment?.mediaType ?? 'image'
            const dims =
              block.attachment?.width !== undefined && block.attachment?.height !== undefined
                ? `, ${block.attachment.width}x${block.attachment.height}`
                : ''
            next.push({ type: 'text', text: `[Image (${mediaType}${dims}): ${description}]` })
            changed = true
            continue
          }
        }
        if (block.type === 'tool-result') {
          const inner = rebuild(block.content)
          if (inner.changed) {
            next.push({ ...block, content: inner.content })
            changed = true
            continue
          }
        }
        next.push(block)
      }
      return { changed, content: next }
    }

    return rebuild(message.content)
  }

  async function bridgeRequest(options) {
    try {
      if (!(await routeBridged(options.provider, options.model, options.signal))) return options
      let changed = false
      const messages = []
      for (const message of options.messages) {
        if (!contentHasImage(message.content)) {
          messages.push(message)
          continue
        }
        const rebuilt = await describeMessage(message, options.signal)
        if (rebuilt.changed) {
          changed = true
          messages.push({ ...message, content: rebuilt.content })
        } else {
          messages.push(message)
        }
      }
      if (!changed) return options
      return { ...options, messages }
    } catch (error) {
      log(
        `image bridging failed for ${options.provider}/${options.model}: ${String(error?.message ?? error)}; passing the request through untouched`,
      )
      return options
    }
  }

  // ── 1. the model route: wrap the dispatch entry points so the rewritten
  //    request actually reaches the adapter ─────────────────────────────────
  /**
   * Wrap one stream factory. Requests without images pass through untouched;
   * requests with images are bridged lazily (on first iteration) and the
   * rewritten options are handed to the wrapped factory — unlike the
   * `llm/stream` waterfall, a method call propagates its arguments.
   */
  function bridgedStream(options, original) {
    if (!options.messages.some((message) => contentHasImage(message.content))) return original(options)
    return (async function* () {
      const bridged = await bridgeRequest(options)
      yield* original(bridged)
    })()
  }

  // 1a. llm.stream — session titles, compaction, unprepared agent loops.
  if (typeof llm.stream === 'function') {
    const originalStream = llm.stream.bind(llm)
    ctx.effect(() => {
      llm.stream = function (options) {
        return bridgedStream(options, originalStream)
      }
      return () => {
        llm.stream = originalStream
      }
    }, 'vision-bridge llm.stream patch')
  }

  // 1b. llm.prepareCall — the agent loop's prepared-call dispatch path.
  if (typeof llm.prepareCall === 'function') {
    const originalPrepareCall = llm.prepareCall.bind(llm)
    ctx.effect(() => {
      llm.prepareCall = async function (config, signal) {
        const prepared = await originalPrepareCall(config, signal)
        if (prepared === void 0 || typeof prepared.stream !== 'function') return prepared
        const originalStream = prepared.stream.bind(prepared)
        return {
          ...prepared,
          stream: (options) => bridgedStream(options, originalStream),
        }
      }
      return () => {
        llm.prepareCall = originalPrepareCall
      }
    }, 'vision-bridge llm.prepareCall patch')
  }

  // ── 2. image admission: report image input on bridged routes ─────────────
  if (cfg.admitImages) {
    ctx.effect(() => {
      const patched = async (provider, model, signal) => {
        const info = await originalResolveModelInfo.call(llm, provider, model, signal)
        if (info.inputModalities !== undefined && info.inputModalities.includes('image')) return info
        return { ...info, inputModalities: [...(info.inputModalities ?? []), 'image'] }
      }
      llm.resolveModelInfo = patched
      return () => {
        llm.resolveModelInfo = originalResolveModelInfo
      }
    }, 'vision-bridge resolveModelInfo admission')
  }

  // ── 3. the describe_image tool: inspect image files on disk ──────────────
  if (cfg.tool) {
    ctx.effect(
      () =>
        tools.register(
          defineTool({
            name: 'describe_image',
            description:
              'Analyze an image file on disk (PNG, JPG, JPEG, WebP, or GIF) with a vision model and return a detailed description, transcribing all visible text. Use this when the user asks about an image file, screenshot, or picture you cannot see directly, such as a file under the workspace.',
            parameters: {
              file_path: { type: 'string', description: 'Path to the image file to describe.', required: true },
              question: { type: 'string', description: 'Optional specific question to answer about the image.' },
            },
            output: {
              schema: { type: 'string' },
              render(_args, value) {
                return [{ type: 'text', text: String(value) }]
              },
            },
            timeoutMs: cfg.timeoutMs + 5000,
            async execute(args, exec) {
              const filePath = String(args.file_path)
              const question = typeof args.question === 'string' ? args.question : ''
              const dot = filePath.lastIndexOf('.')
              const mediaType = IMAGE_EXTENSIONS[(dot >= 0 ? filePath.slice(dot) : '').toLowerCase()]
              if (mediaType === undefined) {
                throw new Error(
                  `"${filePath}" is not a supported image file; describe_image accepts PNG, JPG, JPEG, WebP, and GIF paths`,
                )
              }
              const target = await fs.resolve(filePath, { signal: exec.signal })
              const bytes = await fs.readBytes(target, exec.signal, cfg.maxImageBytes)
              return visionDescribe(
                [{ data: Buffer.from(bytes).toString('base64'), mediaType }],
                question.length > 0 ? question : 'Describe this image in detail, transcribing all visible text.',
                exec.signal,
              )
            },
          }),
        ),
      'vision-bridge describe_image tool',
    )
  }

  // ── 4. system-prompt section ─────────────────────────────────────────────
  if (cfg.systemSection) {
    ctx.effect(
      () =>
        systemPrompt.section({
          name: 'vision-bridge',
          order: 150,
          text: [
            '## Vision bridge',
            'This model cannot see images directly. When the user attaches images, a vision model describes them and the descriptions appear in the conversation as [Image ...] text blocks — answer from those descriptions. To inspect an image file on disk, use the describe_image tool. If an image has no description or a description failed, say so instead of guessing.',
          ].join('\n'),
        }),
      'vision-bridge prompt section',
    )
  }
}

export { name, inject, apply }
export default { name, inject, apply }
