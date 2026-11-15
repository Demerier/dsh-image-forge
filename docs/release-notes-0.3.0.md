# 0.3.0 发布说明

**本版只有本机 ComfyUI 一个后端**（云端 api 路径在 0.3.0 的开发线里已删除）。若你之前用
`backend: api` 配过 key，那套配置在本版无效，请按 `docs/configuration.md` 改成 comfyui 配置或直接留空。

## 新增

- **`node scripts/start-comfyui.mjs`：一条命令把本机 ComfyUI 拉起来。** 自动发现安装（Comfy Desktop
  的 `installations.json` / `instance-model-paths`、`COMFYUI_DIR`、或有限深度的目录扫描），**原样复用**
  桌面版自己记录的 `launchArgs` 与 `envVars`，起进程、等 `/system_stats` 应答、报显卡与版本。
  - `--doctor`：只体检不启动——安装、torch 是否在解释器里、五个权重按角色列大小、显存、ComfyUI 能枚举到的 Qwen unet。
  - `--stop` / `--print` / `--dir` / `--timeout`，以及 `pnpm comfy`、`pnpm comfy:doctor`、`pnpm comfy:stop` 三个别名。
  - 脚本**不下载权重、不装 ComfyUI、不改它的配置**；它只是把「点桌面版的启动按钮」换成命令行。
- 「没找到在跑的 ComfyUI」这条报错现在直接给出上面那条命令，不再只让你去读 400 行的部署文档。

## 修复

- **`comfyModel: 'turbo'` 在装了双份主干时永远跑不到 turbo。** 权重是按文件名打分挑的（`image` /
  `2.1` / `int8` 各加分），base 与 turbo 两份**同分**，平手保留服务端顺序，于是永远选中 base，
  `turboUnetOf()` 永远返回 undefined、turbo 图（`SamplerCustomAdvanced` + 手动 sigma，8 步）成了死代码。
  现在 `comfyModel: 'turbo'` 会把 `/turbo/i` 的主干提到最前；找不到 turbo 文件时仍退回 base 并在结果里写明
  原因（`turbo_fallback`）。
  - 本机实测（RTX 4070 Laptop 8 GB，1248×1248）：base 25 步 **45–55 s**，turbo 8 步 **15.8 s**。

## 文档

- `docs/comfyui-deployment.md` 新增 §0.5「先跑一条命令」，§2 补无头启动，§6 用 `--doctor` 取代手工
  `dir /s` + sha256 对表；README 快速开始同步。
- 测试计数更新为 **11 个文件 / 158 个用例**（新增 turbo 主干选择用例）。

## 已知限制

- 8 GB 卡上 base 25 步约 45–55 s/张；想要更快就用 `comfyModel: turbo`（需 `qwen_image_2.1_turbo_*` 权重）。
- 显存不足时报的是 ComfyUI 自己的 CUDA OOM，插件不做前置门禁。
- 脚本只在 Windows 上实测（Comfy Desktop 布局）；便携版/venv 布局走 `--dir`。
