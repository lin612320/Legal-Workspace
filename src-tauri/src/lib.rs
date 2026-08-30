// 律政工作台 —— Rust 后端入口 + Tauri 命令桥接

mod db;

use std::fs;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use db::DbState;

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

#[tauri::command]
fn ping() -> String {
    "pong".into()
}

// ---------------------------------------------------------------------------
// 设置（AI / 翻译 API、备份配置、偏好）
// ---------------------------------------------------------------------------

#[tauri::command]
fn settings_get(conn: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    db::get_setting(&conn.lock().unwrap(), &key)
}

#[tauri::command]
fn settings_set(conn: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    db::set_setting(&conn.lock().unwrap(), &key, &value)
}

// ---------------------------------------------------------------------------
// 版块 4：AI 助手会话（多会话，持久化到 SQLite，重启不丢）
// ---------------------------------------------------------------------------

#[tauri::command]
fn chat_sessions_list(conn: State<'_, DbState>) -> Result<Vec<Value>, String> {
    db::chat_sessions_list(&conn.lock().unwrap())
}

#[tauri::command]
fn chat_session_create(conn: State<'_, DbState>, title: String) -> Result<i64, String> {
    db::chat_session_create(&conn.lock().unwrap(), &title)
}

#[tauri::command]
fn chat_session_rename(conn: State<'_, DbState>, id: i64, title: String) -> Result<(), String> {
    db::chat_session_rename(&conn.lock().unwrap(), id, &title)
}

#[tauri::command]
fn chat_session_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    db::chat_session_delete(&conn.lock().unwrap(), id)
}

#[tauri::command]
fn chat_history_load(conn: State<'_, DbState>, session_id: i64) -> Result<Vec<Value>, String> {
    db::chat_history_load(&conn.lock().unwrap(), session_id)
}

#[tauri::command]
fn chat_history_save(
    conn: State<'_, DbState>,
    session_id: i64,
    messages: Vec<db::ChatMsg>,
) -> Result<(), String> {
    db::chat_history_save(&conn.lock().unwrap(), session_id, &messages)
}

// ---------------------------------------------------------------------------
// 版块 2：法规查询
// ---------------------------------------------------------------------------

#[tauri::command]
fn laws_search(conn: State<'_, DbState>, keyword: String) -> Result<Vec<Value>, String> {
    let c = conn.lock().unwrap();
    let like = format!("%{keyword}%");
    let mut stmt = c
        .prepare(
            "SELECT id, title, chapter, article_no, content, source
             FROM laws WHERE title LIKE ?1 OR content LIKE ?1 OR article_no LIKE ?1
             ORDER BY title",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&like], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "title": r.get::<_, String>(1)?,
                "chapter": r.get::<_, Option<String>>(2)?,
                "article_no": r.get::<_, Option<String>>(3)?,
                "content": r.get::<_, String>(4)?,
                "source": r.get::<_, Option<String>>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 版块 3：文书模板（列表 / 占位）
// ---------------------------------------------------------------------------

#[tauri::command]
fn templates_list(conn: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let c = conn.lock().unwrap();
    let mut stmt = c
        .prepare(
            "SELECT id, title, category, content, file_type, built_in FROM templates ORDER BY category, title",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "title": r.get::<_, String>(1)?,
                "category": r.get::<_, Option<String>>(2)?,
                "content": r.get::<_, String>(3)?,
                "file_type": r.get::<_, Option<String>>(4)?,
                "built_in": r.get::<_, i64>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 新建模板（自建）。
#[tauri::command]
fn templates_create(
    conn: State<'_, DbState>,
    title: String,
    category: String,
    content: String,
    file_type: String,
) -> Result<(), String> {
    conn.lock()
        .unwrap()
        .execute(
            "INSERT INTO templates(title, category, content, file_type, built_in)
             VALUES (?1, ?2, ?3, ?4, 0)",
            rusqlite::params![title, category, content, file_type],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 删除模板（内置模板不允许删除，返回错误提示）。
#[tauri::command]
fn templates_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    let c = conn.lock().unwrap();
    let built_in: i64 = c
        .query_row("SELECT built_in FROM templates WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if built_in == 1 {
        return Err("内置模板不可删除".into());
    }
    c.execute("DELETE FROM templates WHERE id = ?1", [id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn todos_list(conn: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let c = conn.lock().unwrap();
    let mut stmt = c
        .prepare(
            "SELECT id, title, note, due_at, remind_minutes, desktop_popup, done, created_at
             FROM todos ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "title": r.get::<_, String>(1)?,
                "note": r.get::<_, Option<String>>(2)?,
                "due_at": r.get::<_, Option<String>>(3)?,
                "remind_minutes": r.get::<_, i64>(4)?,
                "desktop_popup": r.get::<_, i64>(5)? == 1,
                "done": r.get::<_, i64>(6)? == 1,
                "created_at": r.get::<_, String>(7)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn todos_create(
    conn: State<'_, DbState>,
    title: String,
    note: Option<String>,
    due_at: Option<String>,
    remind_minutes: Option<i64>,
    desktop_popup: Option<bool>,
) -> Result<i64, String> {
    let c = conn.lock().unwrap();
    let created_at = chrono::Local::now().to_rfc3339();
    c.execute(
        "INSERT INTO todos(title, note, due_at, remind_minutes, desktop_popup, done, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
        rusqlite::params![
            title,
            note,
            due_at,
            remind_minutes.unwrap_or(0),
            desktop_popup.unwrap_or(true).then_some(1),
            created_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(c.last_insert_rowid())
}

#[tauri::command]
fn todos_update(
    conn: State<'_, DbState>,
    id: i64,
    done: Option<bool>,
    title: Option<String>,
) -> Result<(), String> {
    let c = conn.lock().unwrap();
    if let Some(d) = done {
        c.execute("UPDATE todos SET done = ?1 WHERE id = ?2", [d.then_some(1), Some(id)])
            .map_err(|e| e.to_string())?;
    }
    if let Some(t) = title {
        c.execute("UPDATE todos SET title = ?1 WHERE id = ?2", [t, id.to_string()])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 全字段保存：编辑待办（备注/到期/提醒/弹窗/完成状态）。
#[tauri::command]
fn todos_save(
    conn: State<'_, DbState>,
    id: i64,
    title: String,
    note: Option<String>,
    due_at: Option<String>,
    remind_minutes: i64,
    desktop_popup: bool,
    done: bool,
) -> Result<(), String> {
    conn.lock()
        .unwrap()
        .execute(
            "UPDATE todos SET title = ?1, note = ?2, due_at = ?3,
                    remind_minutes = ?4, desktop_popup = ?5, done = ?6
             WHERE id = ?7",
            rusqlite::params![
                title,
                note,
                due_at,
                remind_minutes,
                desktop_popup.then_some(1),
                done.then_some(1),
                id,
            ],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn todos_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    conn.lock()
        .unwrap()
        .execute("DELETE FROM todos WHERE id = ?1", [id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 版块 7：备份 / 还原
// ---------------------------------------------------------------------------

/// 手动备份：把本地数据库复制到指定目录，文件名带时间戳。
#[tauri::command]
fn backup_now(app: AppHandle, dir: String) -> Result<String, String> {
    let src = app.path().app_data_dir().map(|p| p.join("legal.db")).map_err(|e| e.to_string())?;
    if !src.exists() {
        return Err("本地数据库不存在".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dst = std::path::Path::new(&dir).join(format!("legal-{stamp}.db"));
    fs::copy(&src, &dst).map_err(|e| format!("备份失败：{e}"))?;
    Ok(dst.to_string_lossy().into_owned())
}

/// 还原：用备份文件替换本地数据库。
#[tauri::command]
fn restore(app: AppHandle, file: String) -> Result<String, String> {
    let src = std::path::Path::new(&file);
    if !src.exists() {
        return Err("备份文件不存在".into());
    }
    let dst = app.path().app_data_dir().map(|p| p.join("legal.db")).map_err(|e| e.to_string())?;
    fs::copy(src, &dst).map_err(|e| format!("还原失败：{e}"))?;
    Ok("还原成功，重启后生效".into())
}

// ---------------------------------------------------------------------------
// 版块 4：AI 助手 —— 置顶悬浮窗 ⇄ 大窗口切换
// ---------------------------------------------------------------------------

/// 确保置顶悬浮窗存在（label = "float"，always-on-top 小窗）。
fn ensure_float(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("float") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        "float",
        WebviewUrl::App("index.html#/assistant?float=1".into()),
    )
    .title("AI 助手 · 悬浮")
    .inner_size(380.0, 500.0)
    .min_inner_size(320.0, 400.0)
    .resizable(true)
    .always_on_top(true)
    .build()
    .map_err(|e| e.to_string())?;

    // 关闭悬浮窗时恢复主窗口，避免应用"消失"
    let app = app.clone();
    if let Some(w) = app.get_webview_window("float") {
        w.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { .. } = event {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
        });
    }
    Ok(())
}

/// 收起到置顶悬浮窗：隐藏主窗口，显示/创建悬浮窗。
#[tauri::command]
fn float_in(app: AppHandle) -> Result<(), String> {
    ensure_float(&app)?;
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.hide();
    }
    Ok(())
}

/// 放大回大窗口：显示主窗口并关闭悬浮窗。
#[tauri::command]
fn float_out(app: AppHandle) -> Result<(), String> {
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.show();
        let _ = m.unminimize();
        let _ = m.set_focus();
    }
    if let Some(w) = app.get_webview_window("float") {
        let _ = w.close();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 版块 8：数据导入（预留接口，后接 Excel 解析）
// ---------------------------------------------------------------------------

#[tauri::command]
fn import_data(_kind: String, _path: String) -> Result<String, String> {
    // TODO: 接入 Excel 读取与字段映射（见数据库搭建指引）
    Ok("导入接口已预留，待接入 Excel 解析后启用".into())
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

#[cfg_attr(mobile_desktop, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let conn = db::init(&dir)?;
            app.manage(Mutex::new(conn) as DbState);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            settings_get,
            settings_set,
            chat_sessions_list,
            chat_session_create,
            chat_session_rename,
            chat_session_delete,
            chat_history_load,
            chat_history_save,
            laws_search,
            templates_list,
            templates_create,
            templates_delete,
            todos_list,
            todos_create,
            todos_update,
            todos_save,
            todos_delete,
            backup_now,
            restore,
            float_in,
            float_out,
            import_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}