// 设置数据层：桌面环境走 Rust(SQLite 键值表)，浏览器预览自动降级到 localStorage。

import { useCallback, useEffect, useState } from "react";
import { callRust, isTauri } from "../lib/tauri";

/** 设置键名常量 */
export const KEYS = {
  aiBaseUrl: "ai.base_url",
  aiApiKey: "ai.api_key",
  aiModel: "ai.model",
  translateProvider: "translate.provider", // "free" | "paid"
  translateApiKey: "translate.api_key",
  translateBaseUrl: "translate.base_url",
  backupAuto: "backup.auto", // "1" | "0"
  backupIntervalDays: "backup.interval_days",
  backupTargetDir: "backup.target_dir",
  defaultDesktopPopup: "pref.default_popup", // "1" | "0"
} as const;

export interface SettingsState {
  loaded: boolean;
  ai: { baseUrl: string; apiKey: string; model: string };
  translate: {
    provider: string;
    apiKey: string;
    baseUrl: string;
  };
  backup: {
    auto: boolean;
    intervalDays: number;
    targetDir: string;
  };
  defaultDesktopPopup: boolean;
}

const DEFAULTS: SettingsState = {
  loaded: false,
  ai: { baseUrl: "", apiKey: "", model: "gpt-4o-mini" },
  translate: { provider: "free", apiKey: "", baseUrl: "" },
  backup: { auto: false, intervalDays: 7, targetDir: "" },
  defaultDesktopPopup: true,
};

const LS_KEY = "workbench:settings";

function readLocal(): Partial<Record<string, string>> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function writeLocal(map: Partial<Record<string, string>>) {
  localStorage.setItem(LS_KEY, JSON.stringify(map));
}

export function useSettings() {
  const [s, setS] = useState<SettingsState>(DEFAULTS);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 首次载入全部设置
  useEffect(() => {
    let alive = true;
    (async () => {
      const map: Record<string, string> = {};
      const keys: string[] = [
        KEYS.aiBaseUrl,
        KEYS.aiApiKey,
        KEYS.aiModel,
        KEYS.translateProvider,
        KEYS.translateApiKey,
        KEYS.translateBaseUrl,
        KEYS.backupAuto,
        KEYS.backupIntervalDays,
        KEYS.backupTargetDir,
        KEYS.defaultDesktopPopup,
      ];
      if (isTauri()) {
        for (const k of keys) {
          const v = await callRust<string>(`settings_get`, { key: k });
          if (v !== null && v !== undefined) map[k] = String(v);
        }
      } else {
        const local = readLocal();
        for (const k of keys) {
          if (local[k] !== undefined) map[k] = local[k] as string;
        }
      }
      if (!alive) return;
      setS({
        loaded: true,
        ai: {
          baseUrl: map[KEYS.aiBaseUrl] ?? DEFAULTS.ai.baseUrl,
          apiKey: map[KEYS.aiApiKey] ?? DEFAULTS.ai.apiKey,
          model: map[KEYS.aiModel] ?? DEFAULTS.ai.model,
        },
        translate: {
          provider: map[KEYS.translateProvider] ?? DEFAULTS.translate.provider,
          apiKey: map[KEYS.translateApiKey] ?? DEFAULTS.translate.apiKey,
          baseUrl: map[KEYS.translateBaseUrl] ?? DEFAULTS.translate.baseUrl,
        },
        backup: {
          auto: (map[KEYS.backupAuto] ?? "0") === "1",
          intervalDays: Number(map[KEYS.backupIntervalDays] ?? DEFAULTS.backup.intervalDays) || DEFAULTS.backup.intervalDays,
          targetDir: map[KEYS.backupTargetDir] ?? DEFAULTS.backup.targetDir,
        },
        defaultDesktopPopup: (map[KEYS.defaultDesktopPopup] ?? "1") === "1",
      });
    })();
    return () => {
      alive = false;
    };
  }, []);

  const persist = useCallback(async (key: string, value: string) => {
    if (isTauri()) {
      await callRust<void>("settings_set", { key, value });
    } else {
      const map = readLocal();
      map[key] = value;
      writeLocal(map);
    }
  }, []);

  const setAI = useCallback(
    (patch: Partial<SettingsState["ai"]>) => {
      setS((prev) => ({ ...prev, ai: { ...prev.ai, ...patch } }));
      if (patch.baseUrl !== undefined) void persist(KEYS.aiBaseUrl, patch.baseUrl);
      if (patch.apiKey !== undefined) void persist(KEYS.aiApiKey, patch.apiKey);
      if (patch.model !== undefined) void persist(KEYS.aiModel, patch.model);
    },
    [persist],
  );

  const setTranslate = useCallback(
    (patch: Partial<SettingsState["translate"]>) => {
      setS((prev) => ({ ...prev, translate: { ...prev.translate, ...patch } }));
      if (patch.provider !== undefined) void persist(KEYS.translateProvider, patch.provider);
      if (patch.apiKey !== undefined) void persist(KEYS.translateApiKey, patch.apiKey);
      if (patch.baseUrl !== undefined) void persist(KEYS.translateBaseUrl, patch.baseUrl);
    },
    [persist],
  );

  const setBackup = useCallback(
    (patch: Partial<SettingsState["backup"]>) => {
      setS((prev) => ({ ...prev, backup: { ...prev.backup, ...patch } }));
      if (patch.auto !== undefined) void persist(KEYS.backupAuto, patch.auto ? "1" : "0");
      if (patch.intervalDays !== undefined) void persist(KEYS.backupIntervalDays, String(patch.intervalDays));
      if (patch.targetDir !== undefined) void persist(KEYS.backupTargetDir, patch.targetDir);
    },
    [persist],
  );

  const setDefaultPopup = useCallback(
    (v: boolean) => {
      setS((prev) => ({ ...prev, defaultDesktopPopup: v }));
      void persist(KEYS.defaultDesktopPopup, v ? "1" : "0");
    },
    [persist],
  );

  /** 手动备份：Rust 复制数据库到目标目录 */
  const backupNow = useCallback(async (dir: string): Promise<boolean> => {
    if (!isTauri()) {
      setMsg({ type: "err", text: "备份仅桌面版可用（当前为浏览器预览）。" });
      return false;
    }
    const res = await callRust<string>("backup_now", { dir });
    if (res) {
      setMsg({ type: "ok", text: `已备份：${res}` });
      return true;
    }
    setMsg({ type: "err", text: "备份失败，请确认目录可写。" });
    return false;
  }, []);

  /** 还原：用备份文件替换本地数据库 */
  const restore = useCallback(async (file: string): Promise<boolean> => {
    if (!isTauri()) {
      setMsg({ type: "err", text: "还原仅桌面版可用（当前为浏览器预览）。" });
      return false;
    }
    const res = await callRust<string>("restore", { file });
    if (res) {
      setMsg({ type: "ok", text: res });
      return true;
    }
    setMsg({ type: "err", text: "还原失败，请确认备份文件路径正确。" });
    return false;
  }, []);

  const notify = useCallback((type: "ok" | "err", text: string) => setMsg({ type, text }), []);

  return { s, setAI, setTranslate, setBackup, setDefaultPopup, backupNow, restore, notify, msg, setMsg };
}