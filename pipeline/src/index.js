#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { transcribe, transcribeSegments, mergeTracks } from "./transcribe.js";
import { loadGlossary, buildVocab } from "./glossary.js";
import { polishTranscript } from "./polish.js";
import { summarize } from "./summarize.js";
import {
  createCallPage,
  fetchActiveProjects,
  resolveProjectId,
  makeClient,
} from "./notion.js";

// Distinct exit code for "recording had no speech" (vs 1 = real failure). The
// menu-bar app treats this as a benign no-op (discard, no notification).
const EXIT_EMPTY_RECORDING = 20;

function parseArgs(argv) {
  const args = { dryRun: false, audioPath: null, transcriptPath: null, micPath: null, systemPath: null, meetingPath: null };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--transcript=")) args.transcriptPath = a.slice("--transcript=".length);
    else if (a.startsWith("--mic=")) args.micPath = a.slice("--mic=".length);
    else if (a.startsWith("--system=")) args.systemPath = a.slice("--system=".length);
    else if (a.startsWith("--meeting-json=")) args.meetingPath = a.slice("--meeting-json=".length);
    else if (!a.startsWith("--")) args.audioPath = a;
  }
  return args;
}

function usage() {
  console.log(`Echo pipeline — audio -> whisper -> Claude -> Notion

Usage:
  node src/index.js <path-to-audio> [--dry-run]
  node src/index.js --mic=<me.wav> --system=<them.wav> [--dry-run]   # two-track Me/Them
  node src/index.js --transcript=<path-to-txt> [--dry-run]          # skip whisper, use existing transcript

Options:
  --dry-run            Don't call Claude or write to Notion; print what would happen.
  --mic=FILE           "Me" track (your mic). Use with --system for speaker-labeled notes.
  --system=FILE        "Them" track (system audio). Transcribed separately and merged by time.
  --transcript=FILE    Use a pre-made transcript instead of transcribing audio.
  --meeting-json=FILE  Calendar context {title, me, attendees[]} to name speakers + set title.
`);
}

/**
 * Make sure a transcript is never lost when a later step fails. If it came from
 * a file it is already safe; otherwise dump it to a temp file and return a hint
 * telling the user how to resume from it.
 */
function preserveTranscript(transcript, transcriptPath) {
  if (transcriptPath) {
    return `Transcript is safe at: ${transcriptPath}\nRe-run with: node src/index.js --transcript="${transcriptPath}"`;
  }
  try {
    const out = path.join(os.tmpdir(), `echo-transcript-${crypto.randomBytes(6).toString("hex")}.txt`);
    fs.writeFileSync(out, transcript, "utf8");
    return `Transcript preserved at: ${out}\nRe-run with: node src/index.js --transcript="${out}"`;
  } catch (e) {
    return `(could not preserve transcript to disk: ${e.message})`;
  }
}

/**
 * Archive the raw (pre-polish) whisper transcript so the LLM cleanup pass can
 * never lose the original wording. Best-effort — a failure only logs.
 */
function saveRawTranscript(transcript, recordedAt) {
  try {
    const dir = path.join(os.homedir(), "Library", "Application Support", "Echo", "raw-transcripts");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = (recordedAt instanceof Date ? recordedAt : new Date())
      .toISOString()
      .slice(0, 16)
      .replace(/[:T]/g, "-");
    const out = path.join(dir, `${stamp}.txt`);
    fs.writeFileSync(out, transcript, "utf8");
    console.log(`Raw transcript archived: ${out}`);
  } catch (e) {
    console.warn(`Could not archive raw transcript: ${e.message}`);
  }
}

/** Label for the "[Them]" track: the single other attendee's name if known, else "Them". */
function otherAttendeeLabel(meeting) {
  const attendees = Array.isArray(meeting?.attendees) ? meeting.attendees.filter(Boolean) : [];
  const others = attendees.filter((a) => a !== meeting?.me);
  return others.length === 1 ? others[0] : "Them";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const twoTrack = Boolean(args.micPath || args.systemPath);
  if (!args.audioPath && !args.transcriptPath && !twoTrack) {
    usage();
    process.exit(1);
  }

  // whisper is only needed when transcribing audio (not when a transcript is given).
  const cfg = loadConfig({ dryRun: args.dryRun, needWhisper: !args.transcriptPath });

  // Optional calendar context (Phase 4): { title, me, attendees[] }. Read early so the
  // other attendee's name can label the "[Them]" track in the transcript itself.
  let meeting = null;
  if (args.meetingPath) {
    try {
      meeting = JSON.parse(fs.readFileSync(args.meetingPath, "utf8"));
      console.log(`Calendar event: "${meeting.title || "(untitled)"}" (${(meeting.attendees || []).length} attendees).`);
    } catch (e) {
      console.warn(`Could not read meeting context (continuing without it): ${e.message}`);
    }
  }
  const themLabel = otherAttendeeLabel(meeting);

  // Transcription glossary (local file + optional Notion page): names and domain
  // terms whisper otherwise garbles. Fed into the whisper prompt and the polish
  // pass. Any failure here degrades to "no glossary", never blocks the call.
  let glossaryTerms = [];
  try {
    glossaryTerms = await loadGlossary(cfg);
  } catch (e) {
    console.warn(`Glossary unavailable (continuing without it): ${e.message}`);
  }
  const vocab = buildVocab(glossaryTerms, meeting);
  if (vocab) console.log(`Whisper vocabulary (${glossaryTerms.length} glossary terms): ${vocab}`);

  // 1. Transcript (from whisper, or a provided file).
  let transcript;
  let recordedAt = new Date();
  if (args.transcriptPath) {
    if (!fs.existsSync(args.transcriptPath)) {
      throw new Error(`Transcript file not found: ${args.transcriptPath}`);
    }
    transcript = fs.readFileSync(args.transcriptPath, "utf8").trim();
    try {
      recordedAt = fs.statSync(args.transcriptPath).mtime;
    } catch {}
    console.log(`Loaded transcript (${transcript.length} chars) from ${args.transcriptPath}`);
  } else if (twoTrack) {
    if (!args.micPath || !args.systemPath) {
      throw new Error("Two-track mode needs both --mic=<me.wav> and --system=<them.wav>.");
    }
    console.log(`Transcribing two tracks with whisper.cpp (Me + ${themLabel})…`);
    const meSegs = await transcribeSegments(cfg, args.micPath, { vocab });
    const themSegs = await transcribeSegments(cfg, args.systemPath, { vocab });
    transcript = mergeTracks([
      { label: "Me", segments: meSegs },
      { label: themLabel, segments: themSegs },
    ]);
    if (!transcript.trim()) {
      // No speech on either track — this is a false-positive "call" (a background
      // app briefly held the mic), not a failure. Nothing to summarize and no
      // transcript to lose. Exit with a distinct code so the app discards the
      // session quietly instead of surfacing a scary ❌ failure notification.
      console.log("No speech detected on either track — nothing to summarize (skipping).");
      process.exit(EXIT_EMPTY_RECORDING);
    }
    try {
      recordedAt = fs.statSync(args.micPath).mtime;
    } catch {}
    console.log(
      `Merged transcript ready (${transcript.length} chars; Me=${meSegs.length} seg, Them=${themSegs.length} seg).`,
    );
  } else {
    console.log(`Transcribing ${args.audioPath} with whisper.cpp…`);
    transcript = await transcribe(cfg, args.audioPath, { vocab });
    try {
      recordedAt = fs.statSync(args.audioPath).mtime;
    } catch {}
    console.log(`Transcript ready (${transcript.length} chars).`);
  }

  // 1b. LLM polish pass: repair punctuation/casing, fix misheard glossary terms,
  // attribute "[Them]" lines to named participants. The raw transcript is saved
  // to disk first — polish must never be able to lose the original.
  if (cfg.transcriptPolish && !cfg.dryRun) {
    const rawTranscript = transcript;
    try {
      console.log("Polishing transcript (punctuation, glossary terms, speaker names)…");
      const polished = await polishTranscript(cfg, {
        transcript,
        meeting,
        glossary: glossaryTerms,
      });
      if (polished && polished !== rawTranscript) {
        saveRawTranscript(rawTranscript, recordedAt);
        transcript = polished;
      }
    } catch (e) {
      console.warn(`Polish pass failed (continuing with the raw transcript): ${e.message}`);
    }
  }

  // 2. Fetch active projects (for auto-attach), unless dry-run without a token.
  let projects = [];
  if (!cfg.dryRun || cfg.notion.token) {
    try {
      projects = await fetchActiveProjects(makeClient(cfg), cfg.notion.projectsDbId, cfg.notion.projectDoneStatus);
      console.log(`Found ${projects.length} active projects for matching.`);
    } catch (e) {
      console.warn(`Could not fetch projects (continuing without auto-attach): ${e.message}`);
    }
  }
  const projectNames = projects.map((p) => p.name);

  // 3. Summarize via Claude (api or subscription CLI).
  console.log(`Summarizing with ${cfg.anthropic.model} via ${cfg.summaryBackend} (lang=${cfg.summaryLang})…`);
  let summary;
  try {
    summary = await summarize(cfg, { transcript, projectNames, meeting });
  } catch (e) {
    // Hard rule: a summarization failure must never lose the transcript.
    const hint = preserveTranscript(transcript, args.transcriptPath);
    throw new Error(`Summarization failed: ${e.message}\n${hint}`);
  }
  console.log(`Title: ${summary.title}`);
  console.log(
    `  decisions=${summary.decisions.length} actions=${summary.action_items.length} questions=${summary.open_questions.length} participants=[${summary.participants.join(", ")}]`,
  );

  // 4. Resolve project + create Notion page.
  const projectId = resolveProjectId(projects, summary.suggested_project);
  if (summary.suggested_project) {
    console.log(
      projectId
        ? `Matched project "${summary.suggested_project}" -> attaching.`
        : `Claude suggested "${summary.suggested_project}" but no matching project found — leaving Project empty.`,
    );
  } else {
    console.log("No confident project match — leaving Project empty.");
  }

  const { url } = await createCallPage(cfg, {
    summary,
    transcript,
    projectId,
    date: recordedAt,
  });
  console.log(`\n✅ Notion page: ${url}`);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
