// 法规数据层：桌面走 Rust（laws_search 按关键词检索 / laws_count 计数），浏览器预览降级到 localStorage 示例。
// 注意：内置法库达 15 万条，绝不挂载即全量拉取——仅在用户输入关键词后按需检索。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Law, SAMPLE_LAWS } from "../data/laws";
import { callRust, isTauri } from "../lib/tauri";

const LS_KEY = "workbench:laws";

function readLocal(): Law[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Law[];
  } catch {
    /* ignore */
  }
  localStorage.setItem(LS_KEY, JSON.stringify(SAMPLE_LAWS));
  return SAMPLE_LAWS;
}

export function useLaws() {
  // 桌面：不预载条文（避免全量 15 万条传输），laws 仅浏览器预览示例用
  const laws = useMemo<Law[]>(() => (isTauri() ? [] : readLocal()), []);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (isTauri()) {
        const n = (await callRust<number>("laws_count")) ?? 0;
        if (alive) setTotal(n);
      } else {
        if (alive) setTotal(readLocal().length);
      }
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const search = useCallback(
    async (keyword: string, country?: string): Promise<Law[]> => {
      const k = keyword.trim();
      if (isTauri()) {
        // 空关键词：不请求（后端同样不返回全量）
        if (!k) return [];
        const c = country && country !== "全部国家" ? country : undefined;
        return (await callRust<Law[]>("laws_search", { keyword: k, country: c })) ?? [];
      }
      const all = readLocal();
      if (!k) return all;
      const kk = k.toLowerCase();
      return all.filter(
        (l) =>
          l.title.toLowerCase().includes(kk) ||
          (l.article_no ?? "").toLowerCase().includes(kk) ||
          (l.chapter ?? "").toLowerCase().includes(kk) ||
          l.content.toLowerCase().includes(kk),
      );
    },
    [],
  );

  return { laws, total, loading, search };
}
