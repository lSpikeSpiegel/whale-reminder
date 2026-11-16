use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::time::Duration;

use chrono::{Local, SecondsFormat, Utc};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime};

use crate::db::{now_iso, Db};
use crate::recur::RecurRule;
use crate::sync::{self, Entity};

/// 轮询间隔。不用 sleep_until 是因为 Windows 休眠会让计时基准漂移，
/// 轮询的语义是「只要我醒着，就把所有该触发但没触发的补上」。
const TICK: Duration = Duration::from_secs(15);

/// 单次 tick 最多处理多少条，避免唤醒后一口气弹十几个气泡。
const BATCH: i64 = 5;

/// 气泡无人操作时的存活时间（毫秒）。
///
/// 默认 15 秒，可以在设置页改；用原子量是因为改它的是命令线程，
/// 读它的是调度线程和一堆延迟隐藏的定时器。
static BUBBLE_TTL_MS: AtomicU64 = AtomicU64::new(15_000);

/// 设置页改了停留时长后调用，之后弹出的气泡立刻按新值走。
pub fn set_bubble_ttl(seconds: u32) {
    BUBBLE_TTL_MS.store(u64::from(seconds) * 1_000, Ordering::SeqCst);
}

fn bubble_ttl() -> Duration {
    Duration::from_millis(BUBBLE_TTL_MS.load(Ordering::SeqCst))
}

/// 展开时间选择器后的存活时间。用户在挑时间，别 15 秒就把气泡收了。
const PICKER_TTL: Duration = Duration::from_secs(60);

/// 台词气泡的存活时间。短一点，别挡鼠标。
const SPEECH_TTL: Duration = Duration::from_millis(3_200);

/// 气泡宽度，三种提醒一致（逻辑像素，和 tauri.conf.json 里一致）
const BUBBLE_WIDTH: u32 = 280;
/// 追问气泡：只有一行回答按钮
const ASK_SIZE: (u32, u32) = (BUBBLE_WIDTH, 132);
/// 截止提醒：主操作一行 + 快捷时刻一行
const DUE_SIZE: (u32, u32) = (BUBBLE_WIDTH, 156);
/// 开始提醒：主操作 + 快捷时刻 + 晚点提醒，三行按钮
const START_SIZE: (u32, u32) = (BUBBLE_WIDTH, 196);
/// 台词气泡尺寸：只有一行字，做小一圈
const SPEECH_SIZE: (u32, u32) = (236, 88);

/// 每种提醒的气泡尺寸。前端 `Bubble.tsx` 里的同名常量要跟着改。
fn size_for(phase: &str) -> (u32, u32) {
    match phase {
        "start" => START_SIZE,
        "ask" => ASK_SIZE,
        _ => DUE_SIZE,
    }
}

/// 气泡代数。每次显示递增，延迟隐藏时用它判断自己是不是最新那个，
/// 避免旧气泡的定时器把新气泡关掉。
static BUBBLE_GEN: AtomicU64 = AtomicU64::new(0);

/// 气泡现在装的是什么。提醒优先，台词不能把它顶掉。
const BUBBLE_NONE: u8 = 0;
const BUBBLE_REMINDER: u8 = 1;
const BUBBLE_SPEECH: u8 = 2;
static BUBBLE_KIND: AtomicU8 = AtomicU8::new(BUBBLE_NONE);

pub const EVENT_FIRE: &str = "reminder://fire";
/// 桌宠说话
pub const EVENT_SAY: &str = "pet://say";

#[derive(Debug, Clone, serde::Serialize)]
pub struct FiredReminder {
    pub reminder_id: String,
    pub task_id: String,
    pub kind: String,
    /// 这条提醒是干什么的：`ask` 追问 / `start` 开始时间到 / `due` 临近或到截止。
    /// 气泡据此决定按钮（开始提醒给「已开始」，其余给「已完成」）。
    pub phase: String,
    pub title: String,
    pub due_at: Option<String>,
}

/// 从 `kind` 和 `rule` 推出 `phase`。
///
/// 开始提醒和结束提醒在库里都是 `kind = notify` 的一次性提醒，
/// 唯一的分辨依据是建它时写进 `rule` 的 `origin`（见 `reminder::ORIGIN_START`）。
fn phase_of(kind: &str, rule: &str) -> String {
    if kind == "ask" {
        return "ask".into();
    }

    let origin = serde_json::from_str::<serde_json::Value>(rule)
        .ok()
        .and_then(|value| value.get("origin")?.as_str().map(str::to_owned));

    match origin.as_deref() {
        Some(crate::repository::reminder::ORIGIN_START) => "start".into(),
        _ => "due".into(),
    }
}

/// 取到期提醒时顺带把规则也读出来：一次性提醒响过就结束，循环提醒要续上下一次。
struct Candidate {
    fired: FiredReminder,
    rule: String,
}

fn to_iso(dt: chrono::DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
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
        // 按钮行数跟着提醒类型变，窗口尺寸得先摆对
        show_bubble(app, &item.phase);
        // 广播给所有窗口：气泡窗口渲染内容，桌宠窗口切到 remind 状态
        let _ = app.emit(EVENT_FIRE, item);
    }
}

/// 取出到期提醒并原子地标记为已触发。
///
/// 去重靠「带条件的 UPDATE」：受影响行数为 0 说明已经被别的 tick（或另一个进程）
/// 处理过了，直接跳过。
///
/// 一次性提醒更新 `state = 'done'`；循环提醒则把 `next_fire_at` 推到下一次，
/// 状态保持 `pending`——这样同一条 reminder 会一直活下去。
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
            "SELECT r.id, r.task_id, r.kind, r.rule, t.title, t.due_at
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
            let kind: String = row.get(2)?;
            let rule: String = row.get(3)?;
            Ok(Candidate {
                fired: FiredReminder {
                    reminder_id: row.get(0)?,
                    task_id: row.get(1)?,
                    phase: phase_of(&kind, &rule),
                    kind,
                    title: row.get(4)?,
                    due_at: row.get(5)?,
                },
                rule,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .unwrap_or_default()
    };

    let mut fired = Vec::new();
    for Candidate { fired: item, rule } in candidates {
        let rule = RecurRule::from_json(&rule);

        // 认领写入也走 sync::mutate：提醒的 state / next_fire_at 变了，
        // 这个变化必须进 outbox，否则另一台设备上它还挂在 pending，会再弹一次。
        // 失败按「没认领到」处理（并发下别的进程可能已经改过了）。
        let claimed = if rule.is_recurring() {
            match rule.next_after(Local::now()) {
                Some(next) => sync::mutate(&guard, Entity::Reminder, &item.reminder_id, |tx| {
                    Ok(tx.execute(
                        "UPDATE reminder
                         SET next_fire_at = ?3, last_fired_at = ?2, fire_count = fire_count + 1
                         WHERE id = ?1 AND state = 'pending' AND next_fire_at <= ?2",
                        rusqlite::params![item.reminder_id, now, to_iso(next)],
                    )?)
                })
                .unwrap_or(0),
                None => {
                    // 规则推算不出下一次（比如每周一天都没选），这条提醒作废
                    let _ = sync::mutate(&guard, Entity::Reminder, &item.reminder_id, |tx| {
                        Ok(tx.execute(
                            "UPDATE reminder SET state = 'cancelled' WHERE id = ?1",
                            [&item.reminder_id],
                        )?)
                    });
                    0
                }
            }
        } else {
            sync::mutate(&guard, Entity::Reminder, &item.reminder_id, |tx| {
                Ok(tx.execute(
                    "UPDATE reminder
                     SET state = 'done', last_fired_at = ?2, fire_count = fire_count + 1
                     WHERE id = ?1 AND state = 'pending'",
                    rusqlite::params![item.reminder_id, now],
                )?)
            })
            .unwrap_or(0)
        };

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
///
/// `overlap` 是气泡底边压住宠物头顶的像素数：提醒卡压 24px，
/// 台词气泡只压 10px，免得盖住她的脸。
fn place_above<R: Runtime>(
    pet: &tauri::WebviewWindow<R>,
    bubble: &tauri::WebviewWindow<R>,
    size: (u32, u32),
    overlap: i32,
) {
    let (Ok(pet_pos), Ok(pet_size)) = (pet.outer_position(), pet.outer_size()) else {
        return;
    };

    // 先改尺寸，再按「实际」尺寸算位置：
    // 万一窗口不允许 resize（conf 里 resizable:false），也还能摆对地方。
    let _ = bubble.set_size(LogicalSize::new(size.0, size.1));
    let (width, height) = bubble
        .outer_size()
        .map(|actual| (actual.width as i32, actual.height as i32))
        .unwrap_or((size.0 as i32, size.1 as i32));

    let mut x = pet_pos.x + (pet_size.width as i32 - width) / 2;
    let mut y = pet_pos.y - height + overlap;

    // 宠物贴着屏幕顶部时，气泡翻到下方
    if y < 0 {
        y = pet_pos.y + pet_size.height as i32 - overlap;
    }

    // 贴边时气泡会有一半跑到屏幕外，拉回工作区里
    if let Ok(Some(monitor)) = pet.current_monitor() {
        let area = monitor.work_area();
        let (ax, ay) = (area.position.x, area.position.y);
        let (aw, ah) = (area.size.width as i32, area.size.height as i32);
        x = clamp(x, ax, ax + aw - width);
        y = clamp(y, ay, ay + ah - height);
    }

    let _ = bubble.set_position(PhysicalPosition::new(x, y));
    let _ = bubble.show();
}

fn clamp(value: i32, min: i32, max: i32) -> i32 {
    if max < min {
        min
    } else {
        value.max(min).min(max)
    }
}

/// 显示完一段时间后自动收起。代数不匹配说明期间又弹了新的，别乱关。
fn hide_later<R: Runtime>(app: &AppHandle<R>, ttl: Duration) {
    let generation = BUBBLE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ttl);
        if BUBBLE_GEN.load(Ordering::SeqCst) == generation {
            if let Some(window) = handle.get_webview_window("bubble") {
                let _ = window.hide();
            }
            BUBBLE_KIND.store(BUBBLE_NONE, Ordering::SeqCst);
        }
    });
}

/// 气泡自己撑高 / 缩回（「晚点提醒我」要放一个时间选择器）。
///
/// 顺手把自动收起重新计时：不重新计的话，用户刚点开选择器，
/// 上一个 15 秒的定时器就把气泡收走了。挑时间给 60 秒。
pub fn resize_bubble<R: Runtime>(app: &AppHandle<R>, height: u32) {
    let Some(pet) = app.get_webview_window("main") else {
        return;
    };
    let Some(bubble) = app.get_webview_window("bubble") else {
        return;
    };

    place_above(&pet, &bubble, (BUBBLE_WIDTH, height), 24);
    hide_later(app, PICKER_TTL);
}

fn show_bubble<R: Runtime>(app: &AppHandle<R>, phase: &str) {
    let Some(pet) = app.get_webview_window("main") else {
        return;
    };
    let Some(bubble) = app.get_webview_window("bubble") else {
        return;
    };

    BUBBLE_KIND.store(BUBBLE_REMINDER, Ordering::SeqCst);
    // 按钮行数跟着提醒类型变，窗口得先撑够，不然按钮会被窗口底边裁掉
    place_above(&pet, &bubble, size_for(phase), 24);
    hide_later(app, bubble_ttl());
}

/// 让桌宠冒一句台词。提醒正在显示时不抢——提醒比卖萌重要。
pub fn say<R: Runtime>(app: &AppHandle<R>, text: &str) {
    if text.is_empty() {
        return;
    }
    let Some(pet) = app.get_webview_window("main") else {
        return;
    };
    let Some(bubble) = app.get_webview_window("bubble") else {
        return;
    };

    let showing_reminder = bubble.is_visible().unwrap_or(false)
        && BUBBLE_KIND.load(Ordering::SeqCst) == BUBBLE_REMINDER;
    if showing_reminder {
        return;
    }

    let _ = app.emit_to("bubble", EVENT_SAY, text.to_string());
    BUBBLE_KIND.store(BUBBLE_SPEECH, Ordering::SeqCst);
    place_above(&pet, &bubble, SPEECH_SIZE, 10);
    hide_later(app, SPEECH_TTL);
}

#[cfg(test)]
mod tests {
    use super::phase_of;

    #[test]
    fn phase_splits_start_from_due() {
        assert_eq!(phase_of("ask", r#"{"type":"once"}"#), "ask");
        assert_eq!(
            phase_of("notify", r#"{"type":"once","origin":"start"}"#),
            "start"
        );
        assert_eq!(phase_of("notify", r#"{"type":"once"}"#), "due");
        assert_eq!(
            phase_of("notify", r#"{"type":"daily","time":"09:00"}"#),
            "due"
        );
    }
}
