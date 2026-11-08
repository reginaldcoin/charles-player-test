DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE listeners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  pw_algo TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listener_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listener_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  track_title TEXT NOT NULL,
  project TEXT NOT NULL,
  duration_sec REAL NOT NULL,
  listened_sec REAL NOT NULL,
  credited_sec REAL NOT NULL,
  eligible_sec REAL NOT NULL,
  finished INTEGER NOT NULL,
  natural_end INTEGER NOT NULL,
  points INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  week_key TEXT NOT NULL,
  played_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE listener_days (
  listener_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  credited_sec REAL NOT NULL DEFAULT 0,
  eligible_sec REAL NOT NULL DEFAULT 0,
  finishes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (listener_id, day_key)
);
--> statement-breakpoint
CREATE TABLE listener_state (
  listener_id INTEGER PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 0,
  eligible_sec_total REAL NOT NULL DEFAULT 0,
  minute_points INTEGER NOT NULL DEFAULT 0,
  last_play_end_ms INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL DEFAULT '',
  session_sec REAL NOT NULL DEFAULT 0,
  session_bonus INTEGER NOT NULL DEFAULT 0,
  finish_streak INTEGER NOT NULL DEFAULT 0,
  depth_mask INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0
);
