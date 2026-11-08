// Drizzle schema for the Charles Hamilton Player — THE LISTENERS board.
//
// Identity (tripcode-style, per the 2026-11-07 wiring spec + research
// corrections): a listener row stores a display name, a RANDOM public
// !code assigned at claim time (never derived from the password), and a
// slow-KDF verification hash of the password (Argon2id where the runtime
// offers it, scrypt otherwise — the algo is stored beside the hash).
// Session tokens are random; only their SHA-256 hash is stored.

import {
integer,
primaryKey,
real,
sqliteTable,
text,
} from "drizzle-orm/sqlite-core";

export const listeners = sqliteTable("listeners", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  // Lowercased, trimmed lookup key — names are unique case-insensitively.
  nameKey: text("name_key").notNull().unique(),
  // Public !code shown beside the name. Random at claim time.
  code: text("code").notNull(),
  pwHash: text("pw_hash").notNull(),
  pwAlgo: text("pw_algo").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  listenerId: integer("listener_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const plays = sqliteTable("plays", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  listenerId: integer("listener_id").notNull(),
  // Client-side listening-session id (for the 60-minute session bonus).
  sessionId: text("session_id").notNull(),
  trackTitle: text("track_title").notNull(),
  project: text("project").notNull(),
  durationSec: real("duration_sec").notNull(),
  // What the audio clock actually accumulated.
  listenedSec: real("listened_sec").notNull(),
  // listenedSec after the plausibility clamp (wall-clock overlap rule).
  creditedSec: real("credited_sec").notNull(),
  // Portion of creditedSec that fell inside the 8h/day score cap.
  eligibleSec: real("eligible_sec").notNull(),
  finished: integer("finished").notNull(), // 0 | 1 (>=90% or natural end)
  naturalEnd: integer("natural_end").notNull(), // 0 | 1
  // Fractional: minute points accrue at eligibleSec/60, so a 90s play
  // earns exactly 1.50 minute points. Stored as REAL (hundredths-clean).
  points: real("points").notNull(),
  // Listener-local calendar day (client clock) for cap + streak math.
  dayKey: text("day_key").notNull(),
  // ISO week key (server clock) for first-listen-this-week.
  weekKey: text("week_key").notNull(),
  // Server receipt time = the moment the play ended.
  playedAt: integer("played_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Per-listener, per-day aggregates: cap accounting + streak source.
export const listenerDays = sqliteTable(
  "listener_days",
  {
    listenerId: integer("listener_id").notNull(),
    dayKey: text("day_key").notNull(),
    creditedSec: real("credited_sec").notNull().default(0),
    eligibleSec: real("eligible_sec").notNull().default(0),
    finishes: integer("finishes").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.listenerId, t.dayKey] })],
);

// Running score state per listener (bonus bookkeeping that can't be
// re-derived cheaply from plays alone).
export const listenerState = sqliteTable("listener_state", {
  listenerId: integer("listener_id").primaryKey(),
  score: real("score").notNull().default(0),
  eligibleSecTotal: real("eligible_sec_total").notNull().default(0),
  minutePoints: real("minute_points").notNull().default(0),
  lastPlayEndMs: integer("last_play_end_ms").notNull().default(0),
  // Reporting-window allowance (seconds) for the plausibility clamp:
  // how much not-yet-elapsed listening this listener may still claim.
  // Refills 1:1 with real time up to the server-side maximum.
  windowCreditSec: real("window_credit_sec").notNull().default(300),
  sessionId: text("session_id").notNull().default(""),
  sessionSec: real("session_sec").notNull().default(0),
  sessionBonus: integer("session_bonus").notNull().default(0), // 0 | 1
  finishStreak: integer("finish_streak").notNull().default(0),
  // Bitmask of awarded catalog-depth thresholds (25/50/75/100%).
  depthMask: integer("depth_mask").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
});
