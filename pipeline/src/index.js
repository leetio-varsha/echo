#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config.js";
import { transcribe, transcribeSegments, mergeTracks } from "./transcribe.js";
import { summarize } from "./summarize.js";
import {
  createCallPage,
  fetchActiveProjects,
  resolveProjectId,
  makeClient,
} from "./notion.js";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const twoTrack = Boolean(args.micPath || args.systemPath);
  if (!args.audioPath && !args.transcriptPath && !twoTrack) {
    usage();
    process.exit(1);
  }

  // whisper is only needed when transcribing audio (not when a transcript is given).
  const cfg = loadConfig({ dryRun: args.dryRun, needWhisper: !args.transcriptPath });

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
    console.log("Transcribing two tracks with whisper.cpp (Me + Them)…");
    const meSegs = await transcribeSegments(cfg, args.micPath);
    const themSegs = await transcribeSegments(cfg, args.systemPath);
    transcript = mergeTracks([
      { label: "Me", segments: meSegs },
      { label: "Them", segments: themSegs },
    ]);
    if (!transcript.trim()) throw new Error("Both tracks transcribed empty.");
    try {
      recordedAt = fs.statSync(args.micPath).mtime;
    } catch {}
    console.log(
      `Merged transcript ready (${transcript.length} chars; Me=${meSegs.length} seg, Them=${themSegs.length} seg).`,
    );
  } else {
    console.log(`Transcribing ${args.audioPath} with whisper.cpp…`);
    transcript = await transcribe(cfg, args.audioPath);
    try {
      recordedAt = fs.statSync(args.audioPath).mtime;
    } catch {}
    console.log(`Transcript ready (${transcript.length} chars).`);
  }

  // 2. Fetch active projects (for auto-attach), unless dry-run without a token.
  let projects = [];
  if (!cfg.dryRun || cfg.notion.token) {
    try {
      projects = await fetchActiveProjects(makeClient(cfg), cfg.notion.projectsDbId);
      console.log(`Found ${projects.length} active projects for matching.`);
    } catch (e) {
      console.warn(`Could not fetch projects (continuing without auto-attach): ${e.message}`);
    }
  }
  const projectNames = projects.map((p) => p.name);

  // Optional calendar context (Phase 4): { title, me, attendees[] }.
  let meeting = null;
  if (args.meetingPath) {
    try {
      meeting = JSON.parse(fs.readFileSync(args.meetingPath, "utf8"));
      console.log(`Calendar event: "${meeting.title || "(untitled)"}" (${(meeting.attendees || []).length} attendees).`);
    } catch (e) {
      console.warn(`Could not read meeting context (continuing without it): ${e.message}`);
    }
  }

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
