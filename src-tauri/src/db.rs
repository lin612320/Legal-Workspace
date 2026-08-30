use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

/// 全局数据库连接（SQLite 本地库）
pub type DbState = Mutex<Connection>;

/// 初始化数据库：确保文件存在、建立数据目录、执行表结构迁移。
/// 返回已打开的连接；失败时返回错误字符串。
pub fn init(app_data_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;

    let db_path = app_data_dir.join("legal.db");
    let conn = Connection::open(&db_path).map_err(|e| format!("打开数据库失败：{e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("设置 WAL 失败：{e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("启用外键失败：{e}"))?;

    migrate(&conn)?;
    Ok(conn)
}

/// 表结构迁移（包含 8 版块所需的核心表）
fn migrate(conn: &Connection) -> Result<(), String> {
    // 键值设置（AI / 翻译 API、备份配置、偏好）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 版块 2：法律法规（由 Excel 导入）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS laws (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            chapter    TEXT,
            article_no TEXT,
            content    TEXT NOT NULL,
            source     TEXT
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 版块 3：文书模板
    conn.execute(
        "CREATE TABLE IF NOT EXISTS templates (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            title     TEXT NOT NULL,
            category  TEXT,
            content   TEXT NOT NULL,
            file_type TEXT,
            built_in  INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 版块 6：待办提醒
    conn.execute(
        "CREATE TABLE IF NOT EXISTS todos (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            title          TEXT NOT NULL,
            note           TEXT,
            due_at         TEXT,
            remind_minutes INTEGER NOT NULL DEFAULT 0,
            desktop_popup  INTEGER NOT NULL DEFAULT 1,
            done           INTEGER NOT NULL DEFAULT 0,
            created_at     TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 版块 1：最近处理的文书
    conn.execute(
        "CREATE TABLE IF NOT EXISTS documents (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            content    TEXT,
            updated_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 版块 2：法规表无数据时播种少量示例条文，便于即时体验检索
    seed_laws_if_empty(conn)?;

    // 版块 3：模板表无数据时播种内置文书
    seed_templates_if_empty(conn)?;

    Ok(())
}

/// 若 templates 表为空则插入少量内置模板（自建/导入用 same 表）。
fn seed_templates_if_empty(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM templates", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count > 0 {
        return Ok(());
    }
    let samples: &[&[&str]] = &[
        &
        [
            "授权委托书",
            "授权文书",
            "委托人：________，身份证号：________。\n受托人：________，执业证号：________。\n\n现委托上述受托人在我方与________纠纷一案中，作为我方________阶段的委托代理人。\n代理权限：一般代理 / 特别授权（代为承认、放弃、变更诉讼请求，进行和解，提起反诉或者上诉，接收法律文书等）。\n\n委托人（签名）：________\n____年__月__日",
            "txt",
        ],
        &
        [
            "民事起诉状",
            "诉讼文书",
            "原告：姓名____，性别____，住址________，联系方式________。\n被告：姓名____，性别____，住址________，联系方式________。\n\n诉讼请求：\n一、判令被告……\n二、本案诉讼费由被告承担。\n\n事实与理由：\n……\n\n此致\n________人民法院\n\n具状人：____\n____年__月__日",
            "txt",
        ],
        &
        [
            "劳动仲裁申请书",
            "劳动仲裁",
            "申请人：____，住址________。\n被申请人：________公司，住所地________。\n\n仲裁请求：\n一、要求被申请人支付____元；\n二、要求被申请人________。\n\n事实与理由：\n……\n\n此致\n________劳动人事争议仲裁委员会\n\n申请人：____\n____年__月__日",
            "txt",
        ],
        &
        [
            "律师函模板",
            "函件",
            "致：________\n本所受________委托，就贵方________事宜，出具本律师函如下：\n一、事实概述……\n二、法律依据……\n三、律师意见/催告……\n\n请贵方于本函送达后____日内________，逾期本所将依委托人授权采取法律途径。\n\n特此函告。\n\n________律师事务所\n____年__月__日",
            "txt",
        ],
        &
        [
            "房屋租赁合同（简）",
            "合同",
            "出租方（甲方）：____；承租方（乙方）：____。\n\n第一条 房屋基本情况：位于________。\n第二条 租赁期限：自____年__月__日至____年__月__日。\n第三条 租金及支付：每月人民币____元，于每月__日前支付。\n第四条 定金及押金：____。\n第五条 双方权利义务：……\n第六条 违约责任：……\n\n甲方：____　乙方：____\n____年__月__日",
            "txt",
        ],
    ];
    for s in samples {
        conn.execute(
            "INSERT INTO templates(title, category, content, file_type, built_in)
             VALUES (?1, ?2, ?3, ?4, 1)",
            rusqlite::params![s[0], s[1], s[2], s[3]],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 若 laws 表为空则插入示例条文（正式数据将由「数据导入」的 Excel 覆盖/补充）。
fn seed_laws_if_empty(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM laws", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count > 0 {
        return Ok(());
    }
    let samples: &[&[&str]] = &[
        // title, chapter, article_no, content
        &[
            "中华人民共和国民法典",
            "第一编 总则",
            "第一条",
            "为了保护民事主体的合法权益，调整民事关系，维护社会和经济秩序，适应中国特色社会主义发展要求，弘扬社会主义核心价值观，根据宪法，制定本法。",
        ],
        &[
            "中华人民共和国民法典",
            "第一编 总则",
            "第三条",
            "民事主体的人身权利、财产权利以及其他合法权益受法律保护，任何组织或者个人不得侵犯。",
        ],
        &[
            "中华人民共和国民法典",
            "第一编 总则",
            "第一百四十三条",
            "具备下列条件的民事法律行为有效：（一）行为人具有相应的民事行为能力；（二）意思表示真实；（三）不违反法律、行政法规的强制性规定，不违背公序良俗。",
        ],
        &[
            "中华人民共和国民法典",
            "第三编 合同",
            "第五百零二条",
            "依法成立的合同，自成立时生效，但是法律另有规定或者当事人另有约定的除外。",
        ],
        &[
            "中华人民共和国民法典",
            "第三编 合同",
            "第五百七十七条",
            "当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。",
        ],
        &[
            "中华人民共和国民法典",
            "第四编 人格权",
            "第一千零三十二条",
            "自然人享有隐私权。任何组织或者个人不得以刺探、侵扰、泄露、公开等方式侵害他人的隐私权。",
        ],
    ];
    for s in samples {
        conn.execute(
            "INSERT INTO laws(title, chapter, article_no, content, source)
             VALUES (?1, ?2, ?3, ?4, '内置示例')",
            rusqlite::params![s[0], s[1], s[2], s[3]],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 读取一条设置
pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([key]).map_err(|e| e.to_string())?;
    let row = rows.next().map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.get::<_, String>(0).unwrap_or_default()))
}

/// 写入一条设置
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}