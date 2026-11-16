//! 循环提醒的规则定义与「下一次该在什么时候响」的推算。
//!
//! 时间语义：用户选的是**本地时间**（「每天 09:00」就是本地 9 点），
//! 而库里一律存 UTC，所以这里用 `chrono::Local` 推算，最后再转成 UTC 存库。
//!
//! 节假日用的是硬编码的国务院放假安排。这是有意为之：法定节假日每年才公布一次，
//! 引入日历库或联网接口属于杀鸡用牛刀，代价是**每年要补一次数据**（见 [`HOLIDAY_RANGES`]）。

use std::collections::HashSet;
use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveTime, Utc, Weekday};
use serde::{Deserialize, Serialize};

/// 存进 `reminder.rule` 的 JSON 规则。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RecurRule {
    /// 一次性，`next_fire_at` 响过就结束
    Once,
    Daily {
        time: String,
    },
    /// `days` 用 0=周日 … 6=周六（与 JS `getDay()` 对齐）
    Weekly {
        days: Vec<u32>,
        time: String,
    },
    /// 工作日：周一至周五，跳过法定节假日，法定调休上班日算工作日
    Workday {
        time: String,
    },
    /// 只在法定节假日当天
    Holiday {
        time: String,
    },
}

impl Default for RecurRule {
    fn default() -> Self {
        RecurRule::Once
    }
}

impl RecurRule {
    pub fn from_json(raw: &str) -> Self {
        serde_json::from_str(raw).unwrap_or(RecurRule::Once)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| r#"{"type":"once"}"#.into())
    }

    pub fn is_recurring(&self) -> bool {
        !matches!(self, RecurRule::Once)
    }

    /// 严格晚于 `after` 的下一次触发时刻（UTC）。推算不出来（比如每周但一天都没选）返回 None。
    pub fn next_after(&self, after: DateTime<Local>) -> Option<DateTime<Utc>> {
        match self {
            RecurRule::Once => None,
            RecurRule::Daily { time } => {
                let at = parse_hhmm(time)?;
                (0..=1).find_map(|d| at_local(after.date_naive() + Duration::days(d), at, after))
            }
            RecurRule::Weekly { days, time } => {
                let at = parse_hhmm(time)?;
                if days.is_empty() {
                    return None;
                }
                (0..=7).find_map(|d| {
                    let date = after.date_naive() + Duration::days(d);
                    if days.contains(&date.weekday().num_days_from_sunday()) {
                        at_local(date, at, after)
                    } else {
                        None
                    }
                })
            }
            RecurRule::Workday { time } => {
                let at = parse_hhmm(time)?;
                (0..=400).find_map(|d| {
                    let date = after.date_naive() + Duration::days(d);
                    if is_workday(date) {
                        at_local(date, at, after)
                    } else {
                        None
                    }
                })
            }
            RecurRule::Holiday { time } => {
                let at = parse_hhmm(time)?;
                (0..=400).find_map(|d| {
                    let date = after.date_naive() + Duration::days(d);
                    if is_holiday(date) {
                        at_local(date, at, after)
                    } else {
                        None
                    }
                })
            }
        }
    }
}

fn parse_hhmm(raw: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(raw.trim(), "%H:%M").ok()
}

fn at_local(date: NaiveDate, time: NaiveTime, after: DateTime<Local>) -> Option<DateTime<Utc>> {
    let value = date.and_time(time).and_local_timezone(Local).earliest()?;
    (value > after).then(|| value.with_timezone(&Utc))
}

// ---- 中国法定节假日 ----

/// 放假区间（闭区间）。目前只有 2026 年，见文件头注释。
const HOLIDAY_RANGES: &[(i32, &str, &str)] = &[
    (2026, "2026-01-01", "2026-01-03"), // 元旦
    (2026, "2026-02-15", "2026-02-23"), // 春节（9 天）
    (2026, "2026-04-04", "2026-04-06"), // 清明
    (2026, "2026-05-01", "2026-05-05"), // 劳动节
    (2026, "2026-06-19", "2026-06-21"), // 端午
    (2026, "2026-09-25", "2026-09-27"), // 中秋
    (2026, "2026-10-01", "2026-10-07"), // 国庆
];

/// 调休上班日（周末但要上班）。
const MAKEUP_WORKDAYS: &[&str] = &[
    "2026-01-04",
    "2026-02-14",
    "2026-02-28",
    "2026-05-09",
    "2026-09-20",
    "2026-10-10",
];

fn holiday_set() -> &'static HashSet<NaiveDate> {
    static SET: OnceLock<HashSet<NaiveDate>> = OnceLock::new();
    SET.get_or_init(|| {
        let mut set = HashSet::new();
        for (_, start, end) in HOLIDAY_RANGES {
            let Ok(from) = NaiveDate::parse_from_str(start, "%Y-%m-%d") else {
                continue;
            };
            let Ok(to) = NaiveDate::parse_from_str(end, "%Y-%m-%d") else {
                continue;
            };
            let mut day = from;
            while day <= to {
                set.insert(day);
                day += Duration::days(1);
            }
        }
        set
    })
}

fn makeup_set() -> &'static HashSet<NaiveDate> {
    static SET: OnceLock<HashSet<NaiveDate>> = OnceLock::new();
    SET.get_or_init(|| {
        MAKEUP_WORKDAYS
            .iter()
            .filter_map(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .collect()
    })
}

/// 这一年有没有录入放假安排。没录入的年份只能退化成「周末即休息」。
fn has_calendar(year: i32) -> bool {
    HOLIDAY_RANGES.iter().any(|(y, _, _)| *y == year)
}

fn is_weekend(date: NaiveDate) -> bool {
    matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
}

/// 法定节假日当天（含调休连休里的周末）。
pub fn is_holiday(date: NaiveDate) -> bool {
    if has_calendar(date.year()) {
        holiday_set().contains(&date)
    } else {
        is_weekend(date)
    }
}

/// 工作日：调休上班日算工作日；放假区间内的任何一天都不算。
pub fn is_workday(date: NaiveDate) -> bool {
    if has_calendar(date.year()) {
        makeup_set().contains(&date) || (!holiday_set().contains(&date) && !is_weekend(date))
    } else {
        !is_weekend(date)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn local(s: &str) -> DateTime<Local> {
        NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
            .and_local_timezone(Local)
            .earliest()
            .unwrap()
    }

    #[test]
    fn holiday_calendar_matches_notice() {
        assert!(is_holiday(date("2026-02-15")), "春节首日");
        assert!(is_holiday(date("2026-02-23")), "春节末日");
        assert!(!is_holiday(date("2026-02-24")));
        assert!(is_holiday(date("2026-10-07")), "国庆末日");
        assert!(!is_holiday(date("2026-03-07")), "普通周六不算法定节假日");
    }

    #[test]
    fn workday_skips_holidays_and_respects_makeup() {
        assert!(!is_workday(date("2026-02-17")), "春节假期内的周二不上班");
        assert!(is_workday(date("2026-02-28")), "调休的周六要上班");
        assert!(!is_workday(date("2026-03-07")), "普通周六");
        assert!(is_workday(date("2026-03-06")), "普通周五");
    }

    #[test]
    fn daily_rolls_to_tomorrow_after_time_passed() {
        // 12:00 之后找「每天 09:00」→ 应该是明天 09:00
        let rule = RecurRule::Daily {
            time: "09:00".into(),
        };
        let next = rule.next_after(local("2026-03-06")).unwrap();
        let next_local = next.with_timezone(&Local);
        assert_eq!(next_local.date_naive(), date("2026-03-07"));
        assert_eq!(next_local.format("%H:%M").to_string(), "09:00");
    }

    #[test]
    fn weekly_picks_selected_weekdays() {
        // 2026-03-06 是周五，选周日+周一 → 下一次是 03-08 周日
        let rule = RecurRule::Weekly {
            days: vec![0, 1],
            time: "09:00".into(),
        };
        let next = rule.next_after(local("2026-03-06")).unwrap();
        let next_local = next.with_timezone(&Local);
        assert_eq!(next_local.date_naive(), date("2026-03-08"));
        assert_eq!(next_local.weekday(), Weekday::Sun);
    }

    #[test]
    fn weekly_without_days_is_none() {
        let rule = RecurRule::Weekly {
            days: vec![],
            time: "09:00".into(),
        };
        assert!(rule.next_after(local("2026-03-06")).is_none());
    }

    #[test]
    fn workday_rule_jumps_over_spring_festival() {
        let rule = RecurRule::Workday {
            time: "09:00".into(),
        };

        // 2026-02-13 是周五。次日 2/14 虽是周六，但属于春节调休上班日，算工作日
        let next = rule.next_after(local("2026-02-13")).unwrap();
        assert_eq!(next.with_timezone(&Local).date_naive(), date("2026-02-14"));

        // 从调休那天中午往后找：整个春节假期（2/15–2/23）都要跳过，落在 2/24 周二
        let next = rule.next_after(local("2026-02-14")).unwrap();
        assert_eq!(next.with_timezone(&Local).date_naive(), date("2026-02-24"));
    }

    #[test]
    fn holiday_rule_waits_for_next_holiday() {
        // 2026-03-06 之后最近的法定节假日是清明 4/4
        let rule = RecurRule::Holiday {
            time: "09:00".into(),
        };
        let next = rule.next_after(local("2026-03-06")).unwrap();
        assert_eq!(next.with_timezone(&Local).date_naive(), date("2026-04-04"));
    }

    #[test]
    fn rule_json_roundtrip() {
        let rule = RecurRule::Weekly {
            days: vec![1, 3],
            time: "08:30".into(),
        };
        let raw = rule.to_json();
        assert_eq!(RecurRule::from_json(&raw), rule);
        assert_eq!(RecurRule::from_json("坏数据"), RecurRule::Once);
    }
}
