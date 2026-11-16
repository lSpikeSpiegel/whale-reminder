-- Whale Reminder schema v5
-- 时间一律存 UTC ISO 8601（带 Z），展示时才转本地。
-- 删除一律软删（deleted_at），查询默认过滤。
--
-- v5 起每张同步实体表多两列同步元数据（`hlc` / `origin`），另有 `outbox`
-- 记录本地变更。这两列**不进业务查询**的列清单，只在写路径和同步里用——
-- 详见 docs/06-persistence-and-sync.md 与 src/sync.rs。

CREATE TABLE IF NOT EXISTS task (
  id            TEXT PRIMARY KEY,
  title         TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'todo'
                  CHECK (status IN ('todo','doing','done','archived')),
  priority      INTEGER NOT NULL DEFAULT 1
                  CHECK (priority BETWEEN 0 AND 3),
  due_at        TEXT,
  -- 计划开始时间（不是 started_at：那个记的是「实际开始动手」的时刻）
  start_at      TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  estimate_min  INTEGER,
  tags          TEXT    NOT NULL DEFAULT '[]',
  source        TEXT    NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual','ai','import')),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  deleted_at    TEXT,
  -- 同步元数据（v5）：最后一次写入的混合逻辑时钟与设备号。
  -- 不参与业务查询，也不当排序依据——`updated_at` 管排序，`hlc` 只管定序。
  hlc           TEXT    NOT NULL DEFAULT '',
  origin        TEXT    NOT NULL DEFAULT ''
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
  created_at     TEXT    NOT NULL,
  hlc            TEXT    NOT NULL DEFAULT '',
  origin         TEXT    NOT NULL DEFAULT ''
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

-- 备忘：不挂提醒、不进调度器，纯粹「写下来别忘」。
-- 和待办分开存是有意的——待办是要做完的事，备忘是一段信息，
-- 混在一张表里就得给「没做完」加一堆例外条件。
CREATE TABLE IF NOT EXISTS note (
  id          TEXT PRIMARY KEY,
  body        TEXT    NOT NULL,
  -- 0/1 而不是布尔：SQLite 没有布尔类型，读出来再转
  pinned      INTEGER NOT NULL DEFAULT 0
                CHECK (pinned IN (0, 1)),
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  deleted_at  TEXT,
  hlc         TEXT    NOT NULL DEFAULT '',
  origin      TEXT    NOT NULL DEFAULT ''
);

-- 列表按「置顶在前、最近改过的在前」排，索引跟着这个顺序建
CREATE INDEX IF NOT EXISTS idx_note_live ON note(deleted_at, pinned DESC, updated_at DESC);

-- 标签：独立一张表，不塞进 note.tags 的 JSON。
-- 理由是「已有标签」要能脱离某条备忘存在——用户先建好标签，过两天才用得上；
-- 只存在 JSON 里的话，没有任何备忘引用的标签会凭空消失。
CREATE TABLE IF NOT EXISTS tag (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  hlc        TEXT NOT NULL DEFAULT '',
  origin     TEXT NOT NULL DEFAULT ''
);

-- 标签名唯一：同一件事别存成两个标签。大小写敏感（SQLite 默认 BINARY），
-- NOCASE 只对 ASCII 生效，中英混排时反而更难解释。
CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_name ON tag(name);

-- 备忘 ↔ 标签。note 是软删的，所以这里不靠 CASCADE 清理——
-- 删标签时代码里显式删关联，测试库（没开 foreign_keys）也照样对。
CREATE TABLE IF NOT EXISTS note_tag (
  note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tag(id)  ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_note_tag_tag ON note_tag(tag_id);

-- ============================================================
-- 同步（v5）。这一层只做「记录」，推送/拉取在 L2 才接进来。
-- ============================================================

-- 待推送队列，同时也是本地变更日志（排查「我的修改去哪了」用）。
--
-- 每一条写操作都往这里投一行，和业务行写在同一个事务里——
-- 分开写的话会出现「数据改了但没进队列」的静默丢失，而且永远查不出来。
-- `payload` 是**行级快照**（明文 JSON，推送时才加密），不是字段级增量：
-- 字段少、行级 LWW 够用，字段级要把体积和合并复杂度都放大一个量级。
CREATE TABLE IF NOT EXISTS outbox (
  op_id      TEXT PRIMARY KEY,           -- uuid v7，同时是推送去重键
  entity     TEXT NOT NULL,              -- task | note | reminder | tag
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL,              -- upsert | delete（软删的行 payload 里带 deleted_at）
  payload    TEXT NOT NULL,
  hlc        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  synced_at  TEXT,                       -- NULL = 还没推出去
  tries      INTEGER NOT NULL DEFAULT 0
);

-- 只索引未推送的：已同步的行占绝大多数，不该拖慢插入
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(hlc) WHERE synced_at IS NULL;

-- 同步状态，键值对。
-- 现在只用两个键：`device_id`（本机 8 位设备号）、`last_hlc`（时钟水位）。
-- `last_hlc` 落库不只是为了重启后续上，更重要的是 GUI 与 MCP 是两个进程——
-- 都从库里的水位继续走，才不会互相把对方的写入判成「更旧」。
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 服务端下发后缓存的设备列表，用于选「谁来弹提醒」和显示「由 iPhone 修改」
CREATE TABLE IF NOT EXISTS device (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  platform   TEXT NOT NULL DEFAULT ''
);
