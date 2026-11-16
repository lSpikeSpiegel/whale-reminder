"""把 DeepSeek-chan 的 Live2D 模型整理成前端能直接加载的形态。

原始素材是 VTube Studio 的目录结构：中文文件名、4096² 贴图、24 个 Exp3、8 个 Motion。
直接用有三个问题：

1. **贴图太大**。5 张 4096² 解码后是 335 MB 显存，一个常驻桌宠扛不住；
   桌宠最大也就 340px 高，1024² 已经有 3 倍余量。
2. **中文文件名进 URL** 要百分号编码，WebView2 下偶尔还会和本地文件协议打架，
   统一改成 ASCII。
3. **用不上的文件太多**。Exp3 只是把某个 `keyN` 参数置 1，代码里直接设参数更省事；
   7 个「切换手」的 Motion 是给 VTS 做过渡用的，也不需要。

所以这里只产出「能画出来」的最小集合：

    assets/live2d/
      model.model3.json     ← 重写过，只引用下面这些
      model.moc3            ← 15.7 MB，没法压
      model.physics3.json   ← 头发 / 裙摆 / 尾巴的物理
      model.cdi3.json       ← 参数名，调试用
      textures/tex_0*.png   ← 4096 → 1024
      motions/idle.motion3.json

用法：
    python tools/prepare-live2d.py               # 默认 1024
    python tools/prepare-live2d.py --size 2048   # 显存翻 4 倍，一般用不上
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = (
    ROOT
    / "DeepSeek-chan  DeepSeekちゃん｜Free Live2D Model + Layered PSD  無料モデル・PSD"
    / "DeepSeek"
)
OUT = ROOT / "assets" / "live2d"

TEXTURES = [
    "大肥鱼.4096/texture_00.png",
    "大肥鱼.4096/texture_01.png",
    "大肥鱼.4096/texture_02.png",
    "大肥鱼.4096/texture_03.png",
    "大肥鱼.4096/texture_04.png",
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--size", type=int, default=1024, help="贴图边长（正方形）")
    args = parser.parse_args()

    moc = SRC / "大肥鱼.moc3"
    if not moc.exists():
        print(f"找不到模型：{moc}", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "textures").mkdir(exist_ok=True)
    (OUT / "motions").mkdir(exist_ok=True)

    # 1. 贴图降采样。UV 是归一化的，换分辨率不用改模型。
    total = 0
    names = []
    for index, rel in enumerate(TEXTURES):
        src = SRC / rel
        if not src.exists():
            print(f"缺贴图：{src}", file=sys.stderr)
            return 1
        image = Image.open(src).convert("RGBA")
        before = image.size
        image = image.resize((args.size, args.size), Image.LANCZOS)
        name = f"textures/tex_{index:02d}.png"
        image.save(OUT / name, "PNG", optimize=True)
        size = (OUT / name).stat().st_size
        total += size
        names.append(name)
        print(f"  {name:<20} {before[0]}² → {args.size}²  {size // 1024} KB")

    # 2. 二进制和物理直接搬
    shutil.copyfile(moc, OUT / "model.moc3")
    shutil.copyfile(SRC / "大肥鱼.physics3.json", OUT / "model.physics3.json")
    shutil.copyfile(SRC / "大肥鱼.cdi3.json", OUT / "model.cdi3.json")
    shutil.copyfile(SRC / "Animation" / "IDLE.motion3.json", OUT / "motions" / "idle.motion3.json")

    # 3. 重写 model3.json：只留实际用到的引用
    model = {
        "Version": 3,
        "FileReferences": {
            "Moc": "model.moc3",
            "Textures": names,
            "Physics": "model.physics3.json",
            "DisplayInfo": "model.cdi3.json",
            "Motions": {
                "Idle": [
                    {
                        "File": "motions/idle.motion3.json",
                        "FadeInTime": 0.8,
                        "FadeOutTime": 0.8,
                    }
                ]
            },
        },
        "Groups": [
            {
                "Target": "Parameter",
                "Name": "EyeBlink",
                "Ids": ["ParamEyeLOpen", "ParamEyeROpen"],
            },
            {"Target": "Parameter", "Name": "LipSync", "Ids": []},
        ],
    }
    (OUT / "model.model3.json").write_text(
        json.dumps(model, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    moc_size = (OUT / "model.moc3").stat().st_size
    print(f"\n贴图合计 {total // 1024 // 1024} MB（原 45 MB），moc3 {moc_size // 1024 // 1024} MB")
    print(f"完成 → {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
