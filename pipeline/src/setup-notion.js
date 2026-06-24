#!/usr/bin/env node
// Provision a user's Notion workspace for Echo: create the Projects + Calls
// databases (with the schema the pipeline expects) under a parent page, then
// write the token + ids into pipeline/.env. Idempotent — reuses existing
// "Projects"/"Calls" databases found under the parent.
//
// Usage (invoked by the app's onboarding):
//   node src/setup-notion.js --token=<secret> --parent=<page-url-or-id> [--done-status=Done]
// Prints a single JSON line: {"ok":true,"callsDbId":"…","projectsDbId":"…"} or {"ok":false,"error":"…"}.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@notionhq/client";

const PIPELINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(PIPELINE_ROOT, ".env");

function arg(name) {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

function done(obj) {
  console.log(JSON.stringify(obj));
  process.exit(obj.ok ? 0 : 1);
}

/** Extract a Notion id from a URL or raw id and format as a UUID. */
function parseId(s) {
  if (!s) return null;
  // Prefer an already-dashed UUID; else a contiguous 32-hex run (Notion URLs put
  // it after a "-"/"/" so separators keep stray hex letters from gluing on).
  const dashed = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (dashed) return dashed[0].toLowerCase();
  const plain = s.match(/[0-9a-f]{32}/i);
  if (!plain) return null;
  const h = plain[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Read/modify/write KEY=value pairs in .env (create from .env.example if missing). */
function setEnv(updates, envPath = ENV_PATH) {
  let text = "";
  if (fs.existsSync(envPath)) text = fs.readFileSync(envPath, "utf8");
  else if (fs.existsSync(`${envPath}.example`)) text = fs.readFileSync(`${envPath}.example`, "utf8");
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, `${k}=${v}`);
    else text += `${text.endsWith("\n") || text === "" ? "" : "\n"}${k}=${v}\n`;
  }
  fs.writeFileSync(envPath, text);
}

/** Offline self-test of the deterministic helpers (no Notion, no real .env). */
function selfTest() {
  let ok = true;
  const eq = (c, m) => { if (!c) { ok = false; console.error("FAIL:", m); } else console.log("ok:", m); };
  eq(parseId("https://www.notion.so/me/Title-3893a6aebd6581e0b165ec4146650bea?pvs=4")
     === "3893a6ae-bd65-81e0-b165-ec4146650bea", "parseId extracts uuid from a Notion URL");
  eq(parseId("3893a6aebd6581e0b165ec4146650bea") === "3893a6ae-bd65-81e0-b165-ec4146650bea", "parseId from raw id");
  eq(parseId("nope") === null, "parseId returns null on garbage");

  const tmp = path.join(os.tmpdir(), `echo-env-test-${Date.now()}`);
  fs.writeFileSync(tmp, "NOTION_TOKEN=\nKEEP=yes\n");
  setEnv({ NOTION_TOKEN: "secret_x", NOTION_CALLS_DB_ID: "abc" }, tmp);
  const out = fs.readFileSync(tmp, "utf8");
  fs.unlinkSync(tmp);
  eq(/^NOTION_TOKEN=secret_x$/m.test(out), "setEnv replaces an existing key");
  eq(/^NOTION_CALLS_DB_ID=abc$/m.test(out), "setEnv appends a missing key");
  eq(/^KEEP=yes$/m.test(out), "setEnv preserves other keys");
  console.log(ok ? "\nsetup-notion self-test: PASS" : "\nsetup-notion self-test: FAIL");
  process.exit(ok ? 0 : 1);
}

/** Find a child_database titled `title` directly under the parent page (idempotency). */
async function findChildDb(client, parentId, title) {
  let cursor;
  do {
    const resp = await client.blocks.children.list({ block_id: parentId, start_cursor: cursor, page_size: 100 });
    for (const b of resp.results) {
      if (b.type === "child_database" && b.child_database?.title === title) return b.id;
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return null;
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const token = arg("token");
  const parentRaw = arg("parent");
  const doneStatus = arg("done-status") || "Done";
  if (!token) return done({ ok: false, error: "Missing --token." });
  const parentId = parseId(parentRaw);
  if (!parentId) return done({ ok: false, error: "Missing/invalid --parent (paste the Notion page URL)." });

  const client = new Client({ auth: token });

  // Validate token early for a clear error.
  try {
    await client.users.me();
  } catch {
    return done({ ok: false, error: "Invalid Notion token, or the integration has no access." });
  }

  // Projects DB (create or reuse).
  let projectsDbId = await findChildDb(client, parentId, "Projects");
  if (!projectsDbId) {
    const db = await client.databases.create({
      parent: { type: "page_id", page_id: parentId },
      title: [{ type: "text", text: { content: "Projects" } }],
      properties: {
        Name: { title: {} },
        Status: {
          select: {
            options: [
              { name: "Active", color: "green" },
              { name: "Paused", color: "yellow" },
              { name: doneStatus, color: "default" },
            ],
          },
        },
      },
    });
    projectsDbId = db.id;
  }

  // Calls DB (create or reuse) — Project relation points at Projects.
  let callsDbId = await findChildDb(client, parentId, "Calls");
  if (!callsDbId) {
    const db = await client.databases.create({
      parent: { type: "page_id", page_id: parentId },
      title: [{ type: "text", text: { content: "Calls" } }],
      properties: {
        Name: { title: {} },
        Date: { date: {} },
        Participants: { rich_text: {} },
        "Open follow-ups": { checkbox: {} },
        Project: { relation: { database_id: projectsDbId, single_property: {} } },
      },
    });
    callsDbId = db.id;
  }

  setEnv({
    NOTION_TOKEN: token,
    NOTION_CALLS_DB_ID: callsDbId,
    NOTION_PROJECTS_DB_ID: projectsDbId,
    PROJECT_DONE_STATUS: doneStatus,
  });

  done({ ok: true, callsDbId, projectsDbId });
}

main().catch((e) => done({ ok: false, error: e?.message || String(e) }));
