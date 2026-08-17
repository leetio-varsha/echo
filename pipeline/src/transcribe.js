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
 * Read the PCM layout of a canonical RIFF/WAVE file (the one ffmpeg just wrote).
 * Returns null when the file isn't plain PCM we can slice — callers then fall
 * back to transcribing it in one pass instead of failing.
 */
export function readWavInfo(wavPath) {
  let fd;
  try {
    fd = fs.openSync(wavPath, "r");
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12) return null;
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return null;

    const size = fs.fstatSync(fd).size;
    let pos = 12;
    let fmt = null;
    // Walk the chunk list; `data` can be preceded by LIST/fact/etc.
    while (pos + 8 <= size) {
      const hdr = Buffer.alloc(8);
      if (fs.readSync(fd, hdr, 0, 8, pos) < 8) return null;
      const id = hdr.toString("ascii", 0, 4);
      const len = hdr.readUInt32LE(4);
      const body = pos + 8;
      if (id === "fmt ") {
        const b = Buffer.alloc(Math.min(16, len));
        fs.readSync(fd, b, 0, b.length, body);
        if (b.length < 16) return null;
        fmt = {
          format: b.readUInt16LE(0),
          channels: b.readUInt16LE(2),
          sampleRate: b.readUInt32LE(4),
          bitsPerSample: b.readUInt16LE(14),
        };
      } else if (id === "data") {
        if (!fmt || fmt.format !== 1) return null; // not plain PCM -> don't slice
        const bytesPerFrame = (fmt.bitsPerSample / 8) * fmt.channels;
        if (!bytesPerFrame) return null;
        // A streamed WAV can carry len=0/0xFFFFFFFF; trust the file size then.
        const dataBytes = len > 0 && body + len <= size ? len : size - body;
        return {
          ...fmt,
          bytesPerFrame,
          dataOffset: body,
          dataBytes,
          durationSec: dataBytes / bytesPerFrame / fmt.sampleRate,
        };
      }
      pos = body + len + (len % 2); // chunks are word-aligned
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/** Write [fromSec, fromSec+lenSec) of a PCM wav to a new wav file. */
function writeWavSlice(srcPath, info, fromSec, lenSec, outPath) {
  const frameFrom = Math.floor(fromSec * info.sampleRate);
  const frames = Math.min(
    Math.ceil(lenSec * info.sampleRate),
    Math.floor(info.dataBytes / info.bytesPerFrame) - frameFrom,
  );
  const bytes = Math.max(0, frames * info.bytesPerFrame);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(info.channels, 22);
  header.writeUInt32LE(info.sampleRate, 24);
  header.writeUInt32LE(info.sampleRate * info.bytesPerFrame, 28);
  header.writeUInt16LE(info.bytesPerFrame, 32);
  header.writeUInt16LE(info.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(bytes, 40);

  const src = fs.openSync(srcPath, "r");
  const dst = fs.openSync(outPath, "w");
  try {
    fs.writeSync(dst, header);
    const buf = Buffer.alloc(Math.min(bytes, 1 << 22) || 1);
    let done = 0;
    while (done < bytes) {
      const want = Math.min(buf.length, bytes - done);
      const got = fs.readSync(src, buf, 0, want, info.dataOffset + frameFrom * info.bytesPerFrame + done);
      if (got <= 0) break;
      fs.writeSync(dst, buf, 0, got);
      done += got;
    }
  } finally {
    try {
      fs.closeSync(src);
    } catch {}
    try {
      fs.closeSync(dst);
    } catch {}
  }
}

/**
 * Short, punctuated seed sentences. whisper.cpp given no context frequently
 * drops into an unpunctuated all-lowercase mode for a whole chunk (and the
 * carried context keeps it there); priming it with one normal sentence in the
 * chunk's own language restores capitalization + punctuation.
 */
const PRIMING_PROMPTS = {
  en: "Okay, so let's align on the scope. I think we should discuss this.",
  ru: "Хорошо, давайте согласуем скоуп. Думаю, нам нужно это обсудить.",
  uk: "Добре, давайте узгодимо скоуп. Думаю, нам потрібно це обговорити.",
};

/** Normalize a token/phrase for repeat-detection: fold case, strip punctuation. */
function normForRepeat(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Collapse pathological repetition loops that whisper.cpp falls into on marginal /
 * overlapping audio ("I think that's a great point." ×hundreds), which `-mc 128`
 * shrinks but doesn't fully kill. Deterministic safety net: any phrase (1..maxPhraseLen
 * tokens) that repeats consecutively >= minReps times is capped to `keep` copies.
 * Real speech (a doubled word, "yeah yeah") stays untouched — only >= minReps runs collapse.
 *
 * `maxPhraseLen` must comfortably exceed a spoken sentence: real loops repeat a whole
 * sentence, and a limit shorter than it makes the whole backstop a no-op. (A 16-token
 * loop sailed through the original 12-token limit and ate 55 minutes of a call.)
 */
export function collapseRepeatedPhrases(
  text,
  { maxPhraseLen = 48, minReps = 3, keep = 2 } = {},
) {
  const tokens = String(text || "").split(/\s+/).filter(Boolean);
  if (tokens.length < minReps) return String(text || "").trim();
  const norm = tokens.map(normForRepeat);
  // Compare token windows directly instead of building joined keys: same result,
  // no per-window string allocation (this runs over whole-call transcripts).
  const sameWindow = (a, b, len) => {
    for (let k = 0; k < len; k++) if (norm[a + k] !== norm[b + k]) return false;
    return true;
  };
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let collapsed = false;
    // Shortest period first so "a b a b a b" collapses to "a b" (2 tokens), and a
    // "…point. …point." loop to one sentence — not to a longer multiple of the unit.
    const maxLen = Math.min(maxPhraseLen, Math.floor((tokens.length - i) / minReps));
    let allPunct = true;
    for (let len = 1; len <= maxLen; len++) {
      if (norm[i + len - 1]) allPunct = false;
      if (allPunct) continue; // phrase is all punctuation -> not a meaningful repeat
      let reps = 1;
      while (
        i + (reps + 1) * len <= tokens.length &&
        sameWindow(i, i + reps * len, len)
      ) {
        reps++;
      }
      if (reps >= minReps) {
        for (let r = 0; r < Math.min(keep, reps); r++) {
          out.push(...tokens.slice(i, i + len));
        }
        i += reps * len;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) {
      out.push(tokens[i]);
      i++;
    }
  }
  return out.join(" ");
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
function runWhisper(cfg, wavPath, { json = false, lang = null, prompt = "" } = {}) {
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
    const configured = cfg.whisper.lang && cfg.whisper.lang !== "auto" ? cfg.whisper.lang : null;
    args.push("-l", configured || lang || "auto");
    if (prompt) {
      args.push("--prompt", prompt);
    }
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
 * Ask whisper.cpp which language a wav is in (`-dl` exits right after detecting,
 * so this only costs one 30s window). Returns { lang, p } or null when detection
 * fails — callers then fall back to `auto`.
 *
 * VAD matters here as much as it does for transcription: detection reads the
 * FIRST window of the file, and on a per-speaker track that is usually silence
 * or breathing. Measured on one call's opening chunk: without VAD "en" p=0.51
 * and "en" p=0.32 (both wrong, and confident enough to be believed); with VAD
 * "ru" p=0.83 and "uk" p=0.93 (both right).
 */
function detectLanguage(cfg, wavPath) {
  return new Promise((resolve) => {
    const args = ["-m", cfg.whisper.modelPath, "-f", wavPath, "-dl"];
    if (cfg.whisper.vadModel && fs.existsSync(cfg.whisper.vadModel)) {
      args.push("--vad", "--vad-model", cfg.whisper.vadModel);
    }
    const proc = spawn(cfg.whisper.binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (out += d.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const m = out.match(/auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([0-9.]+)\)/i);
      resolve(m ? { lang: m[1].toLowerCase(), p: Number(m[2]) } : null);
    });
  });
}

/** Strip a priming prompt that whisper occasionally echoes back as the first segment. */
function dropEchoedPrompt(segments, prompt) {
  if (!prompt || !segments.length) return segments;
  const key = normForRepeat(prompt);
  // The echo can be the whole prompt or just its tail (e.g. the vocabulary list),
  // so match "first segment is a sizable substring of the prompt", not equality.
  return segments.filter((s, idx) => {
    if (idx !== 0) return true;
    const seg = normForRepeat(s.text);
    return !(seg.length >= 12 && key.includes(seg)) && seg !== key;
  });
}

/** Prompt for a chunk: punctuation-priming seed + domain vocabulary (names, terms). */
function chunkPrompt(lang, vocab) {
  const seed = (lang && PRIMING_PROMPTS[lang]) || "";
  return [seed, vocab].filter(Boolean).join(" ");
}

/**
 * Transcribe a 16kHz mono wav into timestamped segments, chunk by chunk.
 *
 * One whisper.cpp invocation detects the language once and carries decoder
 * context across the entire file. On a long, multilingual meeting that means a
 * single mis-detected 30s intro re-renders the whole call in the wrong language,
 * and one repetition loop keeps feeding itself to the end of the recording.
 * Transcribing in chunks gives each one a fresh context and its own language.
 * Falls back to a single pass when chunking is disabled or the wav can't be sliced.
 */
async function transcribeWavSegments(cfg, wavPath, vocab = "") {
  const info = readWavInfo(wavPath);
  const chunkSec = cfg.whisper.chunkSec;
  const chunks =
    chunkSec > 0 && info && info.durationSec > chunkSec
      ? Math.ceil(info.durationSec / chunkSec)
      : 1;
  // An explicitly configured WHISPER_LANG wins outright — don't pay for detection
  // we're going to ignore, and prime in the language we'll actually decode in.
  const forced = cfg.whisper.lang && cfg.whisper.lang !== "auto" ? cfg.whisper.lang : null;
  const languageOf = async (file, fallback) => {
    if (forced) return forced;
    const detected = await detectLanguage(cfg, file);
    return detected && detected.p >= 0.5 ? detected.lang : fallback;
  };

  if (chunks === 1) {
    const lang = await languageOf(wavPath, null);
    const prompt = chunkPrompt(lang, vocab);
    return dropEchoedPrompt(await runWhisper(cfg, wavPath, { json: true, lang, prompt }), prompt);
  }

  const all = [];
  let lastLang = null;
  for (let i = 0; i < chunks; i++) {
    const from = i * chunkSec;
    const slice = path.join(
      os.tmpdir(),
      `echo-chunk-${crypto.randomBytes(6).toString("hex")}.wav`,
    );
    writeWavSlice(wavPath, info, from, chunkSec, slice);
    try {
      // A near-silent chunk detects "some" language with low confidence; keep the
      // previous chunk's language there instead of letting the call switch tongue.
      const lang = await languageOf(slice, lastLang);
      if (lang) lastLang = lang;
      const prompt = chunkPrompt(lang, vocab);
      const segs = dropEchoedPrompt(
        await runWhisper(cfg, slice, { json: true, lang, prompt }),
        prompt,
      );
      const offset = from * 1000;
      for (const s of segs) all.push({ ...s, start: s.start + offset, end: s.end + offset });
      console.log(
        `  chunk ${i + 1}/${chunks} (${from}s+): lang=${lang || "auto"}, ${segs.length} segments`,
      );
    } finally {
      try {
        fs.unlinkSync(slice);
      } catch {}
    }
  }
  return all;
}

/**
 * Transcribe an audio file locally with whisper.cpp.
 * @returns {Promise<string>} transcript text
 */
export async function transcribe(cfg, audioPath, { vocab = "" } = {}) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }
  const wav = await toWav16k(audioPath);
  try {
    const segments = await transcribeWavSegments(cfg, wav, vocab);
    const text = segments.map((s) => s.text).join(" ").trim();
    if (!text) throw new Error("Transcription came back empty.");
    return collapseRepeatedPhrases(text);
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
export async function transcribeSegments(cfg, audioPath, { vocab = "" } = {}) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }
  const wav = await toWav16k(audioPath);
  try {
    return await transcribeWavSegments(cfg, wav, vocab);
  } finally {
    try {
      fs.unlinkSync(wav);
    } catch {}
  }
}

/**
 * Collapse runs of (near-)identical consecutive segments on ONE track before
 * merging. Per-turn `collapseRepeatedPhrases` misses a loop that ends up spread
 * across several turns (the other speaker's short interjections split it), but
 * on its own track the loop is still one consecutive run of equal segments.
 * Periods 1 and 2 cover the observed failures ("A A A…", "A B A B A B…").
 */
export function collapseRepeatedSegments(segments, { minReps = 3, keep = 2 } = {}) {
  const segs = segments || [];
  if (segs.length < minReps) return segs;
  const norm = segs.map((s) => normForRepeat(s.text));
  const out = [];
  let i = 0;
  while (i < segs.length) {
    let collapsed = false;
    for (const period of [1, 2]) {
      if (i + period * minReps > segs.length) break;
      let reps = 1;
      while (
        i + (reps + 1) * period <= segs.length &&
        Array.from({ length: period }, (_, k) => norm[i + k] && norm[i + k] === norm[i + reps * period + k]).every(Boolean)
      ) {
        reps++;
      }
      if (reps >= minReps) {
        out.push(...segs.slice(i, i + keep * period));
        i += reps * period;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) {
      out.push(segs[i]);
      i++;
    }
  }
  return out;
}

/**
 * A short interjection ("Okay.", "Yeah.", "Mm-hmm.") that lands in the middle of
 * the other speaker's sentence. Questions are never treated as backchannels —
 * "Is it correct?" must keep its exact position in the flow.
 */
function isBackchannel(text) {
  const t = String(text || "").trim();
  return t.length > 0 && t.length <= 40 && !t.includes("?") && t.split(/\s+/).length <= 4;
}

/** True when a turn ends on a finished sentence (so an interjection after it is NOT interrupting). */
function endsSentence(text) {
  return /[.!?…]["»')\]]*$/.test(String(text || "").trim());
}

/**
 * Interleave labeled tracks into a single speaker-tagged transcript, ordered by
 * time. Consecutive segments from the same speaker are merged into one line.
 * A short backchannel that interrupts the other speaker mid-sentence is moved
 * to AFTER that speaker's turn instead of shredding one sentence into three
 * lines ("[A] start of… [B] Okay. [A] …rest of the sentence").
 * @param {Array<{label:string, segments:Array<{start:number,end:number,text:string}>}>} tracks
 * @returns {string} e.g. "[Me] ...\n[Them] ...\n[Me] ..."
 */
export function mergeTracks(tracks) {
  const all = [];
  for (const t of tracks || []) {
    for (const s of collapseRepeatedSegments(t.segments || [])) all.push({ ...s, label: t.label });
  }
  // Sort by start time; ties broken by label for stable output.
  all.sort((a, b) => a.start - b.start || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  // Group into speaker turns first.
  const turns = [];
  for (const seg of all) {
    const cur = turns[turns.length - 1];
    if (cur && cur.label === seg.label) {
      cur.text += " " + seg.text;
    } else {
      turns.push({ label: seg.label, text: seg.text });
    }
  }

  // Weave backchannels: [A][b][A] where A was cut off mid-sentence and b is a
  // short non-question interjection becomes one merged [A] turn followed by [b].
  // Repeat until stable so a chain ("[A] [b] [A] [b] [A]") fully reassembles.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < turns.length - 1; i++) {
      if (
        turns[i - 1].label === turns[i + 1].label &&
        turns[i].label !== turns[i - 1].label &&
        !endsSentence(turns[i - 1].text) &&
        isBackchannel(turns[i].text)
      ) {
        turns[i - 1].text += " " + turns[i + 1].text;
        const back = turns[i];
        turns.splice(i, 2, back);
        changed = true;
        break;
      }
    }
  }

  return turns
    .map((t) => `[${t.label}] ${collapseRepeatedPhrases(t.text)}`)
    .join("\n");
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

  // --- repetition-loop collapse (the "transcript поплыл" failure) ---
  const loop = "I think that's a great point. ".repeat(200).trim();
  const deLooped = collapseRepeatedPhrases(loop);
  eq(deLooped === "I think that's a great point. I think that's a great point.",
    "collapseRepeatedPhrases caps a 200x sentence loop to 2 copies");
  eq(collapseRepeatedPhrases("Мальчик ".repeat(12).trim()) === "Мальчик Мальчик",
    "collapses a 12x single-word loop (unicode) to 2");
  eq(collapseRepeatedPhrases("yeah yeah") === "yeah yeah",
    "leaves a genuine doubled word alone (below minReps)");
  eq(collapseRepeatedPhrases("da da da") === "da da",
    "collapses a 3x run down to keep=2");
  eq(collapseRepeatedPhrases("This is a normal sentence with no loops at all.")
    === "This is a normal sentence with no loops at all.",
    "leaves normal speech untouched");
  eq(collapseRepeatedPhrases("great point great point great point extra")
    === "great point great point extra",
    "collapses a repeated 2-token phrase, keeps trailing context");
  {
    // end-to-end: a looping Them track gets de-looped inside mergeTracks
    const themLoop = Array.from({ length: 50 }, (_, k) => ({
      start: 1000 + k, end: 1000 + k, text: "I think that's a great point.",
    }));
    const m = mergeTracks([
      { label: "Me", segments: [{ start: 0, end: 500, text: "Yeah." }] },
      { label: "Them", segments: themLoop },
    ]);
    eq(m === "[Me] Yeah.\n[Them] I think that's a great point. I think that's a great point.",
      "mergeTracks de-loops a 50-segment repetition on one track");
  }
  {
    // The 2026-08-04 failure: a 16-token sentence looped 391× and sailed straight
    // through the old 12-token limit, wiping 55 minutes of one track.
    const s16 = "Yeah, and I think I can do something for today, but very basic implementation will be.";
    eq(s16.split(/\s+/).length === 16, "regression fixture really is 16 tokens");
    eq(collapseRepeatedPhrases(`${s16} `.repeat(391).trim()) === `${s16} ${s16}`,
      "collapses a 16-token sentence loop (old maxPhraseLen=12 missed it entirely)");
    // …and the long one that survived on the other track of the same call.
    const s34 = "Okay, so then it means, Jane, that there is no need to show this info when we show on the dashboard cards, you know, that three targets are in outreach because, like, we don't have.";
    eq(s34.split(/\s+/).length > 30, "long fixture is >30 tokens");
    eq(collapseRepeatedPhrases(`${s34} `.repeat(6).trim()) === `${s34} ${s34}`,
      "collapses a >30-token sentence loop");
    eq(collapseRepeatedPhrases(`Hi. ${s16} ${s16} ${s16} Bye.`) === `Hi. ${s16} ${s16} Bye.`,
      "keeps the surrounding speech when collapsing a long loop");
  }

  // --- backchannel weaving: don't shred a sentence around a short interjection ---
  {
    const m = mergeTracks([
      { label: "Them", segments: [
        { start: 0, end: 2000, text: "My question is, it seems like we placed a lot of cards on" },
        { start: 5000, end: 7000, text: "the top half above the acquisition targets." },
      ] },
      { label: "Me", segments: [{ start: 3000, end: 3500, text: "Okay." }] },
    ]);
    eq(
      m === "[Them] My question is, it seems like we placed a lot of cards on the top half above the acquisition targets.\n[Me] Okay.",
      "weaves a mid-sentence backchannel to after the interrupted turn",
    );
  }
  {
    // A finished sentence before the interjection -> real turn-taking, keep order.
    const m = mergeTracks([
      { label: "Me", segments: [
        { start: 0, end: 1000, text: "Давай зафиналим." },
        { start: 4000, end: 5000, text: "Я напишу пресс-релиз." },
      ] },
      { label: "Them", segments: [{ start: 2000, end: 2500, text: "Окей." }] },
    ]);
    eq(
      m === "[Me] Давай зафиналим.\n[Them] Окей.\n[Me] Я напишу пресс-релиз.",
      "does NOT weave when the previous turn ended on a full sentence",
    );
  }
  {
    // Questions are never woven — their position carries meaning.
    const m = mergeTracks([
      { label: "Them", segments: [
        { start: 0, end: 2000, text: "So we do three for Scout and" },
        { start: 5000, end: 7000, text: "ten for Operator, is that fine?" },
      ] },
      { label: "Me", segments: [{ start: 3000, end: 3500, text: "Is it correct?" }] },
    ]);
    eq(m.startsWith("[Them] So we do three for Scout and\n[Me] Is it correct?"),
      "keeps a question interjection in place");
  }

  // --- segment-level loop collapse (cross-turn loops on one track) ---
  {
    const loopSeg = (k, text) => ({ start: 1000 + k * 100, end: 1000 + k * 100 + 50, text });
    const segs = [
      loopSeg(0, "So yeah, and here we go."),
      ...Array.from({ length: 6 }, (_, k) => loopSeg(k + 1, "Yeah, we're going to have to implement this.")),
      loopSeg(9, "We're locked into the dashboard."),
    ];
    const out = collapseRepeatedSegments(segs);
    eq(out.length === 4, "collapseRepeatedSegments caps a 6x identical-segment run to 2");
    eq(out[out.length - 1].text === "We're locked into the dashboard.", "keeps surrounding segments");
    // period-2 loop: A B A B A B -> A B A B
    const ab = ["A phrase.", "B phrase.", "A phrase.", "B phrase.", "A phrase.", "B phrase."]
      .map((t, k) => loopSeg(k, t));
    eq(collapseRepeatedSegments(ab).length === 4, "collapses a period-2 segment loop");
    eq(collapseRepeatedSegments([loopSeg(0, "hi"), loopSeg(1, "hi")]).length === 2,
      "leaves a doubled segment alone (below minReps)");
  }

  // --- wav header parsing + slicing (chunked transcription) ---
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-wavtest-"));
    const wav = path.join(dir, "t.wav");
    const rate = 16000, secs = 5, frames = rate * secs;
    const pcm = Buffer.alloc(frames * 2);
    for (let k = 0; k < frames; k++) pcm.writeInt16LE((k % 30000) - 15000, k * 2);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + pcm.length, 4);
    h.write("WAVEfmt ", 8, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
    h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write("data", 36, "ascii"); h.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(wav, Buffer.concat([h, pcm]));

    const info = readWavInfo(wav);
    eq(info && info.sampleRate === 16000 && info.channels === 1, "readWavInfo reads fmt");
    eq(info && Math.abs(info.durationSec - secs) < 1e-9, "readWavInfo computes duration");
    eq(readWavInfo(path.join(dir, "nope.wav")) === null, "readWavInfo(missing) -> null (degrades to single pass)");
    fs.writeFileSync(path.join(dir, "junk.wav"), Buffer.from("not a wav at all"));
    eq(readWavInfo(path.join(dir, "junk.wav")) === null, "readWavInfo(non-wav) -> null");

    const slice = path.join(dir, "s.wav");
    writeWavSlice(wav, info, 1, 2, slice);
    const si = readWavInfo(slice);
    eq(si && Math.abs(si.durationSec - 2) < 1e-9, "writeWavSlice yields the requested duration");
    eq(
      Buffer.compare(
        fs.readFileSync(slice).subarray(si.dataOffset),
        pcm.subarray(rate * 2, rate * 2 * 3),
      ) === 0,
      "writeWavSlice copies exactly the requested samples",
    );
    // A slice running past the end is clamped, not padded with garbage.
    writeWavSlice(wav, info, 4, 10, slice);
    eq(Math.abs(readWavInfo(slice).durationSec - 1) < 1e-9, "writeWavSlice clamps at end of file");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(ok ? "\ntranscribe self-test: PASS" : "\ntranscribe self-test: FAIL");
  process.exit(ok ? 0 : 1);
}
