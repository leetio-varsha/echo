import { Client } from "@notionhq/client";

const MAX_TEXT = 1900; // Notion hard limit is 2000 chars per rich_text item
const MAX_CHILDREN_PER_CALL = 90; // Notion allows 100; stay under

function richText(content) {
  // Notion rejects rich_text items with empty content; return [] instead.
  if (!content) return [];
  return [{ type: "text", text: { content: content.slice(0, MAX_TEXT) } }];
}

/** Split a long string into <=MAX_TEXT chunks on whitespace where possible. */
function chunkText(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > MAX_TEXT) {
    let cut = rest.lastIndexOf(" ", MAX_TEXT);
    if (cut < MAX_TEXT * 0.6) cut = MAX_TEXT; // no good break point
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function heading(text) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: richText(text) },
  };
}

function paragraph(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richText(text) },
  };
}

function bullet(text) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richText(text) },
  };
}

function todo(text) {
  return {
    object: "block",
    type: "to_do",
    to_do: { rich_text: richText(text), checked: false },
  };
}

/** Build the page body blocks from a parsed summary + full transcript. */
export function buildBlocks(summary, transcript) {
  const blocks = [];

  if (summary.tldr) {
    blocks.push(heading("TL;DR"));
    blocks.push(paragraph(summary.tldr));
  }
  if (summary.decisions.length) {
    blocks.push(heading("Решения"));
    for (const d of summary.decisions) blocks.push(bullet(d));
  }
  if (summary.action_items.length) {
    blocks.push(heading("Action items"));
    for (const a of summary.action_items) blocks.push(todo(a));
  }
  if (summary.open_questions.length) {
    blocks.push(heading("Открытые вопросы"));
    for (const q of summary.open_questions) blocks.push(bullet(q));
  }

  // Full transcript inside a collapsed toggle.
  const transcriptChildren = chunkText(transcript || "(empty)").map(paragraph);
  blocks.push({
    object: "block",
    type: "toggle",
    toggle: {
      rich_text: richText("📄 Полный транскрипт"),
      // toggle children are capped at 100; chunk if needed (transcripts rarely exceed)
      children: transcriptChildren.slice(0, 95),
    },
  });

  return blocks;
}

/**
 * Fetch active projects from the Projects DB.
 * Returns [{ id, name }]. We filter client-side on Status to avoid schema coupling.
 */
export async function fetchActiveProjects(client, projectsDbId, doneStatus = "Завершён") {
  const results = [];
  let cursor;
  do {
    const resp = await client.databases.query({
      database_id: projectsDbId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of resp.results) {
      const props = page.properties || {};
      const titleProp = Object.values(props).find((p) => p.type === "title");
      const name = (titleProp?.title || []).map((t) => t.plain_text).join("").trim();
      const status = props.Status?.select?.name || "";
      if (!name) continue;
      // Keep active + paused; skip clearly-archived (PROJECT_DONE_STATUS) to reduce noise.
      if (status === doneStatus) continue;
      results.push({ id: page.id, name });
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return results;
}

/** Resolve a suggested project name to a page id (case-insensitive exact match). */
export function resolveProjectId(projects, name) {
  if (!name) return null;
  const target = name.trim().toLowerCase();
  const hit = projects.find((p) => p.name.trim().toLowerCase() === target);
  return hit ? hit.id : null;
}

/**
 * Create the Calls page. Returns { url, id } (or a preview object in dry-run).
 */
export async function createCallPage(cfg, { summary, transcript, projectId, date }) {
  const properties = {
    Name: { title: richText(summary.title) },
    Date: { date: { start: (date || new Date()).toISOString() } },
    Participants: {
      rich_text: richText(summary.participants.join(", ") || ""),
    },
    "Open follow-ups": { checkbox: summary.action_items.length > 0 },
  };
  if (projectId) {
    properties.Project = { relation: [{ id: projectId }] };
  }

  const blocks = buildBlocks(summary, transcript);

  if (cfg.dryRun) {
    console.log("\n[dry-run] Would create Calls page:");
    console.log(JSON.stringify({ properties, blockCount: blocks.length, projectId }, null, 2));
    return { url: "(dry-run)", id: "(dry-run)" };
  }

  const client = new Client({ auth: cfg.notion.token });

  const page = await client.pages.create({
    parent: { database_id: cfg.notion.callsDbId },
    properties,
    children: blocks.slice(0, MAX_CHILDREN_PER_CALL),
  });

  // Append any overflow blocks.
  if (blocks.length > MAX_CHILDREN_PER_CALL) {
    for (let i = MAX_CHILDREN_PER_CALL; i < blocks.length; i += MAX_CHILDREN_PER_CALL) {
      await client.blocks.children.append({
        block_id: page.id,
        children: blocks.slice(i, i + MAX_CHILDREN_PER_CALL),
      });
    }
  }

  return { url: page.url, id: page.id };
}

/** Convenience: a Notion client for project lookup. */
export function makeClient(cfg) {
  return new Client({ auth: cfg.notion.token });
}
