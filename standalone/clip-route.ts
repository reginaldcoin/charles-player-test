// GET /clip/<slug>?t=<start-sec> — a song's 30-second clip, rendered
// on first request and cached on the data volume beside the database
// (see server/clip.ts for the render itself).
//
// ONE CLIP PER SONG. The first render request a song ever gets cooks
// its one clip, from that request's window: the requested start rounds
// DOWN to the nearest 5-second mark, then clamps against the song's
// length. That window locks. Every later request for the song serves
// the locked clip (or waits on its render), whatever ?t= it carries —
// ?t= is advisory, spent only at the moment a song has no locked clip
// and none in flight. The cache key is the slug alone, so a link names
// one song, and the song names one clip.
//
// A locked clip resets after 28 days: clips older than that are swept
// at boot and daily thereafter, and the next request re-cooks the song
// fresh — a new first window, and the hearts and plays baked in are
// the song's as they stand that day. A hearted song's clip is cheap to
// re-render, and the volume is not an archive. Clips cooked before
// this law, under window-named files, are adopted at boot: a song
// with exactly one becomes that file, renamed; a song with several
// keeps its smallest start; the rest stay sweepable under the same
// 28-day rule.
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
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT = 2;
const JOB_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_AGE_MS = 28 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// A legacy clip file wears its window in its name: <slug>--<start>.mp4.
// Slugs never contain "--" beyond their one project/title separator and
// never end in "--<digits>", so the last "--<digits>" is unambiguously
// the window a pre-law clip was cooked from. Anything whose slug names
// no catalog song is not a clip this route owns.
function parseLegacyClipName(
  name: string,
): { slug: string; start: number } | null {
  if (!name.endsWith(".mp4") || name.includes(".rendering-")) return null;
  const m = /^(.*)--(\d+)$/.exec(name.slice(0, -4));
  if (!m) return null;
  const slug = m[1]!;
  if (songIndexFromSlug(slug) < 0) return null;
  return { slug, start: Number(m[2]) };
}

// True when a cache-dir name is a clip the sweep owns: a song's locked
// clip (<slug>.mp4) or a legacy window clip not yet adopted.
function isClipFile(name: string): boolean {
  if (!name.endsWith(".mp4") || name.includes(".rendering-")) return false;
  return (
    songIndexFromSlug(name.slice(0, -4)) >= 0 ||
    parseLegacyClipName(name) !== null
  );
}

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

  // Adoption, once at boot: clips cooked before the one-clip law wear
  // window names. A song holding legacy files and no locked clip
  // adopts one — its smallest start — under the song's own name, so
  // yesterday's cooking is not wasted. A rename keeps the file's age:
  // the 28-day reset still comes for it on schedule. Songs that
  // already own a locked clip keep it; their legacy files stay behind
  // as sweepable extras.
  function adoptLegacyClips() {
    let adopted = 0;
    try {
      const bySong = new Map<string, { name: string; start: number }[]>();
      for (const name of readdirSync(cacheDir)) {
        const legacy = parseLegacyClipName(name);
        if (!legacy) continue;
        const arr = bySong.get(legacy.slug) ?? [];
        arr.push({ name, start: legacy.start });
        bySong.set(legacy.slug, arr);
      }
      for (const [slug, files] of bySong) {
        const target = join(cacheDir, `${slug}.mp4`);
        if (existsSync(target)) continue;
        files.sort((a, b) => a.start - b.start);
        try {
          renameSync(join(cacheDir, files[0]!.name), target);
          adopted++;
        } catch {
          // A file that vanished mid-adoption is not a failure.
        }
      }
    } catch {
      // No cache dir yet, nothing to adopt.
    }
    if (adopted > 0) {
      console.log(
        `[clips] adopted ${adopted} existing clip(s) as their songs' locked clips`,
      );
    }
  }
  adoptLegacyClips();

  // The age sweep: only this directory, only files wearing a clip's
  // name, plus render temps a dead process left behind (a temp older
  // than a day belongs to no living render — renders take minutes —
  // while a young temp may be one in flight and is never touched).
  function sweep() {
    let removed = 0;
    try {
      for (const name of readdirSync(cacheDir)) {
        const isClip = isClipFile(name);
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
      `[clips] cache sweep: removed ${removed} clip(s) older than 28 days`,
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
    // The key is the song alone. ?t= is read only because a song with
    // no locked clip and none in flight cooks from this request's
    // window: round down to the 5-second mark first, clamp second.
    // Once the render below is kicked (or the locked file is served),
    // the window is locked and ?t= has spent its say.
    let start = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    start = Math.floor(start / 5) * 5;
    if (track.durationSec != null) {
      start = Math.min(start, Math.max(0, track.durationSec - CLIP_SEC));
    }
    const key = slug;
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
