import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SearchHit, SearchHits, SearchHistoryEntry, SearchStatus } from "./types";
import "./search.css";

interface Props {
  /** 搜不到东西时的出路：把这句原话丢进待办的输入框 */
  onDraft: (text: string) => void;
  /** 空输入框上按 Esc：回待办页（再按一次等于「算了」） */
  onBack: () => void;
  /** 面板每次被唤起都会 +1，用来把这里清干净 */
  token: number;
}

/** 打字停顿多久才发查询。短到不觉得卡，长到不会每敲一个字母起一次进程 */
const DEBOUNCE_MS = 130;

/** 每次问后端要多少条。分组之后一屏最多也就十来行，多了纯属浪费 */
const LIMIT = 20;

/**
 * Everything 的下载页。
 *
 * 不直接给 `es.exe` 的 zip 链接：那个文件名带版本号（`ES-1.1.0.27.zip`），
 * 发版就失效，写死在代码里等于半年后必然点不动。
 */
const EVERYTHING_DOWNLOAD = "https://www.voidtools.com/downloads/";

const iconProps = {
  width: 13,
  height: 13,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const MagnifierIcon = () => (
  <svg {...iconProps} width={14} height={14}>
    <circle cx="7" cy="7" r="4.4" />
    <path d="M10.4 10.4 14 14" />
  </svg>
);

const AppIcon = () => (
  <svg {...iconProps}>
    <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.6" />
    <path d="M2.6 6.4h10.8" />
  </svg>
);

const FileIcon = () => (
  <svg {...iconProps}>
    <path d="M4 2.6h4.6l3.4 3.4v6.8a1.2 1.2 0 0 1-1.2 1.2H4a1.2 1.2 0 0 1-1.2-1.2V3.8A1.2 1.2 0 0 1 4 2.6z" />
    <path d="M8.4 2.8v3.4H12" />
  </svg>
);

const FolderIcon = () => (
  <svg {...iconProps}>
    <path d="M2.4 5.2c0-.7.6-1.2 1.2-1.2h2.6l1.4 1.8h4.8c.7 0 1.2.5 1.2 1.2v4.6c0 .7-.5 1.2-1.2 1.2H3.6c-.6 0-1.2-.5-1.2-1.2z" />
  </svg>
);

function Badge({ kind }: { kind: SearchHit["kind"] }) {
  return (
    <span className="search__badge" aria-hidden="true">
      {kind === "app" ? <AppIcon /> : kind === "dir" ? <FolderIcon /> : <FileIcon />}
    </span>
  );
}

/**
 * 这一屏的结果到底是怎么搜出来的，得让用户看得见。
 *
 * 三种情况要分开说：接上了 Everything（全盘）、装了但缺 es.exe（只有常用目录）、
 * 压根没装（只有常用目录）。笼统写一句「未检测到 Everything」会让人以为装了也没用。
 */
function engineHint(status: SearchStatus | null, hits: SearchHits | null, busy: boolean): string {
  if (status === null) return "正在准备搜索…";
  if (!status.ready) return "正在建索引…";
  if (busy && hits === null) return "正在搜索…";
  if (hits?.notice != null) return hits.notice;
  if (status.es !== null) return "Everything · 连全盘一起搜";
  if (status.everything) return "Everything 少了命令行工具 es.exe，只搜了常用目录";
  return "本地索引 · 只搜桌面、文档、下载";
}

/**
 * 「刚刚 / 12 分钟前 / 昨天 / 11-06」。
 *
 * 历史卡片下面那行小字。超过一个月的直接给日期——「37 天前」还得自己换算，
 * 不如让人一眼看到是哪天。
 */
function agoLabel(at: string): string {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "";

  const minutes = Math.floor((Date.now() - time.getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;

  const month = `${time.getMonth() + 1}`.padStart(2, "0");
  const day = `${time.getDate()}`.padStart(2, "0");
  return `${month}-${day}`;
}

export function Search({ onDraft, onBack, token }: Props) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SearchHits | null>(null);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  /** 最近打开过的应用 / 文件，空输入时铺成网格 */
  const [recent, setRecent] = useState<SearchHistoryEntry[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  /**
   * 查询序号。每次发请求都 +1，回来时对不上就丢掉——
   * 打字快的时候会有两三个查询同时在飞，慢的那次回来了不能盖掉新的结果。
   */
  const seq = useRef(0);

  const query = text.trim();

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await invoke<SearchStatus>("search_status"));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // 最近打开。读不出来就当空的——记录坏了不该让搜索本身不能使
  useEffect(() => {
    void invoke<SearchHistoryEntry[]>("search_history")
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);

  // 索引在后台线程里建，建好之前搜文件是空的。600ms 一问，建好就停。
  useEffect(() => {
    if (status === null || status.ready) return;
    const timer = window.setTimeout(() => void loadStatus(), 600);
    return () => window.clearTimeout(timer);
  }, [status, loadStatus]);

  // 面板被重新唤起：输入框、结果、选中项一起归零，回到「打开就能敲」的状态
  useEffect(() => {
    setText("");
    setHits(null);
    setActive(0);
    setBusy(false);
    setError(null);
    seq.current += 1;
    inputRef.current?.focus();
  }, [token]);

  useEffect(() => {
    if (query === "") {
      // 作废还在飞的那次：它回来时会发现序号对不上，不会把结果贴回空输入框下面
      seq.current += 1;
      setHits(null);
      setBusy(false);
      setActive(0);
      return;
    }

    setBusy(true);
    const timer = window.setTimeout(() => {
      const mine = ++seq.current;
      void invoke<SearchHits>("search_query", { text: query, limit: LIMIT })
        .then((result) => {
          if (mine !== seq.current) return;
          setHits(result);
          setActive(0);
          setError(null);
        })
        .catch((err) => {
          if (mine === seq.current) setError(String(err));
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false);
        });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query]);

  /** 按「应用在前、文件在后」摊平，键盘上下走的就是这个顺序 */
  const rows = useMemo(() => (hits === null ? [] : [...hits.apps, ...hits.files]), [hits]);

  // 选中项要跟着滚进来（上下键翻到第十条时，它得在可视区里）
  useEffect(() => {
    rowRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  const open = useCallback(async (hit: SearchHit) => {
    try {
      // 后端顺手记一条「最近打开」，返回值就是重排后的历史，直接铺回去
      setRecent(
        await invoke<SearchHistoryEntry[]>("search_open", {
          path: hit.path,
          name: hit.name,
          kind: hit.kind,
        }),
      );
      setError(null);
    } catch (err) {
      // 界面上是一行红字，但终端里看不到——顺手转一份到 dev 日志，方便排查「点了没反应」
      setError(String(err));
      void invoke("web_log", { message: `[search] 打开失败：${err}` });
    }
  }, []);

  /** 从最近打开里摘掉一条（卡片右上角的 ×） */
  const forget = useCallback(async (path: string) => {
    try {
      setRecent(await invoke<SearchHistoryEntry[]>("search_forget", { path }));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const clearHistory = useCallback(async () => {
    try {
      await invoke("search_history_clear");
      setRecent([]);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const reveal = useCallback(async (hit: SearchHit) => {
    try {
      await invoke("search_reveal", { path: hit.path });
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const clear = () => {
    setText("");
    inputRef.current?.focus();
  };

  /**
   * 重新建索引 + 重新找一次 es.exe。
   *
   * `es.exe` 只在建索引时探一次，所以「先开面板、后装 Everything」的人不重启就永远
   * 接不上。这个按钮把这条路补上：重建（几十万条以内一秒）完再读一次状态。
   */
  const recheck = async () => {
    try {
      setStatus(null);
      await invoke("search_reindex");
      // 重建是后台线程，给它一拍再读状态；没建好这边会继续轮询（见上面那个 effect）
      window.setTimeout(() => void loadStatus(), 400);
    } catch (err) {
      setError(String(err));
    }
  };

  /** 搜不到东西时给条出路：打开 Everything 的下载页（装本体 / 补 es.exe 都在这一页） */
  const openDownload = async () => {
    try {
      await invoke("open_url", { url: EVERYTHING_DOWNLOAD });
    } catch (err) {
      setError(String(err));
    }
  };

  /** 上下键在结果里走一圈，回车打开当前那条 */
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rows.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((prev) => (prev + step + rows.length) % rows.length);
      return;
    }

    if (event.key === "Enter") {
      const hit = rows[active];
      if (hit !== undefined) {
        event.preventDefault();
        void open(hit);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      // 有字就先清字，空着再按才回待办——别让人一按 Esc 就被踢出这一页
      if (text !== "") {
        clear();
        return;
      }
      onBack();
    }
  };

  const groups = [
    { key: "apps", label: "应用", items: hits?.apps ?? [] },
    { key: "files", label: "文件", items: hits?.files ?? [] },
  ];
  let cursor = 0;

  return (
    <div className="search">
      <div className="search__box">
        <span className="search__glyph">
          <MagnifierIcon />
        </span>
        <input
          ref={inputRef}
          className="search__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜文件、应用…"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          aria-label="搜索本机文件和程序"
        />
        {text !== "" && (
          <button type="button" className="search__clear" onClick={clear} title="清空" aria-label="清空搜索">
            ×
          </button>
        )}
      </div>

      <div className="search__meta">
        {/* title 里放索引的真实覆盖面：桌面 / 文档 / 下载可能被重定向到 OneDrive 或别的盘，
            文字里写死「桌面、文档、下载」，鼠标悬停才看得到具体是哪几个目录 */}
        <p
          className="search__engine"
          title={
            status === null
              ? undefined
              : `${status.apps} 个应用 · ${status.files} 个文件${
                  status.roots.length > 0 ? `\n${status.roots.join("\n")}` : ""
                }`
          }
        >
          {engineHint(status, hits, busy)}
        </p>
        {/* 装了 Everything 却没接上时给个出口：es.exe 可能刚放进 PATH，不用重启应用 */}
        {status !== null && status.ready && status.es === null && (
          <button type="button" className="search__recheck" onClick={() => void recheck()}>
            重新检测
          </button>
        )}
      </div>

      {error !== null && <div className="panel__error">{error}</div>}

      <div className="search__body" ref={bodyRef}>
        {query === "" ? (
          recent.length > 0 ? (
            /* 空着的时候先给「上次打开的那个东西」——比一句「敲名字就行」有用得多 */
            <div className="search__recent">
              <div className="search__group">
                <span>最近打开</span>
                <button
                  type="button"
                  className="search__group-act"
                  onClick={() => void clearHistory()}
                >
                  清空
                </button>
              </div>
              <ul className="search__grid">
                {recent.map((entry) => (
                  <li key={entry.path} className="recent">
                    <button
                      type="button"
                      className="recent__open"
                      onClick={() => void open(entry)}
                      title={entry.path}
                    >
                      <Badge kind={entry.kind} />
                      <span className="recent__name">{entry.name}</span>
                      <span className="recent__meta">{agoLabel(entry.at)}</span>
                    </button>
                    {/* 删除按钮只能是卡片的兄弟节点，不能嵌在那个 button 里 */}
                    <button
                      type="button"
                      className="recent__del"
                      onClick={() => void forget(entry.path)}
                      title="从最近打开里移除"
                      aria-label="从最近打开里移除"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="search__empty">
              <span className="search__empty-title">找应用、找文件</span>
              <span className="search__empty-note">
                敲名字就行，首字母也行（<code>vsc</code> 能找到 Visual Studio Code）。
                <br />
                ↑↓ 挑，回车打开，Esc 清空。
              </span>
            </div>
          )
        ) : rows.length === 0 ? (
          <div className="search__empty">
            <span className="search__empty-title">{busy ? "在找了…" : `没搜到「${query}」`}</span>
            {!busy && (
              <>
                <span className="search__empty-note">
                  {status !== null && status.es === null
                    ? "只搜了桌面、文档、下载；接上 Everything 就能连全盘一起搜。"
                    : "换个说法试试，两三个字的片段比整句好使。"}
                </span>
                <div className="search__empty-acts">
                  {/* 搜不到文件，多半是脑子里那句话本身就是一件要做的事——顺手记下来 */}
                  <button type="button" className="chip" onClick={() => onDraft(query)}>
                    记为待办
                  </button>
                  {status !== null && status.es === null && (
                    <button type="button" className="chip" onClick={() => void openDownload()}>
                      {/* 装了就差命令行工具，那是两个不同的动作，别用同一句话糊过去 */}
                      {status.everything ? "补上 es.exe" : "装 Everything"}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          groups.map((group) => {
            if (group.items.length === 0) return null;
            return (
              <div className="search__group-block" key={group.key}>
                <div className="search__group">
                  <span>{group.label}</span>
                  <span className="search__group-count">{group.items.length}</span>
                </div>
                <ul className="search__list">
                  {group.items.map((hit) => {
                    const index = cursor++;
                    return (
                      <li
                        key={`${group.key}:${hit.path}`}
                        ref={(node) => {
                          rowRefs.current[index] = node;
                        }}
                        className={`search__row${index === active ? " search__row--on" : ""}`}
                        onMouseMove={() => setActive(index)}
                        onClick={() => void open(hit)}
                        title={hit.path}
                      >
                        <Badge kind={hit.kind} />
                        <span className="search__text">
                          <span className="search__name">{hit.name}</span>
                          <span className="search__path">{hit.path}</span>
                        </span>
                        {/* 只给文件和目录「在文件夹中显示」，应用本来就是个快捷方式 */}
                        {group.key === "files" && (
                          <button
                            type="button"
                            className="search__reveal"
                            onClick={(event) => {
                              event.stopPropagation();
                              void reveal(hit);
                            }}
                          >
                            定位
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
