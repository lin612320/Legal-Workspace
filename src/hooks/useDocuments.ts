// 最近文书数据层：桌面走 Rust(documents 表)，浏览器预览降级到 localStorage。
// documents 是智能体交付物 / 文书的统一落点（首页"最近处理的文书"面板数据源）。

import { useCallback, useEffect, useState } from "react";
import { callRust, isTauri } from "../lib/tauri";
import { localDocList, localDocDelete } from "../lib/tools";

export interface DocItem {
  id: number;
  title: string;
  content?: string | null;
  file_path?: string | null;
  kind?: string;
  meta?: string | null;
  updated_at: string;
}

export function useDocuments() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = isTauri()
        ? ((await callRust<DocItem[]>("documents_list")) ?? [])
        : (localDocList() as DocItem[]);
      if (alive) {
        setDocs(list);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const list = isTauri()
      ? ((await callRust<DocItem[]>("documents_list")) ?? [])
      : (localDocList() as DocItem[]);
    setDocs(list);
  }, []);

  const remove = useCallback(async (id: number) => {
    if (isTauri()) {
      await callRust<void>("document_delete", { id });
    } else {
      localDocDelete(id);
    }
    setDocs((prev) => prev.filter((d) => d.id !== id));
  }, []);

  return { docs, loading, refresh, remove };
}
