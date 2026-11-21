import React from "react";
import ReactDOM from "react-dom/client";
// 设计令牌必须最先加载，后面的 panel.css / bubble.css 都靠它取值
import "./ui/tokens.css";
import App from "./App";
import { detectLive2D } from "./live2d/availability";

// 立绘可用性要先定下来再挂载：App 和设置页都是同步读 live2dAvailable()，
// 挂载之后再翻牌，桌宠会先闪一张静态图再换成 Live2D。
// detectLive2D 永远 resolve（内部有超时兜底），最坏情况是晚 PROBE_TIMEOUT_MS 出画面。
void detectLive2D().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
