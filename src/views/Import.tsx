import Placeholder from "./Placeholder";

export default function Import() {
  return (
    <Placeholder
      badge="版块 8"
      title="数据导入工具"
      desc="法规 / 模板库的数据底座：把 Excel 数据导入本地 SQLite。"
      modules={[
        "数据源选择（法规 / 模板）",
        "选择 Excel 文件",
        "字段映射预览",
        "确认导入 → 写入本地库",
        "数据库搭建指引（后接 Excel）",
      ]}
    />
  );
}