// THE TAPE'S FINGERPRINT, CLIENT SIDE — fetch, parse, sample.
//
// The server precomputes each track's spectrogram once (see
// server/fingerprint.ts) and this module fetches it lazily: playback
// NEVER waits on it. Until a track's fingerprint lands, the tape
// paints its no-data columns exactly as it used to when no analyser
// existed, and starts dancing from the song's current position the
// moment the data arrives. Parsed fingerprints are cached for the
// session; the browser's HTTP cache (immutable, year-long) carries
// them across sessions.

export interface TapeFingerprint {
  bands: number;
  frameMs: number;
  frameCount: number;
  /** frameCount * bands band values, 0..255, pre-gamma. */
  data: Uint8Array;
}

const cache = new Map<string, TapeFingerprint>();
const fetching = new Set<string>();

const MAX_ATTEMPTS = 10;

export function getFingerprint(src: string): TapeFingerprint | null {
  return cache.get(src) ?? null;
}

/**
 * Make sure a track's fingerprint is on its way. Safe to call
 * repeatedly (load, preload, every tape tick): one fetch loop per
 * src, retrying while the server computes the first one.
 */
export function ensureFingerprint(src: string): void {
  if (cache.has(src) || fetching.has(src)) return;
  fetching.add(src);
  void (async () => {
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const res = await fetch(
            `./fingerprint?u=${encodeURIComponent(src)}`,
          );
          if (res.status === 200) {
            const parsed = parseFingerprint(await res.arrayBuffer());
            if (parsed) cache.set(src, parsed);
            return;
          }
          if (res.status === 404) return; // server could not compute it
          // 202 (computing) or anything transient: wait and retry.
          const retryAfter = Number(res.headers.get("retry-after")) || 4;
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
        } catch {
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
    } finally {
      fetching.delete(src);
    }
  })();
}

export function parseFingerprint(buf: ArrayBuffer): TapeFingerprint | null {
  if (buf.byteLength < 16) return null;
  const view = new DataView(buf);
  let magic = "";
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(view.getUint8(i));
  if (magic !== "TFP1") return null;
  const bands = view.getUint16(4, true);
  const frameMs = view.getUint16(6, true);
  const frameCount = view.getUint32(8, true);
  const data = new Uint8Array(buf, 16);
  if (data.length < frameCount * bands) return null;
  return { bands, frameMs, frameCount, data };
}

/**
 * The band values (0..255 per band) at a playback position, linearly
 * interpolated between the two neighbouring frames so columns glide
 * the way the smoothed live spectrum did. Writes into `out`.
 */
export function sampleFingerprint(
  fp: TapeFingerprint,
  timeSec: number,
  out: Float32Array,
): void {
  const pos = (timeSec * 1000) / fp.frameMs;
  const i0 = Math.max(0, Math.min(fp.frameCount - 1, Math.floor(pos)));
  const i1 = Math.min(fp.frameCount - 1, i0 + 1);
  const frac = Math.max(0, Math.min(1, pos - i0));
  const { data, bands } = fp;
  for (let b = 0; b < bands; b++) {
    const a = data[i0 * bands + b] ?? 0;
    const c = data[i1 * bands + b] ?? 0;
    out[b] = a + (c - a) * frac;
  }
}
