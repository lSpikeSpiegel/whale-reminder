import React from "react";
import ReactDOM from "react-dom/client";
// 设计令牌必须最先加载，后面的 panel.css / bubble.css 都靠它取值
import "./ui/tokens.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
