import { useLocation } from "react-router-dom";

/** 左侧导航（赛事版：移除「AI 问答」「专注计时」；「自我进化」为 0.8.0 方案稿可视化页） */
export interface NavItem {
  key: string;
  label: string;
  path: string;
  /** 规划中 / 方案稿页面：侧栏以弱化样式提示，避免被当成已落地功能 */
  planned?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { key: "home", label: "首页总览", path: "/home" },
  { key: "laws", label: "法规查询", path: "/laws" },
  { key: "templates", label: "模板库", path: "/templates" },
  { key: "agent", label: "文书智能体", path: "/agent" },
  { key: "evolution", label: "自我进化", path: "/evolution", planned: true },
  { key: "translate", label: "翻译", path: "/translate" },
  { key: "todo", label: "待办提醒", path: "/todo" },
  { key: "settings", label: "数据设置", path: "/settings" },
  { key: "import", label: "数据导入", path: "/import" },
];

/** 根据当前路径取出版块标题，用于顶部栏 */
export function useCurrentPage() {
  const { pathname } = useLocation();
  // 赛事版：/law/:title 属于“法规查询”版块
  if (pathname === "/law" || pathname.startsWith("/law/")) {
    return NAV_ITEMS.find((it) => it.key === "laws") ?? NAV_ITEMS[0];
  }
  return (
    NAV_ITEMS.find((it) => it.path === pathname) ?? { key: "home", label: "首页总览", path: "/home" }
  );
}