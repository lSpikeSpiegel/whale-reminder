/**
 * 扫码结果的格式名。
 *
 * Rust 侧存的是 ZXing `BarcodeFormat` 的 `Display` 输出，长这样：
 * `qrcode` / `ean 13` / `code 128`（小写、空格分隔，见 rxing 的 barcode_format.rs）。
 * 这里翻成人话再上屏；认不出来的格式原样显示，别把它吞掉。
 */

const LABEL: Record<string, string> = {
  qrcode: "二维码",
  mqr: "微型二维码",
  rmqr: "微型二维码",
  aztec: "Aztec",
  datamatrix: "Data Matrix",
  maxicode: "MaxiCode",
  "pdf 417": "PDF417",
  "ean 8": "EAN-8",
  "ean 13": "EAN-13",
  "upc a": "UPC-A",
  "upc e": "UPC-E",
  "upc/ean extension": "UPC/EAN 附加码",
  "code 39": "Code 39",
  "code 93": "Code 93",
  "code 128": "Code 128",
  codabar: "Codabar",
  itf: "ITF",
  telepen: "Telepen",
  "rss 14": "RSS-14",
  "rss expanded": "RSS Expanded",
  DXFilmEdge: "DX Film Edge",
};

export function formatLabel(format: string): string {
  return LABEL[format] ?? LABEL[format.toLowerCase()] ?? format;
}

/** 扫出来的是不是能直接打开的网址 */
export function isWebLink(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}
