use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// 窗口位置，单位为物理像素。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WindowPos {
    pub x: i32,
    pub y: i32,
}

fn config_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("window.json"))
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Option<WindowPos> {
    let path = config_file(app)?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save<R: Runtime>(app: &AppHandle<R>, pos: WindowPos) {
    let Some(path) = config_file(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(&pos) {
        let _ = fs::write(path, raw);
    }
}
