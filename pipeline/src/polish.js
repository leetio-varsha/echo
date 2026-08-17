import fs from "node:fs";
import path from "node:path";
import { PIPELINE_ROOT } from "./config.js";
import { runClaude } from "./summarize.js";

const PROMPT_PATH = path.join(PIPELINE_ROOT, "prompts", "polish.md");

// One Claude call per chunk; keep chunks big enough that speaker-attribution
// context works, small enough that the model reliably returns the whole thing.
const CHUNK_CHARS = 12000;
const PREV_TAIL_LINES = 3;

/** Split a transcript into line-aligned chunks of ~maxChars (never mid-line). */
export function chunkTranscript(transcript, maxChars = CHUNK_CHARS) {
  const lines = String(transcript || "").split("\n");
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const line of lines) {
    if (len > 0 && len + line.length + 1 > maxChars) {
      chunks.push(cur.join("\n"));
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks;
}

/** Render calendar context for the polish prompt. */
function formatMeeting(meeting) {
  const attendees = Array.isArray(meeting?.attendees) ? meeting.attendees.filter(Boolean) : [];
  if (!meeting || (!meeting.title && !attendees.length)) return "(no calendar context)";
  const lines = [];
  if (meeting.title) lines.push(`Meeting: ${meeting.title}`);
  if (meeting.me) lines.push(`The "[Me]" speaker is: ${meeting.me}`);
  const others = attendees.filter((a) => a !== meeting.me);
  if (others.length) lines.push(`Remote participants (currently all labeled "[Them]"): ${others.join(", ")}`);
  return lines.join("\n");
}

/**
 * Sanity-check one repaired chunk: repair preserves speech, so the output must
 * still look like a transcript of roughly the same size. Anything suspicious
 * (truncation, refusal, commentary) -> null, and the caller keeps the raw chunk.
 */
export function validatePolishedChunk(raw, original) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  const fence = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  if (!text) return null;
  if (original.trimStart().startsWith("[") && !text.startsWith("[")) return null;
  // Repair never shortens much (only loop-dedup does) and never balloons.
  if (text.length < original.length * 0.5 || text.length > original.length * 1.6) return null;
  return text;
}

/**
 * LLM cleanup pass over the merged transcript: restore punctuation/casing in
 * degraded regions, fix glossary terms whisper misheard, collapse leftover
 * loops, and attribute "[Them]" lines to named remote participants.
 *
 * Degrades gracefully: any per-chunk failure (backend error, suspicious output)
 * keeps that chunk raw; a total failure returns the input unchanged. The caller
 * is responsible for preserving the raw transcript.
 */
export async function polishTranscript(cfg, { transcript, meeting, glossary }) {
  const template = fs.readFileSync(PROMPT_PATH, "utf8");
  const meetingCtx = formatMeeting(meeting);
  const glossaryStr = (glossary || []).join(", ") || "(no glossary)";

  const chunks = chunkTranscript(transcript);
  const out = [];
  let repaired = 0;
  for (const [i, chunk] of chunks.entries()) {
    const prevTail = out.length
      ? out[out.length - 1].split("\n").slice(-PREV_TAIL_LINES).join("\n")
      : "(start of call)";
    const prompt = template
      .replace("{{MEETING_CONTEXT}}", meetingCtx)
      .replace("{{GLOSSARY}}", glossaryStr)
      .replace("{{PREV_TAIL}}", prevTail)
      .replace("{{CHUNK}}", chunk);
    try {
      const polished = validatePolishedChunk(await runClaude(cfg, prompt), chunk);
      if (polished) {
        out.push(polished);
        repaired++;
      } else {
        console.warn(`  polish: chunk ${i + 1}/${chunks.length} came back malformed — keeping raw.`);
        out.push(chunk);
      }
    } catch (e) {
      console.warn(`  polish: chunk ${i + 1}/${chunks.length} failed (${e.message}) — keeping raw.`);
      out.push(chunk);
    }
  }
  console.log(`  polish: ${repaired}/${chunks.length} chunks repaired.`);
  return out.join("\n");
}

// --- self-test (no Claude calls) ---
if (process.argv[1] && process.argv[1].endsWith("polish.js") && process.argv.includes("--self-test")) {
  let ok = true;
  const eq = (c, m) => {
    if (!c) { ok = false; console.error("FAIL:", m); } else console.log("ok:", m);
  };

  const lines = Array.from({ length: 40 }, (_, i) => `[Me] line number ${i} with some padding text`);
  const chunks = chunkTranscript(lines.join("\n"), 400);
  eq(chunks.length > 1, "chunkTranscript splits long transcripts");
  eq(chunks.join("\n") === lines.join("\n"), "chunks reassemble to the exact input");
  eq(chunks.every((c) => c.length <= 400 + 45), "chunks respect the size cap (line-aligned)");
  eq(chunkTranscript("", 100).join("") === "", "empty transcript -> one empty chunk");

  const orig = "[Me] hello there, this is a decent sized line of speech.";
  eq(validatePolishedChunk(orig, orig) === orig, "valid chunk passes through");
  eq(validatePolishedChunk("```\n" + orig + "\n```", orig) === orig, "markdown fence is stripped");
  eq(validatePolishedChunk("Sure! Here is the repaired transcript:", orig) === null,
    "commentary instead of transcript -> rejected");
  eq(validatePolishedChunk("[Me] hi.", orig) === null, "truncated output -> rejected");
  eq(validatePolishedChunk("", orig) === null, "empty output -> rejected");

  console.log(ok ? "\npolish self-test: PASS" : "\npolish self-test: FAIL");
  process.exit(ok ? 0 : 1);
}
