# dsh-image-forge

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

DeepSeek Harness 插件：**Qwen-Image 出图 / 参考图编辑**，并把官方提示词契约的 `wh_ratio` 做成工具的**一等参数**——比例换算像素由插件做，不需要人工翻译。

- 工具：`qwen_image_generate`、`qwen_image_edit`、`qwen_image_status`、`qwen_image_env`；技能：`qwen-image-forge`（意图路由 + 自撰的 T2I / Edit 改写规则）
- 后端三选一：`local`（随包 `resources/worker.py`，自管 venv + CUDA torch + 10.63 GiB nf4 权重与生命周期，**不需要先装 ComfyUI**）、`comfyui`（只经 HTTP 复用你本机已装的实例）、`api`（自带 key 的云端点）；默认 `auto`

## 安装

**从 npm：**

```bash
npm install dsh-image-forge
# 或 dsh plugin --profile <profile> add github:Demerier/dsh-image-forge
```

**从本仓库源码：**

**在本仓库目录内构建出 `lib/`，再装进某个 DSH profile。**

```powershell
# 在本仓库目录内构建出 lib/
pnpm install
pnpm build

# 装进某个 DSH profile
dsh plugin --profile <profile> add <本目录绝对路径>
```

`cordis.yml` 通过 `dsh.bundle.patch` 自动生效，插件注册名 `dsh-image-forge` 与包名一致。⚠️ 若 `pnpm build` 报 `Cannot find package 'ansis'`，本仓库用 `pnpm-workspace.yaml` 固定 `nodeLinker: hoisted` 绕开——删掉 `node_modules` 重装即可。

## 配置

**全部字段都有默认值，下面这 8 个是你几乎只需要关心的。**

| 字段 | 默认 | 说明 |
|---|---|---|
| `backend` | `auto` | `auto` / `api` / `comfyui` / `local` 四选一 |
| `apiKey` | 空 | **建议留空**改用环境变量，key 就不会进 profile 文件 |
| `outputDir` | `~/Pictures/dsh-image-forge` | 图片落盘目录 |
| `timeoutMs` | `180000` | 单次生成预算（ComfyUI 首次冷加载模型很慢，可调到 `900000`） |
| `comfyEndpoint` | 空 | 如 `http://127.0.0.1:8188`；**空 = 自动探测 `comfyPorts`**，非回环地址会被拒绝 |
| `runtimeDir` | `~/.dsh-image-forge` | 插件自己拥有的运行时目录：venv、worker 日志、`worker-state.json` |
| `minFreeVramMiB` | `5500` | **启动前门禁**阈值：空闲显存低于它就拒绝拉起本地 worker（`0` = 关掉这道门禁） |
| `localReferenceBudget` | `0` | 只对 `local` 编辑生效的参考图条件化预算；**`0` = 按画布推导** |

完整 **32** 个字段（含默认值、边界、实测依据）见 [docs/configuration.md](docs/configuration.md)；步数解析优先级 **调用方显式 > 后端专属 `comfyuiSteps`/`localSteps` > `defaultSteps`**，结果里回显 `steps_used` / `steps_source`。
**设置页只展示日常字段 + 本地「一键部署」**（建 venv / 装 torch / 下 10.63 GiB 权重）；解释器路径、镜像、端口等自定义环境项**不外露**，默认值即可，要改写 profile。
Key 读取顺序：`apiKey` → `QWEN_IMAGE_API_KEY` → `DASHSCOPE_API_KEY` → `OPENAI_API_KEY`；key 只在内存里，**不写盘、不进日志**（报错里会被 `<redacted-key>` 顶掉）。

## 用法

**用户说「画一只猫」时，模型先按技能规则把需求改写成契约，再调用工具。**

```json
{"rewritten_prompt": "A wide photograph of …", "wh_ratio": "16:9"}
```

→ `qwen_image_generate(prompt = <rewritten_prompt>, wh_ratio = "16:9")`

`wh_ratio` 7 档（官方）与插件换算出的像素（**~1.5MP 预算**、32 对齐）：

| `wh_ratio` | 像素 | 像素数 | 备注 |
|---|---|---|---|
| `1:1` | 1248×1248 | 1.558 MP | 精确 |
| `4:3` | 1408×1056 | 1.487 MP | 精确 |
| `3:4` | 1056×1408 | 1.487 MP | 精确 |
| `3:2` | 1536×1024 | 1.573 MP | 精确 |
| `2:3` | 1024×1536 | 1.573 MP | 精确 |
| `16:9` | 1664×928 | 1.544 MP | 32 网格上无法精确，偏差 +0.86% |
| `9:16` | 928×1664 | 1.544 MP | 偏差 −0.86% |

落盘命名：`<outputDir>/<prefix>_<W>x<H>_<n>.png`，`prefix` 默认 `qwen`（可用 `preset` 覆盖），编号从 1 起且**跳过已占用的名字**，重复调用不会覆盖旧图。
图片回传：结果里给 `![](绝对路径)` 的 Markdown（客户端会渲染成真图），另有一份 JSON 供机器读。要显式像素就用 `width`/`height`（必须 32 的倍数），**显式值永远优先**。（细目见 docs/usage-reference.md）

## 参考图编辑（图生图）

**用户给了参考图（一张或多张）就是改图任务，走 `qwen_image_edit`；画布比例三选一，`wh_ratio` 与 `ratio_follow` 互斥。**

```text
qwen_image_edit(prompt = <成品改图指令>, images = ["D:\\pictures\\room.png"], ratio_follow = "image1")
```

| 情况 | 传什么 | 画布 |
|---|---|---|
| 用户明说了比例 / 像素 | `wh_ratio`（或 `width`+`height`） | 该比例，~1.5MP 预算、32 对齐 |
| 用户没说，要跟随某张参考图 | `ratio_follow: "image1"`（也可直接写该图在 `images` 里的那个字符串） | 量出该图的实际长宽比 → 32 网格上最接近的一对像素 |
| 用户什么都没说 | 两个都不传 | **默认跟随第一张参考图**（第 1 张就是编辑目标） |

- 路径必须**绝对**（相对路径会被拒绝）；只认 **PNG / JPEG / WebP**（要读文件头拿像素尺寸），也收 `data:image/…;base64,…`；任何一张读不出来都会报错并点名 `images[n]`。
- 后端只有 `comfyui` 与 `local`（都在本机）：`backend: "auto"` 在编辑场景**跳过云 API**（它没有编辑通道，`api_skipped` 如实说明），显式传 `backend: "api"` 会明确报错。
- `wh_ratio` 与 `ratio_follow` **同时给会直接报错**（官方 Edit 契约要求一个非空另一个为空），而不是悄悄选一个；`preset` 默认是 `edit`。

## 提示词模板（按路由）

**先问自己三句：有没有参考图（→ T2I 还是 Edit）？画幅比谁说了算？是下订单、还是只想问怎么写？再照抄下面对应的三段式；完整规则见 [references/t2i_rules.md](references/t2i_rules.md) 与 [references/edit_rules.md](references/edit_rules.md)。**

**① T2I·分区型**（海报 / 页面 / 多物宽景）
- **你这么说**：「给我画一张夏日饮料海报」
- **改写成**：英文**一整段**散文，先背景与承托面 → 顶部带 → 主体横走一遍 → 底部带；比例只进字段，**绝不写进正文**
- **调用**：`qwen_image_generate(prompt = <成品散文>, wh_ratio = "16:9")`

**② T2I·单主体型**（肖像 / 特写 / 单品）
- **你这么说**：「画我的猫的大头照」
- **改写成**：英文一整段散文，先背景与景深 → 姿态 → 头脸 → 身体与衣料 → 手里拿的/贴着它的东西 → 边缘小物
- **调用**：`qwen_image_generate(prompt = <成品散文>, wh_ratio = "1:1")`

**③ Edit·N=1**（只给了一张参考图）
- **你这么说**：「把这张客厅照片改成晚上的」
- **改写成**：只动被点名的那几个属性、其余按输入锁住；**N=1 不加标签**；没说画布就默认跟随第 1 张；`wh_ratio` 与 `ratio_follow` **恰好一个为空**（同时给会被工具拒绝）
- **调用**：`qwen_image_edit(prompt = <成品指令>, images = ["D:\\…\\room.png"], ratio_follow = "image1")`

**④ Edit·N≥2**（两张及以上参考图）
- **你这么说**：「把这张人像里的我放进那张客厅照片里，光线跟着客厅」
- **改写成**：**必须**用 `<image1>`/`<image2>` 逐张说明用途，并**认准哪张是画布图**（合成/放入取目标场景图），不要写「第一张图」
- **调用**：`qwen_image_edit(prompt = <成品指令>, images = ["D:\\…\\person.png", "D:\\…\\living-room.png"], ratio_follow = "image2")`

**咨询**（「这种需求提示词怎么写」）：只给契约结果、**不调用**任何生成工具，等用户点头再出图。

**按后端的建议提法**（每行一句，理由见上文「后端怎么选」）：

| 后端 | 什么时候这么提 |
|---|---|
| `auto`（默认） | 不用提：有 key 走云 API，否则先探本机 ComfyUI、最后落 `local` |
| `api` | 要云上出图就这么提；**它没有编辑通道**，给了参考图会被跳过——编辑必须提本机后端 |
| `comfyui` | **8 GB 卡上编辑就这么提**（`backend: "comfyui"`）：绕开本地编辑尺寸门，且快得多 |
| `local` | 脱离 ComfyUI 依赖时提；编辑要显式给可靠档尺寸（如 `1216×672`）**或**把 `localReferenceBudget` 设 `512`，否则默认画布会被尺寸门默认拒绝 |

## 工具一览

**两个干活的、两个看环境的。**

| 工具 | 说明 |
|---|---|
| `qwen_image_generate` | 出图主入口：`prompt` + `wh_ratio` 一等参数，另有 `width`/`height`、`steps`、`seed`、`count`、`backend`、`preset` |
| `qwen_image_edit` | 参考图编辑（图生图）：`images` 1–10 张绝对路径，`ratio_follow` 与 `wh_ratio` 二选一，只走本机后端 |
| `qwen_image_status` | 只读健康探测：云端点是否可达、key 是否被接受、本机 ComfyUI 在不在跑、worker 六态；不回显 key |
| `qwen_image_env` | 本机环境体检 + 本地运行时管理：`status` / `install` / `fetch-weights` / `unload` / `repair`，都支持 `dryRun:true` |

## 后端怎么选

**`auto` 的次序：有 key 走云 API，否则先试本机 ComfyUI，最后才落到本地 worker。**

- **8 GB 卡上出图与编辑都优先 `comfyui`**：同画布 992×992 的步数扫描里 `comfyui` 0.727 s/步、`local` 2.014 s/步，每步 **2.77×**（两侧量化档不同，别读成纯后端差异）；编辑差得更远——它的联合序列 ≈ 7576 token 把 reserved 顶到 **8666 MiB**、**越过 8188 MiB 物理上限**，驱动走 WDDM 分页，于是每步 20–40 s。
- **本地编辑尺寸门（只在 `local` 后端生效）**：按画布算出的参考图条件化预算 `_reference_budget` **≤ 896** 放行（1216×672 峰值 reserved 7458 MiB）、**897–960** 放行但结果里带警告、**> 960 默认拒绝**；拒绝时给四条出路——① 改用 `comfyui`；② 显式给更小的 `width`/`height`（可靠档 ≤896，例如 1216×672）；③ 把 `localReferenceBudget` 调到 **512**（1.5MP 画布上唯一实测跑得完的档：wall **109.5 s**、峰值 reserved 6488 MiB、worker 存活）；④ 配 `allowLocalEditOverBudget: true` 显式放行。
- 完整论证、逐档实测与 ComfyUI 探测细节见 [docs/backends.md](docs/backends.md)。

## 排障

**先 `qwen_image_status`，再 `qwen_image_env status`。**

## 已知边界

**这几条最容易咬人，装之前先看一眼。**

- 云 API 后端**没有编辑通道**：`qwen_image_edit` 只走本机（`comfyui` / `local`）；显式指定 `backend: "api"` 会明确报错，而**不会把参考图丢掉**。
- 参考图的像素尺寸只认 **PNG / JPEG / WebP** 的文件头；其它容器（含 TIFF、AVIF）会被拒绝并给出原因。
- 没有局部重绘（inpaint / mask）、放大、相册 UI。
- 真实设备上只验证过 **cu126** 这一档（`torch 2.9.1+cu126`）；cu128 / cu118 是同一段矩阵代码里的备选路径，**未在真机下载验证过**。
- ⚠️ **8 GiB 卡上本地编辑有实测的硬墙**：1312×736 画布上 ComfyUI 8 步 ≈ 19–23 s，受管 worker 同样尺寸 6 步要 **219 s**（reserved 8666 MiB > 8188 MiB → WDDM 分页）。
- **判断「某个 pid 还活着」在本机不可靠**：`repair` **只停止本会话自己拉起的那个进程**，历史记录里的 pid 只报告并给出 `taskkill` 命令。
- 客户端 4 个工具都有 `tool.call.toolview` 卡片（出图/改图带图网格，status/env 带摘要），设置页有完整布局样式（含窄栏容器查询）。**设置页与 status 卡片已在真实 web 客户端验过**（`docs/evidence/r7-real-client-verification.md`）；出图/改图卡片的图网格因本机无后端未在真机出图。图片显示的**主路径**始终是工具结果里的 Markdown 绝对路径。

## 测试

**10 个文件 / 153 个用例，全部不需要 GPU、venv 或 10.6 GiB 权重。**

```powershell
pnpm build
pnpm test
```

`ratio 12 / local-edit-budget 16 / surface 9 / api-e2e 8 / comfyui-e2e 9 / worker-lifecycle 21 / edit-e2e 9 / vram-gate 14 / settings 52 / package-contents 3`；真机端到端（`test/live-worker-e2e.mjs` / `test/live-edit-e2e.mjs`）不在 `pnpm test` 里，详见 [docs/testing.md](docs/testing.md)。

## 许可

**本插件自身以 MIT 发布；权重与官方提示词原文都不随包分发。**

- **Qwen-Image-2.1 权重**受 **Qwen RESEARCH LICENSE AGREEMENT** 约束（**限研究用途；商用需自行向权利方取得授权**）：本插件**不随包分发**，`qwen_image_env action:"fetch-weights"` 只**按你的指令**从 `hf-mirror.com` 拉取 `circulus/Qwen-Image-2.1-bnb-4bit`（10.63 GiB）到你的 `modelsDir`。
- **ComfyUI** 是**可选的外部依赖**（GPL-3.0）：本插件不包含、不修改、不分发其代码，只通过 HTTP 与你自己安装的实例通信。
- **官方提示词原文**（`system_prompt_t2i.txt` / `guide_t2i.md` / `guide_edit.md` 等）**不随包分发**；`skill.md` 与 `references/*.md` 是本插件**自撰**的规则文档。完整口径见 [docs/license-and-limits.md](docs/license-and-limits.md)。

## 详细文档

**细节都在这里，按需点开。**

- [docs/configuration.md](docs/configuration.md) —— 32 个配置字段的默认值、边界与实测依据，以及 DSH 设置页。
- [docs/client-bundle.md](docs/client-bundle.md) —— 你要改客户端产物或设置页 UI 时看它：两个 `inject`、lazy-CJS factory 的产物形状。
- [docs/backends.md](docs/backends.md) —— 换后端、调步数、本地编辑跑不动、看 ComfyUI 探测细节时看它。
- [docs/usage-reference.md](docs/usage-reference.md) —— 想知道 1.5MP 画布怎么来的、表外比例（如 `21:9`）怎么处理、worker 六态、`qwen_image_env` 各动作细节时看它。
- [docs/testing.md](docs/testing.md) —— 想跑测试，或想知道每个用例钉住了什么时看它。
- [docs/license-and-limits.md](docs/license-and-limits.md) —— 分发 / 商用前，或排查已知边界时看它。
