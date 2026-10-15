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

export default function App() {
  return (
    <HashRouter>
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