import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  CROPS,
  MAX_EDGES,
  QUALITIES,
  extOf,
  formatBytes,
  mimeOf,
  outputStem,
  planSize,
  resolveFormat,
  savingLabel,
  usesQuality,
  type CropPlan,
  type CropRatio,
  type ImageFormat,
  type OutputFormat,
} from "./image";
import type { ToolProps } from "./types";

/** 拖进来的单张图（已经从字节解成了位图）。位图留着，选项一变就地重编 */
interface Single {
  /** 拖进来才有；「选择图片」挑的拿不到路径，存盘时落到图片文件夹 */
  path: string | null;
  name: string;
  bytes: number;
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

/** 单张的处理结果 */
interface Result {
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

/** 批量里的一张。只存路径，处理时一张张读、编完就把位图扔掉 */
interface Job {
  path: string;
  name: string;
  bytes: number;
  status: "waiting" | "working" | "done" | "failed";
  width?: number;
  height?: number;
  outBytes?: number;
  blob?: Blob;
  error?: string;
}

interface Folder {
  name: string;
  jobs: Job[];
  /** 文件夹里总共有多少张；超过上限时只处理前 `jobs.length` 张 */
  total: number;
}

/** `image_open` 的返回：拖进来的可能是一张图，也可能是一个文件夹 */
type Opened =
  | { kind: "image"; file: { name: string; ext: string; size: number; data: string } }
  | {
      kind: "folder";
      name: string;
      items: { path: string; name: string; size: number }[];
      total: number;
    };

/** 存完之后那一行：说清存了几张、在哪 */
interface Saved {
  text: string;
  /** 用来「打开位置」，取第一张的路径就够 */
  path: string;
  failed: number;
}

/** 能处理的扩展名。和 Rust 侧的白名单对齐，两边都拦一道 */
const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "bmp", "gif"];

/** 选项改动后等这么久再重新编码：连点几个胶囊时不必每一下都跑一次 canvas */
const DEBOUNCE_MS = 140;

function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXT.includes(ext);
}

/** 不带 type 的 Blob：`createImageBitmap` 自己嗅探格式，写死一个反而会误导 */
function base64ToBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes]);
}

function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    // 一次塞 32KB 进 fromCharCode：再多会顶到参数个数上限
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  });
}

/** 把位图按计划画进 canvas 并编码。单张和批量共用这一份 */
async function encode(
  bitmap: ImageBitmap,
  plan: CropPlan,
  format: OutputFormat,
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = plan.dw;
  canvas.height = plan.dh;

  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("拿不到画布");
  // JPEG 没有透明通道：不铺白底，透明区域会变成黑色
  if (format === "jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, plan.dw, plan.dh);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.dw, plan.dh);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, mimeOf(format), usesQuality(format) ? quality : undefined);
  });
  if (blob === null) throw new Error("编码失败");
  return blob;
}

/** 目录部分，用来在批量存完之后显示「存到哪」 */
function dirOf(path: string): string {
  const index = path.search(/[\\/][^\\/]+$/);
  return index < 0 ? path : path.slice(0, index);
}

/**
 * 图片处理：拖一张图（或一个文件夹）进来，选格式 / 质量 / 长边 / 裁剪，存回本地。
 *
 * **压缩和转码都在 canvas 里做**（浏览器的解码器 + `toBlob`），Rust 只负责读文件和
 * 落盘——引一套 Rust 图像库要编很久、体积也大，而这个面板只做「随手压一下」。
 *
 * 两种模式：
 * - **单张**：位图留着，选项一变就地重编，预览实时跟手；
 * - **批量**（拖文件夹）：一张张读、编、扔位图，进度显示在列表里。选项改了不自动重跑，
 *   而是把「重新处理」亮出来——四十张图每点一下胶囊都重编一轮，谁也等不起。
 */
export function ToolImage({ onLayout }: ToolProps) {
  const [single, setSingle] = useState<Single | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [folder, setFolder] = useState<Folder | null>(null);

  const [format, setFormat] = useState<ImageFormat>("keep");
  const [quality, setQuality] = useState(QUALITIES[1].value);
  const [maxEdge, setMaxEdge] = useState(0);
  const [crop, setCrop] = useState<CropRatio>("none");

  const [batchBusy, setBatchBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** 点「保存」之后展开的「另存 / 覆盖」选择 */
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  /** 位图占的是显存/堆内存，换图和解散时必须主动 close，不能等 GC */
  const bitmapRef = useRef<ImageBitmap | null>(null);
  /** 编码的批次号：慢的那次回来时如果选项又变了，结果要丢掉 */
  const seq = useRef(0);
  /** 批量处理的批次号：换了文件夹 / 点了重新处理，老循环就该停 */
  const batchSeq = useRef(0);
  /** 批量这一轮是按哪套选项跑的，用来判断「选项变了要不要重跑」 */
  const processedRef = useRef<string | null>(null);

  const batch = folder !== null;
  const target: OutputFormat =
    single === null ? "png" : resolveFormat(format, single.name);
  const signature = `${format}|${quality}|${maxEdge}|${crop}`;
  const stale = folder !== null && processedRef.current !== null && processedRef.current !== signature;

  /**
   * 质量那排要不要露出来。
   *
   * 批量 + 「原格式」时每张的格式可能都不一样（混着 png 和 jpg），没法逐一判断，
   * 就按「选了 PNG 才收起」处理：png 那几张会忽略质量，但界面不用跟着闪。
   */
  const showQuality = single !== null ? usesQuality(target) : format !== "png";

  const jobs = folder?.jobs ?? [];
  const doneJobs = jobs.filter((job) => job.status === "done");
  const failedJobs = jobs.filter((job) => job.status === "failed");
  const bytesBefore = doneJobs.reduce((sum, job) => sum + job.bytes, 0);
  const bytesAfter = doneJobs.reduce((sum, job) => sum + (job.outBytes ?? 0), 0);

  /* ------------------------------------------------------------ 打开 */

  /** 换一张图：旧的位图立刻释放，别让它陪着一起等 GC */
  const apply = useCallback((next: Single) => {
    bitmapRef.current?.close();
    bitmapRef.current = next.bitmap;
    setSingle(next);
    setResult(null);
    setSaved(null);
    setAsking(false);
    setError(null);
  }, []);

  const clear = useCallback(() => {
    batchSeq.current += 1;
    bitmapRef.current?.close();
    bitmapRef.current = null;
    setSingle(null);
    setResult(null);
    setFolder(null);
    setSaved(null);
    setAsking(false);
    setError(null);
    setBatchBusy(false);
  }, []);

  // 卸载时把批量的循环也掐掉：面板一关，剩下的几十张没必要继续编
  useEffect(
    () => () => {
      batchSeq.current += 1;
      bitmapRef.current?.close();
    },
    [],
  );

  /** 单张：给一段字节就行（拖进来的是路径，选进来的是 File） */
  const openBlob = useCallback(
    async (blob: Blob, name: string, path: string | null, bytes: number) => {
      try {
        const bitmap = await createImageBitmap(blob);
        apply({ path, name, bytes, width: bitmap.width, height: bitmap.height, bitmap });
      } catch {
        setError("这张图认不出来（可能是 HEIC 或者文件坏了）");
      }
    },
    [apply],
  );

  const patchJob = useCallback((index: number, patch: Partial<Job>) => {
    setFolder((prev) => {
      if (prev === null) return prev;
      return {
        ...prev,
        jobs: prev.jobs.map((job, i) => (i === index ? { ...job, ...patch } : job)),
      };
    });
  }, []);

  /** 批量：一张张读、编、扔位图。顺序执行，内存是平的，进度也看得见 */
  const runBatch = useCallback(
    async (list: Job[]) => {
      const mine = ++batchSeq.current;
      processedRef.current = `${format}|${quality}|${maxEdge}|${crop}`;
      setBatchBusy(true);
      setAsking(false);
      setSaved(null);
      setError(null);

      for (let index = 0; index < list.length; index += 1) {
        if (batchSeq.current !== mine) return;
        patchJob(index, { status: "working" });

        try {
          const file = await invoke<{ name: string; size: number; data: string }>("image_read", {
            path: list[index].path,
          });
          const bitmap = await createImageBitmap(base64ToBlob(file.data));
          // 格式按**这一张自己的名字**推：「原格式」在批量里意味着各存各的格式
          const formatOfJob = resolveFormat(format, file.name);

          let blob: Blob;
          let plan: CropPlan;
          try {
            plan = planSize(bitmap, crop, maxEdge);
            blob = await encode(bitmap, plan, formatOfJob, quality);
          } finally {
            // 这一张用完了就扔：四十张 4K 全留着，内存直接顶到几百 MB。
            // 放在 finally 里，编码失败时也不能漏
            bitmap.close();
          }

          if (batchSeq.current !== mine) return;
          patchJob(index, {
            status: "done",
            blob,
            width: plan.dw,
            height: plan.dh,
            outBytes: blob.size,
          });
        } catch (err) {
          console.error("[image] 批量处理失败", list[index].path, err);
          if (batchSeq.current !== mine) return;
          patchJob(index, { status: "failed", error: String(err) });
        }
      }

      if (batchSeq.current === mine) setBatchBusy(false);
    },
    [crop, maxEdge, quality, format, patchJob],
  );

  /** 拖进来的路径：WebView 没有文件系统权限，得让 Rust 读。文件夹则走批量 */
  const openPath = useCallback(
    async (path: string) => {
      try {
        setError(null);
        const opened = await invoke<Opened>("image_open", { path });

        if (opened.kind === "folder") {
          clear();
          const next: Job[] = opened.items.map((item) => ({
            path: item.path,
            name: item.name,
            bytes: item.size,
            status: "waiting",
          }));
          setFolder({ name: opened.name, jobs: next, total: opened.total });
          void runBatch(next);
          return;
        }

        const blob = base64ToBlob(opened.file.data);
        const bitmap = await createImageBitmap(blob);
        batchSeq.current += 1;
        setFolder(null);
        setBatchBusy(false);
        apply({
          path,
          name: opened.file.name,
          bytes: opened.file.size,
          width: bitmap.width,
          height: bitmap.height,
          bitmap,
        });
      } catch (err) {
        setError(String(err));
      }
    },
    [apply, clear, runBatch],
  );

  // 拖拽是 Tauri 的原生事件：它给的是真实路径，HTML5 的 drop 在 Tauri 窗口里收不到
  useEffect(() => {
    const pending = getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        setDragging(true);
        return;
      }
      if (payload.type === "leave") {
        setDragging(false);
        return;
      }

      setDragging(false);
      // 一次只接一个：拖一堆文件进来时默默只处理第一张，比报错更让人困惑
      if (payload.paths.length > 1) {
        setError("一次拖一张图或一个文件夹，批量请拖文件夹");
        return;
      }

      // 文件夹也认：名字里通常没有扩展名，所以过滤不能只看后缀
      const path = payload.paths[0];
      if (path === undefined) return;
      if (!isImagePath(path) && path.includes(".")) {
        setError("只能拖图片或文件夹进来");
        return;
      }
      void openPath(path);
    });

    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [openPath]);

  /* ------------------------------------------------------------ 单张预览 */

  useEffect(() => {
    if (single === null) return;

    const mine = ++seq.current;
    setBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const plan = planSize(single, crop, maxEdge);
          const blob = await encode(single.bitmap, plan, target, quality);
          if (mine !== seq.current) return;

          setResult({ blob, url: URL.createObjectURL(blob), width: plan.dw, height: plan.dh });
          setSaved(null);
          setAsking(false);
          setError(null);
        } catch (err) {
          if (mine !== seq.current) return;
          console.error("[image] 处理失败", err);
          setError("这张图处理不了，换一张试试");
        } finally {
          if (mine === seq.current) setBusy(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [single, crop, maxEdge, quality, target]);

  // 预览用的是 object URL，换一张就把旧的那个吊销，不然每切一次都漏一份内存
  useEffect(() => {
    if (result === null) return;
    const url = result.url;
    return () => URL.revokeObjectURL(url);
  }, [result]);

  useEffect(() => {
    onLayout();
  }, [onLayout, single, result, folder, error, saved, asking, showQuality]);

  /* ------------------------------------------------------------ 保存 */

  /** 有没有「原文件」可以覆盖：单张看路径，批量每张都有 */
  const canReplace = batch || single?.path != null;

  const save = async (replace: boolean) => {
    setAsking(false);
    setSaving(true);
    try {
      if (folder !== null) {
        let ok = 0;
        let failed = 0;
        let first = "";

        for (const job of folder.jobs) {
          if (job.status !== "done" || job.blob === undefined) continue;
          try {
            const data = await blobToBase64(job.blob);
            const path = await invoke<string>("image_save", {
              source: job.path,
              name: outputStem(job.name, job.width ?? 0, job.height ?? 0),
              // 每张按自己的格式存：「原格式」在批量里就是各存各的
              ext: extOf(resolveFormat(format, job.name)),
              data,
              replace,
            });
            ok += 1;
            if (first === "") first = path;
          } catch (err) {
            console.error("[image] 保存失败", job.path, err);
            failed += 1;
          }
        }

        if (ok === 0) {
          setError("一张都没存上，检查一下文件是不是被别的程序占着");
        } else {
          setSaved({
            text: `${replace ? "已覆盖" : "已另存"} ${ok} 张到 ${dirOf(first)}`,
            path: first,
            failed,
          });
          setError(null);
        }
        return;
      }

      if (single === null || result === null) return;
      const data = await blobToBase64(result.blob);
      const path = await invoke<string>("image_save", {
        source: single.path,
        name: outputStem(single.name, result.width, result.height),
        ext: extOf(target),
        data,
        replace,
      });
      setSaved({ text: replace ? "已覆盖原图" : "已另存一份", path, failed: 0 });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const reveal = () => {
    if (saved === null) return;
    void invoke("search_reveal", { path: saved.path }).catch((err) => setError(String(err)));
  };

  /* ------------------------------------------------------------ 渲染 */

  const pick = () => inputRef.current?.click();

  const savedLine = saved !== null && (
    <div className="image__saved">
      <span className="image__saved-path" title={saved.path}>
        {saved.text}
        {saved.failed > 0 ? `，${saved.failed} 张失败` : ""}
      </span>
      <button type="button" className="image__saved-open" onClick={reveal}>
        打开位置
      </button>
    </div>
  );

  const askBar = asking && (
    <div className="image__ask">
      <div className="image__ask-head">
        <span className="image__ask-title">
          {batch ? `保存 ${doneJobs.length} 张，怎么存？` : "存到哪儿？"}
        </span>
        <button type="button" className="image__ask-cancel" onClick={() => setAsking(false)}>
          取消
        </button>
      </div>
      <div className="image__ask-acts">
        <button
          type="button"
          className="ui-btn ui-btn--primary image__ask-main"
          onClick={() => void save(false)}
          disabled={saving}
        >
          另存一份
        </button>
        {canReplace && (
          <button
            type="button"
            className="ui-btn image__ask-replace"
            onClick={() => void save(true)}
            disabled={saving}
          >
            覆盖原图
          </button>
        )}
      </div>
      <p className="image__ask-note">
        {canReplace
          ? replaceNote(target, batch ? null : (single?.path ?? null), batch, format)
          : "这张图是选进来的，没有原路径，只能另存"}
      </p>
    </div>
  );

  return (
    <div className={`image${dragging ? " image--drag" : ""}`}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="image__file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // 同一个文件选两次也要能触发 change
          event.target.value = "";
          if (file !== undefined) {
            batchSeq.current += 1;
            setFolder(null);
            setBatchBusy(false);
            void openBlob(file, file.name, null, file.size);
          }
        }}
      />

      <section className="tool image__panel">
        {batch ? (
          <div className="image__batch">
            <div className="image__batch-head">
              <span className="image__batch-name" title={folder.name}>
                {folder.name}
              </span>
              <span className="image__batch-count">{jobs.length} 张</span>
            </div>
            <p className="image__batch-stat">
              {doneJobs.length} / {jobs.length} 已处理
              {doneJobs.length > 0 && (
                <>
                  {" · "}
                  {formatBytes(bytesBefore)} → {formatBytes(bytesAfter)} ·{" "}
                  {savingLabel(bytesBefore, bytesAfter)}
                </>
              )}
              {failedJobs.length > 0 && (
                <span className="image__batch-failed"> · {failedJobs.length} 张失败</span>
              )}
            </p>
            {folder.total > jobs.length && (
              <p className="image__batch-more">
                文件夹里共 {folder.total} 张，这次先处理前 {jobs.length} 张
              </p>
            )}
            <ul className="image__batch-list">
              {jobs.map((job) => (
                <li
                  key={job.path}
                  className={`image__batch-row image__batch-row--${job.status}`}
                  title={job.error ?? job.path}
                >
                  <span className="image__batch-file">{job.name}</span>
                  <span className="image__batch-out">
                    {job.status === "done"
                      ? `${formatBytes(job.bytes)} → ${formatBytes(job.outBytes ?? 0)}`
                      : job.status === "working"
                        ? "处理中"
                        : job.status === "failed"
                          ? "失败"
                          : "排队"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : single === null || result === null ? (
          <button type="button" className="image__drop" onClick={pick}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="3" y="4.5" width="18" height="15" rx="3" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="8.6" cy="10" r="1.7" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M4 17 9.4 12l3.4 3 3-2.6L20 17"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="image__drop-title">
              {single === null ? "把图片或文件夹拖进来" : "正在处理…"}
            </span>
            <span className="image__drop-note">
              {single === null ? "jpg / png / webp · 拖文件夹可以一次处理一批" : "马上就好"}
            </span>
            {single === null && <span className="image__drop-cta">选择图片</span>}
          </button>
        ) : (
          <div className="image__preview">
            <img src={result.url} alt="处理后的预览" draggable={false} />
            {busy && <span className="image__busy">处理中…</span>}
          </div>
        )}

        {(single !== null || batch) && (
          <>
            {single !== null && result !== null && (
              <div className="image__meta">
                <span className="image__meta-row">
                  原图 {single.width}×{single.height} · {formatBytes(single.bytes)}
                </span>
                <span className="image__meta-row image__meta-row--now">
                  现在 {result.width}×{result.height} · {formatBytes(result.blob.size)} ·{" "}
                  {savingLabel(single.bytes, result.blob.size)}
                </span>
              </div>
            )}

            {stale && (
              <p className="image__stale">
                选项改过了，这批还是按旧设置处理的
                <button
                  type="button"
                  className="image__stale-act"
                  onClick={() =>
                    void runBatch(
                      jobs.map((job) => ({
                        path: job.path,
                        name: job.name,
                        bytes: job.bytes,
                        status: "waiting" as const,
                      })),
                    )
                  }
                  disabled={batchBusy}
                >
                  重新处理
                </button>
              </p>
            )}

            <div className="image__opts">
              <div className="image__opt">
                <span className="image__opt-label">格式</span>
                <div className="image__opt-chips">
                  {(
                    [
                      { value: "keep", label: "原格式" },
                      { value: "jpeg", label: "JPG" },
                      { value: "png", label: "PNG" },
                      { value: "webp", label: "WebP" },
                    ] as { value: ImageFormat; label: string }[]
                  ).map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      className={`chip${format === entry.value ? " chip--on" : ""}`}
                      onClick={() => setFormat(entry.value)}
                      aria-pressed={format === entry.value}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* PNG 是无损的，不给质量选项——摆一排点了没反应的按钮最劝退 */}
              {showQuality && (
                <div className="image__opt">
                  <span className="image__opt-label">质量</span>
                  <div className="image__opt-chips">
                    {QUALITIES.map((entry) => (
                      <button
                        key={entry.value}
                        type="button"
                        className={`chip${quality === entry.value ? " chip--on" : ""}`}
                        onClick={() => setQuality(entry.value)}
                        aria-pressed={quality === entry.value}
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="image__opt">
                <span className="image__opt-label">长边</span>
                <div className="image__opt-chips">
                  {MAX_EDGES.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      className={`chip${maxEdge === entry.value ? " chip--on" : ""}`}
                      onClick={() => setMaxEdge(entry.value)}
                      aria-pressed={maxEdge === entry.value}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="image__opt">
                <span className="image__opt-label">裁剪</span>
                <div className="image__opt-chips">
                  {CROPS.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      className={`chip${crop === entry.value ? " chip--on" : ""}`}
                      onClick={() => setCrop(entry.value)}
                      aria-pressed={crop === entry.value}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {askBar}

            {/* 选择条展开时把「保存」收起来：两排按钮同时摆着会让人不知道该点哪个 */}
            {!asking && (
              <div className="image__actions">
                <button
                  type="button"
                  className="ui-btn ui-btn--primary image__save"
                  onClick={() => setAsking(true)}
                  disabled={
                    saving || busy || batchBusy || (batch ? doneJobs.length === 0 : result === null)
                  }
                >
                  {saving ? "保存中…" : batch ? `保存 ${doneJobs.length} 张` : "保存"}
                </button>
                <button type="button" className="ui-btn ui-btn--ghost" onClick={clear}>
                  {batch ? "换一批" : "换一张"}
                </button>
              </div>
            )}

            {savedLine}
          </>
        )}

        {error !== null && <p className="image__error">{error}</p>}
      </section>

      {dragging && (
        <div className="image__drop-hint" aria-hidden="true">
          <span>松手就换这批</span>
        </div>
      )}
    </div>
  );
}

/**
 * 「覆盖原图」这句提示得说清后果：同格式是覆盖同一个文件，换格式会把原文件删掉。
 * 这两种后果不一样，不能共用一句「会替换原文件」。
 */
function replaceNote(
  target: OutputFormat,
  sourcePath: string | null,
  batch: boolean,
  format: ImageFormat,
): string {
  if (batch) {
    return format === "keep"
      ? "覆盖会把每张原文件都换掉，不能撤销"
      : "覆盖会按新格式重写每张，原来那些文件会被删掉";
  }

  const ext = extOf(target);
  const originExt = sourcePath?.split(".").pop()?.toLowerCase() ?? "";
  if (sourcePath !== null && originExt !== "" && originExt !== ext) {
    return `原图是 .${originExt}，会被换成 .${ext}，原文件删除`;
  }
  return "覆盖会把原文件换掉，不能撤销";
}
