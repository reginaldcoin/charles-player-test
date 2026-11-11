// THE TAPE'S FINGERPRINT — the spectrogram, precomputed.
//
// The tape used to read a live AnalyserNode, which forced every sound
// the player makes to route through a Web Audio graph on its way to
// the speaker. On some iPhones iOS suspends that graph in the
// background and the music stops mid-track. Now the sound travels the
// native element path — nothing between the file and the speaker —
// and the tape dances to data instead: for each track, this module
// computes the same 56 log-spaced bands the live tape drew (40 Hz to
// 16 kHz), one frame every 180 ms, in the AnalyserNode's own byte
// scale (dB between -100 and -30, temporal smoothing 0.82), so the
// tapestry the room knows is the tapestry it keeps.
//
// Computed once per track, on first request, and cached by the host
// (see standalone/fingerprint-route.ts). Playback never waits on it:
// a track with no fingerprint yet plays instantly and its tape paints
// as soon as the data lands.

export const TAPE_BANDS = 56;
export const TAPE_FRAME_MS = 180;
export const TAPE_MIN_F = 40;
export const TAPE_MAX_F = 16000;

const FFT_SIZE = 2048;
const DECODE_RATE = 32000; // mono; Nyquist is the tape's top band edge
const MIN_DB = -100;
const MAX_DB = -30;
const SMOOTHING = 0.82; // the old analyser's smoothingTimeConstant
// Level calibration: with a Blackman window and no gain compensation,
// raw band magnitudes sit hotter than the live analyser's did. This
// offset brings mastered program material into the same range the
// tape's palette and gamma were tuned against (checked against real
// catalog tracks: loud passages ride high, quiet ones read low).
const CAL_DB = -18;

const HOP = Math.round((TAPE_FRAME_MS / 1000) * DECODE_RATE); // 5760

/** [binLo, binHi) per band — the same log mapping tape.ts drew with. */
function computeBandBins(sampleRate: number): [number, number][] {
  const binCount = FFT_SIZE / 2;
  const bands: [number, number][] = [];
  for (let b = 0; b < TAPE_BANDS; b++) {
    const f0 = TAPE_MIN_F * Math.pow(TAPE_MAX_F / TAPE_MIN_F, b / TAPE_BANDS);
    const f1 =
      TAPE_MIN_F * Math.pow(TAPE_MAX_F / TAPE_MIN_F, (b + 1) / TAPE_BANDS);
    const i0 = Math.max(1, Math.floor((f0 / (sampleRate / 2)) * binCount));
    const i1 = Math.min(
      binCount,
      Math.max(i0 + 1, Math.ceil((f1 / (sampleRate / 2)) * binCount)),
    );
    bands.push([i0, i1]);
  }
  return bands;
}

const BAND_BINS = computeBandBins(DECODE_RATE);

// Blackman window — the AnalyserNode's own.
const WINDOW = new Float64Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  const t = i / (FFT_SIZE - 1);
  WINDOW[i] =
    0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

/** Iterative radix-2 FFT, in place. Length must be a power of two. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k] as number;
        const ui = im[i + k] as number;
        const vr = re[i + k + half] as number;
        const vi = im[i + k + half] as number;
        const xr = vr * cwr - vi * cwi;
        const xi = vr * cwi + vi * cwr;
        re[i + k] = ur + xr;
        im[i + k] = ui + xi;
        re[i + k + half] = ur - xr;
        im[i + k + half] = ui - xi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

/**
 * Streaming builder: feed decoded mono samples (f32, DECODE_RATE) in
 * any chunking; finish() returns the band frames flattened into one
 * Uint8Array(frameCount * 56). Memory stays bounded: samples are
 * dropped as soon as every frame covering them has been emitted.
 */
export class FingerprintBuilder {
  private buf = new Float32Array(0); // samples starting at absolute `base`
  private base = 0;
  private nextFrame = 0; // absolute sample index of the next frame start
  private total = 0;
  private frames: number[] = [];
  private smooth = new Float64Array(TAPE_BANDS);
  private re = new Float64Array(FFT_SIZE);
  private im = new Float64Array(FFT_SIZE);

  push(samples: Float32Array) {
    if (samples.length === 0) return;
    this.total += samples.length;
    const joined = new Float32Array(this.buf.length + samples.length);
    joined.set(this.buf);
    joined.set(samples, this.buf.length);
    this.buf = joined;
    while (this.nextFrame + FFT_SIZE <= this.base + this.buf.length) {
      this.emitFrame(this.nextFrame - this.base, FFT_SIZE);
      this.nextFrame += HOP;
    }
    // Everything before the next frame start is framed past for good —
    // but never claim the buffer starts past the samples actually
    // received: a hop can overshoot the stream's current end, and the
    // frame it names gathers its window once the rest arrives.
    const drop =
      Math.min(this.nextFrame, this.base + this.buf.length) - this.base;
    if (drop > 0) {
      this.buf = this.buf.slice(drop);
      this.base += drop;
    }
  }

  private emitFrame(off: number, len: number) {
    const { re, im } = this;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < len; i++) {
      re[i] = (this.buf[off + i] as number) * (WINDOW[i] as number);
    }
    fft(re, im);
    for (let b = 0; b < TAPE_BANDS; b++) {
      const [i0, i1] = BAND_BINS[b] as [number, number];
      let sum = 0;
      for (let i = i0; i < i1; i++) {
        const mag = Math.sqrt(re[i]! * re[i]! + im[i]! * im[i]!) / FFT_SIZE;
        const db = 20 * Math.log10(mag || 1e-12) + CAL_DB;
        const byte = Math.max(
          0,
          Math.min(255, (255 * (db - MIN_DB)) / (MAX_DB - MIN_DB)),
        );
        sum += byte;
      }
      const raw = sum / Math.max(1, i1 - i0);
      const smoothed = SMOOTHING * (this.smooth[b] as number) + (1 - SMOOTHING) * raw;
      this.smooth[b] = smoothed;
      this.frames.push(Math.round(smoothed));
    }
  }

  finish(): { frames: Uint8Array; frameCount: number } {
    // One last frame from the tail, zero-padded — the song's final
    // moment still gets its column.
    const remaining = this.total - this.nextFrame;
    if (remaining > 0) {
      this.emitFrame(
        this.nextFrame - this.base,
        Math.min(remaining, FFT_SIZE),
      );
    }
    const frameCount = Math.floor(this.frames.length / TAPE_BANDS);
    return {
      frames: Uint8Array.from(this.frames.slice(0, frameCount * TAPE_BANDS)),
      frameCount,
    };
  }
}

const MAGIC = "TFP1";

export function encodeFingerprint(frames: Uint8Array, frameCount: number): Uint8Array {
  const out = new Uint8Array(16 + frames.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = MAGIC.charCodeAt(i);
  view.setUint16(4, TAPE_BANDS, true);
  view.setUint16(6, TAPE_FRAME_MS, true);
  view.setUint32(8, frameCount, true);
  view.setUint32(12, frameCount * TAPE_FRAME_MS, true);
  out.set(frames, 16);
  return out;
}

export function parseFingerprintHeader(buf: ArrayBuffer): {
  bands: number;
  frameMs: number;
  frameCount: number;
  durationMs: number;
} | null {
  if (buf.byteLength < 16) return null;
  const view = new DataView(buf);
  let magic = "";
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(view.getUint8(i));
  if (magic !== MAGIC) return null;
  return {
    bands: view.getUint16(4, true),
    frameMs: view.getUint16(6, true),
    frameCount: view.getUint32(8, true),
    durationMs: view.getUint32(12, true),
  };
}

/**
 * Fetch a track's audio and compute its fingerprint. Bun-only (spawns
 * ffmpeg); returns null on any failure — the caller treats fingerprints
 * as a courtesy, never a requirement for playback.
 */
export async function computeFingerprintForUrl(
  src: string,
): Promise<Uint8Array | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const audio = new Uint8Array(await res.arrayBuffer());
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        "pipe:0",
        "-ac",
        "1",
        "-ar",
        String(DECODE_RATE),
        "-f",
        "f32le",
        "pipe:1",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const sink = proc.stdin;
    if (sink && typeof sink !== "number") {
      sink.write(audio);
      sink.end();
    }
    const builder = new FingerprintBuilder();
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let carry = new Uint8Array(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const joined = new Uint8Array(carry.length + value.length);
      joined.set(carry);
      joined.set(value, carry.length);
      const usable = joined.length - (joined.length % 4);
      const floats = new Float32Array(
        joined.buffer.slice(joined.byteOffset, joined.byteOffset + usable),
      );
      builder.push(floats);
      carry = joined.subarray(usable);
    }
    const code = await proc.exited;
    if (code !== 0) return null;
    const { frames, frameCount } = builder.finish();
    if (frameCount === 0) return null;
    return encodeFingerprint(frames, frameCount);
  } catch {
    return null;
  }
}
