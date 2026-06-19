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
 * Run whisper.cpp on a WAV file and return the transcript text.
 * We ask whisper to write a plain .txt next to a temp output prefix and read it.
 */
function runWhisper(cfg, wavPath) {
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
      "-otxt",
      "-of",
      outPrefix,
      "-np", // no prints / progress noise
    ];
    if (cfg.whisper.lang && cfg.whisper.lang !== "auto") {
      args.push("-l", cfg.whisper.lang);
    } else {
      args.push("-l", "auto");
    }
    if (cfg.whisper.threads) {
      args.push("-t", String(cfg.whisper.threads));
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
      const txtPath = `${outPrefix}.txt`;
      if (code !== 0) {
        return reject(new Error(`whisper.cpp exited ${code}:\n${stderr.slice(-2000)}`));
      }
      if (!fs.existsSync(txtPath)) {
        return reject(
          new Error(`whisper.cpp produced no transcript file at ${txtPath}.\n${stderr.slice(-2000)}`),
        );
      }
      const text = fs.readFileSync(txtPath, "utf8").trim();
      try {
        fs.unlinkSync(txtPath);
      } catch {}
      resolve(text);
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
    const text = await runWhisper(cfg, wav);
    if (!text) throw new Error("Transcription came back empty.");
    return text;
  } finally {
    try {
      fs.unlinkSync(wav);
    } catch {}
  }
}
