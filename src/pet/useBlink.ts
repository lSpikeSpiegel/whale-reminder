import { useEffect, useState } from "react";

/** 两次眨眼的间隔范围（毫秒） */
const GAP_MIN = 2600;
const GAP_MAX = 6200;
/** 闭眼持续时间 */
const CLOSE_MS = 110;

/**
 * 随机眨眼。只有拿得到眼睛坐标的立绘才启用，
 * 否则会在错误的位置画出一条线。
 */
export function useBlink(enabled: boolean): boolean {
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setBlinking(false);
      return;
    }

    let openTimer = 0;
    let closeTimer = 0;

    const schedule = () => {
      const gap = GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);
      openTimer = window.setTimeout(() => {
        setBlinking(true);
        closeTimer = window.setTimeout(() => {
          setBlinking(false);
          schedule();
        }, CLOSE_MS);
      }, gap);
    };

    schedule();

    return () => {
      window.clearTimeout(openTimer);
      window.clearTimeout(closeTimer);
    };
  }, [enabled]);

  return blinking;
}
