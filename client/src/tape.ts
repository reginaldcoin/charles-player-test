// THE TAPE — a spectrogram waterfall. Each new column is one slice of the
// live spectrum (log-spaced frequency bands, low frequencies at the
// bottom); history scrolls left into a tapestry. A hot-pink rule marks
// every track change. Driven by an AnalyserNode tapped off the single
// <audio> element — the visuals never drive scoring; the audio clock does.
//
// Motion safety: columns land ~11 times a second but each changes only a
// 2px slice — no full-screen luminance pulses, nothing flashes. With
// prefers-reduced-motion the tape renders one designed static poster and
// never animates.
//
// NES re-skin (2026-11-08): the tapestry lives in the charleshamilton.app
// palette — black ground, signal climbing through deep magenta to the
// site's hot pink #ff69b4 and cresting white. The track-change rule is
// the same hot pink. No bone or cream tones anywhere.

interface Palette {
  bg: string;
  stops: [number, [number, number, number]][];
}

const PALETTE: Palette = {
  bg: "#000000",
  stops: [
    [0, [0, 0, 0]],
    [0.25, [74, 10, 44]],
    [0.55, [186, 30, 110]],
    [0.8, [255, 105, 180]],
    [1, [255, 255, 255]],
  ],
};

const RULE_COLOR = "#ff69b4";

const BANDS = 56;
const COL_W = 2;
const TICK_MS = 90;

function colorFor(palette: Palette, v: number): string {
  const stops = palette.stops;
  let prev = stops[0] as [number, [number, number, number]];
  for (const stop of stops) {
    if (v <= stop[0]) {
      const span = stop[0] - prev[0] || 1;
      const t = (v - prev[0]) / span;
      const c = prev[1].map((p, i) =>
        Math.round(p + ((stop[1][i] ?? p) - p) * t),
      );
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
    prev = stop;
  }
  const last = stops[stops.length - 1]?.[1] ?? [255, 255, 255];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

export class TapeRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private g: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private lastTick = 0;
  private getAnalyser: () => AnalyserNode | null = () => null;
  private freq: Uint8Array | null = null;
  private changePending = false;
  private reducedMotion = false;
  private bandBins: [number, number][] = [];

  attach(canvas: HTMLCanvasElement, getAnalyser: () => AnalyserNode | null) {
    this.canvas = canvas;
    this.getAnalyser = getAnalyser;
    this.g = canvas.getContext("2d");
    this.reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.resize();
    if (this.reducedMotion) {
      this.drawPoster();
    } else {
      this.clearAll();
      this.loop(0);
    }
  }

  markChange() {
    this.changePending = true;
  }

  resize() {
    const canvas = this.canvas;
    const g = this.g;
    if (!canvas || !g) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(2, Math.round(rect.width * dpr));
    const h = Math.max(2, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      // Preserve what we can: draw old canvas into the resized one.
      const old = document.createElement("canvas");
      old.width = canvas.width;
      old.height = canvas.height;
      old.getContext("2d")?.drawImage(canvas, 0, 0);
      canvas.width = w;
      canvas.height = h;
      g.fillStyle = PALETTE.bg;
      g.fillRect(0, 0, w, h);
      g.drawImage(old, 0, 0, old.width, old.height, 0, 0, w, h);
    }
    this.computeBands();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.canvas = null;
    this.g = null;
  }

  private computeBands() {
    const analyser = this.getAnalyser();
    const sampleRate = analyser?.context.sampleRate ?? 48000;
    const binCount = analyser?.frequencyBinCount ?? 1024;
    const minF = 40;
    const maxF = 16000;
    this.bandBins = [];
    for (let b = 0; b < BANDS; b++) {
      const f0 = minF * Math.pow(maxF / minF, b / BANDS);
      const f1 = minF * Math.pow(maxF / minF, (b + 1) / BANDS);
      const i0 = Math.max(1, Math.floor((f0 / (sampleRate / 2)) * binCount));
      const i1 = Math.min(
        binCount,
        Math.max(i0 + 1, Math.ceil((f1 / (sampleRate / 2)) * binCount)),
      );
      this.bandBins.push([i0, i1]);
    }
  }

  private clearAll() {
    const canvas = this.canvas;
    const g = this.g;
    if (!canvas || !g) return;
    g.fillStyle = PALETTE.bg;
    g.fillRect(0, 0, canvas.width, canvas.height);
  }

  /** Designed static poster for prefers-reduced-motion: a still tapestry
      in the NES palette on black. */
  private drawPoster() {
    const canvas = this.canvas;
    const g = this.g;
    if (!canvas || !g) return;
    const palette = PALETTE;
    const w = canvas.width;
    const h = canvas.height;
    const bandH = h / BANDS;
    // Deterministic layered pattern — no randomness, no motion.
    for (let x = 0; x < w; x += COL_W) {
      const t = x / w;
      for (let b = 0; b < BANDS; b++) {
        const fb = b / BANDS;
        const v =
          0.55 *
            Math.exp(-Math.pow((fb - 0.18 - 0.1 * Math.sin(t * 9.0)) * 3.4, 2)) *
            (0.6 + 0.4 * Math.sin(t * 22.0 + fb * 5.0)) +
          0.3 *
            Math.exp(-Math.pow((fb - 0.55) * 5.0, 2)) *
            (0.5 + 0.5 * Math.sin(t * 47.0)) +
          0.12 * Math.exp(-Math.pow((fb - 0.85) * 6.0, 2));
        g.fillStyle = colorFor(palette, Math.max(0, Math.min(1, v)));
        g.fillRect(x, h - (b + 1) * bandH, COL_W, bandH + 1);
      }
    }
    // One pink rule, as a track change would leave.
    g.fillStyle = RULE_COLOR;
    g.fillRect(Math.floor(w * 0.62), 0, COL_W, h);
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    if (now - this.lastTick < TICK_MS) return;
    this.lastTick = now;
    this.tick();
  };

  private tick() {
    const canvas = this.canvas;
    const g = this.g;
    if (!canvas || !g) return;
    const palette = PALETTE;
    const w = canvas.width;
    const h = canvas.height;

    // Scroll history left by one column.
    g.drawImage(canvas, -COL_W, 0);

    const analyser = this.getAnalyser();
    const x = w - COL_W;

    if (this.changePending) {
      this.changePending = false;
      g.fillStyle = RULE_COLOR;
      g.fillRect(x, 0, COL_W, h);
      return;
    }

    if (!analyser) {
      g.fillStyle = palette.bg;
      g.fillRect(x, 0, COL_W, h);
      return;
    }
    if (!this.freq || this.freq.length !== analyser.frequencyBinCount) {
      this.freq = new Uint8Array(analyser.frequencyBinCount);
      this.computeBands();
    }
    analyser.getByteFrequencyData(this.freq);

    const bandH = h / BANDS;
    for (let b = 0; b < BANDS; b++) {
      const range = this.bandBins[b];
      if (!range) continue;
      const [i0, i1] = range;
      let sum = 0;
      for (let i = i0; i < i1; i++) sum += this.freq[i] ?? 0;
      const avg = sum / Math.max(1, i1 - i0) / 255;
      // Gentle gamma lift so quiet passages still read on the tape.
      const v = Math.pow(avg, 0.72);
      g.fillStyle = colorFor(palette, v);
      g.fillRect(x, h - (b + 1) * bandH, COL_W, bandH + 1);
    }
  }
}
