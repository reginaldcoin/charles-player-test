// Standalone bootstrap for the Charles Hamilton Player.
//
// The app was built as a Muse TS space: the client POSTs {action, args}
// to ./actions and server/src/actions.ts handlers expect a host-provided
// ctx (ctx.db(), ctx.executePrivileged(), ctx.invalidateQueries()).
// This file supplies exactly that ctx on plain Bun, serves client/dist
// statically, and answers POST /actions — one process, one origin, one
// SQLite file. No app logic lives here; actions.ts / privileged.ts /
// schema.ts are the artifact's own code, unmodified.

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { Actions } from "../server/src/actions";
import { handlers as privilegedHandlers } from "../server/src/privileged";
import * as schema from "../server/src/schema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "data", "app.db");
const CLIENT_DIST = join(ROOT, "client", "dist");

// ---------------------------------------------------------------------------
// Database: fresh SQLite file + the artifact's own Drizzle migrations.
// ---------------------------------------------------------------------------

mkdirSync(dirname(DB_PATH), { recursive: true });
const sqlite = new Database(DB_PATH, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");

const migrationsDir = join(ROOT, "drizzle");
for (const file of readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  const sqlText = readFileSync(join(migrationsDir, file), "utf8");
  for (const stmt of sqlText.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed) sqlite.exec(trimmed);
  }
}

const db = drizzle(sqlite, { schema });

// ---------------------------------------------------------------------------
// ctx: the minimal host surface the artifact's actions actually use.
// ---------------------------------------------------------------------------

const privilegedByName = new Map(
  privilegedHandlers.entries.map((entry) => [entry.contract.name, entry]),
);

const ctx = {
  slug: "charles-player-test",
  invocationId: "",
  spaceDir: ROOT,
  db: () => db,
  blobs: {
    async put() {
      throw new Error("blobs are not available in the standalone host");
    },
    async getUrl() {
      throw new Error("blobs are not available in the standalone host");
    },
    async delete() {
      throw new Error("blobs are not available in the standalone host");
    },
    async head() {
      return null;
    },
    async list() {
      return [];
    },
  },
  emit() {},
  invalidateQueries() {},
  agent: {
    async spawnTask() {
      return { ok: false, error: "agent tasks are not available standalone" };
    },
    async send() {
      return { ok: false, error: "agent tasks are not available standalone" };
    },
    async status() {
      return { taskId: "", status: "not_found" };
    },
  },
  inference: {
    async complete() {
      throw new Error("inference is not available in the standalone host");
    },
  },
  tool: {},
  async executePrivileged(contract: { name: string }, args: unknown) {
    const entry = privilegedByName.get(contract.name);
    if (!entry) {
      throw new Error(`no privileged handler registered for ${contract.name}`);
    }
    const parsedArgs = entry.contract.request.parse(args);
    const result = await entry.handler(parsedArgs as never);
    return entry.contract.response.parse(result);
  },
};

// ---------------------------------------------------------------------------
// HTTP: POST /actions + static client.
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
};

function serveStatic(pathname: string): Response | null {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(CLIENT_DIST, rel));
  if (!filePath.startsWith(CLIENT_DIST)) return null;
  if (existsSync(filePath)) {
    const file = Bun.file(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    return new Response(file, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  }
  // SPA fallback for non-asset paths.
  if (!rel.includes(".")) {
    const indexPath = join(CLIENT_DIST, "index.html");
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath), {
        headers: { "content-type": MIME[".html"] },
      });
    }
  }
  return null;
}

async function handleAction(req: Request): Promise<Response> {
  let body: { action?: string; args?: unknown };
  try {
    body = (await req.json()) as { action?: string; args?: unknown };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = body.action ?? "";
  const def = (Actions as Record<string, {
    request: { parse: (v: unknown) => unknown };
    response: { parse: (v: unknown) => unknown };
    handler: (c: typeof ctx, a: unknown) => Promise<unknown>;
  }>)[name];
  if (!def) {
    return Response.json({ error: `unknown action: ${name}` }, { status: 404 });
  }
  let args: unknown;
  try {
    args = def.request.parse(body.args ?? {});
  } catch (err) {
    return Response.json(
      { error: `invalid args for ${name}: ${String(err)}` },
      { status: 400 },
    );
  }
  try {
    const raw = await def.handler(ctx, args);
    let data: unknown = raw;
    try {
      data = def.response.parse(raw);
    } catch {
      // Response-schema drift should not take a working action down;
      // the artifact runtime is equally tolerant in practice.
      console.warn(`[actions] ${name}: response did not match its schema`);
    }
    return Response.json({ data });
  } catch (err) {
    console.error(`[actions] ${name} failed:`, err);
    return Response.json(
      { error: `action ${name} failed: ${String(err)}` },
      { status: 500 },
    );
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/actions" || url.pathname.endsWith("/actions")) {
      if (req.method !== "POST") {
        return Response.json({ error: "POST only" }, { status: 405 });
      }
      return handleAction(req);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const res = serveStatic(url.pathname);
      if (res) return res;
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(
  `charles-player-test listening on http://localhost:${PORT} (db: ${DB_PATH})`,
);
