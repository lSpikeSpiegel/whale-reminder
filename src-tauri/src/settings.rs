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
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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
}

fn default_bubble_seconds() -> u32 {
    DEFAULT_BUBBLE_SECONDS
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            bubble_seconds: DEFAULT_BUBBLE_SECONDS,
            panel_size: None,
            pet_style: PetStyle::default(),
            pet_live2d: false,
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
    serde_json::from_str::<Settings>(&raw)
        .map(Settings::normalized)
        .unwrap_or_default()
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
        };
        let raw = serde_json::to_string(&settings).unwrap();
        let back: Settings = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.panel_size, settings.panel_size);
        assert_eq!(back.pet_live2d, settings.pet_live2d);
    }
}
