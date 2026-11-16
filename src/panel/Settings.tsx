import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Switch } from "../ui/Switch";
import type { SettingsView } from "./types";
import "./settings.css";

interface Props {
  /** 内容变化后让面板重新量高度 */
  onLayout: () => void;
  /** 数据被改动（清空历史）后通知外面刷新待办与统计 */
  onDataChanged: () => void;
  /** 面板尺寸恢复成「跟着内容走」之后，让外面重新量一次高度 */
  onResetSize: () => void;
}

/** 气泡停留时长的三档。再短来不及看清，再长就一直挡着屏幕 */
const BUBBLE_CHOICES = [10, 15, 30];

export function Settings({ onLayout, onDataChanged, onResetSize }: Props) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 清空历史要点两下：第一次变成「确定清空？」，3 秒不点自己退回去 */
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const confirmTimer = useRef(0);

  useEffect(() => {
    invoke<SettingsView>("get_settings")
      .then((next) => {
        setView(next);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    onLayout();
  }, [onLayout, view, error, confirming, note]);

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  /** 三个开关动作长得一样：调用 → 用返回值刷新整页 → 失败只报错不动状态 */
  const apply = useCallback(async (run: () => Promise<SettingsView>) => {
    setBusy(true);
    try {
      const next = await run();
      setView(next);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  /** 面板尺寸回到「跟着内容走」：清掉保存的尺寸，再让面板重新量高度 */
  const resetSize = () => {
    if (busy || view === null) return;
    void apply(async () => {
      const next = await invoke<SettingsView>("set_panel_size", { size: null });
      // 先让外面把锁放开、重新量一次，再把新状态摆上来
      onResetSize();
      return next;
    });
  };

  const armClear = () => {
    if (busy) return;
    if (!confirming) {
      setConfirming(true);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirming(false), 3500);
      return;
    }

    window.clearTimeout(confirmTimer.current);
    setConfirming(false);
    setBusy(true);
    invoke<number>("clear_history")
      .then((count) => {
        setNote(count === 0 ? "历史本来就是空的" : `已清空 ${count} 条记录`);
        setError(null);
        onDataChanged();
        window.setTimeout(() => setNote(null), 3000);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="page__body" data-page-body>
      {error !== null && <div className="panel__error">{error}</div>}

      <section className="set">
        <h2 className="set__title">通用</h2>
        <div className="option">
          <Switch
            on={view?.autostart ?? false}
            label="开机自启"
            onChange={(next) => {
              if (busy || view === null) return;
              void apply(() => invoke<SettingsView>("set_autostart", { on: next }));
            }}
          />
          <button
            type="button"
            className="option__label"
            onClick={() => {
              if (busy || view === null) return;
              void apply(() => invoke<SettingsView>("set_autostart", { on: !view.autostart }));
            }}
          >
            开机自启
          </button>
        </div>
        <p className="set__hint">开机后自动把桌宠叫起来，不弹窗、不抢焦点。</p>
      </section>

      <section className="set">
        <h2 className="set__title">外观</h2>
        <div className="option">
          <Switch
            on={view?.pet_style === "real"}
            label="写实立绘"
            onChange={(next) => {
              if (busy || view === null) return;
              void apply(() =>
                invoke<SettingsView>("set_pet_style", { style: next ? "real" : "chibi" }),
              );
            }}
          />
          <button
            type="button"
            className="option__label"
            onClick={() => {
              if (busy || view === null) return;
              void apply(() =>
                invoke<SettingsView>("set_pet_style", {
                  style: view.pet_style === "real" ? "chibi" : "real",
                }),
              );
            }}
          >
            写实立绘
          </button>
        </div>
        <p className="set__hint">
          {view?.pet_style === "real"
            ? "写实立绘：8 张表情，新交互都只在这一版上更新。"
            : "Q 版已归档：11 张立绘照常能用，但不再跟着新交互更新。"}
        </p>

        <div className="option">
          <Switch
            on={view?.pet_live2d ?? false}
            label="动态立绘"
            onChange={(next) => {
              if (busy || view === null) return;
              void apply(() => invoke<SettingsView>("set_pet_live2d", { on: next }));
            }}
          />
          <button
            type="button"
            className="option__label"
            onClick={() => {
              if (busy || view === null) return;
              void apply(() =>
                invoke<SettingsView>("set_pet_live2d", { on: !view.pet_live2d }),
              );
            }}
          >
            动态立绘（Live2D）
          </button>
        </div>
        <p className="set__hint">
          {view?.pet_style !== "real"
            ? "只在写实立绘下生效，先把上面的开关打开。"
            : view?.pet_live2d
              ? "模型 + 物理 + 眨眼：头发会晃，鼠标移过去她会看你。加载失败会自动退回静态图。"
              : "打开后换成 Live2D 模型，代价是多占约 20 MB 内存和一点显卡。"}
        </p>
      </section>

      <section className="set">
        <h2 className="set__title">面板</h2>
        <div className="option">
          <span className="option__label option__label--static">窗口尺寸</span>
          <span className="set__value">
            {view?.panel_size == null
              ? "跟着内容"
              : `${view.panel_size.width} × ${view.panel_size.height}`}
          </span>
          {view?.panel_size != null && (
            <button type="button" className="ui-btn set__reset" onClick={resetSize} disabled={busy}>
              恢复自动
            </button>
          )}
        </div>
        <p className="set__hint">拖面板的边或角就能改大小，改完会记住，下次打开还是这么大。</p>
      </section>

      <section className="set">
        <h2 className="set__title">提醒</h2>
        <div className="option">
          <span className="option__label option__label--static">气泡停留</span>
          <div className="option__chips">
            {BUBBLE_CHOICES.map((seconds) => (
              <button
                key={seconds}
                type="button"
                className={`chip${view?.bubble_seconds === seconds ? " chip--on" : ""}`}
                onClick={() => {
                  if (busy || view === null) return;
                  void apply(() =>
                    invoke<SettingsView>("set_bubble_seconds", { seconds }),
                  );
                }}
                disabled={busy || view === null}
              >
                {seconds} 秒
              </button>
            ))}
          </div>
        </div>
        <p className="set__hint">提醒气泡没人理的时候，多久自己收起来。</p>
      </section>

      <section className="set">
        <h2 className="set__title">数据</h2>
        <div className="option">
          <span className="option__label option__label--static">清空历史</span>
          <button
            type="button"
            className={`ui-btn set__danger${confirming ? " set__danger--armed" : ""}`}
            onClick={armClear}
            disabled={busy}
          >
            {confirming ? "确定清空？" : "清空"}
          </button>
        </div>
        <p className={`set__hint${note !== null ? " set__hint--ok" : ""}`}>
          {note ?? "只删已完成的记录，待办不受影响。"}
        </p>
      </section>

      <section className="set">
        <h2 className="set__title">关于</h2>
        <div className="set__row">
          <span className="set__key">版本</span>
          <span className="set__value">v{view?.version ?? "—"}</span>
        </div>
        <div className="set__row">
          <span className="set__key">数据目录</span>
          <span className="set__value set__value--path" title={view?.data_dir}>
            {view?.data_dir ?? "—"}
          </span>
        </div>
      </section>
    </div>
  );
}
