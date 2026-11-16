/**
 * 工具清单用的图标。
 *
 * 统一 20×20、描边 1.5、圆角端点，和面板里其它图形一个口径；
 * 颜色一律 `currentColor`，由外面的容器决定（清单里是 --brand）。
 */

const base = {
  width: 20,
  height: 20,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** 二维码助手：三个定位角 + 一块数据点 */
export const QrIcon = () => (
  <svg {...base}>
    <rect x="2.2" y="2.2" width="5.6" height="5.6" rx="1.4" />
    <rect x="12.2" y="2.2" width="5.6" height="5.6" rx="1.4" />
    <rect x="2.2" y="12.2" width="5.6" height="5.6" rx="1.4" />
    <path d="M12.2 12.2h2.2v2.2h-2.2zM15.6 15.6h2.2v2.2h-2.2z" fill="currentColor" stroke="none" />
  </svg>
);

/** 聚合页：一块通栏 + 两块小的，读起来就是「拼起来的一页」 */
export const HubIcon = () => (
  <svg {...base}>
    <rect x="2.6" y="2.8" width="14.8" height="5.8" rx="1.6" />
    <rect x="2.6" y="11.4" width="6.4" height="5.8" rx="1.6" />
    <rect x="11.4" y="11.4" width="6" height="5.8" rx="1.6" />
  </svg>
);

/** 颜色转换：一滴颜料，里面一道高光 */
export const ColorIcon = () => (
  <svg {...base}>
    <path d="M10 2.9c3.1 3.6 4.8 6 4.8 8.1a4.8 4.8 0 0 1-9.6 0c0-2.1 1.7-4.5 4.8-8.1z" />
    <path d="M7.9 11.4c.1 1 .8 1.7 1.8 1.8" />
  </svg>
);

/** 图片处理：相框 + 太阳 + 山脊 */
export const ImageIcon = () => (
  <svg {...base}>
    <rect x="2.6" y="3.8" width="14.8" height="12.4" rx="2.2" />
    <circle cx="7.4" cy="8.2" r="1.5" />
    <path d="M3.4 14 7.6 10l2.6 2.3 2.5-2.4 3.9 3.8" />
  </svg>
);

/** JSON 格式化：一对花括号 */
export const JsonIcon = () => (
  <svg {...base}>
    <path d="M7.8 3.6c-1.5 0-2.2.7-2.2 2.2v1.4c0 1.1-.7 1.8-1.9 1.8 1.2 0 1.9.7 1.9 1.8v1.4c0 1.5.7 2.2 2.2 2.2" />
    <path d="M12.2 3.6c1.5 0 2.2.7 2.2 2.2v1.4c0 1.1.7 1.8 1.9 1.8-1.2 0-1.9.7-1.9 1.8v1.4c0 1.5-.7 2.2-2.2 2.2" />
  </svg>
);

/** 编解码：一上一下两支箭头 */
export const CodecIcon = () => (
  <svg {...base}>
    <path d="M3.6 7.2h11.2M12.4 4.8l2.4 2.4-2.4 2.4" />
    <path d="M16.4 12.8H5.2M7.6 10.4 5.2 12.8l2.4 2.4" />
  </svg>
);
