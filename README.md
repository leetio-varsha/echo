# Echo

A local, self-hosted replacement for Notion AI Meeting Notes (macOS, Apple Silicon).

A menu-bar app detects calls and records them locally; a local pipeline transcribes
with whisper.cpp (on-device, Metal), summarizes the transcript with Claude (your
Claude Code subscription by default, or the API), and creates a structured page in
your Notion **Calls** database. Notion stays a pure frontend/store — no paid
Business plan needed.

**Privacy:** audio and transcription never leave the machine. Only the text
transcript is sent to Claude.

## Status — all phases built & verified on real calls ✅

- **Phase 1 — pipeline:** `audio → whisper.cpp (VAD, large-v3) → Claude → Notion page`. Testable standalone.
- **Phase 2 — native app:** SwiftUI `MenuBarExtra`, two-track capture (mic + system audio → "Me / Them").
- **Phase 3 — auto-detect:** per-process Core Audio → auto **start and** auto **stop + summarize**.
- **Phase 4 — enrichment:** current calendar event (title + attendees) via EventKit → names, title, project.

App build/run: [`app/README.md`](app/README.md). Domain vocabulary: [`CONTEXT.md`](CONTEXT.md).

---

## Quick start — set up on your own Mac

```bash
git clone <repo> && cd echo
./bootstrap.sh           # deps + whisper.cpp + models + self-signed cert + app build
open app/build/Echo.app  # finish in the "Set up Echo…" window
```
`bootstrap.sh` does everything heavy (Homebrew deps, whisper.cpp + `large-v3` + VAD,
`npm install`, a code-signing identity, the app build). Then the app's **onboarding
window** collects the rest: paste your Notion integration token + a shared parent-page
link → it **creates your Calls + Projects databases**; Claude uses your Claude Code
subscription automatically (or paste an API key). Grant Microphone, Screen Recording,
and Calendar when prompted.

> Notion integration: <https://www.notion.so/my-integrations> → create one, then create a
> page, share it with the integration, and paste that page's link in onboarding.

The sections below document the same steps **manually** (and the pipeline-only path).

---

## Phase 1 setup (one-time)

### 1. Notion integration

1. Go to <https://www.notion.so/my-integrations> → **New integration** (internal).
2. Copy the **Internal Integration Secret** → this is `NOTION_TOKEN`.
3. Share **both** databases with the integration: open each database in Notion →
   `•••` menu → **Connections** → add your integration.
   - **Calls** database — where notes are created.
   - **Projects** database — used to auto-attach each note to the right project.

The database IDs are already filled in `.env.example`:
- Calls: `<your-calls-db-id>`
- Projects: `<your-projects-db-id>`

(If sharing fails or the API rejects `database_id`, your workspace may require the
newer data-source API — see "Notion API note" below.)

### 2. Claude access (pick one)

Two ways to call Claude for the summary, chosen by `SUMMARY_BACKEND`:

- **`claude-cli` (default)** — reuses your local Claude Code login (subscription).
  No API key, no per-token billing. Just have the `claude` CLI installed and
  logged in (`claude` on `PATH`, or set `CLAUDE_CLI_PATH`). The pipeline calls it
  headless in a neutral dir and strips `ANTHROPIC_API_KEY` so it can't silently
  bill the API.
- **`api`** — direct Anthropic API. Get a key at
  <https://console.anthropic.com/> → set `ANTHROPIC_API_KEY` and
  `SUMMARY_BACKEND=api`. Metered.

Default model is `claude-sonnet-4-6` either way.

### 3. whisper.cpp (local transcription, Metal)

```bash
# build whisper.cpp with Metal
brew install cmake ffmpeg            # ffmpeg is used to convert audio to 16kHz wav
git clone https://github.com/ggml-org/whisper.cpp ~/whisper.cpp
cd ~/whisper.cpp
cmake -B build -DWHISPER_METAL=ON
cmake --build build -j --config Release
# the CLI binary lands at: ~/whisper.cpp/build/bin/whisper-cli

# download the large-v3 model (~3 GB)
bash ./models/download-ggml-model.sh large-v3
# -> ~/whisper.cpp/models/ggml-large-v3.bin
```

Point `WHISPER_CPP_PATH` at the `whisper-cli` binary, and `WHISPER_MODEL` at the
`.bin` (or copy the model into `pipeline/models/`).

> Tip for a faster smoke test you can grab `base` or `small` instead of
> `large-v3`; keep `large-v3` for real Ukrainian/Russian quality.

### 4. Configure

```bash
cd pipeline
cp .env.example .env
# edit .env: NOTION_TOKEN, WHISPER_CPP_PATH, WHISPER_MODEL
#   (default SUMMARY_BACKEND=claude-cli needs no key; set ANTHROPIC_API_KEY only for SUMMARY_BACKEND=api)
npm install
```

---

## Run

```bash
# from repo root
./samples/make-sample.sh                       # makes samples/test.m4a (macOS)

# full run: transcribe -> summarize -> create Notion page
node pipeline/src/index.js samples/test.m4a

# see what would happen without calling Claude / writing to Notion
node pipeline/src/index.js samples/test.m4a --dry-run

# skip whisper and use a transcript you already have
node pipeline/src/index.js --transcript=path/to/transcript.txt
```

The created Notion page lands in **Calls** with: title, date, participants, the
Project relation (auto-matched by Claude from your active projects), a TL;DR,
Decisions, Action items (as to-do checkboxes), Open questions, and the full
transcript inside a collapsed toggle.

Configuration knobs (`.env`):
- `SUMMARY_BACKEND` — `claude-cli` (default, uses your Claude Code subscription) or `api`.
- `CLAUDE_CLI_PATH` — path to the `claude` binary if it isn't on `PATH` (claude-cli backend).
- `SUMMARY_LANG` — `auto` (match the meeting), or force `ru` / `uk` / `en`.
- `WHISPER_LANG` — `auto`, or force `ru` / `uk` / `en`.

---

## Notion API note

This repo uses `@notionhq/client` with `parent.database_id`, which works for
single-source databases. Notion is migrating to a "data sources" model; if a
future API version requires `data_source_id`, update `pipeline/src/notion.js`
(`pages.create` parent and `databases.query`) accordingly. The data-source ID for
Calls is `<your-calls-data-source-id>`.

## Layout

```
Echo/
├── pipeline/        # Phase 1 (Node)
│   ├── src/         # config, transcribe, summarize, notion, index
│   ├── prompts/     # summary prompt + JSON contract
│   └── models/      # whisper models (gitignored)
├── app/             # Phase 2+ native macOS app (placeholder)
└── samples/         # test audio (gitignored)
```
