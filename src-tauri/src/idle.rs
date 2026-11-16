//! 系统级闲置时长：用户多久没碰键盘鼠标。
//!
//! 桌宠的「打盹」按这个算，而不是按「多久没点我」——用户在写代码时她该安静待着，
//! 而不是自顾自地睡过去；反过来人真的离开了，几分钟就该睡着。
//!
//! 非 Windows 平台返回 0（等于「一直在用」），前端会退回到按桌宠自己的空闲计时。

/// `GetTickCount` 是 32 位、49.7 天回绕一次。直接相减会把「刚动过」算成
/// 「49 天没动过」，桌宠立刻睡死——所以必须用 wrapping_sub。
pub fn elapsed_ms(now: u32, last: u32) -> u64 {
    now.wrapping_sub(last) as u64
}

#[cfg(windows)]
mod imp {
    use std::mem::MaybeUninit;

    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }

    unsafe extern "system" {
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
        fn GetTickCount() -> u32;
    }

    /// 距上一次键鼠输入过了多少毫秒。取不到就返回 0。
    pub fn idle_ms() -> u64 {
        let info = MaybeUninit::<LastInputInfo>::zeroed();
        unsafe {
            let mut info = info.assume_init();
            info.cb_size = std::mem::size_of::<LastInputInfo>() as u32;
            if GetLastInputInfo(&mut info) == 0 {
                return 0;
            }
            super::elapsed_ms(GetTickCount(), info.dw_time)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn idle_ms() -> u64 {
        0
    }
}

/// 用户已经多久没碰键鼠（秒）。
pub fn idle_seconds() -> u64 {
    imp::idle_ms() / 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_elapsed_ticks() {
        assert_eq!(elapsed_ms(5_000, 2_000), 3_000);
        assert_eq!(elapsed_ms(2_000, 2_000), 0);
    }

    #[test]
    fn tick_wraparound_does_not_look_like_a_month() {
        // 回绕点前后：now 比 last 小，但实际只过了 16ms
        assert_eq!(elapsed_ms(10, u32::MAX - 5), 16);
    }

    #[test]
    fn idle_seconds_is_reachable() {
        // 只是确认这层封装没把单位算错：拿不到真实输入时应当是 0 或一个合理的秒数
        assert!(idle_seconds() < 60 * 60 * 24 * 30);
    }
}
