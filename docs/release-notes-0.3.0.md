# dsh-image-forge 0.3.0

本版只保留**本机 ComfyUI** 一个生成后端。插件不下载运行时、不托管权重，也不再把
云端 API key 当作生成路径；旧 profile 里的云端字段会被忽略。

## 生成与模型

- 三个模型档位：`qwen21-base`、`qwen21-turbo` 与 `moss-sft`。Qwen base 默认 40 步，
  turbo 使用 8 步蒸馏图；MOSS-Image 可用 `comfy` / `official` 两套采样口径。
- 文生图与参考图编辑共用一套图构建管线；参考图最多 10 张，改图会保留参考图、尺寸和血缘关系。
- MOSS-Image 的 Layout 节点可编辑画框、模板与完整 schema，编译后的布局作为正向提示词提交。

## 工作台

- 工作台改为画布优先：项目管理、画板、节点详情和 ComfyUI 日志位于同一级页签。
- 画布使用 React Flow；空白处拖动平移，滚轮平移，Ctrl/Meta+滚轮缩放，Shift+拖动框选。
- 节点支持属性抽屉、完整详情页、拖线创建后续节点、血缘连线、增量保存与拼版导出。
- 「素材」是所有项目共享的素材视图，可跨画板搜索、定位、用作参考或移除。
- ComfyUI 日志是独立页签：按行号、时间戳和级别展示，支持加载更早、刷新最新、暂停与复制。

## 运行与环境

- `node scripts/start-comfyui.mjs` 可发现本机 ComfyUI、启动、等待就绪并做体检；
  `--doctor`、`--stop` 分别对应体检与停止。
- 工作台可直接启动/停止由插件拉起的 ComfyUI，并可查看结构化日志。
- 缺失权重可从工作台按文件下载；用户自己启动的 ComfyUI 不会被插件误杀。

## 执行后端

- `executionBackend` 支持 `auto`、`mcp`、`cli` 与 `http`。
- `auto` 依次尝试 comfy-mcp、comfy CLI、内置 HTTP；`mcp` / `cli` 是严格模式，不会静默回退。
- 新增 `comfyMcpBin`、`comfyBin`、`backendTimeoutMs`、`mcpDebug`、`backendTmpDir` 配置项。

## 发布边界

- npm 包只包含 README 明确引用的公共文档和运行所需文件。
- 长设计稿、调研和本地预览数据不进入 Git 共享面，也不进入 npm 包。
- 预览脚本位于 `test/dev/preview/`，只用于开发验收，不随包发布。

## 已知限制

- 8 GB 显存仍需按实际模型和分辨率控制；OOM 由 ComfyUI 直接报告。
- Windows 是当前重点验证平台；其他平台的 ComfyUI 发现与进程归属仍需实测。
