# 写实立绘素材署名与许可

本目录（`assets/pet-real/`）的立绘由 **DeepSeek-chan** 免费 Live2D 模型的分层 PSD
导出，仅做了「按表情组叠加 → 裁剪透明边距 → 缩放 → WebP 压缩」，未修改角色形象本身。

## 作者

| 角色 | 姓名 |
|---|---|
| 角色插画 / PSD 拆分 | 神谷凌子（Kamiya Ryoko）· https://vgen.co/KAMIYA · X [@kamiya_ryoko](https://twitter.com/kamiya_ryoko) |
| Live2D 绑定 | 霓虹猫_NeonNeko |
| 模型发布 | 神谷凌子 |

## 许可要点

原模型的《利用规约》允许：个人使用、直播 / 视频创作、平台收益、二次创作与社交平台展示，
**但必须署名**。禁止：转售模型文件、把完整模型文件重新上传到网盘 / 素材站供他人下载、
冒充原作者、声称模型为自己原创。

因此本目录的使用边界是：

- ✅ 随本项目（个人自用）一起编译进桌面应用；
- ✅ 在 README / 发布页写明上面三位作者；
- ❌ 不要把这个仓库当成「DeepSeek-chan 模型下载源」发布——模型本体（`大肥鱼.moc3`、
  4K 贴图、PSD）**不进版本库、不进安装包**，推荐别人请给原发布页；
- ❌ 不要用于商业产品内置资产（品牌广告、付费商品）——需要先联系作者授权。

## 重新生成

```bash
pip install psd-tools
python tools/prepare-real-art.py            # 默认输出 560px 高
python tools/prepare-real-art.py --height 720
```

脚本读的是仓库根目录下的
`DeepSeek-chan .../psd/大肥鱼公皮分享拆分.psd`（该目录已被 `.gitignore` 排除）。
