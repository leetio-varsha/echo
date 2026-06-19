# Echo domain glossary

Use these terms exactly.

## Pipeline
- **Pipeline** — the Node program in `pipeline/` that turns one audio file into one Notion
  page. Stages: transcribe → summarize → create page. Entry: `pipeline/src/index.js`.
- **Transcript** — plain text produced locally by whisper.cpp from the audio. Never leaves
  the machine except as the text body sent to Claude.
- **Summary** — the structured object Claude returns: `title`, `tldr`, `decisions`,
  `action_items`, `open_questions`, `participants`, `suggested_project`. Contract lives in
  `pipeline/prompts/summary.md`; parsed defensively in `summarize.js`.
- **Dry run** (`--dry-run`) — run the pipeline without calling Claude or writing to Notion;
  prints the prompt and the page payload. Used to validate without secrets.

## Transcription
- **whisper.cpp** — the local, on-device transcriber (Metal on Apple Silicon). `WHISPER_CPP_PATH`
  → the `whisper-cli` binary. Avoid "Whisper API" — there is NO cloud transcription here.
- **Model** — a `ggml-*.bin` file (`WHISPER_MODEL`). Default `ggml-large-v3` (best uk/ru).

## Notion (existing workspace — do not create new DBs)
- **Calls DB** — the database where each meeting note (page) is created. Props: `Name`,
  `Date`, `Participants`, `Project` (relation), `Open follow-ups`.
- **Projects DB** — the user's projects. The **Project** relation links a Call to one project.
- **Project auto-attach** — Claude picks `suggested_project` from the active-projects list;
  `notion.js` resolves the name → Projects page id and sets the relation. No match → empty.
- **Integration** — the Notion internal integration whose token is `NOTION_TOKEN`. Must be
  **shared with both** the Calls and Projects databases or the API can't see them.

## App (Phase 2+, not built)
- **Menu-bar app** — the native SwiftUI `MenuBarExtra` recorder/launcher. Detects calls,
  records, and invokes the pipeline. Avoid "the recorder" as a separate product — it's one app.
- **Two-track capture** — recording mic and system audio as separate tracks so speakers can
  be labeled **Me / Them** without a diarization model.
