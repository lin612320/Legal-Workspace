// 模板数据层：桌面走 Rust(SQLite)，浏览器预览走 localStorage。

import { useCallback, useEffect, useState } from "react";
import { Template, readLocalTemplates, writeLocalTemplates } from "../data/templates";
import { callRust, isTauri } from "../lib/tauri";

export interface NewTemplate {
  title: string;
  category: string;
  content: string;
  file_type: string;
}

export function useTemplates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = isTauri()
        ? ((await callRust<Template[]>("templates_list")) ?? [])
        : readLocalTemplates();
      if (alive) {
        setTemplates(list);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const create = useCallback(async (input: NewTemplate) => {
    if (isTauri()) {
      await callRust<void>("templates_create", {
        title: input.title,
        category: input.category,
        content: input.content,
        file_type: input.file_type,
      });
      const list = (await callRust<Template[]>("templates_list")) ?? [];
      setTemplates(list);
      return;
    }
    const list = readLocalTemplates();
    const next: Template = {
      id: Date.now(),
      title: input.title,
      category: input.category,
      content: input.content,
      file_type: input.file_type,
      built_in: 0,
    };
    writeLocalTemplates([next, ...list]);
    setTemplates([next, ...list]);
  }, []);

  const remove = useCallback(async (id: number): Promise<string | null> => {
    if (isTauri()) {
      const err = await callRust<string>("templates_delete", { id });
      if (err) return err;
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      return null;
    }
    const list = readLocalTemplates().filter((t) => t.id !== id);
    writeLocalTemplates(list);
    setTemplates(list);
    return null;
  }, []);

  return { templates, loading, create, remove };
}