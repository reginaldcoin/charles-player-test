// ============================================================================
// FLIGHT RECORDER — anonymous crash reports (2026-11-11, the playback
// program). The player keeps a small ring of its own vital signs on the
// device: the last ~150 playback events, written synchronously to
// localStorage so the record survives even a renderer kill. If a
// session ends WITHOUT a clean close (no pagehide goodbye — the OS
// reaped the page in the dark), the next boot files the death report
// by itself: no listener action, no listener effort.
//
// ANONYMITY AT COLLECTION is the design rule, not a side effect: the
// report carries machine facts only — a coarse user-agent family, the
// event ring, where the playhead died, how much audio was buffered.
// No name, no !code, no token, nothing that ties it to a listener is
// ever put in the payload. Operators hold play records elsewhere and
// could correlate timestamps if they chose; the house rule is that
// these reports are read as machine evidence and never used to
// identify anyone. Reports auto-expire server-side after 30 days.
//
// The clean-close signal: pagehide is the goodbye. A session whose
// ring ends in a pagehide event closed cleanly; a session whose ring
// just stops — last event a heartbeat, a waiting, a playing — died.
// ============================================================================

export type FlightEvent = {
  /** Wall-clock ms when the event was written. */
  t: number;
  /** Monotonic ms (performance.now) — the delta against wall time
   *  across two events exposes freezes and suspensions. */
  m: number;
  e: string;
  vis?: string;
  /** Track key (title) at the time, empty when none is loaded. */
  track?: string;
  ct?: number;
  dur?: number;
  /** Seconds of audio buffered ahead of the playhead. */
  buf?: number;
  rs?: number;
  ns?: number;
  paused?: boolean;
  /** Watchdog ladder stage, for watchdog events. */
  stage?: number;
  /** For gap events: the wall-clock ms since the previous supervisor
   *  tick — the size of the hole a suspension tore in the record. */
  gapMs?: number;
  /** Navigation type / wasDiscarded / persisted pageshow flag. */
  note?: string;
}

export type FlightSnap = {
  track: string;
  ct: number;
  dur: number;
  buf: number;
  rs: number;
  ns: number;
  paused: boolean;
}

export type DeathReport = {
  uaFamily: string;
  diedAt: number;
  events: FlightEvent[];
}

const RING_KEY = "chp.flight.v1";
const RING_MAX = 150;
const HEARTBEAT_MS = 15000;

let ring: FlightEvent[] = [];
let lastHeartbeatAt = 0;
let booted = false;

function persist(): void {
  try {
    localStorage.setItem(RING_KEY, JSON.stringify(ring));
  } catch {
    // Storage full or private mode: the recorder degrades silently.
  }
}

function loadRing(): FlightEvent[] {
  try {
    const raw = localStorage.getItem(RING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FlightEvent[];
    return Array.isArray(parsed) ? parsed.slice(-RING_MAX) : [];
  } catch {
    return [];
  }
}

/** Coarse device/browser family from the UA string. Deliberately
 *  coarse: enough to aim a fix ("Android Chrome"), never a fingerprint. */
export function uaFamily(ua: string): string {
  const android = /Android/.test(ua);
  const ios = /iPhone|iPad|iPod/.test(ua);
  const samsung = /SamsungBrowser/.test(ua);
  const chrome = /CriOS/.test(ua) || (/Chrome\//.test(ua) && !samsung);
  const firefox = /FxiOS/.test(ua) || /Firefox\//.test(ua);
  const safari = /Safari\//.test(ua) && !chrome && !firefox && !samsung;
  const browser = samsung
    ? "Samsung Internet"
    : firefox
      ? "Firefox"
      : chrome
        ? "Chrome"
        : safari
          ? "Safari"
          : "Other browser";
  const device = android ? "Android" : ios ? "iOS" : "Desktop";
  return `${device} ${browser}`;
}

export function recEvent(
  e: string,
  snap?: Partial<FlightSnap> & { stage?: number; note?: string; gapMs?: number },
): void {
  const ev: FlightEvent = {
    t: Date.now(),
    m: Math.round(performance.now()),
    e,
    vis: typeof document !== "undefined" ? document.visibilityState : undefined,
  };
  if (snap) {
    if (snap.track !== undefined) ev.track = snap.track;
    if (snap.ct !== undefined) ev.ct = Math.round(snap.ct * 10) / 10;
    if (snap.dur !== undefined) ev.dur = Math.round(snap.dur * 10) / 10;
    if (snap.buf !== undefined) ev.buf = Math.round(snap.buf * 10) / 10;
    if (snap.rs !== undefined) ev.rs = snap.rs;
    if (snap.ns !== undefined) ev.ns = snap.ns;
    if (snap.paused !== undefined) ev.paused = snap.paused;
    if (snap.stage !== undefined) ev.stage = snap.stage;
    if (snap.gapMs !== undefined) ev.gapMs = snap.gapMs;
    if (snap.note !== undefined) ev.note = snap.note;
  }
  ring.push(ev);
  if (ring.length > RING_MAX) ring = ring.slice(-RING_MAX);
  persist();
}

/** 15s heartbeat, throttled here so callers can offer every tick. */
export function recHeartbeat(snap: FlightSnap): void {
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_MS) return;
  lastHeartbeatAt = now;
  recEvent("heartbeat", snap);
}

// GAP EVENTS (2026-11-13, the wake-side fix). The supervisor ticks on
// a timer, and a suspended page stops ticking entirely — the freeze
// that killed the session leaves no trace in the ring, because the
// ring only hears from the ticks that ran. So every tick now reports
// its own spacing: when the wall-clock delta since the previous tick
// exceeds the threshold, the tick writes a gap event carrying the
// delta before doing anything else. A suspension leaves testimony
// even when the session survives it and no death report ever files.
const GAP_THRESHOLD_MS = 2000;
let lastTickAt = 0;

/** Observe a supervisor tick. Returns the ms since the previous
 *  tick (0 on the first observation). Callers: the 250ms interval,
 *  and the wake path (so a return records its gap immediately,
 *  before the interval's next beat — the re-stamp here means that
 *  beat then sees a small delta and writes nothing twice). */
export function recTickGap(snap?: Partial<FlightSnap>): number {
  const now = Date.now();
  const prev = lastTickAt;
  lastTickAt = now;
  if (prev <= 0) return 0;
  const delta = now - prev;
  if (delta > GAP_THRESHOLD_MS) {
    recEvent("gap", { ...snap, gapMs: delta });
  }
  return delta;
}

/**
 * Judge the previous session and start this one. Returns the death
 * report to file when the previous session died dirty (its ring does
 * not end in a pagehide goodbye), or null when it closed clean or
 * never existed. Either way the ring restarts for the new session,
 * with a boot event noting how this page arrived and where the
 * previous session's playhead stopped.
 */
export function recBoot(): DeathReport | null {
  if (booted) return null;
  booted = true;
  const prev = loadRing();
  let death: DeathReport | null = null;
  let prevNote = "no previous session";
  if (prev.length > 0) {
    const last = prev[prev.length - 1] as FlightEvent;
    prevNote = `prev last: ${last.e} ct=${last.ct ?? "?"} dur=${last.dur ?? "?"}`;
    if (last.e !== "pagehide") {
      death = {
        uaFamily: uaFamily(navigator.userAgent),
        diedAt: last.t,
        events: prev,
      };
    }
  }
  ring = [];
  let navType = "unknown";
  let discarded = false;
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav?.type) navType = nav.type;
    discarded =
      (document as unknown as { wasDiscarded?: boolean }).wasDiscarded ===
      true;
  } catch {
    // Navigation timing is garnish for the boot event.
  }
  recEvent("boot", {
    note: `${navType}${discarded ? " discarded" : ""}; ${prevNote}`,
  });
  return death;
}

/** The goodbye. Called from the pagehide handler: a ring ending in
 *  this event is a clean close, never a death report. */
export function recGoodbye(snap: FlightSnap): void {
  recEvent("pagehide", snap);
}
