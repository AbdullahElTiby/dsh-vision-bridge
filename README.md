# dsh-vision-bridge

> **npm:** `dsh-vision-bridge-dsh` · **source/GitHub:** `AbdullahElTiby/dsh-vision-bridge`
> (the npm package is named `dsh-vision-bridge-dsh` because the shorter name
> was already taken on npm).

Host-plane plugin that gives **text-only models** (DeepSeek and any provider route
that does not declare `image` input) the ability to "see" images, using a
**pluggable vision provider** as the eyes: **Gemini**, **Groq**, or any
**OpenAI-compatible endpoint** (OpenAI, OpenRouter, Ollama, LM Studio, …).

## What it does

1. **Dispatch interception** — the two LLM dispatch entry points are wrapped:
   `llm.prepareCall` (the agent loop's prepared-call path, used for main
   turns and subagents) and `llm.stream` (session titles, compaction,
   unprepared loops). Before the adapter stream is built, every image block in
   the conversation is described by the configured vision provider and
   replaced with a `[Image (mediaType, WxH): …]` text block. The session
   history and UI keep the real image; only the model request is rewritten.
   This works for every text-only route (`deepseek-official`, pi-ai providers
   such as `opencode-go`, …). Routes that genuinely declare image input are
   passed through untouched.

   **Why method patching instead of the `llm/stream` waterfall:** in this
   harness build the waterfall ignores arguments passed to `next()` (listeners
   always receive the original args) and `dsh-llm`'s default handler closes
   over the original options object. A waterfall listener can wrap the chunk
   stream but can never replace the request the adapter receives — a
   waterfall-only bridge silently loses its rewrite and the text-only adapter
   throws `UNSUPPORTED_CONTENT` ("… does not support image input"). Wrapping
   the service methods makes the rewritten request reach the adapter.

2. **Image admission** — `llm.resolveModelInfo` is patched so bridged routes
   also report `image` input. This admits image uploads in chat, model
   switches with images already in the session, and the built-in `read_image`
   tool for text-only routes (its image blocks are described by the bridge on
   the next model call).
3. **`describe_image` tool** — the model can inspect an image file on disk
   (PNG/JPG/JPEG/WebP/GIF) on demand; useful for screenshot and file analysis.
4. **System-prompt section** — the model is told images arrive as descriptions.

Descriptions are cached per attachment, so history images are described once
per session, not on every model call.

## Installation for users

The plugin runs inside the DeepSeek Harness (DSH) **web profile**. You need
Node + pnpm, the DSH web app running once (so the profile folder exists), and
an API key for one vision provider (Gemini, Groq, or an OpenAI-compatible
endpoint).

### 1. Install the package

The package is installed into your web profile's `node_modules`. From the
profile directory, add the npm package:

```sh
cd ~/.dsh/profiles/web
dsh plugin --profile web add dsh-vision-bridge-dsh
```

or via pnpm directly:

```sh
cd ~/.dsh/profiles/web
pnpm add dsh-vision-bridge-dsh
```

(As a fallback you can also install straight from GitHub with
`pnpm add github:AbdullahElTiby/dsh-vision-bridge`, or copy the package
folder into `~/.dsh/profiles/node_modules/` — the user-owned module
fallback.)

### 2. Register the plugin row

Edit `~/.dsh/profiles/web/cordis.patch.yml` and add one of the rows below.
Gemini (the default provider):

```yaml
- insert:
    - id: vision-bridge
      name: 'dsh-vision-bridge'
      config:
        provider: gemini            # optional: gemini is the default
        model: gemini-2.5-flash     # optional
        apiKeyRef: GEMINI_API_KEY   # optional
```

Groq (free tier, vision-capable models — see the table below):

```yaml
- insert:
    - id: vision-bridge
      name: 'dsh-vision-bridge'
      config:
        provider: groq
        model: qwen/qwen3.6-27b     # vision-capable on the free tier
        apiKeyRef: GROQ_API_KEY
```

Any OpenAI-compatible endpoint:

```yaml
- insert:
    - id: vision-bridge
      name: 'dsh-vision-bridge'
      config:
        provider: openai
        baseURL: https://openrouter.ai/api/v1
        model: <vision model id of that endpoint>
        apiKeyRef: OPENROUTER_API_KEY
```

### 3. Set your API key

Add the key to `~/.dsh/.credentials.yaml` (or export the env var):

```yaml
GEMINI_API_KEY: your-gemini-key
GROQ_API_KEY: your-groq-key      # gsk_… from console.groq.com/keys
```

Auth-free local endpoints (Ollama, LM Studio) still need a credential ref to
be *present* — put any placeholder in it, e.g. `OPENAI_API_KEY: ollama`; the
bridge sends it as a bearer token the local server ignores.

### 4. Restart

Close and reopen DSH (`dsh web`). You can confirm the row mounts by dumping
the composed config: `dsh --profile web --dump-config`.

To verify it works, attach an image in a chat with a text-only model (e.g. a
DeepSeek route) — it should be described instead of rejected with
`UNSUPPORTED_CONTENT`.

### Enable/disable

Remove the `vision-bridge` row from `cordis.patch.yml` to disable the feature
(hot-reloaded); delete the package folder to remove it permanently. See the
[Notes](#notes) section for how edits to the plugin code are — and are not —
hot-reloaded.

## Providers

| `provider` | API | default `model` | default `apiKeyRef` | default `baseURL`/`endpoint` |
| --- | --- | --- | --- | --- |
| `gemini` (default) | Google Generative Language `generateContent` | `gemini-2.5-flash` | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta` |
| `groq` | Groq chat completions (OpenAI-compatible) | `qwen/qwen3.6-27b` | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` |
| `openai` | any OpenAI-compatible chat completions | `gpt-4o-mini` | `OPENAI_API_KEY` | `https://api.openai.com/v1` |

`model`, `apiKeyRef` and `baseURL` on the row override the per-provider
defaults. `endpoint` is the legacy name of `baseURL` and still works for the
Gemini transport; for `groq`/`openai`, `baseURL` wins over `endpoint`.

### Groq free tier — which models can see? (live-verified)

Tested against the live API with a real PNG: on the free plan **exactly one
chat model accepts images**:

| model | vision | free limits (RPM / RPD / TPM / TPD) |
| --- | --- | --- |
| `qwen/qwen3.6-27b` | ✅ multimodal (vision + text), thinking + non-thinking modes — **default for `provider: groq`** | 30 / 1K / 8K / 200K |
| `openai/gpt-oss-20b` / `openai/gpt-oss-120b` | ❌ served **text-only** on Groq — the API rejects `image_url` parts with `messages[1].content must be a string` | 30 / 1K / 8K / 200K |
| `llama-3.1-8b-instant`, `llama-3.3-70b-versatile` | ❌ text-only (same `content must be a string` rejection) | — |
| `groq/compound(-mini)`, `llama-prompt-guard-2-*`, `openai/gpt-oss-safeguard-20b` | ❌ compound/moderation models, no image description | — |
| `whisper-large-v3(-turbo)`, `canopylabs/orpheus-*` | ❌ audio (STT / TTS) | — |

Pointing the bridge at a non-vision model surfaces a
`description unavailable: groq HTTP 400 …` placeholder — only
`qwen/qwen3.6-27b` works for vision on the free tier.

**Free-plan budget (measured live):** each image call on
`qwen/qwen3.6-27b` charges ~2.7K against the 8K TPM bucket (the reported
usage is ~1.3K prompt tokens, but Groq bills an image floor) — so expect
roughly **3 image descriptions per minute**, 1000 per day (RPD), 30 per
minute max (RPM). Rate-limit responses carry Groq's `x-ratelimit-*`
headers; `npm run test:groq` prints them.

## Configuration (row config on the `vision-bridge` row)

| key | default | meaning |
| --- | --- | --- |
| `provider` | `gemini` | vision transport: `gemini`, `groq`, or `openai` |
| `model` | per provider (see table) | vision model id |
| `apiKeyRef` | per provider (see table) | credential ref (env var / `~/.dsh/.credentials.yaml` / `.env`) |
| `baseURL` | per provider (see table) | API base URL (chat completions for `groq`/`openai`; the Gemini endpoint for `gemini`) |
| `endpoint` | per provider (see table) | legacy alias for `baseURL` (Gemini rows keep using it) |
| `maxOutputTokens` | `1024` | description length cap |
| `reasoningEffort` | `none` for `groq`, unset otherwise | reasoning effort sent to the endpoint (`reasoning_effort`); `none` keeps qwen out of thinking mode so descriptions come back without a `<think>…</think>` block |
| `temperature` | `0.4` | sampling temperature |
| `timeoutMs` | `30000` | per-call timeout |
| `maxImageBytes` | `15728640` | largest image sent to the vision provider |
| `admitImages` | `true` | patch `resolveModelInfo` (image admission) |
| `tool` | `true` | register `describe_image` |
| `systemSection` | `true` | contribute the prompt section |
| `cacheSize` | `256` | description cache size |

Set `admitImages: false` to keep the stock gates (images are then rejected for
text-only models and the bridge never fires).

## Enabling the key

The bridge reads the credential referenced by `apiKeyRef` through the harness
credential layers (inherited environment wins, then
`~/.dsh/.credentials.yaml`, then `.env`). For example, add to
`~/.dsh/.credentials.yaml`:

```yaml
GEMINI_API_KEY: sk-…
GROQ_API_KEY: gsk-…
```

Without a key, attached images are replaced with a short failure placeholder
and a warning is logged; the conversation keeps working.

## Notes

- The package lives in `~/.dsh/profiles/node_modules/` (the deployment's
  user-owned module fallback, alongside the auto-created package links) so it
  survives npx-cache refreshes. Reinstalling the profile via `pnpm install`
  may prune that directory; re-create the package afterwards.
- The `llm.prepareCall` / `llm.stream` / `llm.resolveModelInfo` patches are
  applied per process start by the plugin itself (no shipped package is
  modified) and are removed when the row stops or reloads.
- Code changes to this package are NOT hot-reloaded: the loader re-imports
  rows only when their `name` changes, the HMR watcher ignores
  `**/node_modules`, and config-only row updates reuse the already-loaded
  module. **Restart the harness (close and reopen the app) after editing
  `lib/index.js`.**
- Remove the `vision-bridge` row from `~/.dsh/profiles/web/cordis.patch.yml`
  to disable the feature (hot-reloaded), or delete the package to remove it
  permanently.
