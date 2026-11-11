-- Whale Reminder schema v1
-- 时间一律存 UTC ISO 8601（带 Z），展示时才转本地。
-- 删除一律软删（deleted_at），查询默认过滤。

CREATE TABLE IF NOT EXISTS task (
  id            TEXT PRIMARY KEY,
  title         TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'todo'
                  CHECK (status IN ('todo','doing','done','archived')),
  priority      INTEGER NOT NULL DEFAULT 1
                  CHECK (priority BETWEEN 0 AND 3),
  due_at        TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  estimate_min  INTEGER,
  tags          TEXT    NOT NULL DEFAULT '[]',
  source        TEXT    NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual','ai','import')),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_live_due ON task(deleted_at, status, due_at);
CREATE INDEX IF NOT EXISTS idx_task_status   ON task(status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS reminder (
  id             TEXT PRIMARY KEY,
  task_id        TEXT    NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('notify','ask')),
  rule           TEXT    NOT NULL DEFAULT '{"type":"once"}',
  next_fire_at   TEXT    NOT NULL,
  state          TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending','paused','done','cancelled')),
  fire_count     INTEGER NOT NULL DEFAULT 0,
  last_fired_at  TEXT,
  created_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminder_due  ON reminder(state, next_fire_at);
CREATE INDEX IF NOT EXISTS idx_reminder_task ON reminder(task_id);

CREATE TABLE IF NOT EXISTS progress_log (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  asked_at     TEXT NOT NULL,
  answer       TEXT CHECK (answer IN ('done','doing','not_started','ignored')),
  answered_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_progress_task ON progress_log(task_id, asked_at DESC);

CREATE TABLE IF NOT EXISTS event_log (
  id       TEXT PRIMARY KEY,
  at       TEXT NOT NULL,
  actor    TEXT NOT NULL CHECK (actor IN ('user','ai','scheduler','system')),
  action   TEXT NOT NULL,
  task_id  TEXT,
  payload  TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_event_at ON event_log(at DESC);
