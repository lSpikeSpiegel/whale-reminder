//! 面板搜索：本机「应用」和「文件」。
//!
//! 两条腿，各管一段：
//!
//! - **应用**：扫开始菜单（全局 + 当前用户）和桌面上的 `.lnk` / `.url`。几百个文件，
//!   建索引是毫秒级，不依赖任何外部工具，所以应用搜索永远可用。
//! - **文件**：本机全盘的名字索引只有 Everything 有，所以优先把查询交给它的官方命令行
//!   `es.exe`（见 <https://www.voidtools.com/support/everything/command_line_interface/>）。
//!   没装 Everything、没放 `es.exe`、或者 Everything 当前没在跑，就退回「常用目录」的
//!   本地索引（桌面 / 文档 / 下载）——宁可少搜几个盘，也别让默认页一片空白。
//!
//! **为什么走 `es.exe` 而不是 SDK 的 `Everything64.dll`**：DLL 是同步接口、还带 UTF-16
//! 路径，性能最好，但它要求用户的 Everything 安装目录里恰好有那个 DLL，而且得手写
//! `unsafe` 的 FFI；DLL 不在时我们拿不到任何反馈，只能静默失效。`es.exe` 是官方 CLI，
//! 失败会给出明确的退出码（7 = IPC 出错，8 = Everything 没在跑），解析的是文本，
//! 出问题能看见、能降级。等以后真要压到 10ms 以内再换 DLL，接口（`run_es`）留在这一层。
//!
//! 索引只放内存，不落盘：桌面 / 文档 / 下载加起来几万条，重建一次一秒以内，
//! 落盘还要处理「文件已经删了但索引还在」的过期问题，不划算。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, AppResult};

/// 一次搜索最多返回多少条（前端每次传自己的上限，这里是兜底）
pub const MAX_HITS: usize = 40;

/// 本地索引最多收多少条文件。桌面 / 文档 / 下载正常也就几千到几万，
/// 设个上限是防「把整个用户目录拖进索引」——那会让每次按键都要扫几十万条。
const INDEX_CAP: usize = 40_000;

/// 本地索引往下钻几层。太浅搜不到 `工作/2026/项目/x.pdf`，太深会把 node_modules 全吃掉。
const INDEX_DEPTH: usize = 4;

/// 建应用索引时往下钻几层。开始菜单一般是「厂商 / 应用」两层。
const APP_DEPTH: usize = 3;

/// 建文件索引时直接跳过的目录名。
///
/// 这些目录里的东西用户不会去「搜」，但文件数能占掉一半预算。
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    ".svn",
    ".hg",
    ".idea",
    ".vscode",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
    "AppData",
    "Windows",
];

/* ---------------------------------------------------------------- 数据结构 */

/// 一条搜索结果。
///
/// `lower` 是小写化的名字，只给打分用：每次按键都要在几万条上比一遍，
/// 现算 `to_lowercase()` 会白白分配几万次字符串。
#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub name: String,
    pub path: String,
    /// `app` / `file` / `dir`，前端按它挑图标和文案
    pub kind: &'static str,
    #[serde(skip)]
    lower: String,
}

impl Hit {
    fn new(name: String, path: String, kind: &'static str) -> Self {
        let lower = name.to_lowercase();
        Self {
            name,
            path,
            kind,
            lower,
        }
    }
}

/// 一次查询的结果。应用和文件分开给，前端好分组、好排序。
#[derive(Debug, Serialize)]
pub struct Hits {
    pub apps: Vec<Hit>,
    pub files: Vec<Hit>,
    /// 这批文件结果从哪来的：`everything` / `index` / `none`（没查询，或索引还没建好）
    pub engine: String,
    /// 降级原因。前端拿它显示一行小字，比如「Everything 没在运行，已退回本地索引」
    pub notice: Option<String>,
}

impl Hits {
    fn empty(engine: &str, notice: Option<String>) -> Self {
        Self {
            apps: Vec::new(),
            files: Vec::new(),
            engine: engine.to_string(),
            notice,
        }
    }
}

/// 前端进搜索页时问一次：接没接上 Everything、索引建好没有、覆盖了哪些目录。
#[derive(Debug, Clone, Serialize)]
pub struct SearchStatus {
    /// `es.exe` 的路径；null 表示没找到（要么没装 Everything，要么只装了主程序）
    pub es: Option<String>,
    /// 装了 Everything 本体（找到了 `Everything.exe`）
    pub everything: bool,
    /// 索引建好了没有。建索引在后台线程跑，冷启动时前端会先看到 false
    pub ready: bool,
    pub apps: usize,
    pub files: usize,
    /// 本地索引覆盖的目录，前端在降级时把这几条路径说给用户听
    pub roots: Vec<String>,
}

/// 索引本体。全部内存态，重建就是整体替换。
#[derive(Default)]
struct Inner {
    apps: Vec<Hit>,
    files: Vec<Hit>,
    roots: Vec<PathBuf>,
    es: Option<PathBuf>,
    everything: bool,
    ready: bool,
}

/// 挂在 Tauri 上的搜索索引。读多写少，用 `RwLock` 就够。
pub struct SearchIndex {
    inner: RwLock<Inner>,
}

impl Default for SearchIndex {
    fn default() -> Self {
        Self {
            inner: RwLock::new(Inner::default()),
        }
    }
}

impl SearchIndex {
    /// 重建索引（建完整体替换，读的人永远看到一份完整快照）。
    ///
    /// 会走磁盘扫描，**必须**在后台线程里调，别放在命令的同步路径上。
    pub fn rebuild<R: Runtime>(&self, app: &AppHandle<R>) {
        let apps = build_apps();
        let roots = file_roots(app);

        let mut files = Vec::new();
        let mut budget = INDEX_CAP;
        for root in &roots {
            walk_files(root, INDEX_DEPTH, &mut files, &mut budget);
        }

        let es = find_es();

        // 自检：搜不到文件时先看这一行——是索引没建、还是 es.exe 没找到
        eprintln!(
            "[search] 索引就绪：{} 个应用 / {} 个文件；es.exe {}",
            apps.len(),
            files.len(),
            match es.as_ref() {
                Some(path) => path.display().to_string(),
                None => "未找到（只搜常用目录）".to_string(),
            }
        );

        if let Ok(mut guard) = self.inner.write() {
            *guard = Inner {
                apps,
                files,
                roots,
                es,
                everything: find_everything(),
                ready: true,
            };
        }
    }

    pub fn status(&self) -> SearchStatus {
        let Ok(guard) = self.inner.read() else {
            return SearchStatus {
                es: None,
                everything: false,
                ready: false,
                apps: 0,
                files: 0,
                roots: Vec::new(),
            };
        };
        SearchStatus {
            es: guard
                .es
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            everything: guard.everything,
            ready: guard.ready,
            apps: guard.apps.len(),
            files: guard.files.len(),
            roots: guard
                .roots
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        }
    }

    fn es_path(&self) -> Option<PathBuf> {
        self.inner.read().ok().and_then(|guard| guard.es.clone())
    }

    fn apps(&self, query: &str, limit: usize) -> Vec<Hit> {
        match self.inner.read() {
            Ok(guard) => top(&guard.apps, query, limit),
            Err(_) => Vec::new(),
        }
    }

    fn files(&self, query: &str, limit: usize) -> Vec<Hit> {
        match self.inner.read() {
            Ok(guard) => top(&guard.files, query, limit),
            Err(_) => Vec::new(),
        }
    }

    fn is_ready(&self) -> bool {
        self.inner.read().map(|guard| guard.ready).unwrap_or(false)
    }
}

/* ---------------------------------------------------------------- 打分 */

/// 给一条命中打分，`None` 表示不匹配。
///
/// 只看**名字**，不看完整路径：用户敲「报告」是想找 `报告.docx`，不是想把
/// `D:\报告归档\…` 下的两千个文件全捞出来。Everything 那一路也是按文件名搜的，
/// 两边口径一致。
///
/// 分值只是排序依据，具体数字没有含义，只要相对大小对：
/// 完全相等 > 从头匹配 > 命中位置靠前 > 包含 > 子序列（`vsc` → `Visual Studio Code`）。
fn score(hit: &Hit, query: &str) -> Option<i32> {
    if query.is_empty() {
        return None;
    }
    let name = hit.lower.as_str();

    if name == query {
        return Some(1000);
    }
    if let Some(rest) = name.strip_prefix(query) {
        // 前缀命中：剩下的越短说明越贴题（「微信」比「微信开发者工具」更像要找的）
        return Some(900 - (rest.chars().count() as i32).min(90));
    }
    if let Some(pos) = name.find(query) {
        return Some(700 - (pos as i32).min(90));
    }
    if subsequence(name, query) {
        return Some(400);
    }
    None
}

/// query 的字符是否按顺序出现在 name 里（不要求连续）。
///
/// 这是「首字母缩写」那一类输入的兜底：`vsc` → `Visual Studio Code`。
/// 只对短查询开这个口子，否则一个字的查询会把半屏都判成命中。
fn subsequence(name: &str, query: &str) -> bool {
    if query.chars().count() < 2 {
        return false;
    }
    let mut wanted = query.chars();
    let mut next = wanted.next();
    for ch in name.chars() {
        let Some(target) = next else {
            return true;
        };
        if ch == target {
            next = wanted.next();
        }
    }
    next.is_none()
}

/// 从一组命中里挑前 `limit` 条。
fn top(items: &[Hit], query: &str, limit: usize) -> Vec<Hit> {
    let mut scored: Vec<(i32, &Hit)> = items
        .iter()
        .filter_map(|hit| score(hit, query).map(|score| (score, hit)))
        .collect();

    // 同分时短名字优先（「微信」排在「微信开发者工具」前面），再按名字定序，避免结果跳动
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.lower.len().cmp(&b.1.lower.len()))
            .then_with(|| a.1.lower.cmp(&b.1.lower))
    });

    scored
        .into_iter()
        .take(limit)
        .map(|(_, hit)| hit.clone())
        .collect()
}

/* ---------------------------------------------------------------- 应用索引 */

/// 应用索引的来源目录。
///
/// 只认快捷方式：真正的 `.exe` 散落在各种 `Program Files` 深处，全盘找它们又慢又没必要——
/// 用户能「点一下就开」的入口，安装时本来就会在开始菜单或桌面挂一个 `.lnk`。
/// （UWP 应用不在开始菜单的 `.lnk` 里，它们由 shell:AppsFolder 提供，暂不覆盖。）
fn app_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = std::env::var("ProgramData") {
        roots.push(PathBuf::from(dir).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Ok(dir) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(dir).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Ok(dir) = std::env::var("USERPROFILE") {
        roots.push(PathBuf::from(dir).join("Desktop"));
    }
    roots.retain(|path| path.is_dir());
    roots
}

/// 建应用索引。
fn build_apps() -> Vec<Hit> {
    let mut apps = Vec::new();
    for root in app_roots() {
        walk_apps(&root, APP_DEPTH, &mut apps);
    }

    // 全局和当前用户的开始菜单常常各放一份同名的快捷方式，留先出现的那份（全局在前）
    apps.sort_by(|a, b| a.lower.cmp(&b.lower));
    apps.dedup_by(|next, kept| next.lower == kept.lower);
    apps
}

fn walk_apps(dir: &Path, depth: usize, out: &mut Vec<Hit>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            walk_apps(&path, depth - 1, out);
            continue;
        }

        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ext != "lnk" && ext != "url" {
            continue;
        }

        let Some(name) = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()) else {
            continue;
        };
        if is_noise(&name) {
            continue;
        }
        out.push(Hit::new(name, path.to_string_lossy().into_owned(), "app"));
    }
}

/// 开始菜单里混着的「卸载 xxx」「xxx 帮助」之类不是应用，搜出来只会挤掉真正想找的那条。
fn is_noise(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["卸载", "uninstall", "readme", "帮助", "help"].iter().any(|word| lower.contains(word))
}

/* ---------------------------------------------------------------- 文件索引（兜底） */

/// 本地索引覆盖哪几个目录。
///
/// 走系统的「已知文件夹」而不是手拼 `C:\Users\x\Desktop`：桌面 / 文档 / 下载都可能被
/// 重定向到 OneDrive 或别的盘，手拼出来的路径在那种机器上是空的。
fn file_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let resolver = app.path();
    let mut roots: Vec<PathBuf> = [
        resolver.desktop_dir(),
        resolver.document_dir(),
        resolver.download_dir(),
    ]
    .into_iter()
    .filter_map(Result::ok)
    .collect();

    roots.retain(|path| path.is_dir());
    roots.sort();
    roots.dedup();
    roots
}

fn walk_files(dir: &Path, depth: usize, out: &mut Vec<Hit>, budget: &mut usize) {
    if depth == 0 || *budget == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        if *budget == 0 {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // 隐藏目录（`.git` / `$RECYCLE.BIN`）不进索引
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }

        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if SKIP_DIRS.iter().any(|skip| name.eq_ignore_ascii_case(skip)) {
                continue;
            }
            walk_files(&path, depth - 1, out, budget);
            continue;
        }

        *budget -= 1;
        out.push(Hit::new(name, path.to_string_lossy().into_owned(), "file"));
    }
}

/* ---------------------------------------------------------------- Everything */

/// 找 `es.exe`：先在 PATH 里找，再看 Everything 常见安装位置。
fn find_es() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend(everything_dirs());
    dirs.into_iter()
        .map(|dir| dir.join("es.exe"))
        .find(|path| path.is_file())
}

/// Everything 本体在不在。装了但没 `es.exe` 时，前端要能说清「差的是哪个文件」，
/// 而不是笼统地说「未检测到 Everything」。
fn find_everything() -> bool {
    everything_dirs().iter().any(|dir| {
        dir.join("Everything.exe").is_file() || dir.join("Everything64.exe").is_file()
    })
}

fn everything_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        let Ok(base) = std::env::var(var) else {
            continue;
        };
        let base = PathBuf::from(base);
        dirs.push(base.join("Everything"));
        // 便携版 / 用户级安装会落在 `%LOCALAPPDATA%\Programs\Everything`
        dirs.push(base.join("Programs").join("Everything"));
    }
    dirs
}

/// `es.exe` 的三种结局。分开是因为三种要跟用户说的话完全不同。
#[derive(Debug, PartialEq, Eq)]
enum EsOutcome {
    Hits(Vec<String>),
    /// Everything 没在跑，或者它的 IPC 窗口找不到（退出码 7 / 8）
    NotRunning,
    Failed(String),
}

fn run_es(es: &Path, query: &str, limit: usize) -> EsOutcome {
    let limit = limit.to_string();

    // `-timeout`：刚开机时 Everything 还没把库读进内存，默认会直接返回空结果，
    // 等它几百毫秒比「明明有文件却搜不到」好。（`-n` 是结果条数上限）
    let output = Command::new(es)
        .args([
            "-n",
            limit.as_str(),
            "-timeout",
            "600",
            "-full-path",
            query,
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();

    let output = match output {
        Ok(output) => output,
        Err(err) => return EsOutcome::Failed(format!("调不起 es.exe：{err}")),
    };

    match output.status.code() {
        Some(0) => EsOutcome::Hits(parse_es_output(&decode(&output.stdout))),
        // 7 = IPC 查询失败，8 = 找不到 Everything 的 IPC 窗口（没在运行）
        Some(7) | Some(8) => EsOutcome::NotRunning,
        other => EsOutcome::Failed(format!("es.exe 退出码 {other:?}")),
    }
}

/// 从 `es.exe` 的输出里取完整路径。
///
/// 不假设列数：`es` 的默认输出列会跟着 `es.ini` 和版本变（`-full-path` 只是多加一列，
/// 制表符分隔），所以每行取**最后一个**制表符之后的那段，再按「像个绝对路径」过一遍。
/// 这样无论它给的是「名称 + 路径」还是光秃秃一条路径，都能拿到对的东西。
fn parse_es_output(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let last = line.rsplit('\t').next().unwrap_or(line).trim();
            let last = last.trim_matches('"');
            // `C:\x` 或 UNC `\\server\share` 才算路径，别把 help 文本、表头当成结果
            let is_path = last.len() > 2 && (last.as_bytes().get(1) == Some(&b':') || last.starts_with(r"\\"));
            if !is_path {
                return None;
            }
            // es 给文件夹补了结尾的反斜杠，靠它区分文件和目录，省掉一次 stat
            Some(last.to_string())
        })
        .collect()
}

/// 把 `es.exe` 的 stdout 解成字符串。
///
/// es 的输出跟着控制台代码页走，中文系统上是 GBK：直接按 UTF-8 解会把「桌面」变成一堆
/// 替换字符（还看不出来，因为路径确实存在，只是打不开）。所以先试 UTF-8，不成再按 GB18030。
fn decode(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => encoding_rs::GB18030
            .decode_without_bom_handling(bytes)
            .0
            .into_owned(),
    }
}

/// 把 es 给出的路径变成一条命中。
fn hit_from_path(path: &str) -> Hit {
    let is_dir = path.ends_with('\\') || path.ends_with('/');
    let trimmed = path.trim_end_matches(|ch| ch == '\\' || ch == '/');
    let name = trimmed
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(trimmed)
        .to_string();
    Hit::new(name, trimmed.to_string(), if is_dir { "dir" } else { "file" })
}

/* ---------------------------------------------------------------- 查询 */

/// 查一次。应用永远走本地索引（快、准、不受 Everything 影响），
/// 文件优先走 Everything，走不了再退回本地索引。
pub fn query<R: Runtime>(app: &AppHandle<R>, text: &str, limit: usize) -> Hits {
    let query = text.trim().to_lowercase();
    let limit = limit.clamp(1, MAX_HITS);

    let Some(index) = app.try_state::<SearchIndex>() else {
        return Hits::empty("none", Some("搜索模块没初始化".into()));
    };
    if query.is_empty() {
        let engine = if index.es_path().is_some() { "everything" } else { "index" };
        return Hits::empty(engine, None);
    }

    let apps = index.apps(&query, limit);

    if let Some(es) = index.es_path() {
        match run_es(&es, &query, limit) {
            EsOutcome::Hits(paths) => {
                let files = paths.iter().take(limit).map(|path| hit_from_path(path)).collect();
                return Hits {
                    apps,
                    files,
                    engine: "everything".into(),
                    notice: None,
                };
            }
            EsOutcome::NotRunning => {
                return Hits {
                    apps,
                    files: index.files(&query, limit),
                    engine: "index".into(),
                    notice: Some("Everything 没在运行，这次只搜了常用目录".into()),
                };
            }
            EsOutcome::Failed(reason) => {
                return Hits {
                    apps,
                    files: index.files(&query, limit),
                    engine: "index".into(),
                    notice: Some(format!("{reason}，这次只搜了常用目录")),
                };
            }
        }
    }

    let ready = index.is_ready();
    Hits {
        apps,
        files: index.files(&query, limit),
        engine: if ready { "index".into() } else { "none".into() },
        notice: None,
    }
}

/* ---------------------------------------------------------------- 打开 */

/// 用系统默认程序打开一条结果。
///
/// 走 `ShellExecuteW` 而不是 `cmd /c start`：路径里带空格、`&`、中文都很常见，
/// 拼进 shell 命令行会有一堆转义坑（`start` 还会把第一个带引号的参数当窗口标题）。
/// `.lnk` 也能直接交给它，不用自己解析快捷方式的目标。
#[cfg(windows)]
fn shell_open(path: &Path) -> AppResult<()> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file = wide(path.as_os_str());
    let verb = wide(std::ffi::OsStr::new("open"));

    let code = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;

    // 返回值是个 HINSTANCE，但 ShellExecute 的历史包袱是「> 32 才算成功」
    if code <= 32 {
        eprintln!(
            "[search] 打开失败：{} → rc={code}（{}）",
            path.display(),
            shell_reason(code)
        );
        return Err(AppError::Other(format!(
            "打不开（{}）：{}",
            shell_reason(code),
            path.display()
        )));
    }

    // 自检：rc 成立但窗口没出来时先看这一行。多半不是 ShellExecute 的问题，
    // 而是进程环境被污染了——比如继承到 `ELECTRON_RUN_AS_NODE`，
    // 那种情况下 Electron 应用会以 Node 模式一闪而过（见 `lib.rs::scrub_electron_env`）。
    eprintln!("[search] 已交给系统打开：{} → rc={code}", path.display());
    Ok(())
}

/// 把 ShellExecute 的错误码翻成人话。
///
/// 这些码是 `ShellExecute` 返回值里那几个「≤ 32」的魔法数字（WinError 与 SE_ERR_* 混用），
/// 直接甩给用户等于没说。
#[cfg(windows)]
fn shell_reason(code: isize) -> &'static str {
    match code {
        0 => "系统忙或内存不足",
        2 | 3 => "文件已经不在了",
        5 => "权限不够，可能要以管理员身份运行",
        11 => "这不是一个能运行的程序",
        26 => "文件正被别的程序占用",
        27 | 31 => "没有能打开它的程序",
        28 | 29 | 30 => "目标程序没响应",
        32 => "缺少它需要的运行库",
        _ => "系统没有接这个活",
    }
}

#[cfg(not(windows))]
fn shell_open(path: &Path) -> AppResult<()> {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(opener)
        .arg(path)
        .stdin(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|err| AppError::Other(format!("打不开：{err}")))
}

#[cfg(windows)]
fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    text.encode_wide().chain(std::iter::once(0)).collect()
}

/* ---------------------------------------------------------------- 打开记录 */

/// 最近打开留几条。
///
/// 3 列 × 3 行——436 宽的面板里正好一屏，不用滚动。这块的用处是「一眼看到上次用过
/// 的那个东西」，不是翻旧账，所以宁可少留几条也别让它变成一列要滚的清单。
const MAX_HISTORY: usize = 9;

/// 一条「打开过」的记录。
///
/// 只记打开过的条目，**不记搜索词**：回到空输入框时，用户想看的是「上次打开的那个文件」，
/// 不是「我上周搜过什么」。字段全部 `#[serde(default)]`，手改配置文件写残了也只丢一条。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub name: String,
    pub path: String,
    /// `app` / `file` / `dir`。存字符串而不是枚举：写进来认不出的值前端会退化成文件图标，
    /// 不值得为它让整份历史解析失败
    #[serde(default)]
    pub kind: String,
    /// 最后一次打开的时刻，UTC RFC3339
    #[serde(default)]
    pub at: String,
}

fn history_path() -> PathBuf {
    crate::db::data_dir().join("search_history.json")
}

/// 读历史。文件缺失、被改坏都退化成「没有历史」——记录丢了是小事，
/// 让搜索页打不开是大事。
fn load_history() -> Vec<HistoryEntry> {
    fs::read(history_path())
        .ok()
        .and_then(|bytes| parse_history(&bytes))
        .unwrap_or_default()
}

/// 单独拆出来是为了能单测「文件被改坏了会怎样」。
fn parse_history(bytes: &[u8]) -> Option<Vec<HistoryEntry>> {
    serde_json::from_slice::<Vec<HistoryEntry>>(bytes).ok()
}

fn save_history(entries: &[HistoryEntry]) -> AppResult<()> {
    let bytes = serde_json::to_vec(entries)
        .map_err(|err| AppError::Other(format!("搜索历史编码失败：{err}")))?;
    // 原子写：半截 JSON 读不出来，会静默退化成「没有历史」
    crate::fsutil::write_atomic(&history_path(), &bytes)
}

/// 记一条：同一路径只留一行，重复打开顶到最前；超出上限从尾部裁掉。
///
/// 抽成纯函数（不碰文件）是为了能直接单测顺序和去重。
fn push_entry(entries: &mut Vec<HistoryEntry>, entry: HistoryEntry) {
    entries.retain(|item| !same_path(&item.path, &entry.path));
    entries.insert(0, entry);
    entries.truncate(MAX_HISTORY);
}

/// 同一条路径可能有两种写法进来：Everything 会给目录补结尾反斜杠，
/// 而 Windows 的路径本来就大小写不敏感。
fn same_path(left: &str, right: &str) -> bool {
    let normalize = |text: &str| {
        text.trim_end_matches(|ch| ch == '\\' || ch == '/')
            .to_lowercase()
    };
    normalize(left) == normalize(right)
}

/* ---------------------------------------------------------------- 命令 */

#[tauri::command]
pub fn search_status(app: AppHandle) -> SearchStatus {
    app.try_state::<SearchIndex>()
        .map(|index| index.status())
        .unwrap_or(SearchStatus {
            es: None,
            everything: false,
            ready: false,
            apps: 0,
            files: 0,
            roots: Vec::new(),
        })
}

/// 搜一次。
///
/// 是 `async` 的：里面要起 `es.exe` 进程（几十毫秒），同步命令会占着主线程，
/// 而这是**键盘输入**的路径，卡一下就是「打字跟不上」。
#[tauri::command]
pub async fn search_query(
    app: AppHandle,
    text: String,
    limit: Option<usize>,
) -> AppResult<Hits> {
    let limit = limit.unwrap_or(MAX_HITS);
    tauri::async_runtime::spawn_blocking(move || query(&app, &text, limit))
        .await
        .map_err(|err| AppError::Other(format!("搜索失败：{err}")))
}

/// 同一个应用在几秒内只拉起一次。
///
/// 触发这个的场景很实际：双击结果的两下都会派发 `click`；或者用户看 IDE 半天没出来，
/// 重开面板又点了一次。同一个程序被拉起两个实例时，JetBrains 系的 `.port` / `.lock`
/// 会直接打架（实机报过 `AccessDeniedException: ...\.port` + `Address already in use`）。
///
/// 只拦「应用」：同一个文件开两次可能是用户故意的（比如两个窗口对照看）。
const APP_REOPEN_GUARD: Duration = Duration::from_secs(4);
static LAST_APP_LAUNCH: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// 纯判断，拆出来是为了能单测——全局状态在并行测试里不好摆。
fn repeated_within(
    last: &Option<(String, Instant)>,
    path: &str,
    now: Instant,
    window: Duration,
) -> bool {
    last.as_ref()
        .is_some_and(|(previous, at)| previous == path && now.duration_since(*at) < window)
}

fn launched_recently(path: &str) -> bool {
    match LAST_APP_LAUNCH.lock() {
        Ok(last) => repeated_within(&last, path, Instant::now(), APP_REOPEN_GUARD),
        // 锁中毒就当没记录过：宁可多开一次，也别让「打开」按钮失灵
        Err(_) => false,
    }
}

fn remember_launch(path: &str) {
    if let Ok(mut last) = LAST_APP_LAUNCH.lock() {
        *last = Some((path.to_string(), Instant::now()));
    }
}

/// 打开一条结果，并记进「最近打开」。
///
/// 返回记录之后的历史：前端拿返回值直接重排卡片，不用再问一次（和 `tool_open` 一个套路）。
/// `name` / `kind` 由前端带上（它手上就有），缺了就从路径反推——反推不出来
/// 「微信」这种快捷方式的显示名，只会得到 `微信.lnk`。
#[tauri::command]
pub fn search_open(
    path: String,
    name: Option<String>,
    kind: Option<String>,
) -> AppResult<Vec<HistoryEntry>> {
    let target = PathBuf::from(path.trim());
    let exists = target.exists();

    // 自检：点了结果却没反应时，先看这一行。
    // 没出现 = 请求压根没到后端（前端就断了）；出现但「不存在」= 索引里的路径已经过期。
    eprintln!(
        "[search] 打开请求：{}（{}）",
        target.display(),
        if exists { "存在" } else { "不存在" }
    );

    if !exists {
        return Err(AppError::NotFound(format!(
            "{}（可能已经被删掉了，刷新一下索引）",
            target.display()
        )));
    }

    let is_app = kind.as_deref() == Some("app");
    let key = target.to_string_lossy().to_string();
    if is_app && launched_recently(&key) {
        eprintln!("[search] 刚拉起过，忽略重复请求：{}", target.display());
        return Ok(load_history());
    }

    // 自检：ShellExecute 正常应该只有几毫秒。如果是几秒，说明被 DDE / 启动器拖住了，
    // 那种情况前端把面板藏掉之后用户只会觉得「点了没反应」，得从这行看出来。
    let started = Instant::now();
    shell_open(&target)?;
    if is_app {
        remember_launch(&key);
    }
    eprintln!(
        "[search] ShellExecute 用时 {}ms",
        started.elapsed().as_millis()
    );

    // 打开成功才记：打不开的条目留在历史里，只会让人反复点到同一个错误
    let fallback = hit_from_path(&target.to_string_lossy());
    let entry = HistoryEntry {
        name: name
            .filter(|text| !text.trim().is_empty())
            .unwrap_or(fallback.name),
        path: fallback.path,
        kind: kind.unwrap_or_else(|| fallback.kind.to_string()),
        at: crate::db::now_iso(),
    };

    let mut entries = load_history();
    push_entry(&mut entries, entry);
    // 历史写不进去不该把「已经打开了」变成一次失败，所以这里吞掉错误
    let _ = save_history(&entries);
    Ok(entries)
}

/// 最近打开过的应用 / 文件。搜索页空着的时候铺成网格。
#[tauri::command]
pub fn search_history() -> Vec<HistoryEntry> {
    load_history()
}

/// 从最近打开里移除一条（卡片右上角的 ×）。
#[tauri::command]
pub fn search_forget(path: String) -> AppResult<Vec<HistoryEntry>> {
    let mut entries = load_history();
    entries.retain(|item| !same_path(&item.path, &path));
    save_history(&entries)?;
    Ok(entries)
}

/// 清空最近打开。
#[tauri::command]
pub fn search_history_clear() -> AppResult<()> {
    save_history(&[])
}

/// 在资源管理器里定位这条结果（右键「在文件夹中显示」的等价物）。
#[tauri::command]
pub fn search_reveal(path: String) -> AppResult<()> {
    let target = PathBuf::from(path.trim());
    if !target.exists() {
        return Err(AppError::NotFound(format!("{} 已经不在这个位置了", target.display())));
    }

    #[cfg(windows)]
    {
        // `/select,` 和路径之间**不能**有空格，而且整体要作为同一个参数交给 explorer，
        // 否则带空格的路径会被拆成两个参数
        Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .stdin(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|err| AppError::Other(format!("打不开所在文件夹：{err}")))
    }

    #[cfg(not(windows))]
    {
        let dir = target.parent().unwrap_or(Path::new("."));
        shell_open(dir)
    }
}

/// 手动重建索引（设置页 / 换了 Everything 之后用）。
#[tauri::command]
pub fn search_reindex(app: AppHandle) {
    spawn_build(&app);
}

/// 后台建索引。启动时调一次：几万条文件 + 几百个快捷方式，冷启动一秒以内，
/// 但也没必要占着 setup 的位置，前端会先看到 `ready: false` 并自己轮询。
pub fn spawn_build<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let Some(index) = handle.try_state::<SearchIndex>() else {
            return;
        };
        index.rebuild(&handle);

        // 只读探针：`WHALE_SEARCH_PROBE=open` 时把这条查询的前几条命中打出来（不打开任何东西）。
        // 用来还原「用户搜到了、点开却没反应」时的那一屏。验完删掉。
        #[cfg(debug_assertions)]
        if let Ok(text) = std::env::var("WHALE_SEARCH_PROBE") {
            let hits = query(&handle, &text, 8);
            eprintln!(
                "[probe] 「{text}」→ 应用 {} 条 / 文件 {} 条",
                hits.apps.len(),
                hits.files.len()
            );
            for hit in hits.apps.iter().chain(hits.files.iter()) {
                eprintln!(
                    "[probe]   {} | {} | {}",
                    hit.name,
                    hit.path,
                    if Path::new(&hit.path).exists() {
                        "存在"
                    } else {
                        "不存在"
                    }
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn hit(name: &str) -> Hit {
        Hit::new(name.to_string(), format!(r"C:\x\{name}"), "file")
    }

    #[test]
    fn exact_and_prefix_beat_contains() {
        let exact = score(&hit("报告"), "报告").unwrap();
        let prefix = score(&hit("报告草稿"), "报告").unwrap();
        let contains = score(&hit("季度报告草稿"), "报告").unwrap();

        assert!(exact > prefix, "完全相等要排最前");
        assert!(prefix > contains, "从头匹配要压过中间命中");
        assert_eq!(score(&hit("周报"), "报告"), None, "没有的就不该出现");
    }

    #[test]
    fn shorter_remainder_wins_among_prefix_hits() {
        let short = score(&hit("微信"), "微").unwrap();
        let long = score(&hit("微信开发者工具"), "微").unwrap();
        assert!(short > long);
    }

    #[test]
    fn initials_match_as_subsequence() {
        // 「vsc」按首字母摸到了 Visual Studio Code（不连续）
        assert_eq!(score(&hit("Visual Studio Code"), "vsc"), Some(400));
        // 单字查询不开放子序列匹配，否则满屏都是命中：它只会落到前缀 / 包含那两档
        let single = score(&hit("Visual Studio Code"), "v").unwrap();
        assert!(single > 400, "单字不该被判成子序列命中：{single}");
    }

    #[test]
    fn top_prefers_score_then_short_name() {
        let items = vec![hit("报告草稿"), hit("报告"), hit("季度报告")];
        let best = top(&items, "报告", 10);
        assert_eq!(best[0].name, "报告");
        assert_eq!(best.len(), 3);
        // limit 要生效
        assert_eq!(top(&items, "报告", 1).len(), 1);
    }

    #[test]
    fn parses_everything_output_variants() {
        // -full-path 的输出：「名称 \t 路径」；也可能只有路径
        let text = "报告.docx\tC:\\Users\\x\\Desktop\\报告.docx\r\n\
                    C:\\Users\\x\\Desktop\\草稿\r\n\
                    \r\n\
                    Everything is not running\r\n";
        let paths = parse_es_output(text);

        assert_eq!(
            paths,
            vec![
                r"C:\Users\x\Desktop\报告.docx".to_string(),
                r"C:\Users\x\Desktop\草稿".to_string(),
            ]
        );
    }

    #[test]
    fn folder_paths_keep_their_trailing_separator_for_kind() {
        let dir = hit_from_path(r"C:\Users\x\Desktop\项目\");
        assert_eq!(dir.kind, "dir");
        // 展示时不带那个反斜杠，否则看着像路径截断了
        assert_eq!(dir.path, r"C:\Users\x\Desktop\项目");
        assert_eq!(dir.name, "项目");

        let file = hit_from_path(r"C:\Users\x\Desktop\报告.docx");
        assert_eq!(file.kind, "file");
        assert_eq!(file.name, "报告.docx");
    }

    #[test]
    fn decodes_gbk_when_output_is_not_utf8() {
        // 中文 Windows 上 es.exe 的输出是 GBK：「桌面」= 0xD7 0xC0 0xC3 0xE6
        let gbk = [0xD7u8, 0xC0, 0xC3, 0xE6];
        assert_eq!(decode(&gbk), "桌面");
        // 本来就是 UTF-8 的不能被重新解释一遍
        assert_eq!(decode("桌面".as_bytes()), "桌面");
    }

    #[test]
    fn file_walk_skips_noise_dirs_and_stops_at_depth() {
        let dir = TempDir::new("search-walk");
        fs::create_dir_all(dir.join("工作/2026")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("工作/2026/报告.docx"), b"x").unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), b"x").unwrap();
        fs::write(dir.join("readme.txt"), b"x").unwrap();

        let mut out = Vec::new();
        let mut budget = 100;
        walk_files(dir.path(), INDEX_DEPTH, &mut out, &mut budget);

        let names: Vec<&str> = out.iter().map(|hit| hit.name.as_str()).collect();
        assert!(names.contains(&"报告.docx"));
        assert!(names.contains(&"readme.txt"));
        assert!(!names.contains(&"index.js"), "node_modules 要跳过");
    }

    #[test]
    fn file_walk_respects_budget() {
        let dir = TempDir::new("search-budget");
        for index in 0..10 {
            fs::write(dir.join(&format!("f{index}.txt")), b"x").unwrap();
        }

        let mut out = Vec::new();
        let mut budget = 3;
        walk_files(dir.path(), INDEX_DEPTH, &mut out, &mut budget);

        assert_eq!(out.len(), 3, "预算用完就停，别把整盘吞进内存");
        assert_eq!(budget, 0);
    }

    #[test]
    fn apps_only_pick_shortcuts_and_drop_uninstallers() {
        let dir = TempDir::new("search-apps");
        fs::create_dir_all(dir.join("工具")).unwrap();
        fs::write(dir.join("微信.lnk"), b"x").unwrap();
        fs::write(dir.join("工具/画图.lnk"), b"x").unwrap();
        fs::write(dir.join("卸载 微信.lnk"), b"x").unwrap();
        fs::write(dir.join("说明.txt"), b"x").unwrap();

        let mut out = Vec::new();
        walk_apps(dir.path(), APP_DEPTH, &mut out);

        let names: Vec<&str> = out.iter().map(|hit| hit.name.as_str()).collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"微信"));
        assert!(names.contains(&"画图"), "子目录里的也要收");
    }

    #[test]
    fn empty_query_matches_nothing() {
        assert_eq!(score(&hit("微信"), ""), None);
        assert!(top(&[], "微信", 10).is_empty());
    }

    /* ------------------------------------------------ 最近打开 */

    fn record(name: &str, path: &str, kind: &str) -> HistoryEntry {
        HistoryEntry {
            name: name.to_string(),
            path: path.to_string(),
            kind: kind.to_string(),
            at: "2026-11-18T07:00:00Z".to_string(),
        }
    }

    #[test]
    fn history_dedupes_and_moves_the_entry_to_the_front() {
        let mut entries = Vec::new();
        push_entry(&mut entries, record("微信", r"C:\a\微信.lnk", "app"));
        push_entry(&mut entries, record("报告.docx", r"C:\b\报告.docx", "file"));
        // 再打开一次「微信」：不该留两行，而且回到最前面
        push_entry(&mut entries, record("微信", r"C:\a\微信.lnk", "app"));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "微信");
    }

    #[test]
    fn history_paths_ignore_case_and_trailing_separator() {
        // Windows 路径大小写不敏感；Everything 给目录补的那条反斜杠也不能算成另一条
        assert!(same_path(r"C:\Users\X\a.txt", r"c:\users\x\a.txt"));
        assert!(same_path(r"C:\Users\X\项目", r"C:\Users\X\项目\"));
        assert!(!same_path(r"C:\a\b.txt", r"C:\a\c.txt"));
    }

    #[test]
    fn history_keeps_only_the_newest_entries() {
        let mut entries = Vec::new();
        for index in 0..MAX_HISTORY + 5 {
            let name = format!("文件{index}");
            push_entry(&mut entries, record(&name, &format!(r"C:\x\{name}.txt"), "file"));
        }

        assert_eq!(entries.len(), MAX_HISTORY);
        // 排在前面的是最后打开的那几个
        assert_eq!(entries[0].name, format!("文件{}", MAX_HISTORY + 4));
    }

    #[test]
    fn repeated_app_launch_is_ignored_within_the_window() {
        let path = concat!(
            r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\",
            r"Android Studio\Android Studio.lnk",
        )
        .to_string();
        let now = Instant::now();

        // 刚拉过：同一个路径要拦（双击、重开面板再点都算同一次）
        assert!(repeated_within(
            &Some((path.clone(), now)),
            &path,
            now,
            APP_REOPEN_GUARD
        ));
        // 别的应用不受影响
        assert!(!repeated_within(
            &Some((path.clone(), now)),
            r"C:\x\WeChat.lnk",
            now,
            APP_REOPEN_GUARD
        ));
        // 过了窗口期就放行：用户真想开第二个窗口时不能被永久挡住
        assert!(!repeated_within(
            &Some((path.clone(), now - APP_REOPEN_GUARD * 2)),
            &path,
            now,
            APP_REOPEN_GUARD
        ));
        assert!(!repeated_within(&None, &path, now, APP_REOPEN_GUARD));
    }

    #[test]
    fn broken_history_file_falls_back_to_empty() {        // 手改坏了 / 断电写了半截：读不出来就当没有历史，不能让搜索页打不开
        assert!(parse_history(b"not json").is_none());
        assert!(parse_history(b"").is_none());

        let ok = parse_history(
            r#"[{"name":"报告","path":"C:\\a\\报告.docx","kind":"file","at":"2026-11-18T07:00:00Z"}]"#
                .as_bytes(),
        );
        assert_eq!(ok.unwrap().len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn shell_error_codes_are_translated() {
        // 这些是 ShellExecute 返回值里「≤ 32 表示失败」的那几个魔法数字。
        // 至少别让用户看到裸的 rc=5
        assert_eq!(shell_reason(5), "权限不够，可能要以管理员身份运行");
        assert_eq!(shell_reason(2), "文件已经不在了");
        assert_eq!(shell_reason(31), "没有能打开它的程序");
        // 不认识的码也要有话说，不能返回空字符串
        assert!(!shell_reason(999).is_empty());
    }
}
