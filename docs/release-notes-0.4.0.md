# dsh-image-forge 0.4.0

本版同时包含一次**对外命名破坏性变更**和一次工作台大版本升级。产品能力不再以 Qwen 模型命名；生成继续支持 Qwen-Image 2.1 与 MOSS-Image，模型由 `comfyModel` 选择。

## 工具与技能改名

| 0.3.0 | 0.4.0 |
|---|---|
| `qwen_image_generate` | `image_forge_generate` |
| `qwen_image_edit` | `image_forge_edit` |
| `qwen_image_status` | `image_forge_status` |
| `qwen_image_setup` | `image_forge_setup` |
| skill `qwen-image-forge` | skill `image-forge` |

旧工具名不再注册，也没有别名。升级后需要更新模型提示、自动化配置和手工调用。

## 工作台 2.2

- 工作台继续以 React Flow 无限画布为核心，补齐工具坞、手势提示、操作历史、项目管理和全部素材画廊。
- 空白左拖始终平移，Shift+左拖框选；滚轮平移，Ctrl/Meta+滚轮或双指捏合缩放。工具栏不再维护容易混淆的「选择 / 平移」模式。
- 快速合成器把参数固定显示为「画幅 / 分辨率 / 张数」，移除未标注的步数输入；步数仍在节点属性与任务快照中。
- 分辨率新增 `1.5MP` 与 `2K` 两档，并按当前画幅显示实际尺寸。生成时会把精确 `width` / `height` 写入任务和画板记录。
- 提示词输入 `@` 会弹出当前画板图片候选，支持文件名/描述过滤、键盘选择和有序参考图加入；选中后按钮切换为「改这张」。
- 画廊可在当前画板与全部素材之间切换，并保留独立空态、搜索与刷新行为。
- Better Sidebar 的布局编辑改用纯色画布，不再把结果图当作描框底图；保存后通过 board-change 通知让画布立即重读。

## MOSS 布局节点 2.0

- 布局节点从简单画框计数升级为实时创作摘要：显示缩略图、整图描述首行、状态徽标、画框数、draft 尺寸、映射比例和参考缩略图。
- 布局节点最多保存 10 张参考图，按连接顺序去重；第 11 张会明确拒绝。
- 默认仍是官方纯 Layout：参考图可以保存在节点上，但生成时会被明确忽略。
- 新增默认关闭的「Layout + 参考图（实验）」模式：必须至少有一张参考图，生成时复用 MOSS 编辑 LoRA，并把 compiled Layout JSON 作为 `TextEncodeMOSSImageEdit.prompt`。
- 实验模式生成前会检查 `moss-sft`、MOSS 基础模型、编辑 LoRA 和 `TextEncodeMOSSImageEdit`；条件不满足时禁用入口并显示原因。
- 该实验组合不是 MOSS 官方模板。失败只产生一次失败任务并保留错误，不自动回退纯 Layout。
- 布局生成会携带 draft 的精确宽高，不再只按比例映射后改变画框坐标系；旧布局数据缺省按纯 Layout 读取。

## 设置与环境

- Settings 2.0 使用常用/高级分栏、统一草稿和明确保存状态；环境字段未保存时禁止启动/停止。
- ComfyUI 日志成为工作区独立页签，支持行号、时间戳、级别、加载更早、刷新最新、暂停与复制。
- `image_forge_setup` 支持 `status` / `start` / `stop` / `install` / `download`。权重下载默认 dry-run，只有 `confirm: true` 才写盘。
- ComfyUI 未运行时工作台仍可打开，并显示连接失败原因与可用动作。

## 工程与发布

- 新增严格 TypeScript 检查：`npm run typecheck` 使用 `tsc --noEmit`，覆盖 `src/**/*.ts` 与 tsdown 配置。
- CI 与 Release workflow 在构建前执行 `pnpm typecheck`；`prepublishOnly` 同时执行类型检查和全量测试。
- CI 继续要求提交后的 `lib/` 与源码一致，并执行全量测试与 npm 包内容审计。
- 新增并保留 Canvas 2.2 浏览器 QA、MOSS 实验生成假后端回归和布局参考顺序/上限测试。

## 默认命名与兼容性

- 新生成 PNG 的默认前缀从 `qwen` 改为 `forge`。
- `image_forge_edit` 未给 `preset` 时仍默认使用 `edit`。
- 已有文件名和画板 JSON 不会被批量改名；历史成果仍可正常读取。
- 模型档位值 `qwen21-base`、`qwen21-turbo`、`moss-sft` 保持不变。
- 已退役的 `qwen_image_env` 不提供，也不会重新引入。

## 已知限制

- 「Layout + 参考图」仍是非官方实验组合，模型是否能稳定理解布局 JSON 与参考图不构成正式保证。
- `2K` 档像素约为默认档 2.8 倍，8 GB 显存设备存在明显耗时与 OOM 风险。
- Windows 仍是当前重点验证平台；其他平台的 ComfyUI 发现和进程归属仍需实测。
