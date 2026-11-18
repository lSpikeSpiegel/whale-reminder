/**
 * 动态立绘在这个构建里可不可用。
 *
 * 模型本体（`model.moc3` 16 MB + `textures/` 5 张 1024² 贴图）按作者授权
 * 不允许二次分发，所以不在版本库里（见 `.gitignore`）。GitHub Actions 从仓库
 * checkout 构建，产物里天然缺这些文件——表现是「设置页的开关能点，点了没反应」：
 * 加载失败后 `liveFailed` 会让它**静默**退回静态图，用户只会觉得这功能坏了。
 *
 * 所以开关只在开发版出现：本地 `assets/live2d/` 有素材，`pnpm dev` 能看到它。
 * 等模型能随包分发（或改成用户自备模型）之后，把这里改成 `true` 即可，
 * `Settings` 的开关和 `App` 的选用判断都读这一个常量，别在两处各写一遍。
 */
export const LIVE2D_ENABLED = import.meta.env.DEV;
