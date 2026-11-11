#!/usr/bin/env python3
"""
把鲸鱼娘立绘处理成桌宠可直接使用的素材。

源素材：https://github.com/pokerface-1224/deepseek-whale-girl-pet
  - 角色原作者：上善
  - 二次设计 / 立绘：zipzippipe
  - 授权：CC BY-NC-SA 4.0（仅限非商业用途，须署名，衍生须同协议）

处理策略：
  1. 按 alpha 通道裁出可见包围盒，去掉四周留白
  2. 等比缩放到 CANVAS x CANVAS 内（contain）
  3. 底部对齐 + 水平居中 —— 保证切状态时脚底基线不跳
  4. 导出 WebP
  5. 把原图归一化的眼睛坐标映射到新画布，供前端做眨眼动画

用法：
  python tools/prepare-art.py --src <原仓库 desktop-pet/art 目录>
"""

import argparse
import json
import os
from PIL import Image

CANVAS = 352          # 2x of 显示尺寸 176px
DISPLAY = 176
WEBP_QUALITY = 88
ALPHA_THRESHOLD = 16  # 低于此 alpha 视为透明，用于算包围盒
PAD_RATIO = 0.03      # 每边留白比例，给呼吸缩放（1.0→1.03）留余量，避免被窗口裁切

# 原仓库 Program.cs 中 Pose 的归一化眼睛参数（相对原图宽高）
# 仅 front / side 有有效值，其余状态不做眨眼
EYE_PARAMS = {
    "front": dict(eye_y=0.495, eye_h=0.075, eye_w=0.150, left_x=0.265, right_x=0.625),
    "side":  dict(eye_y=0.495, eye_h=0.075, eye_w=0.120, left_x=0.300, right_x=0.560),
}

POSES = [
    "front", "side", "back",
    "thinking", "working", "sleep", "playing",
    "slacking", "bored", "daydreaming", "eating",
]


def visible_bbox(im):
    alpha = im.getchannel("A")
    mask = alpha.point(lambda v: 255 if v > ALPHA_THRESHOLD else 0)
    return mask.getbbox()


def process(src_dir, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    meta = {"canvas": CANVAS, "displaySize": DISPLAY, "poses": {}}
    total = 0

    for name in POSES:
        src = os.path.join(src_dir, f"{name}.png")
        if not os.path.exists(src):
            print(f"  skip {name}: not found")
            continue

        im = Image.open(src).convert("RGBA")
        ow, oh = im.size
        bbox = visible_bbox(im)
        if bbox is None:
            print(f"  skip {name}: fully transparent")
            continue

        bx, by, br, bb = bbox
        cw, ch = br - bx, bb - by
        cropped = im.crop(bbox)

        pad = round(CANVAS * PAD_RATIO)
        inner = CANVAS - pad * 2
        scale = min(inner / cw, inner / ch)
        nw, nh = max(1, round(cw * scale)), max(1, round(ch * scale))
        resized = cropped.resize((nw, nh), Image.LANCZOS)

        ox = (CANVAS - nw) // 2
        oy = CANVAS - nh - pad  # 底部对齐，并留出安全边距

        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        canvas.paste(resized, (ox, oy), resized)

        dst = os.path.join(out_dir, f"{name}.webp")
        canvas.save(dst, "WEBP", quality=WEBP_QUALITY, method=6)
        size_kb = os.path.getsize(dst) / 1024
        total += size_kb

        entry = {
            "file": f"{name}.webp",
            "drawRect": {"x": ox, "y": oy, "w": nw, "h": nh},
            "sourceSize": [ow, oh],
            "sourceBBox": [bx, by, br, bb],
        }

        # 把归一化眼睛坐标映射到新画布
        if name in EYE_PARAMS:
            p = EYE_PARAMS[name]
            sx, sy = nw / cw, nh / ch

            def map_x(nx):
                return round(ox + (nx * ow - bx) * sx, 2)

            def map_y(ny):
                return round(oy + (ny * oh - by) * sy, 2)

            entry["eyes"] = {
                "y": map_y(p["eye_y"]),
                "height": round(p["eye_h"] * oh * sy, 2),
                "width": round(p["eye_w"] * ow * sx, 2),
                "leftX": map_x(p["left_x"]),
                "rightX": map_x(p["right_x"]),
            }

        meta["poses"][name] = entry
        print(f"  {name:12s} bbox={cw}x{ch} -> {nw}x{nh} @({ox},{oy})  {size_kb:6.1f} KB")

    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"\n合计 {len(meta['poses'])} 张，{total:.1f} KB")
    return meta


def build_icons(src_icon, out_dir):
    """生成托盘图标与应用图标"""
    im = Image.open(src_icon).convert("RGBA")
    for size in (32, 64, 128, 256):
        im.resize((size, size), Image.LANCZOS).save(
            os.path.join(out_dir, f"icon-{size}.png"), "PNG"
        )
    # Windows 托盘常用 ICO，含多尺寸
    im.save(
        os.path.join(out_dir, "icon.ico"),
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)],
    )
    print(f"  icons: 32/64/128/256 png + icon.ico")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="原仓库 desktop-pet/art 目录")
    ap.add_argument("--out", default="assets/pet", help="输出目录")
    ap.add_argument("--icon", default=None, help="原仓库 icon.png 路径")
    args = ap.parse_args()

    print(f"处理立绘: {args.src}")
    process(args.src, args.out)

    if args.icon and os.path.exists(args.icon):
        print("\n生成图标:")
        build_icons(args.icon, args.out)
