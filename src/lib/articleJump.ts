// 赛事版·条文跳转：把用户输入（阿拉伯数字 / 中文数字 / 罗马数字）解析为条号，
// 并在一部法的条文列表里定位（支持日文「第X条（之Y）」、中文「第X条」、美国宪法
// 「Article I · Sec. 1」/「Amendment I」、美国法典「§101」等常见条号形态）。

export const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** 中文/日文数字串 → 阿拉伯数（如 “百三” → 103、“一千零三十二” → 1032、“千四十四” → 1044）。
 *  无法解析时返回 null。 */
export function cnToNumber(s: string): number | null {
  const clean = (s || "")
    .replace(/[第條条之のノ款項目]/g, "")
    .trim();
  if (!clean) return null;
  if (![...clean].every((ch) => ch in CN_DIGITS || ch in CN_UNITS)) return null;
  let total = 0;
  let cur = 0;
  for (const ch of clean) {
    if (ch in CN_DIGITS) {
      cur = CN_DIGITS[ch];
    } else {
      const unit = CN_UNITS[ch];
      if (cur === 0) cur = 1; // 十五 / 百三 之类省略“一”
      total += cur * unit;
      cur = 0;
    }
  }
  return total + cur;
}

const ROMAN_MAP: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
/** 罗马数字 → 阿拉伯数（I..XXXIX 内够用）；非法返回 null。 */
export function romanToNumber(s: string): number | null {
  const up = (s || "").trim().toUpperCase();
  if (!up) return null;
  let total = 0;
  let prev = 0;
  for (let i = up.length - 1; i >= 0; i--) {
    const v = ROMAN_MAP[up[i]];
    if (v === undefined) return null;
    if (v < prev) total -= v;
    else total += v;
    prev = v;
  }
  return total > 0 ? total : null;
}

/** 一条条文的规范编号（供与用户输入比较） */
export interface ArticleKey {
  n: number;
  sec?: number;
  kind: "cn" | "article" | "amend" | "section";
}

export function articleKeyOf(no: string | null | undefined): ArticleKey | null {
  if (!no) return null;
  const t = no.trim();
  const amend = t.match(/^Amendment\s+([IVXLCDM]+)/i);
  if (amend) {
    const n = romanToNumber(amend[1]);
    return n == null ? null : { n, kind: "amend" };
  }
  const art = t.match(/^Article\s+([IVXLCDM]+)\s*[·.\-]?\s*Sec(?:tion)?\.?\s*(\d+)/i);
  if (art) {
    const n = romanToNumber(art[1]);
    if (n == null) return null;
    return { n, sec: parseInt(art[2], 10), kind: "article" };
  }
  const artOnly = t.match(/^Article\s+([IVXLCDM]+)/i);
  if (artOnly) {
    const n = romanToNumber(artOnly[1]);
    return n == null ? null : { n, kind: "article" };
  }
  const sect = t.match(/^§\s*(\d+)(?:[.\-](\d+))?/);
  if (sect) {
    const n = parseInt(sect[1], 10);
    return { n, sec: sect[2] ? parseInt(sect[2], 10) : undefined, kind: "section" };
  }
  if (/[第条之のノ]/.test(t) || /[零〇一二三四五六七八九十百千万]/.test(t)) {
    const n = cnToNumber(t);
    return n == null ? null : { n, kind: "cn" };
  }
  return null;
}

/** 解析用户输入 → 目标编号 */
export function parseQuery(q: string): { n: number; sec?: number } | null {
  const s = (q || "").trim();
  if (!s) return null;
  const d2 = s.match(/^(\d{1,5})\.(\d{1,3})$/);
  if (d2) return { n: parseInt(d2[1], 10), sec: parseInt(d2[2], 10) };
  if (/^\d{1,6}$/.test(s)) return { n: parseInt(s, 10) };
  if (/^[IVXLCDM]+$/i.test(s)) {
    const n = romanToNumber(s);
    return n == null ? null : { n };
  }
  const n = cnToNumber(s);
  return n == null ? null : { n };
}

/** 在一部法的条文里定位目标条（article_no 形态多样）。返回命中下标，未命中返回 -1。 */
export function findArticleByNumber(
  articles: ReadonlyArray<{ article_no?: string | null }>,
  query: string,
): number {
  const target = parseQuery(query);
  if (!target) return -1;
  for (let i = 0; i < articles.length; i++) {
    const k = articleKeyOf(articles[i].article_no);
    if (!k) continue;
    if (k.n !== target.n) continue;
    // 用户给了“第X条之Y/§N.N/Article N Sec M”，要求精确到细目
    if (target.sec !== undefined) {
      if (k.sec === target.sec) return i;
      continue;
    }
    // 仅给条号：条文按顺序排列，取首个匹配（若该条分多款则首款）
    return i;
  }
  return -1;
}
