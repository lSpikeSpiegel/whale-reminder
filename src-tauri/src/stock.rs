//! 行情工具：搜标的、自选清单、批量报价。
//!
//! 数据来自东方财富网页版在用的两个公开接口，都是 HTTPS + JSON：
//!
//! - `searchapi.eastmoney.com/api/suggest/get`：按代码 / 名称 / 拼音搜，回一个
//!   `QuoteID`（形如 `1.600519`，市场号 + 代码），报价接口直接认这个键；
//! - `push2.eastmoney.com/api/qt/ulist.np/get`：一次问一批标的的现价、涨跌额、涨跌幅。
//!
//! **取数放在 Rust 而不是前端 `fetch`**：WebView2 里跨域要对方给 CORS 头，这两个
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
        StockItem, amount, fetch_quotes, fetch_suggest, load_from, parse_quotes, parse_suggest, push,
        remove, save_to,
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
        });
    }
}
