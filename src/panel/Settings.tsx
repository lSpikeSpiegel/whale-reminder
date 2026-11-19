import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Switch } from "../ui/Switch";
import { LIVE2D_ENABLED } from "../live2d/availability";
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

/** 单个片段的显示写法：修饰键换成用户熟的叫法，Code 名还原成人按得出来的字 */
function keyLabel(part: string): string {
  if (part === "Control") return "Ctrl";
  if (part === "Super") return "Win";
  if (part === "Space") return "空格";
  if (/^Key[A-Z]$/.test(part)) return part.slice(3);
  if (/^Digit[0-9]$/.test(part)) return part.slice(5);
  return part;
}

/**
 * 快捷键的显示写法：`Control+Alt+Space` → `Ctrl + Alt + 空格`。
 *
 * 后端存的是插件认的紧凑写法（好解析），显示时把分隔符两侧撑开、修饰键换成
 * 用户熟的叫法。空串表示一个组合都没绑上（几个备选全被别的程序占着）。
 */
function shortcutLabel(raw?: string): string {
  if (!raw) return "未生效";
  return raw
    .split("+")
    .filter(Boolean)
    .map(keyLabel)
    .join(" + ");
}

/** 按下这些键本身不算组合，得等真正的主键 */
const MODIFIER_KEYS = new Set([
  "Control",
  "Alt",
  "Shift",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
]);

/**
 * `KeyboardEvent.code` → 后端认的主键名。
 *
 * 两边命名本来就同源（都是 keyboard-types 那套 Code），字母 / 数字 / F1–F24 /
 * 小键盘 / 方向键 / 标点全部一一对应，直接透传即可。挡掉的只是后端白名单里
 * 没有的那几个（`IntlBackslash`、`NumpadComma` 这类极少见的键位）——
 * 录进去也注册不上，不如当场说一声。
 */
const NAMED_CODES = new Set([
  "Space",
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "CapsLock",
  "NumLock",
  "PrintScreen",
  "ScrollLock",
  "Pause",
  "Minus",
  "Equal",
  "Comma",
  "Period",
  "Slash",
  "Backslash",
  "Semicolon",
  "Quote",
  "BracketLeft",
  "BracketRight",
  "Backquote",
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  "NumpadEnter",
  "NumpadEqual",
]);

function hotkeyCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code;
  if (/^Digit[0-9]$/.test(code)) return code;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return code;
  return NAMED_CODES.has(code) ? code : null;
}

export function Settings({ onLayout, onDataChanged, onResetSize }: Props) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 清空历史要点两下：第一次变成「确定清空？」，3 秒不点自己退回去 */
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const confirmTimer = useRef(0);
  /** 正在录制新快捷键：这期间整页的 keydown 都被拦下来 */
  const [capturing, setCapturing] = useState(false);
  /** 录制时按错了给一句提示，别让人以为卡住了 */
  const [captureHint, setCaptureHint] = useState<string | null>(null);

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
  }, [onLayout, view, error, confirming, note, capturing, captureHint]);

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

  const stopCapture = useCallback(() => {
    setCapturing(false);
    setCaptureHint(null);
  }, []);

  /** 开始录制。先告诉后端「别响应热键」，否则按到当前组合会先把面板自己收走 */
  const startCapture = useCallback(() => {
    if (busy || view === null) return;
    setCaptureHint(null);
    // 必须在后端真的置位之后再进入录制态：没置位就录，按到当前组合
    // 会走正常的 toggle 把面板收起来，录制器当场没了
    void invoke<boolean>("begin_shortcut_capture")
      .then((altSpaceReady) => {
        setCapturing(true);
        // 后端临时占不住 Alt+Space，说明被别的启动器（uTools / PowerToys）占着；
        // 这时候按它不会有任何反应，提前说清楚
        if (!altSpaceReady) {
          setCaptureHint("Alt+Space 被别的程序占着，暂时录不到它；其它组合可以");
        }
      })
      .catch((err) => setError(String(err)));
  }, [busy, view]);

  /** 放弃录制：后端按 settings.json 里存的原值重新挂上 */
  const cancelCapture = useCallback(() => {
    stopCapture();
    void invoke<SettingsView>("resume_shortcut")
      .then((next) => {
        setView(next);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, [stopCapture]);

  useEffect(() => {
    if (!capturing) return;

    /**
     * 注册过的组合会被系统吞掉，webview 收不到 keydown（`Alt+Space` 更特殊：
     * 没注册时会被窗口的系统菜单吃掉）。后端在录制期间把它临时占住，
     * 按下后从热键回调推这条事件过来，这里当作一次正常的录制结果。
     */
    const pending = listen<string>("shortcut://captured", (event) => {
      const captured = event.payload;
      if (captured === "") return;
      stopCapture();
      void apply(() =>
        invoke<SettingsView>("set_panel_shortcut", { shortcut: captured }),
      );
    });

    const onKeyDown = (event: KeyboardEvent) => {
      // 录制态下按什么都不该漏出去（尤其是别把面板自己的快捷键再触发一次）
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        cancelCapture();
        return;
      }
      // 还按着修饰键，等主键
      if (MODIFIER_KEYS.has(event.key)) return;

      const code = hotkeyCode(event.code);
      if (code === null) {
        setCaptureHint("这个键不行，换一个（字母、数字、F1–F24、方向键都可以）");
        return;
      }

      const mods: string[] = [];
      if (event.ctrlKey) mods.push("Control");
      if (event.altKey) mods.push("Alt");
      if (event.shiftKey) mods.push("Shift");
      if (event.metaKey) mods.push("Super");
      if (mods.length === 0) {
        // 裸字母做全局热键会把正常打字全抢走，必须带修饰键
        setCaptureHint("至少带一个 Ctrl / Alt / Shift / Win");
        return;
      }

      stopCapture();
      void apply(() =>
        invoke<SettingsView>("set_panel_shortcut", {
          shortcut: [...mods, code].join("+"),
        }),
      );
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      void pending.then((unlisten) => unlisten());
    };
  }, [capturing, apply, cancelCapture, stopCapture]);

  /**
   * 面板被关掉时如果还在录制态，热键在后端是「装死」的——收掉它。
   * 正常情况这个命令会随窗口一起消失，所以后端 `close_panel` 里也兜了一次。
   */
  useEffect(
    () => () => {
      void invoke("resume_shortcut").catch(() => {});
    },
    [],
  );

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

        {/* 动态立绘的模型本体不入库，发布版里没有素材，开关就完全不出来——
            点开只会静默退回静态图，白白让人以为坏了。见 live2d/availability.ts */}
        {LIVE2D_ENABLED && (
          <>
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
          </>
        )}
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

        <div className="option">
          <span className="option__label option__label--static">呼出快捷键</span>
          <span className={`set__value${capturing ? " set__capture" : ""}`}>
            {capturing ? "按下新的组合…" : shortcutLabel(view?.panel_shortcut)}
          </span>
          <button
            type="button"
            className="ui-btn set__reset"
            onClick={capturing ? cancelCapture : startCapture}
            disabled={busy || view === null}
          >
            {capturing ? "取消" : "改键"}
          </button>
        </div>
        <p className={`set__hint${captureHint !== null ? " set__hint--warn" : ""}`}>
          {captureHint ??
            (capturing
              ? "按你想用的组合，Esc 取消。"
              : view === null
                ? "随手按一下就能把面板叫到最前面，再按一次收起来。"
                : view.panel_shortcut
                  ? `随手按 ${shortcutLabel(view.panel_shortcut)} 把面板叫到最前，再按一次收起来。`
                  : "这个组合被别的程序占着了，点「改键」换一个。")}
        </p>
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
