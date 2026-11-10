import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import { ARTIST, CATALOG } from "./catalog";
import { TapeRenderer } from "./tape";

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

/** A listener's public !code, in classic tripcode green. */
function TripCode({ code }: { code: string }) {
  return <span className="trip">!{code}</span>;
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

type View = "player" | "standings" | "road" | "backroom";

type BoardData = ApiResponse<typeof api, "getBoard">;
type RoadData = ApiResponse<typeof api, "getMyRoad">;
type TrackBoardData = ApiResponse<typeof api, "getTrackBoard">;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("player");
  const [identity, setIdentity] = useState<Identity | null>(loadIdentity);
  const [roomMode, setRoomMode] = useState(false);

  const identityRef = useRef(identity);
  identityRef.current = identity;

  // --- Player state ---------------------------------------------------------
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<{
    ctx: AudioContext;
    analyser: AnalyserNode;
  } | null>(null);
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
  const failStreakRef = useRef(0);
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
  const heartNow = useMutation({
    mutationFn: (args: { trackTitle: string; project: string }) =>
      api.toggleFavorite({ token: identityRef.current!.token, ...args }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["road"] });
    },
  });
  const nowHearted =
    !!nowTrack &&
    !!roadLite.data?.favorites.some(
      (f) => f.trackTitle === nowTrack.title && f.project === nowTrack.project,
    );

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
      listenedRef.current = 0;
      lastTimeRef.current = 0;
      lastProgressRef.current = 0;
      lastProgressAtRef.current = Date.now();
      stallAttemptsRef.current = 0;
      stallHintRef.current = false;
      setNowIdx(idx);
      setTrackClock({ elapsed: 0, duration: tr.durationSec ?? 0 });
      tapeRef.current?.markChange();
      updateMediaSession(idx);
      audio.src = tr.src;
      if (autoplay) {
        audio.play().catch(() => handleTrackError());
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateMediaSession],
  );

  const advance = useCallback(
    async (natural: boolean) => {
      await reportPlay(natural);
      failStreakRef.current = 0;
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
    window.setTimeout(() => {
      void reportPlay(false).then(() => loadTrack(pickNext(), true));
    }, 1200);
  }, [reportPlay, pickNext, loadTrack]);

  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.addEventListener("ended", () => {
      void advance(true);
    });
    audio.addEventListener("error", () => {
      if (currentRef.current >= 0) handleTrackError();
    });
    audio.addEventListener("play", () => setIsPlaying(true));
    audio.addEventListener("pause", () => setIsPlaying(false));
    audio.addEventListener("playing", () => {
      // Real motion again: the watchdog stands down for this track.
      stallAttemptsRef.current = 0;
      stallHintRef.current = false;
      lastProgressAtRef.current = Date.now();
    });
    const onStallHint = () => {
      stallHintRef.current = true;
    };
    audio.addEventListener("stalled", onStallHint);
    audio.addEventListener("waiting", onStallHint);
    audioRef.current = audio;
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.setActionHandler("play", () => {
          void audio.play().catch(() => undefined);
        });
        navigator.mediaSession.setActionHandler("pause", () => audio.pause());
        navigator.mediaSession.setActionHandler("nexttrack", () => {
          void advance(false);
        });
        navigator.mediaSession.setActionHandler("previoustrack", () => {
          void goPrevious();
        });
      }
    } catch {
      // Handlers are best-effort.
    }
    return audio;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advance, handleTrackError]);

  const restartTrack = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || currentRef.current < 0) return;
    await reportPlay(false);
    listenedRef.current = 0;
    lastTimeRef.current = 0;
    audio.currentTime = 0;
    tapeRef.current?.markChange();
    await audio.play().catch(() => undefined);
  }, [reportPlay]);

  // AudioContext + analyser are born inside a user gesture, or the
  // tape runs silent-frozen. Shared by the first PLAY tap and by
  // playing a track straight from Recent Plays.
  const ensureAnalysis = useCallback((audio: HTMLAudioElement) => {
    try {
      if (!audioCtxRef.current) {
        const AC =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (AC) {
          const ctx = new AC();
          const source = ctx.createMediaElementSource(audio);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0.82;
          source.connect(analyser);
          analyser.connect(ctx.destination);
          audioCtxRef.current = { ctx, analyser };
        }
      }
      if (audioCtxRef.current?.ctx.state === "suspended") {
        void audioCtxRef.current.ctx.resume();
      }
    } catch {
      // No analysis available: playback continues, tape draws silence.
    }
  }, []);

  const startPlayback = useCallback(() => {
    const audio = ensureAudio();
    ensureAnalysis(audio);
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
  }, [ensureAudio, ensureAnalysis, loadTrack, pickNext, requestWakeLock]);

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
      const audio = ensureAudio();
      ensureAnalysis(audio);
      setStarted(true);
      void requestWakeLock();
      bagRef.current = bagRef.current.filter((i) => i !== idx);
      if (currentRef.current >= 0) {
        await reportPlay(false);
      }
      failStreakRef.current = 0;
      loadTrack(idx, true);
    },
    [
      ensureAudio,
      ensureAnalysis,
      loadTrack,
      reportPlay,
      requestWakeLock,
      restartTrack,
    ],
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
        const ct = audio.currentTime;
        const d = ct - lastTimeRef.current;
        if (d > 0 && d < 2) {
          listenedRef.current += d;
          sessionListenedRef.current += d;
        }
        lastTimeRef.current = ct;
        // Stall watchdog: the track should be moving. If the position
        // has not advanced for seconds while the element says it lacks
        // data, the stream has wedged — re-open it at the last known
        // position. Three tries per track, then the error path takes
        // it. A user pause never reaches here (paused branch above).
        if (ct > lastProgressRef.current + 0.05) {
          lastProgressRef.current = ct;
          lastProgressAtRef.current = Date.now();
          stallHintRef.current = false;
        } else if (
          currentRef.current >= 0 &&
          audio.readyState < 3 &&
          Date.now() - lastProgressAtRef.current >
            (stallHintRef.current ? 3000 : 6000)
        ) {
          lastProgressAtRef.current = Date.now();
          if (stallAttemptsRef.current >= 3) {
            stallAttemptsRef.current = 0;
            handleTrackError();
          } else {
            stallAttemptsRef.current += 1;
            const tr = CATALOG[currentRef.current];
            if (tr) {
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
              audio.src = tr.src;
              void audio.play().catch(() => undefined);
            }
          }
        }
      } else {
        lastTimeRef.current = audio.currentTime;
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
  }, [started, nowTrack]);

  // Flush the in-progress play if the page goes away mid-track.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && listenedRef.current >= 5) {
        void reportPlay(false);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [reportPlay]);

  // --- Tape lifecycle -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const tape = new TapeRenderer();
    tape.attach(canvas, () => audioCtxRef.current?.analyser ?? null);
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

  // --- Identity -----------------------------------------------------------------
  const handleClaimed = useCallback((id: Identity) => {
    setIdentity(id);
    try {
      localStorage.setItem(ID_KEY, JSON.stringify(id));
    } catch {
      // Private mode: identity lives for this session only.
    }
  }, []);

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
                <button
                  type="button"
                  aria-label={
                    nowHearted
                      ? `Unheart ${nowTrack.title}`
                      : `Heart ${nowTrack.title}`
                  }
                  aria-pressed={nowHearted}
                  onClick={() =>
                    heartNow.mutate({
                      trackTitle: nowTrack.title,
                      project: nowTrack.project,
                    })
                  }
                  disabled={heartNow.isPending}
                  className="shrink-0 px-2 py-1 text-[28px] leading-none disabled:opacity-40"
                  style={nowHearted ? { color: "var(--accent)" } : undefined}
                >
                  {nowHearted ? "♥" : "♡"}
                </button>
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
                </span>{" "}
                — every finish reports to the board.
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
          <Standings identity={identity} onClaim={() => setView("road")} />
        )}

        {/* ============================= MY ROAD ============================= */}
        {view === "road" &&
          (identity ? (
            <MyRoad
              identity={identity}
              onSignOut={() => void handleSignOut()}
              onPlayTrack={playRecent}
            />
          ) : (
            <ClaimPanel onClaimed={handleClaimed} />
          ))}

        {/* ============================ BACK ROOM ============================ */}
        {view === "backroom" && <BackRoom />}
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
          aria-label="Open the back room: the track board"
          onClick={() => setView("backroom")}
          className="font-data px-2 py-2 text-[11px] uppercase tracking-[0.12em] text-[var(--accent)] underline underline-offset-4"
        >
          Back room
        </button>
      </footer>
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
}: {
  identity: Identity | null;
  onClaim: () => void;
}) {
  const board = useQuery({
    queryKey: ["board"],
    queryFn: () => api.getBoard({}),
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
                </p>
                <p className="font-pixel mt-3 text-[54px] leading-[1.2] text-[var(--accent)]">
                  {fmtPts1(top.score)}
                </p>
                <p className="font-data mt-2 text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                  {top.minutes} minutes · {top.finishes} finishes · {top.depth}{" "}
                  deep
                </p>
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
                    </span>
                    <span className="font-data block text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
                      {l.minutes} min · {l.finishes} fin · {l.depth} deep
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
            {data.totals.minutes} minutes · {data.totals.finishes} finishes,
            all time
          </p>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// CLAIM PANEL — claim a name with a password, or sign back in.
// ---------------------------------------------------------------------------

function ClaimPanel({
  onClaimed,
}: {
  onClaimed: (id: Identity) => void;
}) {
  const [name, setName] = useState("");
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
        YOUR NAME
      </h2>
      <p className="mt-3 max-w-[62ch] text-base leading-relaxed">
        Claim a name with a password and it's yours on the board, on any
        device. The server keeps only a scrambled hash of the password —
        never the password itself. Beside your name sits a public code,
        assigned at claim time, that says nothing about your password.
      </p>
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
            Password — 10+ characters, one you don't use anywhere else
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
          {claim.isPending ? "WORKING…" : "CLAIM / SIGN IN"}
        </button>
        <p className="font-data mt-3 text-[11px] uppercase leading-relaxed tracking-[0.12em] text-[var(--dim)]">
          New name? This claims it. Already yours? The same password signs
          you back in — and signs out every other device.
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

  const heart = useMutation({
    mutationFn: (args: { trackTitle: string; project: string }) =>
      api.toggleFavorite({ token: identity.token, ...args }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["road"] });
    },
  });

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
                <button
                  type="button"
                  aria-label={
                    p.hearted
                      ? `Unheart ${p.trackTitle}`
                      : `Heart ${p.trackTitle}`
                  }
                  aria-pressed={p.hearted}
                  onClick={() =>
                    heart.mutate({
                      trackTitle: p.trackTitle,
                      project: p.project,
                    })
                  }
                  disabled={heart.isPending}
                  className="shrink-0 px-2 py-2 text-[18px] leading-none disabled:opacity-40"
                  style={p.hearted ? { color: "var(--accent)" } : undefined}
                >
                  {p.hearted ? "♥" : "♡"}
                </button>
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
                <button
                  type="button"
                  aria-label={`Unheart ${f.trackTitle}`}
                  aria-pressed={true}
                  onClick={() =>
                    heart.mutate({
                      trackTitle: f.trackTitle,
                      project: f.project,
                    })
                  }
                  disabled={heart.isPending}
                  className="shrink-0 px-2 py-2 text-[18px] leading-none disabled:opacity-40"
                  style={{ color: "var(--accent)" }}
                >
                  ♥
                </button>
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
// THE BACK ROOM — the songs board. Operators' view, behind the footer
// affordance, never in the front nav.
// ---------------------------------------------------------------------------

function BackRoom() {
  const board = useQuery({
    queryKey: ["trackboard"],
    queryFn: () => api.getTrackBoard({}),
    refetchInterval: 30000,
  });

  if (board.isPending) {
    return (
      <section aria-label="The back room: track board" className="px-4 py-10">
        <p className="font-data text-[11px] uppercase tracking-[0.12em] text-[var(--dim)]">
          Reading the track board…
        </p>
      </section>
    );
  }
  if (board.error || !board.data) {
    return (
      <section aria-label="The back room: track board" className="px-4 py-10">
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
  const crowned = data.tracks.find((t) => t.crowned && t.rank === 1);

  return (
    <section aria-label="The back room: track board">
      <div className="px-4 pt-4">
        <div className="nes-container with-title px-4 py-3">
          <h2 className="title column-title font-pixel text-[11px]">
            BACK ROOM
          </h2>
          <p className="font-data max-w-[68ch] text-[11px] uppercase leading-relaxed tracking-[0.12em] text-[var(--dim)]">
            Tracks ranked by share of plays finished, shrunk toward the mean
            (Wilson) so two lucky plays can't crown a track. A track needs 10
            starts to rank. Start = played over 5s · Finish = reached 90% or
            the natural end · Skip = bailed before 30s. Duration prints beside
            every % — short tracks finish easier, and the board says so.
          </p>
        </div>
      </div>

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
