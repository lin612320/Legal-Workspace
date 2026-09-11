// 设置数据层：桌面环境走 Rust(SQLite 键值表)，浏览器预览自动降级到 localStorage。

import { useCallback, useEffect, useState } from "react";
import { callRust, isTauri } from "../lib/tauri";
import { encryptSecret, decryptSecret } from "../lib/secret";

/** 设置键名常量 */
export const KEYS = {
  aiBaseUrl: "ai.base_url",
  aiApiKey: "ai.api_key",
  aiModel: "ai.model",
  backupAuto: "backup.auto", // "1" | "0"
  backupIntervalDays: "backup.interval_days",
  backupTargetDir: "backup.target_dir",
  defaultDesktopPopup: "pref.default_popup", // "1" | "0"
} as const;

export interface SettingsState {
  loaded: boolean;
  /** AI 接口：文书智能体 / 翻译 / 文档翻译 / 多模态转录统一共用 */
  ai: { baseUrl: string; apiKey: string; model: string };
  backup: {
    auto: boolean;
    intervalDays: number;
    targetDir: string;
  };
  defaultDesktopPopup: boolean;
}

const DEFAULTS: SettingsState = {
  loaded: false,
  ai: { baseUrl: "", apiKey: "", model: "deepseek-chat" },
  backup: { auto: false, intervalDays: 7, targetDir: "" },
  defaultDesktopPopup: true,
};

const LS_KEY = "workbench:settings";

/** 需加密落盘的设置键（API Key 类） */
const SECRET_KEYS: string[] = [KEYS.aiApiKey];

const isSecretKey = (k: string) => SECRET_KEYS.includes(k);

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
      // 解密 API Key（桌面 Rust 已解密返回；浏览器 local 若为密文也在此还原）
      for (const k of SECRET_KEYS) {
        const v = map[k];
        if (v !== undefined) map[k] = decryptSecret(v);
      }
      if (!alive) return;
      setS({
        loaded: true,
        ai: {
          baseUrl: map[KEYS.aiBaseUrl] ?? DEFAULTS.ai.baseUrl,
          apiKey: map[KEYS.aiApiKey] ?? DEFAULTS.ai.apiKey,
          model: map[KEYS.aiModel] ?? DEFAULTS.ai.model,
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
    // API Key 加密后落盘（桌面 Rust 会再次加密；此处防浏览器 localStorage 明文）
    const val = isSecretKey(key) ? encryptSecret(value) : value;
    if (isTauri()) {
      await callRust<void>("settings_set", { key, value: val });
    } else {
      const map = readLocal();
      map[key] = val;
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

  return { s, setAI, setBackup, setDefaultPopup, backupNow, restore, notify, msg, setMsg };
}