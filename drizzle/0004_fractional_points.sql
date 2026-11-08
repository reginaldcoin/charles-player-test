CREATE TABLE plays_new (
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
  points REAL NOT NULL,
  day_key TEXT NOT NULL,
  week_key TEXT NOT NULL,
  played_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO plays_new (id, listener_id, session_id, track_title, project, duration_sec, listened_sec, credited_sec, eligible_sec, finished, natural_end, points, day_key, week_key, played_at) SELECT id, listener_id, session_id, track_title, project, duration_sec, listened_sec, credited_sec, eligible_sec, finished, natural_end, points, day_key, week_key, played_at FROM plays;
--> statement-breakpoint
DROP TABLE plays;
--> statement-breakpoint
ALTER TABLE plays_new RENAME TO plays;
--> statement-breakpoint
CREATE TABLE listener_state_new (
  listener_id INTEGER PRIMARY KEY,
  score REAL NOT NULL DEFAULT 0,
  eligible_sec_total REAL NOT NULL DEFAULT 0,
  minute_points REAL NOT NULL DEFAULT 0,
  last_play_end_ms INTEGER NOT NULL DEFAULT 0,
  window_credit_sec REAL NOT NULL DEFAULT 300,
  session_id TEXT NOT NULL DEFAULT '',
  session_sec REAL NOT NULL DEFAULT 0,
  session_bonus INTEGER NOT NULL DEFAULT 0,
  finish_streak INTEGER NOT NULL DEFAULT 0,
  depth_mask INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO listener_state_new (listener_id, score, eligible_sec_total, minute_points, last_play_end_ms, window_credit_sec, session_id, session_sec, session_bonus, finish_streak, depth_mask, longest_streak) SELECT listener_id, score, eligible_sec_total, minute_points, last_play_end_ms, window_credit_sec, session_id, session_sec, session_bonus, finish_streak, depth_mask, longest_streak FROM listener_state;
--> statement-breakpoint
DROP TABLE listener_state;
--> statement-breakpoint
ALTER TABLE listener_state_new RENAME TO listener_state;
