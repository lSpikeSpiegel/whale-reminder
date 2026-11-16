//! 混合逻辑时钟（Hybrid Logical Clock）。
//!
//! 同步定序的唯一依据。**不能用 `updated_at` 当版本号**，三个原因：
//!
//! 1. 它是秒级的（`SecondsFormat::Secs`），同一秒内的两次写入排不出先后；
//! 2. 它依赖设备本地时钟，手机慢 3 分钟，这 3 分钟内的修改同步上去会全被判成旧版本；
//! 3. `note::set_pinned` 为了列表顺序稳定**故意不更新它**——拿它当版本号，置顶动作
//!    不产生新版本，对端会直接丢掉这条变更。
//!
//! HLC 把「物理时间」和「逻辑计数」拼在一起，既保留时间的直觉，又能在时钟倒退、
//! 停走、跨设备偏移时保持严格单调。CockroachDB / Cassandra 用的就是这套。
//!
//! ## 格式
//!
//! 定长 27 字符：`<13 位毫秒>-<4 位计数>-<8 位设备>`
//!
//! ```text
//! 1796283456789-0000-a1b2c3d4
//! └── 物理毫秒 ──┘ └计数┘ └设备┘
//! ```
//!
//! **定长 + 补零**让字符串字典序等于时间全序——可以直接 `ORDER BY hlc`、
//! 直接 `>` 比较，不用解析成结构体再比。

use std::fmt;
use std::str::FromStr;

/// 序列化后的固定长度。解析时按这个长度硬校验，
/// 因为「定长」是字典序等于全序的前提。
pub const LEN: usize = 27;

const MS_DIGITS: usize = 13;
const COUNTER_DIGITS: usize = 4;
const DEVICE_DIGITS: usize = 8;

/// 13 位毫秒能表示到 2286 年。超过就截断——真到那天格式要改，
/// 而截断只会让排序退化成「同时刻按 counter 排」，比溢出成 14 位破坏定长好。
const MAX_MS: u64 = 9_999_999_999_999;

/// 计数段能表示的上限（4 位十进制）。撞顶就进位到下一毫秒，
/// 不能回绕——回绕会破坏单调性，而单调性是整个同步协议的地基。
const MAX_COUNTER: u32 = 9_999;

/// 允许对端时钟比本地快多少。
///
/// 超过就判定对方时钟坏了（改过系统时间、虚拟机挂起后没校准、恶意构造），
/// 只借它的 counter 段、不借毫秒——否则一次脏数据能把整台机器的时钟推到几十年后，
/// 之后本地所有写入都会排在别人后面，而且再也追不回来。
const MAX_DRIFT_MS: u64 = 24 * 60 * 60 * 1000;

/// 设备短标识，4 字节 / 8 位小写 hex。
///
/// 一台设备生成一次、存进 `sync_state` 反复使用。8 位 hex 对个人工具
/// （≤5 台设备）的碰撞概率可以忽略；真撞了也只是同一毫秒内的排序不稳定，
/// 不影响正确性。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DeviceId([u8; 4]);

impl DeviceId {
    pub fn new(bytes: [u8; 4]) -> Self {
        Self(bytes)
    }

    /// 从 uuid 取**末尾** 4 字节。
    ///
    /// 不能取开头：uuid v7 的前 8 位是时间戳高位，同一毫秒生成的一批 uuid
    /// 开头完全一样。尾部才是随机段。
    pub fn from_uuid(id: uuid::Uuid) -> Self {
        let bytes = id.as_bytes();
        Self([bytes[12], bytes[13], bytes[14], bytes[15]])
    }

    pub fn parse(raw: &str) -> Result<Self, HlcError> {
        if raw.len() != DEVICE_DIGITS {
            return Err(HlcError::Shape);
        }

        let mut bytes = [0u8; 4];
        for (index, pair) in raw.as_bytes().chunks_exact(2).enumerate() {
            let high = hex_value(pair[0])?;
            let low = hex_value(pair[1])?;
            bytes[index] = high << 4 | low;
        }
        Ok(Self(bytes))
    }
}

impl fmt::Display for DeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:08x}", u32::from_be_bytes(self.0))
    }
}

/// 一个混合逻辑时钟读数。
///
/// 字段顺序（毫秒 → 计数 → 设备）就是比较顺序，所以 `Ord` 直接派生。
/// 设备段参与比较是为了让两台设备在同一毫秒、同一计数上也有确定的全序——
/// 否则「谁赢」取决于到达顺序，两端会收敛到不同结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hlc {
    millis: u64,
    counter: u32,
    device: DeviceId,
}

impl Hlc {
    /// 从零开始。第一次 `tick` 会把毫秒推到当前时间。
    pub fn new(device: DeviceId) -> Self {
        Self {
            millis: 0,
            counter: 0,
            device,
        }
    }

    /// 本地事件，用系统时钟取当前毫秒。
    pub fn tick(&mut self) -> Self {
        self.tick_at(now_millis())
    }

    /// 本地事件，时间由调用方给。
    ///
    /// 拆出 `_at` 版本是为了单测——不用 mock 系统时钟，直接喂时间点。
    pub fn tick_at(&mut self, now_millis: u64) -> Self {
        let now = now_millis.min(MAX_MS);

        if now > self.millis {
            // 时钟正常前进：计数归零，重新开始数同一毫秒内的事件
            self.millis = now;
            self.counter = 0;
        } else {
            // 时钟没走（同一毫秒内第二次写）或者倒退了（NTP 校正、用户改时间、
            // 休眠唤醒）：毫秒不动，靠计数继续递增
            self.bump();
        }
        *self
    }

    /// 收到远端读数，用系统时钟。
    pub fn observe(&mut self, remote: &Hlc) -> Self {
        self.observe_at(remote, now_millis())
    }

    /// 收到远端读数，时间由调用方给。
    ///
    /// 先把自己推到「不早于对方」，再生成新值。这一步是抗时钟偏移的关键：
    /// 慢的机器会被邻居一路拽着往前走，不会永远落后。
    pub fn observe_at(&mut self, remote: &Hlc, now_millis: u64) -> Self {
        let now = now_millis.min(MAX_MS);

        // 对端超前太多 → 只借计数、不借毫秒
        let remote_millis = if remote.millis > now.saturating_add(MAX_DRIFT_MS) {
            now
        } else {
            remote.millis
        };

        if (remote_millis, remote.counter) > (self.millis, self.counter) {
            self.millis = remote_millis;
            // 夹一下：远端可能喂来 `counter = u32::MAX` 的脏值，
            // 直接抄进来会让 Display 输出超过 4 位，定长就废了
            self.counter = remote.counter.min(MAX_COUNTER);
        }

        self.tick_at(now)
    }

    /// 同一毫秒内继续递增。计数撞顶时强行进位到下一毫秒。
    ///
    /// 正常情况下永远撞不到：4 位十进制 = 同一毫秒 9999 次事件。
    /// 但时钟完全停住、或者远端喂来撞顶的计数时，直接 `+1` 在 debug 下会 panic、
    /// release 下会回绕成 0——回绕就破坏了单调性。
    fn bump(&mut self) {
        if self.counter >= MAX_COUNTER {
            self.millis = (self.millis + 1).min(MAX_MS);
            self.counter = 0;
        } else {
            self.counter += 1;
        }
    }

    pub fn millis(&self) -> u64 {
        self.millis
    }

    pub fn counter(&self) -> u32 {
        self.counter
    }

    pub fn device(&self) -> DeviceId {
        self.device
    }

    pub fn parse(raw: &str) -> Result<Self, HlcError> {
        raw.parse()
    }
}

impl fmt::Display for Hlc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // `{:0>width$}` 是「填充 0、右对齐、宽度 width」。
        //
        // 别写成 `{:0width$}`——那样 `0` 被当成填充字符，缺了 align，
        // 数字短于宽度时**不会补零**，定长就废了，字典序跟着废。
        // 超过宽度会原样输出更多位，所以内部状态必须在 `tick_at` 里就夹到 MAX_MS。
        write!(
            f,
            "{:0>ms$}-{:0>ctr$}-{}",
            self.millis,
            self.counter,
            self.device,
            ms = MS_DIGITS,
            ctr = COUNTER_DIGITS
        )
    }
}

impl FromStr for Hlc {
    type Err = HlcError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        let bytes = raw.as_bytes();
        if bytes.len() != LEN {
            return Err(HlcError::Length {
                expected: LEN,
                actual: bytes.len(),
            });
        }

        // 分隔符位置写死：`split('-')` 太宽松，`1-2-3` 也能过，
        // 而那会让字典序彻底失效
        if bytes[MS_DIGITS] != b'-' || bytes[MS_DIGITS + 1 + COUNTER_DIGITS] != b'-' {
            return Err(HlcError::Shape);
        }

        let millis = parse_decimal(&bytes[..MS_DIGITS])?;
        let counter = parse_decimal(&bytes[MS_DIGITS + 1..MS_DIGITS + 1 + COUNTER_DIGITS])?;
        let device = DeviceId::parse(&raw[MS_DIGITS + 1 + COUNTER_DIGITS + 1..])?;

        Ok(Self {
            millis,
            counter: counter as u32,
            device,
        })
    }
}

/// 逐字节解析十进制数字。
///
/// 不用 `str::parse::<u64>()`：它接受前导 `+`、会为超长输入返回溢出错误，
/// 而这里需要的是「这 13 个字节必须全是数字」这个更强的约束。
fn parse_decimal(bytes: &[u8]) -> Result<u64, HlcError> {
    let mut value: u64 = 0;
    for &byte in bytes {
        let digit = hex_value(byte)?;
        if digit > 9 {
            return Err(HlcError::InvalidChar);
        }
        value = value * 10 + u64::from(digit);
    }
    Ok(value)
}

fn hex_value(byte: u8) -> Result<u8, HlcError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        // 大写也收：用户手抄恢复码、别的语言实现可能写大写。
        // 输出统一小写，所以解析是「宽进严出」
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(HlcError::InvalidChar),
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(MAX_MS))
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HlcError {
    #[error("时钟字符串长度应为 {expected}，实际 {actual}")]
    Length { expected: usize, actual: usize },
    #[error("时钟字符串格式不对，应为 <13 位毫秒>-<4 位计数>-<8 位设备>")]
    Shape,
    #[error("时钟字符串里有非法字符")]
    InvalidChar,
}

#[cfg(test)]
mod tests {
    use super::{DeviceId, Hlc, HlcError, LEN};

    fn device(hex: &str) -> DeviceId {
        DeviceId::parse(hex).unwrap()
    }

    fn clock(hex: &str) -> Hlc {
        Hlc::new(device(hex))
    }

    /// 手写一份 27 字符的读数。用 helper 是为了让「长度」这件事只有一处出错的机会。
    fn stamp(millis: &str, counter: &str, device: &str) -> Hlc {
        format!("{millis}-{counter}-{device}").parse().unwrap()
    }

    #[test]
    fn first_tick_takes_the_wall_clock() {
        let mut hlc = clock("a1b2c3d4");
        let stamped = hlc.tick_at(1_700_000_000_000);

        assert_eq!(stamped.millis(), 1_700_000_000_000);
        assert_eq!(stamped.counter(), 0);
    }

    #[test]
    fn repeated_ticks_are_strictly_increasing() {
        let mut hlc = clock("a1b2c3d4");
        let mut last = hlc.tick_at(1_700_000_000_000);

        // 同一毫秒里连打 5000 次：只能靠 counter 拉开
        for _ in 0..5_000 {
            let next = hlc.tick_at(1_700_000_000_000);
            assert!(next > last, "单调性破了：{last} -> {next}");
            last = next;
        }
        assert_eq!(last.counter(), 5_000);
    }

    #[test]
    fn counter_carries_into_next_millisecond_instead_of_wrapping() {
        let mut hlc = clock("a1b2c3d4");
        hlc.tick_at(1_700_000_000_000);
        for _ in 0..9_999 {
            hlc.tick_at(1_700_000_000_000);
        }
        assert_eq!(hlc.counter(), 9_999);

        let carried = hlc.tick_at(1_700_000_000_000);

        // 进位到下一毫秒，而不是回绕成 0
        assert_eq!(carried.millis(), 1_700_000_000_001);
        assert_eq!(carried.counter(), 0);
    }

    #[test]
    fn clock_going_backwards_keeps_millis_and_bumps_counter() {
        let mut hlc = clock("a1b2c3d4");
        hlc.tick_at(1_700_000_000_000);

        // 用户把系统时间调回去 3 分钟
        let stamped = hlc.tick_at(1_699_999_820_000);

        assert_eq!(stamped.millis(), 1_700_000_000_000);
        assert_eq!(stamped.counter(), 1);
    }

    #[test]
    fn clock_moving_forward_resets_counter() {
        let mut hlc = clock("a1b2c3d4");
        hlc.tick_at(1_700_000_000_000);
        hlc.tick_at(1_700_000_000_000);
        assert_eq!(hlc.counter(), 1);

        let stamped = hlc.tick_at(1_700_000_000_500);

        assert_eq!(stamped.millis(), 1_700_000_000_500);
        assert_eq!(stamped.counter(), 0);
    }

    #[test]
    fn observing_a_newer_clock_pulls_us_forward() {
        let mut local = clock("00000001");
        local.tick_at(1_700_000_000_000);

        let mut remote_clock = clock("00000002");
        let remote = remote_clock.tick_at(1_700_000_005_000);

        let stamped = local.observe_at(&remote, 1_700_000_006_000);

        // 被拽到远端之后，而不是停在原地
        assert!(stamped > remote);
        assert_eq!(stamped.millis(), 1_700_000_006_000);
    }

    #[test]
    fn observing_an_older_clock_changes_nothing_but_still_advances() {
        let mut local = clock("00000001");
        local.tick_at(1_700_000_000_000);
        let before = local;

        let mut stale_clock = clock("00000002");
        let stale = stale_clock.tick_at(1_600_000_000_000);

        let stamped = local.observe_at(&stale, 1_700_000_000_000);

        assert_eq!(stamped.millis(), before.millis());
        assert!(stamped.counter() > before.counter());
    }

    #[test]
    fn a_clock_ten_years_ahead_cannot_poison_us() {
        let mut local = clock("00000001");
        local.tick_at(1_700_000_000_000);

        // 对端系统时间被设到了 2033 年
        let broken = stamp("2000000000000", "0000", "00000002");

        let stamped = local.observe_at(&broken, 1_700_000_000_000);

        // 毫秒没被污染，还在自己该在的地方
        assert_eq!(stamped.millis(), 1_700_000_000_000);
        // 但确实前进了（借了 counter 段）
        assert!(stamped.counter() > 0);
    }

    #[test]
    fn a_poisoned_counter_cannot_break_monotonicity() {
        let mut local = clock("00000001");
        local.tick_at(1_700_000_000_000);

        // 合法字符串、但计数撞顶的脏读数
        let poisoned = stamp("1700000000000", "9999", "00000002");

        let first = local.observe_at(&poisoned, 1_700_000_000_000);
        let second = local.tick_at(1_700_000_000_000);

        assert!(second > first);
        assert!(first.counter() <= 9_999);
        // 序列化仍然是定长
        assert_eq!(first.to_string().len(), LEN);
    }

    #[test]
    fn serialized_form_is_fixed_length() {
        let mut hlc = clock("a1b2c3d4");
        hlc.tick_at(1_700_000_000_000);

        let text = hlc.to_string();

        assert_eq!(text.len(), LEN);
        assert_eq!(text, "1700000000000-0000-a1b2c3d4");
    }

    #[test]
    fn small_millis_are_zero_padded() {
        let mut hlc = clock("a1b2c3d4");
        hlc.tick_at(42);

        assert_eq!(hlc.to_string(), "0000000000042-0000-a1b2c3d4");
        assert_eq!(hlc.to_string().len(), LEN);
    }

    #[test]
    fn padding_keeps_shorter_millis_sorting_correctly() {
        // 不补零的话 "999" > "1000"（字符串比较），排序会直接反掉
        let mut early = clock("a1b2c3d4");
        let mut later = clock("a1b2c3d4");
        let a = early.tick_at(999);
        let b = later.tick_at(1_000);

        assert!(a < b);
        assert!(a.to_string() < b.to_string());
    }

    #[test]
    fn round_trip_through_text() {
        let mut hlc = clock("deadbeef");
        for _ in 0..3 {
            hlc.tick_at(1_700_000_000_123);
        }

        let back: Hlc = hlc.to_string().parse().unwrap();

        assert_eq!(back, hlc);
        assert_eq!(back.to_string(), hlc.to_string());
    }

    #[test]
    fn text_order_equals_structural_order() {
        // 定长补零的全部意义就在这里：字符串比较和结构比较必须给出同一结果
        let cases = [
            "1700000000000-0000-00000001",
            "1700000000000-0000-00000002",
            "1700000000000-0001-00000001",
            "1700000000000-9999-00000000",
            "1700000000001-0000-00000000",
            "9999999999999-0000-ffffffff",
        ];
        let parsed: Vec<Hlc> = cases.iter().map(|raw| raw.parse().unwrap()).collect();

        for left in 0..parsed.len() {
            for right in 0..parsed.len() {
                assert_eq!(
                    parsed[left].cmp(&parsed[right]),
                    cases[left].cmp(cases[right]),
                    "{} vs {}",
                    cases[left],
                    cases[right]
                );
            }
        }
    }

    #[test]
    fn same_instant_is_broken_by_device_id() {
        // 两台设备同一毫秒、同一计数：必须有个确定的先后，
        // 否则两端各自「本地赢」，永远收敛不到一起
        let a = stamp("1700000000000", "0000", "00000001");
        let b = stamp("1700000000000", "0000", "00000002");

        assert!(a < b);
        assert_eq!(a.to_string().cmp(&b.to_string()), std::cmp::Ordering::Less);
    }

    #[test]
    fn device_id_comes_from_the_random_tail_of_a_uuid() {
        // v7 的前 8 位是时间戳高位，同一毫秒生成的一批 uuid 完全一样，不能拿来当设备号
        let first = DeviceId::from_uuid(uuid::Uuid::now_v7());
        let second = DeviceId::from_uuid(uuid::Uuid::now_v7());

        assert_ne!(first, second);
    }

    #[test]
    fn parsing_is_strict_about_shape() {
        let bad = [
            "",
            "1700000000000-0000",                  // 太短
            "1700000000000-0000-00000001x",        // 太长
            "170000000000-0000-00000001",          // 毫秒只有 12 位
            "1700000000000:0000:00000001",         // 分隔符不对
            "1700000000000-0000-0000000g",         // 设备段有非法字符
            "170000000000x-0000-00000001",         // 毫秒段有非法字符
            "1700000000000-00a0-00000001",         // 计数段有非法字符
        ];

        for raw in bad {
            assert!(raw.parse::<Hlc>().is_err(), "这条不该解析成功：{raw:?}");
        }
    }

    #[test]
    fn parsing_reports_why_it_failed() {
        assert!(matches!("abc".parse::<Hlc>(), Err(HlcError::Length { .. })));
        assert!(matches!(
            "170000000000x-0000-00000001".parse::<Hlc>(),
            Err(HlcError::InvalidChar)
        ));
        assert!(matches!(
            "1700000000000:0000:00000001".parse::<Hlc>(),
            Err(HlcError::Shape)
        ));
    }

    #[test]
    fn uppercase_hex_is_accepted_and_normalized() {
        let upper: Hlc = "1700000000000-0000-A1B2C3D4".parse().unwrap();

        assert_eq!(upper.device(), device("a1b2c3d4"));
        assert_eq!(upper.to_string(), "1700000000000-0000-a1b2c3d4");
    }

    #[test]
    fn millis_are_capped_so_the_text_stays_fixed_width() {
        let mut hlc = clock("a1b2c3d4");
        hlc.tick_at(u64::MAX);

        assert_eq!(hlc.millis(), 9_999_999_999_999);
        assert_eq!(hlc.to_string().len(), LEN);
    }
}
