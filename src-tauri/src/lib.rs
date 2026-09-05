// 律政工作台 —— Rust 后端入口 + Tauri 命令桥接

mod ball;
mod db;

use std::fs;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

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
// 悬浮窗（label = "float"）在 tauri.conf.json 中预声明：启动即创建、默认隐藏。
// 运行时不再动态 WebviewWindowBuilder::build()（Windows 上二次建窗不可靠，
// 曾导致 build 挂起、页面空白）。float_in/out 只做显示与隐藏切换。

/// 收起到置顶悬浮窗：显示悬浮窗、隐藏主窗口。
#[tauri::command]
fn float_in(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("float") {
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        return Err("悬浮窗不存在（启动异常），请重启应用".into());
    }
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.hide();
    }
    Ok(())
}

/// 放大回大窗口：显示主窗口并收起悬浮窗。
#[tauri::command]
fn float_out(app: AppHandle) -> Result<(), String> {
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.show();
        let _ = m.unminimize();
        let _ = m.set_focus();
    }
    if let Some(w) = app.get_webview_window("float") {
        let _ = w.hide();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 版块 8：数据导入（Excel：法规 / 模板）
// ---------------------------------------------------------------------------

/// 从 Excel 导入法规或模板数据。
/// kind = "laws"（列：title/chapter/article_no/content/source）或
/// kind = "templates"（列：title/category/content/file_type）。
/// 表头支持中英文列名；返回 { imported, skipped }。
#[tauri::command]
fn import_excel(conn: State<'_, DbState>, kind: String, path: String) -> Result<Value, String> {
    use calamine::{Data, Reader, Xlsx};

    let mut workbook: Xlsx<_> =
        calamine::open_workbook(&path).map_err(|e| format!("打开 Excel 失败：{e}"))?;
    let sheet = workbook
        .worksheet_range_at(0)
        .ok_or_else(|| "Excel 中没有工作表".to_string())?
        .map_err(|e| format!("读取工作表失败：{e}"))?;

    let mut rows = sheet.rows();
    let header = rows
        .next()
        .ok_or_else(|| "Excel 为空（缺少表头行）".to_string())?;

    let cell_str = |d: &Data| -> Option<String> {
        match d {
            Data::String(s) => Some(s.clone()),
            Data::Float(f) => Some(f.to_string()),
            Data::Int(i) => Some(i.to_string()),
            Data::DateTimeIso(s) => Some(s.clone()),
            _ => None,
        }
    };
    let col = |name: &str| -> Option<usize> {
        header.iter().position(|h| {
            cell_str(h)
                .map(|s| s.trim().to_lowercase() == name)
                .unwrap_or(false)
        })
    };
    let title_col = col("title").or_else(|| col("标题"));
    let content_col = col("content").or_else(|| col("内容"));
    if title_col.is_none() || content_col.is_none() {
        return Err("表头缺少 title/标题 或 content/内容 列".into());
    }

    let c = conn.lock().unwrap();
    let mut imported = 0usize;
    let mut skipped = 0usize;
    for row in rows {
        let title = title_col
            .and_then(|i| row.get(i))
            .and_then(cell_str)
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let content = content_col
            .and_then(|i| row.get(i))
            .and_then(cell_str)
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if title.is_empty() || content.is_empty() {
            skipped += 1;
            continue;
        }
        if kind == "templates" {
            let category = col("category").or_else(|| col("分类")).and_then(|i| row.get(i)).and_then(cell_str);
            let file_type = col("file_type").or_else(|| col("类型")).and_then(|i| row.get(i)).and_then(cell_str);
            c.execute(
                "INSERT INTO templates(title, category, content, file_type, built_in)
                 VALUES (?1, ?2, ?3, ?4, 0)",
                rusqlite::params![title, category, content, file_type.unwrap_or_else(|| "txt".into())],
            )
            .map_err(|e| e.to_string())?;
        } else {
            let chapter = col("chapter").or_else(|| col("章节")).and_then(|i| row.get(i)).and_then(cell_str);
            let article_no = col("article_no").or_else(|| col("条文号")).and_then(|i| row.get(i)).and_then(cell_str);
            let source = col("source").or_else(|| col("来源")).and_then(|i| row.get(i)).and_then(cell_str);
            c.execute(
                "INSERT INTO laws(title, chapter, article_no, content, source)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    title,
                    chapter,
                    article_no,
                    content,
                    source.unwrap_or_else(|| "Excel 导入".into())
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        imported += 1;
    }
    Ok(json!({ "imported": imported, "skipped": skipped }))
}

// ---------------------------------------------------------------------------
// 后台提醒：轮询待办，到期的发系统通知（每 30 秒一次）
// ---------------------------------------------------------------------------

fn check_todo_notifications(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;

    let state = app.state::<DbState>();
    let conn = match state.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let now = chrono::Local::now();

    // 只挑「未完成 + 已开弹窗 + 有到期时间 + 该到期时间还没提醒过」的待办
    let mut stmt = match conn.prepare(
        "SELECT id, title, due_at, remind_minutes FROM todos
         WHERE done = 0 AND desktop_popup = 1 AND due_at IS NOT NULL
           AND (last_notified_due IS NULL OR last_notified_due != due_at)",
    ) {
        Ok(s) => s,
        Err(_) => return,
    };
    let rows = match stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
        ))
    }) {
        Ok(r) => r,
        Err(_) => return,
    };

    let mut pending: Vec<(i64, String, String)> = Vec::new();
    for row in rows {
        if let Ok((id, title, due_at, remind_minutes)) = row {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&due_at) {
                let due_local: chrono::DateTime<chrono::Local> = dt.with_timezone(&chrono::Local);
                let remind = remind_minutes.max(0);
                // 到期时刻 - 提前提醒分钟数 <= 当前时间 => 触发提醒
                if due_local <= now + chrono::Duration::minutes(remind) {
                    pending.push((id, title, due_at));
                }
            }
        }
    }
    drop(stmt);

    for (id, title, due_at) in pending {
        // 记录已提醒的到期时间，避免同一到期时间重复提醒
        let _ = conn.execute(
            "UPDATE todos SET last_notified_due = ?1 WHERE id = ?2",
            rusqlite::params![due_at, id],
        );
        let _ = app
            .notification()
            .builder()
            .title("律政工作台 · 待办提醒")
            .body(format!("「{title}」已到期或即将到期，请及时处理。"))
            .show();
    }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

#[cfg_attr(mobile_desktop, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let _ = std::fs::create_dir_all(&dir);
            let db_path = dir.join("legal.db");

            // —— 内置法库装载判定 ——
            // 1) 本地库不存在：直接装载预置库；
            // 2) 本地库存在但 laws 仍只有“播种示例”（≤6 条，从未导入过真实数据）：
            //    视为“空库”，先把旧文件备份为 legal.db.user-<时间戳>.db 再装载预置库，
            //    覆盖“老版本已生成空库导致升级后仍只有示例”的场景。
            let mut need_preload = !db_path.exists();
            if !need_preload {
                if let Ok(probe) = rusqlite::Connection::open(&db_path) {
                    let cnt: rusqlite::Result<i64> =
                        probe.query_row("SELECT COUNT(*) FROM laws", [], |r| r.get(0));
                    if let Ok(c) = cnt {
                        if c <= 6 {
                            need_preload = true;
                            let now = chrono::Local::now().format("%Y%m%d-%H%M%S");
                            let bak = dir.join(format!("legal.db.user-{now}.db"));
                            if let Err(e) = std::fs::copy(&db_path, &bak) {
                                eprintln!("[preload] 备份旧空库失败: {e}");
                            }
                        }
                    }
                    drop(probe);
                }
            }
            if need_preload {
                // 兼容多种发布布局：BaseDirectory::Resource、exe 同目录、exe/resources 子目录，及 exe 侧浅层扫描
                let mut candidates: Vec<std::path::PathBuf> = Vec::new();
                if let Ok(p) =
                    app.path().resolve("legal_preload.db", tauri::path::BaseDirectory::Resource)
                {
                    candidates.push(p);
                }
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.to_path_buf()));
                if let Some(exe_dir) = &exe_dir {
                    candidates.push(exe_dir.join("legal_preload.db"));
                    candidates.push(exe_dir.join("resources").join("legal_preload.db"));
                    // 浅层扫描（≤3 层），兼容安装器把资源放到更内层目录的情况
                    let mut stack: Vec<std::path::PathBuf> = vec![exe_dir.clone()];
                    for _ in 0..3 {
                        let mut next: Vec<std::path::PathBuf> = Vec::new();
                        for d in stack.drain(..) {
                            if let Ok(rd) = std::fs::read_dir(&d) {
                                for en in rd.filter_map(Result::ok) {
                                    let p = en.path();
                                    let n = en.file_name().to_string_lossy().to_string();
                                    if n == "node_modules" || n == "target" {
                                        continue;
                                    }
                                    if en.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                                        next.push(p);
                                    } else if n == "legal_preload.db" {
                                        candidates.push(p);
                                    }
                                }
                            }
                        }
                        stack = next;
                    }
                }
                let hit = candidates.into_iter().find(|p| p.exists());
                if let Some(pre) = hit {
                    if let Err(e) = std::fs::copy(&pre, &db_path) {
                        eprintln!("[preload] 拷贝内置法库失败（将使用空库并播种示例）: {e}");
                    } else {
                        println!("[preload] 已装载内置法库 {}", pre.display());
                    }
                } else {
                    eprintln!("[preload] 未找到预置库 legal_preload.db（本机装的是无内置法库的旧安装包？）");
                }
            }
            let conn = db::init(&dir)?;
            app.manage(Mutex::new(conn) as DbState);

            // 自动拉起 Electron 悬浮球（子进程模式）
            let _ = ball::ball_start();
            // 启动 floating-ball → 律政 桥接轮询
            ball::start_bridge_poller(app.handle().clone());

            // 悬浮窗点“关闭”= 收起：拦截销毁、隐藏悬浮窗并恢复主窗口
            if let Some(float_win) = app.get_webview_window("float") {
                let app_h = app.handle().clone();
                float_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(f) = app_h.get_webview_window("float") {
                            let _ = f.hide();
                        }
                        if let Some(m) = app_h.get_webview_window("main") {
                            let _ = m.show();
                            let _ = m.set_focus();
                        }
                    }
                });
            }

            // 后台线程：每 30 秒轮询一次待办，到期的发系统通知
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(30));
                check_todo_notifications(&handle);
            });

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
            import_excel,
            // 悬浮球（Electron）集成
            ball::ball_start_cmd,
            ball::ball_show,
            ball::ball_hide,
            ball::ball_prefill,
            ball::ball_translate,
            ball::ball_quit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}