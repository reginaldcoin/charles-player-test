import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import {
  createHeartToggleCore,
  type HeartArgs,
  type HeartToggleCore,
} from "./heartToggle";
import { ARTIST, CATALOG, type CatalogTrack } from "./catalog";
import {
  isSongPath,
  songIndexFromPath,
  songPath,
} from "./songSlug";
import { judgeResume, RESUME_KEY, type ResumeSave } from "./resume";
import {
  recBoot,
  recEvent,
  recGoodbye,
  recHeartbeat,
  recTickGap,
  type FlightSnap,
} from "./recorder";
import { TapeRenderer } from "./tape";
import {
  ensureFingerprint,
  getFingerprint,
  sampleFingerprint,
} from "./fingerprint";
import bowskullUrl from "./assets/bowskull.png";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}

/** Fractional points, hundredths — the live score's display precision. */
function fmtPts2(n: number): string {
  return (isFinite(n) ? n : 0).toFixed(2);
}

/** Fractional points, one decimal — standings rows. */
function fmtPts1(n: number): string {
  return (isFinite(n) ? n : 0).toFixed(1);
}

/** A reign's length in board words: the two largest units, nothing more. */
function fmtReign(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "under a minute";
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rem = mins % 60;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day");
  if (hours > 0) return rem > 0 ? `${unit(hours, "hour")} ${rem} min` : unit(hours, "hour");
  return `${mins} min`;
}

/** A listener's public !code, in classic tripcode green. */
function TripCode({ code }: { code: string }) {
  return <span className="trip">!{code}</span>;
}

/** Bug-hunter flair: a little pixel bug, granted by the operators. */
function BugGlyph() {
  const green = "#4ade80";
  const dark = "#14532d";
  return (
    <span title="Bug hunter" className="ml-1 inline-flex align-[-2px]">
      <svg viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden className="h-[13px] w-[13px]">
        <rect x="2" y="0" width="1" height="1" fill={green} />
        <rect x="7" y="0" width="1" height="1" fill={green} />
        <rect x="3" y="1" width="1" height="1" fill={green} />
        <rect x="6" y="1" width="1" height="1" fill={green} />
        <rect x="4" y="1" width="2" height="2" fill={green} />
        <rect x="1" y="4" width="2" height="1" fill={green} />
        <rect x="7" y="4" width="2" height="1" fill={green} />
        <rect x="1" y="6" width="2" height="1" fill={green} />
        <rect x="7" y="6" width="2" height="1" fill={green} />
        <rect x="1" y="8" width="2" height="1" fill={green} />
        <rect x="7" y="8" width="2" height="1" fill={green} />
        <rect x="3" y="3" width="4" height="6" fill={green} />
        <rect x="3" y="5" width="4" height="1" fill={dark} />
        <rect x="3" y="7" width="4" height="1" fill={dark} />
      </svg>
    </span>
  );
}

/** Trailing 24 hours of points as 24 tiny pixel bars, oldest first. */
function DayBars({ bars }: { bars: number[] }) {
  const max = Math.max(0, ...bars);
  return (
    <svg
      viewBox="0 0 48 16"
      shapeRendering="crispEdges"
      aria-hidden
      className="h-[16px] w-[64px]"
    >
      {bars.map((v, i) =>
        v > 0 ? (
          <rect
            key={i}
            x={i * 2}
            y={16 - Math.max(2, Math.round((v / max) * 15))}
            width="1"
            height={Math.max(2, Math.round((v / max) * 15))}
            fill="#4ade80"
          />
        ) : (
          <rect
            key={i}
            x={i * 2}
            y="15"
            width="1"
            height="1"
            fill="var(--dim)"
            opacity="0.5"
          />
        ),
      )}
    </svg>
  );
}

/** Presence: green heard from this hour, yellow quiet a while, red gone a day or more. */
function PresenceDot({ lastActiveMs }: { lastActiveMs: number }) {
  const age = lastActiveMs > 0 ? Date.now() - lastActiveMs : Infinity;
  const tier =
    age <= 3600_000
      ? { color: "#4ade80", label: "active this hour" }
      : age <= 24 * 3600_000
        ? { color: "var(--accent-yellow)", label: "quiet a while" }
        : { color: "#f87171", label: "gone a day or more" };
  return (
    <span
      title={tier.label}
      aria-label={tier.label}
      className="ml-2 inline-block h-[8px] w-[8px] shrink-0 self-center rounded-full"
      style={{ backgroundColor: tier.color }}
    />
  );
}

/** Charles's birthday: November 10, viewer-local. */
function isCharlesBirthday(d: Date): boolean {
  return d.getMonth() === 10 && d.getDate() === 10;
}

/** The skullbow: the house mark (bowskull.png), rendered pixelated. Decorative. */
function SkullBow() {
  return (
    <img
      src={bowskullUrl}
      alt=""
      aria-hidden
      className="h-[44px] w-[44px] shrink-0"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

/** Deterministic burst spread for the heart celebration: 12 pixel
 *  sparkles on a fixed ring, no randomness in render. */
const HEART_SPARKS = [
  { dx: 52, dy: 0, size: 5, color: "#ff69b4" },
  { dx: 45, dy: 26, size: 4, color: "#ffffff" },
  { dx: 24, dy: 42, size: 6, color: "#fde047" },
  { dx: 0, dy: 50, size: 5, color: "#ff69b4" },
  { dx: -26, dy: 45, size: 4, color: "#ffffff" },
  { dx: -48, dy: 28, size: 6, color: "#fde047" },
  { dx: -54, dy: 0, size: 5, color: "#ff69b4" },
  { dx: -46, dy: -27, size: 4, color: "#ffffff" },
  { dx: -25, dy: -44, size: 6, color: "#fde047" },
  { dx: 0, dy: -52, size: 5, color: "#ff69b4" },
  { dx: 27, dy: -47, size: 4, color: "#ffffff" },
  { dx: 49, dy: -28, size: 6, color: "#fde047" },
];

/** The drawn heart on its own, for counts and shelves (static: no burst). */
function HeartIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="block shrink-0"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path
        d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
        fill="#ff69b4"
        stroke="#ffffff"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Wires the heart toggle core (heartToggle.ts) to the API. One core
 * per surface: the now-playing heart and the road hearts each own
 * their pending state. A save counts as failed on a transport error
 * OR an ok:false answer, and the send resolves only after the road
 * refetch lands, so when the core clears its optimistic override the
 * display hands over to the server's fresh truth with no stale flash.
 */
function useHeartToggle(
  getToken: () => string | undefined,
): HeartToggleCore {
  const queryClient = useQueryClient();
  const [, setTick] = useState(0);
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const coreRef = useRef<HeartToggleCore | null>(null);
  if (coreRef.current === null) {
    coreRef.current = createHeartToggleCore(
      async (args: HeartArgs) => {
        const token = getTokenRef.current();
        if (!token) throw new Error("Not signed in.");
        const res = await api.toggleFavorite({ token, ...args });
        if (!res.ok) throw new Error(res.error ?? "The heart did not save.");
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["road"] }),
          queryClient.invalidateQueries({ queryKey: ["hearts-today"] }),
          queryClient.invalidateQueries({ queryKey: ["love-board"] }),
          queryClient.invalidateQueries({ queryKey: ["song-stats"] }),
        ]);
      },
      () => setTick((t) => t + 1),
    );
  }
  return coreRef.current;
}

/**
 * The heart, drawn not typed: an SVG silhouette (Press Start 2P has no
 * heart glyph, so the old text heart fell back to a tiny system glyph
 * and its on/off state read as a dim color swap). OFF is a white
 * outline; ON is a solid accent fill with the white outline kept —
 * more present, never darker. The fill and the HEARTED label follow
 * the displayed state, which is optimistic: they flip the moment a
 * tap lands. The pop and the pixel sparkles still wait for the save:
 * they fire when the SAVED state turns on under a click we made, so
 * a failed toggle never celebrates.
 */
function HeartButton({
  hearted,
  savedHearted,
  pending,
  onToggle,
  label,
  size,
}: {
  hearted: boolean;
  savedHearted: boolean;
  pending: boolean;
  onToggle: () => void;
  label: string;
  size: "now" | "row" | "page";
}) {
  const glyph = size === "page" ? 96 : size === "now" ? 36 : 26;
  const [burstKey, setBurstKey] = useState(0);
  const awaitingRef = useRef(false);

  // Fire the burst when a click we made turns the SAVED heart ON. The
  // displayed state flips optimistically and cannot be trusted for
  // this; a failed save never flips the saved state, so it never
  // bursts. The awaiting flag expires on its own so an unrelated later
  // flip stays quiet.
  useEffect(() => {
    if (savedHearted && awaitingRef.current) {
      awaitingRef.current = false;
      setBurstKey((k) => k + 1);
    }
  }, [savedHearted]);

  const handleClick = () => {
    if (!hearted) {
      awaitingRef.current = true;
      window.setTimeout(() => {
        awaitingRef.current = false;
      }, 4000);
    }
    onToggle();
  };

  return (
    <span className="relative inline-flex shrink-0 flex-col items-center">
      <button
        type="button"
        aria-label={label}
        aria-pressed={hearted}
        aria-busy={pending}
        onClick={handleClick}
        disabled={pending}
        className={
          size === "page"
            ? "shrink-0 px-4 py-3 leading-none"
            : size === "now"
              ? "shrink-0 px-3 py-2 leading-none"
              : "shrink-0 px-2 py-2 leading-none"
        }
      >
        <span
          className="relative block"
          style={{ width: glyph, height: glyph }}
        >
          <svg
            key={burstKey}
            className={burstKey > 0 ? "heart-pop block" : "block"}
            width={glyph}
            height={glyph}
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path
              d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
              fill={hearted ? "var(--accent)" : "none"}
              stroke="#ffffff"
              strokeWidth={1.8}
              strokeLinejoin="round"
            />
          </svg>
          {burstKey > 0 && (
            <span key={`s${burstKey}`} className="heart-sparks" aria-hidden>
              {HEART_SPARKS.slice(0, size === "row" ? 8 : 12).map((s, i) => (
                <span
                  key={i}
                  className="heart-spark"
                  style={
                    {
                      width: s.size,
                      height: s.size,
                      backgroundColor: s.color,
                      "--dx": `${s.dx}px`,
                      "--dy": `${s.dy}px`,
                    } as CSSProperties
                  }
                />
              ))}
            </span>
          )}
        </span>
      </button>
      {size !== "row" && hearted && (
        <span
          className="font-pixel text-[9px] tracking-[0.18em]"
          style={{ color: "var(--accent)" }}
        >
          HEARTED
        </span>
      )}
    </span>
  );
}

/** A pixel birthday cake: pink frosting, three candles. Decorative. */
function BirthdayCake() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 18 18"
      shapeRendering="crispEdges"
      className="h-[44px] w-[44px] shrink-0"
    >
      {/* flames + candles */}
      <rect x="4" y="0" width="1" height="2" fill="#ffd23f" />
      <rect x="8" y="0" width="1" height="2" fill="#ffd23f" />
      <rect x="12" y="0" width="1" height="2" fill="#ffd23f" />
      <rect x="4" y="2" width="1" height="4" fill="#ffffff" />
      <rect x="8" y="2" width="1" height="4" fill="#ffffff" />
      <rect x="12" y="2" width="1" height="4" fill="#ffffff" />
      {/* top tier: frosting, drips, body */}
      <rect x="4" y="6" width="10" height="1" fill="#ff69b4" />
      <rect x="4" y="7" width="10" height="3" fill="#ffffff" />
      <rect x="5" y="7" width="2" height="1" fill="#ff69b4" />
      <rect x="9" y="7" width="2" height="1" fill="#ff69b4" />
      <rect x="12" y="7" width="1" height="1" fill="#ff69b4" />
      {/* bottom tier */}
      <rect x="2" y="10" width="14" height="1" fill="#ff69b4" />
      <rect x="2" y="11" width="14" height="3" fill="#ffffff" />
      <rect x="3" y="11" width="2" height="1" fill="#ff69b4" />
      <rect x="8" y="11" width="2" height="1" fill="#ff69b4" />
      <rect x="13" y="11" width="2" height="1" fill="#ff69b4" />
      {/* plate */}
      <rect x="1" y="14" width="16" height="1" fill="#ba1e6e" />
    </svg>
  );
}

function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function newSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

interface Identity {
  id: number;
  name: string;
  code: string;
  bugHunter?: boolean;
  token: string;
}

const ID_KEY = "chp.identity.v1";

function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(ID_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Identity;
    if (!parsed.token || !parsed.name) return null;
    return parsed;
  } catch {
    return null;
  }
}

type View = "player" | "standings" | "road" | "backroom" | "song";

type BoardData = ApiResponse<typeof api, "getBoard">;
type LoveBoardData = ApiResponse<typeof api, "getLoveBoard">;
type RoadData = ApiResponse<typeof api, "getMyRoad">;
type TrackBoardData = ApiResponse<typeof api, "getTrackBoard">;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const queryClient = useQueryClient();
  // A cold open on a song address (/s/<slug>) lands on that song's page,
  // not the player home: the boot view and the boot song both read the
  // path the page was served under. An unresolvable slug still opens
  // the song view, which renders its own "not here" state.
  const [view, setView] = useState<View>(() =>
    isSongPath(window.location.pathname) ? "song" : "player",
  );
  const [songIdx, setSongIdx] = useState<number>(() =>
    songIndexFromPath(window.location.pathname),
  );
  // A guest who taps PLAY or the heart on a song page is routed through
  // the claim flow with the song held here; handleClaimed picks the
  // intent up the moment the name lands.
  const songIntentRef = useRef<{ idx: number; play: boolean } | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(loadIdentity);
  const [roomMode, setRoomMode] = useState(false);

  const identityRef = useRef(identity);
  identityRef.current = identity;

  // --- Player state ---------------------------------------------------------
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Scratch column the tape samples each tick from the current track's
  // precomputed fingerprint (see ./fingerprint). There is deliberately
  // no Web Audio graph anywhere in this player: the element's sound
  // goes straight to the device, and the tape reads data, not signal.
  const tapeColumnRef = useRef<Float32Array>(new Float32Array(56));
  const tapeRef = useRef<TapeRenderer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bagRef = useRef<number[]>([]);
  // Session play history, in play order: PREVIOUS pops the last entry.
  // navBackRef marks a loadTrack call that IS a step back, so stepping
  // back doesn't push the track being left (no ping-pong).
  const historyRef = useRef<number[]>([]);
  const navBackRef = useRef(false);
  const currentRef = useRef(-1);
  const listenedRef = useRef(0);
  const lastTimeRef = useRef(0);
  // Wall time of the last progress sample. Listened time is credited
  // from the audio clock, bounded by the wall time actually elapsed
  // since the previous sample — so background playback (where timers
  // are throttled to near-nothing but the song keeps playing) still
  // counts honestly, while a seek forward can never outrun the wall.
  const sampleAtRef = useRef(0);
  // Next-track preload: a detached element warming the upcoming file
  // into the browser cache while the current track plays, so the
  // song-to-song handoff in the dark starts from cache, not cold
  // network. A hint only — the advance itself still picks for real.
  const preloadRef = useRef<HTMLAudioElement | null>(null);
  const preloadIdxRef = useRef(-1);
  // Blob prefetch (2026-11-11, the playback program): the next track's
  // bytes, fetched whole and held as an object URL, so the handoff can
  // start the main element from memory with zero network at the seam.
  // The detached-element warm above stays as the fallback when a fetch
  // cannot complete. blobRef is the held prefetch; currentBlobRef is
  // the object URL the main element is currently playing from.
  const blobRef = useRef<{ idx: number; url: string } | null>(null);
  const blobFetchIdxRef = useRef(-1);
  const blobAbortRef = useRef<AbortController | null>(null);
  const currentBlobRef = useRef<string | null>(null);
  // Stall ladder (2026-11-11): replaces the src-resetting watchdog.
  // stallSinceRef marks when the playhead last froze; ladderStageRef
  // is the highest rung already tried for this freeze; the probe
  // result gates the hard reload; reloads are capped per track.
  const stallSinceRef = useRef(0);
  const ladderStageRef = useRef(0);
  const ladderProbeRef = useRef<{ ok: boolean } | null>(null);
  const ladderReloadsRef = useRef(0);
  const failStreakRef = useRef(0);
  // Haunted-playback guards (2026-11-10): a burst of quick consecutive
  // error advances means the element is wedged, not that every track is
  // bad; the hide-flush marker remembers a play banked on hide so the
  // foreground reconcile can settle instead of re-reporting or skipping;
  // isPlayingRef mirrors UI state for callbacks that can't re-subscribe.
  const errBurstRef = useRef<{ count: number; lastAt: number }>({
    count: 0,
    lastAt: 0,
  });
  const hideFlushRef = useRef<{ trackIdx: number; at: number } | null>(null);
  // Reopen save bookkeeping (2026-11-11): lastSaveRef dedupes the
  // continuous writes (a write happens when the saved second, the
  // banked second, or the playing flag moves — not on every tick);
  // restoreTriedRef keeps the mount restore a one-shot.
  const lastSaveRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const restoreTriedRef = useRef(false);
  const isPlayingRef = useRef(false);
  const reconcileBusyRef = useRef(false);
  // Wake-side fix (2026-11-13): the stall evaluation and the wake
  // return live in different effects than the ears that need them
  // (the element's stall hints, the Page Lifecycle resume), so both
  // are published through refs for any ear to invoke.
  const stallEvalRef = useRef<(() => void) | null>(null);
  const wakeEvalRef = useRef<(() => void) | null>(null);
  // Addendum 2 (owner, 2026-11-10): a stolen-audio episode. The flag is
  // raised when the UI claims playing but the element is paused while
  // VISIBLE (the interruption case — another app took the sound). While
  // it stands, the clock interval retries play() on stall-window
  // spacing, at most 3 attempts, then settles per mechanism A. Any
  // element 'pause' event clears it: real pauses are indistinguishable
  // at the event level, so pausing — by the user OR by the interruption
  // itself — ends the episode, and only an episode still standing when
  // the interval ticks gets auto-resumed. User pause intent also flows
  // through the same event, so a user pause is never overridden live.
  const stolenRef = useRef<{ attempts: number; lastTryAt: number } | null>(
    null,
  );
  // Stall watchdog: last position the audio clock actually reached, the
  // wall time it got there, and how many recoveries this track has had.
  const lastProgressRef = useRef(0);
  const lastProgressAtRef = useRef(0);
  const stallAttemptsRef = useRef(0);
  const stallHintRef = useRef(false);
  const sessionIdRef = useRef<string>(newSessionId());
  const sessionListenedRef = useRef(0);
  const sessionFinishesRef = useRef(0);
  const sessionBankedRef = useRef(0);
  // Live-score projection bridges: while a play is being reported, its
  // projected minute points sit in settlingRef so the counter never
  // dips; if the server settles below the projection (clamp/cap), the
  // difference parks in easeRef and decays to zero instead of dropping.
  const settlingRef = useRef(0);
  const easeRef = useRef(0);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const idleTimerRef = useRef<number>(0);

  const [started, setStarted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [nowIdx, setNowIdx] = useState(-1);
  const [trackClock, setTrackClock] = useState({ elapsed: 0, duration: 0 });
  const [sessionClock, setSessionClock] = useState({
    elapsed: 0,
    finishes: 0,
    banked: 0,
    livePoints: 0,
  });
  const [lastAward, setLastAward] = useState<string | null>(null);
  const [hasPrev, setHasPrev] = useState(false);

  const nowTrack = nowIdx >= 0 ? CATALOG[nowIdx] : undefined;

  // Hearts, read side: the road query doubles as the favorites source
  // (same cache key MyRoad uses), so the now-playing heart knows its
  // state without a second endpoint. Guests skip it entirely.
  const roadLite = useQuery({
    queryKey: ["road", identity?.id],
    queryFn: () =>
      api.getMyRoad({
        token: identity!.token,
        catalogSize: CATALOG.length,
        todayKey: localDayKey(new Date()),
      }),
    enabled: !!identity,
    refetchInterval: 30000,
  });
  // Session honesty: the stored identity renders from local storage and
  // is never re-verified on its own; this road query IS the verification.
  // When it answers ok:false while an identity is stored, the session is
  // stale — rotated away by a sign-in somewhere else. The header and the
  // road view say so and offer the sign-back-in path; the stored
  // identity itself is kept (name and code stay his, only the password
  // needs re-entering).
  const sessionStale =
    !!identity && roadLite.data !== undefined && !roadLite.data.ok;
  // Birthday hearts counter: public, birthday-only. The number renders
  // only when the query has data — a wrong number never shows.
  const birthdayToday = isCharlesBirthday(new Date());
  const heartsToday = useQuery({
    queryKey: ["hearts-today", localDayKey(new Date())],
    queryFn: () => api.getHeartsToday({ todayKey: localDayKey(new Date()) }),
    enabled: birthdayToday,
    refetchInterval: 30000,
  });
  const heartNow = useHeartToggle(() => identityRef.current?.token);
  const nowHearted =
    !!nowTrack &&
    !!roadLite.data?.favorites.some(
      (f) => f.trackTitle === nowTrack.title && f.project === nowTrack.project,
    );

  // The song page's heart: its own toggle core (one per surface, like
  // the now-playing heart), its saved state read from the same road
  // favorites the now-playing heart reads.
  const songTrack = songIdx >= 0 ? CATALOG[songIdx] : undefined;
  const heartSong = useHeartToggle(() => identityRef.current?.token);
  const songHearted =
    !!songTrack &&
    !!roadLite.data?.favorites.some(
      (f) => f.trackTitle === songTrack.title && f.project === songTrack.project,
    );

  const openSong = useCallback((idx: number) => {
    setSongIdx(idx);
    setView("song");
  }, []);

  // The address bar follows the song view: a song page is a real,
  // copyable address, and leaving the view restores the plain root.
  useEffect(() => {
    const path = window.location.pathname;
    if (view === "song" && songIdx >= 0) {
      const target = songPath(songIdx);
      if (path !== target) window.history.pushState(null, "", target);
    } else if (view !== "song" && isSongPath(path)) {
      window.history.pushState(null, "", "/");
    }
  }, [view, songIdx]);

  // Back/forward across song addresses re-opens what the address names.
  useEffect(() => {
    const onPop = () => {
      const path = window.location.pathname;
      if (isSongPath(path)) {
        setSongIdx(songIndexFromPath(path));
        setView("song");
      } else {
        setView((v) => (v === "song" ? "player" : v));
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The tab names the song while its page is open (the served share
  // metadata already does for cold opens; this keeps in-app arrivals
  // honest too).
  useEffect(() => {
    document.title =
      view === "song" && songTrack
        ? `${songTrack.title} — Charles Hamilton · ${songTrack.project}`
        : "Charles Hamilton Player";
  }, [view, songTrack]);

  // --- Wake lock ---------------------------------------------------------------
  const requestWakeLock = useCallback(async () => {
    try {
      const nav = navigator as unknown as {
        wakeLock?: {
          request: (t: string) => Promise<{ release: () => Promise<void> }>;
        };
      };
      if (nav.wakeLock) {
        wakeLockRef.current = await nav.wakeLock.request("screen");
      }
    } catch {
      // Unsupported or policy-blocked: degrade silently.
    }
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && isPlaying) {
        void requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [isPlaying, requestWakeLock]);

  // --- Room mode (idle 60s while playing) --------------------------------------
  const pokeActivity = useCallback(() => {
    setRoomMode(false);
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => setRoomMode(true), 60000);
  }, []);

  useEffect(() => {
    if (isPlaying) pokeActivity();
    else {
      setRoomMode(false);
      window.clearTimeout(idleTimerRef.current);
    }
    return () => window.clearTimeout(idleTimerRef.current);
  }, [isPlaying, pokeActivity]);

  // --- Audio engine --------------------------------------------------------------
  const reportPlay = useCallback(async (naturalEnd: boolean) => {
    const idx = currentRef.current;
    if (idx < 0) return;
    const tr = CATALOG[idx];
    if (!tr) return;
    const listened = listenedRef.current;
    listenedRef.current = 0;
    const audio = audioRef.current;
    // Duration truth order: the audio element's own loaded duration,
    // then the catalog's measured durSec, then (only when neither
    // exists yet) the listened time itself so the report never blocks.
    const dur =
      audio && isFinite(audio.duration) && audio.duration > 0
        ? Math.round(audio.duration)
        : (tr.durationSec ?? Math.max(1, Math.round(listened)));
    if (naturalEnd || listened >= 0.9 * dur) {
      sessionFinishesRef.current += 1;
    }
    const id = identityRef.current;
    if (!id || listened < 1) return;
    // Bridge the projection across the report: the live counter has
    // been showing this play's fractional minute points (listened/60);
    // park them in settlingRef until the settled value replaces them.
    const projected = listened / 60;
    settlingRef.current += projected;
    try {
      const res = await api.logPlay({
        token: id.token,
        sessionId: sessionIdRef.current,
        trackTitle: tr.title,
        project: tr.project,
        durationSec: dur,
        listenedSec: Math.round(listened * 10) / 10,
        naturalEnd,
        dayKey: localDayKey(new Date()),
        catalogSize: CATALOG.length,
      });
      settlingRef.current = Math.max(0, settlingRef.current - projected);
      if (res.ok) {
        if (res.token) {
          // A credential recovery issued this device a fresh session
          // (none was live): adopt it, so the next play keeps reporting
          // instead of dying on the stale token.
          const next = { ...id, token: res.token };
          setIdentity(next);
          try {
            localStorage.setItem(ID_KEY, JSON.stringify(next));
          } catch {
            // Private mode: identity lives for this session only.
          }
        }
        sessionBankedRef.current += res.points;
        if (res.points < projected) {
          // Settled below the projection (clamp or cap): don't drop —
          // park the difference and let the counter ease down to it.
          easeRef.current += projected - res.points;
        }
        if (res.points > 0 || res.capped) {
          setLastAward(
            res.capped
              ? `+${fmtPts2(res.points)} — PAST THE 8H CAP, PLAYS COUNT, POINTS DON'T`
              : `+${fmtPts2(res.points)} BANKED`,
          );
          window.setTimeout(() => setLastAward(null), 5000);
        }
        void queryClient.invalidateQueries({ queryKey: ["board"] });
        void queryClient.invalidateQueries({ queryKey: ["road"] });
        void queryClient.invalidateQueries({ queryKey: ["trackboard"] });
      } else {
        // Rejected (burst clamp): ease the projection away, no drop.
        easeRef.current += projected;
      }
    } catch {
      // A lost report is a quiet interlude, never an error dialog.
      settlingRef.current = Math.max(0, settlingRef.current - projected);
      easeRef.current += projected;
    }
  }, [queryClient]);

  // Durable now-playing save (2026-11-11, the reopen fix): while a
  // track plays, continuously write down where it is — track, position,
  // the honest seconds heard but not yet captured by a report
  // (listenedRef IS that bank, by definition), and whether the
  // listener left it playing or paused it himself. If the OS kills
  // this page on a long dark run, the save is what the reopen finds.
  // Because the bank written here is listenedRef itself, a report
  // capture (which zeroes listenedRef synchronously, hide-flush
  // included) is reflected in the very next write: seconds already
  // claimed can never be claimed again by a restored play. Writes are
  // deduped to when the saved second / banked second / playing flag
  // actually moves, plus forced writes at the discrete moments that
  // matter (pause, hide, pagehide, track change).
  const persistResume = useCallback((force = false) => {
    const idx = currentRef.current;
    const audio = audioRef.current;
    if (idx < 0 || !audio) return;
    const tr = CATALOG[idx];
    if (!tr) return;
    const save: ResumeSave = {
      v: 1,
      title: tr.title,
      project: tr.project,
      src: tr.src,
      pos: Math.max(0, audio.currentTime || 0),
      dur:
        isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : (tr.durationSec ?? 0),
      unreported: Math.max(0, listenedRef.current),
      wasPlaying: isPlayingRef.current,
      savedAt: Date.now(),
    };
    const key = `${idx}|${Math.floor(save.pos)}|${Math.round(save.unreported)}|${save.wasPlaying}`;
    if (!force && key === lastSaveRef.current.key) return;
    lastSaveRef.current = { key, at: save.savedAt };
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify(save));
    } catch {
      // Private mode: the save lives for this page only, reopen
      // degrades to the old cold start. Never an error.
    }
  }, []);

  // Progress sampler: credit listened time from the audio element's
  // own clock, bounded by wall time elapsed since the last sample.
  // Called by the 250ms clock interval in the foreground AND by the
  // element's timeupdate events, which keep firing while a track
  // plays with the screen off — so a song played through sleep still
  // settles with the minutes it actually ran, not the minutes a
  // throttled timer happened to witness. Seeks are rejected by the
  // same bound (a jump forward outruns the wall). atEnded takes the
  // final sample as the track ends, before reportPlay captures.
  const sampleProgress = useCallback((atEnded = false) => {
    const audio = audioRef.current;
    if (!audio) return;
    // The save rides the sampler: every honest sample is also the
    // moment the durable record of this play is freshest.
    persistResume();
    if (!atEnded && (audio.paused || audio.ended)) return;
    const now = Date.now();
    const wall =
      sampleAtRef.current > 0 ? (now - sampleAtRef.current) / 1000 : 0;
    sampleAtRef.current = now;
    const ct = audio.currentTime;
    const d = ct - lastTimeRef.current;
    if (d > 0 && d <= wall + 1) {
      listenedRef.current += d;
      sessionListenedRef.current += d;
    }
    lastTimeRef.current = ct;
    if (ct > lastProgressRef.current + 0.05) {
      lastProgressRef.current = ct;
      lastProgressAtRef.current = now;
      stallHintRef.current = false;
      // A play that has genuinely run 30s+ is healthy: any earlier
      // error burst is history, not a pattern.
      if (listenedRef.current >= 30) {
        errBurstRef.current = { count: 0, lastAt: 0 };
      }
    }
  }, [persistResume]);

  const pickNext = useCallback((): number => {
    if (CATALOG.length === 1) return 0;
    if (bagRef.current.length === 0) {
      const all = CATALOG.map((_, i) => i).filter(
        (i) => i !== currentRef.current,
      );
      // Fisher-Yates bag: no repeat until the whole catalog has played.
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = all[i] as number;
        all[i] = all[j] as number;
        all[j] = tmp;
      }
      bagRef.current = all;
    }
    return bagRef.current.pop() ?? 0;
  }, []);

  // Peek at the track pickNext would serve (refilling the bag the
  // same way) without consuming it. Exists only to aim the preload;
  // the real advance still pops for itself.
  const peekNext = useCallback((): number => {
    if (CATALOG.length === 1) return 0;
    if (bagRef.current.length === 0) {
      const all = CATALOG.map((_, i) => i).filter(
        (i) => i !== currentRef.current,
      );
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = all[i] as number;
        all[i] = all[j] as number;
        all[j] = tmp;
      }
      bagRef.current = all;
    }
    return bagRef.current[bagRef.current.length - 1] ?? 0;
  }, []);

  // Seconds of audio buffered ahead of the playhead — the single
  // most diagnostic number in the player: it gates the prefetch (a
  // hungry radio should finish the current song's cushion before it
  // starts pulling the next one) and it judges stalls (a freeze with
  // cushion in hand is not a network stall).
  const bufferedAhead = useCallback((): number => {
    const audio = audioRef.current;
    if (!audio) return 0;
    try {
      const ct = audio.currentTime;
      for (let i = 0; i < audio.buffered.length; i++) {
        if (audio.buffered.start(i) <= ct && ct <= audio.buffered.end(i)) {
          return Math.max(0, audio.buffered.end(i) - ct);
        }
      }
    } catch {
      // No ranges yet: no cushion.
    }
    return 0;
  }, []);

  // The flight recorder's snapshot of this moment.
  const recSnap = useCallback((): FlightSnap => {
    const audio = audioRef.current;
    const idx = currentRef.current;
    const tr = idx >= 0 ? CATALOG[idx] : undefined;
    return {
      track: tr ? tr.title : "",
      ct: audio ? audio.currentTime || 0 : 0,
      dur:
        audio && isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : (tr?.durationSec ?? 0),
      buf: bufferedAhead(),
      rs: audio ? audio.readyState : 0,
      ns: audio ? audio.networkState : 0,
      paused: audio ? audio.paused : true,
    };
  }, [bufferedAhead]);

  // Media Session position state: keeps Android's media notification
  // honest about where the song is on long sessions.
  const updatePositionState = useCallback(() => {
    try {
      const audio = audioRef.current;
      if (!audio || !("mediaSession" in navigator)) return;
      const dur = audio.duration;
      if (!isFinite(dur) || dur <= 0) return;
      navigator.mediaSession.setPositionState({
        duration: dur,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(Math.max(0, audio.currentTime || 0), dur),
      });
    } catch {
      // Garnish only.
    }
  }, []);

  // Warm the next track. Two courtesies, in order of strength:
  //   1. Fetch the whole file and hold it as a blob object URL, so
  //      the handoff starts the main element from bytes already in
  //      hand — zero silence at the seam, which is the window where
  //      a sleeping phone's battery police reap background pages.
  //   2. If the fetch cannot complete, warm the browser cache on the
  //      detached element instead (the original mechanism).
  // Gated on the current track's cushion: prefetch does not start
  // until the playing song has >= 15s buffered ahead, so the next
  // song never starves the current one on a waking radio.
  const preloadNext = useCallback(() => {
    try {
      // BANDWIDTH YIELD (2026-11-12): a prefetch in flight aborts if
      // the PLAYING track's cushion later drains under 5s — the
      // current song's stream outranks the next song's download. The
      // fetch may restart on a later tick once the cushion recovers
      // (the >= 15s start gate below gives the pair hysteresis).
      if (
        blobAbortRef.current &&
        currentRef.current >= 0 &&
        bufferedAhead() < 5
      ) {
        blobAbortRef.current.abort();
        blobAbortRef.current = null;
      }
      const idx = peekNext();
      const tr = CATALOG[idx];
      if (!tr) return;
      if (blobRef.current?.idx === idx) return;
      if (idx === preloadIdxRef.current) return;
      const audio = audioRef.current;
      if (audio && currentRef.current >= 0 && bufferedAhead() < 15) {
        return; // Cushion first; the clock interval retries.
      }
      // Warm the next track's tape fingerprint alongside its audio, so
      // the handoff paints from its first second too.
      ensureFingerprint(tr.src);
      if (blobFetchIdxRef.current === idx) return;
      blobFetchIdxRef.current = idx;
      const controller = new AbortController();
      blobAbortRef.current = controller;
      void (async () => {
        try {
          const res = await fetch(tr.src, { signal: controller.signal });
          if (!res.ok) throw new Error("prefetch failed");
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          if (blobRef.current) URL.revokeObjectURL(blobRef.current.url);
          blobRef.current = { idx, url };
          preloadIdxRef.current = idx;
        } catch {
          // A deliberate yield (bandwidth abort above) is not a
          // failure: skip the cache-warm fallback, which would pull
          // the same bytes over the same hungry radio.
          if (controller.signal.aborted) return;
          // Fallback: warm the cache on the detached element.
          try {
            if (preloadIdxRef.current !== idx) {
              preloadIdxRef.current = idx;
              if (!preloadRef.current) {
                preloadRef.current = new Audio();
                preloadRef.current.preload = "auto";
              }
              preloadRef.current.src = tr.src;
              preloadRef.current.load();
            }
          } catch {
            // Preload is a courtesy to the handoff, never a failure path.
          }
        } finally {
          if (blobFetchIdxRef.current === idx) blobFetchIdxRef.current = -1;
          if (blobAbortRef.current === controller) blobAbortRef.current = null;
        }
      })();
    } catch {
      // Preload is a courtesy to the handoff, never a failure path.
    }
  }, [peekNext, bufferedAhead]);

  const updateMediaSession = useCallback((idx: number) => {
    const tr = CATALOG[idx];
    if (!tr) return;
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: tr.title,
          artist: ARTIST,
          album: tr.project,
        });
      }
    } catch {
      // Media Session is garnish; never let it break playback.
    }
  }, []);

  const loadTrack = useCallback(
    (idx: number, autoplay: boolean) => {
      const tr = CATALOG[idx];
      const audio = audioRef.current;
      if (!tr || !audio) return;
      const outgoing = currentRef.current;
      if (outgoing >= 0 && outgoing !== idx && !navBackRef.current) {
        historyRef.current.push(outgoing);
      }
      navBackRef.current = false;
      setHasPrev(historyRef.current.length > 0);
      currentRef.current = idx;
      hideFlushRef.current = null;
      listenedRef.current = 0;
      lastTimeRef.current = 0;
      sampleAtRef.current = Date.now();
      lastProgressRef.current = 0;
      lastProgressAtRef.current = Date.now();
      stallAttemptsRef.current = 0;
      stallHintRef.current = false;
      stallSinceRef.current = 0;
      ladderStageRef.current = 0;
      ladderProbeRef.current = null;
      ladderReloadsRef.current = 0;
      setNowIdx(idx);
      setTrackClock({ elapsed: 0, duration: tr.durationSec ?? 0 });
      tapeRef.current?.markChange();
      updateMediaSession(idx);
      // The tape's data rides along lazily; playback never waits on it.
      ensureFingerprint(tr.src);
      // The seam: if the prefetch holds this track's bytes, the main
      // element starts from memory and the boundary has no network
      // silence in it at all. Otherwise it loads the way it always
      // did, from the warmed cache or the network.
      const held = blobRef.current;
      if (currentBlobRef.current && currentBlobRef.current !== held?.url) {
        URL.revokeObjectURL(currentBlobRef.current);
        currentBlobRef.current = null;
      }
      if (held && held.idx === idx) {
        audio.src = held.url;
        currentBlobRef.current = held.url;
        blobRef.current = null;
      } else {
        audio.src = tr.src;
      }
      recEvent("track", {
        track: tr.title,
        ct: 0,
        dur: tr.durationSec ?? 0,
        buf: 0,
        rs: audio.readyState,
        ns: audio.networkState,
        paused: audio.paused,
      });
      if (autoplay) {
        audio.play().catch(() => handleTrackError());
      }
      // This track is rolling: warm the one after it.
      preloadIdxRef.current = -1;
      preloadNext();
      // A track change overwrites the reopen save on the spot: the
      // outgoing song (finished, skipped, or stepped away from) is
      // never what a reopen resurrects. audio.currentTime has just
      // been reset by the src change and listenedRef zeroed above,
      // so this writes the new track at its honest zero.
      persistResume(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateMediaSession, preloadNext, persistResume],
  );

  // THE HANDOFF: report first, but never WAIT on the report.
  // reportPlay captures the outgoing play synchronously (track,
  // listened, duration) and its POST settles in the background; the
  // next track loads and starts immediately. The old shape awaited
  // the network before even setting the next src — with the screen
  // off, a sleeping phone stalls that POST indefinitely, the song
  // ends, and nothing ever starts (Matteo's report, 2026-11-11).
  const advance = useCallback(
    (natural: boolean) => {
      void reportPlay(natural);
      failStreakRef.current = 0;
      errBurstRef.current = { count: 0, lastAt: 0 };
      loadTrack(pickNext(), true);
    },
    [reportPlay, pickNext, loadTrack],
  );

  const handleTrackError = useCallback(() => {
    failStreakRef.current += 1;
    if (failStreakRef.current > CATALOG.length) {
      // Everything failed in a row: stop advancing, stay calm.
      setIsPlaying(false);
      return;
    }
    // Burst cap: three error advances inside 10s of each other is a
    // wedged element falling down its own staircase (the haunted skip
    // cascade), not three bad tracks. Stop on the current track and
    // stay calm; the outer failStreak ceiling above still bounds all.
    const now = Date.now();
    const burst = errBurstRef.current;
    const inBurst = burst.lastAt > 0 && now - burst.lastAt <= 10000;
    const count = inBurst ? burst.count + 1 : 1;
    errBurstRef.current = { count, lastAt: now };
    if (count >= 3) {
      errBurstRef.current = { count: 0, lastAt: 0 };
      setIsPlaying(false);
      setLastAward("THAT TRACK WON'T PLAY — PRESS PLAY TO TRY AGAIN");
      window.setTimeout(() => setLastAward(null), 5000);
      return;
    }
    window.setTimeout(() => {
      // Same rule as the natural handoff: settle in the background,
      // load the next track now — never gate playback on the POST.
      void reportPlay(false);
      loadTrack(pickNext(), true);
    }, 1200);
  }, [reportPlay, pickNext, loadTrack]);

  // THE STALL EVALUATION (extracted 2026-11-13, the wake-side fix).
  // This is the ladder block the 250ms interval used to carry inline,
  // lifted unchanged into a callback so stall supervision has more
  // than one driver: the interval still calls it every tick, and the
  // audio element's own waiting/stalled hints call it the moment the
  // element complains, while the page is alive to hear them. Every
  // rule inside is the ladder's own, preserved exactly: the cushion
  // gate, the honest wall-clock freeze clock (the caller samples
  // progress first where it can; the readings here are live either
  // way), the stage timings, the probe-gated reload, the per-track
  // reload cap. It never runs on a paused element — a user pause is
  // sacred and no evaluation may speak over it.
  const evaluateStall = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audio.paused || audio.ended) return;
    if (currentRef.current < 0) return;
    // CUSHION GATE (2026-11-12): with more than a second of audio in
    // hand there is no stall to recover from — the ladder stands down
    // entirely: no timing, no stages. A genuine network stall drains
    // the cushion first; only then may a freeze start timing.
    const nowMs = Date.now();
    // FREEZE is wall-clock time since the playhead was last observed
    // to move — lastProgressAtRef, stamped by the sampler. No
    // position-vs-snapshot race: throttled background timers once
    // desynced the two readings and the verdict cried frozen over a
    // healthy song.
    const frozenFor =
      lastProgressAtRef.current > 0 ? nowMs - lastProgressAtRef.current : 0;
    if (bufferedAhead() > 1 || frozenFor < 1000) {
      // Cushion in hand, or motion observed within the last second:
      // healthy. Stand down and reset.
      ladderStageRef.current = 0;
      ladderProbeRef.current = null;
      return;
    }
    const stage = ladderStageRef.current;
    const tr = CATALOG[currentRef.current];
    if (frozenFor >= 17000 && stage < 4) {
      ladderStageRef.current = 4;
      recEvent("watchdog", { ...recSnap(), stage: 4 });
      if (tr && ladderProbeRef.current?.ok && ladderReloadsRef.current < 2) {
        ladderReloadsRef.current += 1;
        const pos = lastProgressRef.current;
        const resume = () => {
          try {
            audio.currentTime = pos;
          } catch {
            // Not seekable yet: play from wherever it lands.
          }
          audio.removeEventListener("loadedmetadata", resume);
        };
        audio.addEventListener("loadedmetadata", resume);
        audio.src =
          blobRef.current?.idx === currentRef.current
            ? blobRef.current.url
            : tr.src;
        void audio.play().catch(() => undefined);
        // A reload buys a fresh ladder window for this freeze.
        lastProgressAtRef.current = nowMs;
        ladderStageRef.current = 0;
        ladderProbeRef.current = null;
      } else {
        // No proven network, or the reload cap is spent: the error
        // path takes the track from here.
        ladderStageRef.current = 0;
        ladderProbeRef.current = null;
        handleTrackError();
      }
    } else if (frozenFor >= 12000 && stage < 3) {
      ladderStageRef.current = 3;
      recEvent("watchdog", { ...recSnap(), stage: 3 });
      if (tr && navigator.onLine) {
        void fetch(tr.src, { method: "HEAD" })
          .then((res) => {
            ladderProbeRef.current = { ok: res.ok };
          })
          .catch(() => {
            ladderProbeRef.current = { ok: false };
          });
      } else {
        ladderProbeRef.current = { ok: false };
      }
    } else if (frozenFor >= 9000 && stage < 2) {
      ladderStageRef.current = 2;
      recEvent("watchdog", { ...recSnap(), stage: 2 });
      try {
        audio.currentTime = audio.currentTime + 0.05;
      } catch {
        // Not seekable: the nudge below still applies.
      }
      void audio.play().catch(() => undefined);
    } else if (frozenFor >= 5000 && stage < 1) {
      ladderStageRef.current = 1;
      recEvent("watchdog", { ...recSnap(), stage: 1 });
      void audio.play().catch(() => undefined);
    }
  }, [bufferedAhead, recSnap, handleTrackError]);

  // Publish the evaluation for the ears that live in other effects.
  useEffect(() => {
    stallEvalRef.current = evaluateStall;
  }, [evaluateStall]);

  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.addEventListener("ended", () => {
      // Final sample first: the tail of the track counts too, then
      // the handoff fires. Driven by the element's own event, never
      // by a timer — timers are exactly what a sleeping phone takes.
      recEvent("ended", recSnap());
      sampleProgress(true);
      void advance(true);
    });
    audio.addEventListener("timeupdate", () => {
      // The media clock keeps ticking while a song plays in the
      // dark; sample from it so background minutes are real minutes.
      sampleProgress();
    });
    audio.addEventListener("error", () => {
      recEvent("error", recSnap());
      if (currentRef.current >= 0) handleTrackError();
    });
    audio.addEventListener("play", () => {
      recEvent("play", recSnap());
      isPlayingRef.current = true;
      setIsPlaying(true);
      try {
        if ("mediaSession" in navigator)
          navigator.mediaSession.playbackState = "playing";
      } catch {
        // Garnish only.
      }
    });
    audio.addEventListener("pause", () => {
      recEvent("pause", recSnap());
      isPlayingRef.current = false;
      setIsPlaying(false);
      try {
        if ("mediaSession" in navigator)
          navigator.mediaSession.playbackState = "paused";
      } catch {
        // Garnish only.
      }
      // Any pause event ends a stolen-audio episode (see stolenRef).
      stolenRef.current = null;
      // The pause is a fact the reopen must honor: write the save
      // with the playing flag already down (isPlayingRef was cleared
      // above), so a restored page never autoplays over his intent.
      persistResume(true);
    });
    audio.addEventListener("playing", () => {
      // Real motion again: the watchdog stands down for this track.
      recEvent("playing", recSnap());
      stallAttemptsRef.current = 0;
      stallHintRef.current = false;
      stallSinceRef.current = 0;
      ladderStageRef.current = 0;
      ladderProbeRef.current = null;
      lastProgressAtRef.current = Date.now();
      updatePositionState();
    });
    const onStallHint = () => {
      stallHintRef.current = true;
      recEvent("stallhint", recSnap());
      // The element's own distress signal is a supervisor tick too
      // (2026-11-13): evaluate the stall right now instead of waiting
      // for the interval's next beat. The evaluation's own gates
      // decide whether anything is actually wrong.
      stallEvalRef.current?.();
    };
    audio.addEventListener("stalled", onStallHint);
    audio.addEventListener("waiting", onStallHint);
    audioRef.current = audio;
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.setActionHandler("play", () => {
          recEvent("msaction", { ...recSnap(), note: "play" });
          void audio.play().catch(() => undefined);
        });
        navigator.mediaSession.setActionHandler("pause", () => {
          recEvent("msaction", { ...recSnap(), note: "pause" });
          audio.pause();
        });
        navigator.mediaSession.setActionHandler("nexttrack", () => {
          recEvent("msaction", { ...recSnap(), note: "nexttrack" });
          void advance(false);
        });
        navigator.mediaSession.setActionHandler("previoustrack", () => {
          recEvent("msaction", { ...recSnap(), note: "previoustrack" });
          void goPrevious();
        });
      }
    } catch {
      // Handlers are best-effort.
    }
    return audio;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advance, handleTrackError, sampleProgress, persistResume]);

  const restartTrack = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || currentRef.current < 0) return;
    await reportPlay(false);
    listenedRef.current = 0;
    lastTimeRef.current = 0;
    sampleAtRef.current = Date.now();
    audio.currentTime = 0;
    tapeRef.current?.markChange();
    persistResume(true);
    await audio.play().catch(() => undefined);
  }, [reportPlay, persistResume]);

  const startPlayback = useCallback(() => {
    const audio = ensureAudio();
    try {
      const nav = navigator as unknown as {
        audioSession?: { type: string };
      };
      if (nav.audioSession) nav.audioSession.type = "playback";
    } catch {
      // iOS garnish only.
    }
    setStarted(true);
    void requestWakeLock();
    if (currentRef.current < 0) {
      loadTrack(pickNext(), true);
    } else {
      void audio.play().catch(() => undefined);
    }
  }, [ensureAudio, loadTrack, pickNext, requestWakeLock]);

  // PREVIOUS: step back one track in this session's play order. The
  // in-flight play settles exactly the way NEXT settles it (reportPlay
  // first), and loadTrack is told not to push the track being left —
  // stepping back shrinks the stack instead of ping-ponging.
  const goPrevious = useCallback(async () => {
    const prev = historyRef.current.pop();
    setHasPrev(historyRef.current.length > 0);
    if (prev === undefined) return;
    await reportPlay(false);
    failStreakRef.current = 0;
    navBackRef.current = true;
    loadTrack(prev, true);
  }, [reportPlay, loadTrack]);

  // Play one catalog track directly (a Recent Plays row): same engine
  // start as the first PLAY tap, same settle-then-load path as NEXT,
  // and the track leaves the shuffle bag so it can't repeat early.
  const playCatalogIndex = useCallback(
    async (idx: number) => {
      if (idx < 0 || !CATALOG[idx]) return;
      setView("player");
      if (idx === currentRef.current && audioRef.current) {
        await restartTrack();
        return;
      }
      ensureAudio();
      setStarted(true);
      void requestWakeLock();
      bagRef.current = bagRef.current.filter((i) => i !== idx);
      if (currentRef.current >= 0) {
        await reportPlay(false);
      }
      failStreakRef.current = 0;
      loadTrack(idx, true);
    },
    [ensureAudio, loadTrack, reportPlay, requestWakeLock, restartTrack],
  );

  // Recent Plays entries resolve against the catalog by title +
  // project (the exact pair they were logged from); title alone is
  // the fallback. No match means the row simply doesn't play.
  const playRecent = useCallback(
    (trackTitle: string, project: string) => {
      let idx = CATALOG.findIndex(
        (t) => t.title === trackTitle && t.project === project,
      );
      if (idx < 0) idx = CATALOG.findIndex((t) => t.title === trackTitle);
      if (idx >= 0) void playCatalogIndex(idx);
    },
    [playCatalogIndex],
  );

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void requestWakeLock();
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
      void wakeLockRef.current?.release().catch(() => undefined);
    }
  }, [requestWakeLock]);

  // --- Listening clock: accumulate from the audio clock, display 1/sec --------
  useEffect(() => {
    if (!started) return;
    let lastShownSec = -1;
    let lastShownCent = -1;
    const t = window.setInterval(() => {
      const audio = audioRef.current;
      if (!audio) return;
      if (!audio.paused && !audio.ended) {
        // Credit and progress tracking live in the shared sampler;
        // timeupdate events feed it too, so a track playing in the
        // dark accumulates exactly like one on screen. The sampler
        // runs FIRST: it is what stamps lastProgressAtRef, the last
        // moment the playhead was observed to move, and every
        // position reading in this tick is taken after that
        // observation, never before it.
        sampleProgress();
        const ct = audio.currentTime;
        // The tick testifies about its own spacing (2026-11-13): if
        // the page was suspended since the last beat, this writes the
        // gap event before anything else reads the silence as data.
        recTickGap(recSnap());
        recHeartbeat(recSnap());
        updatePositionState();
        // Prefetch runs on the cushion rule now: offer it every tick
        // and let preloadNext itself refuse until the playing track
        // has >= 15s buffered ahead.
        preloadNext();
        // THE STALL LADDER lives in evaluateStall now (extracted
        // 2026-11-13, the wake-side fix) — the same evaluation the
        // element's stall hints invoke directly. Its header tells the
        // ladder's whole story: the cushion gate, the honest freeze
        // clock, the gentle rungs, the probe-gated reload. A user
        // pause never reaches here (paused branch below).
        evaluateStall();
        // Near the end: make sure the next file is warm. Normally
        // loadTrack already aimed the preload; this catches the bag
        // having changed under us (a manual jump filtered a track).
        if (
          isFinite(audio.duration) &&
          audio.duration > 0 &&
          audio.duration - ct < 60
        ) {
          preloadNext();
        }
      } else {
        lastTimeRef.current = audio.currentTime;
        sampleAtRef.current = Date.now();
        // Auto-resume (Addendum 2): the element sits paused. If the UI
        // state says playing, we are VISIBLE, and no pause event ever
        // landed, this is a silent steal/freeze, not a user pause —
        // raise (or continue) the episode and try to take the sound
        // back from the element's frozen position. Bounded: at most 3
        // attempts, spaced by the stall window (6s, 3s on a stall
        // hint); then settle paused and stop trying. If the page was
        // fully suspended this interval never ran, and the foreground
        // reconcile covers the return instead.
        if (
          audio.paused &&
          !audio.ended &&
          isPlayingRef.current &&
          currentRef.current >= 0 &&
          document.visibilityState === "visible"
        ) {
          const ep = stolenRef.current ?? { attempts: 0, lastTryAt: 0 };
          stolenRef.current = ep;
          const spacing = stallHintRef.current ? 3000 : 6000;
          if (
            ep.attempts < 3 &&
            Date.now() - ep.lastTryAt >= spacing
          ) {
            ep.attempts += 1;
            ep.lastTryAt = Date.now();
            void audio.play().catch(() => undefined);
          } else if (
            ep.attempts >= 3 &&
            Date.now() - ep.lastTryAt >= spacing
          ) {
            // Retries exhausted: settle per mechanism A.
            stolenRef.current = null;
            setIsPlaying(false);
            setLastAward("THAT TRACK WON'T PLAY — PRESS PLAY TO TRY AGAIN");
            window.setTimeout(() => setLastAward(null), 5000);
          }
        }
      }
      // Ease any settled-below-projection difference down gently
      // (~1.5s) rather than letting the live counter drop in one step.
      if (easeRef.current > 0) {
        easeRef.current = Math.max(0, easeRef.current - easeRef.current * 0.18 - 0.002);
      }
      // LIVE SCORE projection: banked points + the in-flight play's
      // fractional minute points (listened/60) + any settling/easing
      // residue. Guests see the same ticking math off the session
      // clock — it just never banks to a name.
      const livePoints = identityRef.current
        ? sessionBankedRef.current +
          settlingRef.current +
          easeRef.current +
          listenedRef.current / 60
        : sessionListenedRef.current / 60;
      const shownSec = Math.floor(sessionListenedRef.current);
      const shownCent = Math.round(livePoints * 100);
      if (shownSec !== lastShownSec || shownCent !== lastShownCent) {
        lastShownSec = shownSec;
        lastShownCent = shownCent;
        setSessionClock({
          elapsed: sessionListenedRef.current,
          finishes: sessionFinishesRef.current,
          banked: sessionBankedRef.current,
          livePoints,
        });
        setTrackClock({
          elapsed: audio.currentTime || 0,
          duration:
            isFinite(audio.duration) && audio.duration > 0
              ? audio.duration
              : (nowTrack?.durationSec ?? 0),
        });
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [started, nowTrack, sampleProgress, preloadNext, evaluateStall]);

  // Flush the in-progress play if the page goes away mid-track.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && listenedRef.current >= 5) {
        // Marker FIRST: the reconcile on return must know this track's
        // play was already banked here, so it settles instead of
        // re-reporting or error-skipping (mechanism C).
        hideFlushRef.current = {
          trackIdx: currentRef.current,
          at: Date.now(),
        };
        void reportPlay(false);
        // reportPlay captured the bank synchronously (listenedRef is
        // already zeroed): the save written now can never resurrect
        // seconds this flush just claimed.
        persistResume(true);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [reportPlay, persistResume]);

  // Pagehide (2026-11-11): the kill itself. visibilitychange covers
  // most departures, but a page torn down by the OS can reach pagehide
  // with its bank unflushed. Bank exactly like the hide-flush does —
  // capture first, then write the save with the claim already made —
  // so a death loses at most the sub-5s tail, and claims nothing twice.
  useEffect(() => {
    const onPageHide = () => {
      if (currentRef.current < 0) return;
      if (listenedRef.current >= 5) {
        hideFlushRef.current = {
          trackIdx: currentRef.current,
          at: Date.now(),
        };
        void reportPlay(false);
      }
      persistResume(true);
      // The flight recorder's goodbye: a ring ending in pagehide is
      // a clean close. A ring that just stops is a death, and the
      // next boot files it.
      recGoodbye(recSnap());
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [reportPlay, persistResume, recSnap]);

  // Foreground reconcile (mechanism A) + THE WAKE-SIDE CLIMB
  // (2026-11-13). On returning to the window, if the UI believes it
  // is playing but the element disagrees — another app stole the
  // phone's audio, or the element froze while suspended — settle
  // against reality. Never errors, never advances.
  //
  // The 2026-11-13 diagnosis named why the old reconcile was not
  // enough: every supervisor lives on the 250ms interval, and a
  // hidden, silenced page can lose that interval for minutes — the
  // ladder never got the chance to be wrong, it never ran. The wake
  // is therefore a tick in its own right, and the reconcile may now
  // climb the ladder's CHEAP RUNGS on return: the first play()
  // attempt it always made, then — if the playhead is still frozen
  // after a short window — another play() nudge (L1), then the L2
  // micro-seek. The hard rungs stay where they belong: L4's reload
  // fires only through the interval ladder with its proven-network
  // gate, never on wake alone. Baselines are re-anchored first, as
  // they always were, so every reading after a suspension is honest.
  // A user pause is sacred throughout: the UI wanting playback is
  // the entry gate, and every rung re-checks it before acting.
  useEffect(() => {
    const WAKE_CHECK_MS = 1500;
    let timers: number[] = [];
    const later = (fn: () => void, ms: number) => {
      timers.push(window.setTimeout(fn, ms));
    };
    const reconcile = () => {
      if (reconcileBusyRef.current) return;
      const audio = audioRef.current;
      if (!audio || currentRef.current < 0 || !isPlayingRef.current) return;
      const trackIdx = currentRef.current;
      const stalled =
        Date.now() - lastProgressAtRef.current > 4000 &&
        audio.currentTime <= lastProgressRef.current + 0.05;
      if (!audio.paused && !stalled) return; // honestly playing
      reconcileBusyRef.current = true;
      // Re-anchor every progress baseline at the element's position
      // NOW. Across a suspension the wall clock jumped while the
      // audio clock may not have; if the stall watchdog keeps judging
      // from the pre-sleep baseline, its first act on return is a
      // spurious src reset — the hiccupy catch-up heard after long
      // unattended sessions. From here, everything measures fresh.
      lastTimeRef.current = audio.currentTime;
      sampleAtRef.current = Date.now();
      lastProgressRef.current = audio.currentTime;
      lastProgressAtRef.current = Date.now();
      stallSinceRef.current = 0;
      ladderStageRef.current = 0;
      ladderProbeRef.current = null;
      const marker = hideFlushRef.current;
      if (marker && marker.trackIdx === trackIdx) {
        // This play was already banked by the hide-flush: just settle
        // at the element's true position, no resume, no report.
        hideFlushRef.current = null;
        lastTimeRef.current = audio.currentTime;
        setIsPlaying(false);
        reconcileBusyRef.current = false;
        return;
      }
      const anchorCt = audio.currentTime;
      // Motion again means the return healed itself: stand down.
      // (The sampler keeps lastProgressAtRef honest, but the direct
      // position read here is the wake path's own witness.) A fat
      // cushion AND resumed progress is the cushion gate's stand-down
      // in its own terms; progress alone ends the climb regardless —
      // a moving playhead is not a stall.
      const resumed = () =>
        currentRef.current !== trackIdx ||
        !isPlayingRef.current ||
        (!audio.paused && audio.currentTime > anchorCt + 0.05);
      const settleCalm = () => {
        lastTimeRef.current = audio.currentTime;
        setIsPlaying(false);
        setLastAward("THAT TRACK WON'T PLAY — PRESS PLAY TO TRY AGAIN");
        window.setTimeout(() => setLastAward(null), 5000);
        reconcileBusyRef.current = false;
      };
      const climbL2 = () => {
        if (resumed()) {
          reconcileBusyRef.current = false;
          return;
        }
        // L2, the micro-seek: unstick the decoder, then play.
        ladderStageRef.current = Math.max(ladderStageRef.current, 2);
        recEvent("watchdog", { ...recSnap(), stage: 2, note: "wake" });
        try {
          audio.currentTime = audio.currentTime + 0.05;
        } catch {
          // Not seekable: the nudge below still applies.
        }
        void audio.play().catch(() => undefined);
        later(() => {
          if (resumed()) {
            reconcileBusyRef.current = false;
            return;
          }
          // The cheap rungs are spent. Settle calm on this track,
          // per mechanism A; if the element is still unpaused and
          // frozen, the interval ladder — awake now — owns whatever
          // harder judgment comes next, probe gate and all.
          settleCalm();
        }, WAKE_CHECK_MS);
      };
      const climbL1 = () => {
        if (resumed()) {
          reconcileBusyRef.current = false;
          return;
        }
        // L1, the gentle nudge, one rung up from the first attempt.
        ladderStageRef.current = Math.max(ladderStageRef.current, 1);
        recEvent("watchdog", { ...recSnap(), stage: 1, note: "wake" });
        void audio.play().catch(() => undefined);
        later(climbL2, WAKE_CHECK_MS);
      };
      // One recovery attempt at the element's own position — the
      // attempt this reconcile always made. Its promise resolving is
      // not proof of motion, so the climb checks the playhead itself
      // a short window later.
      void audio
        .play()
        .then(() => {
          later(climbL1, WAKE_CHECK_MS);
        })
        .catch(() => {
          // Focus/autoplay policy says no: settle calm on this track.
          settleCalm();
        });
    };
    wakeEvalRef.current = reconcile;
    const onWake = () => {
      // The wake testifies first: if the page was suspended, the gap
      // event lands now, not at the interval's next throttled beat.
      recTickGap(recSnap());
      reconcile();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") onWake();
    };
    const onResume = () => onWake();
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("resume", onResume);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("resume", onResume);
      window.removeEventListener("focus", onWake);
      timers.forEach((id) => window.clearTimeout(id));
      timers = [];
    };
  }, []);

  // --- Flight recorder: boot judgment + lifecycle ears (2026-11-11) -----------
  // On mount, judge the previous session: if its ring does not end in
  // a pagehide goodbye, it died in the dark, and this boot files the
  // anonymous death report by itself. Then keep this session's ears
  // open: visibility, freeze/resume, pageshow, network changes.
  useEffect(() => {
    const death = recBoot();
    if (death) {
      void api
        .reportCrash({
          uaFamily: death.uaFamily,
          diedAt: death.diedAt,
          events: death.events,
        })
        .catch(() => undefined);
    }
    const snap = () => recSnap();
    const onVis = () => recEvent("visibility", snap());
    const onFreeze = () => recEvent("freeze", snap());
    const onResume = () => {
      recEvent("resume", snap());
      // A resumed page is a woken page (2026-11-13): run the wake
      // evaluation now — gap testimony plus the reconcile's climb —
      // instead of waiting for a visibility change that may never
      // come (a frozen page can resume while already visible).
      wakeEvalRef.current?.();
    };
    const onShow = (ev: PageTransitionEvent) =>
      recEvent("pageshow", { ...snap(), note: ev.persisted ? "persisted" : "fresh" });
    const onOnline = () =>
      recEvent("online", {
        ...snap(),
        note: (navigator as { connection?: { effectiveType?: string } }).connection
          ?.effectiveType,
      });
    const onOffline = () => recEvent("offline", snap());
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("freeze", onFreeze);
    document.addEventListener("resume", onResume);
    window.addEventListener("pageshow", onShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Resume on reopen (2026-11-11) ------------------------------------------
  // One shot, on mount: judge the durable save (./resume). A good save
  // means the previous page died mid-song — OS kill on a long dark
  // run, crash, torn-down tab. Instead of the cold shuffle a reopen
  // used to serve, his song is cued at his position, the sampler
  // baselines are anchored there (a restore is not a seek the wall
  // clock should pay for), and the unreported bank rides back into
  // listenedRef, where the play's one eventual report claims it —
  // exactly once, alongside whatever he hears after the return.
  // If he had left it playing, the page tries to hand the sound
  // straight back; autoplay policy may refuse without a gesture, and
  // then it simply rests, cued, on his song. If HE had paused it, no
  // attempt is made at all: a user pause is sacred across a death too.
  useEffect(() => {
    if (restoreTriedRef.current) return;
    restoreTriedRef.current = true;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(RESUME_KEY);
    } catch {
      raw = null;
    }
    if (!raw) return;
    const verdict = judgeResume(raw, Date.now(), (s) => {
      let i = CATALOG.findIndex(
        (t) => t.title === s.title && t.project === s.project,
      );
      if (i < 0) i = CATALOG.findIndex((t) => t.src === s.src);
      return i;
    });
    if (!verdict.ok) {
      // A save that may not come back (stale, finished, gone, corrupt)
      // is cleared so it is never judged twice.
      try {
        localStorage.removeItem(RESUME_KEY);
      } catch {
        // Nothing to clear in a storage-less session.
      }
      return;
    }
    const { idx, save } = verdict;
    const tr = CATALOG[idx];
    if (!tr) return;
    const audio = ensureAudio();
    currentRef.current = idx;
    listenedRef.current = save.unreported;
    sessionListenedRef.current = save.unreported;
    lastTimeRef.current = save.pos;
    sampleAtRef.current = Date.now();
    lastProgressRef.current = save.pos;
    lastProgressAtRef.current = Date.now();
    stallAttemptsRef.current = 0;
    stallHintRef.current = false;
    setNowIdx(idx);
    setTrackClock({
      elapsed: save.pos,
      duration: save.dur || tr.durationSec || 0,
    });
    tapeRef.current?.markChange();
    updateMediaSession(idx);
    // The restored track's tape data rides the same lazy path as any
    // load; playback never waits on it.
    ensureFingerprint(tr.src);
    const seek = () => {
      try {
        audio.currentTime = save.pos;
      } catch {
        // Not seekable yet: the baselines already sit at the saved
        // position, so the sampler simply starts counting from
        // wherever the element can begin.
      }
      lastTimeRef.current = save.pos;
      audio.removeEventListener("loadedmetadata", seek);
    };
    audio.addEventListener("loadedmetadata", seek);
    audio.src = tr.src;
    setStarted(true);
    if (save.wasPlaying) {
      void audio.play().catch(() => undefined);
    }
    preloadIdxRef.current = -1;
    preloadNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Tape lifecycle -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const tape = new TapeRenderer();
    // The tape samples the current track's precomputed fingerprint at
    // the element's own position. No fingerprint yet (first-ever play,
    // still computing): null, and the tape draws its dark ground
    // columns until the data lands — playback is never held for it.
    tape.attach(canvas, () => {
      const audio = audioRef.current;
      const idx = currentRef.current;
      if (!audio || idx < 0) return null;
      const tr = CATALOG[idx];
      if (!tr) return null;
      const fp = getFingerprint(tr.src);
      if (!fp) {
        ensureFingerprint(tr.src);
        return null;
      }
      sampleFingerprint(fp, audio.currentTime, tapeColumnRef.current);
      return tapeColumnRef.current;
    });
    tapeRef.current = tape;
    const onResize = () => tape.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      tape.destroy();
      tapeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The tape runs white till play: mirror the audio element's own
  // play/pause state (the same isPlaying the ON AIR indicator reads,
  // set from the element's play/pause events in ensureAudio).
  useEffect(() => {
    tapeRef.current?.setPlaying(isPlaying);
  }, [isPlaying]);

  // --- Song page intents ---------------------------------------------------------
  // PLAY on a song page: a signed-in listener starts the song at once,
  // down the same engine path Recent Plays rows use. A guest is routed
  // through the claim flow with the song held as an intent, and the
  // song starts the moment the claim lands (handleClaimed, below).
  const playSongPage = useCallback(() => {
    if (songIdx < 0) return;
    if (identityRef.current) {
      void playCatalogIndex(songIdx);
    } else {
      songIntentRef.current = { idx: songIdx, play: true };
      setView("road");
    }
  }, [songIdx, playCatalogIndex]);

  // The song page's heart: signed in, the toggle itself; a guest is
  // routed through the claim flow and returned to the page.
  const heartSongPage = useCallback(() => {
    if (!songTrack) return;
    if (identityRef.current) {
      heartSong.toggle(
        { trackTitle: songTrack.title, project: songTrack.project },
        songHearted,
      );
    } else if (songIdx >= 0) {
      songIntentRef.current = { idx: songIdx, play: false };
      setView("road");
    }
  }, [songTrack, songIdx, heartSong, songHearted]);

  // --- Identity -----------------------------------------------------------------
  const handleClaimed = useCallback(
    (id: Identity) => {
      setIdentity(id);
      try {
        localStorage.setItem(ID_KEY, JSON.stringify(id));
      } catch {
        // Private mode: identity lives for this session only.
      }
      // Re-ask the road under the fresh token right away: the cached
      // road answer belongs to the old session (a stale ok:false would
      // otherwise linger up to the refetch interval and read as "still
      // signed out" seconds after a successful sign-in).
      void queryClient.invalidateQueries({ queryKey: ["road"] });
      // A song page sent this guest here with a song in hand: honor
      // the intent now that the name has landed — start the song, or
      // return to its page when the errand was the heart.
      const intent = songIntentRef.current;
      if (intent) {
        songIntentRef.current = null;
        if (intent.play) {
          void playCatalogIndex(intent.idx);
        } else {
          setSongIdx(intent.idx);
          setView("song");
        }
      }
    },
    [queryClient, playCatalogIndex],
  );

  const handleSignOut = useCallback(async () => {
    const id = identityRef.current;
    if (id) {
      try {
        await api.signOut({ token: id.token });
      } catch {
        // Local sign-out stands regardless.
      }
    }
    setIdentity(null);
    try {
      localStorage.removeItem(ID_KEY);
    } catch {
      // Nothing to remove.
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const progressPct =
    trackClock.duration > 0
      ? Math.min(100, (trackClock.elapsed / trackClock.duration) * 100)
      : 0;

  return (
    <div
      className={`min-h-screen bg-[var(--bg)] text-[var(--text)] ${roomMode && view === "player" ? "room-mode" : ""}`}
      onPointerDown={pokeActivity}
    >
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      {/* Masthead — an NES container title bar: the site's own frame */}
      <header className="px-4 pt-4">
        <div className="nes-container with-title px-4 py-3">
          <p className="title font-pixel text-[11px]">ZONE 00</p>
          <div className="flex items-stretch justify-between gap-3">
            <div>
              <p className="font-pixel text-[20px] leading-relaxed sm:text-[24px]">
                CHARLES HAMILTON
              </p>
              <p className="font-data mt-2 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                ZONE 00 · the endless player
              </p>
            </div>
            <div className="chrome flex shrink-0 items-center gap-2">
              {isPlaying ? (
                <>
                  <span
                    aria-hidden
                    className="inline-block h-[12px] w-[12px] bg-[var(--accent)]"
                  />
                  <span className="font-pixel text-[11px]">ON AIR</span>
                </>
              ) : (
                <span className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                  {started ? "Paused" : "Not started"}
                </span>
              )}
            </div>
          </div>
          {birthdayToday && (
            <div className="mt-3 flex items-center gap-3 border-t border-[var(--border)] pt-3">
              <SkullBow />
              <div className="min-w-0">
                <p
                  className="font-pixel text-[18px] leading-relaxed"
                  style={{ color: "var(--accent)" }}
                >
                  Happy Birthday Charles!
                </p>
                {heartsToday.data?.ok && (
                  <p className="font-data mt-1 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                    <span aria-hidden style={{ color: "var(--accent)" }}>
                      ♥
                    </span>{" "}
                    {heartsToday.data.count} hearts sent to Charles today
                  </p>
                )}
              </div>
              <div className="ml-auto">
                <BirthdayCake />
              </div>
            </div>
          )}
        </div>
      </header>

      <main>
        {/* ============================ PLAYER ============================ */}
        <section
          aria-label="Player"
          className={view === "player" ? "" : "hidden"}
        >
          {/* THE TAPE */}
          <div className="relative mt-4 overflow-hidden border-y-4 border-[var(--border)]">
            <canvas
              ref={canvasRef}
              aria-label="The Tape: a living spectrogram tapestry of the music as it plays"
              className="block h-[34vh] w-full"
            />
            {/* Session/score overlay: bounded on BOTH sides and clipped
                to the panel, so at phone width the text wraps and the
                score numerals shrink inside the box instead of crowding
                or clipping at the panel's right edge. */}
            <div className="chrome pointer-events-none absolute left-3 right-3 top-3 overflow-hidden text-right">
              <p className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                Session
              </p>
              <p className="font-pixel mt-1 text-[20px] leading-none">
                {fmtTime(sessionClock.elapsed)}
              </p>
              <p className="font-data mt-1 break-words text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                {sessionClock.finishes} finished · {fmtPts2(sessionClock.banked)} pts
                banked
              </p>
              <p className="font-data mt-2 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                {identity ? "Your live score" : "Live points"}
              </p>
              <p
                aria-label={`Live score: ${fmtPts2(sessionClock.livePoints)} points this session, ticking up as you listen`}
                className="font-pixel mt-1 max-w-full truncate text-[20px] leading-none text-[var(--accent)] sm:text-[24px]"
              >
                {fmtPts2(sessionClock.livePoints)}
              </p>
            </div>
            {!started && (
              <button
                type="button"
                onClick={startPlayback}
                aria-label="Play: start ZONE 00"
                className="absolute inset-0 flex w-full items-center justify-center bg-[var(--bg)]/85"
              >
                <span className="nes-btn is-pink px-8 py-6 text-center">
                  <span className="font-pixel block text-[36px] leading-none sm:text-[54px]">
                    PLAY
                  </span>
                  <span className="font-data mt-3 block text-[11px] uppercase tracking-[0.12em]">
                    One tap. Then it never ends.
                  </span>
                </span>
              </button>
            )}
          </div>

          {/* Now playing — the title is the one break: it runs poster-wide */}
          <div className="border-b border-[var(--border)] px-4 pb-4 pt-4">
            <p className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
              {nowTrack ? `Now playing · ${nowTrack.project}` : "Now playing"}
            </p>
            <div className="mt-3 flex items-start justify-between gap-3">
              <h1 className="font-pixel break-words text-[30px] leading-[1.15] sm:text-[54px]">
                {nowTrack ? nowTrack.title.toUpperCase() : "—"}
              </h1>
              {identity && nowTrack && (
                <HeartButton
                  size="now"
                  hearted={heartNow.display(nowHearted, {
                    trackTitle: nowTrack.title,
                    project: nowTrack.project,
                  })}
                  savedHearted={nowHearted}
                  pending={heartNow.isPending({
                    trackTitle: nowTrack.title,
                    project: nowTrack.project,
                  })}
                  label={
                    heartNow.display(nowHearted, {
                      trackTitle: nowTrack.title,
                      project: nowTrack.project,
                    })
                      ? `Unheart ${nowTrack.title}`
                      : `Heart ${nowTrack.title}`
                  }
                  onToggle={() =>
                    heartNow.toggle(
                      {
                        trackTitle: nowTrack.title,
                        project: nowTrack.project,
                      },
                      nowHearted,
                    )
                  }
                />
              )}
            </div>
            {/* Progress: a hard-edged block bar, no knob */}
            <div
              className="mt-4 h-[12px] w-full border border-[var(--border)]"
              role="progressbar"
              aria-label="Track progress"
              aria-valuemin={0}
              aria-valuemax={Math.round(trackClock.duration)}
              aria-valuenow={Math.round(trackClock.elapsed)}
            >
              <div
                className="h-full bg-[var(--text)]"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="font-data mt-2 flex justify-between text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
              <span>{fmtTime(trackClock.elapsed)}</span>
              <span>{fmtTime(trackClock.duration)}</span>
            </div>
            {nowTrack && (
              <p className="mt-3">
                <a
                  href={songPath(nowIdx)}
                  onClick={(e) => {
                    e.preventDefault();
                    openSong(nowIdx);
                  }}
                  className="font-data text-[11px] uppercase tracking-[0.12em] underline underline-offset-4"
                >
                  This song&rsquo;s page →
                </a>
              </p>
            )}
            {started && (
              <div className="mt-4 flex items-baseline justify-between border-t border-[var(--border)] pt-3">
                <p className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                  {identity
                    ? "Your score — live this session"
                    : "Points ticking — claim a name to bank them"}
                </p>
                <p className="font-pixel text-[20px] leading-none">
                  {fmtPts2(sessionClock.livePoints)}
                  <span className="font-data ml-2 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                    pts
                  </span>
                </p>
              </div>
            )}
            {lastAward && (
              <p className="font-pixel mt-3 inline-block bg-[var(--accent)] px-2 py-1 text-[11px] text-[var(--on-accent)]">
                {lastAward}
              </p>
            )}
          </div>

          {/* Transport — the site's button family: yellow, purple, pink, green */}
          <div className="chrome grid grid-cols-4 gap-3 px-4 py-4">
            <button
              type="button"
              aria-label="Previous track"
              onClick={() => void goPrevious()}
              disabled={!started || !hasPrev}
              className="nes-btn is-yellow min-h-[56px] px-2 py-2 text-left disabled:opacity-40"
            >
              <span className="font-pixel text-[16px]">|◀</span>
              <span className="font-data block text-[11px] uppercase tracking-[0.12em]">
                Previous
              </span>
            </button>
            <button
              type="button"
              aria-label="Back: restart this track"
              onClick={() => void restartTrack()}
              disabled={!started}
              className="nes-btn is-purple min-h-[56px] px-2 py-2 text-left disabled:opacity-40"
            >
              <span className="font-pixel text-[16px]">|◀◀</span>
              <span className="font-data block text-[11px] uppercase tracking-[0.12em]">
                Restart
              </span>
            </button>
            <button
              type="button"
              aria-label={isPlaying ? "Pause" : "Play"}
              onClick={started ? togglePlay : startPlayback}
              className="nes-btn is-pink min-h-[56px] px-2 py-2 text-left"
            >
              <span className="font-pixel text-[16px]">
                {isPlaying ? "❚❚" : "▶"}
              </span>
              <span className="font-data block text-[11px] uppercase tracking-[0.12em]">
                {isPlaying ? "Pause" : "Play"}
              </span>
            </button>
            <button
              type="button"
              aria-label="Next track"
              onClick={() => void advance(false)}
              disabled={!started}
              className="nes-btn is-green min-h-[56px] px-2 py-2 text-left disabled:opacity-40"
            >
              <span className="font-pixel text-[16px]">▶▶|</span>
              <span className="font-data block text-[11px] uppercase tracking-[0.12em]">
                Next
              </span>
            </button>
          </div>

          <div className="chrome px-4 py-4">
            {identity ? (
              <p className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                Listening as{" "}
                <span className="text-[var(--text)]">
                  {identity.name} <TripCode code={identity.code} />
                  {identity.bugHunter && <BugGlyph />}
                </span>{" "}
                —{" "}
                {sessionStale ? (
                  <>
                    session's out.{" "}
                    <button
                      type="button"
                      onClick={() => setView("road")}
                      className="text-[var(--text)] underline underline-offset-4"
                    >
                      Sign back in →
                    </button>
                  </>
                ) : (
                  "every finish reports to the board."
                )}
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setView("road")}
                className="font-data text-left text-[11px] uppercase tracking-[0.12em] underline underline-offset-4"
              >
                Listening as a guest — claim a name so your plays count →
              </button>
            )}
            <p className="font-data mt-3 text-[11px] uppercase leading-relaxed tracking-[0.12em] text-[var(--dim)]">
              Shuffled with no repeats until the whole catalog has played.
              Score comes from the audio clock — it keeps counting with the
              screen off.
            </p>
          </div>
        </section>

        {/* =========================== STANDINGS =========================== */}
        {view === "standings" && (
          <Standings
            identity={identity}
            onClaim={() => setView("road")}
            onPlayTrack={playRecent}
          />
        )}

        {/* ============================= MY ROAD ============================= */}
        {view === "road" &&
          (identity && !sessionStale ? (
            <MyRoad
              identity={identity}
              onSignOut={() => void handleSignOut()}
              onPlayTrack={playRecent}
            />
          ) : (
            <ClaimPanel
              onClaimed={handleClaimed}
              welcomeBackName={identity?.name}
            />
          ))}

        {/* ============================ SONG PAGE ============================ */}
        {view === "song" && (
          <SongPage
            track={songTrack}
            guest={!identity}
            hearted={heartSong.display(songHearted, {
              trackTitle: songTrack?.title ?? "",
              project: songTrack?.project ?? "",
            })}
            savedHearted={songHearted}
            heartPending={
              !!songTrack &&
              heartSong.isPending({
                trackTitle: songTrack.title,
                project: songTrack.project,
              })
            }
            onHeart={heartSongPage}
            onPlay={playSongPage}
            onBack={() => setView("player")}
          />
        )}

        {/* ============================ ADMIN PANEL ============================ */}
        {view === "backroom" &&
          (identity ? (
            <BackRoom identity={identity} />
          ) : (
            <ClaimPanel onClaimed={handleClaimed} />
          ))}
      </main>

      {/* Front nav — a ruled strip pinned to the bottom; the live view
          wears the site's lead pink */}
      <nav
        aria-label="Views"
        className="chrome sticky bottom-0 grid grid-cols-3 border-t-4 border-[var(--border)] bg-[var(--bg)]"
      >
        {(
          [
            ["player", "ZONE 00"],
            ["standings", "STANDINGS"],
            ["road", "MY ROAD"],
          ] as [View, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-label={`View: ${label}`}
            aria-current={view === v ? "page" : undefined}
            onClick={() => setView(v)}
            className={`min-h-[52px] px-2 ${
              view === v
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--text)]"
            } ${v !== "road" ? "border-r border-[var(--border)]" : ""}`}
          >
            <span className="font-pixel text-[11px]">{label}</span>
          </button>
        ))}
      </nav>

      <footer className="flex items-center justify-between px-4 py-3">
        <p className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">
          The Listeners · a board for people who stay
        </p>
        <button
          type="button"
          aria-label="Open the admin panel: the track board"
          onClick={() => setView("backroom")}
          className="font-data px-2 py-2 text-[11px] uppercase tracking-[0.12em] text-[var(--accent)] underline underline-offset-4"
        >
          Admin panel
        </button>
      </footer>
      <p className="font-data px-4 pb-4 text-[11px] uppercase leading-relaxed tracking-[0.12em] text-[var(--dim)]">
        If the player crashes, it reports the crash anonymously so we can
        fix it. Your listening stays yours.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// STANDINGS — the brag board. #1 crowned at poster scale; the giant rank
// numeral is this view's one deliberate grid break.
// ---------------------------------------------------------------------------

function Standings({
  identity,
  onClaim,
  onPlayTrack,
}: {
  identity: Identity | null;
  onClaim: () => void;
  onPlayTrack: (trackTitle: string, project: string) => void;
}) {
  const board = useQuery({
    queryKey: ["board"],
    queryFn: () => api.getBoard({}),
    refetchInterval: 30000,
  });
  const love = useQuery({
    queryKey: ["love-board"],
    queryFn: () => api.getLoveBoard({}),
    refetchInterval: 30000,
  });

  if (board.isPending) {
    return (
      <section aria-label="Standings" className="px-4 py-10">
        <p className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
          Reading the board…
        </p>
      </section>
    );
  }
  if (board.error || !board.data) {
    return (
      <section aria-label="Standings" className="px-4 py-10">
        <p className="text-base">The board won't read right now.</p>
        <button
          type="button"
          onClick={() => void board.refetch()}
          className="font-data mt-3 text-[11px] uppercase tracking-[0.12em] underline underline-offset-4"
        >
          Try again
        </button>
      </section>
    );
  }

  const data: BoardData = board.data;
  const top = data.listeners[0];
  const rest = data.listeners.slice(1);

  return (
    <section aria-label="Standings">
      <div className="px-4 pt-4">
        <div className="nes-container with-title px-4 py-3">
          <h2 className="title column-title font-pixel text-[11px]">
            STANDINGS
          </h2>
          <p className="font-data text-[11px] uppercase leading-relaxed tracking-[0.12em] text-[var(--dim)]">
            Ranked by listening score · 1 pt a minute, counted fractionally
            second by second · +10 a finish · +25 a first listen in a week ·
            scored time capped at 8 hours a day
          </p>
        </div>
      </div>

      {data.listeners.length === 0 ? (
        <div className="px-4 py-8">
          <p className="font-pixel text-[20px] leading-relaxed">
            THE BOARD IS EMPTY.
          </p>
          <p className="mt-3 max-w-[60ch] text-base leading-relaxed">
            No names claimed, no plays logged. The first listener to claim a
            name and let a track finish stands at № 1 alone.
          </p>
          <div aria-hidden className="mt-6">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className="flex items-baseline gap-4 border-b border-dashed border-[var(--dim)] py-3"
              >
                <span className="font-pixel text-[20px] text-[var(--dim)]">
                  {n}
                </span>
                <span className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                  — not yet claimed
                </span>
              </div>
            ))}
          </div>
          {!identity && (
            <button
              type="button"
              onClick={onClaim}
              className="nes-btn is-pink font-pixel mt-8 px-5 py-4 text-[16px]"
            >
              CLAIM YOUR NAME
            </button>
          )}
        </div>
      ) : (
        <>
          {/* № 1 — poster scale, in the site's container frame */}
          {top && (
            <div className="px-4 pt-4">
              <div className="nes-container with-title relative px-5 pb-5 pt-4">
                <p className="title font-pixel text-[11px]">THE CROWN</p>
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden"
                >
                  <span className="font-pixel absolute -top-4 right-2 text-[121px] leading-none text-[var(--accent)] opacity-25">
                    1
                  </span>
                </span>
                <p className="mt-3 break-words text-[24px] font-semibold leading-relaxed">
                  {top.name}{" "}
                  <span className="font-data text-[16px] text-[var(--dim)]">
                    <TripCode code={top.code} />
                  </span>
                  {top.bugHunter && <BugGlyph />}
                  <PresenceDot lastActiveMs={top.lastActiveMs} />
                </p>
                <p className="font-pixel mt-3 text-[54px] leading-[1.2] text-[var(--accent)]">
                  {fmtPts1(top.score)}
                </p>
                <p className="font-data mt-2 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                  {top.minutes} minutes · {top.depth}{" "}
                  deep
                </p>
                {top.reignSinceMs > 0 && (
                  <p className="font-data mt-2 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                    Reigning{" "}
                    <span className="text-[var(--accent)]">
                      {fmtReign(Date.now() - top.reignSinceMs)}
                    </span>
                    {top.reigns > 1 && <> · reign № {top.reigns}</>}
                    {top.reigns > 1 && (
                      <> · {fmtReign(top.champMs)} as champ all time</>
                    )}
                  </p>
                )}
                <div className="mt-2">
                  <DayBars bars={top.dayBars} />
                </div>
              </div>
            </div>
          )}

          <ol className="mt-4">
            {rest.map((l) => {
              const mine = identity?.id === l.id;
              return (
                <li
                  key={l.id}
                  className="flex items-baseline gap-4 border-b border-[var(--border)] px-4 py-3"
                >
                  <span className="font-pixel w-[44px] shrink-0 text-[20px]">
                    {l.rank}
                  </span>
                  <span
                    aria-hidden
                    className={`h-[16px] w-[8px] shrink-0 self-center ${
                      mine ? "bg-[var(--accent)]" : "bg-transparent"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[16px] font-medium leading-snug">
                      {l.name}{" "}
                      <span className="font-data text-[11px] text-[var(--dim)]">
                        <TripCode code={l.code} />
                      </span>
                      {l.bugHunter && <BugGlyph />}
                      <PresenceDot lastActiveMs={l.lastActiveMs} />
                    </span>
                    <span className="font-data block text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                      {l.minutes} min
                      {l.champMs > 0 && <> · {fmtReign(l.champMs)} as champ</>}
                    </span>
                    <span className="mt-1 block">
                      <DayBars bars={l.dayBars} />
                    </span>
                  </span>
                  <span className="font-pixel shrink-0 text-[20px]">
                    {fmtPts1(l.score)}
                  </span>
                </li>
              );
            })}
          </ol>

          <p className="font-data px-4 py-4 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
            {data.totals.listeners} listeners · {data.totals.plays} plays ·{" "}
            {data.totals.minutes} minutes,
            all time
          </p>
        </>
      )}

      {love.data && (
        <MostLoved data={love.data} onPlayTrack={onPlayTrack} />
      )}
    </section>
  );
}

function MostLoved({
  data,
  onPlayTrack,
}: {
  data: LoveBoardData;
  onPlayTrack: (trackTitle: string, project: string) => void;
}) {
  const top = data.tracks[0];
  const rest = data.tracks.slice(1);
  const canPlay = (title: string, project: string) =>
    CATALOG.some((t) => t.title === title && t.project === project);

  return (
    <section aria-label="Most Loved" className="mt-6">
      <div className="px-4">
        <div className="nes-container with-title px-4 py-3">
          <h3 className="title column-title font-pixel text-[11px]">
            MOST LOVED
          </h3>
          <p className="font-data text-[11px] uppercase leading-relaxed tracking-[0.12em] text-[var(--dim)]">
            Ranked by hearts.
          </p>
        </div>
      </div>

      {data.tracks.length === 0 ? (
        <p className="px-4 py-8 text-base leading-relaxed">
          No hearts yet. Tap the heart on a song you love.
        </p>
      ) : (
        <>
          {top && (
            <div className="px-4 pt-4">
              <div className="nes-container with-title relative px-5 pb-5 pt-4">
                <p className="title font-pixel text-[11px]">№ 1</p>
                {canPlay(top.title, top.project) ? (
                  <button
                    type="button"
                    onClick={() => onPlayTrack(top.title, top.project)}
                    className="block w-full text-left"
                    aria-label={`Play ${top.title}`}
                  >
                    <span className="mt-3 block break-words text-[24px] font-semibold leading-relaxed">
                      {top.title}
                    </span>
                    <span className="font-data mt-1 block text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                      {top.project}
                      {top.durationSec > 0 && ` · ${fmtTime(top.durationSec)}`}
                    </span>
                    <span className="mt-3 flex items-center gap-3">
                      <HeartIcon size={32} />
                      <span className="font-pixel text-[36px] leading-none text-[var(--accent)]">
                        {top.hearts}
                      </span>
                    </span>
                  </button>
                ) : (
                  <>
                    <p className="mt-3 break-words text-[24px] font-semibold leading-relaxed">
                      {top.title}
                    </p>
                    <p className="font-data mt-1 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                      {top.project}
                      {top.durationSec > 0 && ` · ${fmtTime(top.durationSec)}`}
                    </p>
                    <p className="mt-3 flex items-center gap-3">
                      <HeartIcon size={32} />
                      <span className="font-pixel text-[36px] leading-none text-[var(--accent)]">
                        {top.hearts}
                      </span>
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          <ol className="mt-4">
            {rest.map((t) => {
              const playable = canPlay(t.title, t.project);
              const body = (
                <>
                  <span className="font-pixel w-[44px] shrink-0 text-[20px]">
                    {t.rank}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[16px] font-medium leading-snug">
                      {t.title}
                    </span>
                    <span className="font-data block text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                      {t.project}
                      {t.durationSec > 0 && ` · ${fmtTime(t.durationSec)}`}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <HeartIcon size={18} />
                    <span className="font-pixel text-[18px]">{t.hearts}</span>
                  </span>
                </>
              );
              return (
                <li
                  key={`${t.title}\u001f${t.project}`}
                  className="border-b border-[var(--border)] px-4 py-3"
                >
                  {playable ? (
                    <button
                      type="button"
                      onClick={() => onPlayTrack(t.title, t.project)}
                      className="flex w-full items-center gap-4 text-left"
                      aria-label={`Play ${t.title}`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex items-center gap-4">{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// SONG PAGE — one song's postcard: its name, its project, its hearts and
// plays, the heart itself at the center, and a PLAY that starts this
// song. Reached cold from a shared /s/<slug> address or in-app from the
// now-playing link. Guests meet the same page; PLAY and the heart route
// them through the claim flow (see the intents in App).
// ---------------------------------------------------------------------------

function SongPage({
  track,
  guest,
  hearted,
  savedHearted,
  heartPending,
  onHeart,
  onPlay,
  onBack,
}: {
  track: CatalogTrack | undefined;
  guest: boolean;
  hearted: boolean;
  savedHearted: boolean;
  heartPending: boolean;
  onHeart: () => void;
  onPlay: () => void;
  onBack: () => void;
}) {
  const stats = useQuery({
    queryKey: ["song-stats", track?.title, track?.project],
    queryFn: () =>
      api.getSongStats({
        trackTitle: track!.title,
        project: track!.project,
      }),
    enabled: !!track,
  });
  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused: the address bar still holds the link.
    }
  };

  return (
    <section aria-label="Song page" className="px-4 pt-4">
      <div className="nes-container with-title px-5 pb-6 pt-4">
        <p className="title font-pixel text-[11px]">POSTCARD</p>
        {track ? (
          <>
            <p className="font-data mt-2 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
              {track.project}
            </p>
            <h2 className="font-pixel mt-3 break-words text-[30px] leading-[1.15] sm:text-[44px]">
              {track.title.toUpperCase()}
            </h2>
            <div className="mt-6 flex justify-center">
              <HeartButton
                size="page"
                hearted={hearted}
                savedHearted={savedHearted}
                pending={heartPending}
                label={
                  hearted
                    ? `Unheart ${track.title}`
                    : `Heart ${track.title}`
                }
                onToggle={onHeart}
              />
            </div>
            {stats.data && (
              <p className="mt-4 flex items-center justify-center gap-5">
                <span className="flex items-center gap-2">
                  <HeartIcon size={18} />
                  <span className="font-pixel text-[18px]">
                    {stats.data.hearts}
                  </span>
                </span>
                <span className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                  {stats.data.plays}{" "}
                  {stats.data.plays === 1 ? "play" : "plays"}
                </span>
              </p>
            )}
            <button
              type="button"
              onClick={onPlay}
              className="nes-btn is-pink mt-6 min-h-[56px] w-full px-4 py-3 text-left"
            >
              <span className="font-pixel text-[20px]">▶ PLAY</span>
              <span className="font-data block text-[11px] uppercase tracking-[0.12em]">
                {track.title}
              </span>
            </button>
            {guest && (
              <p className="font-data mt-3 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                Claim a name so your plays count.
              </p>
            )}
            <div className="mt-6 flex items-center justify-between border-t border-[var(--border)] pt-4">
              <button
                type="button"
                onClick={onBack}
                className="font-data text-[11px] uppercase tracking-[0.12em] underline underline-offset-4"
              >
                ← The player
              </button>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="font-data text-[11px] uppercase tracking-[0.12em] underline underline-offset-4"
              >
                {copied ? "Link copied" : "Copy link"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-3 text-base leading-relaxed">
              That song is not in the catalog.
            </p>
            <p className="mt-4">
              <button
                type="button"
                onClick={onBack}
                className="font-data text-[11px] uppercase tracking-[0.12em] underline underline-offset-4"
              >
                ← The player
              </button>
            </p>
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// CLAIM PANEL — claim a name with a password, or sign back in.
// ---------------------------------------------------------------------------

function ClaimPanel({
  onClaimed,
  welcomeBackName,
}: {
  onClaimed: (id: Identity) => void;
  // Set when a stored identity's session went stale: the panel becomes
  // a sign-back-in, name prefilled. The password is never prefilled —
  // it is never stored anywhere.
  welcomeBackName?: string;
}) {
  const [name, setName] = useState(welcomeBackName ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const claim = useMutation({
    mutationFn: () => api.claimName({ name, password }),
    onSuccess: (res) => {
      if (res.ok && res.listener && res.token) {
        onClaimed({
          id: res.listener.id,
          name: res.listener.name,
          code: res.listener.code,
          bugHunter: res.listener.bugHunter,
          token: res.token,
        });
      } else {
        setError(res.error ?? "That didn't work. Try again.");
      }
    },
    onError: () => setError("The board won't answer right now. Try again."),
  });

  return (
    <section aria-label="Claim your name" className="px-4 py-6">
      <h2 className="column-title font-pixel text-[24px] leading-relaxed">
        {welcomeBackName ? "SIGN BACK IN" : "YOUR NAME"}
      </h2>
      {welcomeBackName ? (
        <p className="mt-3 max-w-[62ch] text-base leading-relaxed">
          Welcome back, {welcomeBackName}. Your session ended — one
          sign-in lives at a time, and this device's went stale. The name
          and everything on your road are still yours; your password
          brings this device back.
        </p>
      ) : (
        <p className="mt-3 max-w-[62ch] text-base leading-relaxed">
          Claim a name with a password and it's yours on the board, on any
          device. The server keeps only a scrambled hash of the password —
          never the password itself. Beside your name sits a public code,
          assigned at claim time, that says nothing about your password.
        </p>
      )}
      <div className="nes-balloon from-left mt-6 max-w-[420px]">
        <p className="font-pixel text-[11px] leading-relaxed">
          NO RESET EXISTS. LOSE THE PASSWORD, THE NAME IS GONE. NOBODY
          HOLDS IT FOR YOU.
        </p>
      </div>

      <form
        className="mt-8"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          claim.mutate();
        }}
      >
        <div className="nes-field">
          <label
            htmlFor="claim-name"
            className="font-data block text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]"
          >
            Name
          </label>
          <input
            id="claim-name"
            aria-label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="username"
            maxLength={24}
            className="nes-input is-dark mt-1 w-full text-[16px]"
          />
        </div>
        <div className="nes-field mt-6">
          <label
            htmlFor="claim-password"
            className="font-data block text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]"
          >
            {welcomeBackName
              ? "Password"
              : "Password — 10+ characters, one you don't use anywhere else"}
          </label>
          <input
            id="claim-password"
            aria-label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="nes-input is-dark mt-1 w-full text-[16px]"
          />
        </div>
        {error && (
          <p role="alert" className="nes-text is-error mt-4 text-[16px] leading-relaxed">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={claim.isPending || name.trim().length === 0}
          className="nes-btn is-pink font-pixel mt-8 min-h-[56px] w-full px-4 text-[16px] disabled:opacity-40"
        >
          {claim.isPending
            ? "WORKING…"
            : welcomeBackName
              ? "SIGN BACK IN"
              : "CLAIM / SIGN IN"}
        </button>
        <p className="font-data mt-3 text-[11px] uppercase leading-relaxed tracking-[0.12em] text-[var(--dim)]">
          {welcomeBackName
            ? "One live session at a time: signing in here signs out the other device."
            : "New name? This claims it. Already yours? The same password signs you back in — and signs out every other device."}
        </p>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// MY ROAD — where I'm going.
// ---------------------------------------------------------------------------

function MyRoad({
  identity,
  onSignOut,
  onPlayTrack,
}: {
  identity: Identity;
  onSignOut: () => void;
  onPlayTrack: (trackTitle: string, project: string) => void;
}) {
  const queryClient = useQueryClient();
  const road = useQuery({
    queryKey: ["road", identity.id],
    queryFn: () =>
      api.getMyRoad({
        token: identity.token,
        catalogSize: CATALOG.length,
        todayKey: localDayKey(new Date()),
      }),
    refetchInterval: 30000,
  });

  const del = useMutation({
    mutationFn: (playId: number) =>
      api.deletePlay({ token: identity.token, playId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["road"] });
      void queryClient.invalidateQueries({ queryKey: ["board"] });
      void queryClient.invalidateQueries({ queryKey: ["trackboard"] });
    },
  });

  const heart = useHeartToggle(() => identity.token);

  if (road.isPending) {
    return (
      <section aria-label="My road" className="px-4 py-10">
        <p className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
          Reading your road…
        </p>
      </section>
    );
  }
  const data: RoadData | undefined = road.data;
  if (road.error || !data?.ok) {
    return (
      <section aria-label="My road" className="px-4 py-10">
        <p className="text-base">
          {data?.error ??
            "Your session won't read. Sign out and back in with your password."}
        </p>
        <button
          type="button"
          onClick={onSignOut}
          className="font-data mt-3 text-[11px] uppercase tracking-[0.12em] underline underline-offset-4"
        >
          Sign out
        </button>
      </section>
    );
  }

  const capPct =
    data.dayCapSec > 0
      ? Math.min(100, (data.todayEligibleSec / data.dayCapSec) * 100)
      : 0;

  return (
    <section aria-label="My road">
      <div className="px-4 pt-4">
        <div className="nes-container with-title relative px-5 pb-5 pt-4">
          <p className="title font-pixel text-[11px]">YOUR RANK</p>
          {/* The watermark numeral bleeds off the top BY DESIGN, so it
              clips inside its own full-panel wrapper — the container
              itself stays unclipped, which keeps the straddling title
              and the rank numeral whole at phone width. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden"
          >
            <span className="font-pixel absolute -top-4 right-2 text-[121px] leading-none text-[var(--accent)] opacity-25">
              {data.rank ?? "—"}
            </span>
          </span>
          <p className="font-pixel mt-3 text-[54px] leading-[1.2]">
            № {data.rank ?? "—"}
          </p>
          <p className="mt-3 text-[16px] leading-relaxed">
            {identity.name}{" "}
            <span className="font-data text-[11px] text-[var(--dim)]">
              <TripCode code={identity.code} />
            </span>
            {(data.listener?.bugHunter ?? identity.bugHunter) && <BugGlyph />}
          </p>
          <p className="font-data mt-1 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
            {fmtPts2(data.score)} points · {data.minutes} minutes · {data.finishes}{" "}
            finishes · {data.depth} tracks deep
          </p>
          {data.gapAbove ? (
            <p className="mt-3 max-w-[55ch] text-[16px] leading-relaxed">
              <strong>{fmtPts2(data.gapAbove.points)} points</strong> behind{" "}
              {data.gapAbove.name}. That's the next name on your road.
            </p>
          ) : (
            <p className="mt-3 text-[16px] leading-relaxed">
              You're at the front. The road behind you is the only pressure.
            </p>
          )}
        </div>
      </div>

      {/* Today under the cap */}
      <div className="mt-4 border-b border-[var(--border)] px-4 py-4">
        <div className="flex items-baseline justify-between">
          <p className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
            Today, scored time
          </p>
          <p className="font-data text-[11px] uppercase tracking-[0.12em]">
            {fmtTime(data.todayEligibleSec)} / {fmtTime(data.dayCapSec)}
          </p>
        </div>
        <div className="mt-2 h-[12px] w-full border border-[var(--border)]">
          <div
            className="h-full bg-[var(--text)]"
            style={{ width: `${capPct}%` }}
          />
        </div>
        <p className="font-data mt-2 text-[11px] uppercase leading-relaxed tracking-[0.12em] text-[var(--dim)]">
          Past 8 hours in a day the music still plays and finishes still
          count on the track board — they just stop scoring. Nobody wins
          this board by leaving a tablet running in a closet.
        </p>
        <p className="font-data mt-3 text-[11px] uppercase tracking-[0.12em]">
          Streak: {data.streak.current} days now · {data.streak.longest} best
          ever · {data.streak.freezesUsed} freeze
          {data.streak.freezesUsed === 1 ? "" : "s"} used
        </p>
      </div>

      {/* Milestones */}
      <div className="border-b-2 border-[var(--border)]">
        {data.milestones.map((m) => {
          const pct =
            m.target > 0 ? Math.min(100, (m.current / m.target) * 100) : 0;
          const shown =
            m.unit === "sec"
              ? `${fmtTime(m.current)} / ${fmtTime(m.target)}`
              : `${m.current} / ${m.target} ${m.unit}`;
          return (
            <div
              key={m.label}
              className="border-b border-[var(--border)] px-4 py-3 last:border-b-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                  {m.label}
                </p>
                <p className="font-data shrink-0 text-[11px] uppercase tracking-[0.12em]">
                  {shown}
                </p>
              </div>
              <div className="mt-2 h-[8px] w-full border border-[var(--border)]">
                <div
                  className="h-full bg-[var(--text)]"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent plays */}
      <div className="px-4 py-4">
        <h3 className="column-title font-pixel text-[20px] leading-relaxed">
          RECENT PLAYS
        </h3>
        {data.recentPlays.length === 0 ? (
          <p className="mt-3 text-base leading-relaxed">
            Nothing logged yet. Press play, let a track ride to the end, and
            it lands here.
          </p>
        ) : (
          <ul>
            {data.recentPlays.map((p) => (
              <li
                key={p.id}
                className="flex items-baseline gap-3 border-b border-[var(--border)] py-3"
              >
                {/* The row IS the replay door: tap the song, it plays
                    again. Remove is a sibling button, never nested, so
                    removing a play can't start one. */}
                <button
                  type="button"
                  onClick={() => onPlayTrack(p.trackTitle, p.project)}
                  aria-label={`Play ${p.trackTitle} again`}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block break-words text-[16px] font-medium leading-snug">
                    <span aria-hidden className="mr-2 text-[var(--accent)]">
                      ▶
                    </span>
                    {p.trackTitle}
                  </span>
                  <span className="font-data block text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                    {fmtTime(p.listenedSec)} of {fmtTime(p.durationSec)} ·{" "}
                    {p.finished ? "finished" : "partial"} · +{fmtPts2(p.points)} pts ·{" "}
                    {new Date(p.playedAt).toLocaleDateString()}
                  </span>
                </button>
                <HeartButton
                  size="row"
                  hearted={heart.display(p.hearted, {
                    trackTitle: p.trackTitle,
                    project: p.project,
                  })}
                  savedHearted={p.hearted}
                  pending={heart.isPending({
                    trackTitle: p.trackTitle,
                    project: p.project,
                  })}
                  label={
                    heart.display(p.hearted, {
                      trackTitle: p.trackTitle,
                      project: p.project,
                    })
                      ? `Unheart ${p.trackTitle}`
                      : `Heart ${p.trackTitle}`
                  }
                  onToggle={() =>
                    heart.toggle(
                      { trackTitle: p.trackTitle, project: p.project },
                      p.hearted,
                    )
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove the play of ${p.trackTitle} from ${new Date(p.playedAt).toLocaleDateString()}`}
                  onClick={() => del.mutate(p.id)}
                  disabled={del.isPending}
                  className="font-data shrink-0 px-2 py-2 text-[11px] uppercase tracking-[0.12em] underline underline-offset-4 disabled:opacity-40"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* Your hearts — the shelf of hearted songs, playable in place */}
        <h3 className="column-title font-pixel mt-8 text-[20px] leading-relaxed">
          YOUR HEARTS
        </h3>
        {data.favorites.length === 0 ? (
          <p className="mt-3 text-base leading-relaxed">
            Nothing hearted yet.
          </p>
        ) : (
          <ul>
            {data.favorites.map((f) => (
              <li
                key={`${f.trackTitle}::${f.project}`}
                className="flex items-baseline gap-3 border-b border-[var(--border)] py-3"
              >
                <button
                  type="button"
                  onClick={() => onPlayTrack(f.trackTitle, f.project)}
                  aria-label={`Play ${f.trackTitle}`}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block break-words text-[16px] font-medium leading-snug">
                    <span aria-hidden className="mr-2 text-[var(--accent)]">
                      ▶
                    </span>
                    {f.trackTitle}
                  </span>
                  <span className="font-data block text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                    {f.project} · hearted{" "}
                    {new Date(f.heartedAt).toLocaleDateString()}
                  </span>
                </button>
                <HeartButton
                  size="row"
                  hearted={heart.display(true, {
                    trackTitle: f.trackTitle,
                    project: f.project,
                  })}
                  savedHearted={true}
                  pending={heart.isPending({
                    trackTitle: f.trackTitle,
                    project: f.project,
                  })}
                  label={
                    heart.display(true, {
                      trackTitle: f.trackTitle,
                      project: f.project,
                    })
                      ? `Unheart ${f.trackTitle}`
                      : `Heart ${f.trackTitle}`
                  }
                  onToggle={() =>
                    heart.toggle(
                      { trackTitle: f.trackTitle, project: f.project },
                      true,
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={onSignOut}
          className="font-data mt-6 px-2 py-2 text-[11px] uppercase tracking-[0.12em] underline underline-offset-4"
        >
          Sign out of {identity.name}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// OPERATOR TOOLS — house tools rendered only inside the admin panel's
// allowed branch. The server still gates every action itself.
// ---------------------------------------------------------------------------

function OperatorTools({ identity }: { identity: Identity }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("iM3HGWtXra");
  const [grant, setGrant] = useState(true);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const board = useQuery({
    queryKey: ["board"],
    queryFn: () => api.getBoard({}),
  });
  const hunters =
    board.data?.listeners.filter((listener) => listener.bugHunter) ?? [];

  const setBug = useMutation({
    mutationFn: () =>
      api.setBugHunter({ token: identity.token, code: code.trim(), on: grant }),
    onSuccess: (res) => {
      if (res.ok && res.listener) {
        setResult({
          ok: true,
          text: grant
            ? `${res.listener} wears the bug now.`
            : `${res.listener}'s bug is off.`,
        });
        void queryClient.invalidateQueries({ queryKey: ["board"] });
        void queryClient.invalidateQueries({ queryKey: ["trackboard"] });
      } else {
        setResult({
          ok: false,
          text: res.error ?? "That didn't work. Try again.",
        });
      }
    },
    onError: () =>
      setResult({
        ok: false,
        text: "The board won't answer right now. Try again.",
      }),
  });

  return (
    <div className="px-4 pb-8 pt-4">
      <div className="nes-container px-4 py-4">
        <h3 className="column-title font-pixel text-[20px] leading-relaxed">
          House tools
        </h3>
        <p className="font-data mt-4 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
          Bug hunters
        </p>
        {board.isPending ? (
          <p className="font-data mt-2 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
            Reading the board…
          </p>
        ) : board.error || !board.data ? (
          <p className="mt-2 text-base leading-relaxed">
            The board won't read right now.
          </p>
        ) : hunters.length === 0 ? (
          <p className="mt-2 text-base leading-relaxed">
            No bugs handed out yet.
          </p>
        ) : (
          <ul className="mt-2">
            {hunters.map((hunter) => (
              <li
                key={hunter.id}
                className="flex min-h-[44px] flex-wrap items-center gap-x-2 py-1 text-[16px]"
              >
                <span className="font-medium">{hunter.name}</span>
                <BugGlyph />
                <span className="font-data text-[11px] text-[var(--dim)]">
                  <TripCode code={hunter.code} />
                </span>
              </li>
            ))}
          </ul>
        )}

        <form
          className="mt-6"
          onSubmit={(e) => {
            e.preventDefault();
            setResult(null);
            setBug.mutate();
          }}
        >
          <div className="nes-field">
            <label
              htmlFor="operator-bug-code"
              className="font-data block text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]"
            >
              Listener !code
            </label>
            <input
              id="operator-bug-code"
              aria-label="Listener !code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              className="nes-input is-dark mt-1 min-h-[48px] w-full text-[16px]"
            />
          </div>
          <div
            className="mt-5 grid grid-cols-2 gap-2"
            role="group"
            aria-label="Bug grant choice"
          >
            <button
              type="button"
              aria-pressed={grant}
              onClick={() => setGrant(true)}
              className={`font-pixel min-h-[44px] px-3 text-[11px] ${
                grant
                  ? "bg-[var(--accent)] text-[var(--on-accent)]"
                  : "border border-[var(--border)] text-[var(--text)]"
              }`}
            >
              Grant
            </button>
            <button
              type="button"
              aria-pressed={!grant}
              onClick={() => setGrant(false)}
              className={`font-pixel min-h-[44px] px-3 text-[11px] ${
                !grant
                  ? "bg-[var(--accent)] text-[var(--on-accent)]"
                  : "border border-[var(--border)] text-[var(--text)]"
              }`}
            >
              Remove
            </button>
          </div>
          <button
            type="submit"
            disabled={setBug.isPending || code.trim().length === 0}
            className="nes-btn is-pink font-pixel mt-5 min-h-[48px] w-full px-4 text-[14px] disabled:opacity-40"
          >
            {setBug.isPending
              ? "Working…"
              : grant
                ? "Hand out the bug"
                : "Take the bug back"}
          </button>
          {result && (
            <p
              role={result.ok ? "status" : "alert"}
              className={`mt-4 text-[15px] leading-relaxed ${
                result.ok ? "text-[#4ade80]" : "text-[#f87171]"
              }`}
            >
              {result.text}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE ADMIN PANEL — the songs board. Operators' view, behind the footer
// affordance, never in the front nav.
// ---------------------------------------------------------------------------

// Crash reports: the flight recorder's anonymous death reports.
// Machine facts only, filed by the player itself when a session dies
// without a clean close. Operators' eyes only, same door as the rest
// of this room; reports are never used to identify anyone.
function CrashReports({ identity }: { identity: Identity }) {
  const reports = useQuery({
    queryKey: ["crashreports", identity.id],
    queryFn: () => api.getCrashReports({ token: identity.token }),
    refetchInterval: 60000,
  });
  if (!reports.data?.allowed) return null;
  const data = reports.data;
  return (
    <div className="px-4 pt-4">
      <div className="nes-container with-title px-4 py-3">
        <h3 className="title column-title font-pixel text-[11px]">
          CRASH REPORTS
        </h3>
        <p className="font-data max-w-[68ch] text-[11px] uppercase leading-relaxed tracking-[0.12em] text-[var(--dim)]">
          Anonymous death reports the player files itself when a session
          dies without a clean close. Machine facts only. Gone after 30
          days. {data.total} on file.
        </p>
        {data.reports.length > 0 && (
          <ol className="mt-3">
            {data.reports.slice(0, 8).map((r) => (
              <li
                key={r.id}
                className="font-data border-t border-[var(--border)] py-2 text-[11px] uppercase leading-relaxed tracking-[0.12em]"
              >
                {new Date(r.receivedAt).toLocaleString()} · {r.uaFamily} ·{" "}
                {r.eventCount} events · last: {r.lastEvent}
                {r.lastTrack
                  ? ` · ${r.lastTrack} at ${fmtTime(r.lastCt)} of ${fmtTime(r.lastDur)}`
                  : ""}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function BackRoom({ identity }: { identity: Identity }) {
  const board = useQuery({
    queryKey: ["trackboard", identity.id],
    queryFn: () => api.getTrackBoard({ token: identity.token }),
    refetchInterval: 30000,
  });

  if (board.isPending) {
    return (
      <section aria-label="The admin panel: track board" className="px-4 py-10">
        <p className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
          Reading the track board…
        </p>
      </section>
    );
  }
  if (board.error || !board.data) {
    return (
      <section aria-label="The admin panel: track board" className="px-4 py-10">
        <p className="text-base">The track board won't read right now.</p>
        <button
          type="button"
          onClick={() => void board.refetch()}
          className="font-data mt-3 text-[11px] uppercase tracking-[0.12em] underline underline-offset-4"
        >
          Try again
        </button>
      </section>
    );
  }

  const data: TrackBoardData = board.data;
  if (!data.allowed) {
    return (
      <section aria-label="The admin panel: track board" className="px-4 py-10">
        <h2 className="column-title font-pixel text-[24px] leading-relaxed">
          ADMIN PANEL
        </h2>
        <p className="mt-3 text-base leading-relaxed">
          The admin panel is for the operators.
        </p>
      </section>
    );
  }
  const crowned = data.tracks.find((t) => t.crowned && t.rank === 1);

  return (
    <section aria-label="The admin panel: track board">
      <div className="px-4 pt-4">
        <div className="nes-container with-title px-4 py-3">
          <h2 className="title column-title font-pixel text-[11px]">
            ADMIN PANEL
          </h2>
          <p className="font-data max-w-[68ch] text-[11px] uppercase leading-relaxed tracking-[0.12em] text-[var(--dim)]">
            Tracks ranked by share of plays finished, shrunk toward the mean
            (Wilson) so two lucky plays can't crown a track. A track needs 10
            starts to rank. Start = played over 5s · Finish = reached 90% or
            the natural end · Skip = bailed before 30s. Duration prints beside
            every % — short tracks finish easier, and the board says so.
          </p>
          <p className="font-data mt-3 max-w-[68ch] text-[11px] uppercase leading-relaxed tracking-[0.12em] text-[var(--dim)]">
            What gets skipped stays in this room.
          </p>
        </div>
      </div>

      <OperatorTools identity={identity} />

      <CrashReports identity={identity} />

      {data.tracks.length === 0 ? (
        <div className="px-4 py-8">
          <p className="font-pixel text-[20px] leading-relaxed">
            NO PLAYS LOGGED.
          </p>
          <p className="mt-3 max-w-[60ch] text-base leading-relaxed">
            The songs board fills in as listeners play. Nothing here is
            seeded — every start below will be a real one.
          </p>
        </div>
      ) : (
        <>
          {crowned && (
            <div className="px-4 pt-4">
              <div className="nes-container with-title px-4 py-4">
                <p className="title font-pixel text-[11px]">
                  № 1 · {crowned.band} BAND
                </p>
                <p className="mt-2 break-words text-[24px] font-semibold leading-relaxed">
                  {crowned.title}
                </p>
                <p className="font-pixel mt-2 text-[81px] leading-none text-[var(--accent-yellow)]">
                  {crowned.pct}%
                </p>
                <p className="font-data mt-1 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                of {crowned.starts} starts finished · runs{" "}
                {fmtTime(crowned.durationSec)}
                </p>
              </div>
            </div>
          )}
          <ol className="mt-4">
            {data.tracks.map((t) => (
              <li
                key={t.title}
                className="border-b border-[var(--border)] px-4 py-3"
              >
                <div className="flex items-baseline gap-4">
                  <span className="font-pixel w-[44px] shrink-0 text-[20px]">
                    {t.rank ?? "—"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[16px] font-medium leading-snug">
                      {t.title}
                      {t.crowned && (
                        <span className="font-data ml-2 bg-[var(--accent)] px-1 text-[11px] uppercase tracking-[0.12em] text-[var(--on-accent)]">
                          {t.band} crown
                        </span>
                      )}
                    </span>
                    <span className="font-data block text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                      {t.project} · {fmtTime(t.durationSec)} · {t.starts}{" "}
                      starts · {t.finishes} finishes · {t.skips} skips
                      {t.rank === null &&
                        ` · needs ${Math.max(0, 10 - t.starts)} more starts to rank`}
                    </span>
                  </span>
                  <span className="font-pixel shrink-0 text-[20px]">
                    {t.rank === null ? "—" : `${t.pct}%`}
                  </span>
                </div>
                {t.rank !== null && (
                  <div className="ml-[60px] mt-2 h-[8px] border border-[var(--border)]">
                    <div
                      className="h-full bg-[var(--text)]"
                      style={{ width: `${t.pct}%` }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ol>
          <p className="font-data px-4 py-4 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
            {data.totals.tracks} tracks touched · {data.totals.starts} starts
            counted
          </p>
        </>
      )}
    </section>
  );
}
