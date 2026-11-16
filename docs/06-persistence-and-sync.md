# Whale Reminder · 持久化加固与多端云同步

> 版本 v0.1 · 2026-11-13
> 目标：**本地永不丢数据，多端最终一致，单人千元内零成本。**

---

## 1. 现状盘点

### 1.1 已经做对的事

| 现状 | 为什么对同步友好 |
|---|---|
| 主键 UUID v7 | 离线可生成，多端不会撞号；时间有序，`ORDER BY id` 仍是创建序 |
| 软删除 `deleted_at` | 天然 tombstone，删除动作能传播，不会「删了又复活」 |
| `updated_at` 每行都有 | 版本语义的雏形 |
| WAL + `busy_timeout=5000` | GUI 与 MCP 双进程并发已跑通，多写者不是新问题 |
| `meta.schema_version` + 迁移函数 | 已有升级通道，加列有地方落脚 |

**结论：不需要重做数据模型。** 下面所有改动都是「加列 + 加表」，不动既有列和查询。

### 1.2 三个必须修掉的坑

这三个坑指向同一个结论：**`updated_at` 不能当同步版本号。**

**坑一：精度只有秒。** `db::now_iso()` 用 `SecondsFormat::Secs`，同一秒内的两次写入时间戳完全相同，LWW 无从比较。而「改标题」和「改时间」在 UI 上是两次独立提交，完全可能落在同一秒。

**坑二：依赖设备本地时钟。** 手机比电脑慢 3 分钟，那它这 3 分钟内的所有修改，同步上去都会被判成「旧版本」而丢弃。用户会看到「我在手机上改的，怎么又变回去了」。这个 bug 极难复现，因为取决于两台机器的时钟偏差。

**坑三（最隐蔽）：`note::set_pinned` 故意不更新 `updated_at`。** 这是有意的设计——置顶不该打乱置顶区内部的顺序（`note.rs` 里有注释和单测守着）。但一旦把 `updated_at` 当版本号，置顶这个动作就**不会产生新版本**，同步出去会被对端判定为「过期数据」直接丢弃。用户点十次置顶，另一台设备纹丝不动。

**解法不是改这三处，而是把两个语义拆开：**

- `updated_at` → **业务语义**：管列表排序，保持不变。
- `hlc` → **同步语义**：管定序，独立维护，任何写入（含置顶）都推进。

这个拆分让坑三从「bug」变成「设计」。

---

## 2. 目标与非目标

**目标**

1. 单机：断电、崩溃、磁盘满、误删，都能恢复到最近一次成功状态。
2. 多端：任意台设备离线任意久，重连后自动收敛到同一份数据，无静默丢失。
3. 成本：个人使用（1–3 台设备）**零成本**；千人规模仍在免费额度内。
4. 隐私：服务端只见密文，看不到任何待办内容。

**非目标**

- 多人协作 / 共享清单（那是另一个产品）。
- 实时协同编辑（不需要，待办不是协作文档）。
- 跨账号迁移（一个工作区一条密钥，够用）。

---

## 3. L0 · 本地持久化加固

> **已实现（2026-11-13）**：`src-tauri/src/fsutil.rs`（原子写）、`src-tauri/src/backup.rs`
> （快照 / 自检 / 恢复）、`db::open_or_recover`。新增 19 个单测。

跟云同步完全独立，**先做这一层**，因为它每天在保护数据，而云同步只有联网时才生效。

### 3.1 原子写

现在 `settings.rs` 和 `config.rs` 都是 `fs::write(path, raw)` 直接覆盖。写到一半断电，文件就剩半截 JSON，下次启动读失败退化成默认值——用户的面板尺寸、气泡时长全部悄悄重置。

改成「临时文件 + rename」：

```rust
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;          // 必须 fsync，否则 rename 后内容可能还在页缓存里
    }
    fs::rename(&tmp, path)      // 同分区 rename 是原子的
}
```

Windows 上 `fs::rename` 覆盖已存在文件是可以的（Rust 内部用 `MoveFileEx` + `REPLACE_EXISTING`），不需要先删。

### 3.2 定时备份

**不要复制 `.db` 文件**——WAL 模式下，未 checkpoint 的数据还在 `-wal` 里，复制出来的 `.db` 是残缺的。用 `VACUUM INTO`：

```rust
pub fn backup(conn: &Connection, dir: &Path, keep: usize) -> AppResult<PathBuf> {
    let name = format!("whale-{}.db", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let target = dir.join(&name);
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    prune_old(dir, keep)?;   // 只留最近 keep 份
    Ok(target)
}
```

`VACUUM INTO` 在 SQLite 3.27+ 可用，产生一个**完整、一致、已整理**的副本，且在读事务里跑，不阻塞写入。单机待办几 MB，耗时几十毫秒。

节奏：
- 应用启动 30 秒后一次（避开启动高峰）
- 之后每 6 小时一次（`scheduler::tick` 里顺带判断）
- 保留 7 份，约一周滚动

### 3.3 启动自检

```rust
let ok: String = conn.query_row("PRAGMA quick_check(1)", [], |r| r.get(0))?;
if ok != "ok" {
    // 损坏：把坏库改名留证，从最近一份能打开的备份恢复，记 event_log
}
```

`quick_check` 比 `integrity_check` 快得多（不校验索引一致性），启动时跑一次几十毫秒可接受。恢复流程必须**先重命名坏库而不是删除**——万一备份也坏了，还能人工抢救。

### 3.4 WAL 体积控制

长时间不 checkpoint，`whale.db-wal` 会一直涨（尤其 MCP 进程频繁短连接写入时）。加：

```rust
conn.pragma_update(None, "wal_autocheckpoint", 1000)?;  // 约 4MB 触发
```

并在备份前显式 `PRAGMA wal_checkpoint(TRUNCATE)`。

### 3.5 导出 / 导入

设置页给一个「导出全部数据」按钮，产出单个 JSON：

```json
{ "format": "whale-export", "version": 1, "exported_at": "...",
  "tasks": [...], "notes": [...], "tags": [...], "note_tag": [...] }
```

作用不是同步，是**兜底**：用户换电脑、怀疑数据出问题、想自己看一眼，都有出口。导入按 `id` upsert，不删本地多出来的记录（避免「导入一个旧备份把新数据清了」）。

---

## 4. L1 · 同步数据模型（schema v5）

### 4.1 加列

只加两列，语义清晰：

```sql
-- hlc：本条记录最后一次写入的混合逻辑时钟，同步定序的唯一依据
ALTER TABLE task ADD COLUMN hlc    TEXT NOT NULL DEFAULT '';
ALTER TABLE note ADD COLUMN hlc    TEXT NOT NULL DEFAULT '';
ALTER TABLE reminder ADD COLUMN hlc TEXT NOT NULL DEFAULT '';
ALTER TABLE tag  ADD COLUMN hlc    TEXT NOT NULL DEFAULT '';

-- origin：最后写入的设备 id，用于 UI 显示「由 iPhone 修改」和排查问题
ALTER TABLE task ADD COLUMN origin    TEXT NOT NULL DEFAULT '';
ALTER TABLE note ADD COLUMN origin    TEXT NOT NULL DEFAULT '';
ALTER TABLE reminder ADD COLUMN origin TEXT NOT NULL DEFAULT '';
ALTER TABLE tag  ADD COLUMN origin    TEXT NOT NULL DEFAULT '';
```

`note_tag` 是纯关联表，没有自己的语义，**不参与独立同步**——它跟着 `note` 的 payload 一起走（见 4.4）。

### 4.2 迁移时给老数据补 hlc

老数据 `hlc = ''`，直接同步会全部排在最前。迁移里按 `updated_at` 生成一个初始值：

```rust
// 老数据按 updated_at 秒级时间补一个 HLC，counter 用行号保证同秒内也有序
let mut rows = conn.prepare("SELECT id, updated_at FROM task WHERE hlc = ''")?;
// ... 逐行 UPDATE task SET hlc = ?1 WHERE id = ?2
```

初始 hlc 的 `device` 段填 `"00000000"`，让「老数据」在冲突时永远输给任何新写入——这是正确的，因为它确实更旧。

整个迁移包在一个事务里，且用 `WHERE hlc = ''` 保证幂等。

### 4.3 新增表

```sql
-- 待推送队列。同时也是本地变更日志（排查「我的修改去哪了」用）
CREATE TABLE outbox (
  op_id      TEXT PRIMARY KEY,           -- uuid v7
  entity     TEXT NOT NULL,              -- task | note | reminder | tag
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL,              -- upsert | delete
  payload    TEXT NOT NULL,              -- 明文 JSON，推送时才加密
  hlc        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  synced_at  TEXT,                       -- NULL = 未推送
  tries      INTEGER NOT NULL DEFAULT 0
);
-- 只索引未推送的：已同步的行占绝大多数，不该拖慢插入
CREATE INDEX idx_outbox_pending ON outbox(hlc) WHERE synced_at IS NULL;

-- 同步状态，键值对
CREATE TABLE sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 键：workspace_id / sync_key / device_id / device_name /
--     last_pull_seq / last_sync_at / last_error / primary_device

-- 设备列表，服务端下发后缓存，用于选「谁来弹提醒」
CREATE TABLE device (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  platform   TEXT NOT NULL DEFAULT ''
);
```

### 4.4 payload 的形态

**行级快照，不是字段级增量。** 理由：字段少（task 15 列、note 5 列），用户不会在两台设备上同时改同一条的不同字段——真发生了，行级 LWW 丢一个字段，可接受；而字段级 LWW 要把 payload 变成 `{"title": {"v": "...", "h": "..."}}`，体积涨 3 倍，服务端合并逻辑复杂一个量级。

```jsonc
// task 的 payload
{ "id": "...", "title": "写周报", "status": "todo", "priority": 2,
  "due_at": "2026-11-11T06:00:00Z", "start_at": null,
  "started_at": null, "completed_at": null, "estimate_min": 30,
  "tags": ["工作"], "source": "manual",
  "created_at": "...", "updated_at": "...", "deleted_at": null }

// note 的 payload —— 标签关系内联，不单独同步 note_tag
{ "id": "...", "body": "...", "pinned": 1,
  "created_at": "...", "updated_at": "...", "deleted_at": null,
  "tags": ["tag-uuid-1", "tag-uuid-2"] }
```

`tags` 存的是 `tag.id` 而不是名字。这样改标签名（`tag` 表的一行）不会牵动所有备忘。

**reminder 是独立实体**，有自己的 id 和 hlc，单独同步。不能内联进 task 的 payload——否则两台设备各加一条提醒，LWW 会把其中一条整个吞掉，而提醒恰恰是最不能丢的东西。

### 4.5 写路径要改的地方

> **已实现（2026-11-16）**：`src-tauri/src/sync.rs`。所有写函数都过这一个入口，
> 新增 12 个单测（含护栏那条）。与本节原设计的三处出入见下面的「落地时改了什么」。

所有写操作原来只更新 `updated_at`，现在同时推进 `hlc` 并投递 outbox。**别在每个 repository 函数里手写一遍**，统一入口只有两个：

```rust
/// 可重入的事务：已经在外层事务里就直接复用，不重复 BEGIN。
pub fn with_tx<T>(conn: &Connection, apply: impl FnOnce(&Connection) -> AppResult<T>)
    -> AppResult<T>;

/// 在同一个事务里：写业务行 → 推进 hlc → 投 outbox。
/// 三者必须同事务，否则会出现「数据改了但没进队列」的静默丢失。
pub fn mutate<T>(conn: &Connection, entity: Entity, entity_id: &str,
                 apply: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T>;

/// 一次动到多行时用（停提醒、清空历史），每行各投一条。
pub fn mutate_many<T>(conn: &Connection, entity: Entity, entity_ids: &[String],
                      apply: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T>;
```

这条约束写成了单测 `repository_writes_all_land_in_the_outbox`：**任何 repository 的写函数跑完，outbox 里必须多一条记录**。以后新增写函数忘了接同步，这条会直接挂。

**落地时改了什么，为什么**

| 原设计 | 实际 | 原因 |
|---|---|---|
| `conn: &mut Connection` | `&Connection` + `unchecked_transaction` | 所有 repository 的签名都是 `&Connection`，改用 `&mut` 要动几十个调用点（含 `MutexGuard` 的取用方式），收益为零 |
| 调用方传 `op` | 从快照推导 | 让调用方传 `op` 迟早会传错（软删传 upsert），而错的后果是对端永远删不掉。改为看结果行的 `deleted_at`：非空即 `delete` |
| 闭包拿 `&Transaction` | 闭包拿 `&Connection` | 嵌套调用（`task::complete` → `stop_all_for_task` → 每条提醒各投一条）需要内层能感知外层事务。`is_autocommit()` 一判断就行，不用把事务一路透传 |
| 推进 hlc 用进程内时钟 | 每次写读一次 `sync_state.last_hlc` | **GUI 与 MCP 是两个进程**。各记各的时钟，MCP 写过之后 GUI 拿旧时钟再写，同步时那条修改会被判成「更旧」而丢掉。水位落库 + 每次读一次（主键查询）换两个进程不打架 |
| — | 每次写多一次 `sync_state` 写 | 同上，水位必须落库才跨进程可见。单人待办每分钟几次写，代价可忽略 |

**两处刻意的噪声**：0 行命中（重复完成、对象已删）也会投一条内容不变的快照。行级 LWW 收到「和原来一样」的快照等于没变，正确性不受影响；换来的是调用点不用传「到底改没改」这种最容易传错的标志。

**`progress_log` / `event_log` 不参与同步**：前者是追问记录（每台设备各记各的、不影响数据一致性），后者是本地操作日志（给历史页看）。`note_tag` 也不单独同步，跟着 `note` 的快照走——见 4.4。

**outbox 暂时只写不读**：L2 的推送还没接，所以它会一直涨。等同步引擎接上后按 `synced_at` 清理即可；在那之前它是「我的修改去哪了」的排查依据，不该提前裁掉。


---

## 5. HLC · 混合逻辑时钟

### 5.1 为什么是 HLC 而不是别的

| 方案 | 问题 |
|---|---|
| `updated_at`（wall clock） | 精度秒级、受时钟偏移影响（坑一、坑二） |
| 自增 `rev` | 只能本地单调，跨设备不可比 |
| 版本向量 | 能精确判断并发，但每个实体要存 N 个设备的计数，且无法给出全序（还需要人决定怎么合） |
| **HLC** | **单调、跨设备可比、容忍时钟偏移、只占 27 字符** |

HLC 是 CockroachDB / Cassandra 在用的方案，实现只有几十行，且**完全是纯函数**，非常适合写单测。

### 5.2 格式

```
1796283456789-0000-a1b2c3d4
└── 物理毫秒 ──┘ └计数┘ └设备┘
   13 位补零      4 位   8 位
```

定长 + 补零 → **字符串字典序 == 全序**。可以直接 `ORDER BY hlc`、直接 `>` 比较，不用解析。27 字符。

> 写 Display 时用 `{:0>width$}`，**不能写 `{:0width$}`**——后者把 `0` 当填充字符、缺了
> 对齐符，数字短于宽度时不会补零，定长和字典序一起废掉。这个坑真踩过。

### 5.3 生成规则

```rust
impl Hlc {
    /// 本地事件。物理时钟没走或倒退时，靠 counter 保证严格递增。
    /// `_at` 版本让时间由调用方给，单测不用 mock 系统时钟。
    pub fn tick_at(&mut self, now_ms: u64) -> Self {
        let now = now_ms.min(MAX_MS);          // 13 位能表示到 2286 年
        if now > self.millis {
            self.millis = now;
            self.counter = 0;
        } else {
            self.bump();                       // 时钟停了 / 倒退了
        }
        *self
    }

    /// 计数撞顶时进位到下一毫秒，**不能回绕**——回绕会破坏单调性。
    fn bump(&mut self) {
        if self.counter >= 9_999 {
            self.millis = (self.millis + 1).min(MAX_MS);
            self.counter = 0;
        } else {
            self.counter += 1;
        }
    }

    /// 收到远端 HLC：把自己推到「至少不早于对方」，再生成新值。
    /// 这是抵御时钟偏移的关键——慢的机器会被邻居拽着往前走。
    pub fn observe_at(&mut self, remote: &Hlc, now_ms: u64) -> Self {
        let now = now_ms.min(MAX_MS);
        let remote_ms = if remote.millis > now.saturating_add(MAX_DRIFT_MS) {
            now                                // 对端超前太多 → 只借 counter
        } else {
            remote.millis
        };
        if (remote_ms, remote.counter) > (self.millis, self.counter) {
            self.millis = remote_ms;
            self.counter = remote.counter.min(9_999);   // 夹住脏值，保住定长
        }
        self.tick_at(now)
    }
}
```

效果：手机时钟慢 3 分钟，但它每次同步都会 `observe` 服务端下发的最大 HLC，于是它的物理段被抬到当前真实时间附近。它之后的写入不会永久排在最前。

极端情况（设备时钟快 10 年）：物理段被推到 2036 年，之后所有人的写入都排在它后面。**必须有熔断**：

```rust
const MAX_DRIFT_MS: u64 = 24 * 60 * 60 * 1000;
// 收到的 remote.millis 超过 now + 24h，判为异常：只取 counter 不取毫秒
```

这个熔断要单测：喂一个 2036 年的 HLC，断言本地时钟不被污染。

### 5.4 单测清单（全纯函数，不需要数据库）

**已实现 20 个**（`src-tauri/src/hlc.rs`）：

- `tick` 严格单调递增（同一毫秒连调 5000 次，断言无重复无倒退）
- 时钟倒退时 counter 递增、ms 不变
- 时钟前进时 counter 归零
- **counter 撞顶时进位到下一毫秒，而不是回绕**
- `observe` 远端更大时本地被抬高
- `observe` 远端更小时本地不变但仍递增
- 熔断：远端超前 10 年不污染本地毫秒，但确实前进了
- 脏 counter（9999）不破坏单调性，序列化仍是定长
- 序列化 27 字符、往返一致
- **字典序 == 结构序**：6 个读数两两比较全矩阵，字符串比较和 `Ord` 必须给出同一结果
- 补零：`ms=999` 与 `ms=1000` 的字符串序和结构序一致（不补零会反）
- 解析严格拒绝长度 / 分隔符 / 非法字符，并区分 `Length` / `Shape` / `InvalidChar`
- 大写 hex 宽进严出（收进来、统一输出小写）
- `DeviceId::from_uuid` 取**末尾** 4 字节（v7 开头是时间戳，同毫秒生成会撞）
- 毫秒超 13 位时被夹住，不破坏定长

---

## 6. L2 · 同步协议

### 6.1 两种实现路径的取舍

| 路径 | 做法 | 评价 |
|---|---|---|
| **推拉式 API（推荐）** | 客户端 push 自己的变更、pull 别人的变更，服务端做 HLC 合并 | 逻辑全在自己手里，可单测、可换后端、离线行为可控 |
| 整库文件同步 | 把 db 传到对象存储，按时间戳覆盖 | 两台设备都改过 → 后传的整个覆盖前面的，**丢数据**。只能用于单设备备份 |
| libSQL / Turso 副本 | 用官方同步协议做页级复制 | 合并策略不可控，多写者冲突行为是黑盒；且要求所有端都是 libSQL |
| CRDT（Automerge/Yjs） | 文档级 CRDT | **硬伤**：CRDT 里没法做 SQL 查询。按 `due_at` 排序、按状态筛选全都要全量加载到内存算，几百条还行，几年后就是性能坑。还要维护第二份数据 |

**选推拉式 API。** 数据量小（单人待办，几年几 MB）、查询需求重（排序/筛选/逾期计算）、设备数少（≤5），这三个条件决定了「关系库 + 行级 LWW + HLC」是最优解，而不是 CRDT。

### 6.2 端点

```
POST /v1/push     推送本地变更（幂等）
GET  /v1/pull     拉取远端变更（按 seq 游标）
POST /v1/pair     用配对码换长期密钥
GET  /v1/devices  设备列表（用于选提醒设备）
POST /v1/heartbeat 上报本机活跃
```

全部 `Authorization: Bearer <sync_key>`。

### 6.3 push

```jsonc
// 请求
{
  "device_id": "a1b2c3d4",
  "ops": [
    { "op_id": "0193...", "entity": "task", "entity_id": "0193...",
      "op": "upsert", "hlc": "000001796283456789-0000-a1b2c3d4",
      "cipher": "base64..." }
  ]
}

// 响应
{
  "accepted": ["0193..."],           // 已写入或已是最新
  "stale":    ["0194..."],           // 服务端有更新的版本，客户端应改为拉取
  "server_seq": 8842
}
```

服务端对每条 op：

```sql
-- 只在 hlc 更大时覆盖（同 hlc 视为重复，op_id 主键天然去重）
INSERT INTO entity_head (ws_id, entity, entity_id, hlc, op, cipher, seq, device, at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(seq),0)+1 FROM change), ?7, ?8)
ON CONFLICT (ws_id, entity, entity_id) DO UPDATE SET
  hlc = excluded.hlc, op = excluded.op, cipher = excluded.cipher,
  seq = excluded.seq, device = excluded.device, at = excluded.at
WHERE excluded.hlc > entity_head.hlc;
```

`WHERE` 子句是冲突解决的全部逻辑——比应用层判断可靠，因为它是原子的。

同时往 `change` 表追加一条（审计 + 回溯用）。

### 6.4 pull

```jsonc
// GET /v1/pull?since=8800&limit=500
{
  "changes": [
    { "seq": 8801, "entity": "task", "entity_id": "0193...",
      "op": "upsert", "hlc": "...", "cipher": "base64...", "device": "..." }
  ],
  "next_seq": 8842,
  "has_more": false,
  "max_hlc": "000001796283456789-0000-a1b2c3d4"   // 供 observe 用
}
```

**用 `entity_head` 而不是 `change` 表下发。** `entity_head` 每个实体只有一行最新状态，pull 时天然去重，客户端不用重放历史。`change` 表只用于「找回三天前被谁改的」这种排查场景，可以定期裁剪。

`seq` 是服务端全局自增（D1 的 `AUTOINCREMENT`），客户端只记一个数，不会像复合游标那样漏。

### 6.5 客户端合并

```rust
for change in pulled {
    let local_hlc = read_hlc(conn, change.entity, change.entity_id)?;
    if change.hlc > local_hlc {
        // 远端更新 → 覆盖本地
        apply_remote(conn, change)?;
    } else if local_hlc > change.hlc {
        // 本地更新（可能还没推出去）→ 保留本地，确保它在 outbox 里
        ensure_in_outbox(conn, change.entity, change.entity_id)?;
    }
    // 相等 → 同一条变更，跳过
    hlc_state.observe(&change.hlc);   // 无论如何都要 observe
}
```

`else if local > remote` 这一支很容易被忽略，但它是「本地有未推送修改」的关键兜底：如果 outbox 因为崩溃丢了记录，这里会把它补回去。

### 6.6 触发时机

| 触发 | 说明 |
|---|---|
| 启动后 5 秒 | 避开启动高峰（要建窗口、开库、起调度器） |
| 本地写入后 debounce 3 秒 | 连续改五条只推一次 |
| 每 5 分钟 | 兜底，接别人的变更 |
| 面板获得焦点 | 用户刚打开，期望看到最新的 |
| 手动「立即同步」 | 设置页 |
| 网络恢复 | `reqwest` 失败后由退避定时器重试 |

**本地写入永远不等待同步。** 同步是纯后台线程，任何网络失败都不影响本地操作，也不弹错误——只在设置页显示「上次同步：3 分钟前 / 失败，重试中」。

### 6.7 退避

```
1s → 2s → 4s → 8s → 30s → 1min → 5min（封顶）
```
成功一次即重置。`401` 不重试，直接标记「需要重新配对」，在 UI 上醒目提示。

---

## 7. L3 · 服务端

### 7.1 选型

| 方案 | 免费额度 | 休眠 | 运维 | 结论 |
|---|---|---|---|---|
| **Cloudflare Workers + D1** | 3000 万请求/月、5 亿行读、1000 万行写、5GB | 不休眠 | 无 | ✅ **选它** |
| Supabase (Postgres) | 500MB DB、7 天不活跃**暂停** | 会 | 无 | 额度够，但「偶尔用一下」的工具会踩休眠，不选 |
| Turso | 9GB | 不休眠 | 无 | 同步语义被它接管，与 6.5 冲突 |
| 自建 VPS | — | — | 证书、备份、监控全自理 | 个人项目不值当 |
| Firebase | 按文档读写计费，50k 读/天 | — | 无 | 计费模型对「小数据高频轮询」不友好，查询能力也弱 |

### 7.2 D1 schema

```sql
CREATE TABLE ws (
  id         TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL,          -- sha256(sync_key) 的 hex
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE TABLE device (
  ws_id     TEXT NOT NULL,
  id        TEXT NOT NULL,
  name      TEXT NOT NULL,
  platform  TEXT NOT NULL DEFAULT '',
  last_seen TEXT NOT NULL,
  PRIMARY KEY (ws_id, id)
);

-- 每个实体的最新状态：pull 的唯一数据源
CREATE TABLE entity_head (
  ws_id     TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  hlc       TEXT NOT NULL,
  op        TEXT NOT NULL,
  cipher    BLOB NOT NULL,
  seq       INTEGER NOT NULL,
  device    TEXT NOT NULL,
  at        TEXT NOT NULL,
  PRIMARY KEY (ws_id, entity, entity_id)
);
CREATE INDEX idx_head_ws_seq ON entity_head(ws_id, seq);

-- 变更流水：只做审计，可定期裁剪到 30 天
CREATE TABLE change (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  ws_id     TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op        TEXT NOT NULL,
  hlc       TEXT NOT NULL,
  cipher    BLOB NOT NULL,
  device    TEXT NOT NULL,
  at        TEXT NOT NULL
);
CREATE INDEX idx_change_ws_seq ON change(ws_id, seq);
```

### 7.3 鉴权与配对

**不做账号密码。** 个人工具里账号系统是纯负担：注册、找回密码、邮箱验证、GDPR……全是成本，换不来任何东西。

用「工作区 + 长期密钥」：

1. 首次开启同步 → 生成 `workspace_id`（UUID）和 `sync_key`（32 字节随机，base32 编码成 52 字符）。
2. 服务端只存 `sha256(sync_key)`。请求时比对哈希，密钥本身不落库。
3. 其他设备配对：A 设备显示二维码（内含 `whale://pair?ws=<id>&k=<key>`）或一串 52 字符恢复码，B 设备扫/贴进去。

优点：
- 零账号、零 PII、零密码找回流程
- 密钥即身份，天然支持端到端加密（密钥本身就是加密密钥的种子）
- 服务端被拖库，攻击者也拿不到明文

代价：**恢复码丢失 = 数据不可恢复**。必须在 UI 上把这句话写清楚，并提供「导出恢复码」按钮。

### 7.4 端到端加密

```
master_key = HKDF-SHA256(sync_key, salt="whale-sync-v1", info="payload")
cipher     = XChaCha20-Poly1305(master_key, nonce=random24, plaintext=payload_json)
```

- 服务端存的 `cipher` = `nonce(24) || ciphertext`，元数据（`entity` / `entity_id` / `hlc` / `op`）**明文**——服务端合并需要它，而它不泄露内容。
- 单条 payload 几百字节到几 KB，加密开销可忽略（微秒级）。
- 代价：服务端无法做全文搜索。**无所谓**——搜索本来就在本地 SQL 做。

这一层不只是「隐私加分」，它同时解决了一个合规问题：服务端存的是密文，不构成「个人信息处理」。

### 7.5 Worker 骨架

```ts
export default {
  async fetch(req: Request, env: Env) {
    const ws = await auth(req, env);          // 校验 Bearer → ws_id
    if (!ws) return json({ error: "UNAUTHORIZED" }, 401);

    const url = new URL(req.url);
    if (url.pathname === "/v1/push")   return push(req, env, ws);
    if (url.pathname === "/v1/pull")   return pull(env, ws, url);
    if (url.pathname === "/v1/devices") return devices(env, ws);
    if (url.pathname === "/v1/heartbeat") return heartbeat(req, env, ws);
    return json({ error: "NOT_FOUND" }, 404);
  },
};
```

全部逻辑约 300 行，`wrangler deploy` 一条命令上线，`workers.dev` 子域免费。

---

## 8. 边界情况

| 场景 | 处理 |
|---|---|
| 两台设备离线改同一条 | HLC 大的赢；输的那版写进 `event_log`，UI 上可查「3 分钟前的修改被覆盖」 |
| 一台设备离线 90 天 | tombstone 在服务端**永久保留**（一行几十字节），pull 时照样下发，不会复活 |
| 服务端 D1 挂了 | 本地照常用，退避重试；超过 24 小时在设置页标红 |
| 用户换了 sync_key | 视作新工作区，旧数据不上传。UI 必须二次确认 |
| 同一设备重装 | 用恢复码配对 → `device_id` 重新生成 → 旧的 device 记录由心跳超时清掉 |
| 单条 payload 超大（5000 字备忘 + 长描述） | 约 10KB 密文，D1 单行上限 1MB，远够 |
| 时钟熔断触发 | 记 `event_log`，设置页显示「本机时间异常」，同步仍继续但 hlc 只用 counter 段 |
| 用户手改 `settings.json` 写坏 | 已有兜底（`load` 失败退默认值），但要加 `write_atomic` 才不会写坏 |

### 8.1 提醒在多端重复弹

两台设备都在跑 `scheduler::tick`，同一条提醒会在两台机器上同时弹。这是**用户会立刻感知**的 bug，必须有明确规则。

**规则：只有「当前主设备」弹气泡，其他设备只更新数据。**

```rust
/// 纯函数，可单测：给定设备列表和当前时刻，选出该由谁弹提醒。
/// - 有显式指定且 24 小时内活跃过 → 用它
/// - 否则用 last_seen 最新的那台
/// - 全部超过 24 小时（网络断了）→ 各自都弹（离线兜底，反正同步也没发生）
pub fn pick_reminder_device(devices: &[Device], primary: Option<&str>, now: &str) -> Option<String>
```

`primary_device` 存在 `sync_state` 里，设置页可切换（「由这台电脑负责提醒」）。单测覆盖：指定设备在线 / 指定设备离线 / 未指定 / 全部离线。

这样行为可预期：**主设备关机了，24 小时后自动由另一台接管**，用户不需要手动切。

---

## 9. 成本

按「1000 个用户、每人 3 台设备、每天各同步 20 次、每次推拉 30 行」估算：

| 项目 | 月用量 | 免费额度 | 超出后 |
|---|---|---|---|
| Workers 请求 | 180 万 | 3000 万 | $5 / 1000 万 |
| D1 行读 | 5400 万 | 5 亿 | $0.001 / 100 万 |
| D1 行写 | 180 万 | 1000 万 | $1 / 100 万 |
| D1 存储 | 约 2GB | 5GB | $0.75 / GB |

**结论：1000 用户以内月成本 ¥0。** 超出后进入 $5/月 起步的 Workers Paid 档，这个量级要涨到 5000 用户才会真正花钱。

个人使用（1–3 台设备）几乎不产生流量，永久免费。

> 如果连 Cloudflare 都不想依赖，还有个零成本备选：把加密后的 outbox 追加写进用户自己的 WebDAV（坚果云 / Nextcloud），文件名带 `device_id`，各设备读别人的文件合并。但 WebDAV 没有原子 CAS，两台同时写会覆盖，**可靠性明显低于 7.5 的方案**，只作为离线兜底备选。

---

## 10. 实施顺序

**进度：第 1、3、4 步已完成**（后端用例 73 → 138）。第 2 步「导出/导入 JSON」暂缓——
定时备份已经覆盖了「本地兜底」这个诉求，等真有人要换机器或自查数据时再做。

下一步是第 5 步：同步引擎的合并逻辑，纯函数、不联网，靠 `cargo test` 推进。
它能直接吃第 4 步的产出——`outbox` 里已经是完整的行级快照序列，喂两串进去断言收敛即可。

按「每一步都能独立验证」排：

| # | 内容 | 验收 | 状态 |
|---|---|---|---|
| 1 | `write_atomic` + `VACUUM INTO` 备份 + 启动 `quick_check` | 断电测试：强杀进程后重启，数据完整、备份可恢复 | ✅ 已完成 |
| 2 | 导出/导入 JSON | 导出 → 清空库 → 导入 → 数据一致（写成一个 Rust 集成测试） | 待做 |
| 3 | HLC 模块 + 全部单测 | `cargo test hlc` 全绿，含时钟倒退、熔断 | ✅ 已完成（20 个用例） |
| 4 | schema v5 迁移 + `outbox` 接入所有写路径 | 单测：任一 repository 写函数跑完，outbox 必多一条 | ✅ 已完成（12 个用例） |
| 5 | 同步引擎的合并逻辑（**纯函数，不联网**） | 喂两个设备的变更序列，断言收敛结果一致、顺序无关 |
| 6 | Worker + D1 上线，`/v1/push` `/v1/pull` | 用 curl 手工跑通一轮推拉 |
| 7 | 客户端接入网络层 + 设置页同步 UI | 两台机器改数据，互相可见 |
| 8 | E2EE + 配对码 | 抓包确认服务端只有密文 |
| 9 | 提醒主设备选举 | 两台机器只弹一次 |

第 3、4、5 步**完全可以脱离网络和 UI 开发**，靠 `cargo test` 推进——这符合 `AGENTS.md` 里「逻辑往 Rust 侧放并补单测」的约定，也省掉大量「改一行重启看效果」的时间。

---

## 11. 明确不做

- **不用网盘同步 `.db` 文件。** 坚果云 / OneDrive 会并发写同一文件，SQLite 的锁机制在网盘同步层完全失效，损坏是必然的，不是概率问题。
- **不用 SQLite 的 `session` 扩展做 changeset。** 它要求两端 schema 完全一致，而我们每次迁移都会加列，跨版本同步会直接失败。
- **不做实时推送（WebSocket）。** 待办不是聊天，5 分钟轮询的延迟用户感知不到，但 WebSocket 要处理重连、心跳、Durable Objects 计费，成本收益不成正比。
- **不做字段级合并。** 见 4.4，收益小、复杂度高。真要做得先有用户抱怨再说。
