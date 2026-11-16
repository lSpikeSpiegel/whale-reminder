"""把 DeepSeek-chan 的分层 PSD 拆成一套桌宠立绘。

原始 PSD 是一张 3749×7697 的全身体，图层按部位分好组，`表情` 和 `动作` 两组里
各放着若干「可选叠加层」（脸红 / 爱心眼 / 圈圈眼 / 竖食指 / 狗尾草 …）。
直接 `psd.composite()` 得到的就是默认站姿——这两组在文件里默认是关掉的。

所以这里不重排图层树，只做一件事：在默认站姿上，把指定的一组叠加层按顺序
alpha 叠上去，得到不同的表情变体。这样：

- 每个变体的身体、光影、衣褶完全一致，切换时不会跳；
- 裁剪框取所有变体的并集，保证立绘在 176px 窗口里位置不飘。

**只用 `表情` 组，不用 `动作` 组。** `动作`（竖食指 / 举手 / 狗尾草）只补了
手和袖口，原来的两条手臂还留在身体上，直接叠会变成三只手；要用得先把 `手←`
`手→` 隐藏掉再整体重合成——而 psd-tools 重合成 750 层 × 28MP 慢到不可用。
真正的姿势变化留给 Live2D 运行时，见 docs/07-写实立绘接入.md。

用法：
    python tools/prepare-real-art.py                # 全身（默认），344×680
    python tools/prepare-real-art.py --keep 0.42    # 只留上半身

输出：assets/pet-real/*.webp + meta.json

依赖：psd-tools（pip install psd-tools）
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image
from psd_tools import PSDImage

ROOT = Path(__file__).resolve().parent.parent
PSD = (
    ROOT
    / "DeepSeek-chan  DeepSeekちゃん｜Free Live2D Model + Layered PSD  無料モデル・PSD"
    / "psd"
    / "大肥鱼公皮分享拆分.psd"
)
OUT = ROOT / "assets" / "pet-real"

# 变体名 → 要叠加的 (组名, 子组名) 列表。空列表 = 默认站姿。
# 名字直接当文件名，也是前端 ACTIVITY_POSE_REAL 里引用的 key。
VARIANTS: dict[str, list[tuple[str, str]]] = {
    "front": [],
    "blush": [("表情", "脸红")],
    "heart": [("表情", "爱心眼")],
    "dizzy": [("表情", "圈圈眼")],
    "squint": [("表情", "> <眼")],
    # 生气 / 得意 / 委屈：PSD 的「表情」组一共 7 个，这里全用上了
    "gloom": [("表情", "脸黑")],
    "smug": [("表情", "屑屑眼")],
    "tears": [("表情", "流泪")],
}

# 这些层是作者留的参考 / 演示用层，不该出现在成品里
SKIP_KEYWORDS = ("演示用", "参考")


def find(root, name):
    for layer in root:
        if layer.name == name:
            return layer
        if layer.is_group():
            found = find(layer, name)
            if found is not None:
                return found
    return None


def flatten(node):
    """按叠放顺序（底 → 顶）摊平一个组。"""
    if node.is_group():
        for child in node:
            if child.visible:
                yield from flatten(child)
    else:
        yield node


def overlay(dst: Image.Image, group, only: str) -> None:
    """把 group 里名为 only 的子组叠到 dst 上。"""
    target = None
    for child in group:
        if child.name == only:
            target = child
            break
    if target is None:
        raise SystemExit(f"图层组里没有 {only!r}")

    for layer in flatten(target):
        if any(word in layer.name for word in SKIP_KEYWORDS):
            continue
        image = layer.topil()
        if image is None:
            continue
        if image.mode != "RGBA":
            image = image.convert("RGBA")
        left, top, _, _ = layer.bbox
        dst.alpha_composite(image, (left, top))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--height",
        type=int,
        default=680,
        help="输出立绘高度：窗口高 340 的 2 倍（200% 缩放下 1:1）",
    )
    parser.add_argument(
        "--keep",
        type=float,
        default=1.0,
        help="保留身体高度的比例：1.0 是全身（默认），0.42 是半身",
    )
    args = parser.parse_args()
    if not 0.2 <= args.keep <= 1.0:
        print("--keep 要在 0.2 ~ 1.0 之间", file=sys.stderr)
        return 1

    if not PSD.exists():
        print(f"找不到 PSD：{PSD}", file=sys.stderr)
        return 1

    psd = PSDImage.open(PSD)
    base = psd.composite()
    groups = {"表情": find(psd, "表情"), "动作": find(psd, "动作")}
    for name, group in groups.items():
        if group is None:
            print(f"PSD 里找不到 {name!r} 组", file=sys.stderr)
            return 1

    rendered: dict[str, Image.Image] = {}
    for name, steps in VARIANTS.items():
        image = base.copy()
        for group_name, layer_name in steps:
            overlay(image, groups[group_name], layer_name)
        rendered[name] = image
        print(f"  合成 {name}")

    # 统一裁剪框：取所有变体的 alpha 并集，立绘在窗口里的位置才不会因姿势而飘。
    # 默认整身输出，窗口尺寸按 344×680 的比例配（settings.rs 的 PetStyle::window_size）。
    # 想改成半身就 --keep 0.42，同时把那个窗口尺寸一起改掉，否则窗口比例对不上，
    # object-fit: contain 会在四周留出透明边。
    boxes = [image.getbbox() for image in rendered.values()]
    left = min(box[0] for box in boxes)
    top = min(box[1] for box in boxes)
    right = max(box[2] for box in boxes)
    bottom = max(box[3] for box in boxes)
    if args.keep < 1.0:
        bottom = top + round((bottom - top) * args.keep)
    print(f"  裁剪框 {left},{top} → {right},{bottom}")

    OUT.mkdir(parents=True, exist_ok=True)
    height = args.height
    width = round((right - left) * height / (bottom - top))

    poses = {}
    for name, image in rendered.items():
        thumb = image.crop((left, top, right, bottom)).resize(
            (width, height), Image.LANCZOS
        )
        file = f"{name}.webp"
        thumb.save(OUT / file, "WEBP", quality=90, method=6)
        size = (OUT / file).stat().st_size
        poses[name] = {"file": file}
        print(f"  {file:<14} {width}×{height}  {size // 1024} KB")

    meta = {
        "canvas": height,
        # 立绘在窗口里的显示尺寸 = 窗口高度（见 settings.rs 的 PetStyle::window_size），
        # 输出高度正好是它的 2 倍。前端只用它换算腮红坐标，写实素材没有眼睛标注，
        # 留着是为了和 Q 版 meta.json 同构。
        "displaySize": height // 2,
        "poses": poses,
    }
    (OUT / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"完成 → {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
