import { useLocation } from "react-router-dom";

/** 左侧导航（赛事版：移除「AI 问答」「专注计时」） */
export interface NavItem {
  key: string;
  label: string;
  path: string;
}

export const NAV_ITEMS: NavItem[] = [
  { key: "home", label: "首页总览", path: "/home" },
  { key: "laws", label: "法规查询", path: "/laws" },
  { key: "templates", label: "模板库", path: "/templates" },
  { key: "agent", label: "文书智能体", path: "/agent" },
  { key: "translate", label: "翻译", path: "/translate" },
  { key: "todo", label: "待办提醒", path: "/todo" },
  { key: "settings", label: "数据设置", path: "/settings" },
  { key: "import", label: "数据导入", path: "/import" },
];

/**
 * **深链页的固定标题**（纪律 D16）。
 *
 * 为什么单独一张表：`useCurrentPage()` 的兜底是「回退到首页总览」。
 * 深链页（`/evolution`、`/evolution-lab`）**刻意不在 `NAV_ITEMS` 里**（隐式化红线），
 * 于是它们全部命中兜底 —— 顶栏显示「首页总览」而页面内容是「我的使用偏好」。
 *
 * 顶栏是用户的**定位锚点**，标题与内容打架在录屏 / 答辩截图里尤其难看。
 * 所以：**凡是不在导航表里的可达页面，都必须在这里登记自洽标题**。
 */
export const DEEP_LINK_TITLES: Record<string, string> = {
  "/evolution": "我的使用偏好",
  "/evolution-lab": "完整实验台",
};

/** 根据当前路径取出版块标题，用于顶部栏 */
export function useCurrentPage() {
  const { pathname } = useLocation();
  // 赛事版：/law/:title 属于“法规查询”版块
  if (pathname === "/law" || pathname.startsWith("/law/")) {
    return NAV_ITEMS.find((it) => it.key === "laws") ?? NAV_ITEMS[0];
  }
  // D16：深链页优先取固定标题，**不得**回退成首页总览
  const deepTitle = DEEP_LINK_TITLES[pathname];
  if (deepTitle) {
    return { key: "deep-link", label: deepTitle, path: pathname };
  }
  return (
    NAV_ITEMS.find((it) => it.path === pathname) ?? { key: "home", label: "首页总览", path: "/home" }
  );
}