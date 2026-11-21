# 写实立绘素材署名与许可

本目录（`assets/pet-real/`）的立绘由 **DeepSeek-chan** 免费 Live2D 模型的分层 PSD
导出，仅做了「按表情组叠加 → 裁剪透明边距 → 缩放 → WebP 压缩」，未修改角色形象本身。

## 许可要点

原模型的《利用规约》允许：个人使用、直播 / 视频创作、平台收益、二次创作与社交平台展示，
因此本目录的使用边界是：

- ✅ 随本项目（个人自用）一起编译进桌面应用；

## 重新生成

```bash
pip install psd-tools
python tools/prepare-real-art.py            # 默认输出 560px 高
python tools/prepare-real-art.py --height 720
```