// THE LISTENERS — server actions for the Charles Hamilton Player.
//
// Integration surface (per listeners-board-wiring-spec-2026-11-07.md):
//   claimName / logPlay / getBoard / getMyRoad / getTrackBoard / deletePlay
//   plus toggleFavorite (hearts; personal only, never scored)
// plus signOut for session hygiene.
//
// Identity: tripcode-style. A name is claimed WITH a password; the server
// stores only a slow-KDF verification hash (Argon2id via Bun.password
// where the runtime offers it, scrypt otherwise — never a fast hash).
// The public !code beside a name is a RANDOM string assigned at claim
// time. First-seen binding: a claimed name rejects any mismatched
// credential. NO PASSWORD RESET EXISTS, by design. Session tokens are
// random; only their SHA-256 hash is stored; signing in rotates them.
//
// Score (owner's pick, 2026-11-08 — the research formula):
//   1 pt per score-eligible minute + 10 per finish (>=90% or natural end)
//   + 25 first-listen-of-a-track-this-week + 50 at 60 min in one session
//   + 150 per 3 finishes in a row + 300 per catalog-depth threshold
//   (25/50/75/100%). No multiplier. Score-eligible time is capped at
//   8 hours per listener per day; past the cap plays still log and count
//   toward track completion stats but earn no score.
//
// Anti-cheat is plausibility, not identity: listened > duration is
// rejected, and claiming is bounded per reporting window — a play may
// run ahead of the wall clock since the listener's previous play ended
// by at most a bounded allowance (300s, refilling 1:1 with real time);
// overlap past that is clamped, and a claim with nothing creditable is
// rejected. Every accepted play credits its listened minutes to the
// listener's totals and earns minute points on its eligible seconds,
// repeat listens included.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { Privileged } from "@space/privileged";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import * as schema from "./schema";

type Db = ReturnType<Ctx["db"]>;

const DAY_CAP_SEC = 8 * 60 * 60; // 28,800 score-eligible seconds per day
// Reporting-window allowance for the plausibility clamp: a listener may
// claim up to this many seconds of listening beyond the wall-clock time
// elapsed since their previous play ended. It refills 1:1 with real
// time, so honest plays reported a little early (or batched by the
// client) credit in full, while a sustained burst of instant full-track
// claims exhausts it and gets clamped.
const WINDOW_CREDIT_MAX_SEC = 300;
const SESSION_BONUS_SEC = 60 * 60;
const STREAK_DAY_MIN_SEC = 10 * 60; // a streak day needs >=10 credited minutes
const MAX_FREEZES = 2;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// The back room is the operators' room. Codes are public identity —
// they print beside every name on the board — so the key is not the
// code itself but whose session asks: only these two listeners' own
// sessions open the track board; every other caller gets a closed door.
const OPERATOR_CODES = ["ld.LS3qH5c", "4ACX6Obxg/"];

// ---------------------------------------------------------------------------
// Password hashing — slow KDF only, executed host-side via the privileged
// contract (Argon2id; see server/src/privileged.ts). Action code never
// touches a password hash function itself.
// ---------------------------------------------------------------------------

async function hashPassword(
  ctx: Ctx,
  password: string,
): Promise<{ hash: string; algo: string }> {
  return ctx.executePrivileged(Privileged.hashPassword, { password });
}

async function verifyPassword(
  ctx: Ctx,
  password: string,
  stored: string,
  algo: string,
): Promise<boolean> {
  const res = await ctx.executePrivileged(Privileged.verifyPassword, {
    password,
    stored,
    algo,
  });
  return res.ok;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const CODE_ALPHABET =
  "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBytesBase64Url(count: number): string {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomCode(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) {
    out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return out;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isoWeekKey(d: Date): string {
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const week =
    1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 864e5));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Round to hundredths — fractional points are kept clean of FP dust. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayMs(key: string): number {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function keyFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Forgiving streaks: a day qualifies at >=10 credited minutes. Walking a
 * run, a missed day consumes one of at most 2 automatic freezes and the
 * run continues; the run never hard-resets history — longest is forever.
 */
function computeStreaks(
  qualified: Set<string>,
  todayKey: string,
): { current: number; longest: number; freezesUsed: number } {
  if (qualified.size === 0) return { current: 0, longest: 0, freezesUsed: 0 };
  const sorted = [...qualified].sort();
  const earliest = sorted[0] ?? todayKey;

  // Longest run, chronological.
  let longest = 0;
  {
    let run = 0;
    let freezes = 0;
    let prev = "";
    for (const key of sorted) {
      if (prev === "") {
        run = 1;
      } else {
        const gapDays = Math.round((dayMs(key) - dayMs(prev)) / 864e5) - 1;
        if (gapDays === 0) {
          run += 1;
        } else if (gapDays <= MAX_FREEZES - freezes) {
          run += gapDays + 1;
          freezes += gapDays;
        } else {
          run = 1;
          freezes = 0;
        }
      }
      prev = key;
      if (run > longest) longest = run;
    }
  }

  // Current run, walking back from today (or yesterday if today hasn't
  // qualified yet — the day isn't over, the streak is still alive).
  let current = 0;
  let freezesUsed = 0;
  {
    let cursor = qualified.has(todayKey)
      ? todayKey
      : keyFromMs(dayMs(todayKey) - 864e5);
    let freezes = 0;
    while (dayMs(cursor) >= dayMs(earliest)) {
      if (qualified.has(cursor)) {
        current += 1;
      } else if (freezes < MAX_FREEZES && current > 0) {
        freezes += 1;
        current += 1; // freeze day holds the streak
      } else {
        break;
      }
      cursor = keyFromMs(dayMs(cursor) - 864e5);
    }
    freezesUsed = freezes;
  }
  return { current, longest, freezesUsed };
}

function wilsonLower(finishes: number, starts: number): number {
  if (starts <= 0) return 0;
  const z = 1.96;
  const p = finishes / starts;
  const n = starts;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

function lengthBand(durationSec: number): string {
  if (durationSec < 180) return "UNDER 3:00";
  if (durationSec <= 300) return "3:00–5:00";
  return "OVER 5:00";
}

// ---------------------------------------------------------------------------
// Session + state plumbing
// ---------------------------------------------------------------------------

async function resolveListener(db: Db, token: string) {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const rows = await db
    .select({
      listenerId: schema.sessions.listenerId,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.tokenHash, tokenHash))
    .limit(1);
  const session = rows[0];
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  const found = await db
    .select()
    .from(schema.listeners)
    .where(eq(schema.listeners.id, session.listenerId))
    .limit(1);
  return found[0] ?? null;
}

async function issueSession(db: Db, listenerId: number): Promise<string> {
  // Rotate: every previous token for this listener dies.
  await db
    .delete(schema.sessions)
    .where(eq(schema.sessions.listenerId, listenerId));
  const token = randomBytesBase64Url(32);
  await db.insert(schema.sessions).values({
    listenerId,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

type ListenerState = typeof schema.listenerState.$inferSelect;

async function ensureState(db: Db, listenerId: number): Promise<ListenerState> {
  const rows = await db
    .select()
    .from(schema.listenerState)
    .where(eq(schema.listenerState.listenerId, listenerId))
    .limit(1);
  if (rows[0]) return rows[0];
  await db.insert(schema.listenerState).values({ listenerId });
  const created = await db
    .select()
    .from(schema.listenerState)
    .where(eq(schema.listenerState.listenerId, listenerId))
    .limit(1);
  const row = created[0];
  if (!row) throw new Error("listener_state insert failed");
  return row;
}

async function listenerAggregates(db: Db, listenerId: number) {
  const rows = await db
    .select({
      creditedSec: sql<number>`coalesce(sum(${schema.plays.creditedSec}), 0)`,
      finishes: sql<number>`coalesce(sum(case when ${schema.plays.finished} = 1 then 1 else 0 end), 0)`,
      depth: sql<number>`count(distinct case when ${schema.plays.finished} = 1 then ${schema.plays.trackTitle} || char(31) || ${schema.plays.project} end)`,
      plays: sql<number>`count(*)`,
    })
    .from(schema.plays)
    .where(eq(schema.plays.listenerId, listenerId));
  const row = rows[0];
  return {
    creditedSec: row?.creditedSec ?? 0,
    finishes: row?.finishes ?? 0,
    depth: row?.depth ?? 0,
    plays: row?.plays ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------------

const listenerPublic = z.object({
  id: z.number(),
  name: z.string(),
  code: z.string(),
});

const claimResponse = z.object({
  ok: z.boolean(),
  created: z.boolean(),
  error: z.string().nullable(),
  listener: listenerPublic.nullable(),
  token: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// recomputeListenerTotals — the nerf engine (owner's order, 2026-11-09).
// Replays one listener's stored plays in arrival order under the PATCHED
// rules and rewrites every derived number: per-play points/finished flags,
// listener_state, and the per-day eligible totals. Rules replayed:
//   - a finish counts only when CREDITED seconds reach 90% of the track
//   - the +25 first-listen (per title+project, per week) needs credited
//     >= min(30s, half the track)
//   - depth thresholds key on distinct finished title+project pairs
//   - minute points, the 8h/day cap, the +50 session bonus and the +150
//     every-third-finish streak follow the same arithmetic as logPlay
// What it does NOT touch: listeners (name/password/!code) and the stored
// claimed/credited seconds themselves — the listening record stays what
// it was; only what it PAYS changes.
async function recomputeListenerTotals(
  db: Db,
  listenerId: number,
  catalogSize: number,
) {
  const plays = await db
    .select()
    .from(schema.plays)
    .where(eq(schema.plays.listenerId, listenerId))
    .orderBy(asc(schema.plays.id));

  const dayEligible = new Map<string, number>();
  const seenWeekTrack = new Set<string>();
  const finishedPairs = new Set<string>();
  let eligibleTotal = 0;
  let minutePoints = 0;
  let score = 0;
  let sessionId = "";
  let sessionSec = 0;
  let sessionBonus = 0;
  let finishStreak = 0;
  let longestStreak = 0;
  let depthMask = 0;
  let lastPlayEndMs = 0;

  for (const p of plays) {
    const usedToday = dayEligible.get(p.dayKey) ?? 0;
    const eligible = Math.min(
      p.creditedSec,
      Math.max(0, DAY_CAP_SEC - usedToday),
    );
    dayEligible.set(p.dayKey, usedToday + eligible);
    const live = eligible > 0;
    const finished = p.creditedSec >= 0.9 * p.durationSec ? 1 : 0;

    const newTotal = eligibleTotal + eligible;
    const newMinutePoints = round2(newTotal / 60);
    const minuteDelta = round2(newMinutePoints - minutePoints);
    eligibleTotal = newTotal;
    minutePoints = newMinutePoints;

    let pts = minuteDelta;
    if (live && finished === 1) pts += 10;

    const pairKey = p.trackTitle + "\u001f" + p.project;
    if (p.sessionId !== sessionId) {
      sessionId = p.sessionId;
      sessionSec = 0;
      sessionBonus = 0;
    }
    sessionSec += eligible;
    if (live && sessionBonus === 0 && sessionSec >= SESSION_BONUS_SEC) {
      pts += 50;
      sessionBonus = 1;
    }

    if (finished === 1) {
      finishStreak += 1;
      longestStreak = Math.max(longestStreak, finishStreak);
      if (live && finishStreak % 3 === 0) pts += 150;
    } else {
      finishStreak = 0;
    }

    if (live && finished === 1 && !finishedPairs.has(pairKey)) {
      const distinct = finishedPairs.size + 1;
      [0.25, 0.5, 0.75, 1].forEach((t, i) => {
        const bit = 1 << i;
        if (distinct >= Math.ceil(t * catalogSize) && (depthMask & bit) === 0) {
          pts += 300;
          depthMask |= bit;
        }
      });
    }
    if (finished === 1) finishedPairs.add(pairKey);

    const weekTrackKey = p.weekKey + "\u001f" + pairKey;
    if (
      live &&
      !seenWeekTrack.has(weekTrackKey) &&
      p.creditedSec >= Math.min(30, 0.5 * p.durationSec)
    ) {
      pts += 25;
    }
    seenWeekTrack.add(weekTrackKey);

    pts = round2(pts);
    score = round2(score + pts);
    lastPlayEndMs = Math.max(lastPlayEndMs, p.playedAt.getTime());
    if (pts !== p.points || finished !== p.finished) {
      await db
        .update(schema.plays)
        .set({ points: pts, finished })
        .where(eq(schema.plays.id, p.id));
    }
  }

  await db
    .update(schema.listenerState)
    .set({
      score,
      eligibleSecTotal: eligibleTotal,
      minutePoints,
      sessionId,
      sessionSec,
      sessionBonus,
      finishStreak,
      longestStreak,
      depthMask,
      lastPlayEndMs,
    })
    .where(eq(schema.listenerState.listenerId, listenerId));

  for (const [dayKey, eligibleSec] of dayEligible) {
    await db
      .update(schema.listenerDays)
      .set({ eligibleSec })
      .where(
        and(
          eq(schema.listenerDays.listenerId, listenerId),
          eq(schema.listenerDays.dayKey, dayKey),
        ),
      );
  }
  return { score, plays: plays.length };
}

export const Actions = {
  claimName: defineAction({
    description:
      "Claims a listener name with a password, or signs back in if the name is already claimed and the password matches. No password reset exists.",
    request: z.object({
      name: z.string().min(1).max(40),
      password: z.string().min(1).max(200),
    }),
    response: claimResponse,
    privileged: [Privileged.hashPassword, Privileged.verifyPassword],
    async handler(ctx, args): Promise<z.infer<typeof claimResponse>> {
      const db = ctx.db<typeof schema>();
      const name = args.name.trim().replace(/\s+/g, " ");
      if (name.length < 1 || name.length > 24) {
        return {
          ok: false,
          created: false,
          error: "Names run 1 to 24 characters.",
          listener: null,
          token: null,
        };
      }
      const nameKey = name.toLowerCase();
      const existing = await db
        .select()
        .from(schema.listeners)
        .where(eq(schema.listeners.nameKey, nameKey))
        .limit(1);
      const found = existing[0];

      if (found) {
        // First-seen binding: the name belongs to the first credential.
        const okPw = await verifyPassword(
          ctx,
          args.password,
          found.pwHash,
          found.pwAlgo,
        );
        if (!okPw) {
          return {
            ok: false,
            created: false,
            error: `That name is already claimed, and that password doesn't open it. A name stays bound to the first password it was claimed with — there is no reset. If it's yours, use the password you claimed it with; if it isn't, pick another name.`,
            listener: null,
            token: null,
          };
        }
        const token = await issueSession(db, found.id);
        return {
          ok: true,
          created: false,
          error: null,
          listener: { id: found.id, name: found.name, code: found.code },
          token,
        };
      }

      if (args.password.length < 10) {
        return {
          ok: false,
          created: false,
          error:
            "Use a password of at least 10 characters — a short phrase works. There is no reset and nobody holds it for you, so make it one you'll keep.",
          listener: null,
          token: null,
        };
      }
      const { hash, algo } = await hashPassword(ctx, args.password);
      const code = randomCode();
      const inserted = await db
        .insert(schema.listeners)
        .values({ name, nameKey, code, pwHash: hash, pwAlgo: algo })
        .returning({ id: schema.listeners.id });
      const row = inserted[0];
      if (!row) throw new Error("claimName: insert returned no rows");
      await ensureState(db, row.id);
      const token = await issueSession(db, row.id);
      ctx.invalidateQueries();
      return {
        ok: true,
        created: true,
        error: null,
        listener: { id: row.id, name, code },
        token,
      };
    },
  }),

  signOut: defineAction({
    description: "Ends the session for the given token.",
    request: z.object({ token: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.tokenHash, await sha256Hex(args.token)));
      return { ok: true as const };
    },
  }),

  logPlay: defineAction({
    description:
      "Logs one finished-or-abandoned play for the signed-in listener and returns the points it earned under the research score formula with the 8h/day eligibility cap and plausibility clamps. A stale token may recover by presenting the listener's name + password: if that listener already has a live session somewhere, the play is credited WITHOUT rotating it (no sign-in ping-pong); only when no live session exists does recovery issue a fresh one, returned in the response token.",
    request: z.object({
      token: z.string().min(1),
      name: z.string().min(1).max(40).optional(),
      password: z.string().min(1).max(200).optional(),
      sessionId: z.string().min(1).max(64),
      trackTitle: z.string().min(1).max(200),
      project: z.string().max(200),
      durationSec: z.number().positive().max(36000),
      listenedSec: z.number().min(0).max(36000),
      naturalEnd: z.boolean(),
      dayKey: z.string().max(10),
      catalogSize: z.number().int().min(1).max(100000),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      finished: z.boolean(),
      points: z.number(),
      capped: z.boolean(),
      score: z.number(),
      // Session outcome of a credential recovery: token carries the fresh
      // session ONLY when recovery issued one (no live session existed);
      // freshSignIn mirrors that. Both stay null/false on every other
      // path — a play credited under an existing live session rotates
      // nothing and returns token: null.
      token: z.string().nullable(),
      freshSignIn: z.boolean(),
    }),
    privileged: [Privileged.verifyPassword],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const fail = (error: string, score = 0) => ({
        ok: false,
        error,
        finished: false,
        points: 0,
        capped: false,
        score,
        token: null,
        freshSignIn: false,
      });
      let recoveredToken: string | null = null;
      let listener = await resolveListener(db, args.token);
      if (!listener && args.name && args.password) {
        // Identity recovery (ping-pong fix): the presented token is dead
        // but the caller proves the name with its password. If a live
        // session exists anywhere, credit the play under it and touch
        // NOTHING — rotating here is what let a stale device steal the
        // session back on every play, kicking the fresh device forever.
        const nameKey = args.name.trim().replace(/\s+/g, " ").toLowerCase();
        const candidates = await db
          .select()
          .from(schema.listeners)
          .where(eq(schema.listeners.nameKey, nameKey))
          .limit(1);
        const found = candidates[0];
        if (
          found &&
          (await verifyPassword(ctx, args.password, found.pwHash, found.pwAlgo))
        ) {
          const sessions = await db
            .select({ expiresAt: schema.sessions.expiresAt })
            .from(schema.sessions)
            .where(eq(schema.sessions.listenerId, found.id));
          const hasLiveSession = sessions.some(
            (s) => s.expiresAt.getTime() > Date.now(),
          );
          listener = found;
          if (!hasLiveSession) {
            // Nobody is signed in: recovery signs this caller back in.
            recoveredToken = await issueSession(db, found.id);
          }
        }
      }
      if (!listener) {
        return fail("Not signed in. Claim your name (or sign back in) first.");
      }
      const state = await ensureState(db, listener.id);
      const now = Date.now();

      // --- Plausibility -------------------------------------------------
      if (args.listenedSec > args.durationSec + 1) {
        return fail(
          "That play claims more listening than the track holds. Nothing was logged.",
          state.score,
        );
      }
      let credited = args.listenedSec;
      let windowCreditSec = state.windowCreditSec;
      if (state.lastPlayEndMs > 0) {
        // Per reporting window, a listener's claimed listening may run
        // ahead of the wall clock by at most the window allowance. The
        // elapsed real time since the previous play ended always
        // credits; any overlap beyond it draws down the allowance
        // (which refills 1:1 with real time). Only overlap past BOTH is
        // clamped — so two honest full plays logged minutes apart both
        // credit in full, while a burst of instant back-to-back
        // full-track claims exhausts the allowance within a few plays
        // and the rest credit ~nothing and are rejected.
        const elapsedSec = Math.max(0, (now - state.lastPlayEndMs) / 1000);
        windowCreditSec = Math.min(
          WINDOW_CREDIT_MAX_SEC,
          windowCreditSec + elapsedSec,
        );
        const overlapSec = Math.max(0, args.listenedSec - elapsedSec);
        const forgivenSec = Math.min(overlapSec, windowCreditSec);
        credited = args.listenedSec - (overlapSec - forgivenSec);
        windowCreditSec -= forgivenSec;
        if (credited <= 0) {
          return fail(
            "That play claims far more listening than the time that has actually passed since the play before it — faster than anyone can listen. Nothing was logged.",
            state.score,
          );
        }
      }
      credited = Math.min(credited, args.listenedSec);

      // A finish is judged on CREDITED seconds, never the raw claim
      // (nerf patch, owner's order 2026-11-09): the old code read
      // args.listenedSec, so a play whose claim the window clamp had
      // already cut to near zero still banked the finish, the streak,
      // the first-listen bonus and depth. Credited is what survived
      // the wall clock; only that can finish a track.
      const finished = credited >= 0.9 * args.durationSec ? 1 : 0;
      const dayKey = DAY_KEY_RE.test(args.dayKey)
        ? args.dayKey
        : keyFromMs(now);
      const weekKey = isoWeekKey(new Date(now));

      // --- Day row + 8h eligibility cap ---------------------------------
      const dayRows = await db
        .select()
        .from(schema.listenerDays)
        .where(
          and(
            eq(schema.listenerDays.listenerId, listener.id),
            eq(schema.listenerDays.dayKey, dayKey),
          ),
        )
        .limit(1);
      const dayBefore = dayRows[0];
      const dayEligibleBefore = dayBefore?.eligibleSec ?? 0;
      const eligible = Math.min(
        credited,
        Math.max(0, DAY_CAP_SEC - dayEligibleBefore),
      );
      const capped = eligible < credited;
      const scoresLive = eligible > 0; // past the cap: stats only, no score

      // --- Points ---------------------------------------------------------
      // FRACTIONAL accrual: minute points are eligibleSec/60 exactly —
      // a 90s play earns 1.50, two 30s plays earn 0.50 + 0.50 = 1.00.
      // No flooring anywhere; totals are rounded to hundredths only to
      // keep binary floating dust out of the stored values.
      const newEligibleTotal = state.eligibleSecTotal + eligible;
      const newMinutePoints = round2(newEligibleTotal / 60);
      const minuteDelta = round2(newMinutePoints - state.minutePoints);

      let finishPts = 0;
      let firstListenPts = 0;
      let sessionPts = 0;
      let streakPts = 0;
      let depthPts = 0;

      if (scoresLive && finished === 1) finishPts = 10;

      if (scoresLive) {
        const prior = await db
          .select({ id: schema.plays.id })
          .from(schema.plays)
          .where(
            and(
              eq(schema.plays.listenerId, listener.id),
              eq(schema.plays.trackTitle, args.trackTitle),
              eq(schema.plays.weekKey, weekKey),
            ),
          )
          .limit(1);
        // The +25 pays for actually hearing a new track, not for a
        // credited sliver of one: require 30 credited seconds or half
        // the track, whichever is less (short tracks stay earnable).
        if (
          prior.length === 0 &&
          credited >= Math.min(30, 0.5 * args.durationSec)
        )
          firstListenPts = 25;
      }

      // Session bookkeeping (eligible seconds in the current session).
      let sessionSec = state.sessionSec;
      let sessionBonus = state.sessionBonus;
      if (args.sessionId !== state.sessionId) {
        sessionSec = 0;
        sessionBonus = 0;
      }
      sessionSec += eligible;
      if (scoresLive && sessionBonus === 0 && sessionSec >= SESSION_BONUS_SEC) {
        sessionPts = 50;
        sessionBonus = 1;
      }

      // Finish streak: 3 in a row, +150, repeating every third.
      let finishStreak = state.finishStreak;
      if (finished === 1) {
        finishStreak += 1;
        if (scoresLive && finishStreak % 3 === 0) streakPts = 150;
      } else {
        finishStreak = 0;
      }

      // Catalog-depth thresholds at 25/50/75/100% of the catalog finished.
      let depthMask = state.depthMask;
      if (scoresLive && finished === 1) {
        const agg = await listenerAggregates(db, listener.id);
        const alreadyFinished = await db
          .select({ id: schema.plays.id })
          .from(schema.plays)
          .where(
            and(
              eq(schema.plays.listenerId, listener.id),
              eq(schema.plays.trackTitle, args.trackTitle),
              eq(schema.plays.project, args.project),
              eq(schema.plays.finished, 1),
            ),
          )
          .limit(1);
        const distinct = agg.depth + (alreadyFinished.length === 0 ? 1 : 0);
        const thresholds = [0.25, 0.5, 0.75, 1];
        thresholds.forEach((t, i) => {
          const bit = 1 << i;
          if (
            distinct >= Math.ceil(t * args.catalogSize) &&
            (depthMask & bit) === 0
          ) {
            depthPts += 300;
            depthMask |= bit;
          }
        });
      }

      const points = round2(
        minuteDelta +
          finishPts +
          firstListenPts +
          sessionPts +
          streakPts +
          depthPts,
      );
      const newScore = round2(state.score + points);

      // --- Persist --------------------------------------------------------
      await db.insert(schema.plays).values({
        listenerId: listener.id,
        sessionId: args.sessionId,
        trackTitle: args.trackTitle,
        project: args.project,
        durationSec: args.durationSec,
        listenedSec: args.listenedSec,
        creditedSec: credited,
        eligibleSec: eligible,
        finished,
        naturalEnd: args.naturalEnd ? 1 : 0,
        points,
        dayKey,
        weekKey,
        playedAt: new Date(now),
      });

      if (dayBefore) {
        await db
          .update(schema.listenerDays)
          .set({
            creditedSec: dayBefore.creditedSec + credited,
            eligibleSec: dayBefore.eligibleSec + eligible,
            finishes: dayBefore.finishes + finished,
          })
          .where(
            and(
              eq(schema.listenerDays.listenerId, listener.id),
              eq(schema.listenerDays.dayKey, dayKey),
            ),
          );
      } else {
        await db.insert(schema.listenerDays).values({
          listenerId: listener.id,
          dayKey,
          creditedSec: credited,
          eligibleSec: eligible,
          finishes: finished,
        });
      }

      // Longest streak only ever grows.
      const allDays = await db
        .select()
        .from(schema.listenerDays)
        .where(eq(schema.listenerDays.listenerId, listener.id));
      const qualified = new Set(
        allDays
          .filter((d) => d.creditedSec >= STREAK_DAY_MIN_SEC)
          .map((d) => d.dayKey),
      );
      const streaks = computeStreaks(qualified, dayKey);
      const longestStreak = Math.max(state.longestStreak, streaks.longest);

      await db
        .update(schema.listenerState)
        .set({
          score: newScore,
          eligibleSecTotal: newEligibleTotal,
          minutePoints: newMinutePoints,
          lastPlayEndMs: now,
          windowCreditSec,
          sessionId: args.sessionId,
          sessionSec,
          sessionBonus,
          finishStreak,
          depthMask,
          longestStreak,
        })
        .where(eq(schema.listenerState.listenerId, listener.id));

      ctx.invalidateQueries();
      return {
        ok: true,
        error: null,
        finished: finished === 1,
        points,
        capped,
        score: newScore,
        token: recoveredToken,
        freshSignIn: recoveredToken !== null,
      };
    },
  }),

  getBoard: defineAction({
    description:
      "Returns THE LISTENERS standings: every claimed listener ranked by score, plus board totals. Empty until the first name is claimed and the first play lands.",
    request: z.object({}),
    response: z.object({
      listeners: z.array(
        z.object({
          rank: z.number(),
          id: z.number(),
          name: z.string(),
          code: z.string(),
          score: z.number(),
          minutes: z.number(),
          finishes: z.number(),
          depth: z.number(),
        }),
      ),
      totals: z.object({
        listeners: z.number(),
        plays: z.number(),
        minutes: z.number(),
        finishes: z.number(),
      }),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const all = await db.select().from(schema.listeners);
      const states = await db.select().from(schema.listenerState);
      const stateById = new Map(states.map((s) => [s.listenerId, s]));
      const aggs = await db
        .select({
          listenerId: schema.plays.listenerId,
          creditedSec: sql<number>`coalesce(sum(${schema.plays.creditedSec}), 0)`,
          finishes: sql<number>`coalesce(sum(case when ${schema.plays.finished} = 1 then 1 else 0 end), 0)`,
          depth: sql<number>`count(distinct case when ${schema.plays.finished} = 1 then ${schema.plays.trackTitle} || char(31) || ${schema.plays.project} end)`,
          plays: sql<number>`count(*)`,
        })
        .from(schema.plays)
        .groupBy(schema.plays.listenerId);
      const aggById = new Map(aggs.map((a) => [a.listenerId, a]));

      const rows = all
        .map((l) => {
          const agg = aggById.get(l.id);
          return {
            id: l.id,
            name: l.name,
            code: l.code,
            score: round2(stateById.get(l.id)?.score ?? 0),
            minutes: Math.floor((agg?.creditedSec ?? 0) / 60),
            finishes: agg?.finishes ?? 0,
            depth: agg?.depth ?? 0,
            createdAtMs: l.createdAt.getTime(),
          };
        })
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.finishes - a.finishes ||
            a.createdAtMs - b.createdAtMs,
        );

      let totalPlays = 0;
      let totalMinutes = 0;
      let totalFinishes = 0;
      for (const a of aggs) {
        totalPlays += a.plays;
        totalMinutes += Math.floor(a.creditedSec / 60);
        totalFinishes += a.finishes;
      }

      return {
        listeners: rows.map((r, i) => ({
          rank: i + 1,
          id: r.id,
          name: r.name,
          code: r.code,
          score: r.score,
          minutes: r.minutes,
          finishes: r.finishes,
          depth: r.depth,
        })),
        totals: {
          listeners: all.length,
          plays: totalPlays,
          minutes: totalMinutes,
          finishes: totalFinishes,
        },
      };
    },
  }),

  getMyRoad: defineAction({
    description:
      "Returns one signed-in listener's road: rank, gap to the listener above, milestone progress, streaks, today's cap usage, and recent plays.",
    request: z.object({
      token: z.string().min(1),
      catalogSize: z.number().int().min(1).max(100000),
      todayKey: z.string().max(10),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      listener: listenerPublic.nullable(),
      rank: z.number().nullable(),
      score: z.number(),
      minutes: z.number(),
      finishes: z.number(),
      depth: z.number(),
      gapAbove: z
        .object({ name: z.string(), points: z.number() })
        .nullable(),
      streak: z.object({
        current: z.number(),
        longest: z.number(),
        freezesUsed: z.number(),
      }),
      todayEligibleSec: z.number(),
      dayCapSec: z.number(),
      milestones: z.array(
        z.object({
          label: z.string(),
          current: z.number(),
          target: z.number(),
          unit: z.string(),
        }),
      ),
      recentPlays: z.array(
        z.object({
          id: z.number(),
          trackTitle: z.string(),
          project: z.string(),
          listenedSec: z.number(),
          durationSec: z.number(),
          finished: z.boolean(),
          points: z.number(),
          playedAt: z.string(),
          hearted: z.boolean(),
        }),
      ),
      favorites: z.array(
        z.object({
          trackTitle: z.string(),
          project: z.string(),
          heartedAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const empty = {
        ok: false,
        error: "Not signed in. Claim your name (or sign back in) to see your road.",
        listener: null,
        rank: null,
        score: 0,
        minutes: 0,
        finishes: 0,
        depth: 0,
        gapAbove: null,
        streak: { current: 0, longest: 0, freezesUsed: 0 },
        todayEligibleSec: 0,
        dayCapSec: DAY_CAP_SEC,
        milestones: [],
        recentPlays: [],
        favorites: [],
      };
      const listener = await resolveListener(db, args.token);
      if (!listener) return empty;
      const state = await ensureState(db, listener.id);
      const agg = await listenerAggregates(db, listener.id);
      const todayKey = DAY_KEY_RE.test(args.todayKey)
        ? args.todayKey
        : keyFromMs(Date.now());

      // Rank + gap, ordered exactly as getBoard orders the standings
      // (score desc, finishes desc, earliest claim first).
      const states = await db.select().from(schema.listenerState);
      const names = await db.select().from(schema.listeners);
      const nameById = new Map(names.map((n) => [n.id, n]));
      const finRows = await db
        .select({
          listenerId: schema.plays.listenerId,
          finishes: sql<number>`coalesce(sum(case when ${schema.plays.finished} = 1 then 1 else 0 end), 0)`,
        })
        .from(schema.plays)
        .groupBy(schema.plays.listenerId);
      const finById = new Map(finRows.map((r) => [r.listenerId, r.finishes]));
      const ordered = states
        .map((s) => ({
          id: s.listenerId,
          score: s.score,
          finishes: finById.get(s.listenerId) ?? 0,
          createdAtMs: nameById.get(s.listenerId)?.createdAt.getTime() ?? 0,
        }))
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.finishes - a.finishes ||
            a.createdAtMs - b.createdAtMs,
        );
      const idx = ordered.findIndex((o) => o.id === listener.id);
      const rank = idx >= 0 ? idx + 1 : names.length;
      const above = idx > 0 ? ordered[idx - 1] : undefined;
      const gapAbove =
        above && nameById.get(above.id)
          ? {
              name: nameById.get(above.id)?.name ?? "",
              points: round2(above.score - state.score),
            }
          : null;

      // Streaks from day aggregates.
      const allDays = await db
        .select()
        .from(schema.listenerDays)
        .where(eq(schema.listenerDays.listenerId, listener.id));
      const qualified = new Set(
        allDays
          .filter((d) => d.creditedSec >= STREAK_DAY_MIN_SEC)
          .map((d) => d.dayKey),
      );
      const streaks = computeStreaks(qualified, todayKey);
      const todayRow = allDays.find((d) => d.dayKey === todayKey);

      // Milestones.
      const depthThresholds = [0.25, 0.5, 0.75, 1];
      const nextDepth =
        depthThresholds
          .map((t) => Math.ceil(t * args.catalogSize))
          .find((t) => agg.depth < t) ?? args.catalogSize;
      const finishTargets = [10, 25, 50, 100, 250, 500, 1000, 2500];
      const nextFinishes =
        finishTargets.find((t) => agg.finishes < t) ??
        agg.finishes + 100;
      const milestones = [
        {
          label: "CATALOG DEPTH — DISTINCT TRACKS FINISHED",
          current: agg.depth,
          target: nextDepth,
          unit: "tracks",
        },
        {
          label: "SESSION HOUR — LONGEST RUN IN ONE SITTING",
          current: Math.min(Math.floor(state.sessionSec), SESSION_BONUS_SEC),
          target: SESSION_BONUS_SEC,
          unit: "sec",
        },
        {
          label: "DAY STREAK — DAYS AT 10+ MINUTES",
          current: streaks.current,
          target: Math.max(7, streaks.longest),
          unit: "days",
        },
        {
          label: "FINISHES — TRACKS RIDDEN TO THE END",
          current: agg.finishes,
          target: nextFinishes,
          unit: "finishes",
        },
      ];

      // Hearts first, so the history below can mark them.
      const favRows = await db
        .select()
        .from(schema.favorites)
        .where(eq(schema.favorites.listenerId, listener.id))
        .orderBy(desc(schema.favorites.createdAt))
        .limit(200);
      const heartedKeys = new Set(
        favRows.map((f) => `${f.trackTitle}\u0001${f.project}`),
      );

      // History, deduped: fetch deep, then keep the most recent play of
      // each track (title + project), most-recent-first, capped at 25.
      const recentRows = await db
        .select()
        .from(schema.plays)
        .where(eq(schema.plays.listenerId, listener.id))
        .orderBy(desc(schema.plays.id))
        .limit(100);
      const seenTracks = new Set<string>();
      const recents = [];
      for (const p of recentRows) {
        const key = `${p.trackTitle}\u0001${p.project}`;
        if (seenTracks.has(key)) continue;
        seenTracks.add(key);
        recents.push(p);
        if (recents.length >= 25) break;
      }

      return {
        ok: true,
        error: null,
        listener: { id: listener.id, name: listener.name, code: listener.code },
        rank,
        score: round2(state.score),
        minutes: Math.floor(agg.creditedSec / 60),
        finishes: agg.finishes,
        depth: agg.depth,
        gapAbove,
        streak: {
          current: streaks.current,
          longest: Math.max(streaks.longest, state.longestStreak),
          freezesUsed: streaks.freezesUsed,
        },
        todayEligibleSec: Math.floor(todayRow?.eligibleSec ?? 0),
        dayCapSec: DAY_CAP_SEC,
        milestones,
        recentPlays: recents.map((p) => ({
          id: p.id,
          trackTitle: p.trackTitle,
          project: p.project,
          listenedSec: Math.round(p.listenedSec),
          durationSec: Math.round(p.durationSec),
          finished: p.finished === 1,
          points: round2(p.points),
          playedAt: p.playedAt.toISOString(),
          hearted: heartedKeys.has(`${p.trackTitle}\u0001${p.project}`),
        })),
        favorites: favRows.map((f) => ({
          trackTitle: f.trackTitle,
          project: f.project,
          heartedAt: f.createdAt.toISOString(),
        })),
      };
    },
  }),

  getTrackBoard: defineAction({
    description:
      "Returns the back-room track board: tracks ranked by Wilson-adjusted completion rate (minimum 10 starts to rank), with duration beside every percentage and per-length-band crowns. Operators only: the caller's session must belong to a back-room operator, else the door stays closed and the board comes back empty.",
    request: z.object({ token: z.string().min(1) }),
    response: z.object({
      allowed: z.boolean(),
      tracks: z.array(
        z.object({
          rank: z.number().nullable(),
          title: z.string(),
          project: z.string(),
          durationSec: z.number(),
          starts: z.number(),
          finishes: z.number(),
          skips: z.number(),
          pct: z.number(),
          adjusted: z.number(),
          band: z.string(),
          crowned: z.boolean(),
        }),
      ),
      totals: z.object({ tracks: z.number(), starts: z.number() }),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const listener = await resolveListener(db, args.token);
      if (!listener || !OPERATOR_CODES.includes(listener.code)) {
        return {
          allowed: false,
          tracks: [],
          totals: { tracks: 0, starts: 0 },
        };
      }
      const rows = await db
        .select({
          title: schema.plays.trackTitle,
          project: schema.plays.project,
          durationSec: sql<number>`max(${schema.plays.durationSec})`,
          starts: sql<number>`coalesce(sum(case when ${schema.plays.listenedSec} > 5 then 1 else 0 end), 0)`,
          finishes: sql<number>`coalesce(sum(case when ${schema.plays.finished} = 1 then 1 else 0 end), 0)`,
          skips: sql<number>`coalesce(sum(case when ${schema.plays.listenedSec} < 30 and ${schema.plays.finished} = 0 and ${schema.plays.naturalEnd} = 0 then 1 else 0 end), 0)`,
          lastPlayedMs: sql<number>`max(${schema.plays.playedAt})`,
        })
        .from(schema.plays)
        .groupBy(schema.plays.trackTitle);

      const MIN_STARTS = 10;
      const enriched = rows.map((r) => ({
        title: r.title,
        project: r.project,
        durationSec: Math.round(r.durationSec),
        starts: r.starts,
        finishes: r.finishes,
        skips: r.skips,
        pct: r.starts > 0 ? Math.round((r.finishes / r.starts) * 100) : 0,
        adjusted: wilsonLower(r.finishes, r.starts),
        band: lengthBand(r.durationSec),
        lastPlayedMs: r.lastPlayedMs,
        ranked: r.starts >= MIN_STARTS,
      }));

      // Band crowns: best adjusted rate per band among ranked tracks;
      // ties go to the most recently logged track (wiring-spec note).
      const crownByBand = new Map<string, (typeof enriched)[number]>();
      for (const t of enriched) {
        if (!t.ranked) continue;
        const cur = crownByBand.get(t.band);
        if (
          !cur ||
          t.adjusted > cur.adjusted ||
          (t.adjusted === cur.adjusted && t.lastPlayedMs > cur.lastPlayedMs)
        ) {
          crownByBand.set(t.band, t);
        }
      }
      const crownedTitles = new Set(
        [...crownByBand.values()].map((t) => t.title),
      );

      const ranked = enriched
        .filter((t) => t.ranked)
        .sort(
          (a, b) =>
            b.adjusted - a.adjusted ||
            b.finishes - a.finishes ||
            b.lastPlayedMs - a.lastPlayedMs,
        );
      const unranked = enriched
        .filter((t) => !t.ranked)
        .sort((a, b) => b.starts - a.starts || b.lastPlayedMs - a.lastPlayedMs);

      const out = [
        ...ranked.map((t, i) => ({ ...t, rank: i + 1 })),
        ...unranked.map((t) => ({ ...t, rank: null })),
      ];

      return {
        allowed: true,
        tracks: out.map((t) => ({
          rank: t.rank,
          title: t.title,
          project: t.project,
          durationSec: t.durationSec,
          starts: t.starts,
          finishes: t.finishes,
          skips: t.skips,
          pct: t.pct,
          adjusted: Math.round(t.adjusted * 1000) / 1000,
          band: t.band,
          crowned: crownedTitles.has(t.title),
        })),
        totals: {
          tracks: rows.length,
          starts: rows.reduce((s, r) => s + r.starts, 0),
        },
      };
    },
  }),

  deletePlay: defineAction({
    description:
      "Removes one of the signed-in listener's own plays (mis-log repair) and backs its points and day aggregates out of their totals.",
    request: z.object({
      token: z.string().min(1),
      playId: z.number().int().positive(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const listener = await resolveListener(db, args.token);
      if (!listener) {
        return { ok: false, error: "Not signed in." };
      }
      const rows = await db
        .select()
        .from(schema.plays)
        .where(eq(schema.plays.id, args.playId))
        .limit(1);
      const play = rows[0];
      if (!play || play.listenerId !== listener.id) {
        return { ok: false, error: "That play isn't yours to remove." };
      }
      const state = await ensureState(db, listener.id);

      await db.delete(schema.plays).where(eq(schema.plays.id, play.id));

      // Back the play out of the day aggregate.
      const dayRows = await db
        .select()
        .from(schema.listenerDays)
        .where(
          and(
            eq(schema.listenerDays.listenerId, listener.id),
            eq(schema.listenerDays.dayKey, play.dayKey),
          ),
        )
        .limit(1);
      const day = dayRows[0];
      if (day) {
        await db
          .update(schema.listenerDays)
          .set({
            creditedSec: Math.max(0, day.creditedSec - play.creditedSec),
            eligibleSec: Math.max(0, day.eligibleSec - play.eligibleSec),
            finishes: Math.max(0, day.finishes - play.finished),
          })
          .where(
            and(
              eq(schema.listenerDays.listenerId, listener.id),
              eq(schema.listenerDays.dayKey, play.dayKey),
            ),
          );
      }

      // Back the play out of score state. Minute points are re-derived
      // from the reduced eligible total so future deltas stay exact;
      // milestone bonuses already banked are not clawed back.
      const newEligibleTotal = Math.max(
        0,
        state.eligibleSecTotal - play.eligibleSec,
      );
      const newMinutePoints = round2(newEligibleTotal / 60);
      const minutePart = Math.max(0, round2(state.minutePoints - newMinutePoints));
      const bonusPart = Math.max(0, round2(play.points - minutePart));
      await db
        .update(schema.listenerState)
        .set({
          score: Math.max(0, round2(state.score - minutePart - bonusPart)),
          eligibleSecTotal: newEligibleTotal,
          minutePoints: newMinutePoints,
        })
        .where(eq(schema.listenerState.listenerId, listener.id));

      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  toggleFavorite: defineAction({
    description:
      "Hearts or unhearts a track for the signed-in listener. Purely personal: favorites never touch score, state, or plays.",
    request: z.object({
      token: z.string().min(1).max(512),
      trackTitle: z.string().min(1).max(500),
      project: z.string().min(1).max(500),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      hearted: z.boolean(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const listener = await resolveListener(db, args.token);
      if (!listener) {
        return { ok: false, error: "Not signed in.", hearted: false };
      }
      const where = and(
        eq(schema.favorites.listenerId, listener.id),
        eq(schema.favorites.trackTitle, args.trackTitle),
        eq(schema.favorites.project, args.project),
      );
      const existing = await db
        .select()
        .from(schema.favorites)
        .where(where)
        .limit(1);
      if (existing[0]) {
        await db.delete(schema.favorites).where(where);
        ctx.invalidateQueries();
        return { ok: true, error: null, hearted: false };
      }
      await db.insert(schema.favorites).values({
        listenerId: listener.id,
        trackTitle: args.trackTitle,
        project: args.project,
      });
      ctx.invalidateQueries();
      return { ok: true, error: null, hearted: true };
    },
  }),

  getHeartsToday: defineAction({
    description:
      "Public counter: how many hearts were given on the given day, site-wide. 'Today' follows the same day-key convention as getMyRoad (DAY_KEY_RE-validated key, dayMs UTC boundaries). Returns only the count — never who hearted what.",
    request: z.object({
      todayKey: z.string().max(10),
    }),
    response: z.object({
      ok: z.literal(true),
      count: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const todayKey = DAY_KEY_RE.test(args.todayKey)
        ? args.todayKey
        : keyFromMs(Date.now());
      const start = dayMs(todayKey);
      const rows = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.favorites)
        .where(
          and(
            gte(schema.favorites.createdAt, new Date(start)),
            lt(schema.favorites.createdAt, new Date(start + 864e5)),
          ),
        );
      return { ok: true as const, count: rows[0]?.n ?? 0 };
    },
  }),

  recomputeListener: defineAction({
    description:
      "Owner maintenance (nerf engine): replays the named listener's stored plays under the current scoring rules and rewrites their score. Gated by the listener's public !code, which rotates that listener's sessions.",
    request: z.object({
      token: z.string().min(1),
      code: z.string().min(1).max(64),
      catalogSize: z.number().int().min(1).max(100000),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      listener: z.string().nullable(),
      oldScore: z.number().nullable(),
      newScore: z.number().nullable(),
      plays: z.number().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const me = await resolveListener(db, args.token);
      if (!me) {
        return { ok: false, error: "Not signed in.", listener: null, oldScore: null, newScore: null, plays: null };
      }
      const targets = await db
        .select()
        .from(schema.listeners)
        .where(eq(schema.listeners.code, args.code))
        .limit(1);
      const target = targets[0];
      if (!target) {
        return { ok: false, error: "No listener carries that !code.", listener: null, oldScore: null, newScore: null, plays: null };
      }
      const before = await ensureState(db, target.id);
      const oldScore = before.score;
      const result = await recomputeListenerTotals(db, target.id, args.catalogSize);
      const sessions = await db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.listenerId, target.id));
      if (sessions.length > 0) {
        await db.delete(schema.sessions).where(
          inArray(schema.sessions.id, sessions.map((s) => s.id)),
        );
      }
      ctx.invalidateQueries();
      return {
        ok: true,
        error: null,
        listener: target.name,
        oldScore,
        newScore: result.score,
        plays: result.plays,
      };
    },
  }),
} satisfies ActionsModule;
