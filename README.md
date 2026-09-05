# 律政工作台（Legal Workbench）

> 法律工作者本地桌面助手 —— 单机运行，数据全部保存在本机。

律政工作台是一个面向律师、法务等法律工作者的本地桌面应用，围绕日常办案流程提供法规查询、文书模板、AI 辅助、翻译、待办提醒等一体化工具。**配套「悬浮球助手」桌面常驻小球**，选中文字即可翻译、检索或询问 AI。当前版本 `0.3.2`：安装包**内置日美法律数据库**（15.3 万条条文，装机首启即用）。

## 技术栈

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 桌面壳 | Tauri 2 | Rust 编写，负责窗口管理、本地命令桥、文件系统与数据库访问 |
| 前端框架 | React 18.3 + TypeScript 5.5 | 严格模式，函数组件 + Hooks |
| 构建工具 | Vite 5.4 | 开发服务器端口固定 `1420`，构建目标 `es2021` |
| 路由 | react-router-dom 6.26 | `HashRouter`，9 个版块 + 悬浮窗路由 |
| 数据库 | SQLite（rusqlite 0.31 bundled） | 本地单文件 `legal.db`，WAL 模式 |
| 悬浮球 | Electron 33（`floating-ball/` 独立应用） | 桌面小球 + 选词翻译/检索/AI，与主应用文件桥接 |
| 样式 | 手写 CSS | 无 UI 组件库，基于 CSS 变量设计令牌，支持日间/夜间主题 |

## 功能一览

左侧导航共 9 个版块：

1. **首页总览**：今日待办、统计卡（今日/进行中/已超期）、超期横幅、常用功能快捷入口。
2. **法规查询**：**按需关键词检索**（篇名/条文号/章节/内容），左列表右正文阅读；页面不再全量预载，输入关键词才检索（命中最多显示前 500 条，可细化缩小）。**出厂内置日美法库**：日本 2,104 部现行法 + 美国法典 53 个 Title + 美利坚合众国宪法，条文级共 152,940 条（来源 e-Gov / govinfo / constitutioncenter.org）。
3. **模板库**：内置法律文书模板，支持分类筛选、自建模板、删除（内置模板不可删）。
4. **AI 助手**：OpenAI 兼容接口流式对话，内置「通用 / 审合同 / 审质证」三种模式；会话持久化、多会话管理、RAG 法规检索注入、Markdown 渲染；支持大窗口 ⇄ 置顶悬浮窗切换。
5. **翻译**：内置免费接口（Google gtx，无需 Key，开箱即用），可选配置付费接口，支持 15 种语言与自动检测。
6. **待办提醒**：待办增删改查、截止时间、提前提醒、到期桌面弹窗（系统通知）、多种筛选视图。
7. **专注计时**：番茄钟 25/5/15 分钟模式、圆形进度、完成系统通知、番茄计数。
8. **数据设置**：AI / 翻译接口配置、日间/夜间主题、手动备份、自动备份配置、数据库还原。
9. **数据导入**：从 Excel 批量导入法规 / 模板数据（中英文表头）。

> 各版块的实现细节与完成状态见 [docs/02-功能模块.md](docs/02-功能模块.md)。

### 悬浮球助手（floating-ball）

桌面常驻小球，与主应用双向联动：

- **选中即用**：鼠标选中任意文字 → 悬浮球弹窗一键**翻译 / 关联查找 / 询问 AI**。
- **抓取模式可切换**：默认「自动抓取」（选中文字松开即弹面板）；可切到「手动拖入」——不主动抓取，把选中文字拖到悬浮球或面板内即触发。
- **推送给主应用**：悬浮球可将选中文字直接推送到律政工作台 AI 助手输入框。
- **外观可定制**：多套球皮肤与面板主题（内置皮肤选择窗）、悬停对话气泡。
- **随主应用联动**：律政工作台启动时自动拉起悬浮球；顶栏「🎯 悬浮球」按钮唤起面板；悬浮球也可自动拉起打包版 `legal-workbench.exe`。
- **开箱即用**：内置共享 AI Key（运行时解码，不落明文）与配置加密；请求走系统代理，办公网络无需额外设置。
- **独立可用**：悬浮球也可脱离主应用单独运行（便携版 `悬浮球助手`）。

## 运行模式（重要）

同一套前端代码自动降级：

- **桌面版（Tauri）**：数据走 Rust 命令读写本地 SQLite，功能完整；启动时自动拉起 Electron 悬浮球。
- **浏览器预览版（Vite dev 直接打开）**：不加载 Tauri，数据降级到 `localStorage` 示例数据；悬浮球相关功能通过 Vite 桥接插件联动。

检测逻辑位于 `src/lib/tauri.ts` 的 `isTauri()`（判断 `window.__TAURI_INTERNALS__` 是否存在）。

主应用查找悬浮球按以下顺序（满足其一即可，均支持子目录递归）：

1. 环境变量 `FLOATING_BALL_DIR` 指向的目录（开发/自定路径）
2. 主程序 exe 同目录 / `resources` 子目录（发布形态：悬浮球随包装入 `win-unpacked-<版本>` 版本化目录，升级不覆盖旧文件）
3. 主程序 exe 旁 `_up_` 目录（兼容旧版安装包布局）
4. 项目仓库内 `floating-ball`（开发形态，`CARGO_MANIFEST_DIR` 上一级）
5. 用户桌面 `floating-ball`（旧开发形态兜底）

律政 → 悬浮球命令通过共享控制文件 `%APPDATA%\floating-ball\from-workbench.json` 下发（show / hide / prefill / translate / quit），悬浮球常驻轮询执行。

## 快速开始

```bash
# 安装依赖（Node.js 20+，建议 v24；Rust 工具链用于桌面版）
npm install

# 浏览器预览模式（仅前端，数据为示例数据）
npm run dev        # 打开 http://localhost:1420

# 桌面悬浮球依赖：进入 floating-ball 单独安装
cd floating-ball && npm install && cd ..

# 一键联调：Vite 前端 + 悬浮球（见 scripts/dev-with-ball.cjs）
npm run dev:all

# 构建前端产物
npm run build      # tsc 类型检查 + vite build，输出 dist/

# 桌面版开发（需 Rust 工具链，见 docs/04-开发与构建指南.md）
npm run tauri dev

# 打包桌面安装包（NSIS，内含悬浮球 win-unpacked）
npm run tauri build
```

## 目录结构

```
├── index.html                  # 前端入口 HTML
├── package.json                # 前端依赖与脚本
├── vite.config.ts              # Vite 配置（端口 1420，含悬浮球桥接插件）
├── tsconfig.json               # TypeScript 严格模式配置
├── src/                        # 前端源码
│   ├── main.tsx                # React 挂载入口
│   ├── App.tsx                 # 路由表（HashRouter，9 版块）
│   ├── nav.ts                  # 版块导航定义
│   ├── styles.css              # 全局样式（CSS 变量设计令牌）
│   ├── components/             # Layout / Sidebar / Topbar
│   ├── views/                  # 各版块页面
│   ├── hooks/                  # 数据层 Hooks（useLaws/useSettings/useTemplates/useTodos）
│   ├── lib/                    # tauri 桥接 / AI 对话 / 翻译引擎 / 悬浮球封装
│   └── data/                   # 浏览器预览用示例数据
├── floating-ball/              # 悬浮球助手（独立 Electron 应用）
│   └── src/                    #   main 主进程 / preload / renderer 窗口
├── scripts/dev-with-ball.cjs   # Vite + 悬浮球一键联调脚本
├── src-tauri/                  # Rust 桌面壳
│   ├── src/lib.rs              # Tauri 入口 + 命令（含悬浮球命令、置顶悬浮窗）
│   ├── src/ball.rs             # 悬浮球定位 / 拉起 / 控制文件命令桥
│   ├── src/db.rs               # SQLite 初始化 / 迁移 / 播种
│   ├── tauri.conf.json         # 窗口（main + float）、资源、打包配置
│   └── capabilities/           # 主窗口与悬浮窗权限
├── 发布包/                     # 构建产物（不入库）：安装包 + 悬浮球便携版
└── docs/                       # 技术架构 / 功能模块 / 数据库 / 构建指南 / 路线图
```

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/01-技术架构.md](docs/01-技术架构.md) | 技术架构、前后端通信、双环境降级、窗口管理 |
| [docs/02-功能模块.md](docs/02-功能模块.md) | 各版块功能明细与完成状态 |
| [docs/03-数据库设计.md](docs/03-数据库设计.md) | 表结构、种子数据、备份与还原 |
| [docs/04-开发与构建指南.md](docs/04-开发与构建指南.md) | 环境准备、开发构建、打包、常见问题 |
| [docs/05-优化路线图.md](docs/05-优化路线图.md) | P0-P3 优化建议、技术债与发布里程碑 |

## 内置法库与数据说明

- 0.3.2 起安装包内置预置库（`src-tauri/preload/legal_preload.db`，约 490 MB，**git 忽略不入库**）；首次启动检测到用户数据目录无 `legal.db` 时自动拷贝装载。
- 重新打包带库版本前，需先按 `法库ETL工作区/ETL说明.md` 生成/刷新预置库；换环境时把 `legal_preload.db` 放到 `legal-workbench.exe` 同目录，便携版同样自动装载。
- **升级提示**：老用户已有本地库时不会覆盖其数据；如需强制换用内置库，退出应用后删除 `%APPDATA%\com.legalworkbench.app\legal.db` 再启动。
- 规模提示：库内法规正文约 350 MB，`laws_search` 为 `LIKE` 关键词全表扫描，单次约数百毫秒级；「建立向量索引」不适用于对 15 万条全量 embedding，RAG 建议先关键词召回再按需切片调用 AI。

## 打包与发布

- 主应用安装包：`npm run tauri build` → `src-tauri/target/release/bundle/nsis/律政工作台_0.3.2_x64-setup.exe`。安装包内嵌悬浮球与法库预置库，装入**版本化子目录**（如 `win-unpacked-0.3.1`），升级安装不会与正在运行的旧悬浮球发生文件占用冲突。
- 悬浮球便携版（独立使用）：在 `floating-ball/` 下 `npm run dist` → `floating-ball/dist/悬浮球助手 1.0.0.exe`。
- 完整交付物统一放入 `发布包/`。
- **升级提示**：升级前请退出正在运行的律政工作台主程序；托盘中的旧悬浮球可保留（新版主程序会自动定位新版悬浮球，下次重启生效）。

## 当前状态与已知缺口

已实现：法规检索（按需关键词）、模板库、AI 助手（RAG/多会话/置顶悬浮窗）、翻译、待办 + 桌面提醒、专注计时、Excel 导入、手动/自动备份、设置持久化、悬浮球双向联动。

仍待完善（代码中已标注 TODO 或为占位）：

- 法规页原「向量检索」入口已下线：内置库 15 万条不适合一次性全量 embedding，待接入 FTS5 全文索引或分块向量检索后恢复（语义级查询建议先用关键词召回，再对 Top 结果让 AI 分析）。
- 首页「最近文书」面板仍为占位（`documents` 表已建但无读写命令）。
- 自动备份只有配置 + 手动执行入口，无定时调度。
