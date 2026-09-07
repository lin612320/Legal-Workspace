// 赛事版·法规浏览数据层：桌面走 Rust 命令；浏览器预览（无 Tauri）返回 null，由页面给出提示。

import { callRust, isTauri } from "./tauri";

/** 国家页里领域分组下的一行（一部法） */
export interface LawHomeRow {
  title: string;
  articles: number;
  title_zh?: string | null;
}

/** 国家页：按法律领域分组 */
export interface LawHomeGroup {
  domain: string;
  laws: LawHomeRow[];
}

/** 国家页数据：顶部概览（政体/法律体系）+ 领域分组 */
export interface LawHome {
  country: string;
  rows: number;
  intro?: string | null;
  groups: LawHomeGroup[];
}

/** 整部法的一条条文 */
export interface LawArticleRow {
  id: number;
  chapter?: string | null;
  article_no?: string | null;
  content: string;
  content_zh?: string | null;
  source?: string | null;
}

/** 整部法浏览页数据：元信息 + 完整条文 */
export interface LawPage {
  title: string;
  country: string;
  name_zh?: string | null;
  name_orig?: string | null;
  domain?: string | null;
  intro?: string | null;
  article_count: number;
  articles: LawArticleRow[];
}

/** 加载「国家页」：概览 + 领域分组的法律列表（仅桌面版有全量库） */
export async function loadCountryHome(country: string): Promise<LawHome | null> {
  if (!isTauri()) return null;
  return callRust<LawHome>("laws_country_home", { country });
}

/** 加载「整部法」：元信息 + 完整条文（按条文顺序） */
export async function loadLawPage(title: string): Promise<LawPage | null> {
  if (!isTauri()) return null;
  return callRust<LawPage>("law_page", { title });
}

/** 由 laws.title 生成浏览页路由参数 */
export function lawRoute(title: string): string {
  return `/law/${encodeURIComponent(title)}`;
}
