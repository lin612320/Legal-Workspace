// 法规数据层：桌面环境走 Rust(laws_search,SQLite)，浏览器预览降级到 localStorage 示例数据。

import { useCallback, useEffect, useState } from "react";
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
  const [laws, setLaws] = useState<Law[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 桌面首次启动时由 Rust 播种示例数据；浏览器用 localStorage 示例
      const list = isTauri() ? ((await callRust<Law[]>("laws_search", { keyword: "" })) ?? []) : readLocal();
      if (alive) {
        setLaws(list);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const search = useCallback(async (keyword: string): Promise<Law[]> => {
    if (isTauri()) {
      return (await callRust<Law[]>("laws_search", { keyword: keyword.trim() })) ?? [];
    }
    const all = readLocal();
    const k = keyword.trim().toLowerCase();
    if (!k) return all;
    return all.filter(
      (l) =>
        l.title.toLowerCase().includes(k) ||
        (l.article_no ?? "").toLowerCase().includes(k) ||
        (l.chapter ?? "").toLowerCase().includes(k) ||
        l.content.toLowerCase().includes(k),
    );
  }, []);

  return { laws, loading, search };
}