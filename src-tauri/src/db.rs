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

/// 若表缺列则补列（幂等兼容迁移）
fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), String> {
    let has: bool = {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| e.to_string())?;
        let cols = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        let mut found = false;
        for c in cols {
            if c.map_err(|e| e.to_string())? == column {
                found = true;
                break;
            }
        }
        found
    };
    if !has {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"), [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 表结构迁移（包含全部版块与智能体任务所需的表）
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

    // 赛事版：law 支持中文译名（title_zh）与条文中文译文（content_zh）。
    // 老库（含预置库）自动补列；两者可空——无译文时界面仍只显示原文。
    ensure_column(conn, "laws", "title_zh", "TEXT")?;
    ensure_column(conn, "laws", "content_zh", "TEXT")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_laws_title ON laws(title)",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 赛事版：整部法元信息（中文译名/原文名/法律领域/简介），按 laws.title 关联（每部法一行）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS laws_meta (
            title     TEXT PRIMARY KEY,   -- 对应 laws.title（精确匹配）
            country   TEXT,               -- 日本 / 美国 / 中国
            domain    TEXT,               -- 法律领域（宪法·国家法 / 民法 / 刑法 …）
            name_zh   TEXT,               -- 中文译名（如 日本国宪法 / 美国法典 Title 42 中文名）
            name_orig TEXT,               -- 原文名（如 Constitution of the United States / Title 42 — The Public Health and Welfare）
            intro     TEXT                -- 整部法简介（元信息展示用）
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 赛事版：国家页顶部概览（政体 / 国体 / 法律体系），每国一行
    conn.execute(
        "CREATE TABLE IF NOT EXISTS country_intro (
            country TEXT PRIMARY KEY,     -- 日本 / 美国 / 中国
            intro   TEXT NOT NULL
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

    // 兼容迁移：todos 增加 last_notified_due（已提醒的到期时间，避免重复提醒）
    let has_notified_col: bool = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(todos)")
            .map_err(|e| e.to_string())?;
        let cols = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        let mut found = false;
        for c in cols {
            if c.map_err(|e| e.to_string())? == "last_notified_due" {
                found = true;
                break;
            }
        }
        found
    };
    if !has_notified_col {
        conn.execute("ALTER TABLE todos ADD COLUMN last_notified_due TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    // 版块 1：最近处理的文书（智能体交付物落点）
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
    // 兼容迁移：documents 增加交付物元信息列
    ensure_column(conn, "documents", "file_path", "TEXT")?;
    ensure_column(conn, "documents", "kind", "TEXT NOT NULL DEFAULT 'doc'")?;
    ensure_column(conn, "documents", "meta", "TEXT")?;

    // 版块 4：AI 助手会话（多会话：chat_sessions + chat_messages）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_sessions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL DEFAULT 0,
            role       TEXT NOT NULL,
            content    TEXT NOT NULL,
            seq        INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 兼容迁移：旧版 chat_messages 表无 session_id 列，补充添加
    let has_session_col: bool = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(chat_messages)")
            .map_err(|e| e.to_string())?;
        let cols = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        let mut found = false;
        for c in cols {
            if c.map_err(|e| e.to_string())? == "session_id" {
                found = true;
                break;
            }
        }
        found
    };
    if !has_session_col {
        conn.execute(
            "ALTER TABLE chat_messages ADD COLUMN session_id INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    // 旧数据（session_id=0）归入一个默认会话
    conn.execute(
        "INSERT OR IGNORE INTO chat_sessions(id, title, created_at, updated_at)
         SELECT 0, '默认会话', datetime('now'), datetime('now')
         WHERE EXISTS (SELECT 1 FROM chat_messages WHERE session_id = 0)",
        [],
    )
    .map_err(|e| e.to_string())?;

    // —— 智能体（数字员工）：任务 / 步骤 / 交付物 / 记忆 ——
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tasks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            kind       TEXT NOT NULL DEFAULT 'agent',
            title      TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'planned',
            context    TEXT,
            plan_json  TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS task_steps (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id       INTEGER NOT NULL DEFAULT 0,
            seq           INTEGER NOT NULL,
            name          TEXT NOT NULL,
            tool          TEXT,
            params_json   TEXT,
            status        TEXT NOT NULL DEFAULT 'pending',
            result_ref    TEXT,
            need_confirm  INTEGER NOT NULL DEFAULT 0,
            started_at    TEXT,
            updated_at    TEXT
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS task_artifacts (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id    INTEGER NOT NULL DEFAULT 0,
            kind       TEXT NOT NULL,
            file_path  TEXT,
            title      TEXT,
            content    TEXT,
            meta_json  TEXT,
            created_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 记忆向量：前端计算 embedding 后回存，供跨任务召回（P2 长期记忆）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS mem_vectors (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            kind        TEXT NOT NULL DEFAULT 'task',
            ref_id      INTEGER,
            title       TEXT,
            content     TEXT,
            vector_json TEXT,
            created_at  TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 0.7.0：知识图谱（案由-要件-法条-证据-文书）——涉外案由优先，候选边需人工确认
    conn.execute(
        "CREATE TABLE IF NOT EXISTS kg_node (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            type       TEXT NOT NULL,
            name       TEXT NOT NULL,
            name_alt   TEXT,
            source     TEXT,
            confidence REAL NOT NULL DEFAULT 1.0,
            note       TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(type, name)
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS kg_edge (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            src        INTEGER NOT NULL,
            rel        TEXT NOT NULL,
            dst        INTEGER NOT NULL,
            weight     REAL NOT NULL DEFAULT 1.0,
            source     TEXT,
            confidence REAL NOT NULL DEFAULT 1.0,
            confirmed  INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            UNIQUE(src, rel, dst)
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_kg_edge_src ON kg_edge(src)", [])
        .map_err(|e| e.to_string())?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_kg_edge_dst ON kg_edge(dst)", [])
        .map_err(|e| e.to_string())?;

    // 0.7.0：任务材料（多模态导入：PDF / DOCX / XLSX / PPTX / 图片 等提取后的文本）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS task_attachments (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id    INTEGER NOT NULL DEFAULT 0,
            file_name  TEXT NOT NULL,
            file_path  TEXT NOT NULL,
            kind       TEXT,
            size_bytes INTEGER,
            text       TEXT,
            blocks     INTEGER,
            truncated  INTEGER NOT NULL DEFAULT 0,
            note       TEXT,
            created_at TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 法规 FTS5 全文索引（P2）：在种子数据之后建索引更合理（见 migrate 尾部）
    // 版块 2：法规表无数据时播种少量示例条文，便于即时体验检索
    seed_laws_if_empty(conn)?;
    // 版块 3：模板表无数据时播种内置文书
    seed_templates_if_empty(conn)?;

    // 0.7.0：幂等补齐新增的内置模板（证据目录 / 代理词）——老库升级后也能拿到
    ensure_builtin_templates(conn)?;

    // 赛事版：国家概览与整部法元信息（仅首次播种，不覆盖导入/更新的元数据）
    seed_country_intro_if_empty(conn)?;
    seed_laws_meta_if_empty(conn)?;

    // 0.7.0：知识图谱种子（涉外案由优先；按 type+name 幂等，可重复启动）
    seed_kg_if_empty(conn)?;

    // 赛事版：美国宪法官方中译（Preamble + Article I–VII）按 article_no 回填 content_zh（幂等，仅补空值）
    enrich_us_constitution_zh(conn)?;

    // FTS5 建索引（幂等、失败静默回退 LIKE）；放播种之后，保证索引与数据一致
    let _ = ensure_laws_fts(conn);

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

/// 0.7.0：幂等补齐「新增版本才引入」的内置模板。
/// `seed_templates_if_empty` 只在空表时播种，老库升级后不会补新模板，故单列此函数按标题补。
fn ensure_builtin_templates(conn: &Connection) -> Result<(), String> {
    let extra: &[(&str, &str, &str)] = &[
        (
            "证据目录",
            "诉讼文书",
            "证据目录\n\n案号：________　　当事人：________\n\n| 序号 | 证据名称 | 证据种类 | 证明对象 | 来源/页码 | 备注 |\n| --- | --- | --- | --- | --- | --- |\n| 1 | ________ | 书证 | ________ | ________ | ________ |\n| 2 | ________ | 物证 | ________ | ________ | ________ |\n| 3 | ________ | 电子数据 | ________ | ________ | ________ |\n\n以上证据共____份，随本目录一并提交。\n\n提交人（签名）：________\n____年__月__日",
        ),
        (
            "代理词（民事）",
            "诉讼文书",
            "代理词\n\n尊敬的审判长、审判员：\n________律师事务所接受________的委托，指派本律师担任其与________纠纷一案的________代理人。现结合本案事实与法律规定，发表如下代理意见：\n\n一、案件基本情况与争议焦点\n……\n\n二、事实认定意见\n……\n\n三、法律适用意见\n……\n\n四、代理意见与请求\n……\n\n五、结语\n……\n\n代理人：________\n________律师事务所\n____年__月__日",
        ),
    ];
    for (title, category, content) in extra {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM templates WHERE title = ?1",
                [title],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            conn.execute(
                "INSERT INTO templates(title, category, content, file_type, built_in)
                 VALUES (?1, ?2, ?3, 'txt', 1)",
                rusqlite::params![title, category, content],
            )
            .map_err(|e| e.to_string())?;
        }
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

/// 赛事版：国家页顶部概览（政体 / 国体 / 法律体系）首启播种；仅当表空时插入。
fn seed_country_intro_if_empty(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM country_intro", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count > 0 {
        return Ok(());
    }
    let rows: &[(&str, &str)] = &[
        (
            "日本",
            "日本国是议会内阁制君主立宪国家：天皇是日本国及日本国民整体的象征，仅从事宪法规定的国事行为，不拥有统治权；国会（众议院·参议院）是国家的最高权力机关与唯一立法机关。法律体系属大陆法系成文法传统，现行《日本国宪法》1947年5月3日施行，确立国民主权、基本人权保障与和平主义三大原则；法令按法律、政令、省令等层级发布，官方日文条文由 e-Gov 提供。",
        ),
        (
            "美国",
            "美利坚合众国是联邦制总统制共和国：联邦政府实行立法（国会两院）、行政（总统）、司法（联邦最高法院）三权分立与制衡，各州享有较大自治权。法律体系属普通法系，联邦成文法按主题汇编为《美国法典》（United States Code），现行宪法于1788年6月21日经各州批准生效，正文7条并附27条修正案，是联邦最高法；官方英文条文由 govinfo / constitutioncenter 提供。",
        ),
        (
            "中国",
            "中华人民共和国是社会主义国家，实行人民民主专政与人民代表大会制度：全国人民代表大会是最高国家权力机关，国务院即中央人民政府。法律体系为成文法（大陆法系传统），以宪法为根本法，法律、行政法规、地方性法规等分层立法。当前应用内置《民法典》等示例条文供演示，中文全量法库列入 0.7.0 计划。",
        ),
    ];
    for (c, intro) in rows {
        conn.execute(
            "INSERT INTO country_intro(country, intro) VALUES (?1, ?2)",
            rusqlite::params![c, intro],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 赛事版：整部法元信息（重点法双语名 / 法律领域 / 简介），仅当表空播种；
/// 后续数据导入 / 更新不受影响（不覆盖已有行）。
fn seed_laws_meta_if_empty(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM laws_meta", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count > 0 {
        return Ok(());
    }
    // (title, country, domain, name_zh, name_orig, intro)
    let rows: &[(&str, &str, &str, &str, Option<&str>, Option<&str>)] = &[
        (
            "日本国憲法",
            "日本",
            "宪法·国家法",
            "日本国宪法",
            None,
            Some("1947年5月3日施行的日本现行宪法，共11章103条（另附前文），确立国民主权、尊重基本人权与和平主义三大原则，第九条宣示放弃战争。库内条文为 e-Gov 官方日文原文。"),
        ),
        ("民法", "日本", "民法", "日本民法典", None, None),
        ("刑法", "日本", "刑法", "日本刑法", None, None),
        ("会社法", "日本", "商法·公司法", "日本公司法", None, None),
        ("商法", "日本", "商法", "日本商法", None, None),
        ("労働基準法", "日本", "劳动与社会保障法", "日本劳动基准法", None, None),
        ("著作権法", "日本", "知识产权法", "日本著作权法", None, None),
        ("民事訴訟法", "日本", "民事程序法", "日本民事诉讼法", None, None),
        ("刑事訴訟法", "日本", "刑事程序法", "日本刑事诉讼法", None, None),
        (
            "美利坚合众国宪法",
            "美国",
            "宪法",
            "美利坚合众国宪法",
            Some("Constitution of the United States"),
            Some("1788年6月21日经各州批准生效的美国联邦最高法：正文7条确立三权分立与联邦制（Article I–VII），并附27条修正案（Amendment I–XXVII）。库内条文为 constitutioncenter.org 英文原文。"),
        ),
        (
            "美国法典 Title 42 — 公共卫生与福利",
            "美国",
            "卫生与社会保障法",
            "美国法典 Title 42 — 公共卫生与福利",
            Some("Title 42 — The Public Health and Welfare"),
            None,
        ),
        (
            "美国法典 Title 15 — 商业与贸易",
            "美国",
            "商法·贸易法",
            "美国法典 Title 15 — 商业与贸易",
            Some("Title 15 — Commerce and Trade"),
            None,
        ),
        (
            "美国法典 Title 10 — 武装力量",
            "美国",
            "国防法",
            "美国法典 Title 10 — 武装力量",
            Some("Title 10 — Armed Forces"),
            None,
        ),
        (
            "美国法典 Title 26 — 国内税收法典",
            "美国",
            "税法",
            "美国法典 Title 26 — 国内税收法典",
            Some("Title 26 — Internal Revenue Code"),
            None,
        ),
        (
            "美国法典 Title 7 — 农业",
            "美国",
            "农业法",
            "美国法典 Title 7 — 农业",
            Some("Title 7 — Agriculture"),
            None,
        ),
        (
            "美国法典 Title 16 — 自然资源保护",
            "美国",
            "环境与自然资源法",
            "美国法典 Title 16 — 自然资源保护",
            Some("Title 16 — Conservation"),
            None,
        ),
        (
            "中华人民共和国民法典",
            "中国",
            "民法",
            "中华人民共和国民法典",
            None,
            Some("2021年1月1日起施行的《中华人民共和国民法典》，共7编1260条，覆盖总则、物权、合同、人格权、婚姻家庭、继承与侵权责任。应用内置库仅收录其中6条示例条文。"),
        ),
    ];
    for (title, country, domain, name_zh, name_orig, intro) in rows {
        conn.execute(
            "INSERT INTO laws_meta(title, country, domain, name_zh, name_orig, intro)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![title, country, domain, name_zh, name_orig, intro],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 赛事版：把「美国宪法官方中译」按 article_no 回填到 `laws.content_zh`（仅当该行无译文时）。
/// 数据源：`src-tauri/src/data/us_const_zh.json`（由《法库ETL工作区》对齐脚本从官方中译 PDF 生成，
/// 覆盖 Preamble + Article I–VII 共 25 段，不含修正案）。通过 settings 键 `zh.us_const_done` 保证只执行一次。
fn enrich_us_constitution_zh(conn: &Connection) -> Result<(), String> {
    if let Some(v) = get_setting(conn, "zh.us_const_done").map_err(|e| e.to_string())? {
        if !v.is_empty() {
            return Ok(());
        }
    }
    let json: &str = include_str!("data/us_const_zh.json");
    let val: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("解析 us_const_zh.json 失败：{e}"))?;
    let Some(entries) = val.get("entries").and_then(|v| v.as_array()) else {
        return Err("us_const_zh.json 缺少 entries".into());
    };
    let title = val
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("美利坚合众国宪法");
    let mut updated: usize = 0;
    for ent in entries {
        let no = ent.get("article_no").and_then(|v| v.as_str()).unwrap_or("");
        let text = ent.get("text").and_then(|v| v.as_str()).unwrap_or("");
        if no.is_empty() || text.is_empty() {
            continue;
        }
        updated += conn
            .execute(
                "UPDATE laws SET content_zh = ?3
                 WHERE title = ?1 AND article_no = ?2
                   AND (content_zh IS NULL OR content_zh = '')",
                rusqlite::params![title, no, text],
            )
            .map_err(|e| e.to_string())?;
    }
    if updated > 0 {
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('zh.us_const_done', '1')
             ON CONFLICT(key) DO UPDATE SET value = '1'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 读取一条设置
pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([key]).map_err(|e| e.to_string())?;
    let row = rows.next().map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.get::<_, String>(0).unwrap_or_default()))
}

/// 列出全部设置（用于启动时密钥迁移）
pub fn settings_all(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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

/// 一条 AI 对话消息（与前端 ChatMsg 对应）
#[derive(serde::Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// 会话列表（含消息数，按最近更新排序）
pub fn chat_sessions_list(conn: &Connection) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.title, s.updated_at, COUNT(m.id)
             FROM chat_sessions s
             LEFT JOIN chat_messages m ON m.session_id = s.id
             GROUP BY s.id
             ORDER BY s.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "title": r.get::<_, String>(1)?,
                "updated_at": r.get::<_, String>(2)?,
                "count": r.get::<_, i64>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 新建会话，返回 id
pub fn chat_session_create(conn: &Connection, title: &str) -> Result<i64, String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO chat_sessions(title, created_at, updated_at) VALUES (?1, ?2, ?2)",
        rusqlite::params![title, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// 重命名会话
pub fn chat_session_rename(conn: &Connection, id: i64, title: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE chat_sessions SET title = ?1 WHERE id = ?2",
        rusqlite::params![title, id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// 删除会话（级联删除其消息）
pub fn chat_session_delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM chat_messages WHERE session_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chat_sessions WHERE id = ?1", [id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 读取指定会话的记录（按 seq 排序）
pub fn chat_history_load(
    conn: &Connection,
    session_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare("SELECT role, content FROM chat_messages WHERE session_id = ?1 ORDER BY seq")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([session_id], |r| {
            Ok(serde_json::json!({
                "role": r.get::<_, String>(0)?,
                "content": r.get::<_, String>(1)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 整体保存指定会话（先清空再写入，保证与前端状态一致），并刷新 updated_at
pub fn chat_history_save(
    conn: &Connection,
    session_id: i64,
    messages: &[ChatMsg],
) -> Result<(), String> {
    conn.execute("DELETE FROM chat_messages WHERE session_id = ?1", [session_id])
        .map_err(|e| e.to_string())?;
    for (i, m) in messages.iter().enumerate() {
        conn.execute(
            "INSERT INTO chat_messages(session_id, role, content, seq) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![session_id, m.role, m.content, i as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, session_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// FTS5 全文索引（P2）：外部内容表，任何一步失败都不致命（回退 LIKE 检索）
// ---------------------------------------------------------------------------

const FTS_COUNT_KEY: &str = "fts.laws_count";

/// FTS5 是否可用（表存在即可视为可用；创建失败视为不支持）
pub fn fts_ready(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='laws_fts'",
        [],
        |_| Ok(()),
    )
    .is_ok()
}

/// 幂等创建 FTS5 外部内容表 + 同步触发器，并在条数变化时重建索引。
/// 返回是否可用；整个过程失败只会打日志，不影响主流程。
pub fn ensure_laws_fts(conn: &Connection) -> bool {
    if let Err(e) = conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS laws_fts USING fts5(
            title, chapter, article_no, content,
            content='laws', content_rowid='id', tokenize='trigram'
        )",
        [],
    ) {
        eprintln!("[fts] 创建 laws_fts 失败（将回退 LIKE 检索）: {e}");
        return false;
    }
    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS laws_ai AFTER INSERT ON laws BEGIN
            INSERT INTO laws_fts(rowid, title, chapter, article_no, content)
            VALUES (new.id, new.title, new.chapter, new.article_no, new.content);
         END",
        [],
    );
    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS laws_ad AFTER DELETE ON laws BEGIN
            INSERT INTO laws_fts(laws_fts, rowid, title, chapter, article_no, content)
            VALUES ('delete', old.id, old.title, old.chapter, old.article_no, old.content);
         END",
        [],
    );
    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS laws_au AFTER UPDATE ON laws BEGIN
            INSERT INTO laws_fts(laws_fts, rowid, title, chapter, article_no, content)
            VALUES ('delete', old.id, old.title, old.chapter, old.article_no, old.content);
            INSERT INTO laws_fts(rowid, title, chapter, article_no, content)
            VALUES (new.id, new.title, new.chapter, new.article_no, new.content);
         END",
        [],
    );
    // 条数变化或首次启动时重建一次（预置库 15 万条首次约数秒，一次性成本）
    let want_rebuild = match get_setting(conn, FTS_COUNT_KEY) {
        Ok(Some(stored)) => stored
            .parse::<i64>()
            .map(|n| n != laws_count(conn))
            .unwrap_or(true),
        _ => true,
    };
    if want_rebuild {
        if let Err(e) = conn.execute("INSERT INTO laws_fts(laws_fts) VALUES('rebuild')", []) {
            eprintln!("[fts] 重建索引失败（将回退 LIKE 检索）: {e}");
            return false;
        }
        let _ = set_setting(conn, FTS_COUNT_KEY, &laws_count(conn).to_string());
    }
    fts_ready(conn)
}

pub fn laws_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM laws", [], |r| r.get(0)).unwrap_or(0)
}

/// 把用户关键词转成 FTS5 MATCH 短语（引号包裹 + 双引号转义），防注入/语法冲突
pub fn fts_phrase(keyword: &str) -> String {
    format!("\"{}\"", keyword.replace('"', "\"\""))
}

// ---------------------------------------------------------------------------
// 版块 1：最近文书（documents）—— 智能体交付物落点
// ---------------------------------------------------------------------------

pub fn documents_list(conn: &Connection) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, file_path, kind, meta, updated_at
             FROM documents ORDER BY updated_at DESC LIMIT 200",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "title": r.get::<_, String>(1)?,
                "content": r.get::<_, Option<String>>(2)?,
                "file_path": r.get::<_, Option<String>>(3)?,
                "kind": r.get::<_, String>(4)?,
                "meta": r.get::<_, Option<String>>(5)?,
                "updated_at": r.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn document_save(
    conn: &Connection,
    title: &str,
    content: Option<&str>,
    file_path: Option<&str>,
    kind: &str,
    meta: Option<&str>,
) -> Result<i64, String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO documents(title, content, file_path, kind, meta, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![title, content, file_path, kind, meta, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn document_delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM documents WHERE id = ?1", [id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 智能体任务（tasks / task_steps / task_artifacts）
// ---------------------------------------------------------------------------

pub fn task_create(
    conn: &Connection,
    kind: &str,
    title: &str,
    context: Option<&str>,
    plan_json: Option<&str>,
) -> Result<i64, String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO tasks(kind, title, status, context, plan_json, created_at, updated_at)
         VALUES (?1, ?2, 'planned', ?3, ?4, ?5, ?5)",
        rusqlite::params![kind, title, context, plan_json, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

fn task_row_to_json(
    r: &rusqlite::Row,
) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": r.get::<_, i64>(0)?,
        "kind": r.get::<_, String>(1)?,
        "title": r.get::<_, String>(2)?,
        "status": r.get::<_, String>(3)?,
        "context": r.get::<_, Option<String>>(4)?,
        "plan_json": r.get::<_, Option<String>>(5)?,
        "created_at": r.get::<_, String>(6)?,
        "updated_at": r.get::<_, String>(7)?,
    }))
}

pub fn task_list(conn: &Connection) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, title, status, context, plan_json, created_at, updated_at
             FROM tasks ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], task_row_to_json)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn task_get(conn: &Connection, id: i64) -> Result<Option<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, title, status, context, plan_json, created_at, updated_at
             FROM tasks WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([id], task_row_to_json)
        .map_err(|e| e.to_string())?;
    let task = match rows.next() {
        Some(Ok(v)) => v,
        Some(Err(e)) => return Err(e.to_string()),
        None => return Ok(None),
    };
    // steps
    let steps: Vec<serde_json::Value> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, seq, name, tool, params_json, status, result_ref,
                        need_confirm, started_at, updated_at
                 FROM task_steps WHERE task_id = ?1 ORDER BY seq",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([id], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "task_id": r.get::<_, i64>(1)?,
                    "seq": r.get::<_, i64>(2)?,
                    "name": r.get::<_, String>(3)?,
                    "tool": r.get::<_, Option<String>>(4)?,
                    "params_json": r.get::<_, Option<String>>(5)?,
                    "status": r.get::<_, String>(6)?,
                    "result_ref": r.get::<_, Option<String>>(7)?,
                    "need_confirm": r.get::<_, i64>(8)? == 1,
                    "started_at": r.get::<_, Option<String>>(9)?,
                    "updated_at": r.get::<_, Option<String>>(10)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    // artifacts
    let artifacts: Vec<serde_json::Value> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, kind, file_path, title, content, meta_json, created_at
                 FROM task_artifacts WHERE task_id = ?1 ORDER BY id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([id], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "file_path": r.get::<_, Option<String>>(2)?,
                    "title": r.get::<_, Option<String>>(3)?,
                    "content": r.get::<_, Option<String>>(4)?,
                    "meta_json": r.get::<_, Option<String>>(5)?,
                    "created_at": r.get::<_, String>(6)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    Ok(Some(serde_json::json!({
        "task": task,
        "steps": steps,
        "artifacts": artifacts,
    })))
}

pub fn task_set_status(
    conn: &Connection,
    id: i64,
    status: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE tasks SET status = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![status, now, id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn task_delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM task_steps WHERE task_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM task_artifacts WHERE task_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", [id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 全量替换某任务的步骤（计划卡确认后调用）；返回新步骤 id 列表（顺序与入参一致）
pub fn task_steps_save(
    conn: &Connection,
    task_id: i64,
    steps: &[serde_json::Value],
) -> Result<Vec<i64>, String> {
    conn.execute("DELETE FROM task_steps WHERE task_id = ?1", [task_id])
        .map_err(|e| e.to_string())?;
    let mut ids = Vec::with_capacity(steps.len());
    for (i, s) in steps.iter().enumerate() {
        let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("步骤");
        let tool = s.get("tool").and_then(|v| v.as_str());
        let params_json = s
            .get("params")
            .map(|v| v.to_string())
            .or_else(|| s.get("params_json").and_then(|v| v.as_str()).map(String::from));
        // 前端传布尔（true/false），历史/兼容路径可能传 0/1，两种都要认；
        // 早期实现只取 as_i64()，布尔会被静默落成 0，导致「需人工确认」重启后消失。
        let need_confirm = match s.get("need_confirm") {
            Some(serde_json::Value::Bool(b)) => *b as i64,
            Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0),
            _ => 0,
        };
        conn.execute(
            "INSERT INTO task_steps(task_id, seq, name, tool, params_json, status, need_confirm)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)",
            rusqlite::params![task_id, i as i64, name, tool, params_json, need_confirm],
        )
        .map_err(|e| e.to_string())?;
        ids.push(conn.last_insert_rowid());
    }
    Ok(ids)
}

/// 更新某一步的状态与结论摘要
pub fn task_step_update(
    conn: &Connection,
    step_id: i64,
    status: &str,
    result_ref: Option<&str>,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE task_steps SET status = ?1, result_ref = COALESCE(?2, result_ref),
                started_at = COALESCE(started_at, ?3), updated_at = ?3
         WHERE id = ?4",
        rusqlite::params![status, result_ref, now, step_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// 追加一条任务交付物；返回 id
pub fn task_artifact_add(
    conn: &Connection,
    task_id: i64,
    kind: &str,
    file_path: Option<&str>,
    title: Option<&str>,
    content: Option<&str>,
    meta_json: Option<&str>,
) -> Result<i64, String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_artifacts(task_id, kind, file_path, title, content, meta_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![task_id, kind, file_path, title, content, meta_json, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

// ---------------------------------------------------------------------------
// 记忆（mem_vectors）：embedding 由前端计算后回存
// ---------------------------------------------------------------------------

pub fn mem_save(
    conn: &Connection,
    kind: &str,
    ref_id: Option<i64>,
    title: &str,
    content: &str,
    vector_json: &str,
) -> Result<i64, String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO mem_vectors(kind, ref_id, title, content, vector_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![kind, ref_id, title, content, vector_json, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn mem_list(conn: &Connection, kind: Option<&str>) -> Result<Vec<serde_json::Value>, String> {
    let sql = match kind {
        Some(k) if !k.is_empty() => {
            "SELECT id, kind, ref_id, title, content, vector_json, created_at
             FROM mem_vectors WHERE kind = ?1 ORDER BY id DESC LIMIT 500".to_string()
        }
        _ => {
            "SELECT id, kind, ref_id, title, content, vector_json, created_at
             FROM mem_vectors ORDER BY id DESC LIMIT 500".to_string()
        }
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = if let Some(k) = kind.filter(|k| !k.is_empty()) {
        let rows = stmt
            .query_map([k], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "ref_id": r.get::<_, Option<i64>>(2)?,
                    "title": r.get::<_, String>(3)?,
                    "content": r.get::<_, String>(4)?,
                    "vector_json": r.get::<_, Option<String>>(5)?,
                    "created_at": r.get::<_, String>(6)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    } else {
        let rows = stmt
            .query_map([], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "ref_id": r.get::<_, Option<i64>>(2)?,
                    "title": r.get::<_, String>(3)?,
                    "content": r.get::<_, String>(4)?,
                    "vector_json": r.get::<_, Option<String>>(5)?,
                    "created_at": r.get::<_, String>(6)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    Ok(rows)
}

// ---------------------------------------------------------------------------
// 0.7.0：知识图谱（kg_node / kg_edge）——涉外案由优先、人工可确认
// ---------------------------------------------------------------------------

/// 关系类型（固定 5 种，方向固定）
pub const KG_REL_ELEMENT: &str = "构成要件是"; // case → element
pub const KG_REL_LAW: &str = "请求权基础是"; // element → law
pub const KG_REL_EVIDENCE: &str = "证明对象是"; // element → evidence
pub const KG_REL_ISSUE: &str = "常见争点是"; // case → issue
pub const KG_REL_DOC: &str = "文书载体是"; // case → doc

/// 人工策展的案由种子（涉外优先；法条节点只写「法律名」，不写具体条号，避免编造）
struct KgSeedCase {
    case: &'static str,
    keywords: &'static [&'static str],
    /// (构成要件, 请求权基础法律名列表)
    elements: &'static [(&'static str, &'static [&'static str])],
    /// (证据种类, 对应要件)
    evidences: &'static [(&'static str, &'static str)],
    issues: &'static [&'static str],
    docs: &'static [&'static str],
}

const KG_SEED: &[KgSeedCase] = &[
    KgSeedCase {
        case: "涉外货物买卖合同纠纷",
        keywords: &[
            "货物买卖", "买卖合同", "交付", "验收", "货款", "提单", "出口", "进口", "信用证",
        ],
        elements: &[
            ("合同成立与生效", &["民法", "美国法典 Title 15 — 商业与贸易"]),
            ("标的物交付与验收", &["民法"]),
            ("价款支付与结算", &["民法", "商法"]),
            ("违约责任与损害赔偿", &["民法"]),
            ("争议解决与法律适用", &["民事訴訟法"]),
        ],
        evidences: &[
            ("书面合同/订单", "合同成立与生效"),
            ("往来函件与电子邮件", "合同成立与生效"),
            ("提单与运输单据", "标的物交付与验收"),
            ("检验报告/验收单", "标的物交付与验收"),
            ("发票与付款凭证", "价款支付与结算"),
            ("催告函与回函", "违约责任与损害赔偿"),
        ],
        issues: &[
            "合同效力争议", "交付与验收争议", "货款支付争议", "违约金过高", "管辖与法律适用争议",
        ],
        docs: &["合同审查意见书", "民事起诉状", "证据目录", "质证意见", "代理词"],
    },
    KgSeedCase {
        case: "涉外合资经营合同纠纷",
        keywords: &[
            "合资", "合营", "出资", "股权", "章程", "董事会", "利润分配", "退出",
        ],
        elements: &[
            ("出资义务与验资", &["会社法"]),
            ("公司治理与决策程序", &["会社法"]),
            ("利润分配与财务", &["会社法", "美国法典 Title 15 — 商业与贸易"]),
            ("股权转让与退出", &["会社法"]),
            ("违约责任与损害赔偿", &["民法"]),
        ],
        evidences: &[
            ("合资合同/合营协议", "出资义务与验资"),
            ("公司章程", "公司治理与决策程序"),
            ("出资凭证与验资报告", "出资义务与验资"),
            ("董事会/股东会决议", "公司治理与决策程序"),
            ("审计报告与财务报表", "利润分配与财务"),
        ],
        issues: &["出资违约", "控制权与表决权争议", "利润分配争议", "股权转让效力"],
        docs: &["合同审查意见书", "民事起诉状", "证据目录", "质证意见", "代理词"],
    },
];

/// 取（或插入）节点 id；(type,name) 唯一，幂等
fn kg_node_id(
    conn: &Connection,
    ntype: &str,
    name: &str,
    name_alt: Option<&str>,
    source: Option<&str>,
    confidence: f64,
    note: Option<&str>,
) -> Result<i64, String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO kg_node(type, name, name_alt, source, confidence, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![ntype, name, name_alt, source, confidence, note, now],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id FROM kg_node WHERE type = ?1 AND name = ?2",
        rusqlite::params![ntype, name],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// 取（或插入）边 id；(src,rel,dst) 唯一，幂等
fn kg_edge_id(
    conn: &Connection,
    src: i64,
    rel: &str,
    dst: i64,
    weight: f64,
    source: Option<&str>,
    confidence: f64,
    confirmed: bool,
) -> Result<i64, String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO kg_edge(src, rel, dst, weight, source, confidence, confirmed, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![src, rel, dst, weight, source, confidence, confirmed as i64, now],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id FROM kg_edge WHERE src = ?1 AND rel = ?2 AND dst = ?3",
        rusqlite::params![src, rel, dst],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// 幂等播种知识图谱（涉外案由优先）
fn seed_kg_if_empty(conn: &Connection) -> Result<(), String> {
    for c in KG_SEED {
        let case_id = kg_node_id(
            conn,
            "case",
            c.case,
            None,
            Some("人工策展"),
            1.0,
            Some(&format!("关键词：{}", c.keywords.join("、"))),
        )?;
        for (el, laws) in c.elements {
            let el_id = kg_node_id(conn, "element", el, None, Some("人工策展"), 1.0, None)?;
            kg_edge_id(conn, case_id, KG_REL_ELEMENT, el_id, 1.0, Some("人工策展"), 1.0, true)?;
            for law in *laws {
                let law_id = kg_node_id(conn, "law", law, None, Some("内置法库"), 0.9, None)?;
                kg_edge_id(conn, el_id, KG_REL_LAW, law_id, 1.0, Some("人工策展"), 0.9, true)?;
            }
        }
        for (ev, el) in c.evidences {
            let ev_id = kg_node_id(conn, "evidence", ev, None, Some("人工策展"), 1.0, None)?;
            let el_id = kg_node_id(conn, "element", el, None, Some("人工策展"), 1.0, None)?;
            kg_edge_id(conn, el_id, KG_REL_EVIDENCE, ev_id, 1.0, Some("人工策展"), 1.0, true)?;
        }
        for iss in c.issues {
            let iss_id = kg_node_id(conn, "issue", iss, None, Some("人工策展"), 1.0, None)?;
            kg_edge_id(conn, case_id, KG_REL_ISSUE, iss_id, 1.0, Some("人工策展"), 1.0, true)?;
        }
        for d in c.docs {
            let d_id = kg_node_id(conn, "doc", d, None, Some("人工策展"), 1.0, None)?;
            kg_edge_id(conn, case_id, KG_REL_DOC, d_id, 1.0, Some("人工策展"), 1.0, true)?;
        }
    }
    Ok(())
}

type KgNodeRow = (i64, String, String, Option<String>, Option<String>, f64, Option<String>);
type KgEdgeRow = (i64, i64, String, i64, f64, Option<String>, f64, bool);

fn kg_all_nodes(conn: &Connection) -> Result<Vec<KgNodeRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, type, name, name_alt, source, confidence, note FROM kg_node ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, f64>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn kg_all_edges(conn: &Connection) -> Result<Vec<KgEdgeRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, src, rel, dst, weight, source, confidence, confirmed
             FROM kg_edge ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, f64>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, f64>(6)?,
                r.get::<_, i64>(7)? == 1,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn kg_node_json(n: &KgNodeRow) -> serde_json::Value {
    serde_json::json!({
        "id": n.0, "type": n.1, "name": n.2, "name_alt": n.3,
        "source": n.4, "confidence": n.5, "note": n.6,
    })
}

fn kg_edge_json(e: &KgEdgeRow) -> serde_json::Value {
    serde_json::json!({
        "id": e.0, "src": e.1, "rel": e.2, "dst": e.3, "weight": e.4,
        "source": e.5, "confidence": e.6, "confirmed": e.7,
    })
}

/// 全量图谱（可视化用）
pub fn kg_list(conn: &Connection) -> Result<serde_json::Value, String> {
    let nodes = kg_all_nodes(conn)?;
    let edges = kg_all_edges(conn)?;
    Ok(serde_json::json!({
        "nodes": nodes.iter().map(kg_node_json).collect::<Vec<_>>(),
        "edges": edges.iter().map(kg_edge_json).collect::<Vec<_>>(),
    }))
}

/// 某案由的子图（2 跳内），供任务规划使用
pub fn kg_query(conn: &Connection, case_name: &str) -> Result<Option<serde_json::Value>, String> {
    let nodes = kg_all_nodes(conn)?;
    let edges = kg_all_edges(conn)?;
    let root = match nodes.iter().find(|n| n.1 == "case" && n.2 == case_name) {
        Some(n) => n.0,
        None => return Ok(None),
    };
    let mut reachable: std::collections::HashSet<i64> = std::collections::HashSet::new();
    reachable.insert(root);
    for _ in 0..2 {
        let snapshot: Vec<i64> = reachable.iter().copied().collect();
        let mut grew = false;
        for e in &edges {
            if snapshot.contains(&e.1) && reachable.insert(e.3) {
                grew = true;
            }
            if snapshot.contains(&e.3) && reachable.insert(e.1) {
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    let sub_nodes: Vec<&KgNodeRow> = nodes.iter().filter(|n| reachable.contains(&n.0)).collect();
    let sub_edges: Vec<&KgEdgeRow> = edges
        .iter()
        .filter(|e| reachable.contains(&e.1) && reachable.contains(&e.3))
        .collect();
    Ok(Some(serde_json::json!({
        "case": case_name,
        "root": root,
        "nodes": sub_nodes.iter().map(|n| kg_node_json(n)).collect::<Vec<_>>(),
        "edges": sub_edges.iter().map(|e| kg_edge_json(e)).collect::<Vec<_>>(),
    })))
}

/// 按关键词把任务材料归到某个案由（返回案由名；无法判断返回 None）
pub fn kg_find_case(conn: &Connection, text: &str) -> Result<Option<String>, String> {
    let nodes = kg_all_nodes(conn)?;
    let mut best: Option<(String, usize)> = None;
    for c in KG_SEED {
        if !nodes.iter().any(|n| n.1 == "case" && n.2 == c.case) {
            continue;
        }
        let hits = c.keywords.iter().filter(|k| text.contains(**k)).count();
        if hits > 0 && best.as_ref().map(|(_, b)| hits > *b).unwrap_or(true) {
            best = Some((c.case.to_string(), hits));
        }
    }
    Ok(best.map(|(c, _)| c))
}

/// 人工确认 / 拒绝一条候选边
pub fn kg_confirm_edge(conn: &Connection, id: i64, confirmed: bool) -> Result<(), String> {
    if confirmed {
        conn.execute(
            "UPDATE kg_edge SET confirmed = 1,
                    confidence = MAX(confidence, 0.85),
                    source = COALESCE(source, '人工确认')
             WHERE id = ?1",
            [id],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    } else {
        conn.execute("DELETE FROM kg_edge WHERE id = ?1", [id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// 运行期候选边：任务实际检索命中的法条 → 挂到案由下（低置信度，待人工确认）
pub fn kg_add_candidate(
    conn: &Connection,
    case_name: &str,
    law_title: &str,
    task_id: Option<i64>,
) -> Result<Option<i64>, String> {
    let case_id: i64 = match conn.query_row(
        "SELECT id FROM kg_node WHERE type = 'case' AND name = ?1",
        [case_name],
        |r| r.get(0),
    ) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let law_id = kg_node_id(conn, "law", law_title, None, Some("任务检索命中"), 0.5, None)?;
    // 已存在的边不重复登记（否则每次跑任务都会刷出"新增候选边"）
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM kg_edge WHERE src = ?1 AND rel = ?2 AND dst = ?3",
            rusqlite::params![case_id, KG_REL_LAW, law_id],
            |r| r.get(0),
        )
        .ok();
    if existing.is_some() {
        return Ok(None);
    }
    let src = format!("task-log:{}", task_id.unwrap_or(0));
    let id = kg_edge_id(
        conn,
        case_id,
        KG_REL_LAW,
        law_id,
        0.6,
        Some(&src),
        0.5,
        false,
    )?;
    Ok(Some(id))
}

// ---------------------------------------------------------------------------
// 0.7.0：任务材料（多模态导入后的文本）
// ---------------------------------------------------------------------------

pub fn attachment_add(
    conn: &Connection,
    task_id: i64,
    file_name: &str,
    file_path: &str,
    kind: Option<&str>,
    size_bytes: Option<i64>,
    text: Option<&str>,
    blocks: Option<i64>,
    truncated: bool,
    note: Option<&str>,
) -> Result<i64, String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_attachments(task_id, file_name, file_path, kind, size_bytes, text,
                                      blocks, truncated, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            task_id, file_name, file_path, kind, size_bytes, text, blocks,
            truncated as i64, note, now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn attachments_list(
    conn: &Connection,
    task_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, file_name, file_path, kind, size_bytes, blocks, truncated, note,
                    LENGTH(COALESCE(text, '')) AS text_len, created_at
             FROM task_attachments WHERE task_id = ?1 ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([task_id], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "task_id": r.get::<_, i64>(1)?,
                "file_name": r.get::<_, String>(2)?,
                "file_path": r.get::<_, String>(3)?,
                "kind": r.get::<_, Option<String>>(4)?,
                "size_bytes": r.get::<_, Option<i64>>(5)?,
                "blocks": r.get::<_, Option<i64>>(6)?,
                "truncated": r.get::<_, i64>(7)? == 1,
                "note": r.get::<_, Option<String>>(8)?,
                "text_len": r.get::<_, i64>(9)?,
                "created_at": r.get::<_, String>(10)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn attachment_delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM task_attachments WHERE id = ?1", [id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 拼接某任务全部材料的文本（供智能体作为任务材料）
pub fn attachments_text(conn: &Connection, task_id: i64) -> Result<String, String> {
    let mut stmt = conn
        .prepare("SELECT file_name, kind, text FROM task_attachments WHERE task_id = ?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([task_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = String::new();
    for row in rows {
        let (name, kind, text) = row.map_err(|e| e.to_string())?;
        let body = text.unwrap_or_default();
        if body.trim().is_empty() {
            continue;
        }
        out.push_str(&format!(
            "\n\n【材料：{}（{}）】\n{}",
            name,
            kind.unwrap_or_else(|| "未知".into()),
            body
        ));
    }
    Ok(out.trim().to_string())
}

// ---------------------------------------------------------------------------
// 版块 6：待办提醒（todos）
//
// ⚠️ 布尔落库口径：`done` / `desktop_popup` 在表结构里是 `INTEGER NOT NULL`，
// 必须显式写 0/1。历史实现用 `bool::then_some(1)`——`false` 会写成 NULL，
// 于是「取消勾选」报 `NOT NULL constraint failed: todos.done`。
// 所有 todos 写入统一走本节的 flag()，并把底层报错转成可读文案。
// ---------------------------------------------------------------------------

/// 布尔 → SQLite 整数（NOT NULL 列必须显式 0/1，不能靠 NULL 当 false）
fn flag(v: bool) -> i64 {
    if v {
        1
    } else {
        0
    }
}

/// SQLite 原始报错 → 用户可读中文（避免把 "NOT NULL constraint failed: todos.done" 直接抛到界面）
pub fn friendly_db_err(raw: &str) -> String {
    if let Some(col) = raw.strip_prefix("NOT NULL constraint failed: ") {
        let name = match col.trim() {
            "todos.done" | "todos.done." => "完成状态",
            "todos.desktop_popup" => "桌面弹窗开关",
            "todos.remind_minutes" => "提前提醒分钟数",
            "todos.title" => "待办标题",
            "todos.created_at" => "创建时间",
            other => other,
        };
        return format!("{name}不能为空（数据列约束）；请重试一次，若仍失败可删除该条待办后重新添加。");
    }
    if raw.starts_with("UNIQUE constraint failed") {
        return "该记录已存在，无需重复添加。".into();
    }
    if raw.contains("database is locked") || raw.contains("database table is locked") {
        return "数据库正被占用（可能有另一个窗口在写入），请稍后重试。".into();
    }
    if raw.contains("no such table") || raw.contains("no such column") {
        return "数据表或字段缺失，数据库可能未正确初始化；可到「数据设置」从备份还原。".into();
    }
    if raw.contains("readonly") || raw.contains("read-only") {
        return "数据库为只读（可能目录权限受限或被其它程序占用），请检查数据目录权限。".into();
    }
    if raw.contains("disk I/O error") || raw.contains("disk full") {
        return "磁盘写入失败（空间不足或磁盘异常），请检查磁盘后重试。".into();
    }
    format!("数据库操作失败：{raw}")
}

fn friendly(e: rusqlite::Error) -> String {
    friendly_db_err(&e.to_string())
}

/// 待办列表（按创建时间倒序）
pub fn todos_list(conn: &Connection) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, note, due_at, remind_minutes, desktop_popup, done, created_at
             FROM todos ORDER BY created_at DESC",
        )
        .map_err(friendly)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({
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
        .map_err(friendly)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(friendly)
}

/// 新建待办，返回自增 id
pub fn todo_create(
    conn: &Connection,
    title: &str,
    note: Option<&str>,
    due_at: Option<&str>,
    remind_minutes: i64,
    desktop_popup: bool,
) -> Result<i64, String> {
    let created_at = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO todos(title, note, due_at, remind_minutes, desktop_popup, done, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
        rusqlite::params![
            title,
            note,
            due_at,
            remind_minutes.max(0),
            flag(desktop_popup),
            created_at
        ],
    )
    .map_err(friendly)?;
    Ok(conn.last_insert_rowid())
}

/// 全字段保存（前端传整行，故为覆盖写；done=false 写 0 而不是 NULL）
pub fn todo_save(
    conn: &Connection,
    id: i64,
    title: &str,
    note: Option<&str>,
    due_at: Option<&str>,
    remind_minutes: i64,
    desktop_popup: bool,
    done: bool,
) -> Result<(), String> {
    let affected = conn
        .execute(
            "UPDATE todos SET title = ?1, note = ?2, due_at = ?3,
                    remind_minutes = ?4, desktop_popup = ?5, done = ?6
             WHERE id = ?7",
            rusqlite::params![
                title,
                note,
                due_at,
                remind_minutes.max(0),
                flag(desktop_popup),
                flag(done),
                id
            ],
        )
        .map_err(friendly)?;
    if affected == 0 {
        return Err(format!("待办不存在（id={id}），可能已被删除，请刷新页面后重试。"));
    }
    Ok(())
}

/// 局部更新（保留兼容：仅 done / title）
pub fn todo_update(
    conn: &Connection,
    id: i64,
    done: Option<bool>,
    title: Option<&str>,
) -> Result<(), String> {
    if let Some(d) = done {
        conn.execute(
            "UPDATE todos SET done = ?1 WHERE id = ?2",
            rusqlite::params![flag(d), id],
        )
        .map_err(friendly)?;
    }
    if let Some(t) = title {
        conn.execute(
            "UPDATE todos SET title = ?1 WHERE id = ?2",
            rusqlite::params![t, id],
        )
        .map_err(friendly)?;
    }
    Ok(())
}

pub fn todo_delete(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM todos WHERE id = ?1", [id])
        .map(|_| ())
        .map_err(friendly)
}

/// 记录「已按该到期时间提醒过」，避免同一到期时间重复弹窗
pub fn todo_mark_notified(conn: &Connection, id: i64, due_at: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE todos SET last_notified_due = ?1 WHERE id = ?2",
        rusqlite::params![due_at, id],
    )
    .map(|_| ())
    .map_err(friendly)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kg_seed_find_query_and_candidate_flow() {
        let conn = Connection::open_in_memory().expect("打开内存库");
        migrate(&conn).expect("迁移+种子应成功");

        // ① 图谱已播种（两个案由 + 若干节点/边）
        let g = kg_list(&conn).unwrap();
        let cases: Vec<&str> = g["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["type"] == "case")
            .map(|n| n["name"].as_str().unwrap())
            .collect();
        assert!(cases.contains(&"涉外货物买卖合同纠纷"), "案由缺失：{cases:?}");
        assert!(cases.contains(&"涉外合资经营合同纠纷"), "案由缺失：{cases:?}");

        // ② 中文任务材料命中涉外案由
        let ctx = "我方与日本公司签订合资合同，约定双方出资比例与验资程序，日方逾期未出资且拒不召开董事会。";
        let found = kg_find_case(&conn, ctx).unwrap();
        assert_eq!(found.as_deref(), Some("涉外合资经营合同纠纷"));

        // ③ 子图非空且含要件/证据
        let sub = kg_query(&conn, "涉外合资经营合同纠纷").unwrap().expect("子图应存在");
        let types: Vec<&str> = sub["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["type"].as_str().unwrap())
            .collect();
        assert!(types.contains(&"element") && types.contains(&"evidence"));

        // ④ 候选边：任务命中一部不在该案由已有请求权基础里的法 → 登记；重复登记返回 None
        let id1 = kg_add_candidate(&conn, "涉外合资经营合同纠纷", "日本国憲法", Some(1)).unwrap();
        assert!(id1.is_some(), "候选边应登记成功");
        let id2 = kg_add_candidate(&conn, "涉外合资经营合同纠纷", "日本国憲法", Some(1)).unwrap();
        assert!(id2.is_none(), "重复候选边不应再登记");
        // 确认后仍在且 confirmed=1
        kg_confirm_edge(&conn, id1.unwrap(), true).unwrap();
        let row: i64 = conn
            .query_row(
                "SELECT confirmed FROM kg_edge WHERE id = ?1",
                [id1.unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(row, 1);
        // 拒绝 = 删除
        let id3 = kg_add_candidate(&conn, "涉外合资经营合同纠纷", "商法", Some(2)).unwrap().unwrap();
        kg_confirm_edge(&conn, id3, false).unwrap();
        let cnt: i64 = conn
            .query_row("SELECT COUNT(*) FROM kg_edge WHERE id = ?1", [id3], |r| r.get(0))
            .unwrap();
        assert_eq!(cnt, 0, "拒绝应删除候选边");
    }

    #[test]
    fn attachments_roundtrip_and_concat() {
        let conn = Connection::open_in_memory().expect("打开内存库");
        migrate(&conn).expect("迁移应成功");
        let aid = attachment_add(
            &conn, 7, "合同.docx", "D:\\x\\合同.docx", Some("docx"), Some(1024),
            Some("第一条 双方约定……"), Some(3), false, None,
        )
        .unwrap();
        assert!(aid > 0);
        let list = attachments_list(&conn, 7).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["file_name"], "合同.docx");
        let txt = attachments_text(&conn, 7).unwrap();
        assert!(txt.contains("合同.docx") && txt.contains("第一条"));
        attachment_delete(&conn, aid).unwrap();
        assert!(attachments_list(&conn, 7).unwrap().is_empty());
    }

    /// 回归：`done` / `desktop_popup` 是 NOT NULL 列，false 必须写 0 而不是 NULL
    ///（历史 bug：取消勾选报 `NOT NULL constraint failed: todos.done`；
    ///  新建时关掉「桌面弹窗」同理报错）
    #[test]
    fn todos_create_save_and_uncheck_roundtrip() {
        let conn = Connection::open_in_memory().expect("打开内存库");
        migrate(&conn).expect("迁移应成功");
        let due = "2026-09-12T09:00:00+08:00";

        // ① 新建：桌面弹窗关闭（false → 0）
        let id = todo_create(&conn, "提交答辩状", Some("附件见邮件"), Some(due), 30, false)
            .expect("新建待办（弹窗关闭）应成功");
        let row = todos_list(&conn).unwrap().remove(0);
        assert_eq!(row["desktop_popup"], false, "desktop_popup 应落 0");
        assert_eq!(row["done"], false);
        assert_eq!(row["remind_minutes"], 30);
        assert_eq!(row["due_at"], due);

        // ② 勾选完成
        todo_save(&conn, id, "提交答辩状", Some("附件见邮件"), Some(due), 30, false, true)
            .expect("勾选完成应成功");
        assert_eq!(todos_list(&conn).unwrap()[0]["done"], true);

        // ③ 取消勾选（本次报错现场）
        todo_save(&conn, id, "提交答辩状", Some("附件见邮件"), Some(due), 30, false, false)
            .expect("取消勾选必须成功");
        assert_eq!(todos_list(&conn).unwrap()[0]["done"], false, "取消勾选后应落 0");

        // ④ 重新打开桌面弹窗（false→true 也要能落 1）；备注清空走可空列
        todo_save(&conn, id, "提交答辩状", None, Some(due), 0, true, false).unwrap();
        let row = &todos_list(&conn).unwrap()[0];
        assert_eq!(row["desktop_popup"], true);
        assert_eq!(row["note"], serde_json::Value::Null);

        // ⑤ 局部更新 / 已提醒标记 / 不存在的 id / 删除
        todo_update(&conn, id, Some(true), Some("已改名")).unwrap();
        assert_eq!(todos_list(&conn).unwrap()[0]["title"], "已改名");
        todo_mark_notified(&conn, id, due).unwrap();

        let err = todo_save(&conn, 9999, "x", None, None, 0, true, false).unwrap_err();
        assert!(err.contains("待办不存在"), "错误文案应可读：{err}");

        todo_delete(&conn, id).unwrap();
        assert!(todos_list(&conn).unwrap().is_empty());
    }

    #[test]
    fn friendly_db_err_maps_raw_sqlite_messages() {
        let msg = friendly_db_err("NOT NULL constraint failed: todos.done");
        assert!(msg.contains("完成状态"), "应翻译成可读文案：{msg}");
        assert!(friendly_db_err("database is locked").contains("占用"));
        assert!(friendly_db_err("no such table: todos").contains("数据表"));
        assert!(friendly_db_err("随便什么错").starts_with("数据库操作失败："));
    }
}