# AGENTS.md — dsh-vision-bridge

This repo is a **DeepSeek Harness (DSH) host-plane plugin** that gives
text-only models (DeepSeek and any route without `image` input) vision via a
pluggable vision provider (Gemini, Groq, or any OpenAI-compatible endpoint).
npm package: `dsh-vision-bridge-dsh` · repo: `AbdullahElTiby/dsh-vision-bridge`.

## Project knowledge

A snapshot of this codebase lives at `.agents/knowledge/project.md` — read it
before exploring the repo. Refresh it via the `project-knowledge` skill.

## Installing this plugin into a harness (agent instructions)

Target: the DSH **web profile** (`~/.dsh/profiles/web`). Requirements: Node
≥ 20, pnpm, the DSH web app run once so the profile folder exists, and one
vision-provider API key. All steps below are idempotent — safe to re-run.

The full human-oriented explanation lives in `README.md` § Installation
(Option B). The blocks here are the minimal automated path (Option A).

### POSIX

```sh
export GEMINI_API_KEY='your-gemini-key'   # never commit real keys

PROFILE="$HOME/.dsh/profiles/web"
mkdir -p "$PROFILE" && cd "$PROFILE"
pnpm add dsh-vision-bridge-dsh            # or: dsh plugin --profile web add dsh-vision-bridge-dsh

PATCH="$PROFILE/cordis.patch.yml"
touch "$PATCH"
if ! grep -q 'vision-bridge' "$PATCH"; then
  [ -s "$PATCH" ] && printf '\n' >> "$PATCH"
  cat >> "$PATCH" <<'EOF'
- insert:
    - id: vision-bridge
      name: 'dsh-vision-bridge'
EOF
fi

CRED="$HOME/.dsh/.credentials.yaml"
touch "$CRED"
grep -q '^GEMINI_API_KEY:' "$CRED" || printf 'GEMINI_API_KEY: %s\n' "$GEMINI_API_KEY" >> "$CRED"
```

### Windows (PowerShell)

```powershell
$env:GEMINI_API_KEY = 'your-gemini-key'   # never commit real keys

$profileDir = Join-Path $HOME '.dsh\profiles\web'
New-Item $profileDir -ItemType Directory -Force | Out-Null
Set-Location $profileDir
pnpm add dsh-vision-bridge-dsh            # or: dsh plugin --profile web add dsh-vision-bridge-dsh

$patch = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path $patch)) { New-Item $patch -ItemType File | Out-Null }
if (-not (Select-String -Path $patch -Pattern 'vision-bridge' -Quiet)) {
  if ((Get-Item $patch).Length -gt 0) { Add-Content -Path $patch -Value '' }
  Add-Content -Path $patch -Value @'
- insert:
    - id: vision-bridge
      name: 'dsh-vision-bridge'
'@
}

$cred = Join-Path $HOME '.dsh\.credentials.yaml'
if (-not (Test-Path $cred)) { New-Item $cred -ItemType File | Out-Null }
if (-not (Select-String -Path $cred -Pattern '^GEMINI_API_KEY:' -Quiet)) {
  Add-Content -Path $cred -Value "GEMINI_API_KEY: $env:GEMINI_API_KEY"
}
```

### Provider variants

The blocks above install the default provider (Gemini). For other providers,
replace the row config (see `README.md` § Providers for defaults):

- **Groq (free tier):** `provider: groq`, `model: qwen/qwen3.6-27b` (the only
  free-tier Groq model that accepts images), `apiKeyRef: GROQ_API_KEY`.
- **OpenAI-compatible:** `provider: openai`, `baseURL: <endpoint>`,
  `model: <vision model id>`, `apiKeyRef: <ref>` (e.g. `OPENROUTER_API_KEY`).
  Auth-free local endpoints (Ollama, LM Studio) still need the credential ref
  present — any placeholder value works.

### Verify

1. Restart DSH (close and reopen `dsh web`) — plugin code changes are NOT
   hot-reloaded.
2. `dsh --profile web --dump-config` must show the `vision-bridge` row.
3. Functional check: attach an image in a chat with a text-only model — it
   must be described, not rejected with `UNSUPPORTED_CONTENT`.

### Uninstall

Remove the `vision-bridge` row from `cordis.patch.yml` (hot-reloaded) to
disable; delete the package from the profile's `node_modules` to remove it.

## Working on this repo

| Task | Command |
| --- | --- |
| smoke test (no network) | `npm test` |
| live Groq free-tier test | `npm run test:groq` (needs `GROQ_API_KEY`) |

- Entry point: `lib/index.js` (single-file plugin, ESM).
- After editing `lib/index.js`, restart the harness to see changes — the
  loader does not hot-reload plugin code.
- Publishing is via `.github/workflows/publish.yml` (npm provenance, on
  release); bump `version` in `package.json` in the same commit.
