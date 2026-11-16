/** 日期时间的小工具。面板和气泡共用，避免两边各写一套导致格式不一致。 */

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** 解析兜底用的时刻。界面上的默认值一律取当前时间（`nowTime`），不要用这个常量。 */
export const DEFAULT_TIME = "09:00";

/** 当前时刻 `HH:mm`。时分选择的默认值统一从这里来 */
export function nowTime(): string {
  return toLocalTime(new Date());
}

/** 日历表头。周一开头，和国内日历习惯一致 */
export const WEEK_HEAD = ["一", "二", "三", "四", "五", "六", "日"];

/** 星期几的中文单字，0=周日 */
export const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** Date → `YYYY-MM-DD` */
export function toLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Date → `HH:mm` */
export function toLocalTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** `YYYY-MM-DD` + `HH:mm` → 本地 Date。缺时刻按 09:00 补 */
export function parseLocal(date: string, time: string): Date | null {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  const [hh, mm] = (time || DEFAULT_TIME).split(":").map(Number);
  const value = new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
  return Number.isNaN(value.getTime()) ? null : value;
}

/**
 * 日期 + 时刻 → 后端要的 RFC3339（UTC）。
 * 只填了日期就补默认时刻，日期为空则视为没设。
 */
export function toIso(date: string, time: string): string | null {
  const value = parseLocal(date, time);
  return value === null ? null : value.toISOString();
}

/**
 * hours 小时之后，日期和时刻都以「此刻」为基准。
 *
 * 不把分钟归整到 :00 / :30——那样默认值看着像随便挑的，
 * 而且和用户当下的时间对不上。秒归零就够了。
 */
export function defaultSlot(hours: number): { date: string; time: string } {
  const value = new Date(Date.now() + hours * 3600_000);
  value.setSeconds(0, 0);
  return { date: toLocalDate(value), time: toLocalTime(value) };
}

/** 现在之后 N 分钟，秒归零 */
export function inMinutes(minutes: number): Date {
  const value = new Date(Date.now() + minutes * 60_000);
  value.setSeconds(0, 0);
  return value;
}

/**
 * 今天 / 明天（dayOffset）的某个整点。
 *
 * 已经过去就返回 null，界面干脆不显示这个选项——后端建提醒、`reschedule_reminder`
 * 都会拒绝过去的时间，摆出来点了只会看到一行报错。
 */
export function clockAt(dayOffset: number, hour: number): Date | null {
  const value = new Date();
  value.setDate(value.getDate() + dayOffset);
  value.setHours(hour, 0, 0, 0);
  return value.getTime() > Date.now() ? value : null;
}

export interface QuickTime {
  label: string;
  at: Date;
}

/**
 * 快捷时刻，气泡和面板共用同一套。
 *
 * 开始提醒往早上挪（今早 / 明早 9 点），结束提醒往傍晚挪（今晚 / 明晚 5 点）：
 * 一条「早上开始、傍晚结束」的任务，这两种默认值最贴近用户心里的那个点。
 *
 * 过去的整点不返回，所以上午 11 点只剩「1 小时后 / 明早 9 点」两颗。
 */
export function quickTimes(phase: "start" | "due"): QuickTime[] {
  const slots =
    phase === "start"
      ? [
          { label: "1 小时后", at: inMinutes(60) },
          { label: "今早 9 点", at: clockAt(0, 9) },
          { label: "明早 9 点", at: clockAt(1, 9) },
        ]
      : [
          { label: "1 小时后", at: inMinutes(60) },
          { label: "今晚 5 点", at: clockAt(0, 17) },
          { label: "明晚 5 点", at: clockAt(1, 17) },
        ];

  return slots.filter((slot): slot is QuickTime => slot.at !== null);
}

/** 距今差几天（按自然日算，不是按 24 小时） */
export function dayDelta(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** 时刻，带上「今天 / 明天」这类相对说法 */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = toLocalTime(date);
  const delta = dayDelta(new Date(), date);
  if (delta === 0) return `今天 ${time}`;
  if (delta === 1) return `明天 ${time}`;
  if (delta === 2) return `后天 ${time}`;
  if (delta === -1) return `昨天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** `YYYY-MM-DD` 的相对说法，不带时刻 */
export function humanDay(date: string): string {
  const value = parseLocal(date, "00:00");
  if (value === null) return "";
  const delta = dayDelta(new Date(), value);
  if (delta === 0) return "今天";
  if (delta === 1) return "明天";
  if (delta === 2) return "后天";
  if (delta === -1) return "昨天";
  if (value.getFullYear() !== new Date().getFullYear()) {
    return `${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日`;
  }
  return `${value.getMonth() + 1}月${value.getDate()}日`;
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 月历网格：固定 6 行 × 7 列（周一起），保证切换月份时高度不跳。
 * 不在当月的格子返回 null，渲染成空位。
 */
export function monthGrid(year: number, month: number): (Date | null)[][] {
  const first = new Date(year, month, 1);
  // getDay(): 0=周日。换算成「周一为 0」的偏移
  const offset = (first.getDay() + 6) % 7;
  const rows: (Date | null)[][] = [];
  let day = 1 - offset;

  for (let r = 0; r < 6; r += 1) {
    const row: (Date | null)[] = [];
    for (let c = 0; c < 7; c += 1) {
      const value = new Date(year, month, day);
      row.push(value.getMonth() === month ? value : null);
      day += 1;
    }
    rows.push(row);
  }
  return rows;
}

/** 往后推 n 天，返回 `YYYY-MM-DD` */
export function dateAfter(days: number): string {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return toLocalDate(value);
}

/** 把 `HH:mm` 加上 minutes 分钟，返回新的 `HH:mm`（跨天只回绕时分，不关心日期） */
export function shiftTime(time: string, minutes: number): string {
  const [hh, mm] = (time || nowTime()).split(":").map(Number);
  const total = ((hh || 0) * 60 + (mm || 0) + minutes + 1440 * 2) % 1440;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}
