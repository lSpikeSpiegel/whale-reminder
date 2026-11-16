interface SwitchProps {
  on: boolean;
  /** 无文字标签时给屏幕阅读器用 */
  label: string;
  onChange: (next: boolean) => void;
}

/**
 * 弹性开关。拇指按下时被「挤扁」（宽度变大），松开弹回原位，
 * 位移走弹簧曲线，比单纯变色更有手感。
 */
export function Switch({ on, label, onChange }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch${on ? " switch--on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="switch__thumb" />
    </button>
  );
}
