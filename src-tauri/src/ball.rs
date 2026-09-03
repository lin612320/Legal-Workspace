// 悬浮球（Electron）集成模块
// 律政工作台启动时自动拉起 floating-ball 子进程
// 同时监听桥接文件，接收 floating-ball 推送过来的文字

use std::fs;
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

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

/// 悬浮球查找结果
enum BallSource {
    /// 开发态：electron.exe 需把项目目录作为 app 参数加载
    Dev { exe: PathBuf, app_dir: PathBuf },
    /// 已打包 exe（win-unpacked / 便携版），自包含，无需目录参数
    Built { exe: PathBuf },
}

/// 在一个候选目录里探测悬浮球的三种形态
fn probe_dir(dir: &Path) -> Option<BallSource> {
    // 1. 开发态：node_modules/electron/dist/electron.exe（需整目录作为 app 加载）
    let dev_exe = dir.join("node_modules").join("electron").join("dist").join("electron.exe");
    if dev_exe.exists() {
        return Some(BallSource::Dev { exe: dev_exe, app_dir: dir.to_path_buf() });
    }
    // 2. electron-builder win-unpacked 自包含应用
    let unpacked = dir.join("win-unpacked").join("悬浮球助手.exe");
    if unpacked.exists() {
        return Some(BallSource::Built { exe: unpacked });
    }
    // 3. 便携版 exe（悬浮球助手*.exe）
    if let Ok(entries) = fs::read_dir(dir) {
        let mut found: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                n.starts_with("悬浮球助手") && n.ends_with(".exe")
            })
            .collect();
        found.sort();
        if let Some(exe) = found.into_iter().next() {
            return Some(BallSource::Built { exe });
        }
    }
    None
}

fn home_dir_opt() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

/// 主程序 exe 所在目录
fn main_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
}

/// 在目录树（有限深度）里递归探测悬浮球，
/// 兼容 NSIS `_up_` 备份目录等嵌套布局（如 `_up_\floating-ball\dist\悬浮球助手*.exe`）
fn find_ball_recursive(dir: &Path, depth: u32) -> Option<BallSource> {
    if let Some(src) = probe_dir(dir) {
        return Some(src);
    }
    if depth == 0 {
        return None;
    }
    let mut subdirs: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default();
    subdirs.sort();
    for sub in subdirs {
        let name = sub
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        // 跳过与悬浮球无关的大目录（dist 是 electron-builder 产物目录，需保留）
        if name == "node_modules" || name == "target" {
            continue;
        }
        if let Some(src) = find_ball_recursive(&sub, depth - 1) {
            return Some(src);
        }
    }
    None
}

/// 按优先级解析悬浮球可执行文件：
///   1. 环境变量 `FLOATING_BALL_DIR`（指定 floating-ball 项目根或产物目录）
///   2. 主程序 exe 同目录 / `resources` 子目录（发布形态）
///   3. 主程序 exe 旁 `_up_`（NSIS 升级备份布局，兜底旧安装）
///   4. 项目仓库内 floating-ball（开发形态：CARGO_MANIFEST_DIR 上一级，与协作者布局一致）
///   5. 用户桌面 floating-ball（旧开发形态兜底）
fn resolve_ball() -> Option<BallSource> {
    // 1. 环境变量显式指定
    if let Ok(dir) = std::env::var("FLOATING_BALL_DIR") {
        let dir = PathBuf::from(dir);
        if let Some(src) = find_ball_recursive(&dir, 4) {
            return Some(src);
        }
    }
    // 2. 与主程序 exe 同目录（含 tauri resources 子目录）
    if let Some(exe_dir) = main_exe_dir() {
        if let Some(src) = probe_dir(&exe_dir) {
            return Some(src);
        }
        if let Some(src) = probe_dir(&exe_dir.join("resources")) {
            return Some(src);
        }
        // 3. NSIS `_up_` 备份布局兜底（旧版安装包把资源装到这里）
        let up_dir = exe_dir.join("_up_");
        if up_dir.exists() {
            if let Some(src) = find_ball_recursive(&up_dir, 4) {
                return Some(src);
            }
        }
    }
    // 4. 项目仓库内 floating-ball（开发形态）
    let repo_ball = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("floating-ball");
    if let Some(src) = find_ball_recursive(&repo_ball, 2) {
        return Some(src);
    }
    // 5. 用户桌面 floating-ball（旧开发形态兜底）
    if let Some(home) = home_dir_opt() {
        let dev_dir = home.join("Desktop").join("floating-ball");
        if let Some(src) = find_ball_recursive(&dev_dir, 3) {
            return Some(src);
        }
    }
    None
}

/// 以子进程方式启动悬浮球并附加命令行参数
/// 使用 CREATE_BREAKAWAY_FROM_JOB 使悬浮球脱离律政的 Job Object
/// 这样律政退出不会杀掉悬浮球，悬浮球退出也不会影响律政
fn spawn_ball(extra: &[&str]) -> Result<(), String> {
    let src = resolve_ball().ok_or_else(|| {
        "找不到悬浮球（Electron）。请设置环境变量 FLOATING_BALL_DIR，\
         或将悬浮球便携版 exe 放到本程序同目录，或准备桌面 floating-ball 开发目录"
            .to_string()
    })?;

    let (exe, current_dir, mut args) = match src {
        BallSource::Dev { exe, app_dir } => {
            let args = vec![app_dir.to_string_lossy().into_owned()];
            (exe, app_dir, args)
        }
        BallSource::Built { exe } => {
            let current_dir = exe
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."));
            (exe, current_dir, Vec::new())
        }
    };
    args.extend(extra.iter().map(|s| s.to_string()));

    let mut cmd = Command::new(&exe);
    cmd.args(&args)
        .current_dir(&current_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_BREAKAWAY_FROM_JOB);

    cmd.spawn()
        .map_err(|e| format!("启动悬浮球失败：{e}"))?;

    Ok(())
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

/// 启动悬浮球（子进程模式，不注册全局快捷键/鼠标钩子）
/// 悬浮球运行后会持续轮询 %APPDATA%\floating-ball\from-workbench.json，
/// 后续 show / hide / quit / prefill 等命令通过该控制文件下发（见 send_ctrl）。
pub fn ball_start() -> Result<(), String> {
    spawn_ball(&["--child"])
}

/// 律政 → 悬浮球 反向控制文件路径（与 floating-ball main.js 轮询一致）
fn ctrl_file() -> PathBuf {
    let mut p = home_dir();
    p.extend(["AppData", "Roaming", "floating-ball", "from-workbench.json"]);
    p
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 通过共享控制文件向悬浮球下发命令。
/// 比「二次 spawn 传命令行参数」可靠：Electron 便携版 stub / 打包 exe
/// 对额外参数透传不可靠，而悬浮球主实例固定轮询控制文件，命令必达。
fn send_ctrl(cmd: &str, extra: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    // 先确保悬浮球实例在运行；若已存在，单实例锁会让新进程快速退出，无副作用
    let _ = ball_start();

    let mut payload = extra;
    payload.insert("ts".into(), serde_json::json!(now_ms()));
    payload.insert("cmd".into(), serde_json::json!(cmd));

    let dir = ctrl_file()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&dir).map_err(|e| format!("创建悬浮球控制目录失败：{e}"))?;

    let content = serde_json::to_string(&payload).map_err(|e| format!("命令序列化失败：{e}"))?;
    fs::write(ctrl_file(), content).map_err(|e| format!("写入悬浮球命令失败：{e}"))
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
    send_ctrl("show", serde_json::Map::new())
}

/// 隐藏悬浮球面板
#[tauri::command]
pub fn ball_hide() -> Result<(), String> {
    send_ctrl("hide", serde_json::Map::new())
}

/// 预填文本并打开面板（比如用户在律政工作台里选中了一段法规文本）
#[tauri::command]
pub fn ball_prefill(text: String) -> Result<(), String> {
    let mut extra = serde_json::Map::new();
    extra.insert("text".into(), serde_json::json!(text));
    send_ctrl("prefill", extra)
}

/// 让悬浮球直接执行 AI 翻译
#[tauri::command]
pub fn ball_translate(text: String, target: Option<String>) -> Result<(), String> {
    let mut extra = serde_json::Map::new();
    extra.insert("text".into(), serde_json::json!(text));
    extra.insert(
        "target".into(),
        serde_json::json!(target.unwrap_or_else(|| "英文".into())),
    );
    send_ctrl("translate", extra)
}

/// 退出悬浮球
#[tauri::command]
pub fn ball_quit() -> Result<(), String> {
    send_ctrl("quit", serde_json::Map::new())
}

// ---------------------------------------------------------------------------
// floating-ball → 律政工作台 桥接：轮询共享文件
// ---------------------------------------------------------------------------

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
