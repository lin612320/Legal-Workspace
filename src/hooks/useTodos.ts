// 待办数据层：桌面环境走 Rust(SQLite)，浏览器预览自动降级到 localStorage。
//
// 修复要点（v0.7.1）：
//   1) 参数命名：Tauri v2 把 Rust 侧 snake_case 参数映射为 camelCase 再从 JS 读取。
//      旧代码传的是 due_at / remind_minutes / desktop_popup，被当成「缺参」：
//        - todos_save 因缺必填 remindMinutes / desktopPopup 直接报错（且 callRust 吞掉）
//          → 勾选「完成」根本存不进数据库，刷新后又变回未完成；
//        - todos_create 的截止时间 / 提醒分钟被丢弃 → 刷新后设置好的数据「消失」。
//   2) 创建 / 勾选 / 删除后立即更新本地列表（不再等整页重新加载），列表与首页统计即时刷新。
//   3) 写入失败不再静默：改用 invokeStrict 抛错，由页面把原因展示给用户。

import { useCallback, useEffect, useState } from "react";
import { callRust, invokeStrict, isTauri } from "../lib/tauri";

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

/**
 * 待办变更广播：首页、侧栏 badge、待办页各自持有 useTodos 实例，
 * 任一处新增/勾选/删除后广播一次，让其它实例重新对齐后端，
 * 避免「勾了完成，侧栏与首页统计还显示 1」这类过期数据。
 */
const EVT_CHANGED = "workbench:todos-changed";

function notifyChanged() {
  try {
    window.dispatchEvent(new Event(EVT_CHANGED));
  } catch {
    /* ignore */
  }
}

export type CreateTodo = {
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

  const fetchAll = useCallback(async (): Promise<Todo[]> => {
    return isTauri() ? ((await callRust<Todo[]>("todos_list")) ?? []) : readLocal();
  }, []);

  /** 重新从后端读取待办（供页面在需要时手动对齐） */
  const refresh = useCallback(async (): Promise<Todo[]> => {
    const list = await fetchAll();
    setTodos(list);
    setLoading(false);
    return list;
  }, [fetchAll]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await fetchAll();
      if (alive) {
        setTodos(list);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [fetchAll]);

  // 窗口重新获得焦点、或其它页面改动了待办时，重新对齐后端数据，
  // 避免首页统计与侧栏 badge 仍显示旧数字。
  useEffect(() => {
    const sync = () => {
      void refresh();
    };
    window.addEventListener("focus", sync);
    window.addEventListener(EVT_CHANGED, sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener(EVT_CHANGED, sync);
    };
  }, [refresh]);

  /** 新增待办：落库后立即插入本地列表（首页/列表即时可见） */
  const create = useCallback(async (input: CreateTodo): Promise<Todo> => {
    const remind = input.remind_minutes ?? 0;
    const popup = input.desktop_popup ?? true;

    let t: Todo;
    if (isTauri()) {
      const id = await invokeStrict<number>("todos_create", {
        title: input.title,
        note: input.note ?? null,
        dueAt: input.due_at ?? null,
        remindMinutes: remind,
        desktopPopup: popup,
      });
      t = {
        id: Number(id),
        title: input.title,
        note: input.note ?? null,
        due_at: input.due_at ?? null,
        remind_minutes: remind,
        desktop_popup: popup,
        done: false,
        created_at: new Date().toISOString(),
      };
    } else {
      t = {
        id: Date.now(),
        title: input.title,
        note: input.note ?? null,
        due_at: input.due_at ?? null,
        remind_minutes: remind,
        desktop_popup: popup,
        done: false,
        created_at: new Date().toISOString(),
      };
    }

    setTodos((prev) => {
      const next = [t, ...prev];
      if (!isTauri()) writeLocal(next);
      return next;
    });
    notifyChanged();
    return t;
  }, []);

  /** 全字段保存（后端 todos_save 为整行覆盖，故补齐当前值） */
  const save = useCallback(
    async (id: number, patch: Partial<Todo>) => {
      if (isTauri()) {
        const cur = todos.find((t) => t.id === id);
        if (!cur) throw new Error(`待办不存在（id=${id}），请刷新页面后重试。`);
        await invokeStrict<void>("todos_save", {
          id,
          title: patch.title ?? cur.title,
          note: patch.note !== undefined ? patch.note : (cur.note ?? null),
          dueAt: patch.due_at !== undefined ? patch.due_at : (cur.due_at ?? null),
          remindMinutes: patch.remind_minutes ?? cur.remind_minutes ?? 0,
          desktopPopup: patch.desktop_popup ?? cur.desktop_popup ?? true,
          done: patch.done ?? cur.done,
        });
      }
      setTodos((prev) => {
        const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
        if (!isTauri()) writeLocal(next);
        return next;
      });
      notifyChanged();
    },
    [todos],
  );

  const remove = useCallback(async (id: number) => {
    if (isTauri()) await invokeStrict<void>("todos_delete", { id });
    setTodos((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (!isTauri()) writeLocal(next);
      return next;
    });
    notifyChanged();
  }, []);

  const toggle = useCallback((id: number, done: boolean) => save(id, { done }), [save]);

  return { todos, loading, create, save, remove, toggle, refresh };
}
