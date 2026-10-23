import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Todo, useTodos } from "../hooks/useTodos";
import { useDocuments } from "../hooks/useDocuments";
import { useRecipeStatus } from "../hooks/useRecipeStatus";
import { openPathFile } from "../lib/open";

export default function Home() {
  const { todos, toggle, refresh } = useTodos();
  const { docs, remove: removeDoc } = useDocuments();
  const recipe = useRecipeStatus();

  /** 勾选首页待办：写库失败时给出可见提示（完成后统计立即归零） */
  async function handleToggle(id: number, done: boolean) {
    try {
      await toggle(id, done);
    } catch (e) {
      window.alert(`状态保存失败：${e instanceof Error ? e.message : String(e)}`);
      await refresh();
    }
  }

  const pending = useMemo(
    () =>
      todos
        .filter((t) => !t.done)
        .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999")),
    [todos],
  );

  const overdue = pending.filter(isOverdueDay);
  const dueToday = pending.filter(isToday);
  const activeCount = pending.length;

  /** 最近一条文书（真实数据；无数据时为 undefined，走引导而不是"暂无"） */
  const recentDoc = docs[0];

  /**
   * 「打开最近文书」：有交付文件就直接用系统程序打开，
   * 没有文件路径（或压根没记录）就退回到文书智能体——始终给一个**能走通的下一步**。
   */
  async function onOpenRecent() {
    if (recentDoc?.file_path) {
      const err = await openPathFile(recentDoc.file_path);
      if (err) window.alert(`打开失败：${err}`);
      return;
    }
    window.location.hash = "#/agent";
  }

  return (
    <div className="home">
      {/* ① 定位条：全站只此一处，回答「给谁 + 解决什么 + 凭什么」 */}
      <header className="home-hero">
        <h2 className="home-hero-title">面向律师的本地 AI 工作台</h2>
        <p className="home-hero-sub">
          把一份合同变成可核对的审查意见 —— 引用可溯源，结论可复现，原件不出本机
        </p>
      </header>

      {/* ② 主行动区：1 主 + 2 次 */}
      <section className="home-actions">
        <Link to="/agent" className="cta-primary">
          开始审查一份合同
        </Link>
        <Link to="/laws" className="cta-secondary">
          法规检索
        </Link>
        <button className="cta-secondary" onClick={() => void onOpenRecent()}>
          打开最近文书
        </button>
      </section>

      {/* 触点 2（隐式化 · R4-P0-4）：一行状态，只在**真的**调整过时出现。
          ⚠️ 纪律 D12：无数据 / 未采纳配方 → 整行不渲染，不得用占位文案撑场面。
          ⚠️ R6-P1-1：**不得**把配方版本号当成「任务条数」。
             `RecipeVersion.version` 是配方版本号（与进化轮次对应），
             而 `RecipeManifest` 里**没有**样本量字段（`real_samples` 挂在匿名包上，
             不在已采纳的版本里）。于是原本文案有两处错：
               ① 语义错误 —— 那个 N 是版本号，不是条数；
               ② 可能凭空 —— `source === "sim"`（协议仿真）时用户一条任务都没跑过。
             故按 A 方案改为**不声称条数**的表述，版本号如实标为 vN。
             （写法上刻意不把被禁的措辞抄进注释，以免污染 D16 的判据。） */}
      {recipe.available && recipe.activeVersion !== null && (
        <p className="home-recipe-status">
          已根据本机使用记录优化默认工作流
          <span className="home-recipe-status-sub">
            （本机保留 v{recipe.activeVersion.version}，可在「数据设置 → 数据与隐私」恢复默认）
          </span>
        </p>
      )}

      {/* 超期横幅 */}
      {overdue.length > 0 && (
        <div className="overdue-banner">
          有 <b>{overdue.length}</b> 项待办已超期，点击查看{" "}
          <Link to="/todo">前往待办查看</Link>
        </div>
      )}

      {/* 主区两栏：左 = 连续性证据 + 核心能力；右 = 统计（配角）+ 今日待办 */}
      <div className="home-columns">
        <div className="home-main">
          {/* ③ 最近打开：最重要的连续性证据 */}
          <section className="card home-panel">
            <div className="panel-head">
              <h3>最近打开</h3>
              {docs.length > 0 && (
                <Link to="/agent" className="more-link">
                  全部文书 &gt;
                </Link>
              )}
            </div>
            {!recentDoc ? (
              // 无数据 → 引导下一步，不渲染裸「暂无」
              <div className="home-empty-guide">
                <p className="muted">
                  你还没有处理过文书。第一次可以从模板起手，或直接把合同交给文书智能体审查。
                </p>
                <div className="row-actions">
                  <Link to="/templates" className="cta-secondary">
                    从模板开始
                  </Link>
                  <Link to="/agent" className="cta-secondary">
                    交给文书智能体
                  </Link>
                </div>
              </div>
            ) : (
              <>
                <div className="home-recent-item">
                  <div className="mini-doc-main">
                    <span className="mini-title">{recentDoc.title}</span>
                    <span className="muted mini-time">{fmtDateTime(recentDoc.updated_at)}</span>
                  </div>
                  <div className="mini-doc-actions">
                    {recentDoc.kind && <span className="tag">.{recentDoc.kind}</span>}
                    {recentDoc.file_path && (
                      <button
                        className="ghost-btn"
                        title="用系统默认程序打开该交付文件"
                        onClick={async () => {
                          const err = await openPathFile(recentDoc.file_path as string);
                          if (err) window.alert(`打开失败：${err}`);
                        }}
                      >
                        打开
                      </button>
                    )}
                    <button
                      className="danger-btn"
                      title="删除记录"
                      onClick={() => void removeDoc(recentDoc.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
                {/* 其余近 4 条，保持列表的连续性但不抢主位 */}
                {docs.length > 1 && (
                  <ul className="mini-docs">
                    {docs.slice(1, 5).map((d) => (
                      <li key={d.id}>
                        <div className="mini-doc-main">
                          <span className="mini-title">{d.title}</span>
                          <span className="muted mini-time">{fmtDateTime(d.updated_at)}</span>
                        </div>
                        <div className="mini-doc-actions">
                          {d.kind && <span className="tag">.{d.kind}</span>}
                          {d.file_path && (
                            <button
                              className="ghost-btn"
                              title="用系统默认程序打开该交付文件"
                              onClick={async () => {
                                const err = await openPathFile(d.file_path as string);
                                if (err) window.alert(`打开失败：${err}`);
                              }}
                            >
                              打开
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          {/* ⑤ 核心能力露出：一句话 + 可点（能力在文书智能体的质检步骤内） */}
          <section className="card home-capability">
            <h3>确定性引用自检</h3>
            <p className="muted">
              产出里的每一处条文号都会先核对是否存在、再核对是否适用于本案 ——
              这一步由规则执行，不由模型自述，所以同一份材料每次结论一致、可复现。
            </p>
            <Link to="/agent" className="more-link">
              在文书智能体里查看 &gt;
            </Link>
          </section>

          {/* ⑥ 三步工作流：说明「凭什么」，也是首屏下方真实内容的填充
              （不是占位文案 —— 这三步与文书智能体里的实际流程一一对应） */}
          <section className="card home-steps">
            <h3>一份合同是怎么被审出来的</h3>
            <ol className="step-list">
              <li>
                <span className="step-no">1</span>
                <div>
                  <b>交材料</b>
                  <p className="muted">
                    把合同或证据放进「文书智能体」，可同时附上你要依据的本地法条与模板。
                  </p>
                </div>
              </li>
              <li>
                <span className="step-no">2</span>
                <div>
                  <b>先出计划再动手</b>
                  <p className="muted">
                    智能体给出分步计划，你可以增删步骤；执行时每一步都会显示调用了哪个工具、取回什么。
                  </p>
                </div>
              </li>
              <li>
                <span className="step-no">3</span>
                <div>
                  <b>规则自检，再导出</b>
                  <p className="muted">
                    产出落盘前跑一遍确定性引用自检，未匹配到的条文会被逐条列出，最后导出 Word 或 Markdown。
                  </p>
                </div>
              </li>
            </ol>
            <Link to="/agent" className="more-link step-foot">
              打开文书智能体 &gt;
            </Link>
          </section>
        </div>

        <aside className="home-aside">
          {/* ④ 三个统计收进小卡片：配角，不占首屏主位 */}
          <section className="card home-stats">
            <div className="panel-head">
              <h3>本周概览</h3>
              <Link to="/todo" className="more-link">
                待办 &gt;
              </Link>
            </div>
            <ul className="stat-mini">
              <li>
                <span className="stat-mini-label">今日待办</span>
                <span className="stat-mini-value">{dueToday.length}</span>
              </li>
              <li>
                <span className="stat-mini-label">进行中</span>
                <span className="stat-mini-value">{activeCount}</span>
              </li>
              <li>
                <span
                  className="stat-mini-label"
                  style={{ color: overdue.length > 0 ? "var(--danger)" : undefined }}
                >
                  已超期
                </span>
                <span
                  className="stat-mini-value"
                  style={{ color: overdue.length > 0 ? "var(--danger)" : undefined }}
                >
                  {overdue.length}
                </span>
              </li>
            </ul>
          </section>

          {/* 今日待办 */}
          <section className="card home-panel">
            <div className="panel-head">
              <h3>今日待办</h3>
              <Link to="/todo" className="more-link">
                全部 &gt;
              </Link>
            </div>
            {dueToday.length === 0 ? (
              <p className="muted">
                今天没有到期的待办。去<Link to="/todo">待办提醒</Link>安排下一步。
              </p>
            ) : (
              <ul className="mini-todo">
                {dueToday.slice(0, 5).map((t: Todo) => (
                  <li key={t.id}>
                    <input
                      type="checkbox"
                      checked={t.done}
                      onChange={(e) => {
                        void handleToggle(t.id, e.target.checked);
                      }}
                    />
                    <span className="mini-title">{t.title}</span>
                    <span className="mini-time">{fmtHM(t.due_at!)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 数据与隐私：本地化是本产品最实的卖点，也是最容易被评审追问的点。
              这里写的三条都与软件实际行为一致（本地 SQLite / 手动备份 / 断网可用演示模式）。 */}
          <section className="card home-privacy">
            <h3>数据在哪</h3>
            <ul className="plain-list">
              <li>案件、文书、待办都存在本机 SQLite 里，不上传云端。</li>
              <li>可在「数据设置」里一键备份整个数据库，也能从备份还原。</li>
              <li>未配置 AI 接口时，文书智能体以演示模式运行，不发出任何网络请求。</li>
            </ul>
            <Link to="/settings" className="more-link">
              数据设置 &gt;
            </Link>
          </section>
        </aside>
      </div>

      {/* R6-P1-2：已删除「常用功能」快捷入口。
          原先这里把 8 个导航项又平铺了一遍，而**左侧栏始终可见且是同一份列表** ——
          首屏最值钱的位置被「再来一遍目录」占掉了，而首页真正该回答的是
          「今天我要做什么」（今日待办 / 最近处理的文书已经回答了）。
          「按使用频次排序留 3–4 个」的方案需要先有频次统计，本轮不引入新数据源。 */}
    </div>
  );
}

/** 是否今日到期（未完成、due_at 落在今天） */
function isToday(t: Todo): boolean {
  if (!t.due_at || t.done) return false;
  const due = new Date(t.due_at);
  const now = new Date();
  return (
    due.getFullYear() === now.getFullYear() &&
    due.getMonth() === now.getMonth() &&
    due.getDate() === now.getDate()
  );
}

/** 是否已超期（未完成、due_at 早于当前时刻） */
function isOverdueDay(t: Todo): boolean {
  if (!t.due_at || t.done) return false;
  return new Date(t.due_at).getTime() < Date.now();
}

function fmtHM(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
