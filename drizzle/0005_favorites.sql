CREATE TABLE favorites (
  listener_id INTEGER NOT NULL,
  track_title TEXT NOT NULL,
  project TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (listener_id, track_title, project)
);
