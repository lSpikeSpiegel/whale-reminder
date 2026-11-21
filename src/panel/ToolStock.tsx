import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { StockChart } from "./StockChart";
import {
  INDEXES,
  direction,
  formatChange,
  formatPercent,
  formatPrice,
  inWatch,
  mergeQuotes,
  stamp,
} from "./stock";
import type { StockItem, StockQuote, ToolProps } from "./types";

/** 自动刷新间隔。交易所的推送本来就是几秒一跳，30 秒对「随手看一眼」够用了；
 *  再密只是让网络和对方服务器白忙。切走这个页面 / 关掉面板，定时器跟着停。 */
const REFRESH_MS = 30_000;

/** 输入停顿多久才发搜索。太短会被每个字打一次网，中文输入法组字时尤其浪费。 */
const SEARCH_DEBOUNCE_MS = 240;

/** 搜索结果最多留几条。再多也看不过来，还挤占一屏。 */
const HIT_LIMIT = 8;

/** 「已复制 / 已加入」这类反馈停留多久 */
const NOTE_MS = 2200;

/**
 * 行情：大盘三个指数 + 搜标的 + 自选涨跌。
 *
 * 取数全在 Rust（`src-tauri/src/stock.rs`）：WebView 里跨域要对方给 CORS 头，
 * 行情接口不给。这里只负责摆位置、接指针，格式化和方向判断在 `stock.ts`（有单测）。
 *
 * 搜索和自选**从头到尾只占一块列表区**，不做「结果浮在自选上方」：浮层要
 * portal + fixed 才不被 `.panel` 的 overflow 裁掉，而两层列表叠着时窗口高度
 * 每敲一个字都要来回收敛。互斥显示之后，高度只在进 / 出搜索时变一次。
 */
export function ToolStock({ onLayout }: ToolProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<StockItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);

  const [watch, setWatch] = useState<StockItem[]>([]);
  const [quotes, setQuotes] = useState<StockQuote[]>([]);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  const [note, setNote] = useState<string | null>(null);
  /** 正在看哪一只的图表；null 表示还停在列表上 */
  const [detail, setDetail] = useState<StockItem | null>(null);

  const noteTimer = useRef(0);
  /** 搜索的批次号：慢的那次回来时如果又敲过字，结果就该丢掉 */
  const searchSeq = useRef(0);
  /** 行情的批次号。手动刷新和 30 秒定时可能撞上，只认最后发出的那一次——
   *  用「正在请求就跳过」的写法会让刚加进来的那只等满一个周期才有价 */
  const quoteSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  /** 输入框里有字就是「搜索模式」，列表区显示结果而不是自选 */
  const inSearch = query.trim() !== "";

  const flash = useCallback((text: string) => {
    setNote(text);
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), NOTE_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  // 自选清单只在挂载时读一次，之后所有增删都以命令的返回值为准
  useEffect(() => {
    invoke<StockItem[]>("stock_watch")
      .then(setWatch)
      .catch(() => {
        /* 读不出来就当还没自选，搜索照样能用 */
      });
  }, []);

  /**
   * 拉一轮行情：三个指数 + 整份自选一次问完。
   *
   * 失败时**保留上一轮的数字**——断网时把列表清空，用户会以为自选丢了。
   */
  const refresh = useCallback(async () => {
    const seq = ++quoteSeq.current;
    setLoading(true);

    const secids = [...INDEXES, ...watch].map((item) => item.secid);
    try {
      const list = await invoke<StockQuote[]>("stock_quotes", { secids });
      if (seq !== quoteSeq.current) return;
      setQuotes(list);
      setUpdated(new Date());
      setQuoteFailed(false);
    } catch (err) {
      if (seq !== quoteSeq.current) return;
      console.error("[stock] 行情拉取失败", err);
      setQuoteFailed(true);
    } finally {
      if (seq === quoteSeq.current) setLoading(false);
    }
  }, [watch]);

  // 自选变了就立刻重拉一次（新加的那只马上要有价），顺带重置自动刷新的节拍
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const keyword = query.trim();
    if (keyword === "") {
      setHits([]);
      setSearching(false);
      setSearchFailed(false);
      return;
    }

    // 批次号在**敲字这一刻**就推进，不等请求发出：上一批还在路上时又敲了字，
    // 它回来就该被丢掉，否则会闪一下「上一个关键词的结果」
    setSearching(true);
    const seq = ++searchSeq.current;
    const id = window.setTimeout(() => {
      invoke<StockItem[]>("stock_search", { keyword })
        .then((list) => {
          if (seq !== searchSeq.current) return;
          setHits(list.slice(0, HIT_LIMIT));
          setSearchFailed(false);
        })
        .catch((err) => {
          if (seq !== searchSeq.current) return;
          console.error("[stock] 搜索失败", err);
          setHits([]);
          setSearchFailed(true);
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(id);
  }, [query]);

  // 只在「进 / 出搜索」和自选增减时重量高度：结果条数每敲一个字都可能变，
  // 跟着量就是打字时窗口上下抽动（搜索页不参与高度自适应也是这个原因）。
  // 搜索列表因此给了固定高度，条数变化只让它自己滚。
  useEffect(() => {
    onLayout();
  }, [onLayout, inSearch, watch.length, detail]);

  const add = (item: StockItem) => {
    invoke<StockItem[]>("stock_watch_add", { item })
      .then((list) => {
        setWatch(list);
        setQuery("");
        setHits([]);
        flash(`已加入自选 · ${item.name}`);
        // 光标留在搜索框里，方便接着搜下一只
        inputRef.current?.focus();
      })
      .catch((err) => flash(String(err)));
  };

  /** 点搜索结果：已经在自选里就只说一句，别让用户以为没点上 */
  const pick = (item: StockItem) => {
    if (inWatch(watch, item.secid)) {
      flash(`${item.name} 已经在自选了`);
      return;
    }
    add(item);
  };

  const remove = (item: StockItem) => {
    invoke<StockItem[]>("stock_watch_remove", { secid: item.secid })
      .then(setWatch)
      .catch((err) => flash(String(err)));
  };

  const rows = mergeQuotes(watch, quotes);
  const indexes = mergeQuotes(INDEXES, quotes);

  /**
   * 列表头右侧那一句。反馈、搜索状态、更新时刻共用这一个位置——
   * 再单独吐一行提示会让面板高度随状态跳，而这一栏本来就是给人看状态的。
   */
  const status = (() => {
    if (note !== null) return note;
    if (inSearch) {
      if (searching) return "搜索中";
      if (searchFailed) return "搜不到，检查网络";
      return hits.length === 0 ? "没搜到" : null;
    }
    if (updated !== null) return `更新于 ${stamp(updated)}`;
    return quoteFailed ? "取不到行情" : null;
  })();

  return detail !== null ? (
    <StockChart
      item={detail}
      quote={quotes.find((quote) => quote.secid === detail.secid) ?? null}
      onBack={() => setDetail(null)}
      onLayout={onLayout}
    />
  ) : (
    <>
      <section className="tool stock__top">
        <div className="stock__board">
          {indexes.map(({ item, quote }) => (
            <div key={item.secid} className="stock__index">
              <span className="stock__index-name">{item.name}</span>
              <span className={`stock__index-price stock--${direction(quote?.percent)}`}>
                {formatPrice(quote)}
              </span>
              <span className={`stock__index-pct stock--${direction(quote?.percent)}`}>
                {formatPercent(quote?.percent)}
              </span>
            </div>
          ))}
        </div>

        <div className="stock__search">
          <input
            ref={inputRef}
            className="composer__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // 有字先清字（吃掉这个 Esc，面板不关）；空着再按就交给面板去关
              if (event.key === "Escape" && query !== "") {
                event.preventDefault();
                setQuery("");
              }
              // 回车直接收第一条——搜「茅台」按一下就加好，不用再挪去点 ＋
              if (event.key === "Enter" && hits.length > 0) pick(hits[0]);
            }}
            placeholder="代码 / 名称 / 拼音，回车加自选"
            aria-label="搜索股票"
            spellCheck={false}
          />
          {inSearch && (
            <button type="button" className="stock__cancel" onClick={() => setQuery("")}>
              取消
            </button>
          )}
        </div>
      </section>

      <div className="stock__head">
        <span className="list-head__title">{inSearch ? "搜索结果" : "自选"}</span>
        <span className="list-head__count">{inSearch ? hits.length : rows.length}</span>
        <span className="stock__stamp">{status}</span>
        {!inSearch && (
          <button
            type="button"
            className={`stock__refresh${loading ? " stock__refresh--busy" : ""}`}
            onClick={() => void refresh()}
            aria-label="刷新行情"
            title="刷新行情"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M13 8a5 5 0 1 1-1.6-3.7"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <path
                d="M13.2 1.9v2.9H10.3"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>

      {inSearch ? (
        <ul className="stock__list stock__list--search">
          {hits.map((item) => {
            const added = inWatch(watch, item.secid);
            return (
              <li key={item.secid} className={`stock__row${added ? " stock__row--added" : ""}`}>
                <button
                  type="button"
                  className="stock__row-main"
                  onClick={() => pick(item)}
                  disabled={added}
                >
                  <span className="stock__id">
                    <span className="stock__name">{item.name}</span>
                    <span className="stock__meta">
                      {item.code}
                      {item.market === "" ? "" : ` · ${item.market}`}
                    </span>
                  </span>
                  <span className="stock__add">{added ? "已在自选" : "＋"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : rows.length === 0 ? (
        <p className="stock__hint">还没自选，在上面搜个代码或名字，点 ＋ 加进来</p>
      ) : (
        <ul className="stock__list">
          {rows.map(({ item, quote }) => (
            <li key={item.secid} className="stock__row">
              <button
                type="button"
                className="stock__row-main"
                // 点整行看图（分时 / K 线）；复制代码挪到图表页头，那里点名字就是复制
                onClick={() => setDetail(item)}
                title={`查看 ${item.name} 的分时和 K 线`}
              >
                <span className="stock__id">
                  <span className="stock__name">{item.name}</span>
                  <span className="stock__meta">
                    {item.code}
                    {item.market === "" ? "" : ` · ${item.market}`}
                  </span>
                </span>
                <span className={`stock__num stock--${direction(quote?.percent)}`}>
                  <span className="stock__price">{formatPrice(quote)}</span>
                  <span className="stock__delta">
                    {formatChange(quote)} {formatPercent(quote?.percent)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="stock__del"
                onClick={() => remove(item)}
                aria-label={`从自选移除 ${item.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
