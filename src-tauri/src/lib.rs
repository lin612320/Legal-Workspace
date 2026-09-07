// 律政工作台 —— Rust 后端入口 + Tauri 命令桥接

mod ball;
mod db;
mod docx;
mod keycrypt;

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

/// 需要加密落盘的设置键（API Key 类）
const SECRET_KEYS: [&str; 2] = ["ai.api_key", "translate.api_key"];

fn is_secret_key(key: &str) -> bool {
    SECRET_KEYS.contains(&key)
}

#[tauri::command]
fn settings_get(conn: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    let c = conn.lock().unwrap();
    let raw = db::get_setting(&c, &key)?;
    Ok(raw.map(|v| {
        if is_secret_key(&key) {
            keycrypt::decrypt(&v)
        } else {
            v
        }
    }))
}

#[tauri::command]
fn settings_set(conn: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let c = conn.lock().unwrap();
    let stored = if is_secret_key(&key) {
        keycrypt::encrypt(&value)
    } else {
        value
    };
    db::set_setting(&c, &key, &stored)
}

/// 启动迁移：把历史明文 API Key 加密落盘（幂等）
fn migrate_secret_keys(conn: &rusqlite::Connection) {
    let Ok(rows) = db::settings_all(conn) else {
        return;
    };
    let mut changed = 0usize;
    for (key, value) in rows {
        if is_secret_key(&key) && !keycrypt::is_encrypted(&value) && !value.is_empty() {
            if db::set_setting(conn, &key, &keycrypt::encrypt(&value)).is_ok() {
                changed += 1;
            }
        }
    }
    if changed > 0 {
        println!("[keycrypt] 已将 {changed} 个明文 API Key 迁移为加密存储");
    }
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

/// 国家判定（按标题/来源特征推导；当前内置库均由 ETL 导入，命名与来源稳定）
/// 中国：标题以“中华人民共和国”开头（内置示例）；美国：美国法典/美利坚标题或 govinfo/constitutioncenter 来源；
/// 日本：来源 elaws.e-gov.go.jp；其余归为“其他”。
/// alias：SQL 中 laws 表的别名（如 "l" / "laws"），避免与 laws_meta 等表的 title 列产生歧义。
fn country_sql(alias: &str) -> String {
    format!(
        "CASE
           WHEN {a}.title LIKE '美国法典%' OR {a}.title LIKE '美利坚合众国宪法%'
                OR {a}.source LIKE '%constitutioncenter%' OR {a}.source LIKE '%govinfo%' THEN '美国'
           WHEN {a}.title LIKE '中华人民共和国%' THEN '中国'
           WHEN {a}.source LIKE '%e-gov.go.jp%' THEN '日本'
           ELSE '其他' END",
        a = alias
    )
}

fn country_where(country: &Option<String>, alias: &str) -> String {
    match country.as_deref().map(|s| s.trim()) {
        Some(c) if !c.is_empty() && c != "全部" => {
            format!("AND {alias} = ?2")
        }
        _ => String::new(),
    }
}

#[tauri::command]
fn laws_search(
    conn: State<'_, DbState>,
    keyword: String,
    country: Option<String>,
) -> Result<Vec<Value>, String> {
    let kw = keyword.trim();
    // 空关键词不返回全量（内置库 15 万条/数百 MB），由前端引导输入关键词
    if kw.is_empty() {
        return Ok(vec![]);
    }
    let c = conn.lock().unwrap();
    let country_cond = country_where(&country, "laws_country");

    // FTS5 优先（关键词 ≥3 个字符），任何异常静默回退 LIKE；
    // FTS 无命中时也回退 LIKE——中文关键词可能只命中 title_zh/content_zh/整部法中文译名
    if kw.chars().count() >= 3 && db::fts_ready(&c) {
        if let Ok(out) = fts_run(&c, kw, country.as_deref(), &country_cond) {
            if !out.is_empty() {
                return Ok(out);
            }
        }
    }
    like_run(&c, kw, country.as_deref(), &country_cond)
}

/// FTS5 检索路径：先取命中 rowid（按相关度），再回表取整行并套用国家筛选
fn fts_run(
    c: &rusqlite::Connection,
    kw: &str,
    country: Option<&str>,
    country_cond: &str,
) -> Result<Vec<Value>, String> {
    let cond_part = if country_cond.is_empty() {
        String::new()
    } else {
        "WHERE laws_country = ?2".to_string()
    };
    let sql = format!(
        "SELECT * FROM (
           SELECT l.id, l.title, l.chapter, l.article_no, l.content, l.source,
                  COALESCE(l.title_zh, m.name_zh) AS title_zh, {} AS laws_country
           FROM (SELECT rowid AS rid FROM laws_fts WHERE laws_fts MATCH ?1 ORDER BY rank LIMIT 300) f
           JOIN laws l ON l.id = f.rid
           LEFT JOIN laws_meta m ON m.title = l.title
         ) {} LIMIT 500",
        country_sql("l"),
        cond_part
    );
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mapper = |r: &rusqlite::Row| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "title": r.get::<_, String>(1)?,
            "chapter": r.get::<_, Option<String>>(2)?,
            "article_no": r.get::<_, Option<String>>(3)?,
            "content": r.get::<_, String>(4)?,
            "source": r.get::<_, Option<String>>(5)?,
            "title_zh": r.get::<_, Option<String>>(6)?,
        }))
    };
    let out: Vec<Value> = if country_cond.is_empty() {
        stmt.query_map(rusqlite::params![db::fts_phrase(kw)], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        let cv = country.unwrap_or("");
        stmt.query_map(rusqlite::params![db::fts_phrase(kw), cv], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(out)
}

/// LIKE 回退路径（FTS 不可用、查询报错或 FTS 无命中时使用）。
/// 赛事版：同时匹配 title_zh / content_zh / 整部法元信息中的中文译名（laws_meta.name_zh / name_orig），
/// 使“中文输入检索”（如输入“宪法”“民法典”）也能命中外法。
fn like_run(
    c: &rusqlite::Connection,
    kw: &str,
    country: Option<&str>,
    country_cond: &str,
) -> Result<Vec<Value>, String> {
    let like = format!("%{kw}%");
    let cond_part = if country_cond.is_empty() {
        String::new()
    } else {
        "WHERE laws_country = ?2".to_string()
    };
    let sql = format!(
        "SELECT id, title, chapter, article_no, content, source, title_zh FROM (
           SELECT l.id, l.title, l.chapter, l.article_no, l.content, l.source,
                  COALESCE(l.title_zh, m.name_zh) AS title_zh,
                  {} AS laws_country
           FROM laws l LEFT JOIN laws_meta m ON m.title = l.title
           WHERE (l.title LIKE ?1 OR l.content LIKE ?1 OR l.article_no LIKE ?1
                  OR l.title_zh LIKE ?1 OR l.content_zh LIKE ?1
                  OR m.name_zh LIKE ?1 OR m.name_orig LIKE ?1)
         ) {} ORDER BY title LIMIT 500",
        country_sql("l"),
        cond_part
    );
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mapper = |r: &rusqlite::Row| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "title": r.get::<_, String>(1)?,
            "chapter": r.get::<_, Option<String>>(2)?,
            "article_no": r.get::<_, Option<String>>(3)?,
            "content": r.get::<_, String>(4)?,
            "source": r.get::<_, Option<String>>(5)?,
            "title_zh": r.get::<_, Option<String>>(6)?,
        }))
    };
    let out: Vec<Value> = if cond_part.is_empty() {
        stmt.query_map([&like], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        let cv = country.unwrap_or("");
        stmt.query_map(rusqlite::params![&like, cv], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(out)
}

#[tauri::command]
fn laws_count(conn: State<'_, DbState>) -> Result<i64, String> {
    let c = conn.lock().unwrap();
    c.query_row("SELECT COUNT(*) FROM laws", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// 国家选项（含条数），用于下拉框展示
#[tauri::command]
fn laws_countries(conn: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let c = conn.lock().unwrap();
    let sql = format!("SELECT {}, COUNT(*) AS rows FROM laws GROUP BY 1 ORDER BY 1", country_sql("laws"));
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "country": r.get::<_, String>(0)?,
                "rows": r.get::<_, i64>(1)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 某国家下按条文数排序的重点法规预览（前 8 部，标题 + 条文数 + 中文译名）
#[tauri::command]
fn laws_country_preview(
    conn: State<'_, DbState>,
    country: Option<String>,
) -> Result<Vec<Value>, String> {
    let c = conn.lock().unwrap();
    let cond = country_where(&country, "laws_country");
    let where_part = if cond.is_empty() {
        String::new()
    } else {
        "WHERE laws_country = ?1".to_string()
    };
    let sql = format!(
        "SELECT title, n, title_zh FROM (
           SELECT l.title AS title, COUNT(*) AS n,
                  MAX(COALESCE(l.title_zh, m.name_zh)) AS title_zh,
                  {} AS laws_country
           FROM laws l LEFT JOIN laws_meta m ON m.title = l.title
           GROUP BY l.title
         ) {}
         ORDER BY n DESC, title LIMIT 8",
        country_sql("l"),
        where_part
    );
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mapper = |r: &rusqlite::Row| {
        Ok(json!({
            "title": r.get::<_, String>(0)?,
            "articles": r.get::<_, i64>(1)?,
            "title_zh": r.get::<_, Option<String>>(2)?,
        }))
    };
    let out: Vec<Value> = if where_part.is_empty() {
        stmt.query_map([], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        let cv = country.as_deref().unwrap_or("");
        stmt.query_map(rusqlite::params![cv], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(out)
}

/// 赛事版：国家专属页数据——顶部国家概览（政体/国体/法律体系）＋按法律领域分组的法律列表。
/// country：日本 / 美国 / 中国。返回 { country, rows, intro, groups:[{ domain, laws:[{title,title_zh,articles}] }] }。
#[tauri::command]
fn laws_country_home(conn: State<'_, DbState>, country: String) -> Result<Value, String> {
    let c = conn.lock().unwrap();
    let intro: Option<String> = c
        .query_row(
            "SELECT intro FROM country_intro WHERE country = ?1",
            [&country],
            |r| r.get(0),
        )
        .ok();
    let rows: i64 = c
        .query_row(
            &format!("SELECT COUNT(*) FROM laws WHERE {} = ?1", country_sql("laws")),
            [&country],
            |r| r.get(0),
        )
        .map_err(|e| format!("统计国家条数失败：{e}"))?;
    let sql = format!(
        "SELECT title, n, title_zh, d FROM (
           SELECT l.title AS title, COUNT(*) AS n,
                  MAX(COALESCE(l.title_zh, m.name_zh)) AS title_zh,
                  COALESCE(m.domain, '未分类') AS d,
                  {} AS laws_country
           FROM laws l LEFT JOIN laws_meta m ON m.title = l.title
           GROUP BY l.title
         ) WHERE laws_country = ?1 ORDER BY n DESC, title LIMIT 600",
        country_sql("l")
    );
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let item = |r: &rusqlite::Row| {
        Ok(json!({
            "title": r.get::<_, String>(0)?,
            "articles": r.get::<_, i64>(1)?,
            "title_zh": r.get::<_, Option<String>>(2)?,
            "domain": r.get::<_, String>(3)?,
        }))
    };
    let list: Vec<Value> = stmt
        .query_map([&country], item)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // 按领域分组（未分类排最后），域内按条数降序
    let mut order: Vec<String> = Vec::new();
    let mut map: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
    for v in list {
        let d = v["domain"].as_str().unwrap_or("未分类").to_string();
        if !map.contains_key(&d) {
            order.push(d.clone());
        }
        map.entry(d).or_default().push(v);
    }
    if let Some(pos) = order.iter().position(|d| d == "未分类") {
        let d = order.remove(pos);
        order.push(d);
    }
    let groups: Vec<Value> = order
        .into_iter()
        .filter_map(|d| {
            let laws = map.remove(&d)?;
            Some(json!({ "domain": d, "laws": laws }))
        })
        .collect();
    Ok(json!({
        "country": country,
        "rows": rows,
        "intro": intro,
        "groups": groups,
    }))
}

/// 赛事版：整部法浏览——元信息（双语名/领域/简介）+ 按条文顺序的完整条文。
/// 条文默认原文；content_zh 非空时前端提供“查看译文”切换。
#[tauri::command]
fn law_page(conn: State<'_, DbState>, title: String) -> Result<Value, String> {
    let c = conn.lock().unwrap();
    let meta = c
        .query_row(
            "SELECT country, domain, name_zh, name_orig, intro FROM laws_meta WHERE title = ?1",
            [&title],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .ok();
    let country = c
        .query_row(
            &format!("SELECT {} FROM laws WHERE title = ?1 LIMIT 1", country_sql("laws")),
            [&title],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "其他".to_string());
    let article_count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM laws WHERE title = ?1",
            [&title],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let mut stmt = c
        .prepare(
            "SELECT id, chapter, article_no, content, content_zh, source
             FROM laws WHERE title = ?1 ORDER BY id LIMIT 8000",
        )
        .map_err(|e| e.to_string())?;
    let articles: Vec<Value> = stmt
        .query_map([&title], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "chapter": r.get::<_, Option<String>>(1)?,
                "article_no": r.get::<_, Option<String>>(2)?,
                "content": r.get::<_, String>(3)?,
                "content_zh": r.get::<_, Option<String>>(4)?,
                "source": r.get::<_, Option<String>>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let (name_zh, name_orig, domain, intro) = meta
        .map(|(_c2, d, nz, no, it)| (nz, no, d, it))
        .unwrap_or((None, None, None, None));
    Ok(json!({
        "title": title,
        "country": country,
        "name_zh": name_zh,
        "name_orig": name_orig,
        "domain": domain,
        "intro": intro,
        "article_count": article_count,
        "articles": articles,
    }))
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
            // 赛事版：可选的中文译名 / 条文中文译文列（Excel 可空）
            let title_zh = col("title_zh").or_else(|| col("中文标题")).or_else(|| col("中文译名"))
                .and_then(|i| row.get(i)).and_then(cell_str)
                .map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            let content_zh = col("content_zh").or_else(|| col("译文")).or_else(|| col("中文内容"))
                .and_then(|i| row.get(i)).and_then(cell_str)
                .map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            c.execute(
                "INSERT INTO laws(title, chapter, article_no, content, source, title_zh, content_zh)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    title,
                    chapter,
                    article_no,
                    content,
                    source.unwrap_or_else(|| "Excel 导入".into()),
                    title_zh,
                    content_zh
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        imported += 1;
    }
    Ok(json!({ "imported": imported, "skipped": skipped }))
}

// ---------------------------------------------------------------------------
// 版块 1：最近文书 + 智能体交付物（documents / docx 导出）
// ---------------------------------------------------------------------------

#[tauri::command]
fn law_by_id(conn: State<'_, DbState>, id: i64) -> Result<Option<Value>, String> {
    let c = conn.lock().unwrap();
    let mut stmt = c
        .prepare("SELECT id, title, chapter, article_no, content, source FROM laws WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([id], |r| {
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
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(None),
    }
}

#[tauri::command]
fn documents_list(conn: State<'_, DbState>) -> Result<Vec<Value>, String> {
    db::documents_list(&conn.lock().unwrap())
}

#[tauri::command]
fn document_save(
    conn: State<'_, DbState>,
    title: String,
    content: Option<String>,
    file_path: Option<String>,
    kind: Option<String>,
    meta: Option<String>,
) -> Result<i64, String> {
    db::document_save(
        &conn.lock().unwrap(),
        &title,
        content.as_deref(),
        file_path.as_deref(),
        kind.as_deref().unwrap_or("doc"),
        meta.as_deref(),
    )
}

#[tauri::command]
fn document_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    db::document_delete(&conn.lock().unwrap(), id)
}

/// 把 Markdown 交付物导出为 .docx；默认输出到 应用数据目录/artifacts
#[tauri::command]
fn docx_export(
    app: AppHandle,
    title: String,
    markdown: String,
    dir: Option<String>,
) -> Result<Value, String> {
    let out_dir = match dir {
        Some(d) if !d.trim().is_empty() => std::path::PathBuf::from(d.trim()),
        _ => {
            let base = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("定位数据目录失败：{e}"))?;
            base.join("artifacts")
        }
    };
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建导出目录失败：{e}"))?;
    let path = docx::export_docx(&out_dir, &title, &markdown)?;
    Ok(json!({
        "path": path.to_string_lossy().into_owned(),
        "dir": out_dir.to_string_lossy().into_owned(),
    }))
}

/// 用系统默认程序打开文件（白名单扩展名；零依赖：调用 Windows explorer 关联打开）
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("文件不存在".into());
    }
    if !p.is_file() {
        return Err("不是文件".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    const OK_EXT: [&str; 10] = ["docx", "doc", "md", "txt", "xlsx", "xls", "pdf", "html", "htm", "csv"];
    if !OK_EXT.contains(&ext.as_str()) {
        return Err(format!("出于安全考虑不支持打开 .{ext} 类型"));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("打开失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (p, ext);
        Err("当前平台暂不支持".into())
    }
}

/// 在资源管理器中定位文件（零依赖：explorer /select）
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("路径不存在".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| format!("打开所在目录失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        Err("当前平台暂不支持".into())
    }
}

// ---------------------------------------------------------------------------
// 智能体：任务（tasks / task_steps / task_artifacts）+ 记忆（mem_vectors）
// ---------------------------------------------------------------------------

#[tauri::command]
fn task_create(
    conn: State<'_, DbState>,
    kind: Option<String>,
    title: String,
    context: Option<String>,
    plan_json: Option<String>,
) -> Result<i64, String> {
    db::task_create(
        &conn.lock().unwrap(),
        kind.as_deref().unwrap_or("agent"),
        &title,
        context.as_deref(),
        plan_json.as_deref(),
    )
}

#[tauri::command]
fn task_list(conn: State<'_, DbState>) -> Result<Vec<Value>, String> {
    db::task_list(&conn.lock().unwrap())
}

#[tauri::command]
fn task_get(conn: State<'_, DbState>, id: i64) -> Result<Option<Value>, String> {
    db::task_get(&conn.lock().unwrap(), id)
}

#[tauri::command]
fn task_set_status(conn: State<'_, DbState>, id: i64, status: String) -> Result<(), String> {
    db::task_set_status(&conn.lock().unwrap(), id, &status)
}

#[tauri::command]
fn task_delete(conn: State<'_, DbState>, id: i64) -> Result<(), String> {
    db::task_delete(&conn.lock().unwrap(), id)
}

/// 全量替换某任务的步骤（计划卡确认后写入），返回新步骤 id 列表
#[tauri::command]
fn task_steps_save(
    conn: State<'_, DbState>,
    task_id: i64,
    steps: Vec<Value>,
) -> Result<Vec<i64>, String> {
    db::task_steps_save(&conn.lock().unwrap(), task_id, &steps)
}

#[tauri::command]
fn task_step_update(
    conn: State<'_, DbState>,
    step_id: i64,
    status: String,
    result_ref: Option<String>,
) -> Result<(), String> {
    db::task_step_update(&conn.lock().unwrap(), step_id, &status, result_ref.as_deref())
}

#[tauri::command]
fn task_artifact_add(
    conn: State<'_, DbState>,
    task_id: i64,
    kind: String,
    file_path: Option<String>,
    title: Option<String>,
    content: Option<String>,
    meta_json: Option<String>,
) -> Result<i64, String> {
    db::task_artifact_add(
        &conn.lock().unwrap(),
        task_id,
        &kind,
        file_path.as_deref(),
        title.as_deref(),
        content.as_deref(),
        meta_json.as_deref(),
    )
}

/// 保存一条记忆（embedding 由前端计算后回存）
#[tauri::command]
fn mem_save(
    conn: State<'_, DbState>,
    kind: Option<String>,
    ref_id: Option<i64>,
    title: String,
    content: String,
    vector_json: String,
) -> Result<i64, String> {
    db::mem_save(
        &conn.lock().unwrap(),
        kind.as_deref().unwrap_or("task"),
        ref_id,
        &title,
        &content,
        &vector_json,
    )
}

#[tauri::command]
fn mem_list(conn: State<'_, DbState>, kind: Option<String>) -> Result<Vec<Value>, String> {
    db::mem_list(&conn.lock().unwrap(), kind.as_deref())
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
            .title("法元 · 待办提醒")
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
            // 历史明文 API Key → 加密存储（幂等迁移）
            migrate_secret_keys(&conn);
            app.manage(Mutex::new(conn) as DbState);

            // 自动拉起 Electron 悬浮球（子进程模式）；失败不再静默
            if let Err(e) = ball::ball_start() {
                eprintln!("[ball] 自动拉起悬浮球失败：{e}");
            }
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
            laws_count,
            laws_countries,
            laws_country_preview,
            // 赛事版：国家页概览（政体/法律体系 + 领域分组）与整部法浏览
            laws_country_home,
            law_page,
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
            // 智能体（数字员工）：文书交付物与任务状态机
            law_by_id,
            documents_list,
            document_save,
            document_delete,
            docx_export,
            task_create,
            task_list,
            task_get,
            task_set_status,
            task_delete,
            task_steps_save,
            task_step_update,
            task_artifact_add,
            mem_save,
            mem_list,
            // 交付物打开/定位（桌面）
            open_file,
            reveal_in_folder,
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