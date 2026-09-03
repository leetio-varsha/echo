# Echo — agent guide

Local, self-hosted replacement for **Notion AI Meeting Notes** (macOS, Apple Silicon M4 Max).
This file is a ROUTER — read the pointed file when its topic is relevant, don't guess.

**Privacy is the product:** audio and transcription never leave the machine. Only the text
transcript is sent to the Claude API.

## Architecture (two parts)
1. **Native menu-bar app** (Swift / SwiftUI `MenuBarExtra`, `app/`) — Phases 2–4, built &
   verified. Auto-detects calls, records mic + system audio (two tracks → "Me / Them"),
   enriches from Calendar, invokes the pipeline. Built by `app/build.sh` (no Xcode project).
2. **Pipeline** (Node, `pipeline/`) — Phase 1, done. `audio → whisper.cpp → Claude → Notion`.

## Stack
Node ≥20 (ESM) · `@anthropic-ai/sdk` (`claude-sonnet-4-6`) · `@notionhq/client` · `dotenv` ·
whisper.cpp (Metal, `ggml-large-v3`) · `ffmpeg` (audio → 16 kHz mono WAV).

**Summary backend** (`SUMMARY_BACKEND`): `claude-cli` (default) shells out to the `claude`
CLI in headless mode → reuses this machine's Claude Code login (subscription), no API key /
no metered billing; `api` uses the SDK and needs `ANTHROPIC_API_KEY`. See `summarize.js`.

## Verify your work
```
cd pipeline && npm run check          # node --check on all src files
cd pipeline && npm run test:parse     # summarize.js JSON-parse self-test
node pipeline/src/index.js samples/test.m4a --dry-run   # no Claude/Notion calls
```
A task is DONE only when the **Definition of Done** in `memory/rules/execution.md` holds.

## Where things are
- **Phases / Definition of Done / hard rules (MANDATORY)**: `memory/rules/execution.md`.
- **Conventions** (commits, git commit-only, verification): `memory/rules/conventions.md`.
- **Project knowledge / gotchas**: `memory/MEMORY_INDEX.md` → `memory/learnings/`.
- **Domain vocabulary**: `CONTEXT.md` — use these terms, don't invent parallel ones.
- **Human setup guide (macOS)**: `README.md`.
- **Summary prompt + JSON contract**: `pipeline/prompts/summary.md` (edit there, not in code).

## Notion target (existing — never create new DBs)
| Thing | ID |
|---|---|
| Calls DB (`database_id`) | `<your-calls-db-id>` |
| Calls data source | `<your-calls-data-source-id>` |
| Projects DB | `<your-projects-db-id>` |

## Hard rules (short — full text in memory/rules/execution.md)
1. Privacy: never add a step that uploads audio anywhere; only transcript text → Claude.
2. No secrets in git (`.env`, tokens, keys stay out; never hardcode them).
3. Use the existing **Calls** / **Projects** Notion DBs; integration must be shared with both.
4. Degrade gracefully — missing binary/model/match or bad LLM JSON must never crash and lose the transcript.
5. Build phases in order; don't build ahead of the current phase.
6. Git: never commit on `master`; land work via a feature branch. Pushing to the
   private remote goes through a PR (a hook blocks direct pushes to `master`).

## Status
Phase 0 ✅ · Phase 1 ✅ (pipeline) · Phase 2 ✅ (menu-bar app, two-track) · Phase 3 ✅ (auto
start/stop) · Phase 4 ✅ (Calendar enrichment). **All verified on real calls.** Setup +
architecture: `memory/architecture/onboarding.md`; per-part design in `memory/projects/`.
