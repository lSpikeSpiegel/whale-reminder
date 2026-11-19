use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// 气泡停留时长的默认值与允许范围（秒）。
///
/// 太短来不及看清，太长又会挡着屏幕不放——设置页只给 10 / 15 / 30 三档，
/// 这里再兜一次边界，免得手改 settings.json 写出离谱的值。
pub const DEFAULT_BUBBLE_SECONDS: u32 = 15;
const MIN_BUBBLE_SECONDS: u32 = 5;
const MAX_BUBBLE_SECONDS: u32 = 120;

/// 面板手动拖出来的尺寸（逻辑像素）。
///
/// **只兜下限、不设上限**：面板本来就是想拉多大拉多大，硬压一个天花板只会让人
/// 在拖到边界时莫名其妙地卡住。下限和窗口上设的 `min_size` 是同一组数，拖拽时由
/// 系统拦住；这里再兜一次是为了手改 settings.json 也能收得回来。
///
/// 拖得比屏幕还大也有救：设置页「面板 → 恢复自动」会把尺寸清掉并重新按内容量。
pub const MIN_PANEL_WIDTH: u32 = 320;
pub const MIN_PANEL_HEIGHT: u32 = 260;

/// 呼出待办面板的全局快捷键默认值。
///
/// 选 `Alt+Space` 是手感优先：一只手就能按，和「随手把面板叫出来」的动作最配。
/// 代价是它也是 uTools、PowerToys Run 这类启动器的默认键，撞上之后 `RegisterHotKey`
/// 直接返回「已被注册」——所以 `shortcut::bind` 会顺着备选往下试，把**实际绑上的**
/// 组合写回配置，而不是死守默认值。
///
/// 另一件必须配套的事：焦点窗口按 `Alt+Space` 会弹出 Windows 自带的系统菜单
/// （还原 / 移动 / 关闭）。窗口侧由 `sysmenu.rs` 子类化按掉，删它之前先想清楚。
///
/// 用户可以在设置页直接录制一个新组合（`set_panel_shortcut`），
/// 或者手改这里对应的 `settings.json` 字段 `panel_shortcut`。
pub const DEFAULT_PANEL_SHORTCUT: &str = "Alt+Space";

/// 0.4.1 之前的默认值。老配置里存的还是它就跟着换，见 `migrate_shortcut`。
const LEGACY_PANEL_SHORTCUT: &str = "Control+Alt+Space";

/// 把用户写的快捷键归一化成插件认的规范写法。
///
/// 插件那层（`global-hotkey`）解析时全部 `to_uppercase()` 再比对，所以大小写不敏感；
/// 但它**只认** `Alt` / `Option` / `Ctrl` / `Control` / `Shift` / `Cmd` / `Command` /
/// `Super` 这几个修饰键名——`Win`、`Meta` 会被当成主键解析然后报错。所以这里要
/// 把常见的别名折算过去，不指望用户记得住插件那套拼法。
///
/// 修饰键顺序固定成 Ctrl → Alt → Shift → Super，和 Windows 上的习惯写法一致，
/// 免得同一个组合因为手写顺序不同在设置页显示两种样子。
///
/// 认不出来的主键**原样保留**：这一层不做猜测，注册那步会报错并退回默认值。
pub fn normalize_shortcut(raw: &str) -> String {
    let cleaned = raw.trim().replace('＋', "+");
    if cleaned.is_empty() {
        return DEFAULT_PANEL_SHORTCUT.to_string();
    }

    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut sup = false;
    let mut key: Option<String> = None;

    for part in cleaned.split('+') {
        let token = part.trim();
        if token.is_empty() {
            continue;
        }
        match token.to_ascii_lowercase().as_str() {
            "alt" | "option" => alt = true,
            "ctrl" | "control" => ctrl = true,
            "shift" => shift = true,
            "cmd" | "command" | "super" | "win" | "meta" => sup = true,
            // 主键只留第一个，多写的直接忽略（和插件的「只允许一个主键」对齐）
            _ => {
                if key.is_none() {
                    key = Some(canonical_key(token));
                }
            }
        }
    }

    let Some(key) = key else {
        // 只有修饰键没有主键，不是合法热键
        return DEFAULT_PANEL_SHORTCUT.to_string();
    };

    let mut out = String::new();
    for (on, name) in [
        (ctrl, "Control"),
        (alt, "Alt"),
        (shift, "Shift"),
        (sup, "Super"),
    ] {
        if on {
            out.push_str(name);
            out.push('+');
        }
    }
    out.push_str(&key);
    out
}

/// 主键的规范写法。
///
/// 插件是拿大写去比对的（`KEYA` / `SPACE` / `PAGEDOWN`），所以 `keya`、`KeyA`、
/// `KEYA` 三种写法都能通。这里把它们统一成 Code 的标准拼法（`KeyA` / `PageDown`），
/// 目的是让设置页和 `settings.json` 都好看——**不承担校验**，认不出来的原样保留。
///
/// 不能简单「首字母大写、其余小写」：那会把 `KeyS` 变成 `Keys`、`PageDown` 变成
/// `Pagedown`。插件虽然仍能解析，但设置页会显示成「Alt + Keys」这种莫名其妙的东西。
fn canonical_key(token: &str) -> String {
    // 中文习惯写法，顺手认一下
    if matches!(token, "空格" | "空格键") {
        return "Space".to_string();
    }

    let upper = token.to_ascii_uppercase();

    // 有规律的几类：KeyA / Digit1 / Numpad0 / F24
    if let Some(rest) = upper.strip_prefix("KEY") {
        if rest.len() == 1 && rest.chars().all(|c| c.is_ascii_uppercase()) {
            return format!("Key{rest}");
        }
    }
    if let Some(rest) = upper.strip_prefix("DIGIT") {
        if rest.len() == 1 && rest.chars().all(|c| c.is_ascii_digit()) {
            return format!("Digit{rest}");
        }
    }
    if let Some(rest) = upper.strip_prefix("NUMPAD") {
        if rest.len() == 1 && rest.chars().all(|c| c.is_ascii_digit()) {
            return format!("Numpad{rest}");
        }
    }
    if let Some(rest) = upper.strip_prefix('F') {
        if let Ok(number) = rest.parse::<u8>() {
            if (1..=24).contains(&number) {
                return format!("F{number}");
            }
        }
    }

    // 其余已知 Code：按表还原成标准拼法（NumpadAdd / PageDown / BracketLeft…）
    if let Some(name) = CODE_NAMES.iter().find(|name| name.eq_ignore_ascii_case(token)) {
        return (*name).to_string();
    }

    let mut chars = token.chars();
    match chars.next() {
        Some(first) => {
            let mut out = first.to_uppercase().collect::<String>();
            out.push_str(&chars.as_str().to_lowercase());
            out
        }
        None => String::new(),
    }
}

/// 不带规律、需要逐个记的 Code 名。和前端 `Settings.tsx` 的 `NAMED_CODES` 对齐。
const CODE_NAMES: &[&str] = &[
    "Space",
    "Enter",
    "Escape",
    "Tab",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "CapsLock",
    "NumLock",
    "ScrollLock",
    "PrintScreen",
    "Pause",
    "Minus",
    "Equal",
    "Comma",
    "Period",
    "Slash",
    "Backslash",
    "Semicolon",
    "Quote",
    "BracketLeft",
    "BracketRight",
    "Backquote",
    "NumpadAdd",
    "NumpadSubtract",
    "NumpadMultiply",
    "NumpadDivide",
    "NumpadDecimal",
    "NumpadEnter",
    "NumpadEqual",
];


/// 桌宠立绘风格。
///
/// 两套素材是两份独立的美术资源，前端按这里切换 `assets/pet` 与 `assets/pet-real`。
/// 只在 `settings.json` 里存一个短字符串，加新风格时这里加一个变体即可。
///
/// **写实是默认**：Q 版那套（11 张开源立绘）已经归档，只保留现有动作，不再跟着
/// 新交互更新——它的素材是别人画的，加一个表情就得求一张图，扩不动。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PetStyle {
    /// Q 版（归档）
    Chibi,
    /// 写实（默认，DeepSeek-chan 分层 PSD 出的立绘）
    Real,
}

impl Default for PetStyle {
    fn default() -> Self {
        Self::Real
    }
}

impl PetStyle {
    /// 手改 settings.json 写了个不认识的风格时，退回默认风格而不是让整个文件解析失败
    /// （解析失败会把面板尺寸、气泡时长一起丢回默认值）。
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "chibi" => Self::Chibi,
            "real" => Self::Real,
            _ => Self::default(),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chibi => "chibi",
            Self::Real => "real",
        }
    }

    /// 这套立绘对应的桌宠窗口逻辑尺寸。
    ///
    /// 两套素材构图差得远，窗口不能共用一个尺寸：Q 版是「全身但头大」的方图，
    /// 写实是 9 头身全身，瘦长。尺寸必须和素材长宽比一致——`object-fit: contain`
    /// 只保证不变形，窗口比例不对就会在四周留出透明边，看起来像立绘缩了一圈。
    ///
    /// 动态立绘**不单独换尺寸**：那个 moc3 的角色实测宽高比 0.43，和静态写实
    /// （0.506）是同一个量级，竖窗本来就合适。立绘自己按包围盒等比缩放贴底，
    /// 见 `src/live2d/fit.ts`。
    ///
    /// 改这里要同步 `tools/prepare-real-art.py --height`（写实是窗口高的 2 倍）。
    pub fn window_size(self) -> (u32, u32) {
        match self {
            Self::Chibi => (176, 176),
            Self::Real => (172, 340),
        }
    }
}

impl<'de> Deserialize<'de> for PetStyle {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(Self::parse(&raw))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelSize {
    pub width: u32,
    pub height: u32,
}

impl PanelSize {
    pub fn clamped(self) -> Self {
        Self {
            width: self.width.max(MIN_PANEL_WIDTH),
            height: self.height.max(MIN_PANEL_HEIGHT),
        }
    }
}

/// 落盘的用户设置。
///
/// 字段全部 `#[serde(default)]`：以后加新字段时，老配置文件不能一读就失败
/// （和 `config.rs` 里 window.json 的坑一样）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// 提醒气泡无人操作时自动收起的秒数
    #[serde(default = "default_bubble_seconds")]
    pub bubble_seconds: u32,
    /// 面板被手动拖过之后的尺寸；`None` 表示高度跟着内容走（出厂行为）
    #[serde(default)]
    pub panel_size: Option<PanelSize>,
    /// 桌宠用哪套立绘
    #[serde(default)]
    pub pet_style: PetStyle,
    /// 是否用 Live2D 动态立绘（只有写实风格有模型，Q 版忽略）
    #[serde(default)]
    pub pet_live2d: bool,
    /// 呼出待办面板的全局快捷键，写法见 `normalize_shortcut`
    #[serde(default = "default_panel_shortcut")]
    pub panel_shortcut: String,
    /// 默认快捷键从 `Ctrl+Alt+Space` 换成 `Alt+Space` 时做过一次迁移。
    ///
    /// 老配置文件没有这个字段 → `false` → 迁移一次并置 `true`。迁完就别再看它了：
    /// 用户之后手动选回三键组合，不该每次启动都被改回去。
    #[serde(default)]
    pub shortcut_default_migrated: bool,
}

fn default_bubble_seconds() -> u32 {
    DEFAULT_BUBBLE_SECONDS
}

fn default_panel_shortcut() -> String {
    DEFAULT_PANEL_SHORTCUT.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            bubble_seconds: DEFAULT_BUBBLE_SECONDS,
            panel_size: None,
            pet_style: PetStyle::default(),
            pet_live2d: false,
            panel_shortcut: default_panel_shortcut(),
            // 出厂就是新默认值，没有要迁的东西
            shortcut_default_migrated: true,
        }
    }
}

impl Settings {
    fn normalized(self) -> Self {
        Self {
            bubble_seconds: self
                .bubble_seconds
                .clamp(MIN_BUBBLE_SECONDS, MAX_BUBBLE_SECONDS),
            panel_size: self.panel_size.map(PanelSize::clamped),
            pet_style: self.pet_style,
            pet_live2d: self.pet_live2d,
            panel_shortcut: normalize_shortcut(&self.panel_shortcut),
            shortcut_default_migrated: self.shortcut_default_migrated,
        }
    }
}

fn settings_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

/// 读设置。文件不存在 / 坏了都退化成默认值——设置读不出来不该让应用起不来。
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let Some(path) = settings_file(app) else {
        return Settings::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Settings::default();
    };
    let Ok(parsed) = serde_json::from_str::<Settings>(&raw) else {
        return Settings::default();
    };

    let mut settings = parsed.normalized();
    if migrate_shortcut(&mut settings) {
        save(app, settings.clone());
    }
    settings
}

/// 把旧默认快捷键换成新的，只做一次。
///
/// 返回「是否需要落盘」。只改常量不够：老用户的 `settings.json` 里存的是旧默认值
/// `Control+Alt+Space`，升级后还会接着用它。这里在第一次读到老配置时换成
/// `Alt+Space`，并置上标记——之后用户再手动选回三键组合，不会被每次启动改回去。
///
/// 标记本身要落盘，所以返回 true 的条件是「标记从 false 变成了 true」，与是否真的
/// 换了键无关。
fn migrate_shortcut(settings: &mut Settings) -> bool {
    if settings.shortcut_default_migrated {
        return false;
    }
    settings.shortcut_default_migrated = true;
    if settings.panel_shortcut == LEGACY_PANEL_SHORTCUT {
        settings.panel_shortcut = DEFAULT_PANEL_SHORTCUT.to_string();
    }
    true
}

pub fn save<R: Runtime>(app: &AppHandle<R>, settings: Settings) {
    let Some(path) = settings_file(app) else {
        return;
    };
    // 原子写：直接 fs::write 覆盖，断电就留半截 JSON，
    // 下次启动读失败会静默退回默认值——用户的面板尺寸、气泡时长全丢
    if let Ok(raw) = serde_json::to_string_pretty(&settings.normalized()) {
        let _ = crate::fsutil::write_atomic(&path, raw.as_bytes());
    }
}

pub fn clamp_seconds(seconds: u32) -> u32 {
    seconds.clamp(MIN_BUBBLE_SECONDS, MAX_BUBBLE_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_size_only_clamped_at_bottom() {
        assert_eq!(
            PanelSize {
                width: 10,
                height: 10
            }
            .clamped(),
            PanelSize {
                width: MIN_PANEL_WIDTH,
                height: MIN_PANEL_HEIGHT
            }
        );
        // 上限交给用户：拖多大就是多大
        assert_eq!(
            PanelSize {
                width: 4000,
                height: 3000
            }
            .clamped(),
            PanelSize {
                width: 4000,
                height: 3000
            }
        );
    }

    #[test]
    fn old_file_without_panel_size_still_reads() {
        // 老版本写的 settings.json 没有 panel_size，不能一读就失败
        let parsed: Settings = serde_json::from_str(r#"{"bubble_seconds":30}"#).unwrap();
        assert_eq!(parsed.bubble_seconds, 30);
        assert!(parsed.panel_size.is_none());
        // 同样没有 pet_style，得退回默认的写实立绘
        assert_eq!(parsed.pet_style, PetStyle::Real);
        // 0.4.0 之前没有快捷键字段，也要给出 Alt+Space
        assert_eq!(parsed.panel_shortcut, DEFAULT_PANEL_SHORTCUT);
    }

    #[test]
    fn shortcut_aliases_collapse_to_one_canonical_form() {
        // 大小写、空格、全角加号、别名都要收成正主
        for raw in [
            "alt+space",
            "ALT + SPACE",
            "Option+Space",
            "alt＋space",
            " Alt+空格 ",
        ] {
            assert_eq!(normalize_shortcut(raw), "Alt+Space", "{raw}");
        }
        // Win / Meta 插件不认，必须折算成 Super，否则会被当成主键解析失败
        assert_eq!(normalize_shortcut("win+space"), "Super+Space");
        assert_eq!(normalize_shortcut("meta+shift+k"), "Shift+Super+K");
        // 修饰键顺序固定，别让同一个组合出现两种写法
        assert_eq!(normalize_shortcut("shift+alt+ctrl+p"), "Control+Alt+Shift+P");
        assert_eq!(normalize_shortcut("ctrl + alt + p"), "Control+Alt+P");
        // Code 名不能被「首字母大写、其余小写」压坏：KeyS ≠ Keys，PageDown ≠ Pagedown
        assert_eq!(normalize_shortcut("alt+keys"), "Alt+KeyS");
        assert_eq!(normalize_shortcut("alt+keyS"), "Alt+KeyS");
        assert_eq!(normalize_shortcut("ctrl+pageDown"), "Control+PageDown");
        assert_eq!(normalize_shortcut("shift+numpadadd"), "Shift+NumpadAdd");
        assert_eq!(normalize_shortcut("ctrl+digit1"), "Control+Digit1");
        assert_eq!(normalize_shortcut("ctrl+numpad0"), "Control+Numpad0");
        assert_eq!(normalize_shortcut("alt+f24"), "Alt+F24");
    }

    #[test]
    fn broken_shortcut_falls_back_instead_of_going_empty() {
        // 空的、只有修饰键的：都退回默认值，不能存一个注册不上的空串
        assert_eq!(normalize_shortcut("   "), DEFAULT_PANEL_SHORTCUT);
        assert_eq!(normalize_shortcut("Alt+"), DEFAULT_PANEL_SHORTCUT);
        // 认不出来的主键原样保留，交给注册那步报错退回（这里不猜）
        assert_eq!(normalize_shortcut("Alt+Foo"), "Alt+Foo");
    }

    #[test]
    fn pet_style_parses_and_round_trips() {
        assert_eq!(PetStyle::parse("real"), PetStyle::Real);
        assert_eq!(PetStyle::parse(" Real "), PetStyle::Real);
        assert_eq!(PetStyle::parse("chibi"), PetStyle::Chibi);
        // 写错了退回默认（写实），不能连累同一份文件里的其它字段
        assert_eq!(PetStyle::parse("写实"), PetStyle::Real);
        assert_eq!(PetStyle::Real.as_str(), "real");

        let raw = serde_json::to_string(&Settings {
            bubble_seconds: 10,
            panel_size: None,
            pet_style: PetStyle::Chibi,
            pet_live2d: true,
            panel_shortcut: DEFAULT_PANEL_SHORTCUT.to_string(),
            shortcut_default_migrated: true,
        })
        .unwrap();
        let back: Settings = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.pet_style, PetStyle::Chibi);
    }

    #[test]
    fn unknown_pet_style_falls_back_without_losing_other_fields() {
        // 手改配置写错了风格名，不能连带把面板尺寸一起丢掉
        let parsed: Settings =
            serde_json::from_str(r#"{"panel_size":{"width":460,"height":520},"pet_style":"x"}"#)
                .unwrap();
        assert_eq!(parsed.pet_style, PetStyle::Real);
        assert_eq!(parsed.panel_size.unwrap().width, 460);
    }

    #[test]
    fn each_style_has_its_own_window_size() {
        // 写实立绘是 9 头身全身，比 Q 版高得多；两个尺寸不能撞在一起
        let (cw, ch) = PetStyle::Chibi.window_size();
        let (rw, rh) = PetStyle::Real.window_size();
        assert_eq!((cw, ch), (176, 176));
        assert!(rh > ch, "写实版窗口应该比 Q 版高");
        // 比例要和 assets/pet-real 的 344×680 对得上，否则窗口里会留透明边
        assert!((rw as f32 / rh as f32 - 344.0 / 680.0).abs() < 0.001);
    }

    #[test]
    fn settings_round_trip() {
        let settings = Settings {
            bubble_seconds: 10,
            panel_size: Some(PanelSize {
                width: 460,
                height: 520,
            }),
            pet_style: PetStyle::Real,
            pet_live2d: false,
            panel_shortcut: "Control+Alt+P".to_string(),
            shortcut_default_migrated: true,
        };
        let raw = serde_json::to_string(&settings).unwrap();
        let back: Settings = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.panel_size, settings.panel_size);
        assert_eq!(back.pet_live2d, settings.pet_live2d);
        assert_eq!(back.panel_shortcut, "Control+Alt+P");
    }

    #[test]
    fn old_default_shortcut_migrates_once() {
        // 老配置：旧默认值 + 没有迁移标记
        let mut settings = Settings {
            panel_shortcut: LEGACY_PANEL_SHORTCUT.to_string(),
            shortcut_default_migrated: false,
            ..Settings::default()
        };
        assert!(migrate_shortcut(&mut settings), "第一次读到老配置应该落盘");
        assert_eq!(settings.panel_shortcut, DEFAULT_PANEL_SHORTCUT);
        assert_eq!(settings.panel_shortcut, "Alt+Space");
        assert!(settings.shortcut_default_migrated);

        // 第二次以及以后：不再动它
        assert!(!migrate_shortcut(&mut settings));
        assert_eq!(settings.panel_shortcut, "Alt+Space");

        // 用户后来自己选回三键组合，也不会被启动逻辑改回去
        settings.panel_shortcut = "Control+Alt+Space".to_string();
        assert!(!migrate_shortcut(&mut settings));
        assert_eq!(settings.panel_shortcut, "Control+Alt+Space");
    }

    #[test]
    fn migration_keeps_custom_shortcut() {
        // 老配置里存的是用户自己改过的组合：只补标记，不换键
        let mut settings = Settings {
            panel_shortcut: "Alt+Shift+Space".to_string(),
            shortcut_default_migrated: false,
            ..Settings::default()
        };
        assert!(migrate_shortcut(&mut settings));
        assert_eq!(settings.panel_shortcut, "Alt+Shift+Space");
        assert!(settings.shortcut_default_migrated);
    }

    #[test]
    fn missing_shortcut_field_defaults_to_alt_space() {
        // 极老的配置可能整个字段都没有：serde 默认值必须跟着新常量走
        let parsed: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.panel_shortcut, "Alt+Space");
        assert!(!parsed.shortcut_default_migrated);
    }
}
