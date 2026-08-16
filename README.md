# dsh-vision-bridge

Host-plane plugin that gives **text-only models** (DeepSeek and any provider route
that does not declare `image` input) the ability to "see" images, using a
**Gemini Flash** vision model as the eyes.

## What it does

1. **Dispatch interception** — the two LLM dispatch entry points are wrapped:
   `llm.prepareCall` (the agent loop's prepared-call path, used for main
   turns and subagents) and `llm.stream` (session titles, compaction,
   unprepared loops). Before the adapter stream is built, every image block in
   the conversation is described by Gemini and replaced with a
   `[Image (mediaType, WxH): …]` text block. The session history and UI keep
   the real image; only the model request is rewritten. This works for every
   text-only route (`deepseek-official`, pi-ai providers such as
   `opencode-go`, …). Routes that genuinely declare image input are passed
   through untouched.

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
a **Gemini API key**.

### 1. Install the package

The package is installed into your web profile's `node_modules`. From the
profile directory:

```sh
cd ~/.dsh/profiles/web
pnpm add github:AbdullahElTiby/dsh-vision-bridge
```

(This installs straight from this GitHub repo. As a fallback, you can also
copy the package folder into `~/.dsh/profiles/node_modules/` — the
user-owned module fallback — or, once published, use
`dsh plugin --profile web add dsh-vision-bridge`.)

### 2. Register the plugin row

Edit `~/.dsh/profiles/web/cordis.patch.yml` and add:

```yaml
- insert:
    - id: vision-bridge
      name: 'dsh-vision-bridge'
      config:
        model: gemini-2.5-flash
        apiKeyRef: GEMINI_API_KEY
```

### 3. Set your Gemini key

Add the key to `~/.dsh/.credentials.yaml` (or export `GEMINI_API_KEY`):

```yaml
GEMINI_API_KEY: your-gemini-key
```

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

## Configuration (row config on the `vision-bridge` row)

| key | default | meaning |
| --- | --- | --- |
| `model` | `gemini-2.5-flash` | Gemini vision model id |
| `apiKeyRef` | `GEMINI_API_KEY` | credential ref (env var / `~/.dsh/.credentials.yaml` / `.env`) |
| `endpoint` | `https://generativelanguage.googleapis.com/v1beta` | Gemini REST endpoint |
| `maxOutputTokens` | `1024` | description length cap |
| `temperature` | `0.4` | Gemini sampling temperature |
| `timeoutMs` | `30000` | per-call Gemini timeout |
| `maxImageBytes` | `15728640` | largest image sent to Gemini |
| `admitImages` | `true` | patch `resolveModelInfo` (image admission) |
| `tool` | `true` | register `describe_image` |
| `systemSection` | `true` | contribute the prompt section |
| `cacheSize` | `256` | description cache size |

Set `admitImages: false` to keep the stock gates (images are then rejected for
text-only models and the bridge never fires).

## Enabling the key

The bridge reads the `GEMINI_API_KEY` credential through the harness credential
layers (inherited environment wins, then `~/.dsh/.credentials.yaml`, then
`.env`). For example, add to `~/.dsh/.credentials.yaml`:

```yaml
GEMINI_API_KEY: sk-…
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
