import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  nowTime,
  WEEKDAY,
  WEEK_HEAD,
  dateAfter,
  humanDay,
  monthGrid,
  parseLocal,
  sameDay,
  shiftTime,
  toLocalDate,
} from "./date";
import "./datepicker.css";

interface DatePickerProps {
  /** `YYYY-MM-DD`，空串表示还没选 */
  date: string;
  /** `HH:mm` */
  time: string;
  onChange: (date: string, time: string) => void;
  /** month = 月历（面板）；days = 最近 7 天（气泡，空间小） */
  variant?: "month" | "days";
  /** 直接铺在页面里，不弹浮层（气泡窗口太小，浮层会被窗口裁掉） */
  inline?: boolean;
  ariaLabel?: string;
}

const Chevron = ({ dir }: { dir: "left" | "right" | "down" }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path
      d={dir === "left" ? "M7.5 2.5 4 6l3.5 3.5" : dir === "right" ? "M4.5 2.5 8 6l-3.5 3.5" : "M2.5 4.5 6 8l3.5-3.5"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const Caret = ({ up }: { up: boolean }) => (
  <svg width="9" height="6" viewBox="0 0 9 6" fill="none" aria-hidden="true">
    <path
      d={up ? "M1 5 4.5 1.5 8 5" : "M1 1 4.5 4.5 8 1"}
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** 时分步进器：小时按 1 走，分钟按 5 走 */
function TimeStepper({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [hh, mm] = (value || nowTime()).split(":");

  return (
    <div className="dp__time">
      <span className="dp__time-label">时间</span>
      <div className="dp__col">
        <button
          type="button"
          className="dp__step"
          onClick={() => onChange(shiftTime(value, 60))}
          aria-label="加一小时"
        >
          <Caret up />
        </button>
        <span className="dp__num">{hh}</span>
        <button
          type="button"
          className="dp__step"
          onClick={() => onChange(shiftTime(value, -60))}
          aria-label="减一小时"
        >
          <Caret up={false} />
        </button>
      </div>
      <span className="dp__colon">:</span>
      <div className="dp__col">
        <button
          type="button"
          className="dp__step"
          onClick={() => onChange(shiftTime(value, 5))}
          aria-label="加五分钟"
        >
          <Caret up />
        </button>
        <span className="dp__num">{mm}</span>
        <button
          type="button"
          className="dp__step"
          onClick={() => onChange(shiftTime(value, -5))}
          aria-label="减五分钟"
        >
          <Caret up={false} />
        </button>
      </div>
    </div>
  );
}

/** 月历：固定 6 行，切月不跳高度 */
function MonthGrid({
  cursor,
  value,
  onPick,
  onMove,
}: {
  cursor: { year: number; month: number };
  value: string;
  onPick: (date: string) => void;
  onMove: (delta: number) => void;
}) {
  const rows = monthGrid(cursor.year, cursor.month);
  const today = new Date();

  return (
    <div className="dp__month">
      <div className="dp__month-head">
        <button type="button" className="dp__nav" onClick={() => onMove(-1)} aria-label="上个月">
          <Chevron dir="left" />
        </button>
        <span className="dp__month-title">
          {cursor.year} 年 {cursor.month + 1} 月
        </span>
        <button type="button" className="dp__nav" onClick={() => onMove(1)} aria-label="下个月">
          <Chevron dir="right" />
        </button>
      </div>

      <div className="dp__week">
        {WEEK_HEAD.map((label) => (
          <span key={label} className="dp__week-cell">
            {label}
          </span>
        ))}
      </div>

      <div className="dp__grid">
        {rows.flat().map((day, index) => {
          if (day === null) {
            return <span key={`blank-${index}`} className="dp__day dp__day--blank" />;
          }
          const key = toLocalDate(day);
          const selected = key === value;
          const isToday = sameDay(day, today);
          return (
            <button
              key={key}
              type="button"
              className={`dp__day${selected ? " dp__day--on" : ""}${isToday ? " dp__day--today" : ""}`}
              onClick={() => onPick(key)}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 最近 7 天：气泡里放不下整月，横向一条就够用了 */
function DayStrip({
  value,
  onPick,
}: {
  value: string;
  onPick: (date: string) => void;
}) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = dateAfter(index);
    const parsed = parseLocal(date, "00:00");
    const label =
      index === 0
        ? "今天"
        : index === 1
          ? "明天"
          : index === 2
            ? "后天"
            : `周${WEEKDAY[parsed?.getDay() ?? 0]}`;
    return { date, num: parsed?.getDate() ?? 0, label };
  });

  return (
    <div className="dp__strip">
      {days.map((item) => (
        <button
          key={item.date}
          type="button"
          className={`dp__chip${item.date === value ? " dp__chip--on" : ""}`}
          onClick={() => onPick(item.date)}
        >
          <span className="dp__chip-day">{item.label}</span>
          <span className="dp__chip-num">{item.num}</span>
        </button>
      ))}
    </div>
  );
}

/** 横向的时分输入：循环提醒那种一行放得下的场景，不用三行高的步进器 */
function TimeInline({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [hh, mm] = (value || nowTime()).split(":");

  return (
    <>
      <div className="dp__hgroup">
        <button
          type="button"
          className="dp__hstep"
          onClick={() => onChange(shiftTime(value, -60))}
          aria-label="减一小时"
        >
          −
        </button>
        <span className="dp__num">{hh}</span>
        <button
          type="button"
          className="dp__hstep"
          onClick={() => onChange(shiftTime(value, 60))}
          aria-label="加一小时"
        >
          +
        </button>
      </div>
      <span className="dp__colon">:</span>
      <div className="dp__hgroup">
        <button
          type="button"
          className="dp__hstep"
          onClick={() => onChange(shiftTime(value, -5))}
          aria-label="减五分钟"
        >
          −
        </button>
        <span className="dp__num">{mm}</span>
        <button
          type="button"
          className="dp__hstep"
          onClick={() => onChange(shiftTime(value, 5))}
          aria-label="加五分钟"
        >
          +
        </button>
      </div>
    </>
  );
}

/** 只有一个时刻的输入（循环提醒用） */
export function TimeField({
  value,
  onChange,
  label = "时间",
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
}) {
  return (
    <div className="dp__field">
      <span className="dp__field-label">{label}</span>
      <TimeInline value={value || nowTime()} onChange={onChange} />
    </div>
  );
}

export function DatePicker({
  date,
  time,
  onChange,
  variant = "month",
  inline = false,
  ariaLabel = "选择时间",
}: DatePickerProps) {
  const [open, setOpen] = useState(inline);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [cursor, setCursor] = useState(() => {
    const value = parseLocal(date, time) ?? new Date();
    return { year: value.getFullYear(), month: value.getMonth() };
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const width = variant === "month" ? 268 : 248;
  const height = variant === "month" ? 312 : 136;

  // 打开时把月历对准当前选中的月份
  useEffect(() => {
    if (!open) return;
    const value = parseLocal(date, time) ?? new Date();
    setCursor({ year: value.getFullYear(), month: value.getMonth() });
  }, [open, date, time]);

  // 浮层贴着触发器，下方放不下就翻到上方，再整体夹进窗口
  useEffect(() => {
    if (!open || inline) return;
    const trigger = triggerRef.current;
    if (trigger === null) return;

    const rect = trigger.getBoundingClientRect();
    const gap = 8;
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - gap) {
      top = Math.max(gap, rect.top - height - gap);
    }
    const left = Math.min(
      Math.max(gap, rect.left),
      Math.max(gap, window.innerWidth - width - gap),
    );
    setPos({ top, left });
  }, [open, inline, height, width]);

  // 点外面 / 按 Esc 收起
  useEffect(() => {
    if (!open || inline) return;

    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      // 吃掉这个 Esc（preventDefault），面板看到 defaultPrevented 就不会跟着关：
      // 用户想收日历，不想连面板一起没了
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      setOpen(false);
    };

    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, inline]);

  const pick = (next: string) => {
    onChange(next, time || nowTime());
    if (!inline && variant === "month") setOpen(false);
  };

  const setTime = (next: string) => {
    onChange(date || toLocalDate(new Date()), next);
  };

  const move = (delta: number) => {
    setCursor((prev) => {
      const value = new Date(prev.year, prev.month + delta, 1);
      return { year: value.getFullYear(), month: value.getMonth() };
    });
  };

  const body = (
    <div className={`dp__body${variant === "days" ? " dp__body--days" : ""}`}>
      {variant === "month" ? (
        <MonthGrid cursor={cursor} value={date} onPick={pick} onMove={move} />
      ) : (
        <DayStrip value={date} onPick={pick} />
      )}

      <div className="dp__foot">
        <TimeStepper value={time || nowTime()} onChange={setTime} />
        {variant === "month" && (
          <div className="dp__quick">
            <button type="button" className="dp__quick-btn" onClick={() => pick(toLocalDate(new Date()))}>
              今天
            </button>
            <button type="button" className="dp__quick-btn" onClick={() => pick(dateAfter(1))}>
              明天
            </button>
          </div>
        )}
      </div>
    </div>
  );

  if (inline) {
    return <div className="dp dp--inline">{body}</div>;
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`dp__trigger${open ? " dp__trigger--open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        <span className="dp__trigger-text">
          {date === "" ? "选择时间" : `${humanDay(date)} ${time || nowTime()}`}
        </span>
        <span className="dp__trigger-icon">
          <Chevron dir="down" />
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            className="dp__pop"
            style={{ top: pos.top, left: pos.left, width }}
          >
            {body}
          </div>,
          document.body,
        )}
    </>
  );
}
