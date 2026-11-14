// A SONG'S CLIP — the postcard, in motion.
//
// Thirty seconds of one song as a shareable video: the song page's own
// postcard over a waterfall of the song's real sound. The waterfall is
// the window's whole spectrogram drawn once as a still, then slid
// under a frame-wide window at real-time speed — the last ten seconds
// of sound on screen, "now" at the right edge — with the palette
// crushed to gray and ramped back up through the player's hot pink.
//
// The postcard stands in the player's own box grammar, the crown
// poster its reference: a bold framed section with a title tab
// breaking its top border, the poster's name big inside (here the
// song's title), a small line above it (the project), a stats line
// under the centerpiece (hearts, plays), and one line beneath that
// (the artist). The heart holds the center of the frame, as it does
// on the page. The falls run around the frame and glow through its
// dark panel; no word sits on naked waterfall.
//
// Rendered here on the server with ffmpeg, once per (song, start
// second), and cached by the host (see standalone/clip-route.ts). A
// clip is a snapshot: the counts it carries are the counts at render
// time, and rendering one never moves any number — plays still come
// only from playing.
//
// The type is Press Start 2P, the same face the page speaks, committed
// under server/fonts so the render never depends on whatever fonts the
// host image happens to carry.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FONT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fonts",
  "PressStart2P-Regular.ttf",
);

export const CLIP_SEC = 30;
const SIZE = 1080;
const PINK = "0xff69b4";
const DIM = "0xbfbfbf";
const WHITE = "0xffffff";

// Press Start 2P advances roughly one em per glyph, so a line's width
// in pixels is close to its length × the font size. Fit against a safe
// measure of the space the line has, not the full width.
function fitFontSize(
  text: string,
  maxFs: number,
  minFs: number,
  maxWidth = 980,
): number {
  const fs = Math.floor(maxWidth / Math.max(1, text.length));
  return Math.min(maxFs, Math.max(minFs, fs));
}

// Split a long title across two lines at the word boundary that leaves
// the longer line shortest.
function wrapTitle(title: string): string[] {
  const words = title.split(/\s+/);
  if (words.length < 2) return [title];
  let best = [title];
  let bestLen = title.length;
  for (let i = 1; i < words.length; i++) {
    const lines = [
      words.slice(0, i).join(" "),
      words.slice(i).join(" "),
    ];
    const m = Math.max(lines[0]!.length, lines[1]!.length);
    if (m < bestLen) {
      bestLen = m;
      best = lines;
    }
  }
  return best;
}

// The pixel heart the page wears, as drawbox runs: seven columns, six
// rows, one box per horizontal run of filled cells.
const HEART_RUNS: [number, number][][] = [
  [
    [1, 2],
    [4, 5],
  ],
  [[0, 6]],
  [[0, 6]],
  [[1, 5]],
  [[2, 4]],
  [[3, 3]],
];

function heartBoxes(ox: number, oy: number, block: number): string[] {
  return HEART_RUNS.flatMap((runs, r) =>
    runs.map(
      ([a, b]) =>
        `drawbox=x=${ox + a * block}:y=${oy + r * block}:w=${(b - a + 1) * block}:h=${block}:color=${PINK}:t=fill`,
    ),
  );
}

async function probeDurationSec(path: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(
      [
        "ffprobe",
        "-v",
        "quiet",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(
      proc.stdout as ReadableStream<Uint8Array>,
    ).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    const v = Number.parseFloat(out.trim());
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Run one ffmpeg invocation to completion; false on any failure. */
async function runFfmpeg(args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ffmpeg", "-v", "error", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    // Drain stderr so a chatty failure can never stall the render,
    // and keep its tail: when a render dies on the small production
    // machine, the log is the only witness.
    const errText = new Response(
      proc.stderr as ReadableStream<Uint8Array>,
    ).text();
    const code = await proc.exited;
    if (code !== 0) {
      const tail = (await errText)
        .slice(-400)
        .replace(/\s+/g, " ")
        .trim();
      if (tail) console.error(`[clips] ffmpeg failed (${code}): ${tail}`);
    }
    return code === 0;
  } catch {
    return false;
  }
}

export interface ClipSpec {
  src: string;
  /** Requested window start, whole seconds; clamped against the real duration. */
  startSec: number;
  /** Catalog duration when known; the file itself is probed otherwise. */
  durationSec: number | null;
  title: string;
  project: string;
  artist: string;
  hearts: number;
  plays: number;
  outPath: string;
}

/**
 * Render one clip to spec.outPath. Bun-only (spawns ffmpeg); returns
 * false on any failure — the caller treats a clip as a courtesy and
 * caches the failure briefly rather than retrying in a hot loop.
 */
export async function renderClip(spec: ClipSpec): Promise<boolean> {
  let dir: string | null = null;
  try {
    const res = await fetch(spec.src);
    if (!res.ok) return false;
    const audio = new Uint8Array(await res.arrayBuffer());
    dir = mkdtempSync(join(tmpdir(), "clip-"));
    const input = join(dir, "input.mp3");
    writeFileSync(input, audio);

    const duration = spec.durationSec ?? (await probeDurationSec(input));
    if (!duration) return false;
    const len = Math.min(CLIP_SEC, duration);
    const start = Math.min(
      Math.max(0, Math.floor(spec.startSec)),
      Math.max(0, Math.floor(duration - CLIP_SEC)),
    );
    if (len <= 0) return false;

    // drawtext reads its strings from files: no filter-grammar escaping
    // can mangle a title, whatever punctuation it carries.
    const textFile = (name: string, text: string): string => {
      const p = join(dir!, name);
      writeFileSync(p, text);
      return p;
    };
    const drawText = (
      file: string,
      fontsize: number,
      y: number,
      color: string,
      x = "(w-text_w)/2",
    ): string =>
      `drawtext=fontfile=${FONT}:textfile=${file}:expansion=none:fontsize=${fontsize}:fontcolor=${color}:x=${x}:y=${y}`;

    // The poster frame: a dark panel the falls glow through, a bold
    // white border whose corners turn in one pixel step (the NES.css
    // notch the player's own boxes wear), and a POSTCARD tab breaking
    // the top border, exactly where THE CROWN wears its name.
    const FX = 90;
    const FY = 190;
    const FW = 900;
    const FH = 700;
    const T = 8; // border thickness
    const S = 14; // corner step
    // The frame's graphics ride the card (below); its backing — the
    // panel fill, the tab chip, and the tab's word itself — the movie
    // pass draws straight onto the falls. The word must sit on its
    // chip, above the border it breaks: drawn on the card it would
    // land white-on-white over the card's own border line.
    const tabFile = textFile("tab.txt", "POSTCARD");
    const CHIP_X = 126;
    const CHIP_W = 216;
    const frame: string[] = [
      // The top border comes in two pieces: it stops where the tab
      // sits and resumes after it, the way the player's own section
      // frames break for their titles. The falls pass shows the chip
      // and the word through the gap.
      `drawbox=x=${FX + S}:y=${FY}:w=${CHIP_X - (FX + S)}:h=${T}:color=${WHITE}:t=fill`,
      `drawbox=x=${CHIP_X + CHIP_W}:y=${FY}:w=${FX + FW - S - (CHIP_X + CHIP_W)}:h=${T}:color=${WHITE}:t=fill`,
      `drawbox=x=${FX + S}:y=${FY + FH - T}:w=${FW - 2 * S}:h=${T}:color=${WHITE}:t=fill`,
      `drawbox=x=${FX}:y=${FY + S}:w=${T}:h=${FH - 2 * S}:color=${WHITE}:t=fill`,
      `drawbox=x=${FX + FW - T}:y=${FY + S}:w=${T}:h=${FH - 2 * S}:color=${WHITE}:t=fill`,
      ...[
        [FX + S - T, FY + S - T],
        [FX + FW - S, FY + S - T],
        [FX + S - T, FY + FH - S],
        [FX + FW - S, FY + FH - S],
      ].map(
        ([x, y]) =>
          `drawbox=x=${x}:y=${y}:w=${T}:h=${T}:color=${WHITE}:t=fill`,
      ),
    ];

    const INNER_W = 800;
    const projectText = spec.project.toUpperCase();
    const projectFs = fitFontSize(projectText, 26, 14, INNER_W);

    const titleUpper = spec.title.toUpperCase();
    let titleLines = [titleUpper];
    let titleFs = fitFontSize(titleUpper, 56, 22, INNER_W);
    if (titleFs <= 28 && titleUpper.length > 20) {
      titleLines = wrapTitle(titleUpper);
      const longest = Math.max(...titleLines.map((l) => l.length));
      titleFs = fitFontSize("x".repeat(longest), 56, 22, INNER_W);
    }
    const titleY = 286;
    // The heart hangs under the title block, whatever its height, and
    // the stats and artist lines hang under the heart: one stack,
    // crown-poster order, top to bottom.
    const heartBlock = 44;
    const heartY =
      titleY +
      (titleLines.length - 1) * Math.round(titleFs * 1.45) +
      titleFs +
      44;
    const statsY = heartY + 6 * heartBlock + 42;
    const artistY = statsY + 54;

    const statsText = `${spec.hearts} ${spec.hearts === 1 ? "HEART" : "HEARTS"} · ${spec.plays} ${spec.plays === 1 ? "PLAY" : "PLAYS"}`;

    const overlays: string[] = [
      ...frame,
      drawText(textFile("project.txt", projectText), projectFs, 242, DIM),
      ...titleLines.map((line, i) =>
        drawText(
          textFile(`title${i}.txt`, line),
          titleFs,
          titleY + Math.round(i * titleFs * 1.45),
          WHITE,
        ),
      ),
      // The heart at the center of the poster: 7×6 cells of 44px.
      ...heartBoxes((SIZE - 7 * heartBlock) / 2, heartY, heartBlock),
      drawText(
        textFile("stats.txt", statsText),
        fitFontSize(statsText, 26, 15, INNER_W),
        statsY,
        WHITE,
      ),
      drawText(
        textFile("artist.txt", spec.artist.toUpperCase()),
        24,
        artistY,
        PINK,
      ),
    ];

    // Pass 1: the window's spectrogram as one still. 108 px per second
    // of sound, so the pass-2 window (1080 wide) always holds exactly
    // the last ten seconds.
    const pxPerSec = 108;
    const picW = Math.max(pxPerSec, Math.round(pxPerSec * len));
    const pic = join(dir, "waterfall.png");
    const picOk = await runFfmpeg([
      "-ss",
      String(start),
      "-t",
      String(len),
      "-i",
      input,
      "-lavfi",
      `showspectrumpic=s=${picW}x${SIZE}:mode=combined:color=intensity:scale=log:fscale=log:start=20:stop=16000:legend=0`,
      "-frames:v",
      "1",
      pic,
    ]);
    if (!picOk || !existsSync(pic)) return false;

    // Pass 2: the poster's graphics as one still on black. The whole
    // drawbox/drawtext chain runs exactly once, on a single frame —
    // running it on every frame of the movie instead was measured at
    // ~405 MB of peak memory, which the small production machine
    // cannot spare; the still costs a few percent of that. The still
    // carries no alpha (this ffmpeg's lavfi canvas will not hold
    // one); the movie pass keys the black away instead — every
    // graphic on the card is a bright color, so black is a safe key.
    const card = join(dir, "card.png");
    const cardOk = await runFfmpeg([
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${SIZE}x${SIZE}`,
      "-vf",
      overlays.join(","),
      "-frames:v",
      "1",
      card,
    ]);
    if (!cardOk || !existsSync(card)) return false;

    // Pass 3: slide the spectrogram still under the frame. It is
    // padded with ten seconds of black on the left, so at second t
    // the window shows seconds t-10..t of the clip — the falls flow
    // in from the right edge, which is where "now" lives. The palette
    // is crushed to luminance first, so the pink ramp is exact
    // whatever palette the spectrogram filter reached for. The card
    // still is laid over the falls in a single overlay.
    const filter = [
      // The falls get the poster's backing drawn on directly: the
      // translucent panel the words sit on, the tab's black chip, and
      // the tab's word on top of its chip.
      `[1:v]pad=w=${picW + SIZE}:h=${SIZE}:x=${SIZE}:y=0:color=black,crop=w=${SIZE}:h=${SIZE}:x='${pxPerSec}*t':y=0,format=gray,format=rgb24,lutrgb=r='val':g='val*0.412':b='val*0.706',drawbox=x=${FX}:y=${FY}:w=${FW}:h=${FH}:color=black@0.60:t=fill,drawbox=x=${CHIP_X}:y=${FY - 17}:w=${CHIP_W}:h=34:color=black:t=fill,drawtext=fontfile=${FONT}:textfile=${tabFile}:expansion=none:fontsize=20:fontcolor=${WHITE}:x=${CHIP_X}+(${CHIP_W}-text_w)/2:y=${FY - 10}[falls]`,
      `[2:v]colorkey=0x000000:0.08:0.05[cardk]`,
      `[falls][cardk]overlay=0:0:format=rgb:repeatlast=1,format=yuv420p[vout]`,
    ].join(";");

    const ok = await runFfmpeg([
      "-ss",
      String(start),
      "-t",
      String(len),
      "-i",
      input,
      "-loop",
      "1",
      "-framerate",
      "30",
      "-i",
      pic,
      // The card enters as a single frame, not a looped stream: a
      // second 30 fps input makes the overlay's framesync queue whole
      // frames from whichever stream runs ahead (measured: hundreds
      // of MB). repeatlast holds the one frame for the whole clip.
      "-i",
      card,
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-map",
      "0:a",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-c:a",
      "aac",
      "-b:a",
      "256k",
      "-movflags",
      "+faststart",
      "-t",
      String(len),
      spec.outPath,
    ]);
    return ok && existsSync(spec.outPath);
  } catch {
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
