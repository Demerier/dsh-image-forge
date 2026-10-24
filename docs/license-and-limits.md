# 第三方与许可、已知边界（详细）

## 第三方与许可

本插件自身以 **MIT** 发布。与它协作的三方各自独立：

- **Qwen-Image-2.1 权重**：受 **Qwen RESEARCH LICENSE AGREEMENT** 约束，**限研究用途；商用需自行向权利方取得授权**。
  **权重归 Qwen 团队所有**，本插件仅按其许可使用、不主张任何权利。
  本插件**不随包分发、也不替你下载任何权重**：[部署文档](comfyui-deployment.md)里的 `hf-mirror.com` 链接只是指路，
  下不下、下到哪、下完怎么用由你决定并负责。
- **ComfyUI**：**可选的外部依赖**（GPL-3.0）。本插件不包含、不修改、不分发 ComfyUI 代码，
  只通过 HTTP 与用户自行安装的实例通信；是否安装与本插件的 MIT 许可无关。
  本插件也**不改它的启动参数、不重启它、不替它卸载模型**。
- **官方提示词文本**：本插件**不随包分发**任何 Qwen 官方提示词规范原文（`system_prompt_t2i.txt` /
  `guide_t2i.md` / `guide_edit.md` 等）。`skill.md` 与 `references/*.md` 是本插件**自撰**的规则文档；
  输出契约字段名（`rewritten_prompt` / `wh_ratio` / `ratio_follow`）沿用公开契约形状以便互操作。
- **Qwen / 千问 商标**：归阿里巴巴集团所有。它**不在**上述任何开源许可的授权范围内——
  `Qwen RESEARCH LICENSE AGREEMENT` §5(b) 写明「不授予商标许可」，只允许履约声明与
  「描述、再分发材料」时的合理惯用；同一条 §4(c) 禁止把 Qwen 当作衍生作品或产品的主名称。
  因此本项目的包名与仓库名是 `dsh-image-forge`，README 里的「Qwen-Image 2.1」只作**描述性使用**
  （说明调用的是哪个模型），**不宣称与阿里巴巴有任何关联、合作或背书**。
  README 头图（`docs/images/repo-banner.png`）**不含** Qwen / 千问的 logo 或任何商标图样；
  画面右侧是工作台画布功能的示意，左侧是项目自己的吉祥物。
  另有边界：若是商用分发（把模型或产出打包进收费产品），权重的研究许可要求单独申请商用授权；
  商标的使用则需向权利方取得书面同意。
- **`dsh-image-gen`（Apache-2.0，Copyright 2026 shanliuling）**：若移植其代码/文档/占位符协议，
  按 Apache-2.0 §4 履行义务——保留 `LICENSE` 与版权声明、标注修改过的文件、在 README 或 NOTICE
  中致谢。见下节。

> v0.1 曾随包分发一个 Python worker（`resources/worker.py`）与一份 `~/.dsh-image-forge` 运行时。
> 这些**都已删除**：包里现在没有任何 Python，`files` 白名单里也没有 `resources/`（有测试钉住）。

## 从 `dsh-image-gen` 移植的合规要求

上游是 **Apache-2.0**，本插件是 **MIT**。二者兼容：**Apache-2.0 的内容可以进入 MIT 项目，
但该内容本身仍受 Apache-2.0 约束，且不得反向声称"全 MIT"而抹去上游归属。** 具体到本仓库：

**必须做（逐条对应 Apache-2.0 §4）**

1. **随包保留上游许可证**：把上游 `LICENSE` 全文存为 `THIRD-PARTY/dsh-image-gen/LICENSE`，
   并在 `package.json` 的 `files` 中放行（否则 `pnpm pack` 会漏掉它——本包 `files` 是白名单制）。
2. **标注修改**：§4(b) 要求"carry prominent notices stating that You changed the files"。移植后
   被改过的文件在其头注释写明 `Adapted from dsh-image-gen <version> (Apache-2.0), modified`。
   全新重写、仅参考思路的文件不必标，但建议在 commit message 里留追溯线索。
3. **NOTICE**：上游**没有** `NOTICE` 文件，所以 §4(d) 不触发。但 §4 的"attribution"精神仍要求
   在 README 的「致谢」一节点名 `dsh-image-gen` 作者与仓库地址。
4. **不暗示背书**：§4 不含商标授权；README 里写"参考/移植自"而非"官方合作"。

**可以做**

- 移植 `{{prompt}}` / `{{seed}}` / `{{image}}` 这类**占位符协议**与 ComfyUI 适配器逻辑：协议本身
  更接近接口事实，且 Apache-2.0 明确授予改编权。
- 直接拷贝 `src/comfyui.ts`、`src/comfyui-workflow.ts` 的实现，或 Studio 接入的分支结构。

**不要做**

- 把上游代码整段拷进来后只改包名、却在 README 声明"本项目全部代码为 MIT"。
- 借用上游的 README 截图、`docs/assets/readme/*.webp`、灵感库 JSON
  （`src/inspiration/data/*.json` 里是第三方 Prompt 集合，另有一层内容授权问题，与本项目无关，**最要不要碰**）。

> 一句话：**代码能拿来用，但"MIT 的壳"里必须留一块写清来源的 Apache-2.0 领地。**

## 已知边界

- **插件不装 ComfyUI、不下权重、不改它的配置**。它没起来时插件只做两件事：把缺什么说清、把
  [部署文档](comfyui-deployment.md)指给你。这条边界是有意的——替用户改别人的程序状态，代价比省下的
  两分钟大得多。
- 参考图的像素尺寸只认 PNG / JPEG / WebP 的文件头；其它容器（含 TIFF、AVIF）会被拒绝并给出原因。
- 没有局部重绘（inpaint / mask）与放大。素材页只做**检索与整理**（过滤、定位、移除、删文件），不做批量调色 / 导出。
- **显存没有前置门禁**。8 GB 卡上的实测基准见[配置文档](configuration.md#完整证据页面上已不再出现)：
  文生图 1312×736 约 2 s/步、1.5MP 画布 8 步编辑 19–23 s。真不够时是 ComfyUI 回报的干净 CUDA OOM；
  卡上同时跑第二个实例 / 游戏 / Blender 会显著拖慢甚至 OOM，插件只能把这些数字报给你看。
- **`comfyModelsDir` 只影响措辞**：它决定错误信息里写「放进哪个目录」，不决定插件往哪读写。
  权重归 ComfyUI 管，插件一个字节都不碰。
- **`comfyModel: "turbo"` 是请求不是保证**：没有 turbo unet 时自动回落 base，结果里 `comfyui.turbo_fallback`
  会说明。别据此向用户承诺速度。
- **v0.1 的受管 worker 已删除**，连带它的 venv 安装、nf4 权重下载（`fetch-weights` / `skipLmHead`）、
  启动前显存门禁、空闲卸载、「一键部署」桥与 `repair`。删除理由与逐档实测归档见
  [配置文档](configuration.md#完整证据页面上已不再出现)。删除之后的几处「旧数字」只作为历史记录存在
  （`18.81` s / `28.20` s / `219 s` / reserved 8666 MiB 等），**不再代表任何可运行的路径**。
- 客户端 3 个工具都有 `tool.call.toolview` 卡片，设置页有布局样式（含窄栏容器查询）。
  图片显示的**主路径**始终是工具结果里的 Markdown 绝对路径。
