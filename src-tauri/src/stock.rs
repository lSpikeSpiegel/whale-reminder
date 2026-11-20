//! 行情工具：搜标的、自选清单、批量报价、K 线。
//!
//! 数据来自东方财富网页版在用的三个公开接口，都是 HTTPS + JSON：
//!
//! - `searchapi.eastmoney.com/api/suggest/get`：按代码 / 名称 / 拼音搜，回一个
//!   `QuoteID`（形如 `1.600519`，市场号 + 代码），报价接口直接认这个键；
//! - `push2.eastmoney.com/api/qt/ulist.np/get`：一次问一批标的的现价、涨跌额、涨跌幅；
//! - `push2his.eastmoney.com/api/qt/stock/kline/get`：历史 K 线（分钟 / 日 / 周 / 月）。
//!
//! **取数放在 Rust 而不是前端 `fetch`**：WebView2 里跨域要对方给 CORS 头，这些
//! 接口都不给，前端硬发会卡在预检上——而且失败信息只有一句 `TypeError: Failed to fetch`，
//! 比后端拿到的错误难查得多。
//!
//! 自选只存「买了什么」这件事（市场号 + 代码 + 名字），价格每次现问，不落盘：
//! 昨天的收盘价留在本地只会误导人。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 搜索接口。`token` 是网页版里写死的一个常量，不是用户凭据。
const SUGGEST_URL: &str = "https://searchapi.eastmoney.com/api/suggest/get";
const SUGGEST_TOKEN: &str = "D43BF722C8E33BDC906FB84D85E326E8";
/// 批量报价。`fltt=2` 让价格直接是小数——默认（`fltt=1`）给的是乘过 100 的整数，
/// 前端少做一层换算就少一处「小数点错位」的 bug。
const QUOTE_URL: &str = "https://push2.eastmoney.com/api/qt/ulist.np/get";
/// f1 小数位 / f2 现价 / f3 涨跌幅 / f4 涨跌额 / f12 代码 / f13 市场号 / f14 名称 / f18 昨收
const QUOTE_FIELDS: &str = "f1,f2,f3,f4,f12,f13,f14,f18";

/// 历史 K 线。
///
/// **必须只传 `end` + `lmt`，绝对不要传 `beg=0`**：`beg=0` 的意思是「从最早一根开始」，
/// 那会返回 2001 年的前复权数据——而前复权 = 原价 − 累计分红，茅台这种老股算出来是
/// **负数**（实测 `preKPrice: -313.3`）。东方财富的网页端也是靠 `lmt` 直接取末尾 N 根。
/// 只传 `lmt` 不给 `end` 的话接口回 `data: null`，两个都得有。
const KLINE_URL: &str = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const KLINE_FIELDS1: &str = "f1,f2,f3,f4,f5,f6";
/// f51 时间 / f52 开 / f53 收 / f54 高 / f55 低 / f56 成交量（手）/ f57 成交额（元）
const KLINE_FIELDS2: &str = "f51,f52,f53,f54,f55,f56,f57";
/// K 线永远问到这个日期为止（接口要求），实际根数由 `lmt` 决定
const KLINE_END: &str = "20500101";

/// 自选上限。面板再能滚，一屏之外的自选也没人看，还拖慢每次刷新。
const WATCH_LIMIT: usize = 50;
/// 一次最多问多少只。大盘 3 个指数 + 50 只自选才 53，留到 100 是给未来留余量。
const QUOTE_LIMIT: usize = 100;

/// 一个标的。搜索结果和自选条目是同一份数据——搜到就原样存进自选，
/// 免得两张结构之间来回转，字段对不上时又是静默丢数据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StockItem {
    /// 数据源自己的标的编号，形如 `1.600519`（1 = 沪、0 = 深、116 = 港股、105 = 美股）。
    /// 报价接口原样收，所以自选里存的也是它，不自己拼。
    pub secid: String,
    pub code: String,
    pub name: String,
    /// 市场标签（沪A / 深A / 港股 / 美股 / 基金…），清单里当小字。
    /// 早先版本写下的自选没有这个字段，缺了就当空串，别让整份文件读不出来。
    #[serde(default)]
    pub market: String,
}

/// 一条报价。停牌 / 未开盘的标的，接口回的是 `"-"` 而不是数字，
/// 所以价格这几个字段都可以是 `None`——前端显示成「—」，别显示成 0。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StockQuote {
    pub secid: String,
    pub code: String,
    pub name: String,
    pub price: Option<f64>,
    pub change: Option<f64>,
    pub percent: Option<f64>,
    pub prev_close: Option<f64>,
    /// 价格的小数位（接口的 f1）。个股和指数都是 2，债券会有 3，照它格式化不会错位。
    pub digits: u8,
}

/// 一根 K 线。分钟线的时间带时分（`2026-11-20 09:31`），日线以上只有日期。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Bar {
    pub time: String,
    pub open: f64,
    pub close: f64,
    pub high: f64,
    pub low: f64,
    /// 成交量，单位「手」（1 手 = 100 股）。均价换算要用到
    pub volume: f64,
    /// 成交额，单位「元」。分时图的均价线 = 累计成交额 / 累计成交量
    pub amount: f64,
}

/// 一张图的数据。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Chart {
    pub bars: Vec<Bar>,
    /// 昨收。只有分时图用得上（那是 0% 基准线），K 线不看它
    pub prev_close: Option<f64>,
    /// 价格小数位（接口的 `decimal`），坐标轴和读数都按它格式化
    pub digits: u8,
}

fn watch_path() -> PathBuf {
    crate::db::data_dir().join("stock_watch.json")
}

/// 读不出来就当没自选：文件缺失、被改坏、字段对不上，都不该让工具页打不开。
fn load_from(path: &Path) -> Vec<StockItem> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_to(path: &Path, list: &[StockItem]) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(list)
        .map_err(|err| AppError::Other(format!("自选清单编码失败：{err}")))?;
    crate::fsutil::write_atomic(path, &bytes)
}

/// 加一只。已经在里头就返回 `false`（幂等，不报错）——用户重复点「＋」
/// 不该看到红色提示，他只是没注意到列表里已经有这一行了。
///
/// 抽成纯函数是为了单测：去重、上限这两件事跟文件读写无关。
fn push(list: &mut Vec<StockItem>, item: StockItem) -> AppResult<bool> {
    if list.iter().any(|it| it.secid == item.secid) {
        return Ok(false);
    }
    if list.len() >= WATCH_LIMIT {
        return Err(AppError::Invalid(format!(
            "自选最多 {WATCH_LIMIT} 只，先删几个吧"
        )));
    }
    list.push(item);
    Ok(true)
}

/// 删一只，返回有没有真的删掉。找不到不算错：列表是后端状态，前端看到的
/// 可能已经过期（比如两个面板同时开着）。
fn remove(list: &mut Vec<StockItem>, secid: &str) -> bool {
    let before = list.len();
    list.retain(|it| it.secid != secid);
    list.len() != before
}

/// 接口取不到数的字段一律当成「没有」。`f2: "-"`（停牌）如果被读成 0，
/// 界面上会显示「平盘」，那是错的信息，比空着更糟。
fn amount(value: Option<&serde_json::Value>) -> Option<f64> {
    match value? {
        serde_json::Value::Number(number) => number.as_f64(),
        _ => None,
    }
}

/// 解析搜索接口。没有 `Data` 字段就是「一条都没搜到」，不是错误。
fn parse_suggest(body: &str) -> AppResult<Vec<StockItem>> {
    let root: serde_json::Value = serde_json::from_str(body)
        .map_err(|err| AppError::Other(format!("搜索结果解析失败：{err}")))?;

    let Some(items) = root.pointer("/QuotationCodeTable/Data").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let text = |key: &str| item.get(key).and_then(|v| v.as_str()).unwrap_or_default();
        let secid = text("QuoteID");
        let code = text("Code");
        // 没有 QuoteID 的条目点不出报价（比如某些「相关概念」入口），直接跳过
        if secid.is_empty() || code.is_empty() {
            continue;
        }
        out.push(StockItem {
            secid: secid.to_owned(),
            code: code.to_owned(),
            name: text("Name").to_owned(),
            market: text("SecurityTypeName").to_owned(),
        });
    }
    Ok(out)
}

/// 解析批量报价。`data` 为 `null`（键不合法）时同样返回空表。
fn parse_quotes(body: &str) -> AppResult<Vec<StockQuote>> {
    let root: serde_json::Value = serde_json::from_str(body)
        .map_err(|err| AppError::Other(format!("行情解析失败：{err}")))?;

    let Some(items) = root.pointer("/data/diff").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let text = |key: &str| item.get(key).and_then(|v| v.as_str()).unwrap_or_default();
        let code = text("f12");
        if code.is_empty() {
            continue;
        }
        // 市场号缺失时按 0（深市）填：宁可点开一只错的市场，也别整条消失——
        // 前端拿 secid 去配自选，配不上会显示成「没有报价」，更难查
        let market = item.get("f13").and_then(|v| v.as_i64()).unwrap_or_default();
        let digits = item
            .get("f1")
            .and_then(|v| v.as_u64())
            .unwrap_or(2)
            .min(4) as u8;

        out.push(StockQuote {
            secid: format!("{market}.{code}"),
            code: code.to_owned(),
            name: text("f14").to_owned(),
            price: amount(item.get("f2")),
            change: amount(item.get("f4")),
            percent: amount(item.get("f3")),
            prev_close: amount(item.get("f18")),
            digits,
        });
    }
    Ok(out)
}

/// 查询用的 HTTP 客户端。全程只建一次：连接池和 TLS 会话复用能省掉
/// 每次刷新上百毫秒的握手。
///
/// 超时给 8 秒——行情接口平时 100ms 内就回，等到 8 秒说明网络已经不行了，
/// 再等只会让「点了刷新没反应」拖得更久。
fn client() -> AppResult<&'static reqwest::Client> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }

    let built = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        // 接口会挑 UA，光秃秃的 reqwest 有可能被挡；带上名字也方便对方识别来源
        .user_agent("whale-reminder/stock (+desktop pet)")
        .build()
        .map_err(|err| AppError::Other(format!("HTTP 客户端初始化失败：{err}")))?;

    Ok(CLIENT.get_or_init(|| built))
}

/// 搜一次。抽出来是为了单测能直接打真接口（命令的返回类型要过 Tauri，测起来绕）。
async fn fetch_suggest(keyword: &str) -> AppResult<Vec<StockItem>> {
    let response = client()?
        .get(SUGGEST_URL)
        .query(&[
            ("input", keyword),
            ("type", "14"),
            ("count", "12"),
            ("token", SUGGEST_TOKEN),
        ])
        .send()
        .await
        .map_err(|err| AppError::Other(format!("连不上行情服务器：{err}")))?;

    let body = response
        .text()
        .await
        .map_err(|err| AppError::Other(format!("搜索结果读不出来：{err}")))?;

    parse_suggest(&body)
}

/// 问一次报价。secid 在这里去重、截断，接口本身也不喜欢太长的串。
async fn fetch_quotes(secids: Vec<String>) -> AppResult<Vec<StockQuote>> {
    let mut seen = HashSet::new();
    let list: Vec<String> = secids
        .into_iter()
        .map(|secid| secid.trim().to_owned())
        .filter(|secid| !secid.is_empty() && seen.insert(secid.clone()))
        .take(QUOTE_LIMIT)
        .collect();

    if list.is_empty() {
        return Ok(Vec::new());
    }

    let response = client()?
        .get(QUOTE_URL)
        .query(&[
            ("fltt", "2"),
            ("secids", &list.join(",")),
            ("fields", QUOTE_FIELDS),
        ])
        .send()
        .await
        .map_err(|err| AppError::Other(format!("连不上行情服务器：{err}")))?;

    let body = response
        .text()
        .await
        .map_err(|err| AppError::Other(format!("行情读不出来：{err}")))?;

    parse_quotes(&body)
}

/// 按关键词搜标的。空关键词直接回空表，不要白发一次请求。
#[tauri::command]
pub async fn stock_search(keyword: String) -> AppResult<Vec<StockItem>> {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }
    fetch_suggest(keyword).await
}

/// 批量报价。
#[tauri::command]
pub async fn stock_quotes(secids: Vec<String>) -> AppResult<Vec<StockQuote>> {
    fetch_quotes(secids).await
}

/// 周期 → (klt, 取多少根)。
///
/// 根数按「一屏能画多少根」定：160 根日线差不多 8 个月，看趋势够用；分钟线要 260 根，
/// 是因为一整场交易有 240 分钟，多要几根防着跨日，切掉旧数据由 `keep_last_session` 负责。
fn period_spec(period: &str) -> AppResult<(&'static str, usize)> {
    Ok(match period {
        "min1" => ("1", 260),
        "day" => ("101", 160),
        "week" => ("102", 160),
        "month" => ("103", 120),
        other => return Err(AppError::Invalid(format!("不认识的周期：{other}"))),
    })
}

/// 解析一行 `时间,开,收,高,低,量,额`。少一列、多一列、数字读不出来都整行丢掉——
/// 停牌日接口会给空串，别让它把整张图带崩。
fn parse_bar(line: &str) -> Option<Bar> {
    let mut parts = line.split(',');
    let time = parts.next()?.trim().to_owned();
    if time.is_empty() {
        return None;
    }

    let mut next = || parts.next().and_then(|value| value.trim().parse::<f64>().ok());
    Some(Bar {
        time,
        open: next()?,
        close: next()?,
        high: next()?,
        low: next()?,
        volume: next()?,
        amount: next()?,
    })
}

fn parse_chart(body: &str) -> AppResult<Chart> {
    let root: serde_json::Value = serde_json::from_str(body)
        .map_err(|err| AppError::Other(format!("K 线解析失败：{err}")))?;

    // data 为 null（标的已退市 / 键不合法）时按空图处理，不是错误
    let data = &root["data"];
    let digits = data
        .get("decimal")
        .and_then(|v| v.as_u64())
        .unwrap_or(2)
        .min(4) as u8;
    let prev_close = data.get("preKPrice").and_then(|v| v.as_f64());

    let bars = data
        .get("klines")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str())
                .filter_map(parse_bar)
                .collect()
        })
        .unwrap_or_default();

    Ok(Chart {
        bars,
        prev_close,
        digits,
    })
}

/// 分时图只画当天：分钟线接口会顺着往前多给几根，按最后一根的日期切一刀。
fn keep_last_session(bars: Vec<Bar>) -> Vec<Bar> {
    let Some(last) = bars.last() else {
        return bars;
    };
    // `2026-11-20 09:31` → `2026-11-20`；日线没有空格，split 出来就是整串
    let day = last.time.split(' ').next().unwrap_or_default().to_owned();
    let keep = bars
        .iter()
        .position(|bar| bar.time.starts_with(&day))
        .unwrap_or(0);
    bars.into_iter().skip(keep).collect()
}

async fn fetch_chart(secid: &str, period: &str, fqt: u8) -> AppResult<Chart> {
    let (klt, lmt) = period_spec(period)?;
    let fqt_text = fqt.clamp(0, 2).to_string();
    let lmt_text = lmt.to_string();

    let response = client()?
        .get(KLINE_URL)
        .query(&[
            ("secid", secid),
            ("fields1", KLINE_FIELDS1),
            ("fields2", KLINE_FIELDS2),
            ("klt", klt),
            ("fqt", &fqt_text),
            ("end", KLINE_END),
            ("lmt", &lmt_text),
        ])
        .send()
        .await
        .map_err(|err| AppError::Other(format!("连不上行情服务器：{err}")))?;

    let body = response
        .text()
        .await
        .map_err(|err| AppError::Other(format!("K 线读不出来：{err}")))?;

    let chart = parse_chart(&body)?;
    if period != "min1" {
        return Ok(chart);
    }
    Ok(Chart {
        bars: keep_last_session(chart.bars),
        ..chart
    })
}

/// 一段历史行情。`period`：min1 / day / week / month；`fqt`：0 不复权 / 1 前复权 / 2 后复权。
#[tauri::command]
pub async fn stock_chart(secid: String, period: String, fqt: u8) -> AppResult<Chart> {
    let secid = secid.trim();
    if !secid.contains('.') {
        return Err(AppError::Invalid("这只标的没有报价编号".into()));
    }
    fetch_chart(secid, &period, fqt).await
}

/// 自选清单，按加入顺序。
#[tauri::command]
pub fn stock_watch() -> Vec<StockItem> {
    load_from(&watch_path())
}

/// 加一只，返回新的整份清单——前端直接替换，不用再问一次。
#[tauri::command]
pub fn stock_watch_add(item: StockItem) -> AppResult<Vec<StockItem>> {
    if !item.secid.contains('.') || item.code.trim().is_empty() {
        return Err(AppError::Invalid("这只标的没有报价编号".into()));
    }

    let path = watch_path();
    let mut list = load_from(&path);
    if push(&mut list, item)? {
        save_to(&path, &list)?;
    }
    Ok(list)
}

/// 删一只，同样回整份清单。
#[tauri::command]
pub fn stock_watch_remove(secid: String) -> AppResult<Vec<StockItem>> {
    let path = watch_path();
    let mut list = load_from(&path);
    if remove(&mut list, secid.trim()) {
        save_to(&path, &list)?;
    }
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::{
        StockItem, amount, fetch_quotes, fetch_suggest, keep_last_session, load_from, parse_bar,
        parse_chart, parse_quotes, parse_suggest, period_spec, push, remove, save_to,
    };
    use crate::testutil::TempDir;

    fn item(secid: &str, code: &str, name: &str) -> StockItem {
        StockItem {
            secid: secid.to_owned(),
            code: code.to_owned(),
            name: name.to_owned(),
            market: "沪A".to_owned(),
        }
    }

    /// 真接口的响应（截过），字段名和嵌套层级照抄
    const SUGGEST_BODY: &str = r#"{"QuotationCodeTable":{"Data":[
        {"Code":"600519","Name":"贵州茅台","PinYin":"GZMT","ID":"6005191","Classify":"AStock",
         "SecurityTypeName":"沪A","MktNum":"1","QuoteID":"1.600519","UnifiedCode":"600519"},
        {"Code":"000001","Name":"平安银行","PinYin":"PAYH","Classify":"AStock",
         "SecurityTypeName":"深A","MktNum":"0"}
    ],"Status":0,"Message":"成功","TotalCount":2}}"#;

    const QUOTE_BODY: &str = r#"{"rc":0,"rt":11,"svr":1,"lt":1,"full":1,"data":{"total":2,"diff":[
        {"f1":2,"f2":1452.43,"f3":-0.53,"f4":-7.78,"f12":"600519","f13":1,"f14":"贵州茅台","f18":1460.21},
        {"f1":2,"f2":"-","f3":"-","f4":"-","f12":"000002","f13":0,"f14":"万科A","f18":8.5}
    ]}}"#;

    #[test]
    fn suggest_skips_items_without_quote_id() {
        let hits = parse_suggest(SUGGEST_BODY).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].secid, "1.600519");
        assert_eq!(hits[0].name, "贵州茅台");
        assert_eq!(hits[0].market, "沪A");
    }

    #[test]
    fn suggest_without_data_is_empty_not_error() {
        assert!(parse_suggest(r#"{"QuotationCodeTable":{"Status":0}}"#)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn suggest_rejects_broken_json() {
        assert!(parse_suggest("<html>502</html>").is_err());
    }

    #[test]
    fn quotes_keep_secid_shape() {
        let quotes = parse_quotes(QUOTE_BODY).unwrap();
        assert_eq!(quotes[0].secid, "1.600519");
        assert_eq!(quotes[0].price, Some(1452.43));
        assert_eq!(quotes[0].percent, Some(-0.53));
        assert_eq!(quotes[0].digits, 2);
    }

    #[test]
    fn suspended_quote_has_no_numbers() {
        // 停牌回的是 "-"，读不出来就该是 None——读成 0 会被显示成「平盘」
        let quotes = parse_quotes(QUOTE_BODY).unwrap();
        assert_eq!(quotes[1].secid, "0.000002");
        assert_eq!(quotes[1].price, None);
        assert_eq!(quotes[1].percent, None);
        assert_eq!(quotes[1].prev_close, Some(8.5));
    }

    #[test]
    fn quotes_with_null_data_is_empty() {
        assert!(parse_quotes(r#"{"rc":0,"data":null}"#).unwrap().is_empty());
    }

    #[test]
    fn amount_ignores_non_numbers() {
        assert_eq!(amount(Some(&serde_json::json!(1.5))), Some(1.5));
        assert_eq!(amount(Some(&serde_json::json!("-"))), None);
        assert_eq!(amount(None), None);
    }

    #[test]
    fn push_is_idempotent() {
        let mut list = Vec::new();
        assert!(push(&mut list, item("1.600519", "600519", "贵州茅台")).unwrap());
        assert!(!push(&mut list, item("1.600519", "600519", "贵州茅台")).unwrap());
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn push_stops_at_limit() {
        let mut list: Vec<StockItem> = (0..super::WATCH_LIMIT)
            .map(|i| item(&format!("1.60{i}"), "600000", "银行"))
            .collect();
        assert!(push(&mut list, item("1.600519", "600519", "贵州茅台")).is_err());
        assert_eq!(list.len(), super::WATCH_LIMIT);
    }

    #[test]
    fn remove_reports_whether_it_hit() {
        let mut list = vec![item("1.600519", "600519", "贵州茅台")];
        assert!(remove(&mut list, "1.600519"));
        assert!(list.is_empty());
        assert!(!remove(&mut list, "1.600519"));
    }

    #[test]
    fn watch_round_trips_through_disk() {
        let dir = TempDir::new("stock-watch");
        let path = dir.join("stock_watch.json");
        let list = vec![
            item("1.600519", "600519", "贵州茅台"),
            item("0.000001", "000001", "平安银行"),
        ];

        save_to(&path, &list).unwrap();

        assert_eq!(load_from(&path), list);
    }

    #[test]
    fn broken_watch_file_reads_as_empty() {
        let dir = TempDir::new("stock-watch-broken");
        let path = dir.join("stock_watch.json");
        std::fs::write(&path, b"{not json").unwrap();

        assert!(load_from(&path).is_empty());
    }

    #[test]
    fn missing_market_field_still_loads() {
        // 早先版本只存了 secid / code / name，读回来不该整份丢掉
        let dir = TempDir::new("stock-watch-legacy");
        let path = dir.join("stock_watch.json");
        std::fs::write(
            &path,
            r#"[{"secid":"1.600519","code":"600519","name":"贵州茅台"}]"#.as_bytes(),
        )
        .unwrap();

        let list = load_from(&path);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].market, "");
    }

    /* ------------------------------------------------------------ K 线 */

    /// 真接口的响应（截过），字段名和嵌套层级照抄
    const CHART_BODY: &str = r#"{"rc":0,"data":{"code":"600519","market":1,"name":"贵州茅台",
        "decimal":2,"preKPrice":1460.21,"klines":[
        "2026-11-19,1442.00,1460.21,1464.99,1432.10,42692,6192213063.00",
        "2026-11-20,1450.89,1485.75,1489.09,1423.90,67229,9796311852.00"
    ]}}"#;

    #[test]
    fn chart_parses_rows_and_meta() {
        let chart = parse_chart(CHART_BODY).unwrap();
        assert_eq!(chart.bars.len(), 2);
        assert_eq!(chart.digits, 2);
        assert_eq!(chart.prev_close, Some(1460.21));

        let last = &chart.bars[1];
        assert_eq!(last.time, "2026-11-20");
        assert_eq!(last.open, 1450.89);
        assert_eq!(last.close, 1485.75);
        assert_eq!(last.high, 1489.09);
        assert_eq!(last.low, 1423.90);
        assert_eq!(last.volume, 67229.0);
        assert_eq!(last.amount, 9796311852.0);
    }

    #[test]
    fn chart_with_null_data_is_empty() {
        let chart = parse_chart(r#"{"rc":0,"data":null}"#).unwrap();
        assert!(chart.bars.is_empty());
        assert_eq!(chart.prev_close, None);
        // 读不到 decimal 时按两位小数兜底，别让坐标轴画出 0 位
        assert_eq!(chart.digits, 2);
    }

    #[test]
    fn broken_bar_is_dropped_not_fatal() {
        // 停牌日 / 缺列的行只能丢，不能把整张图带崩
        assert!(parse_bar("2026-11-20,1.0,2.0").is_none());
        assert!(parse_bar(",1,2,3,4,5,6").is_none());
        assert!(parse_bar("2026-11-20,a,2,3,4,5,6").is_none());
        assert!(parse_bar("2026-11-20,1,2,3,4,5,6").is_some());
    }

    #[test]
    fn session_keeps_only_the_last_day() {
        let bars: Vec<_> = [
            "2026-11-19 14:59,1,1,1,1,1,1",
            "2026-11-19 15:00,1,1,1,1,1,1",
            "2026-11-20 09:31,1,1,1,1,1,1",
            "2026-11-20 09:32,1,1,1,1,1,1",
        ]
        .iter()
        .map(|line| parse_bar(line).unwrap())
        .collect();

        let kept = keep_last_session(bars);
        assert_eq!(kept.len(), 2);
        assert!(kept.iter().all(|bar| bar.time.starts_with("2026-11-20")));
    }

    #[test]
    fn session_of_empty_input_stays_empty() {
        assert!(keep_last_session(Vec::new()).is_empty());
    }

    #[test]
    fn period_spec_maps_known_and_rejects_unknown() {
        assert_eq!(period_spec("min1").unwrap().0, "1");
        assert_eq!(period_spec("day").unwrap().0, "101");
        assert_eq!(period_spec("week").unwrap().0, "102");
        assert_eq!(period_spec("month").unwrap().0, "103");
        assert!(period_spec("5min").is_err());
    }

    /// 真接口冒烟：默认跳过，`cargo test --lib -- --ignored` 才跑（CI 不该依赖外网）。
    ///
    /// 它盯的是「请求还是那一套参数」——接口换域名、加鉴权、改字段时只有这里会先炸。
    /// 解析层的边界（停牌、缺字段）由上面那些固定报文测试兜着，所以这里只断言
    /// 「拿得到、关键字段有值」，不去比具体价格。
    #[test]
    #[ignore]
    fn live_endpoints_still_answer() {
        tauri::async_runtime::block_on(async {
            let hits = fetch_suggest("茅台").await.expect("搜索接口不通");
            assert!(!hits.is_empty(), "搜索没返回任何标的");
            assert_eq!(hits[0].secid, "1.600519");

            let quotes = fetch_quotes(vec!["1.600519".into(), "1.000001".into()])
                .await
                .expect("报价接口不通");
            assert_eq!(quotes.len(), 2, "两只都要有报价");
            assert!(quotes[0].price.is_some(), "现价没取到");
            assert!(quotes[0].digits >= 1, "小数位没取到");

            // K 线：日线要能拿到一屏的量，分时只能剩当天
            let daily = super::fetch_chart("1.600519", "day", 1)
                .await
                .expect("日 K 接口不通");
            assert!(daily.bars.len() > 20, "日线只有 {} 根", daily.bars.len());

            let min1 = super::fetch_chart("1.600519", "min1", 1)
                .await
                .expect("分时接口不通");
            assert!(!min1.bars.is_empty(), "分时是空的");
            let day = min1.bars[0].time.split(' ').next().unwrap_or_default();
            assert!(
                min1.bars.iter().all(|bar| bar.time.starts_with(day)),
                "分时混进了别的交易日"
            );
        });
    }
}
