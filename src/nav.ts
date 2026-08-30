import { useLocation } from "react-router-dom";

/** 左侧导航的 8 个版块定义 */
export interface NavItem {
  key: string;
  label: string;
  path: string;
}

export const NAV_ITEMS: NavItem[] = [
  { key: "home", label: "首页总览", path: "/home" },
  { key: "laws", label: "法规查询", path: "/laws" },
  { key: "templates", label: "模板库", path: "/templates" },
  { key: "assistant", label: "AI 助手", path: "/assistant" },
  { key: "translate", label: "翻译", path: "/translate" },
  { key: "todo", label: "待办提醒", path: "/todo" },
  { key: "settings", label: "数据设置", path: "/settings" },
  { key: "import", label: "数据导入", path: "/import" },
];

/** 根据当前路径取出版块标题，用于顶部栏 */
export function useCurrentPage() {
  const { pathname } = useLocation();
  return (
    NAV_ITEMS.find((it) => it.path === pathname) ?? { key: "home", label: "首页总览", path: "/home" }
  );
}