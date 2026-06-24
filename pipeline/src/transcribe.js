import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Convert an arbitrary audio file (.m4a, .mp3, ...) to the 16kHz mono WAV that
 * whisper.cpp expects, using ffmpeg. Returns the path to a temp WAV file.
 * The caller is responsible for cleanup (we put it in os.tmpdir()).
 */
function toWav16k(inputPath) {
  return new Promise((resolve, reject) => {
    const out = path.join(
      os.tmpdir(),
      `echo-${crypto.randomBytes(6).toString("hex")}.wav`,
    );
    const args = [
      "-y",
      "-i",
      inputPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      out,
    ];
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("error", (err) =>
      reject(new Error(`Failed to launch ffmpeg (is it installed?): ${err.message}`)),
    );
    ff.on("close", (code) => {
      if (code === 0 && fs.existsSync(out)) resolve(out);
      else reject(new Error(`ffmpeg failed (code ${code}):\n${stderr.slice(-2000)}`));
    });
  });
}

/**
 * Parse whisper.cpp `-oj` JSON into [{ start, end, text }] (offsets in ms).
 * Defensive: tolerates missing fields and drops empty segments.
 */
export function parseWhisperSegments(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`whisper JSON parse failed: ${e.message}`);
  }
  const arr = Array.isArray(parsed?.transcription) ? parsed.transcription : [];
  return arr
    .map((s) => ({
      start: Number(s?.offsets?.from ?? 0),
      end: Number(s?.offsets?.to ?? 0),
      text: (s?.text ?? "").trim(),
    }))
    .filter((s) => s.text);
}

/**
 * Run whisper.cpp on a WAV file. mode "txt" returns the transcript string;
 * mode "json" returns timestamped segments [{ start, end, text }].
 */
function runWhisper(cfg, wavPath, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const outPrefix = path.join(
      os.tmpdir(),
      `echo-tr-${crypto.randomBytes(6).toString("hex")}`,
    );

    const args = [
      "-m",
      cfg.whisper.modelPath,
      "-f",
      wavPath,
      json ? "-oj" : "-otxt",
      "-of",
      outPrefix,
      "-np", // no prints / progress noise
    ];
    args.push("-l", cfg.whisper.lang && cfg.whisper.lang !== "auto" ? cfg.whisper.lang : "auto");
    if (cfg.whisper.threads) {
      args.push("-t", String(cfg.whisper.threads));
    }

    // Anti-hallucination: suppress non-speech tokens, and run VAD when a model is
    // configured so silence/pauses (where whisper invents text, mis-detects the
    // language, or loops) are skipped entirely.
    args.push("-sns");
    // Cap text context carried between segments: unbounded context lets whisper
    // get stuck in repetition loops over a long file; 0 kills loops but hurts
    // accuracy (loses cross-segment context). 128 is the sweet spot — loops
    // shrink dramatically and the transcript recovers, with quality intact.
    args.push("-mc", "128");
    if (cfg.whisper.vadModel && fs.existsSync(cfg.whisper.vadModel)) {
      args.push("--vad", "--vad-model", cfg.whisper.vadModel);
    }

    const proc = spawn(cfg.whisper.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stdout.on("data", () => {});
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) =>
      reject(new Error(`Failed to launch whisper.cpp at "${cfg.whisper.binPath}": ${err.message}`)),
    );
    proc.on("close", (code) => {
      const outPath = `${outPrefix}.${json ? "json" : "txt"}`;
      if (code !== 0) {
        return reject(new Error(`whisper.cpp exited ${code}:\n${stderr.slice(-2000)}`));
      }
      if (!fs.existsSync(outPath)) {
        return reject(
          new Error(`whisper.cpp produced no output at ${outPath}.\n${stderr.slice(-2000)}`),
        );
      }
      const raw = fs.readFileSync(outPath, "utf8");
      try {
        fs.unlinkSync(outPath);
      } catch {}
      try {
        resolve(json ? parseWhisperSegments(raw) : raw.trim());
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Transcribe an audio file locally with whisper.cpp.
 * @returns {Promise<string>} transcript text
 */
export async function transcribe(cfg, audioPath) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }
  const wav = await toWav16k(audioPath);
  try {
    const text = await runWhisper(cfg, wav, { json: false });
    if (!text) throw new Error("Transcription came back empty.");
    return text;
  } finally {
    try {
      fs.unlinkSync(wav);
    } catch {}
  }
}

/**
 * Transcribe an audio file into timestamped segments (for two-track merging).
 * Returns [] for silence rather than throwing, so a quiet track degrades gracefully.
 * @returns {Promise<Array<{start:number,end:number,text:string}>>}
 */
export async function transcribeSegments(cfg, audioPath) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }
  const wav = await toWav16k(audioPath);
  try {
    return await runWhisper(cfg, wav, { json: true });
  } finally {
    try {
      fs.unlinkSync(wav);
    } catch {}
  }
}

/**
 * Interleave labeled tracks into a single speaker-tagged transcript, ordered by
 * time. Consecutive segments from the same speaker are merged into one line.
 * @param {Array<{label:string, segments:Array<{start:number,end:number,text:string}>}>} tracks
 * @returns {string} e.g. "[Me] ...\n[Them] ...\n[Me] ..."
 */
export function mergeTracks(tracks) {
  const all = [];
  for (const t of tracks || []) {
    for (const s of t.segments || []) all.push({ ...s, label: t.label });
  }
  // Sort by start time; ties broken by label for stable output.
  all.sort((a, b) => a.start - b.start || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  const lines = [];
  let cur = null;
  for (const seg of all) {
    if (cur && cur.label === seg.label) {
      cur.text += " " + seg.text;
    } else {
      if (cur) lines.push(`[${cur.label}] ${cur.text}`);
      cur = { label: seg.label, text: seg.text };
    }
  }
  if (cur) lines.push(`[${cur.label}] ${cur.text}`);
  return lines.join("\n");
}

// --- self-test: whisper-JSON parsing + track merging (no whisper binary needed) ---
if (process.argv[1] && process.argv[1].endsWith("transcribe.js") && process.argv.includes("--self-test")) {
  let ok = true;
  const eq = (c, m) => {
    if (!c) { ok = false; console.error("FAIL:", m); } else console.log("ok:", m);
  };

  const segs = parseWhisperSegments(
    JSON.stringify({
      transcription: [
        { offsets: { from: 0, to: 1500 }, text: " Привет." },
        { offsets: { from: 1500, to: 3000 }, text: " Как дела?" },
        { text: "   " }, // empty -> dropped
        { offsets: { from: 3000, to: 4000 } }, // no text -> dropped
      ],
    }),
  );
  eq(segs.length === 2, "parseWhisperSegments drops empty/missing-text segments");
  eq(segs[0].start === 0 && segs[0].end === 1500 && segs[0].text === "Привет.", "segment parsed + trimmed");
  eq(parseWhisperSegments(JSON.stringify({})).length === 0, "missing transcription -> []");

  const merged = mergeTracks([
    { label: "Me", segments: [{ start: 0, end: 1000, text: "Давай зафиналим." }, { start: 4000, end: 5000, text: "Я напишу пресс-релиз." }] },
    { label: "Them", segments: [{ start: 1200, end: 2000, text: "Окей." }, { start: 2100, end: 3000, text: "Закончу интеграцию." }] },
  ]);
  eq(
    merged === ["[Me] Давай зафиналим.", "[Them] Окей. Закончу интеграцию.", "[Me] Я напишу пресс-релиз."].join("\n"),
    "mergeTracks interleaves by time and groups consecutive speaker turns",
  );
  eq(mergeTracks([]) === "", "mergeTracks([]) -> ''");

  console.log(ok ? "\ntranscribe self-test: PASS" : "\ntranscribe self-test: FAIL");
  process.exit(ok ? 0 : 1);
}
