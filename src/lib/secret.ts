// API Key 混淆存储（前端侧，与 Rust 侧 src-tauri/src/keycrypt.rs 对称）
// 算法：XOR(PAD 循环) → hex；带 `enc:` 前缀表示已加密；无前缀视为历史明文。
// 用途：settings 里 ai.api_key / translate.api_key 落盘（localStorage / 发送给
// Rust 落 SQLite）前加密，读取后解密为明文供 AI/翻译使用。

const PAD = "floating-ball::legal-workbench::2026";

function xorText(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    out.push(s.charCodeAt(i) ^ PAD.charCodeAt(i % PAD.length));
  }
  return out;
}

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const v = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(v)) return [];
    out.push(v);
  }
  return out;
}

function decodeHexBytes(bytes: number[]): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] ^ PAD.charCodeAt(i % PAD.length));
  }
  return s;
}

export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  if (plain.startsWith("enc:")) return plain;
  return "enc:" + toHex(xorText(plain));
}

export function decryptSecret(value: string): string {
  if (!value) return value;
  if (value.startsWith("enc:")) {
    return decodeHexBytes(fromHex(value.slice(4)));
  }
  return value;
}
