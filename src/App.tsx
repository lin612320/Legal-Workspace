import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./views/Home";
import Laws from "./views/Laws";
import LawBrowse from "./views/LawBrowse";
import Templates from "./views/Templates";
import Agent from "./views/Agent";
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