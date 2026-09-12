# 产品演示站源码（Cloudflare Pages）

线上地址：<https://faron-demo.pages.dev> ｜ Pages 项目名 `faron-demo`

`index.html` 是**单文件、零依赖**的产品演示页（可直接双击离线打开，无外链、无构建步骤）。它是安装包之外的第二条演示通道：客户与评委不装软件也能亲手操作产品里最关键的几件事。

## 页面里的可交互演示

| 版块 | 锚点 | 能亲手做什么 |
| --- | --- | --- |
| 产品实况 | `#product` | 4 个真实界面还原；法规面板的打印/复制/跳条号按钮直接驱动下方检索台 |
| 法规检索工作台 | `#search` | 内置 31 条示例条文（日 15 / 中 10 / 美 6，节选自 e-Gov、govinfo、民法典公开文本）：关键词检索、按法浏览、条号阿拉伯/中文/罗马三种写法跳转、复制、打印 PDF |
| 智能体演练 | `#runbook` | 执行 / 暂停 / 单步 / 续跑 / 重置；人工确认闸门可确认或拒绝；注入假条号或越界引用会被质检阻断交付，修复后才放行；导出 Word(.doc) / Markdown 并记入「最近文书」 |
| 桌面悬浮球 | `#ball` | 选中文字即浮出球，翻译 / 关联查找（真检索上面那台法库并可跳过去）/ 询问 AI / 复制；4 种皮肤 + 抓取模式 |
| 引用自检实验室 | `#audit` | 注入不存在的条文号，看规则级自检把它抓出来（与检索台共用同一份本地库） |
| 知识图谱 | `#kg` | 节点邻接高亮、候选边人工确认/拒绝 |

界面为还原演示，示例数据不代表真实案件；完整法库 152,940 条随安装包内置（见仓库根 `README.md`）。

## 发布

本仓库只保存**源码** `index.html`；实际发布会用到本地的 `deploy/` 目录（含 `404.html`、`robots.txt`、`_headers` 安全响应头、`og-image.png` 分享缩略图，以及 `index.html` 的副本），该目录是部署产物，未纳入版本库。

```powershell
cd <工作区>\官网演示
Copy-Item index.html deploy\index.html -Force      # 源 → 部署副本
wrangler pages deploy deploy --project-name=faron-demo --commit-dirty=true
```

`og:image` 使用绝对地址（当前指向 `https://faron-demo.pages.dev/og-image.png`），换自有域名时需同步 `<meta property="og:url">` 与 `og:image`。

## 改动后自查

改动 `index.html` 后至少人工过一遍：三台新演示各点一次（检索台搜「违约金」、演练台跑完一张计划卡、悬浮球划一段字），并确认页面在**日间/夜间**两种主题与窄屏（≤ 920px）下无横向滚动。历史版本使用的无头浏览器断言脚本与截图留存在工作区 `官网演示/_shots/`。
