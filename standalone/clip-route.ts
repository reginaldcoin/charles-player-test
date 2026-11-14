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
import { CLIP_SEC, clipFileIsValid, renderClip } from "../server/clip";

const CLIP_PATH_RE = /^\/clip\/([^/]+)\/?$/;
const CLIP_FILE_RE = /^[a-z0-9][a-z0-9-]*--\d+\.mp4$/;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT = 2;
const JOB_TIMEOUT_MS = 12 * 60 * 1000;
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
  // name, plus render temps a dead process left behind (a temp older
  // than a day belongs to no living render — renders take minutes —
  // while a young temp may be one in flight and is never touched).
  function sweep() {
    let removed = 0;
    try {
      for (const name of readdirSync(cacheDir)) {
        const isClip = CLIP_FILE_RE.test(name);
        const isTemp = name.includes(".rendering-") && name.endsWith(".mp4");
        if (!isClip && !isTemp) continue;
        const limit = isClip ? MAX_AGE_MS : DAY_MS;
        const path = join(cacheDir, name);
        try {
          if (Date.now() - statSync(path).mtimeMs > limit) {
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
  const verified = new Set<string>();
  // A failed render is remembered with its reason: the 404 a listener
  // gets while the failure is fresh says why, in the render's own
  // words — on a box whose logs nobody can read from outside, a
  // silent failure would be undiagnosable.
  const negative = new Map<string, { at: number; error: string }>();
  let running = 0;
  const queue: { key: string; job: () => Promise<string | null> }[] = [];

  function kick(key: string, job: () => Promise<string | null>) {
    if (inflight.has(key)) return;
    inflight.add(key);
    if (running >= MAX_CONCURRENT) {
      queue.push({ key, job });
      return;
    }
    void run(key, job);
  }

  async function run(key: string, job: () => Promise<string | null>) {
    running++;
    const began = Date.now();
    console.log(`[clips] render start ${key}`);
    try {
      // A job gets twelve minutes end to end, whatever its passes
      // are doing: past that the slot belongs to the next song. The
      // abandoned job is not cancelled — its passes carry their own
      // watchdogs — and if it ever does land, its file still caches
      // and serves; the timeout only frees the queue.
      const error = await Promise.race([
        job(),
        new Promise<string>((resolve) =>
          setTimeout(
            () => resolve("render timed out after 12 minutes"),
            JOB_TIMEOUT_MS,
          ),
        ),
      ]);
      console.log(
        `[clips] render done ${key} ok=${error === null} in ${Date.now() - began}ms`,
      );
      if (error === null) negative.delete(key);
      else negative.set(key, { at: Date.now(), error });
    } catch (e) {
      negative.set(key, {
        at: Date.now(),
        error: e instanceof Error ? e.message : String(e),
      });
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
      // Once per boot, a cached clip must prove it is whole before
      // it is served: a file orphaned mid-write by a restart is all
      // picture and no index, and without the check it would be
      // served, immutable, forever. A file that fails is deleted
      // and the request falls through to a fresh render.
      if (!verified.has(key)) {
        if (await clipFileIsValid(file)) {
          verified.add(key);
        } else {
          console.log(`[clips] cached ${key} is not a whole file; re-rendering`);
          rmSync(file, { force: true });
        }
      }
      if (existsSync(file)) {
        return new Response(Bun.file(file), {
          headers: {
            "content-type": "video/mp4",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      }
    }
    const failed = negative.get(key);
    if (failed && Date.now() - failed.at < NEGATIVE_TTL_MS) {
      return Response.json(
        { error: "clip unavailable", detail: failed.error },
        { status: 404 },
      );
    }
    kick(key, async () => {
      const counts = countsFor(track.title, track.project);
      // Every attempt renders to its OWN temp file: if the process
      // restarts mid-render, the orphaned encoder and its successor
      // must never write the same path at the same time — two
      // writers on one file is how a cache entry ends up all
      // picture and no index.
      const tmpOut = join(
        cacheDir,
        `${key}.rendering-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.mp4`,
      );
      const r = await renderClip({
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
      if (!r.ok) {
        rmSync(tmpOut, { force: true });
        return r.error;
      }
      renameSync(tmpOut, file);
      verified.add(key);
      return null;
    });
    return new Response("rendering", {
      status: 202,
      headers: { "retry-after": "3" },
    });
  };
}
