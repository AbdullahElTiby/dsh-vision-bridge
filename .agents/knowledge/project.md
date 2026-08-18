---
captured: 2026-08-18
git-head: 4818249f46121d52294559fb6000f6a2988065bd
signatures:
  - path: package.json
    mtime: 1787068768
    size: 1299
  - path: package-lock.json
    mtime: 1787068768
    size: 10302
  - path: README.md
    mtime: 1787068763
    size: 13507
  - path: lib/index.js
    mtime: 1786955194
    size: 24013
  - path: AGENTS.md
    mtime: 1787068416
    size: 4487
---

# dsh-vision-bridge

## Purpose
DeepSeek Harness (DSH) host-plane plugin that lets text-only models (DeepSeek
and any route without `image` input) "see" images: a pluggable vision provider
(Gemini, Groq, or any OpenAI-compatible endpoint) describes images before the
request reaches the text-only adapter. Published to npm as
`dsh-vision-bridge-dsh` (short name was taken).

## Stack
Node ≥ 20, ESM, single runtime dependency `@deepseek-ai/dsh-tools`
(`defineTool`). No build step; plain JS.

## Layout
```
lib/index.js            the entire plugin (single file, ~570 lines)
smoke-test.mjs          offline smoke test (npm test)
live-test-groq.mjs      live Groq free-tier vision test (npm run test:groq)
.github/workflows/      publish.yml — npm publish with provenance on release
AGENTS.md               agent-facing install + repo instructions
README.md               user docs: install (auto + manual), providers, config
```

## Commands
| Task | Command |
| --- | --- |
| install | `pnpm install` (repo dev); into a harness: `pnpm add dsh-vision-bridge-dsh` in `~/.dsh/profiles/web` |
| test | `npm test` (smoke, no network) |
| test:groq | `npm run test:groq` (needs `GROQ_API_KEY`) |
| publish | GitHub release → `publish.yml` (npm provenance) |

## Architecture
`lib/index.js` exports a Cordis plugin (`name: 'vision-bridge'`, injects
`llm, attachments, credentials, fs, tools, systemPrompt`). It:
1. wraps `llm.prepareCall` and `llm.stream` (method patching, NOT the
   `llm/stream` waterfall — the waterfall can't replace request args in this
   harness build) to replace image blocks with `[Image …]` description blocks;
2. patches `llm.resolveModelInfo` so bridged routes admit images;
3. registers the `describe_image` tool;
4. contributes a system-prompt section.
Descriptions cached per attachment (`cacheSize`). Provider transports:
`gemini` (generateContent REST), `groq` and `openai` (chat completions via
`baseURL`). Defaults in `PROVIDER_DEFAULTS` (lib/index.js:72).

## Conventions
- Single-file plugin, JSDoc-heavy, no formatter config.
- README is the source of truth for user-facing install/config; keep
  `AGENTS.md` install blocks in sync with README § Installation Option A.
- Version bumps in `package.json` ship with the change commit.

## Environment
Installed into the DSH web profile: `~/.dsh/profiles/web` (package),
`cordis.patch.yml` (plugin row), `~/.dsh/.credentials.yaml` (API keys).
Groq free tier: only `qwen/qwen3.6-27b` accepts images (~3 descriptions/min).

## Gotchas
- Plugin code edits are NOT hot-reloaded — restart the harness after changing
  `lib/index.js`.
- npm package name is `dsh-vision-bridge-dsh`, repo/dir name is
  `dsh-vision-bridge` — easy to mix up in install commands.
- A waterfall-only rewrite silently fails (`UNSUPPORTED_CONTENT`); the method
  patching is deliberate.
- Profile `node_modules` may be pruned by a profile `pnpm install`; reinstall
  the package afterwards.

## Updates
- 2026-08-18 — initial capture; added AGENTS.md and README install split
  (Option A automated/AI, Option B manual/human).
- 2026-08-18 — docs shipped: version 0.2.3 published to npm, commit
  4818249 pushed to GitHub main.
- 2026-08-18 — README: added npm version + downloads badges.
- 2026-08-18 — README Option A is now a copy-paste prompt for the user's AI
  (AI fetches repo, installs, configures, verifies); AGENTS.md frames the
  agent as the installer. Version 0.2.4.
- 2026-08-18 — downloads badge switched from monthly (`npm/dm`, lags ~2-3
  days) to total (`npm/dt`); real total 520. Version 0.2.5.
