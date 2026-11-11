import type { UpdateState } from "./useUpdater";

interface Props {
  state: UpdateState;
  onInstall: () => void;
  onCheck: () => void;
  onDismiss: () => void;
}

/**
 * 面板顶部的更新横幅。只在有事情要发生时出现，
 * 检查中 / 已最新这类轻状态自动消失，不占版面。
 */
export function UpdateBanner({ state, onInstall, onCheck, onDismiss }: Props) {
  if (state.kind === "idle") return null;

  if (state.kind === "checking") {
    return (
      <div className="update update--muted">
        <span className="update__text">正在检查更新…</span>
      </div>
    );
  }

  if (state.kind === "uptodate") {
    return (
      <div className="update update--muted">
        <span className="update__text">已是最新版本</span>
      </div>
    );
  }

  if (state.kind === "available") {
    return (
      <div className="update">
        <div className="update__body">
          <span className="update__text">
            发现新版本 <b>v{state.version}</b>
          </span>
          {state.notes !== null && state.notes.trim() !== "" && (
            <span className="update__notes">{state.notes.trim().split("\n")[0]}</span>
          )}
        </div>
        <button className="update__action" onClick={onInstall}>
          更新
        </button>
        <button className="update__close" onClick={onDismiss} title="以后再说">
          ×
        </button>
      </div>
    );
  }

  if (state.kind === "downloading") {
    return (
      <div className="update update--progress">
        <div className="update__body">
          <span className="update__text">
            正在下载 v{state.version} · {state.percent}%
          </span>
          <div className="update__bar">
            <div className="update__bar-fill" style={{ width: `${state.percent}%` }} />
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "installing") {
    return (
      <div className="update update--muted">
        <span className="update__text">正在安装 v{state.version}，马上重启…</span>
      </div>
    );
  }

  return (
    <div className="update update--error">
      <span className="update__text">更新失败：{state.message}</span>
      <button className="update__action" onClick={onCheck}>
        重试
      </button>
      <button className="update__close" onClick={onDismiss} title="关闭">
        ×
      </button>
    </div>
  );
}
