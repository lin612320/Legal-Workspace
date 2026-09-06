// 主应用密钥混淆存储（XOR + hex，零依赖）
//
// 说明：客户端无法做到真正加密（密钥随程序分发），此实现的目标是让 API Key
// 不以明文 `sk-...` 出现在 SQLite settings 表 / localStorage 中，避免被直接
// 读取/grep 提取。算法与 floating-ball 的 keycrypt.js 同源（同 PAD、同 XOR），
// 仅编码由 base64 改为 hex（便于零依赖实现）；带前缀 `enc:` 表示已加密，
// 无前缀视为历史明文（读取时自动迁移为密文）。
//
// 注：本文件用于主应用（Tauri/Rust 侧），settings 表中 ai.api_key 与
// translate.api_key 两个键值在命令层加密落盘、读取时解密回明文给前端。

const PAD: &str = "floating-ball::legal-workbench::2026";

fn xor_bytes(data: &[u8]) -> Vec<u8> {
    let pad = PAD.as_bytes();
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ pad[i % pad.len()])
        .collect()
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn from_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let b = hex.as_bytes();
    for i in (0..hex.len()).step_by(2) {
        let hi = (b[i] as char).to_digit(16)?;
        let lo = (b[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

/// 明文 → 密文（带 enc: 前缀）
pub fn encrypt(plain: &str) -> String {
    if plain.is_empty() {
        return plain.to_string();
    }
    if plain.starts_with("enc:") {
        return plain.to_string();
    }
    format!("enc:{}", to_hex(&xor_bytes(plain.as_bytes())))
}

/// 密文/明文 → 明文；无法识别时原样返回（不破坏既有数据）
pub fn decrypt(value: &str) -> String {
    if let Some(body) = value.strip_prefix("enc:") {
        if let Some(bytes) = from_hex(body) {
            let dec = xor_bytes(&bytes);
            if let Ok(s) = String::from_utf8(dec) {
                return s;
            }
        }
        // 格式异常：原样返回，避免把用户数据改坏
        return value.to_string();
    }
    value.to_string()
}

/// 是否已加密（供迁移判断）
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with("enc:")
}
