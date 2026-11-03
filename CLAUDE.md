# Echo — agent guide

Local, self-hosted replacement for **Notion AI Meeting Notes** (macOS, Apple Silicon).

**Privacy is the product:** audio and transcription never leave the machine. Only the text
transcript is sent to Claude.

## Architecture (two parts)
1. **Native menu-bar app** (Swift / SwiftUI `MenuBarExtra`, `app/`). Auto-detects calls,
   records mic + system audio (two tracks → "Me / Them"), enriches from Calendar, invokes
   the pipeline. Built by `app/build.sh` (no Xcode project).
2. **Pipeline** (Node, `pipeline/`). `audio → whisper.cpp → Claude → Notion`.

## Stack
Node ≥20 (ESM) · `@anthropic-ai/sdk` · `@notionhq/client` · `dotenv` ·
whisper.cpp (Metal, `ggml-large-v3`) · `ffmpeg` (audio → 16 kHz mono WAV).

**Summary backend** (`SUMMARY_BACKEND`): `claude-cli` (default) shells out to the `claude`
CLI in headless mode and reuses the machine's Claude Code login; `api` uses the SDK and
needs `ANTHROPIC_API_KEY`. See `pipeline/src/summarize.js`.

## Verify your work
```
cd pipeline && npm run check          # node --check on all src files
cd pipeline && npm run test:parse     # summarize.js JSON-parse self-test
node pipeline/src/index.js samples/test.m4a --dry-run   # no Claude/Notion calls
```

## Where things are
- **Domain vocabulary**: `CONTEXT.md` — use these terms, don't invent parallel ones.
- **Human setup guide (macOS)**: `README.md`; app build details in `app/README.md`.
- **Summary prompt + JSON contract**: `pipeline/prompts/summary.md` (edit there, not in code).
- **Notion targets**: configured in `pipeline/.env` (`NOTION_CALLS_DB_ID`, `NOTION_PROJECTS_DB_ID`).

## Hard rules
1. Privacy: never add a step that uploads audio anywhere; only transcript text → Claude.
2. No secrets in git (`.env`, tokens, keys stay out; never hardcode them).
3. Use the configured **Calls** / **Projects** Notion DBs; the integration must be shared with both.
4. Degrade gracefully — a missing binary/model/match or bad LLM JSON must never crash and lose the transcript.
5. Git: never commit on `master`; land work via a feature branch and a PR.
