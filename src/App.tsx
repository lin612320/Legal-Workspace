import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./views/Home";
import Laws from "./views/Laws";
import LawBrowse from "./views/LawBrowse";
import Templates from "./views/Templates";
import Agent from "./views/Agent";
import Evolution from "./views/Evolution";
import Translate from "./views/Translate";
import Todo from "./views/Todo";
import Settings from "./views/Settings";
import Import from "./views/Import";
import EvolutionLab from "./evolution-lab/EvolutionLab";

export default function App() {
  return (
    // R6-P2-2：打开 react-router 的 v7 预置开关，消掉开发期控制台里
    // 两条 `React Router Future Flag Warning`（v7_startTransition / v7_relativeSplatPath）。
    // 它们不是错误，但**录屏与答辩截图时会被看到**，属于不必要的噪音。
    // 语义不变：这两项只是让我们提前采用 v7 的行为。
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<Home />} />
          <Route path="/laws" element={<Laws />} />
          <Route path="/law/:title" element={<LawBrowse />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/agent" element={<Agent />} />
          {/* /evolution 是**深链**：不出现在左侧导航（见 nav.ts），
              仅保留路由供答辩演示直达（#/evolution）。
              把「自我进化」从一级导航撤下的理由见
              docs/12-联邦配方进化方案.md 与《03-自我进化隐式化设计分析》：
              用户需要的是「状态 + 控制」，机制本身该待在文档里。 */}
          <Route path="/evolution" element={<Evolution />} />
          {/* /evolution-lab 同样是**深链**：完整实验台（收敛曲线 / ε 与 K 可调 /
              A-B 采纳回滚 / RL 对照 / 白名单校验 / 本机进化日志），不进左侧导航，
              仅供答辩与内部研究直达（#/evolution-lab）。
              机制、参数形状与诚实边界在 docs/12-联邦配方进化方案.md §十一 逐条对齐；
              该节与实验台是「机制未被删除」的两个落点（纪律 D11）。 */}
          <Route path="/evolution-lab" element={<EvolutionLab />} />
          <Route path="/translate" element={<Translate />} />
          <Route path="/todo" element={<Todo />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/import" element={<Import />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}