// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // AI 客户端会以 `whale-reminder.exe --mcp` 拉起本程序。
    // 这条路径必须在最早期分流：完全不初始化 Tauri、不建任何窗口，
    // 否则 GUI 会抢走 stdin/stdout，JSON-RPC 直接失败。
    if std::env::args().any(|arg| arg == "--mcp") {
        whale_reminder_lib::mcp::run_blocking();
        return;
    }

    whale_reminder_lib::run()
}
