// GET /clip/<slug>?t=<start-sec> — a song's 30-second clip, rendered
// on first request and cached on the data volume beside the database
// (see server/clip.ts for the render itself).
//
// Start times round DOWN to the nearest 5-second mark before anything
// else — clamping, the cache key, the render — so listeners whose
// playheads sit a second or two apart share one clip instead of
// minting near-duplicates, and the cache stays small enough to keep.
// The cache key is the slug plus that rounded start, so a link names
// one exact window of one exact song. Cached clips older than 30 days
// are swept at boot and daily thereafter; a hearted song's clip is
// cheap to re-render, and the volume is not an archive.
//
// Renders run through a small FIFO queue, at most two at once: a
// shared-CPU box rendering waterfalls for everyone at once would fall
// over, and a queued request simply completes when its turn comes.
//
// The route is public on purpose: a clip is a share tool, and a guest
// who lands on a song page cold is exactly who it exists for. Nothing
// here touches a stat — a clip carries the song's public hearts and
// plays as they stood at render time, and changes neither.
//
// Responses: 200 with the MP4 once rendered (immutable cache headers —
// a cached clip never changes), 202 while the first render is still
// running or queued (the page retries shortly), 404 for an unknown
// slug or a render that recently failed.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { ARTIST, CATALOG } from "../client/src/catalog";
import { songIndexFromSlug } from "../client/src/songSlug";
import { CLIP_SEC, renderClip } from "../server/clip";

const CLIP_PATH_RE = /^\/clip\/([^/]+)\/?$/;
const CLIP_FILE_RE = /^[a-z0-9][a-z0-9-]*--\d+\.mp4$/;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT = 2;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClipCounts {
  hearts: number;
  plays: number;
}

export function createClipHandler(
  dataDir: string,
  countsFor: (trackTitle: string, project: string) => ClipCounts,
) {
  const cacheDir = join(dataDir, "clips");
  mkdirSync(cacheDir, { recursive: true });

  // The age sweep: only this directory, only files wearing a clip's
  // name — in-flight .rendering.mp4 temps never match the pattern, so
  // a sweep can never eat a render in progress.
  function sweep() {
    let removed = 0;
    try {
      for (const name of readdirSync(cacheDir)) {
        if (!CLIP_FILE_RE.test(name)) continue;
        const path = join(cacheDir, name);
        try {
          if (Date.now() - statSync(path).mtimeMs > MAX_AGE_MS) {
            rmSync(path, { force: true });
            removed++;
          }
        } catch {
          // A file that vanished mid-sweep is not a failure.
        }
      }
    } catch {
      // No cache dir yet, nothing to sweep.
    }
    console.log(
      `[clips] cache sweep: removed ${removed} clip(s) older than 30 days`,
    );
  }
  sweep();
  const sweepTimer = setInterval(sweep, DAY_MS);
  (sweepTimer as unknown as { unref?: () => void }).unref?.();

  const inflight = new Set<string>();
  const negative = new Map<string, number>();
  let running = 0;
  const queue: { key: string; job: () => Promise<boolean> }[] = [];

  function kick(key: string, job: () => Promise<boolean>) {
    if (inflight.has(key)) return;
    inflight.add(key);
    if (running >= MAX_CONCURRENT) {
      queue.push({ key, job });
      return;
    }
    void run(key, job);
  }

  async function run(key: string, job: () => Promise<boolean>) {
    running++;
    const began = Date.now();
    console.log(`[clips] render start ${key}`);
    try {
      const ok = await job();
      console.log(
        `[clips] render done ${key} ok=${ok} in ${Date.now() - began}ms`,
      );
      if (ok) negative.delete(key);
      else negative.set(key, Date.now());
    } catch {
      negative.set(key, Date.now());
    } finally {
      running--;
      inflight.delete(key);
      const next = queue.shift();
      if (next) void run(next.key, next.job);
    }
  }

  return async function handleClip(url: URL): Promise<Response | null> {
    const m = CLIP_PATH_RE.exec(url.pathname);
    if (!m) return null;
    const slug = m[1]!;
    const idx = songIndexFromSlug(slug);
    if (idx < 0) {
      return Response.json({ error: "unknown song" }, { status: 404 });
    }
    const track = CATALOG[idx]!;
    const raw = Number(url.searchParams.get("t") ?? "0");
    // Round down to the 5-second mark first; clamp second. The key,
    // the render, and every later request for this window all inherit
    // the rounded start.
    let start = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    start = Math.floor(start / 5) * 5;
    if (track.durationSec != null) {
      start = Math.min(start, Math.max(0, track.durationSec - CLIP_SEC));
    }
    const key = `${slug}--${start}`;
    const file = join(cacheDir, `${key}.mp4`);
    if (existsSync(file)) {
      return new Response(Bun.file(file), {
        headers: {
          "content-type": "video/mp4",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }
    const failedAt = negative.get(key);
    if (failedAt && Date.now() - failedAt < NEGATIVE_TTL_MS) {
      return new Response("clip unavailable", { status: 404 });
    }
    kick(key, async () => {
      const counts = countsFor(track.title, track.project);
      const tmpOut = join(cacheDir, `${key}.rendering.mp4`);
      const ok = await renderClip({
        src: track.src,
        startSec: start,
        durationSec: track.durationSec,
        title: track.title,
        project: track.project,
        artist: ARTIST,
        hearts: counts.hearts,
        plays: counts.plays,
        outPath: tmpOut,
      });
      if (!ok) {
        rmSync(tmpOut, { force: true });
        return false;
      }
      renameSync(tmpOut, file);
      return true;
    });
    return new Response("rendering", {
      status: 202,
      headers: { "retry-after": "3" },
    });
  };
}
