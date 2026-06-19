#!/usr/bin/env node
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { transcribe } from "./transcribe.js";
import { summarize } from "./summarize.js";
import {
  createCallPage,
  fetchActiveProjects,
  resolveProjectId,
  makeClient,
} from "./notion.js";

function parseArgs(argv) {
  const args = { dryRun: false, audioPath: null, transcriptPath: null };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--transcript=")) args.transcriptPath = a.slice("--transcript=".length);
    else if (!a.startsWith("--")) args.audioPath = a;
  }
  return args;
}

function usage() {
  console.log(`Echo pipeline — audio -> whisper -> Claude -> Notion

Usage:
  node src/index.js <path-to-audio> [--dry-run]
  node src/index.js --transcript=<path-to-txt> [--dry-run]   # skip whisper, use existing transcript

Options:
  --dry-run            Don't call Claude or write to Notion; print what would happen.
  --transcript=FILE    Use a pre-made transcript instead of transcribing audio.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.audioPath && !args.transcriptPath) {
    usage();
    process.exit(1);
  }

  const cfg = loadConfig({ dryRun: args.dryRun });

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

  // 3. Summarize via Claude.
  console.log(`Summarizing with ${cfg.anthropic.model} (lang=${cfg.summaryLang})…`);
  const summary = await summarize(cfg, { transcript, projectNames });
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
