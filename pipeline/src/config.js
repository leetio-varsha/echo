import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// pipeline/ root (one level up from src/)
export const PIPELINE_ROOT = path.resolve(__dirname, "..");

// Load pipeline/.env regardless of cwd.
dotenv.config({ path: path.join(PIPELINE_ROOT, ".env") });

function req(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required env var ${name}. Copy pipeline/.env.example to pipeline/.env and fill it in.`,
    );
  }
  return v.trim();
}

function opt(name, fallback = "") {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/**
 * Resolve a possibly-relative path against the pipeline root.
 */
function resolveFromRoot(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(PIPELINE_ROOT, p);
}

/**
 * Build the validated config. When opts.dryRun is true we don't hard-fail on
 * missing API credentials, so the pipeline can be exercised without secrets.
 */
export function loadConfig({ dryRun = false } = {}) {
  const summaryLang = opt("SUMMARY_LANG", "auto").toLowerCase();
  if (!["auto", "ru", "uk", "en"].includes(summaryLang)) {
    throw new Error(`SUMMARY_LANG must be one of auto|ru|uk|en, got "${summaryLang}"`);
  }

  const whisperLang = opt("WHISPER_LANG", "auto").toLowerCase();

  const cfg = {
    dryRun,
    anthropic: {
      apiKey: dryRun ? opt("ANTHROPIC_API_KEY") : req("ANTHROPIC_API_KEY"),
      model: opt("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
    },
    notion: {
      token: dryRun ? opt("NOTION_TOKEN") : req("NOTION_TOKEN"),
      callsDbId: req("NOTION_CALLS_DB_ID"),
      projectsDbId: req("NOTION_PROJECTS_DB_ID"),
    },
    whisper: {
      binPath: dryRun ? opt("WHISPER_CPP_PATH") : req("WHISPER_CPP_PATH"),
      modelPath: resolveFromRoot(opt("WHISPER_MODEL", "models/ggml-large-v3.bin")),
      lang: whisperLang,
      threads: opt("WHISPER_THREADS"),
    },
    summaryLang,
  };

  // Sanity-check local file paths only when not in dry-run (and only if set).
  if (!dryRun) {
    if (!fs.existsSync(cfg.whisper.binPath)) {
      throw new Error(
        `whisper.cpp binary not found at WHISPER_CPP_PATH="${cfg.whisper.binPath}". Build whisper.cpp and point this at whisper-cli (or main).`,
      );
    }
    if (!fs.existsSync(cfg.whisper.modelPath)) {
      throw new Error(
        `whisper model not found at WHISPER_MODEL="${cfg.whisper.modelPath}". Download the ggml model first (see README).`,
      );
    }
  }

  return cfg;
}
