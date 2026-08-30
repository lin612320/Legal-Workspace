// 法规示例数据：浏览器预览时注入 localStorage；桌面版由 Rust 在数据库播种。

export interface Law {
  id: number;
  title: string;
  chapter: string | null;
  article_no: string | null;
  content: string;
  source: string | null;
}

export const SAMPLE_LAWS: Law[] = [
  {
    id: 1,
    title: "中华人民共和国民法典",
    chapter: "第一编 总则",
    article_no: "第一条",
    content:
      "为了保护民事主体的合法权益，调整民事关系，维护社会和经济秩序，适应中国特色社会主义发展要求，弘扬社会主义核心价值观，根据宪法，制定本法。",
    source: "内置示例",
  },
  {
    id: 2,
    title: "中华人民共和国民法典",
    chapter: "第一编 总则",
    article_no: "第三条",
    content: "民事主体的人身权利、财产权利以及其他合法权益受法律保护，任何组织或者个人不得侵犯。",
    source: "内置示例",
  },
  {
    id: 3,
    title: "中华人民共和国民法典",
    chapter: "第一编 总则",
    article_no: "第一百四十三条",
    content:
      "具备下列条件的民事法律行为有效：（一）行为人具有相应的民事行为能力；（二）意思表示真实；（三）不违反法律、行政法规的强制性规定，不违背公序良俗。",
    source: "内置示例",
  },
  {
    id: 4,
    title: "中华人民共和国民法典",
    chapter: "第三编 合同",
    article_no: "第五百零二条",
    content: "依法成立的合同，自成立时生效，但是法律另有规定或者当事人另有约定的除外。",
    source: "内置示例",
  },
  {
    id: 5,
    title: "中华人民共和国民法典",
    chapter: "第三编 合同",
    article_no: "第五百七十七条",
    content:
      "当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。",
    source: "内置示例",
  },
  {
    id: 6,
    title: "中华人民共和国民法典",
    chapter: "第四编 人格权",
    article_no: "第一千零三十二条",
    content: "自然人享有隐私权。任何组织或者个人不得以刺探、侵扰、泄露、公开等方式侵害他人的隐私权。",
    source: "内置示例",
  },
];

export function searchLaws(list: Law[], keyword: string): Law[] {
  const k = keyword.trim().toLowerCase();
  if (!k) return list;
  return list.filter(
    (l) =>
      l.title.toLowerCase().includes(k) ||
      (l.article_no ?? "").toLowerCase().includes(k) ||
      (l.chapter ?? "").toLowerCase().includes(k) ||
      l.content.toLowerCase().includes(k),
  );
}