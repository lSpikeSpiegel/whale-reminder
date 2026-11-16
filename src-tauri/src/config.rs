use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// 屏幕边缘。贴边停靠时记住贴的是哪一边，重启后原样靠回去。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

/// 窗口位置，单位为物理像素。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WindowPos {
    pub x: i32,
    pub y: i32,
}

/// 落盘的实际结构。`dock` 是后加的字段，老配置文件里没有，
/// 所以必须 `#[serde(default)]`，否则升级后一读就失败。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct SavedWindow {
    x: i32,
    y: i32,
    #[serde(default)]
    dock: Option<Edge>,
}

fn config_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("window.json"))
}

fn read<R: Runtime>(app: &AppHandle<R>) -> Option<SavedWindow> {
    let path = config_file(app)?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Option<WindowPos> {
    read(app).map(|saved| WindowPos {
        x: saved.x,
        y: saved.y,
    })
}

/// 上次是不是贴着某条边。
pub fn load_dock<R: Runtime>(app: &AppHandle<R>) -> Option<Edge> {
    read(app).and_then(|saved| saved.dock)
}

pub fn save<R: Runtime>(app: &AppHandle<R>, pos: WindowPos, dock: Option<Edge>) {
    let Some(path) = config_file(app) else {
        return;
    };
    let saved = SavedWindow {
        x: pos.x,
        y: pos.y,
        dock,
    };
    if let Ok(raw) = serde_json::to_string_pretty(&saved) {
        let _ = crate::fsutil::write_atomic(&path, raw.as_bytes());
    }
}
