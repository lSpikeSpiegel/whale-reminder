import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ToolCodec } from "./ToolCodec";
import { ToolColor } from "./ToolColor";
import { ToolImage } from "./ToolImage";
import { ToolJson } from "./ToolJson";
import { ToolQr } from "./ToolQr";
import { ToolStock } from "./ToolStock";
import { CodecIcon, ColorIcon, ImageIcon, JsonIcon, QrIcon, StockIcon } from "./toolIcons";
import type { ToolProps } from "./types";
import "./tools.css";

export interface ToolDef {
  key: string;
  name: string;
  /** 清单里那一行小字，一句话说清能干什么（10–12 字，超了会被省略） */
  desc: string;
  Icon: () => React.JSX.Element;
  View: (props: ToolProps) => React.JSX.Element;
}

/**
 * 还没实现的工具用这个占位。
 *
 * `note` 写的是「打算做成什么样」——既是给用户看的预告，也是回头实现时的需求备忘。
 * 真做的时候把清单里那条的 `View` 换成自己的组件，其它地方都不用动。
 *
 * 目前六项都实现了，所以这里暂时没有调用方；导出是留着给下一个「先占个位」的工具用，
 * 真用上时把 `View: soon("…")` 写回去即可。
 */
export function soon(note: string) {
  return function SoonView() {
    return (
      <section className="soon">
        <span className="soon__badge">待开发</span>
        <p className="soon__note">{note}</p>
      </section>
    );
  };
}

/**
 * 工具清单。
 *
 * **新增工具只改这里**：写一个 `ToolXxx.tsx`（图标从 `toolIcons.tsx` 取），
 * 再往下面加一条定义。清单、返回、页头标题、高度自适应全都是现成的。
 *
 * 约定：
 * - 数组顺序只是「都还没用过时的默认顺序」，真正展示的顺序按打开次数倒序排
 *   （见 `Tools` 里的 `ordered`）。所以别在数组里塞「位置」这类东西。
 * - `View` 只返回内容片段（一串 `<section>`），不要自己套 `page__body`——
 *   滚动容器和高度测量由外层 `Tools` 统一管。
 * - **搜索页也从这张表取数据**（`Search.tsx` 按 name / desc / key 匹配），
 *   所以新工具不用另外登记一遍；key 顺便当英文别名用（「qr」能找到二维码助手）。
 */
export const TOOLS: ToolDef[] = [
  {
    key: "qr",
    name: "二维码助手",
    desc: "框选认码 · 文字转码",
    Icon: QrIcon,
    View: ToolQr,
  },
  {
    key: "stock",
    name: "行情",
    desc: "搜索 · 自选 · 涨跌幅",
    Icon: StockIcon,
    View: ToolStock,
  },
  {
    key: "image",
    name: "图片处理",
    desc: "压缩 · 裁剪 · 转格式",
    Icon: ImageIcon,
    View: ToolImage,
  },
  {
    key: "color",
    name: "颜色转换",
    desc: "HEX · RGB · HSL 互转",
    Icon: ColorIcon,
    View: ToolColor,
  },
  {
    key: "json",
    name: "JSON 格式化",
    desc: "格式化 · 折叠 · 校验",
    Icon: JsonIcon,
    View: ToolJson,
  },
  {
    key: "codec",
    name: "编解码工具",
    desc: "Base64 · URL · 时间戳",
    Icon: CodecIcon,
    View: ToolCodec,
  },
];

interface Props extends ToolProps {
  /** 进到某个工具里时换掉页头标题，回清单时传 null 恢复成「小工具」 */
  onTitle: (title: string | null) => void;
  /** 从搜索页点进来时直接打开的那个工具（key）；null 就是停在清单上 */
  initial?: string | null;
}

/**
 * 小工具页：先是一张工具清单，点进去才是具体工具。
 *
 * 一个工具占满整页会越加越挤，所以这里只做「入口」——
 * 清单行高固定、数量不限，工具自己的内容都收在详情页里。
 */
export function Tools({ onLayout, onTitle, initial = null }: Props) {
  // 初值直接取 `initial`：页面切进来时整块是重挂载的（`Panel` 那边给了 key），
  // 所以「从搜索点进某个工具」只需要在挂载时认一次，不用再做后续同步
  const [active, setActive] = useState<string | null>(initial);
  /** 各工具被打开过多少次，key 是工具的 `key`。没出现过的当 0 */
  const [usage, setUsage] = useState<Record<string, number>>({});
  const tool = TOOLS.find((item) => item.key === active) ?? null;

  useEffect(() => {
    invoke<Record<string, number>>("tool_usage")
      .then(setUsage)
      .catch(() => {
        /* 统计读不出来就按默认顺序排，不影响用 */
      });
  }, []);

  /**
   * 按打开次数倒序；次数相同就保持清单里的声明顺序。
   *
   * 排序不写死位置：次数变了顺序自己跟着变。带上原始下标做第二比较键，
   * 是为了让「都是 0 次」的新工具稳定地按声明顺序排，不会每次渲染抖一下。
   */
  const ordered = useMemo(
    () =>
      TOOLS.map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const delta = (usage[b.item.key] ?? 0) - (usage[a.item.key] ?? 0);
          return delta !== 0 ? delta : a.index - b.index;
        })
        .map(({ item }) => item),
    [usage],
  );

  /** 打开一个工具：本地先 +1（回来时顺序已经是新的），后端只负责落盘 */
  const open = (key: string) => {
    setActive(key);
    setUsage((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
    invoke<Record<string, number>>("tool_open", { key })
      .then(setUsage)
      .catch(() => {
        /* 落盘失败也不回滚：这次照样能进去用，下次打开再计 */
      });
  };

  useEffect(() => {
    onTitle(tool?.name ?? null);
  }, [onTitle, tool]);

  // 清单 ⇄ 详情的高度不一样，切换后要重新量一次
  useEffect(() => {
    onLayout();
  }, [onLayout, active]);

  // 切去待办 / 设置时别把页头标题留在工具名上
  useEffect(() => () => onTitle(null), [onTitle]);

  const View = tool?.View ?? null;

  return (
    <div
      className="page__body tools__pane"
      // key 让清单和详情互相切换时整块重挂载，淡入重放一次；
      // 动画只有 opacity，量高度不会量到中间态
      key={tool?.key ?? "list"}
      data-page-body
    >
      {tool === null || View === null ? (
        <ul className="tools">
          {ordered.map(({ key, name, desc, Icon }) => (
            <li key={key}>
              <button
                type="button"
                className="tools__item"
                onClick={() => open(key)}
                aria-label={`打开${name}`}
              >
                <span className="tools__icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="tools__text">
                  <span className="tools__name">{name}</span>
                  <span className="tools__desc">{desc}</span>
                </span>
                <svg
                  className="tools__go"
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M6.2 3.4 10.8 8l-4.6 4.6"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <button type="button" className="tools__back" onClick={() => setActive(null)}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M9.8 3.4 5.2 8l4.6 4.6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            全部工具
          </button>
          <View onLayout={onLayout} />
        </>
      )}
    </div>
  );
}
