// 悬浮球（Electron）集成模块
// 律政工作台启动时自动拉起 floating-ball 子进程
// 同时监听桥接文件，接收 floating-ball 推送过来的文字

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

// Windows 进程创建标志，使子进程脱离父进程的 Job Object
// 只用 CREATE_BREAKAWAY_FROM_JOB 即可解除关联，不影响 GUI 渲染
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x01000000;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// floating-ball 项目根目录（相对 Legal-Workspace 项目根的 floating-ball 子目录）
/// __FILE__ 是 src-tauri/src/ball.rs，往上 3 级到项目根
fn ball_dir() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // CARGO_MANIFEST_DIR = Legal-Workspace/src-tauri
    p.push("..");
    p.push("floating-ball");
    p
}

/// 共享桥接文件路径（与 floating-ball main.js 一致）
fn bridge_file() -> PathBuf {
    let mut p = home_dir();
    p.extend(["AppData", "Roaming", "floating-ball", "to-workbench.json"]);
    p
}

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Users\\default"))
}

/// floating-ball → 律政 桥接消息
#[derive(Debug, Deserialize, Clone)]
struct BridgeMsg {
    #[allow(dead_code)]
    ts: u64,
    #[allow(dead_code)]
    text: String,
    #[allow(dead_code)]
    action: String,
}

/// 已消费的消息时间戳（避免重复处理）
struct BridgeState {
    last_ts: u64,
}

/// 解析 Electron 可执行文件路径
fn resolve_electron() -> Option<PathBuf> {
    let ball_dir = ball_dir();
    // 1. 开发态：node_modules/electron/dist/electron.exe
    let dev = ball_dir.join("node_modules").join("electron").join("dist").join("electron.exe");
    if dev.exists() {
        return Some(dev);
    }
    // 2. 打包态：win-unpacked/悬浮球助手.exe 或 dist 根目录的便携版
    let unpacked = ball_dir.join("dist").join("win-unpacked").join("悬浮球助手.exe");
    if unpacked.exists() {
        return Some(unpacked);
    }
    let packaged = ball_dir.join("dist").join("悬浮球助手 1.0.0.exe");
    if packaged.exists() {
        return Some(packaged);
    }
    None
}

/// 启动悬浮球（子进程模式，不注册全局快捷键/鼠标钩子）
/// 使用 CREATE_BREAKAWAY_FROM_JOB 使悬浮球脱离律政的 Job Object
/// 这样律政退出不会杀掉悬浮球，悬浮球退出也不会影响律政
pub fn ball_start() -> Result<(), String> {
    let electron = resolve_electron().ok_or_else(|| {
        format!(
            "找不到 Electron 可执行文件。请确认 {} 是 floating-ball 项目根目录，且已执行 npm install",
            ball_dir().display()
        )
    })?;

    let mut cmd = Command::new(&electron);
    cmd.arg(ball_dir())
        .arg("--child")
        .current_dir(ball_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_BREAKAWAY_FROM_JOB);

    cmd.spawn()
        .map_err(|e| format!("启动悬浮球失败：{e}"))?;

    Ok(())
}

fn send_arg(arg: &str) -> Result<(), String> {
    let electron = resolve_electron().ok_or_else(|| "找不到 Electron".to_string())?;
    let mut cmd = Command::new(&electron);
    cmd.arg(ball_dir())
        .arg("--child")
        .arg(arg)
        .current_dir(ball_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_BREAKAWAY_FROM_JOB);

    cmd.spawn()
        .map_err(|e| format!("发送命令失败：{e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri Commands（前端通过 invoke() 调用）
// ---------------------------------------------------------------------------

/// 启动悬浮球
#[tauri::command]
pub fn ball_start_cmd() -> Result<(), String> {
    ball_start()
}

/// 显示悬浮球面板
#[tauri::command]
pub fn ball_show() -> Result<(), String> {
    send_arg("--cmd=show")
}

/// 隐藏悬浮球面板
#[tauri::command]
pub fn ball_hide() -> Result<(), String> {
    send_arg("--cmd=hide")
}

/// 预填文本并打开面板（比如用户在律政工作台里选中了一段法规文本）
#[tauri::command]
pub fn ball_prefill(text: String) -> Result<(), String> {
    let encoded = url_encode(&text);
    send_arg(&format!("--prefill={encoded}"))
}

/// 让悬浮球直接执行 AI 翻译
#[tauri::command]
pub fn ball_translate(text: String, target: Option<String>) -> Result<(), String> {
    let payload = serde_json::json!({
        "kind": "translate",
        "opts": { "text": text, "target": target.unwrap_or_else(|| "英文".into()) }
    });
    let encoded = url_encode(&serde_json::to_string(&payload).unwrap_or_default());
    send_arg(&format!("--run={encoded}"))
}

/// 退出悬浮球
#[tauri::command]
pub fn ball_quit() -> Result<(), String> {
    send_arg("--cmd=quit")
}

/// URL 编码（对标 JS 的 encodeURIComponent）
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// floating-ball → 律政工作台 桥接：轮询共享文件
// ---------------------------------------------------------------------------

use tauri::State;

/// 启动桥接轮询线程（每 1.5s 检查一次）
pub fn start_bridge_poller(app: AppHandle) {
    let poll_file = bridge_file();
    let state = Mutex::new(BridgeState { last_ts: 0u64 });

    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1500));

        // 读桥接文件
        let Ok(content) = fs::read_to_string(&poll_file) else {
            // 文件不存在是正常情况，继续轮询
            continue;
        };

        let Ok(msg) = serde_json::from_str::<BridgeMsg>(&content) else {
            continue;
        };

        // 去重：只处理新消息（ts 更大）
        let mut st = state.lock().unwrap();
        if msg.ts <= st.last_ts {
            continue;
        }
        st.last_ts = msg.ts;
        drop(st);

        // 发给前端（Tauri event）
        let _ = app.emit(
            "ball-push",
            serde_json::json!({
                "text": msg.text,
                "action": msg.action,
                "ts": msg.ts,
            }),
        );

        // 处理后删除文件（floating-ball 下次会重新写）
        let _ = fs::remove_file(&poll_file);
    });
}
