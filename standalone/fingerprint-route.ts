// GET /fingerprint?u=<catalog src> — serves a track's precomputed tape
// fingerprint (see server/fingerprint.ts), computing and caching it on
// first request. Cache lives on the data volume beside the database,
// so it survives deploys and fills in organically: every track gets
// its fingerprint the first time anyone plays it.
//
// Responses: 200 with the binary fingerprint (gzip-encoded, immutable
// cache headers — the data for a given src never changes), 202 while
// the first computation is still running (client retries shortly), 404
// when computation recently failed. Playback never depends on this
// route; it is a courtesy to the tape only.

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { computeFingerprintForUrl } from "../server/fingerprint";

const R2_BASE = "https://pub-195ce558feac44c5bd3f019b9265b6de.r2.dev/";
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT = 2;

export function createFingerprintHandler(dataDir: string) {
  const cacheDir = join(dataDir, "fingerprints");
  mkdirSync(cacheDir, { recursive: true });
  const inflight = new Set<string>();
  const negative = new Map<string, number>();
  let running = 0;
  const queue: string[] = [];

  function keyFor(src: string): string {
    return new Bun.CryptoHasher("sha256").update(src).digest("hex");
  }

  function kickCompute(src: string, key: string) {
    if (inflight.has(key)) return;
    inflight.add(key);
    if (running >= MAX_CONCURRENT) {
      queue.push(src);
      return;
    }
    void runCompute(src, key);
  }

  async function runCompute(src: string, key: string) {
    running++;
    try {
      const data = await computeFingerprintForUrl(src);
      if (data) {
        const tmp = join(cacheDir, `${key}.tmp`);
        writeFileSync(tmp, gzipSync(data));
        renameSync(tmp, join(cacheDir, `${key}.tfp.gz`));
        negative.delete(key);
      } else {
        negative.set(key, Date.now());
      }
    } catch {
      negative.set(key, Date.now());
    } finally {
      running--;
      inflight.delete(key);
      const next = queue.shift();
      if (next) kickCompute(next, keyFor(next));
    }
  }

  return function handleFingerprint(url: URL): Response {
    const src = url.searchParams.get("u") ?? "";
    if (!src.startsWith(R2_BASE)) {
      return Response.json({ error: "unknown track" }, { status: 400 });
    }
    const key = keyFor(src);
    const file = join(cacheDir, `${key}.tfp.gz`);
    if (existsSync(file)) {
      return new Response(Bun.file(file), {
        headers: {
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }
    const failedAt = negative.get(key);
    if (failedAt && Date.now() - failedAt < NEGATIVE_TTL_MS) {
      return new Response("not available", { status: 404 });
    }
    kickCompute(src, key);
    return new Response("computing", {
      status: 202,
      headers: { "retry-after": "4" },
    });
  };
}
