// 待办数据层：桌面环境走 Rust(SQLite)，浏览器预览自动降级到 localStorage。

import { useCallback, useEffect, useState } from "react";
import { callRust, isTauri } from "../lib/tauri";

export interface Todo {
  id: number;
  title: string;
  note?: string | null;
  due_at?: string | null;
  remind_minutes: number;
  desktop_popup: boolean;
  done: boolean;
  created_at: string;
}

const LS_KEY = "workbench:todos";
type CreateTodo = {
  title: string;
  note?: string;
  due_at?: string | null;
  remind_minutes?: number;
  desktop_popup?: boolean;
};

function readLocal(): Todo[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "[]") as Todo[];
  } catch {
    return [];
  }
}

function writeLocal(list: Todo[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = isTauri()
        ? ((await callRust<Todo[]>("todos_list")) ?? [])
        : readLocal();
      if (alive) {
        setTodos(list);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const create = useCallback(async (input: CreateTodo) => {
    if (isTauri()) {
      await callRust<void>("todos_create", input);
    } else {
      const t: Todo = {
        id: Date.now(),
        title: input.title,
        note: input.note ?? null,
        due_at: input.due_at ?? null,
        remind_minutes: input.remind_minutes ?? 0,
        desktop_popup: input.desktop_popup ?? true,
        done: false,
        created_at: new Date().toISOString(),
      };
      setTodos((prev) => {
        const next = [t, ...prev];
        writeLocal(next);
        return next;
      });
    }
  }, []);

  const save = useCallback(async (id: number, patch: Partial<Todo>) => {
    if (isTauri()) {
      // 后端是全字段保存，需传入完整值
      const cur = todos.find((t) => t.id === id);
      if (!cur) return;
      await callRust<void>("todos_save", {
        id,
        title: patch.title ?? cur.title,
        note: patch.note !== undefined ? patch.note : cur.note,
        due_at: patch.due_at !== undefined ? patch.due_at : cur.due_at,
        remind_minutes: patch.remind_minutes ?? cur.remind_minutes,
        desktop_popup: patch.desktop_popup ?? cur.desktop_popup,
        done: patch.done ?? cur.done,
      });
    }
    setTodos((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
      if (!isTauri()) writeLocal(next);
      return next;
    });
  }, [todos]);

  const remove = useCallback(async (id: number) => {
    if (isTauri()) await callRust<void>("todos_delete", { id });
    setTodos((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (!isTauri()) writeLocal(next);
      return next;
    });
  }, []);

  const toggle = useCallback((id: number, done: boolean) => save(id, { done }), [save]);

  return { todos, loading, create, save, remove, toggle };
}