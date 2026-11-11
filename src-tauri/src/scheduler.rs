use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime};

use crate::db::{now_iso, Db};

/// 轮询间隔。不用 sleep_until 是因为 Windows 休眠会让计时基准漂移，
/// 轮询的语义是「只要我醒着，就把所有该触发但没触发的补上」。
const TICK: Duration = Duration::from_secs(15);

/// 单次 tick 最多处理多少条，避免唤醒后一口气弹十几个气泡。
const BATCH: i64 = 5;

/// 气泡无人操作时的存活时间。
const BUBBLE_TTL: Duration = Duration::from_secs(15);

/// 气泡代数。每次显示递增，延迟隐藏时用它判断自己是不是最新那个，
/// 避免旧气泡的定时器把新气泡关掉。
static BUBBLE_GEN: AtomicU64 = AtomicU64::new(0);

pub const EVENT_FIRE: &str = "reminder://fire";

#[derive(Debug, Clone, serde::Serialize)]
pub struct FiredReminder {
    pub reminder_id: String,
    pub task_id: String,
    pub kind: String,
    pub title: String,
    pub due_at: Option<String>,
}

pub fn start<R: Runtime>(app: AppHandle<R>) {
    // 启动时立刻跑一次，补上关机期间错过的提醒
    tick(&app);

    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        tick(&app);
    });
}

fn tick<R: Runtime>(app: &AppHandle<R>) {
    let fired = collect_due(app);

    for item in fired {
        show_bubble(app);
        // 广播给所有窗口：气泡窗口渲染内容，桌宠窗口切到 remind 状态
        let _ = app.emit(EVENT_FIRE, item);
    }
}

/// 取出到期提醒并原子地标记为已触发。
///
/// 去重靠 `UPDATE ... WHERE state = 'pending'`：受影响行数为 0 说明
/// 已经被别的 tick（或另一个进程）处理过了，直接跳过。
fn collect_due<R: Runtime>(app: &AppHandle<R>) -> Vec<FiredReminder> {
    let Some(db) = app.try_state::<Db>() else {
        return Vec::new();
    };
    let Ok(guard) = db.0.lock() else {
        return Vec::new();
    };

    let now = now_iso();

    let candidates = {
        let Ok(mut stmt) = guard.prepare(
            "SELECT r.id, r.task_id, r.kind, t.title, t.due_at
             FROM reminder r
             JOIN task t ON t.id = r.task_id
             WHERE r.state = 'pending'
               AND r.next_fire_at <= ?1
               AND t.deleted_at IS NULL
               AND t.status != 'done'
             ORDER BY r.next_fire_at ASC
             LIMIT ?2",
        ) else {
            return Vec::new();
        };

        stmt.query_map(rusqlite::params![now, BATCH], |row| {
            Ok(FiredReminder {
                reminder_id: row.get(0)?,
                task_id: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                due_at: row.get(4)?,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .unwrap_or_default()
    };

    let mut fired = Vec::new();
    for item in candidates {
        let claimed = guard
            .execute(
                "UPDATE reminder
                 SET state = 'done', last_fired_at = ?2, fire_count = fire_count + 1
                 WHERE id = ?1 AND state = 'pending'",
                rusqlite::params![item.reminder_id, now],
            )
            .unwrap_or(0);

        if claimed > 0 {
            // 追问类提醒留一条待回答记录，供用户点按钮时回填
            if item.kind == "ask" {
                let _ = crate::repository::reminder::log_ask(&guard, &item.task_id, &now);
            }
            fired.push(item);
        }
    }

    fired
}

/// 把气泡窗口摆到桌宠正上方。
fn show_bubble<R: Runtime>(app: &AppHandle<R>) {
    let Some(pet) = app.get_webview_window("main") else {
        return;
    };
    let Some(bubble) = app.get_webview_window("bubble") else {
        return;
    };

    let (Ok(pet_pos), Ok(pet_size), Ok(bubble_size)) = (
        pet.outer_position(),
        pet.outer_size(),
        bubble.outer_size(),
    ) else {
        return;
    };

    let x = pet_pos.x + (pet_size.width as i32 - bubble_size.width as i32) / 2;
    // 略微压住宠物头顶，视觉上像从她头上冒出来
    let mut y = pet_pos.y - bubble_size.height as i32 + 24;

    // 宠物贴着屏幕顶部时，气泡翻到下方
    if y < 0 {
        y = pet_pos.y + pet_size.height as i32 - 24;
    }

    let _ = bubble.set_position(PhysicalPosition::new(x, y));
    let _ = bubble.show();

    // 兜底自动收起：不依赖前端 JS，避免气泡永久挡在屏幕上
    let generation = BUBBLE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(BUBBLE_TTL);
        if BUBBLE_GEN.load(Ordering::SeqCst) == generation {
            if let Some(window) = handle.get_webview_window("bubble") {
                let _ = window.hide();
            }
        }
    });
}
