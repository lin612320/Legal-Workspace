import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./views/Home";
import Laws from "./views/Laws";
import Templates from "./views/Templates";
import Assistant from "./views/Assistant";
import Translate from "./views/Translate";
import Todo from "./views/Todo";
import Focus from "./views/Focus";
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
          <Route path="/templates" element={<Templates />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route path="/translate" element={<Translate />} />
          <Route path="/todo" element={<Todo />} />
          <Route path="/focus" element={<Focus />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/import" element={<Import />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}