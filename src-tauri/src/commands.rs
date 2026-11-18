use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::{Manager, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::repository::note::{self, NewNote, Note, NoteFilter, NotePatch};
use crate::repository::reminder;
use crate::repository::tag::{self, TagView};
use crate::repository::task::{self, DayBrief, NewTask, TaskPatch};
use crate::repository::{Task, TaskFilter};

/// 取数据库连接。锁中毒说明某个线程在持锁时 panic 了，
/// 此时继续使用连接可能读到不一致状态，直接报错更安全。
fn conn<'a>(db: &'a State<'_, Db>) -> AppResult<MutexGuard<'a, Connection>> {
    db.0.lock()
        .map_err(|_| AppError::Other("数据库连接锁异常，请重启应用".into()))
}

#[tauri::command]
pub fn list_tasks(db: State<'_, Db>, filter: Option<TaskFilter>) -> AppResult<Vec<Task>> {
    let guard = conn(&db)?;
    task::list(&guard, &filter.unwrap_or_default())
}

#[tauri::command]
pub fn create_task(db: State<'_, Db>, input: NewTask) -> AppResult<Task> {
    let guard = conn(&db)?;
    task::create(&guard, input)
}

#[tauri::command]
pub fn update_task(db: State<'_, Db>, id: String, patch: TaskPatch) -> AppResult<Task> {
    let guard = conn(&db)?;
    task::update(&guard, &id, patch)
}

#[tauri::command]
pub fn complete_task(db: State<'_, Db>, id: String, note: Option<String>) -> AppResult<Task> {
    let guard = conn(&db)?;
    task::complete(&guard, &id, note.as_deref())
}

/// 记录用户对追问的回答：done / doing / not_started / ignored
#[tauri::command]
pub fn answer_progress(db: State<'_, Db>, id: String, answer: String) -> AppResult<Task> {
    let guard = conn(&db)?;
    task::answer_progress(&guard, &id, &answer)
}

#[tauri::command]
pub fn reopen_task(db: State<'_, Db>, id: String) -> AppResult<Task> {
    let guard = conn(&db)?;
    task::reopen(&guard, &id)
}

#[tauri::command]
pub fn delete_task(db: State<'_, Db>, id: String) -> AppResult<()> {
    let guard = conn(&db)?;
    task::delete(&guard, &id)
}

#[tauri::command]
pub fn snooze_task(db: State<'_, Db>, id: String, minutes: i64) -> AppResult<Option<String>> {
    let guard = conn(&db)?;
    reminder::snooze(&guard, &id, minutes)
}

/// 把刚响过的那一条提醒挪到指定时刻（气泡的「15 分钟后」「晚点提醒我」）。
///
/// 按 reminder 而不是按 task 推迟：一次性提醒响完 state 就是 done，
/// 按 task 找 pending 根本找不到它，用户点了等于没点。
#[tauri::command]
pub fn reschedule_reminder(
    db: State<'_, Db>,
    reminder_id: String,
    at: String,
) -> AppResult<String> {
    let guard = conn(&db)?;
    reminder::reschedule(&guard, &reminder_id, &at)
}

/// 气泡展开时间选择器时自己撑高，收起时再缩回去。
#[tauri::command]
pub fn bubble_resize(app: tauri::AppHandle, height: u32) {
    crate::scheduler::resize_bubble(&app, height);
}

/// 面板高度跟着内容走。
///
/// 窗口尺寸写死在 tauri.conf 里，只有一两条待办时下面会空一大片；
/// 由前端量出实际内容高度再回来改窗口，任务多了撑到上限就滚动。
///
/// 窗口在 conf 里是 `resizable: false`（拖拽由前端自己接管，见 `ui/ResizeHandles.tsx`），
/// 但 `set_size` 照样生效——实测过：无边框窗口的 `set_size` 不受 resizable 影响。
#[tauri::command]
pub fn panel_resize(app: tauri::AppHandle, height: u32) {
    let Some(window) = app.get_webview_window("panel") else {
        return;
    };
    // 下限要留得住展开的日历（约 310 高），否则浮层会被窗口裁掉
    let height = height.clamp(356, 640);
    let _ = window.set_size(tauri::LogicalSize::new(436_u32, height));
}

#[tauri::command]
pub fn today_brief(db: State<'_, Db>) -> AppResult<DayBrief> {
    let guard = conn(&db)?;
    task::today_brief(&guard)
}

/// 打开待办面板。桌宠双击时由前端调用，和托盘菜单同一个入口。
#[tauri::command]
pub fn open_panel(app: tauri::AppHandle) {
    crate::tray::open_panel(&app);
}

/// 关掉待办面板——**真关**，不是隐藏。
///
/// 下次打开会重建窗口、重新加载页面，表单和翻到哪一页都归零。
/// 关之前记一下位置，免得每次重开都跳回屏幕中间。
#[tauri::command]
pub fn close_panel(app: tauri::AppHandle) {
    // 面板是在设置页录制热键时被关掉的：录制态要收掉，否则热键会一直装死
    end_capture(&app);

    let Some(window) = app.get_webview_window("panel") else {
        return;
    };
    if let Ok(pos) = window.outer_position() {
        if let Some(state) = app.try_state::<crate::tray::PanelPos>() {
            state.save(pos);
        }
    }
    let _ = window.close();
}

/// 托盘点「检查更新」时面板要是关着的，标记会留到这里；页面挂载后来取一次。
#[tauri::command]
pub fn take_pending_check(app: tauri::AppHandle) -> bool {
    app.try_state::<crate::tray::PendingCheck>()
        .map(|state| state.take())
        .unwrap_or(false)
}

/// 设置页要的全部状态。开机自启的真身在系统里（注册表 / LaunchAgent），
/// 不落我们的 settings.json，每次现问一次，免得两边说法不一致。
#[derive(serde::Serialize)]
pub struct SettingsView {
    pub bubble_seconds: u32,
    pub autostart: bool,
    pub version: String,
    pub data_dir: String,
    /// 面板手动尺寸；null 表示高度跟着内容走
    pub panel_size: Option<crate::settings::PanelSize>,
    /// 桌宠立绘风格：chibi / real
    pub pet_style: crate::settings::PetStyle,
    /// 是否用 Live2D 动态立绘
    pub pet_live2d: bool,
    /// 呼出待办面板的全局快捷键（规范写法，见 `settings::normalize_shortcut`）
    pub panel_shortcut: String,
}

fn settings_view(app: &tauri::AppHandle) -> SettingsView {
    use tauri_plugin_autostart::ManagerExt;

    let settings = crate::settings::load(app);
    SettingsView {
        bubble_seconds: settings.bubble_seconds,
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        version: app.package_info().version.to_string(),
        data_dir: crate::db::data_dir().to_string_lossy().to_string(),
        panel_size: settings.panel_size,
        pet_style: settings.pet_style,
        pet_live2d: settings.pet_live2d,
        panel_shortcut: settings.panel_shortcut,
    }
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> SettingsView {
    settings_view(&app)
}

/// 改气泡停留时长：写盘 + 立刻生效（下一次弹气泡就用新值）。
#[tauri::command]
pub fn set_bubble_seconds(app: tauri::AppHandle, seconds: u32) -> SettingsView {
    let mut settings = crate::settings::load(&app);
    let seconds = crate::settings::clamp_seconds(seconds);
    settings.bubble_seconds = seconds;
    // 先落盘再改调度器：save 拿走 settings 的所有权（`Settings` 有 String 字段，不是 Copy）
    crate::settings::save(&app, settings);
    crate::scheduler::set_bubble_ttl(seconds);
    settings_view(&app)
}

/// 开机自启。托盘菜单里那个勾选状态要跟着同步，否则两个入口会各说各话。
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, on: bool) -> SettingsView {
    use tauri_plugin_autostart::ManagerExt;

    let launcher = app.autolaunch();
    let _ = if on { launcher.enable() } else { launcher.disable() };
    crate::tray::sync_autostart(&app, on);
    settings_view(&app)
}

/// 记住面板被拖出来的尺寸；传 null 表示回到「高度跟着内容走」。
///
/// 只落盘，不动窗口——尺寸已经是用户拖出来的样子了，再 set_size 一次只会闪一下。
/// 下次开面板时 `tray::create_panel` 按这个值建窗口。
#[tauri::command]
pub fn set_panel_size(
    app: tauri::AppHandle,
    size: Option<crate::settings::PanelSize>,
) -> SettingsView {
    let mut settings = crate::settings::load(&app);
    settings.panel_size = size.map(|value| value.clamped());
    crate::settings::save(&app, settings);
    settings_view(&app)
}

/// 进入「录制新快捷键」状态。
///
/// **不是注销热键**，只是让热键回调装死：用户按到当前那个组合时，面板不能被他
/// 自己收走（录制器就没了）。装死比注销安全——中途被打断也不会把热键弄丢。
/// 退出录制态由 `set_panel_shortcut` / `resume_shortcut` / `close_panel` 负责。
#[tauri::command]
pub fn begin_shortcut_capture(app: tauri::AppHandle) {
    use tauri::Manager;

    if let Some(state) = app.try_state::<crate::shortcut::Capturing>() {
        state.begin();
    }
}

/// 换呼出面板的全局快捷键。
///
/// 先落盘再重绑：`bind` 会把**实际生效**的组合写回来（用户要的键被别的程序占着时，
/// 会顺着备选往下试）。存用户写的原文没意义——设置页会一直显示一个按了没反应的组合。
#[tauri::command]
pub fn set_panel_shortcut(app: tauri::AppHandle, shortcut: String) -> SettingsView {
    end_capture(&app);
    {
        let mut settings = crate::settings::load(&app);
        settings.panel_shortcut = shortcut;
        crate::settings::save(&app, settings);
    }
    bind_panel_shortcut(&app)
}

/// 按配置里存的值重新注册热键。
///
/// 两个用处：录制中途面板被关掉（录制态要收掉，否则热键一直装死）；录制取消后
/// 把原来那个组合挂回去。幂等——正常情况多绑一次也就几十微秒。
#[tauri::command]
pub fn resume_shortcut(app: tauri::AppHandle) -> SettingsView {
    end_capture(&app);
    bind_panel_shortcut(&app)
}

fn end_capture(app: &tauri::AppHandle) {
    use tauri::Manager;

    if let Some(state) = app.try_state::<crate::shortcut::Capturing>() {
        state.end();
    }
}

/// 注册热键并把实际生效的写法落盘。
pub(crate) fn bind_panel_shortcut(app: &tauri::AppHandle) -> SettingsView {
    let mut settings = crate::settings::load(app);
    let bound = crate::shortcut::bind(app, &settings.panel_shortcut);
    if bound != settings.panel_shortcut {
        settings.panel_shortcut = bound;
        crate::settings::save(app, settings);
    }
    settings_view(app)
}

/// 换桌宠立绘：写盘 + 改窗口尺寸 + 通知桌宠窗口换图。
///
/// 面板和桌宠是两个窗口，设置页改完必须推一条事件过去，否则要等下次启动才生效。
/// 事件发不到也没关系——桌宠下次加载页面会自己读一遍 settings。
#[tauri::command]
pub fn set_pet_style(
    app: tauri::AppHandle,
    style: crate::settings::PetStyle,
) -> SettingsView {
    use tauri::Emitter;

    let mut settings = crate::settings::load(&app);
    settings.pet_style = style;
    crate::settings::save(&app, settings);
    // 两套立绘构图不同，窗口尺寸得先跟着换，再让前端换图
    crate::pet::apply_style_size(&app, style);
    let _ = app.emit_to("main", crate::pet::EVENT_STYLE, style.as_str());
    settings_view(&app)
}

/// 用户已经多久没碰键鼠（秒）。桌宠按这个决定「要不要打盹」，
/// 而不是按「多久没点我」——用户在写代码时她该安静待着，不该自己睡过去。
#[tauri::command]
pub fn system_idle() -> u64 {
    crate::idle::idle_seconds()
}

/// 开关 Live2D 动态立绘。Core 的加载在前端（按需注入脚本），这里负责落盘和通知。
///
/// **不动窗口尺寸**：动态立绘那个模型实测宽高比 0.43，和静态写实的 0.506 同一个
/// 量级，竖窗本来就合适；立绘自己按包围盒等比贴底，见 `src/live2d/fit.ts`。
#[tauri::command]
pub fn set_pet_live2d(app: tauri::AppHandle, on: bool) -> SettingsView {
    use tauri::Emitter;

    let mut settings = crate::settings::load(&app);
    settings.pet_live2d = on;
    crate::settings::save(&app, settings);
    let _ = app.emit_to("main", crate::pet::EVENT_LIVE, on);
    settings_view(&app)
}

/// 把网页传上来的 RGBA 像素写成 PNG，调试渲染用。
///
/// 只在排查问题时用（比如 Live2D 画出来不对），正式路径不会调。
#[tauri::command]
pub fn web_dump_pixels(width: u32, height: u32, rgba_base64: String) -> Result<String, String> {
    use base64::Engine;

    let raw = base64::engine::general_purpose::STANDARD
        .decode(rgba_base64.as_bytes())
        .map_err(|err| format!("base64 解不开：{err}"))?;
    let buffer = image::RgbaImage::from_raw(width, height, raw)
        .ok_or_else(|| "像素数量对不上".to_string())?;
    let path = std::env::temp_dir().join("whale-live2d.png");
    buffer.save(&path).map_err(|err| format!("写 PNG 失败：{err}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 把网页里的日志转发到终端。
///
/// tauri dev 的终端看不到 WebView2 的 console，而「Live2D 到底画出来没有」这种
/// 自检结果必须能看见——总不能每次都靠肉眼盯窗口。
#[tauri::command]
pub fn web_log(message: String) {
    eprintln!("[web] {message}");
}

/// 用系统默认浏览器打开链接（扫码结果里的网址走这里）。
///
/// 只放行 http/https：扫码内容来自屏幕上的任意图形，`file:` / `javascript:`
/// 这类协议不该因为「扫了一下」就被打开。参数直接交给进程、不经过 shell，
/// 所以 URL 里的 `&` `|` 之类不会被当成命令分隔符。
#[tauri::command]
pub fn open_url(url: String) -> AppResult<()> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(AppError::Invalid("只支持打开网页链接".into()));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("rundll32");
        command.args(["url.dll,FileProtocolHandler", url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|err| AppError::Other(format!("打不开浏览器：{err}")))
}

/// 清空历史（软删所有已完成的待办），返回清掉的条数。
#[tauri::command]
pub fn clear_history(db: State<'_, Db>) -> AppResult<usize> {
    let guard = conn(&db)?;
    task::clear_done(&guard)
}

/* ---------------------------------------------------------------- 备忘 */

#[tauri::command]
pub fn list_notes(db: State<'_, Db>, filter: Option<NoteFilter>) -> AppResult<Vec<Note>> {
    let guard = conn(&db)?;
    note::list(&guard, &filter.unwrap_or_default())
}

#[tauri::command]
pub fn create_note(db: State<'_, Db>, input: NewNote) -> AppResult<Note> {
    let guard = conn(&db)?;
    note::create(&guard, input)
}

/// 改正文、置顶或标签。只传要改的字段，都不传等于什么都没做。
#[tauri::command]
pub fn update_note(db: State<'_, Db>, id: String, patch: NotePatch) -> AppResult<Note> {
    let guard = conn(&db)?;
    note::update(&guard, &id, patch)
}

#[tauri::command]
pub fn delete_note(db: State<'_, Db>, id: String) -> AppResult<()> {
    let guard = conn(&db)?;
    note::delete(&guard, &id)
}

#[tauri::command]
pub fn list_tags(db: State<'_, Db>) -> AppResult<Vec<TagView>> {
    let guard = conn(&db)?;
    tag::list(&guard)
}

/// 新建标签。同名会直接返回已有的那个，前端把它选中即可。
#[tauri::command]
pub fn create_tag(db: State<'_, Db>, name: String) -> AppResult<TagView> {
    let guard = conn(&db)?;
    tag::create(&guard, &name)
}

/// 删标签：连带把它从所有备忘上摘掉。
#[tauri::command]
pub fn delete_tag(db: State<'_, Db>, id: String) -> AppResult<()> {
    let guard = conn(&db)?;
    tag::delete(&guard, &id)
}
