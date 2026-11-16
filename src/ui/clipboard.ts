/**
 * 复制文本到剪贴板。
 *
 * 优先用 Clipboard API；WebView2 里窗口没有焦点时它偶尔会直接拒绝，
 * 这时退回「选中一个隐藏 textarea + execCommand」——老办法，但不需要权限。
 * 两条路都失败才算失败，调用方据此决定要不要提示用户。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 落到下面的兜底 */
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // 不能用 display:none —— 那样选不中，也就复制不到
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.left = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);

  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
