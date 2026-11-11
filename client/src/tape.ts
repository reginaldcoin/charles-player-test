// THE TAPE — a spectrogram waterfall. Each new column is one slice of
// the spectrum (log-spaced frequency bands, low frequencies at the
// bottom); history scrolls left into a tapestry. A hot-pink rule marks
// every track change. The visuals never drive scoring; the audio clock
// does.
//
// The spectrum no longer comes from a live analyser: routing the sound
// through a Web Audio graph let iOS suspend the music itself in the
// background. The server now precomputes each track's spectrogram once
// (server/fingerprint.ts, in the analyser's own scale) and this
// renderer samples that fingerprint at the audio element's current
// position. The tape reads the music; the music never routes through
// anything to be heard.
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

// The field not yet covered by play runs white (owner's law, 2026-11-09):
// until the music paints over a column, the column is white.
const FIELD_COLOR = "#ffffff";

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

/**
 * One column of the tape: BANDS band values in 0..255 (pre-gamma), or
 * null when the current track has no fingerprint yet. Supplied by the
 * player, sampled from the precomputed data at the playback position.
 */
export type TapeColumnProvider = () => ArrayLike<number> | null;

export class TapeRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private g: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private lastTick = 0;
  private getColumn: TapeColumnProvider = () => null;
  private changePending = false;
  private playing = false;
  private reducedMotion = false;

  attach(canvas: HTMLCanvasElement, getColumn: TapeColumnProvider) {
    this.canvas = canvas;
    this.getColumn = getColumn;
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

  /** Playing-state gate: while not playing, new columns run white
      instead of sampling the fingerprint. Starts false — the field is
      white until the first play covers it. */
  setPlaying(playing: boolean) {
    this.playing = playing;
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
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.canvas = null;
    this.g = null;
  }

  private clearAll() {
    const canvas = this.canvas;
    const g = this.g;
    if (!canvas || !g) return;
    // A fresh tape is all field: white until play covers it.
    g.fillStyle = FIELD_COLOR;
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

    const x = w - COL_W;

    if (this.changePending) {
      this.changePending = false;
      g.fillStyle = RULE_COLOR;
      g.fillRect(x, 0, COL_W, h);
      return;
    }

    if (!this.playing) {
      // Not playing: the column is field, not signal — run it white.
      g.fillStyle = FIELD_COLOR;
      g.fillRect(x, 0, COL_W, h);
      return;
    }

    const column = this.getColumn();
    if (!column) {
      // Playing, but this track's fingerprint has not landed yet: the
      // column is ground, not signal — the same dark the tape drew
      // when no analysis existed. The music is never delayed for it.
      g.fillStyle = palette.bg;
      g.fillRect(x, 0, COL_W, h);
      return;
    }

    const bandH = h / BANDS;
    for (let b = 0; b < BANDS; b++) {
      const raw = (column[b] ?? 0) / 255;
      // Gentle gamma lift so quiet passages still read on the tape.
      const v = Math.pow(raw, 0.72);
      g.fillStyle = colorFor(palette, v);
      g.fillRect(x, h - (b + 1) * bandH, COL_W, bandH + 1);
    }
  }
}
