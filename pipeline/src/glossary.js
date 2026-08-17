import fs from "node:fs";
import path from "node:path";
import { Client } from "@notionhq/client";
import { PIPELINE_ROOT } from "./config.js";

// Fetched Notion glossary is cached here so a network/API failure never costs
// us the vocabulary (degrade gracefully — hard rule 4).
const CACHE_PATH = path.join(PIPELINE_ROOT, ".glossary-cache.txt");

/**
 * Parse a free-form glossary text into a term list. Accepts one term per line
 * and/or comma-separated lists; `#` starts a comment; bullets are stripped.
 * Deduped case-insensitively, order preserved (put the important terms first —
 * the whisper prompt budget is small).
 */
export function parseGlossaryText(text) {
  const seen = new Set();
  const terms = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").replace(/^[\s\-*•]+/, "").trim();
    if (!line) continue;
    for (const piece of line.split(",")) {
      const term = piece.trim();
      // Real terms are short; a long "term" is prose that leaked in (an intro
      // sentence on the glossary page) — drop it rather than waste prompt budget.
      if (!term || term.length > 40) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
    }
  }
  return terms;
}

/** Plain text of every child block of a Notion page (one level deep is enough). */
async function fetchNotionPageText(token, pageId) {
  const client = new Client({ auth: token });
  const lines = [];
  let cursor;
  do {
    const resp = await client.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const block of resp.results) {
      const rich = block[block.type]?.rich_text;
      if (!Array.isArray(rich)) continue;
      // Headings are section labels ("Люди", "Термины"), not terms — comment them out.
      const prefix = block.type.startsWith("heading") ? "# " : "";
      lines.push(prefix + rich.map((t) => t.plain_text).join(""));
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return lines.join("\n");
}

/**
 * Load the transcription glossary: local file + (optionally) a Notion page the
 * user edits by hand. The Notion copy is cached locally; when the fetch fails
 * we fall back to the cache so transcription never blocks on Notion.
 */
export async function loadGlossary(cfg) {
  const terms = [];

  if (cfg.glossaryPath && fs.existsSync(cfg.glossaryPath)) {
    try {
      terms.push(...parseGlossaryText(fs.readFileSync(cfg.glossaryPath, "utf8")));
    } catch (e) {
      console.warn(`Could not read glossary file ${cfg.glossaryPath}: ${e.message}`);
    }
  }

  if (cfg.notion.glossaryPageId && cfg.notion.token) {
    try {
      const text = await fetchNotionPageText(cfg.notion.token, cfg.notion.glossaryPageId);
      try {
        fs.writeFileSync(CACHE_PATH, text, "utf8");
      } catch {}
      terms.push(...parseGlossaryText(text));
    } catch (e) {
      console.warn(`Could not fetch Notion glossary (using cache if any): ${e.message}`);
      try {
        terms.push(...parseGlossaryText(fs.readFileSync(CACHE_PATH, "utf8")));
      } catch {}
    }
  }

  // Dedupe across sources.
  return parseGlossaryText(terms.join("\n"));
}

/**
 * Vocabulary string for the whisper `--prompt`: attendee names from the calendar
 * event first (they are the words whisper most reliably garbles), then glossary
 * terms, capped to leave room for the punctuation-priming seed. whisper.cpp only
 * keeps ~224 tokens of prompt, so a short prioritized list beats a long one.
 */
export function buildVocab(glossaryTerms, meeting, maxChars = 400) {
  const names = Array.isArray(meeting?.attendees) ? meeting.attendees.filter(Boolean) : [];
  const all = parseGlossaryText([...names, ...(glossaryTerms || [])].join("\n"));
  const kept = [];
  let len = 0;
  for (const term of all) {
    if (len + term.length + 2 > maxChars) break;
    kept.push(term);
    len += term.length + 2;
  }
  return kept.join(", ");
}

// --- self-test ---
if (process.argv[1] && process.argv[1].endsWith("glossary.js") && process.argv.includes("--self-test")) {
  let ok = true;
  const eq = (c, m) => {
    if (!c) { ok = false; console.error("FAIL:", m); } else console.log("ok:", m);
  };

  const terms = parseGlossaryText(
    "# comment line\nNorthwind, Clerk\n- Jane\n• ATEM  # trailing comment\n\nnorthwind\nLightbox RE",
  );
  eq(JSON.stringify(terms) === JSON.stringify(["Northwind", "Clerk", "Jane", "ATEM", "Lightbox RE"]),
    "parseGlossaryText: bullets/comments/commas/dedupe");
  eq(parseGlossaryText("").length === 0, "empty text -> []");

  const vocab = buildVocab(["Northwind", "Clerk"], { attendees: ["Jane Doe", "Yuri"], me: "Yuri" });
  eq(vocab === "Jane Doe, Yuri, Northwind, Clerk", "buildVocab: attendees first, then terms");
  eq(buildVocab([], null) === "", "buildVocab: no sources -> empty string");
  const long = buildVocab(Array.from({ length: 200 }, (_, i) => `term${i}`), null, 50);
  eq(long.length <= 50, "buildVocab respects the char cap");

  console.log(ok ? "\nglossary self-test: PASS" : "\nglossary self-test: FAIL");
  process.exit(ok ? 0 : 1);
}
