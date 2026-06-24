import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { PIPELINE_ROOT } from "./config.js";

const PROMPT_PATH = path.join(PIPELINE_ROOT, "prompts", "summary.md");

const LANGUAGE_INSTRUCTIONS = {
  auto: "Write the entire summary in the dominant language spoken in the transcript (Ukrainian, Russian, or English). Match the speakers' language.",
  ru: "Write the entire summary in Russian, regardless of the transcript language.",
  uk: "Write the entire summary in Ukrainian, regardless of the transcript language.",
  en: "Write the entire summary in English, regardless of the transcript language.",
};

const REQUIRED_KEYS = [
  "title",
  "tldr",
  "decisions",
  "action_items",
  "open_questions",
  "participants",
  "suggested_project",
];

/** Render calendar meeting context (title + attendees) for the prompt. */
function formatMeeting(meeting) {
  const attendees = Array.isArray(meeting?.attendees) ? meeting.attendees.filter(Boolean) : [];
  if (!meeting || (!meeting.title && !meeting.me && !attendees.length)) {
    return "(no calendar event matched this call)";
  }
  const lines = [];
  if (meeting.title) lines.push(`Title: ${meeting.title}`);
  if (meeting.me) lines.push(`You (the "[Me]" speaker): ${meeting.me}`);
  const others = attendees.filter((a) => a !== meeting.me);
  if (others.length) lines.push(`Other attendee(s) (the "[Them]" speaker[s]): ${others.join(", ")}`);
  return lines.join("\n");
}

function buildPrompt({ transcript, summaryLang, projectNames, meeting }) {
  const template = fs.readFileSync(PROMPT_PATH, "utf8");
  const projectList =
    projectNames && projectNames.length
      ? projectNames.map((n) => `- ${n}`).join("\n")
      : "(no projects available — always return null for suggested_project)";
  return template
    .replace("{{LANGUAGE_INSTRUCTION}}", LANGUAGE_INSTRUCTIONS[summaryLang] || LANGUAGE_INSTRUCTIONS.auto)
    .replace("{{MEETING_CONTEXT}}", formatMeeting(meeting))
    .replace("{{PROJECT_LIST}}", projectList)
    .replace("{{TRANSCRIPT}}", transcript);
}

/**
 * Defensively extract a JSON object from a model response that may include
 * markdown fences, leading prose, or trailing text.
 */
export function parseSummaryResponse(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Empty model response.");
  }
  let text = raw.trim();

  // Strip ```json ... ``` or ``` ... ``` fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // If there's still surrounding prose, grab the outermost {...}.
  if (!text.startsWith("{")) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      text = text.slice(first, last + 1);
    }
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`Could not parse JSON from model response: ${err.message}\n---\n${raw.slice(0, 1000)}`);
  }

  // Normalize + validate shape.
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
  const str = (v) => (typeof v === "string" ? v.trim() : "");

  const result = {
    title: str(obj.title) || "Untitled meeting",
    tldr: str(obj.tldr),
    decisions: arr(obj.decisions),
    action_items: arr(obj.action_items),
    open_questions: arr(obj.open_questions),
    participants: arr(obj.participants),
    suggested_project:
      obj.suggested_project === null || obj.suggested_project === undefined
        ? null
        : str(obj.suggested_project) || null,
  };

  // Guarantee all keys exist (defensive).
  for (const k of REQUIRED_KEYS) {
    if (!(k in result)) throw new Error(`Parsed summary missing key: ${k}`);
  }
  return result;
}

/**
 * Summarize a transcript via Claude. In dry-run mode, prints the prompt and
 * returns a stub so the rest of the pipeline can be exercised without an API key.
 */
export async function summarize(cfg, { transcript, projectNames, meeting }) {
  const prompt = buildPrompt({ transcript, summaryLang: cfg.summaryLang, projectNames, meeting });

  if (cfg.dryRun) {
    console.log(`\n[dry-run] Prompt that would be sent to Claude (backend=${cfg.summaryBackend}):\n`);
    console.log(prompt.slice(0, 1500) + (prompt.length > 1500 ? "\n…[truncated]" : ""));
    return {
      title: "[dry-run] Sample meeting",
      tldr: "[dry-run] No Claude call was made.",
      decisions: [],
      action_items: [],
      open_questions: [],
      participants: [],
      suggested_project: projectNames && projectNames[0] ? projectNames[0] : null,
    };
  }

  const raw =
    cfg.summaryBackend === "api"
      ? await summarizeViaApi(cfg, prompt)
      : await summarizeViaClaudeCli(cfg, prompt);

  return parseSummaryResponse(raw);
}

/** Backend "api": direct Anthropic API call. Metered — needs ANTHROPIC_API_KEY. */
async function summarizeViaApi(cfg, prompt) {
  const client = new Anthropic({ apiKey: cfg.anthropic.apiKey });
  const msg = await client.messages.create({
    model: cfg.anthropic.model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Backend "claude-cli": shell out to the `claude` CLI in headless print mode.
 * Reuses this machine's Claude Code login (subscription) — no API key, no
 * metered billing. We run in a neutral cwd so no project CLAUDE.md/context is
 * loaded, and strip ANTHROPIC_API_KEY from the child env so the CLI cannot
 * silently fall back to metered API billing.
 *
 * The CLI returns a JSON envelope; the model's text is in its `result` field,
 * which we hand to the same defensive parser used by the API backend.
 */
function summarizeViaClaudeCli(cfg, prompt) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--model", cfg.anthropic.model];
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn(cfg.anthropic.claudeCliPath, args, {
      cwd: os.tmpdir(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      reject(
        new Error(
          `Failed to launch Claude CLI ("${cfg.anthropic.claudeCliPath}"): ${e.message}. ` +
            `Install & log in to Claude Code, set CLAUDE_CLI_PATH, or use SUMMARY_BACKEND=api.`,
        ),
      ),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`Claude CLI exited ${code}: ${(err || out).trim().slice(-2000)}`));
      }
      let envelope;
      try {
        envelope = JSON.parse(out);
      } catch (e) {
        return reject(new Error(`Claude CLI did not return JSON (${e.message}):\n${out.slice(0, 500)}`));
      }
      if (envelope.is_error || envelope.subtype !== "success") {
        return reject(
          new Error(
            `Claude CLI reported an error: ${envelope.subtype || "unknown"} ${envelope.result || ""}`.trim(),
          ),
        );
      }
      resolve(typeof envelope.result === "string" ? envelope.result : "");
    });

    child.stdin.on("error", () => {}); // ignore EPIPE if the CLI exits early
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// --- self-test: validate parsing against tricky sample responses ---
if (process.argv[1] && process.argv[1].endsWith("summarize.js") && process.argv.includes("--self-test")) {
  const samples = [
    // clean JSON
    `{"title":"Sync","tldr":"We synced.","decisions":["Ship Friday"],"action_items":["Yuri: write spec"],"open_questions":[],"participants":["Yuri","Alex"],"suggested_project":"Echo"}`,
    // fenced
    "```json\n{\"title\":\"X\",\"tldr\":\"y\",\"decisions\":[],\"action_items\":[],\"open_questions\":[],\"participants\":[],\"suggested_project\":null}\n```",
    // prose around it + missing arrays
    'Here is the summary:\n{"title":"Z","tldr":"hi","suggested_project":"Zoria"}\nHope this helps!',
  ];
  let ok = true;
  for (const [i, s] of samples.entries()) {
    try {
      const r = parseSummaryResponse(s);
      for (const k of REQUIRED_KEYS) if (!(k in r)) throw new Error(`missing ${k}`);
      console.log(`sample ${i}: OK -> title="${r.title}", project=${JSON.stringify(r.suggested_project)}, actions=${r.action_items.length}`);
    } catch (e) {
      ok = false;
      console.error(`sample ${i}: FAIL -> ${e.message}`);
    }
  }
  console.log(ok ? "\nparse self-test: PASS" : "\nparse self-test: FAIL");
  process.exit(ok ? 0 : 1);
}
