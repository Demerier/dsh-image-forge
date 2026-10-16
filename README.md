# dsh-image-forge

DeepSeek Harness 插件：**Qwen-Image 出图 / 参考图编辑**，并把 Qwen 官方提示词契约的 `wh_ratio` 做成工具的**一等参数**。

现有 DSH 出图插件全部只收「成品 prompt」——契约输出的画幅比必须人工翻译成像素宽高。
本插件消除这一步：契约里的 `wh_ratio` 直接传给 `qwen_image_generate`，换算由插件做。

- 工具：`qwen_image_generate`（文生图）、`qwen_image_edit`（参考图编辑 / 图生图）、`qwen_image_status`、`qwen_image_env`
- 技能：`qwen-image-forge`（意图路由 + 自撰的 T2I / Edit 改写规则）
- 后端：`auto`（默认）/ `local` / `comfyui` / `api` 四选一 ——
  **`local` 由本插件自己拥有并管理生命周期**（随包分发 worker 脚本 `resources/worker.py`：拉起 / 健康轮询 / 掉线重拉 /
  空闲回收显存，并自带 `install` / `fetch-weights` 两个环境动作——venv + CUDA torch + 10.63 GiB 的 nf4 权重，走
  hf-mirror.com，**不需要你先装 ComfyUI**）；`comfyui` 复用你本机已装的实例（只经 HTTP 通信，不含也不分发其代码）；
  `api` 是自带 key 的云端点。`auto` 的次序见下文「后端」；**8 GB 卡上出图 / 编辑都建议显式用 `comfyui`**（速度与画质）

---

## 安装

```powershell
# 在本仓库目录内构建出 lib/
pnpm install
pnpm build

# 装进某个 DSH profile
dsh plugin --profile <profile> add <本目录绝对路径>
```

`cordis.yml` 通过 `dsh.bundle.patch` 自动生效；插件注册名 `dsh-image-forge` 与包名一致。

> 本机构建提示：若 `pnpm build` 报 `Cannot find package 'ansis'`（tsdown 找不到自己的依赖），
> 说明 pnpm 的符号链接布局在本机对 Node 的 realpath 不透明。本仓库用 `pnpm-workspace.yaml`
> 固定 `nodeLinker: hoisted` 绕开它；删掉 `node_modules` 重装即可。

## 配置

在 profile 的插件配置里给出（全部有默认值，`Config` schema 见 `src/index.ts`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `backend` | `auto` | `auto`（有 key 走 api，否则先试本机 ComfyUI，再退到 local）/ `api` / `comfyui` / `local` |
| `apiBaseUrl` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 云端点（OpenAI 兼容） |
| `apiKey` | 空 | **建议留空**，改用环境变量，key 就不会进 profile 文件 |
| `apiModel` | `qwen-image` | 模型 id——**以你的供应商文档为准** |
| `apiStyle` | `openai` | `openai` 已实现；`dashscope`（原生异步任务 API）为扩展点，调用时会明确报未实现 |
| `outputDir` | `~/Pictures/dsh-image-forge` | 图片落盘目录 |
| `timeoutMs` | `180000` | 单次生成预算（ComfyUI 首次冷加载模型很慢，可调到 `900000`） |
| `localEndpoint` | `http://127.0.0.1:8399` | 本地 worker 端点 |
| `comfyEndpoint` | 空 | ComfyUI 地址，如 `http://127.0.0.1:8188`；**空 = 自动探测 `comfyPorts`**。非回环地址会被拒绝（见「后端」） |
| `comfyPorts` | `8000,8188,8189,8190,8191,8192` | `comfyEndpoint` 为空时依次尝试的端口（桌面版常见 8000，便携版 8188） |
| `comfyModelsDir` | 空 | ComfyUI 的 `models` 根目录，**只用于报错里写清「文件该放到哪」**；不填则错误只给相对路径 |
| `runtimeDir` | `~/.dsh-image-forge` | 插件自己拥有的运行时目录：venv、worker 日志、`worker-state.json` |
| `modelsDir` | 空 | nf4 权重目录；空 = `<runtimeDir>/models/qwen-image-2.1-bnb4bit` |
| `modelRepo` | `circulus/Qwen-Image-2.1-bnb-4bit` | `fetch-weights` 的仓库 |
| `hfMirror` | `https://hf-mirror.com` | 下载镜像。**别改成 huggingface.co**：它根路径通，但 `/api/` 会超时，下载会卡死 |
| `workerPorts` | `8399-8410` | worker 候选端口（`localEndpoint` 的端口优先）；被占就顺延 |
| `workerStartTimeoutMs` | `300000` | 冷启动预算（要读 10.6 GiB 权重）；工具总预算取它与 `timeoutMs` 的较大者 |
| `idleUnloadMs` | `600000` | 空闲多久就把显存交回（`POST /unload`，进程留着）；`0` = 不回收 |
| `manageWorker` | `true` | 允许插件自己拉起/重拉 worker。`false` 时只采用别人起好的 worker |
| `pythonPath` | 空 | worker 解释器；空 = `<runtimeDir>/venv` 里的那个 |
| `workerScript` | 空 | worker 脚本；空 = 随包的 `resources/worker.py`（调试/测试时可换） |
| `basePython` | 空 | `install` 用来建 venv 的基础解释器；空 = 依次试 `python` / `python3` / `py` |
| `torchWheels` | 空 | 空 = 设备矩阵 `cu128,cu126,cu118` 逐级降级 |
| `pipIndexUrl` | 空 | 非 torch 包的索引地址（内网镜像）；空 = 默认 PyPI |
| `reuseBaseTorch` | `true` | 基础解释器里已有 CUDA torch 就以 `--system-site-packages` 复用，**不重复下载 torch** |
| `minFreeVramMiB` | `5500` | **启动前门禁**的阈值，也是 `status` 的预警线：空闲显存低于它，插件**拒绝拉起本地 worker**（点名占用者 + 给出 `POST /free` 命令），而不是硬起。`0` = 关掉这道门禁。⚠️ 它守的是**加载那一次约 4.5 GiB 的分配**，**不是**编辑画布尺寸——编辑的画布上限由「本地编辑尺寸门」管（见「后端」），那道门的失败形态也不是显存不足 |
| `freeComfyBeforeLocalStart` | `false` | **显式 opt-in**：门禁发现显存不够时，是否允许插件替你给 ComfyUI 发 `POST /free {"unload_models":true,"free_memory":true}` 再启动 worker。**默认 false**——卸载别人的模型是用户没授权的副作用，所以默认只报错 + 给命令，**一个请求都不发** |
| `allowLocalEditOverBudget` | `false` | **显式 opt-in**，只对 `local` 后端：放行**超出本地编辑尺寸门**的改图请求（**生效的**参考图条件化预算 `_reference_budget` > 960，见下一行的旋钮）。默认 false = **直接拒绝**，因为本机实测那条线上 ≥1216 是**访问违例 / worker 进程消失**、992–1024 是 GPU 去噪 OOM，都不是「腾显存」能修的。`comfyui` 不受这道门约束 |
| `localReferenceBudget` | `0` | 只对 `local` 后端的编辑：**显式**参考图条件化预算（每边像素），随 `/generate` 的 `reference_budget` 字段发给 worker。**`0` = 按画布推导**（worker 自己那套公式，行为与没有这个字段时逐位一致）。调低它 = **降低参考图条件化分辨率**，换来速度与可跑性——保真度：同画布（1216×672）896 vs 512 目视看不出差别（n=1、1 位评判者）；1.5MP 画布上只测了 512。它让 **1.5MP 画布 + 512** 这一种组合变得可跑（尺寸门按**生效的**预算判定，所以 512 + 1248×1248 画布是放行的，实测 wall **109.5 s**）；**896 不在此列**——同一张 1248×1248 用 896 实测 67 s/步、25 步外推 ≈28 min（不报错，等于不可用）。出图尺寸不受它影响。§19 实测 992 → 512：编码 37.7 → 16.5 s、每步 3.4 → 1.67 s |
| `skipLmHead` | `false` | `fetch-weights` 的默认值：是否剔除管线从不读取的 `lm_head.weight`（约 1187 MiB，**本机未验证**） |
| `defaultSteps` | `25` | **默认采样步数**。两个后端都没单独指定时用它。默认 25 = 官方 ComfyUI 2.1 模板口径 |
| `comfyuiSteps` | 空 | ComfyUI 专用步数；**空 = 用 `defaultSteps`** |
| `localSteps` | 空 | 本机 worker 专用步数；**空 = 用 `defaultSteps`**。⚠️ 填 `8` = 快但非官方口径（见「步数」） |

**步数与后端口径**：历史上三个口径互不相同——官方 diffusers 管线 40 步、官方 ComfyUI 2.1 模板 25 步、
本插件 worker 原来是 8 步兜底。于是 `backend: "auto"` 下一旦换后端（例如没装 ComfyUI 就落到 local），
画质与风格会跟着变而没有任何提示。现在统一由**解析优先级**决定，并在结果里回显：

```
调用方显式传的 steps   >   后端专属（comfyuiSteps / localSteps）   >   defaultSteps
```

结果里恒带 `steps_used`（实际步数）与 `steps_source`（`explicit` / `backend` / `default`），
所以「为什么这张不一样」可以直接从返回值回答。解析发生在**每次派发时**，因此 ComfyUI 不可用而回退到 worker 时，
用的是 worker 自己的口径，而不是把 ComfyUI 的步数带过去。

**「更大不等于更好」的实测**：同提示词、同 seed 下 25 → 50 步，客观指标反而**变差**——
lapvar **1019 → 970**、hf_frac **0.0317 → 0.0279**（高频占比变小 = 没有更多细节），用户目视也说 25 步更好。
官方 ComfyUI 2.1 模板同样是 25 步，所以默认值就是 25；`defaultSteps` **没有被锁死**，仍可自由配置，
只是默认值与文档按实测走。**要更多细节就把画布提上去，不是把步数堆上去。**

**Key 的读取顺序**：`apiKey`（config）→ `QWEN_IMAGE_API_KEY` → `DASHSCOPE_API_KEY` → `OPENAI_API_KEY`。
key 只存在于内存，随 `Authorization: Bearer` 发出；**不写盘、不进日志**，报错信息里会被 `<redacted-key>` 顶掉。

## 设置页（DSH Web GUI）

除了在 profile 里手写配置，**上面这 32 个字段都能在 DSH 设置页里读和写**：

- 菜单位置：**设置 → 「Qwen 出图」**——这是和「通用设置 / 模式 / 插件 / Agent 预设」同级的**一级菜单项**
  （注册进 `settings.section` 这个 **list 槽**，用 `id` 定位）。
- 字段按用途分成七块，不是一张平铺的长表：

  | 分区 | 字段 |
  |---|---|
  | 后端选择 | `backend` |
  | 步数（画质与耗时） | `defaultSteps`、`comfyuiSteps`、`localSteps` |
  | 云端 API | `apiBaseUrl`、`apiKey`、`apiModel`、`apiStyle` |
  | 本地运行时 | `runtimeDir`、`modelsDir`、`modelRepo`、`hfMirror`、`localEndpoint`、`workerPorts`、`workerStartTimeoutMs`、`idleUnloadMs`、`manageWorker`、`minFreeVramMiB`、`freeComfyBeforeLocalStart`、`allowLocalEditOverBudget`、`localReferenceBudget` |
  | ComfyUI | `comfyEndpoint`、`comfyPorts`、`comfyModelsDir` |
  | 输出与超时 | `outputDir`、`timeoutMs` |
  | Python、依赖与权重（高级） | `pythonPath`、`workerScript`、`basePython`、`torchWheels`、`pipIndexUrl`、`reuseBaseTorch`、`skipLmHead` |

- **`apiKey` 只写不读**：输入框是密码框，已保存的密钥永远只显示成掩码（`••••••••`），
  留空表示「不修改已保存的密钥」。保存失败时的提示里也不会出现密钥内容。
- `backend` / `apiStyle` 是**下拉**，数值字段带默认值与上下限提示，其余是文本框（带说明文案）。
- `comfyuiSteps` / `localSteps` 是**可留空**的：清空输入框并失焦 = 写回「未设置」，也就是回落到 `defaultSteps`。
  分区文案里直接写清了取舍（`localSteps: 8` 快但不是官方口径；`25` 对齐官方，约慢 2.7 倍）。

**路径类字段要么给出探测到的真实值，要么在文案里说清「留空 = 什么」。** 页面上直接能看到实际会用哪个：

| 字段 | 默认值 | 会不会陈旧 |
|---|---|---|
| `runtimeDir` / `outputDir` | 家目录派生（截图见 README 上文） | 不适用（本身就是可改的源） |
| `modelsDir` | **空**；文案写「留空 = 跟随运行时目录：`<运行时目录>\models\qwen-image-2.1-bnb4bit`」 | **不会** —— 文案里的路径按**当前** `runtimeDir` 实时替换 |
| `pythonPath` | **空**；文案写「留空 = 跟随运行时目录：`<运行时目录>\venv\Scripts\python.exe`」 | **不会** —— 同上 |
| `workerScript` | 随包资源实值：`<插件目录>\resources\worker.py` | **不会** —— 不派生自 `runtimeDir` |
| `basePython` | **`existsSync` 探测**：PATH 上的 `python`/`python3` → 安装目录 | **不会** —— 同上 |
| `comfyModelsDir` | **`existsSync` 探测**：候选目录列表 | **不会** —— 同上 |

- **为什么 `modelsDir` / `pythonPath` 刻意留空**：它们由 `runtimeDir` 在**解析时**推导。
  若把默认值写成实值，就会**冻结在默认的 `runtimeDir` 上** —— 用户一旦改了 `runtimeDir`
  （这是我们**鼓励**的操作：指向已装好的目录可省掉 13 GiB 下载），权重与 venv 就会**静默指向旧位置**。
  **一个会静默变陈旧的实值框，比一个空框加一句写清规则的文案更糟。** 所以规则进文案、实值不进默认值。
- 文案里那个 `<运行时目录>` 是**渲染时用当前值替换**的（`resolveHint`），所以既看得见、又不会陈旧。
  替换需要客户端知道路径，而页面元数据是打进浏览器包的、用不了 `node:os`/`node:path` —— 所以走「模板 + 实时替换」而不是「源头写死绝对路径」。
- 探测**找不到就留空**，此时回落到工具层原有的 `python` / `python3` / `py` 兜底 —— **绝不编一个不存在的路径**。
- **不做网络探测**。`comfyEndpoint` 刻意保持空（文档语义就是「留空 = 按 `comfyPorts` 探测」，在构造 schema 时开 socket 是坏味道），
  所以它的文案直接把端口写出来：`留空 = 依次探 8000/8188/8189/8190/8191/8192。`
  同理 `torchWheels` = `留空 = 依次试 cu128、cu126、cu118。`、`pipIndexUrl` = `留空 = https://pypi.org/simple。`

**页面上只放结论；论证在这里。** 设置页那条性能说明是**两行**（推荐 + 一句数字），
下面这些实测细节**只在本 README 里**——2024 年那次真机评审时，用户的第一反应是页面「暴露了相当多并不适合展示给用户的解释性文本」，
所以现在有**文本预算测试**（`test/settings.test.mjs`）钉死：字段 hint ≤ 40 字、分组 hint ≤ 20 字、
说明块 ≤ 400 字；而「证据必须留在 README」也有断言守着，两边都不能悄悄搬家。

- 完整证据（页面上已不再出现）：步数扫描拟合出的**斜率**（而不是「总时长 ÷ 步数」）：

  | 后端 | 量化档 | 斜率 | 截距 |
  |---|---|---|---|
  | `comfyui` | `int8-convrot` | **0.727 s/步**（复测 0.768） | 1.60 s |
  | `local`（本插件 worker） | bnb `nf4` | **2.014 s/步**（11 个稳态样本，2.012–2.016） | — |

  ⇒ **每步倍率 2.77×**（同一台机、同一画布 992×992、同一 prompt、seed 0，两侧都是 1 次前向/步，已确认）。
  ⚠️ **两侧量化档不同**，所以 2.77× **不是纯「后端差异」**，里面含量化档差异，不能读成「换个后端就能拿回 2.77 倍」。

  端到端实测（不含权重加载）：

  | 步数 | `local` | `comfyui` | 倍率 | `local` 固定开销占比 |
  |---|---|---|---|---|
  | 1 | 13.39 s | 2.21 s | 6.06× | 67.6% |
  | 2 | 14.69 s | 2.94 s | 5.00× | 56.5% |
  | 4 | 18.81 s | 4.90 s | 3.84× | 43.6% |
  | 8 | 28.20 s | 7.27 s | 3.88× | 34.8% |

  - `local` 的**固定开销** = CPU 文本编码 8.2–9.8 s + VAE 解码 1.9 s + PNG 0.1 s ≈ **10.2–11.8 s**，与步数无关。
    倍率随步数下降就是它被摊薄的结果 —— 早期「总时长 ÷ 步数」得到的是摊薄之后的数，于是把倍率**显著高估**了；
    本仓库早先给过的那个跨后端倍率（以及 `992×992 / 4 步 ≈ 37 s` 那行）就是这样来的，已被上面的斜率取代。
    `37 s` 经步数扫描复现不出来（4 步实测 18.81 s），**按受污染的历史读数处理，已从表中删除**。
  - 参考图编辑（1312×736 / 6 步）的**总时长**：纯管线 **219 s**、端到端 **260 s**（含约 12.6 s 冷启动与传输）。
    **两个数口径不同，不是两次不同的测量**；它们是总时长，不是每步成本。
  - **两块各自的把握程度**：
    - **【参考图编辑（长序列）】已定位** —— 前缀 KV cache 使 `reserved` 越过 8188 MiB 物理上限
      （实测 8666 MiB）→ 驱动走 **WDDM 分页**；对照实验（A/B/A/B 交替 + 每次 `empty_cache()`）：
      cache 开 24.06 / 23.20 s/步、关 3.40 / 3.40 s/步，**7 倍、可复现、与顺序无关**。
      **这是同工况内的对照，不依赖跨后端换算**，所以站得住。
      ⇒ **8 GB 显存上做参考图编辑，请优先用 `comfyui` 后端。**
      （这条结论现在也在工具层兜住：**本地编辑尺寸门**默认拒绝 `_reference_budget` > 960 的 local 编辑，
      见「后端 → 本地编辑尺寸门」。）
    - **【文生图（短序列）】已定位：每步 2.77×，成本在 bf16 GEMM** —— 一步的内核画像（@992²、3844 token）：
      cutlass **bf16 tensor-core GEMM 占 60.3%**（329 次调用）、mem-efficient 注意力 14.1%、
      20 多个小核合计 22.9%，而 **nf4 反量化只占 3.4%**（`kDequantizeBlockwise`，334 次调用）。
      ⚠️ **bitsandbytes 自己的 4-bit GEMM 只被调用 5 次、合计 0.33 ms —— 等于没用到**：权重先被反量化成
      bf16 再走 bf16 GEMM。⇒ 主要成本是 **bf16 GEMM，不是「反量化慢」**。
      这是与 ComfyUI 真·低比特 GEMM（`convrot_w4a4_linear`）之间的**结构性差距：要换推理栈才能改，
      超出本插件的范围**，本插件不把它记作待办、也不给出改善承诺。
      已实测排除：注意力后端（默认 == 强制 `mem_efficient`；flash 本机不可用；ComfyUI 侧同样是 pytorch attention）、
      文生图下的 `use_kv_cache`（A/B/A/B 只差 24 MiB）、每步 CPU↔GPU 往返、scheduler、文生图分页；
      另测 fp16 compute 反而慢 8%、CUDA Graphs 无意义（启动开销约 0.5%）。
  - ⚠️ **一个会让人卡住的显存陷阱（8 GB 卡必读）**：ComfyUI 跑完会留下约 **3.6 GiB** 的 `cudaMallocAsync`
    分配器缓存，而 `nvidia-smi --query-compute-apps` **列不出占用进程** —— 于是门禁会看到
    「**没有占用者，但显存不足**」。有效补救只需 `POST /free` + `{"unload_models":false,"free_memory":true}`。
    ⇒ 所以在 8 GB 卡上，**`freeComfyBeforeLocalStart` 实际上是「必需项」而不是「可选优化」**
    （该字段的说明文案已同样写明；**默认值不变**，仍是 `false`）。
    门禁的文案按这两种情形分开写：**报得出占用者**时直接点名并给命令；**一个都报不出来**时不再写成
    「没有进程被报为占用者（可能是别的会话或驱动侧的占用）」这种含糊话，而是明说这是分配器缓存的形态，
    并按顺序给 `POST /free` → 「隔十几秒再重试（`OSError 1455`）」→ `freeComfyBeforeLocalStart: true`。
    门禁**放行**但当时确实有占用者时（余量够加载、不够后续去噪），结果里 `vram_gate.warning` 同样点名它们。
  - 这一块是**静态说明**，不做动态探测。文案纪律由 `test/settings.test.mjs` 守住：
    结论性措辞（`已定位`/`WDDM`/`对照实验`）**必须**出现在已定位的 finding 里且**必须**带实测数字；
    同时**全块禁止**任何修复承诺（`正在优化` / `即将修复` / `预计` / `会修好` / `保证` 一律测试失败），
    并**禁止**任何被撤回或被证伪的数字（`8 倍` / `15 倍` / `7.75` / `0.98` / `37 s` / `口径存疑`）重新出现。
- **保存即写入**：改动直接落到本插件的配置里，不需要重启。写入是**带 revision 校验**的——
  如果同一份配置在别处被改过（比如你手改了 profile 文件），这次写入会被拒绝并**重新读取**当前值，
  页面会明确报「已在别处被修改，请核对后重试」，而不是拿过期值覆盖别人的改动。
- 配置条目为只读时（宿主把该条目标成不可写），页面会直接说明**无法保存修改**，并且**一个写请求都不会发出去**。

> 这一节要生效，要求 DSH **0.2.0-rc.2 或更高**：0.1.18 起一级入口才改为 `settings.section` 槽，
> 且 0.2.0 的设置模型才由宿主按插件自身的 `Config` schema 生成可写页面（字段需标 `volatile()`）。
> 插件的一半（工具与技能）在更老的 DSH 上照常可用——**设置页不可用时不会影响出图工具**。

### 客户端加载须知（两个 inject 不是一回事）

这份 `package.json` 里有**两个 `inject`**，它们在不同的层、要填不同的东西 —— 混淆过一次，
症状是 web 客户端启动时报 `import failed` / `did not activate`：

| 位置 | 填什么 | 当前值 |
|---|---|---|
| `package.json` → `dsh.client.inject` | **客户端模块的包名** | `@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-renderer` |
| `src/client.ts` → `export const inject` | **cordis 服务名** | `['slots', 'configForms']` |

- 前者是「先把这些客户端模块加载起来」的清单，只接受**能解析到的包名**（参照实现里 20 个插件的值
  全是 `@deepseek-ai/dsh-client-*` / `@deepseek-ai/dsh-api-*`；写裸服务名如 `"slots"` 会解析失败）。
- 后者是 cordis 的依赖声明：`slots` 是槽注册表，`configForms` 是本分区绑宿主原生表单用的服务
  （**所有**在参照实现里带设置分区的插件都声明了它）。
- 关于 `immediately`：DSH 官方模板里**有**这个字段（`templates/decoration/package.json`），
  但本机已安装的 20 个 `dsh.client` 插件**都没用它**。本仓库**不再使用**它。
  **这里必须说清楚：它既不是病根、也不是禁令** —— 当初删掉它是因为它同时不符合本地惯例，
  而真正导致 `import failed` 的是产物格式（见下一节）。

### 客户端产物必须是 lazy-CJS factory（否则 web 端直接起不来）

**`lib/client.js` 不是 ESM 模块，`lib/index.js` 才是。** 两个半边是两种不同格式，别一起改：

- **宿主半边** `lib/index.js`：普通 ESM，宿主用 `import()` 加载它。
- **浏览器半边** `lib/client.js`：**只注册一个惰性 factory**，由 web 客户端求值：

  ```js
  window.__ModuleLoader__.load({
    id: "dsh-image-forge",              // 必须 = 包名
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      …
      return module.exports;            // 只发布 apply 与 inject
    }
  });
  ```

  执行 bundle **只注册 factory**；所有模块体副作用（含 CSS 注入）都在 factory 闭包里，等到物化时才跑。
  React 来自 shell 预置的**冻结模块表**（`PLATFORM_MODULES`），因此走 factory 的 `require("react")`，
  **既不打包进来、也不写进 `dsh.client.external`**（它已在基线表里）。而且必须**单文件、零相对
  `require`** —— loader 只物化这一个 bundle，不能同步解析同级的 `client*.js`。

  这条由 **`tsdown.client.config.ts`** 负责（CJS 输出 + banner 开 factory + footer 关 factory），
  由 `pnpm build` 跑两趟：`tsdown && tsdown -c tsdown.client.config.ts`（第二条**不能开 `clean`**，
  否则会删掉同一目录里的 `lib/index.js`）。

  > ⚠️ **为什么这件事必须写成断言**：顶层 `import` 的 ESM bundle **什么都不注册**，客户端只会报
  > `import failed` —— 而本仓库的 Node 测试**从不求值浏览器 bundle**，所以这个错误能在 100+ 个
  > 全绿用例下存活到第一次真机加载。`test/settings.test.mjs` 现在钉住：产物含
  > `window.__ModuleLoader__.load`、`id: "dsh-image-forge"`、`require("react")`、`return module.exports`，
  > **恰好只发布 `apply` / `inject`**，且**不含任何顶层 `import`/`export` 语句、不含相对 require、
  > 不含打包进来的 React**。

## 用法

用户说「画一只猫」时，模型先按技能规则把需求改写成契约，再调用工具：

```json
{"rewritten_prompt": "A wide photograph of …", "wh_ratio": "16:9"}
```

```text
qwen_image_generate(prompt = <rewritten_prompt>, wh_ratio = "16:9")
```

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

**为什么从 1MP 提到 ~1.5MP**：同提示词、同 seed、同为 16:9 的干净对照（1312×736 vs 1664×928）里
**1664×928 更好**——1MP 档那种「材质假、像贴图」的观感在高一档画布上才起来。
这张表是**钉死的常量**（`src/ratio.ts` 的 `DEFAULT_SIZES`），不是搜索出来的：在 32 网格上按
「比例偏差 + 0.5 × 像素预算偏差」打分，1.5MP 档给 `16:9` 的最优解是 1632×928——分数更低，
但形变 +1.1%，不是本产品要公布的画布。七个值都过「能被 32 整除」与「比例偏差 < 3%」两条检查
（`test/ratio.test.mjs` 逐个钉住）。比例**先约分再查表**，所以 `2048:1152` 这种参照图会落到同一张
`16:9` 画布上；**表外**的比例（`21:9`）仍走搜索：最小化「比例偏差 + 0.5 × 像素预算偏差」，同分取更大的画布。
`local` 后端也用同一张表——本机实测（RTX 4070 Laptop 8188 MiB，nf4 worker，25 步）**文生图**的 1248×1248 与
1664×928 自报峰值都是 **reserved 5680–6016 MiB / allocated 5349–5358 MiB**，离 8188 MiB 至少
还有 2.1 GiB 余量，所以没有按后端分表；**文生图这条路也没有加显存阈值护栏**（护栏加在编辑路径上，
而且是一道**尺寸门**，不是显存门——见「本地编辑尺寸门」）。

> ⚠️ **上面这组数字只覆盖文生图，完全不覆盖参考图编辑**（本仓库早些时候把它读成「编辑也没问题」，
> 那是过期依据）。同一张卡上编辑路径是另一个量级，实测：可靠上限是参考图条件化预算
> **`_reference_budget` ≤ 896**（例如 1216×672，峰值 reserved **7458 MiB**，3/3 次一致）；
> **928–960 贴边**（960×960 峰值 reserved **8492 MiB 已超过卡总量 8188 MiB**，靠 WDDM 共享内存撑住）；
> **≥992 在 GPU 去噪段 CUDA OOM**（碎片签名）；**≥1216 在 CPU 文本编码段以访问违例崩掉**，
> 有时直接带走 worker 进程（同一张 1248×1248 画布：t2i reserved 5700 MiB，edit 500）。
> ⚠️ **896 这条可靠线只按预算分档，画布自身的代价不在内**：它的实测出处是 1216×672（0.82 MP，1.9 s/步）；
> 同一预算搬到 1.5MP 画布（1248×1248）上实测 **67 s/步**、25 步外推 ≈28 min（**不报错**，但等于不可用）——
> 那张画布上唯一实测跑得完的是 **512**（wall **109.5 s**、峰值 reserved **6488 MiB**、worker 存活）。
> 依据与逐次原始记录：`docs/evidence/r4b-local-edit-failures.md` §(a)/§(b)、`docs/evidence/r5-budget-canvas-matrix.md`。
要显式像素就用 `width`/`height`（必须 32 的倍数，否则报错并给出最近的合法值）——**显式值永远优先**。

落盘命名：`<outputDir>/<prefix>_<W>x<H>_<n>.png`，`prefix` 默认 `qwen`，可用 `preset` 覆盖；
编号从 1 起且**跳过已占用的名字**，所以重复调用不会覆盖旧图。

图片回传：工具结果里给出 `![](绝对路径)` 的 Markdown（客户端会渲染成真图），
另有一份 JSON 供机器读；客户端侧注册了 `tool.call.toolview` 的 `qwen_image_generate` 槽做卡片显示。

## 参考图编辑（图生图）

用户给了参考图（一张或多张）时，这是**改图任务**，走 `qwen_image_edit`：

```text
qwen_image_edit(prompt = <成品改图指令>, images = ["D:\\pictures\\room.png"], ratio_follow = "image1")
```

**画布比例三选一，`wh_ratio` 与 `ratio_follow` 互斥**（官方 Edit 契约要求「一个非空另一个必须是空字符串」；
同时给会**直接报错**并把这条契约理由写进消息，而不是悄悄选一个）：

| 情况 | 传什么 | 画布 |
|---|---|---|
| 用户明说了比例 / 像素 | `wh_ratio`（或 `width`+`height`） | 该比例，~1.5MP 预算、32 对齐 |
| 用户没说，要跟随某张参考图 | `ratio_follow: "image1"`（也可直接写该图在 `images` 里的那个字符串） | 量出该图的实际长宽比 → 32 网格上最接近的一对像素 |
| 用户什么都没说 | 两个都不传 | **默认跟随第一张参考图**（第 1 张就是编辑目标） |

- 分辨率由插件**量参考图的实际像素头部**得到：2048×1152（正好 16:9）→ 1664×928（偏差 +0.86%）、
  1664×928（本身就是那张公布画布）→ 原样 1664×928（偏差 0）。返回里的 `ratio_deviation_percent` / `exact_ratio`
  说明这次取整，`ratio_follow_image` 说明跟的是哪一张；`images[]` 里每张的 `width`/`height` 也一并回报。
- 参考图就是**图片字节**：路径必须**绝对**（相对路径会被拒绝，理由写在报错里），也收 `data:image/…;base64,…`。
  只认 PNG / JPEG / WebP（要读文件头拿像素尺寸）。**任何一张读不出来都会报错并点名 `images[n]`**——
  静默丢一张会让提示词里的 `<imageN>` 全部错位。
- 后端只有两个：`comfyui` 与 `local`（都在本机）。`backend: "auto"` 在编辑场景**跳过云 API**
  （它没有编辑通道），返回里的 `api_skipped` 如实说明；显式传 `backend: "api"` 会明确报错。
- 落盘命名与文生图一致，`preset` 默认是 `edit`（`<outputDir>/<prefix>_<W>x<H>_<n>.png`）。

## 工具一览

| 工具 | 说明 |
|---|---|
| `qwen_image_generate` | 出图主入口。`prompt`（成品，必填）、`wh_ratio`（一等参数，官方 7 档）、`width`/`height`（可选覆盖）、`steps`、`seed`、`count`(1–4)、`transparent`、`backend`（`auto`/`api`/`comfyui`/`local`）、`preset` |
| `qwen_image_edit` | **参考图编辑（图生图）**。`prompt`（成品修改指令，必填）、`images`（1–10 张绝对路径或 `data:image/…;base64,…`，必填，按序对应 `<image1>`…）、`ratio_follow`（画布跟随某张参考图的宽高比；`image1`… 或该图在 `images` 里的原字符串）、`wh_ratio`（**与 `ratio_follow` 互斥**）、`width`/`height`、`steps`、`seed`、`count`、`transparent`、`backend`、`preset`（默认 `edit`）。编辑只在**本机**后端跑：`comfyui` / `local`；`api` 没有编辑通道，会明确报错而**不丢参考图** |
| `qwen_image_status` | 后端健康探测：云端点是否可达、key 是否被接受（401/403 会点名）、**本机 ComfyUI 是否在跑**（探了哪几个端口、三个权重能不能枚举到）、本地 worker 的六态与最近一次启动失败原因。**只读**，不会拉起或杀掉任何进程；**不回显 key** |
| `qwen_image_env` | **本机环境体检 + 本地运行时管理**。`status`（默认）报告 GPU/驱动、**显存余量（低于阈值就预警，并指名是谁占着——例如 ComfyUI 常驻 2.9 GiB，给出它的 `POST /free` 命令）**、宿主内存、磁盘、输出目录、三端点应答，以及 venv/权重/worker 的就绪情况与 worker 的六态之一（`never-started` / `starting` / `ready` / `unloaded` / `load-failed` / `not-responding`）。`install`（建 venv + CUDA torch，cu128→cu126→cu118 逐级降级，已装 CUDA torch 就复用）、`fetch-weights`（hf-mirror.com 下载 10.63 GiB，查磁盘 + 断点续传 + sha256）、`unload`（`POST /unload` 交回显存）、`repair`（能修就修，不能修明确报因 + 给下一步）。三者都支持 `dryRun:true` 只看计划 |

排障顺序：先 `qwen_image_status`，再 `qwen_image_env status`。

## 后端

- **云 API（已实现）**：`POST {apiBaseUrl}/images/generations`，OpenAI 图片接口形状
  （`{model, prompt, n, size:"WxH", response_format:"b64_json", seed?, steps?, transparent?}`），
  兼容阿里云百炼的 OpenAI 兼容端点。原生 DashScope 异步任务 API 仅留扩展点。
- **本地 worker（本插件自带并管理生命周期）**：随包分发 `resources/worker.py`（diffusers + bitsandbytes nf4，
  文本编码器留在 CPU、transformer 在 GPU、**VAE tiling 强制开启**）。冻结的对外契约不变：
  - `GET  {localEndpoint}/health` → 2xx 表示**模型已加载**
  - `POST {localEndpoint}/generate` → 请求 `{prompt, width, height, count, steps?, seed?, transparent?, images?}`，
    应答 `{images:[<base64 | data:URI | {b64_json}>]}`（也接受 `data[]` / `output[].image`）。
    `images?` 是**可选的编辑扩展**：最多 10 张 base64（或 `data:` URI）参考图，按序对应提示词里的 `<imageN>`；
    **不传就是原来的纯文生图请求**，所以这个字段对两侧都是纯增量，旧 worker / 旧插件各自照旧。
    请求里的 `width`/`height` 由插件侧定好（`ratio_follow` 在插件里换算成像素，worker 从不自己改画幅）。
  - 本插件另加三个端点供自己使用：`GET /state`（进程活着就 200，加载中也算，用来把「在加载」和「已经死了」分开）、
    `POST /unload`（交回显存，进程留着）与 `POST /shutdown`（自己退出；插件停 worker / 被 dispose 时用它）

  **生命周期由插件拥有**：`localEndpoint` 上没人就自己按 `workerPorts` 选端口拉起（`stdout/stderr` 重定向到
  `<runtimeDir>/logs/worker-<port>.log`，**不用管道**——管道在本机沙箱会被拒，而且会随父进程消失，正好丢掉最需要的日志）；
  持有子进程句柄并监听 `exit`，所以「worker 被外部强杀」是**当场知道**的，不是等下次调用才发现；
  连接层失败时重建一次并重试；启动失败会连**最后一次 stderr 尾部**一起报出来，并在 `RESTART_COOLDOWN_MS`
  内不再重复拉起（避免调用风暴）；空闲 `idleUnloadMs` 后自动 `POST /unload`。
  已经跑着的 worker（包括别人起的、只实现冻结契约的旧 worker）会被**采用**而不是抢占；
  `localEndpoint` 端口上是个不相干的 HTTP 服务时会顺延下一个端口。
  停 worker 走 `POST /shutdown` 而不是 kill：Windows 上 venv 的 `python.exe` 是个**转发器**，
  插件 spawn 到的 pid 并不是真正持有模型的那个解释器，直接 kill 会留下一个占着 4.5 GiB 显存的孤儿进程
  （实测 dispose 后显存 5457 MiB → 0 MiB，端口释放）。
  没有 worker 又起不来时，错误会说明是「解释器不存在（先敲 `install`）」「端口全被占」「启动超时（附日志尾部）」
  还是「起来就退出（附退出码与 stderr）」，而不是笼统地说「连不上」。

  **启动前显存门禁**：拉起 worker **之前**先读一次显卡（复用 `status` 的 holders 探测，见 `src/env.ts`）。
  余量低于 `minFreeVramMiB` 时不硬起，而是抛出一条可执行的错误：谁占着（pid / 进程名 / MiB，是 ComfyUI 就带端口）、
  还差多少 MiB、以及可以直接粘贴的补救命令。为什么值得拦：**本机实测**，显存不够时 worker 在**加载阶段**以
  `exit 3221225477 = 0xC0000005 ACCESS_VIOLATION` 结束——CUDA / 驱动在显存分配失败时直接让进程访问违例退出，
  根本不抛 Python 的 OOM，所以用户只会看到一个毫无信息量的退出码。
  这道门禁默认**不动任何别的程序**：`freeComfyBeforeLocalStart: true` 才允许它替你发那条 `POST /free`，
  并且结果里会如实回执（`vram_gate.freed_comfy`）；默认路径连一个 HTTP 请求都不发（有测试钉住）。
  **拒绝时按两种情形分别措辞**（它们需要不同的动作）：**点名了占用者**（ComfyUI 或本插件自己的 worker）时给出
  针对它的 `/free` / `unload` 命令；**一个占用者都没报出来**时明说这是**分配器缓存**的形态而不是「没人占着」
  （下一节 §34），并给出 `POST /free` 与「隔十几秒再重试」（`OSError 1455`）。
  **放行也不等于安全**：门禁通过但当时**确实有进程占着显存**时，结果里 `vram_gate.warning` 会点名它们、说明余量
  可能在加载那一刻被吃掉，并给出同样两条建议（`status` 的 `worker_start_gate.suspicion` / `no_visible_holder` 是同一套判断）。

  **崩了也要说人话**：加载期异常退出时，错误里带退出码的十进制与十六进制含义、最可能的原因、
  实时的空闲显存与占用者、以及补救命令，而不是只回一个 `exit code`；`last output` 与日志路径照旧附上。

  **分阶段计时**：`/generate` 的应答多一个 `stages_s`
  （`encode_prompt_cpu` / `denoise` / `vae_encode_conditions` / `vae_decode` / `pipeline_call` /
  `peak_vram_reserved_MiB` / `prompt_tokens` / `image_tokens` …），插件把它放进结果的 `local_worker.stages_s`。
  没有它，「这次编辑花了 260 秒」是一个无法追问的数字——而追问出来的结论见下一节。

### 出图 / 编辑都优先用 `comfyui`（速度 + 画质）

`backend: "auto"` 的默认顺序就是「有 key 走云 API，否则先试本机 ComfyUI，最后才落到 worker」，
正常情况不需要手动指定。两条**独立**理由都指向同一个顺序：

1. **速度**：同画布 992×992 的步数扫描里 `comfyui` 0.727 s/步、`local`（本插件 worker）2.014 s/步，
   每步 **2.77×**（两侧量化档不同，别读成纯后端差异）；编辑路径差得更远，见下一节。
2. **画质**：同提示词、同 seed、**同尺寸**的对照里 `comfyui` 更好——这是目视判断，不是客观指标；
   结构上也说得通：`comfyui` 走真·低比特 GEMM（`convrot_w4a4_linear`，int8-convrot 权重），
   而本插件 worker 的 bnb nf4 权重会先反量化成 bf16 再走 bf16 GEMM（内核画像见下文）。

**如实记一条边界**：`local` 后端在 **8 GB 档位**上的**材质真实度有上限**——bnb nf4 反量化 + bf16 GEMM
这条路径，加上 CPU 文本编码器与 4.5 GiB 常驻权重，画布上限就在 ~1.5MP 附近（实测 1664×928 时
reserved 6016 MiB），材质/贴图感比同尺寸的 `comfyui` 明显——这也正是用户说的「材质假、像贴图」的来源。
要更好的材质与更细的纹理，优先 `comfyui`；`local` 的价值是**不依赖外部程序、自己管生命周期**。

### 本地编辑为什么慢：8 GB 卡上请优先用 `comfyui`

> **实测补记（P0 运行时 `_fresh`，不是下表的 `_m0`）**：同一台机、显卡全空（`/free` 之后
> **7717 MiB 空闲**、`used 232 MiB`）下，用 `_fresh\models` + `_fresh\venv` 跑**本地编辑**
> （1 张参考图、1 步、seed 42），**1 MP 与 1.5 MP 都失败**：
> - 画布 1312×736（旧 1MP 表）：`OutOfMemoryError: CUDA out of memory. Tried to allocate 180.00 MiB.
>   GPU 0 has a total capacity of 8.00 GiB of which 670.00 MiB is free.`
> - 画布 1664×928（新 1.5MP 表）：崩在 bitsandbytes 的 **CPU** nf4 反量化内核——
>   `OSError: exception: access violation writing 0x000001B6EC000000`
>   （`bitsandbytes/backends/cpu/ops.py` → `cdequantize_blockwise_cpu_nf4_bf16`）。
>
> 两条都是**原始报错**（worker 返回 HTTP 500 并把 traceback 一起给出，进程本身没死）。
> 结论只能说到这一步：**`_fresh` 这条运行时上的本地编辑现在跑不动，且与画布从 1MP 提到 1.5MP 无关**
> （1MP 同样失败），所以默认尺寸表照旧；根因未定位。下表的 `_m0` 数字是另一套 venv/权重，
> 不能拿来推断 `_fresh`。**能编辑就优先 `comfyui`** 这条结论因此更强，不是更弱。

本机（RTX 4070 Laptop **8188 MiB** / 31 GiB RAM，`_m0\venv` torch 2.9.1+cu126，
`_m0\models\qwen-image-2.1-bnb4bit` 10.63 GiB nf4）实测，**同一个画布 1312×736、同样 6 步**：

| 阶段 | 文生图 | 编辑 |
|---|---|---|
| 参考图解码 + 缩放到条件尺寸 | — | 0.02 s |
| **文本+视觉编码（`encode_prompt`，编码器在 CPU）** | 9.04 s（19 token） | **31.64 s（975 token，其中 943 个视觉 token）** |
| **去噪循环（6 步）** | **12.25 s** | **179.13 s** |
| VAE 编码参考图 / VAE 解码 | 0 / 1.89 s | 0.79 / 7.49 s |
| PNG + base64 | 0.10 s | 0.12 s |
| **合计（不含冷启动与 HTTP）** | **23.28 s** | **219.19 s** |
| 峰值显存 allocated | 5041 MiB | 7489 MiB |
| **峰值显存 reserved** | — | **8666 MiB > 8188 MiB 物理上限** |

结论与根因（**实测**，不是推断）：

1. **主导项是去噪循环，不是 CPU 编码。** 179 s / 219 s = 82%。CPU 文本+视觉编码的 31.6 s 只占 14%。
   `encode_prompt` 之所以 31.6 s，是因为参考图以 **943 个视觉 token**（`image_pad` 计数）注入，
   而编码器按硬约束留在 CPU（它 5.8 GiB，和 4.4 GiB 的 transformer 挤不进 8188 MiB）。
2. **真正的原因是这张 8 GB 卡被"超额认购"了。** 编辑路径的联合序列 = 文本 + 参考图潜变量 + 目标潜变量
   ≈ 7576 token（文生图 ≈ 3791 token），于是 KV cache 与激活一起把 **reserved 顶到 8666 MiB**，
   越过 8188 MiB 物理上限，`torch.cuda.mem_get_info()` 全程报 **free = 0 MiB**——
   驱动在走 WDDM 共享内存分页。分页的代价就是每一步 20–40 s（文生图一步约 2 s），
   而且每步耗时是**波动**的（实测同一轮里 14.6 / 31.4 / 31.5 / 42.3 / 20.7 s）。
3. **因此"编辑比文生图慢一个数量级"不是算法问题，是显存问题。**
   同一份代码、同一个画布，只要把条件序列压下去（参考图预算 992→512，视觉 token 943→252），
   每步从 23.4 s 掉到 **1.7 s**、`encode_prompt` 从 35.1 s 掉到 16.5 s——**降一级分辨率换回 12 倍**。
   但条件是"参考图缩放后与画布同量级"（官方模板警告过：两者不一致会让编辑位移），所以调它是有画质代价的，
   本包**不擅自改默认值**。
4. **最锋利的一组证据是前缀 KV cache。** 管线默认开 `use_kv_cache`（它本身是对的：`causal_condition=True`
   让文本/条件 token 的 K/V 与去噪步无关，缓存是**精确**的、不改变计算结果）。但缓存要在每一层留住
   7.6k token 的前缀，实测多占约 **2.5 GiB**。同一进程内、每次跑前都 `torch.cuda.empty_cache()` 的干净对照
   （`test/bench-edit-pressure.py`，A/B/A/B 交替跑以排除顺序与残留影响）：

   | 配置 | 每步 | 去噪合计 | 峰值 allocated | **峰值 reserved** | 驱动侧空闲 |
   |---|---|---|---|---|---|
   | cache **on**（现状；A1 / A2） | 24.06 / 23.20 s | 144.4 / 139.2 s | 7489 MiB | **8666 / 8514 MiB** | **0 MiB** |
   | cache **off**（B1 / B2） | **3.40 / 3.40 s** | 20.4 / 20.4 s | 5587 MiB | **6178 MiB** | 870 MiB |

   开缓存时 reserved **越过 8188 MiB 物理上限**、驱动侧空闲为 0（即在分页），每步 23–24 s；
   关掉缓存后 reserved 6178 MiB、还剩 870 MiB，每步 3.40 s。**7 倍，可复现，与顺序无关。**

   **这一条没有落地成默认行为**，因为它在显存够大的卡上是反向的：缓存把后续步从"全序列 7576 token"
   降到"只算目标 3772 token"，大卡上缓存才是快的。正确做法要按卡（或按请求的投影显存）决定，
   而那个阈值本机没有第二种硬件可验证。结论只落到文档：**8 GB 卡上用 `comfyui`**。

**所以：8 GB 卡上做参考图编辑，请用 `backend: "comfyui"`。** 同一个画布、8 步、官方改图工作流，
ComfyUI 实测 19–23 s，而受管 worker 同样尺寸 6 步要 219 s（约 10 倍）。
`local` 后端的编辑通道保留可用（它在更大显存的机器上是对的），但在 8188 MiB 上它的去噪循环必须与分页对抗。
`qwen_image_edit` 显式传 `backend: "local"` 时仍会照跑，并把 `local_worker.stages_s` 一起回报，
让你能当场看到钱花在哪一段。

### 本地编辑尺寸门（只在 `local` 后端生效）

上一条讲的是「为什么慢」，但后来的定案复测把边界收窄成了**硬墙**：编辑路径的成败只跟一个量有关——
画布算出来的参考图条件化预算 `_reference_budget`（`resources/worker.py:354`，用在 `:244 / :246 / :289`）：

```text
budget = min(4096, max(32, round(sqrt(width × height) / 32) × 32))
```

所以插件在**工具层、拉起 worker 之前**按同一个公式（`src/ratio.ts` 的 `referenceBudget`）算出本次请求的
budget，再分档——三条路径都有测试钉住（`test/local-edit-budget.test.mjs`）：

| budget | 行为 | 依据（本机 RTX 4070 Laptop 8188 MiB） |
|---|---|---|
| **≤ 896** | 放行，不插话；但**画布 > 1.0 MP 且预算 > 512** 时会附一条**画布侧建议**（`local_edit_budget.warning`，仍放行） | 1216×672 → 峰值 reserved **7458 MiB**，3/3 次逐位一致；同一预算在 1248×1248 上是 **67 s/步**（`docs/evidence/r5-budget-canvas-matrix.md`） |
| **897–960** | **放行，但结果里带警告**（`local_edit_budget.warning`，并写进 `summary` 的可见文本） | 960×960 通过，但峰值 reserved **8492 MiB > 卡总量 8188**（走 WDDM 共享内存），去噪 21.19 s ≈ 928 档的 2 倍 |
| **> 960** | **默认拒绝**，抛一条点明失败形态与四条出路的错误 | 992–1024 = GPU 去噪 `torch.OutOfMemoryError`；≥1216 = CPU 文本编码段 **访问违例**，worker 进程有时直接消失 |

分档判的是**生效的** `_reference_budget`，而它有两个来源：配置 `localReferenceBudget`（优先），没有配置才按画布
推导。回执里的 `local_edit_budget.budget_source`（`config` / `canvas`）、`canvas_budget` 与 `configured_budget`
把这次用的是哪一个说明白。

> ⚠️ **分档只按预算，不含画布本身的代价**——这是本节最容易读错的一处，也是 `docs/evidence/r5-budget-canvas-matrix.md` 实测纠正的地方：
> 896 那条「可靠线」的出处是 **1216×672**（0.82 MP）。

> **`localReferenceBudget` 让 `local` 编辑在 1.5MP 画布上可跑，但只有 `512` 这一档**：七档默认画布算出的预算都是
> 1216–1248，落在拒绝档；把预算设成 `512` 后**同一张 1248×1248 画布会被放行**，实测 wall **109.5 s**、
> 峰值 reserved **6488 MiB**、worker 存活。**`896` 不能照搬到这里**：同一张 1248×1248 用 896 实测 **67 s/步**、
> 25 步外推 **≈28 min**，两次都被运行器墙钟杀掉而**没有任何报错**——等于不可用（**不是**「会 OOM / 会崩」）。
> （换到的是速度：§19 预算 992 → 512 时编码 37.7 → 16.5 s、每步 3.4 → 1.67 s。）
> 保真度：同画布（1216×672）896 vs 512 **目视看不出差别**（n=1、1 位评判者），1.5MP 画布上只测了 512；
> **513–895 这段在 1.5MP 画布上没有量过**，所以文档与工具文案都不写「无副作用」。预算填 `0`（默认）= 由画布推导，
> 与没有这个旋钮时逐位一致。出处：`docs/evidence/r5-budget-canvas-matrix.md`。

拒绝信息的措辞是有意为之：失败形态**不是**「显存不足」，所以现有那条「空闲显存不够 → 先给 ComfyUI 发
`POST /free`」的补救提示在这里没用，消息里直接劝住，并给出四条出路——① 改用 `comfyui` 后端；
② 显式给更小的 `width`/`height`（可靠档 ≤896，例如 1216×672）；③ 把 `localReferenceBudget` 调到 **512**
（**1.5MP 画布上唯一实测跑得完的档**：wall 109.5 s / 峰值 reserved 6488 MiB / worker 存活。别照搬 896：
它那条「可靠线」只按预算分档、出处是 1216×672 画布，同一张 1248×1248 用 896 实测 67 s/步、25 步外推 ≈28 min，
**不报错**但等于不可用；**513–895 在 1.5MP 画布上没有量过**。保真度：同画布 896 vs 512 目视看不出差别，
n=1、1 位评判者）；
④ 配置 `allowLocalEditOverBudget: true`（默认 `false`）显式放行。返回值里 `local_edit_budget` 如实回执这次
用的是哪一档、budget 是多少、是不是靠覆盖开关过的；`comfyui` 走另一条路，不受这道门约束（回执
`local_edit_budget: null`）。

**画布侧警告（`docs/evidence/r5-budget-canvas-matrix.md` 之后新增，**放行**、不是拒绝）**：**生效预算 > 512** 且**画布面积 > 1.0 MP** 时，
尺寸门在放行的同时把一条画布侧建议写进同一个 `local_edit_budget.warning`（并照旧进 `summary`）——
它只在预算本身没被拒的档（可靠档的新增情形、贴边档、以及覆盖开关放行的档）里出现，措辞与那一档的原有结论并列
而不冲突（覆盖放行时同一条警告里既有「按用户显式授权放行」，也有画布侧实测）。阈值 **1.0 MP** 是插值：
两个实测端点是 `0.82 MP / 896 = 1.9 s/步` ↔ `1.55 MP / 896 = 67 s/步`，**中间没有测过**（`docs/evidence/r5-budget-canvas-matrix.md`）；
它只给建议（设 `512` 或换 `comfyui`），不新增任何拒绝路径。

**为什么不去抬 `minFreeVramMiB`（启动前显存门禁）？** 这道尺寸门与它管的是两件事：门禁保护的是
**加载阶段**那一次约 4.5 GiB 的分配（`worker.ts` 的文案自述），而编辑的墙在**加载之后**——要「覆盖」
896–960 档的峰值就得要求 8500 MiB 空闲，**比这张卡的总量 8188 MiB 还高**，等于把这个档位变成永远拒绝；
而门禁的结构是**单阈值**（`src/env.ts` 的 `allowed: shortfallMiB === null`），本来也表达不了 ≥1216 那条
**主机 commit** 侧的失败。所以门禁数字不动，拦在尺寸这一维上。

- **本机 ComfyUI（已实现，复用你自己的权重）**：`backend: "comfyui"`（`auto` 在没有 key 时也会走它）。
  本包**不下载、不转换任何权重**，只驱动你已经装好的 ComfyUI：
  1. **找服务**：依次 GET `127.0.0.1:{comfyPorts 里的端口}/system_stats`，第一个应答得像 ComfyUI 的胜出；
     `comfyEndpoint` 非空时只用它，并且**非回环地址直接拒绝**（`127.0.0.0/8` / `localhost` / `::1`，不接受任何域名）。
  2. **枚举权重**：GET `/object_info/UNETLoader`、`/object_info/CLIPLoader`、`/object_info/VAELoader`，
     用 `unet_name` / `clip_name` / `vae_name` 的**选项列表**按名字（要求含 `qwen`）挑文件——**文件名不写死在代码里**。
     `CLIPLoader.type` 同样从它自己的选项里取（优先 `qwen_image`）。
     **一个都挑不到就在送 `/prompt` 之前报错**，点名缺哪个文件、该放进 `comfyModelsDir\unet|clip|vae\`。
  3. **提交与取图**：`POST /prompt` → 轮询 `GET /history/{prompt_id}` → `GET /view?filename=…` 取字节，
     再交给本包的落盘逻辑（命名规则与云端一致）。上游的 `node_errors` 与执行 traceback **原文回传**，不吞。
  4. 工作流是官方 Qwen-Image 2.1 txt2img 模板（内联在 `src/comfyui.ts`，`{{placeholder}}` 注入）：
     `UNETLoader → KSampler.model`、`CLIPLoader(type=qwen_image) → TextEncodeQwenImage21 → KSampler`、
     `VAELoader → VAEDecode`、`EmptyLatentImage → KSampler.latent_image`、`VAEDecode → SaveImage`；
     `KSampler` 用模板自带的 `steps=25 / cfg=1 / euler / simple / denoise=1`（`steps` 可被工具参数覆盖）。
  5. **改图（`qwen_image_edit` + `comfyui`）**：参考图先用 `POST /upload/image`（multipart）送进 ComfyUI 的
     `input/` 目录——`LoadImage` 只认那里，ComfyUI 没有「按绝对路径加载」的输入；文件名按内容哈希
     （`dsh-forge-ref-<sha256 前 16 位>.png`，`overwrite=true`），所以同一张图重复送只会覆盖自己那份，
     也不会撞上你已有的文件名。工作流是**上面那张图 + 官方改图模板的编码节点**：
     `TextEncodeQwenImage21` 多接 `vae` 与 `images.image_1`…`images.image_10`（官方 autogrow 槽位，最多 10 张），
     并收一个 `resolution` 像素预算——由插件按画布面积算出（`round(sqrt(W×H)/32)×32`），让参考图缩放后的尺寸
     与画布同量级（官方模板警告过：两者不一致会让编辑「位移」）。模板里的 `ComfySwitchNode`（custom_size 开关）
     不需要，因为插件**总是**给出显式画布，和 T2I 路径一样；`QwenImage21Cache` 同样略去（只换速度/显存）。
  已知代价：ComfyUI 自己也会把每张图存进它的 output 目录（`<ComfyUI>/output/dsh-image-forge_*.png`），
  本插件不删它（盘是你的）。

## 测试

```powershell
pnpm build
pnpm test
```

8 个文件 / **117 个用例**，全部不需要 GPU、venv 或 10.6 GiB 权重
（ratio 9 / surface 7 / api-e2e 8 / comfyui-e2e 9 / worker-lifecycle 21 / edit-e2e 7 / vram-gate 9 / settings 47）。

> 这 117 个用例目前在**本机全绿**（`worker-lifecycle` 21/21）。此前它曾有 2 个用例在
> `cleanup()` 的 `rmSync` 上报 `EPERM`，根因是 `python -m venv` 在 `TMP` 指向不存在的目录时
> 会在 venv 里留下 ACL 为 `0o700` 的临时目录 —— 那是插件自身的一个真缺陷，已修掉，
> 与本 README 描述的设置页改动无关。

- `test/settings.test.mjs`：设置分区的完整契约——注册形状（槽名 `settings.section`、`id`、
  `order`、`label`、组件、**不带 `key`**，以及 `inject` 返回的释放函数真的会解绑）、
  入口 id 解析与镜像回绑、`describe → 读 → 写` 往返、**revision 冲突被识别并重新读取而不是覆盖**、
  拒绝 / 不可写 / 同步抛错 / 传输失败四条失败路径、`mutateFields` 的 revision 透传、
  **`apiKey` 的展示值与失败文案都不含明文**、以及**「schema 里每个字段都有对应控件」的防漏测试**
  （新增配置字段却忘了补 UI 会在这里失败）、**步数解析优先级**（显式 > 后端专属 > 默认）、
  「每个派发点都转发了解析后的步数」的接线断言、以及**性能说明块的文案纪律**：
  斜率表/端到端表的每个数字逐格断言、结论性 finding 必须带实测数字、
  **全块禁止任何修复承诺**、且**被撤回或被证伪的数字（`8 倍` / `15 倍` / `7.75` / `0.98` / `37 s` /
  `口径存疑`）一旦重新出现就测试失败**（这条存在就是为了「别再犯那个错」）。
  另有「**advisory 不得含 markdown 标记**」的断言 —— 该分区把字符串当纯文本节点渲染，
  `**` 与反引号会原样显示给用户。

`pnpm build` 会产出两个目录：`lib/`（`index.js` + `client.js`，**自包含**，Web 客户端只加载 `./client` 这一个入口）
和 `testlib/`（设置逻辑的独立 bundle，只给 `test/settings.test.mjs` 用，**不随包发布**——
为什么不把设置逻辑直接做成 `lib/` 的额外入口，见 `tsdown.config.ts` 的注释）。

- `test/ratio.test.mjs`：7 档换算、32 对齐、确定性、显式尺寸校验
- `test/surface.test.mjs`：`lib/index.js` 的四个导出、**四个**工具名、`wh_ratio` enum、`qwen_image_edit` 的必填项与参数形状、技能正文与参考文件路径
- `test/api-e2e.test.mjs`：本地假端点端到端（请求体、响应解析、落盘字节一致）、编号不覆盖、
  无 key / 无 worker / 上游 401 的报错文本、key 脱敏、`qwen_image_env status`
- `test/comfyui-e2e.test.mjs`：假 ComfyUI 端到端（多端口探测 → `/object_info` 选权重 → `/prompt` 注入工作流 →
  轮询 `/history` → `/view` 取图 → 落盘**逐字节一致**）、缺文件点名、没在跑时报出探过的端口、
  非回环端点拒绝且**一个请求都不发**、`node_errors` 与 traceback 原文回传、`auto` 的后端选择
- `test/worker-lifecycle.test.mjs`：**worker 生命周期 + 本地运行时管理**。全部跑在
  `test/fixtures/fake-worker.mjs` 上（同命令行、同 HTTP 面的 node 假 worker，所以不需要 GPU/venv/10.6 GiB 权重）：
  插件自启并出图、被外部杀掉后下次调用重建、启动即崩时回报退出码 + stderr、永不就绪时按预算超时并回日志尾部、
  端口被不相干的 HTTP 服务占着时顺延、`POST /unload` 与空闲回收、没有 `/unload` 的旧 worker 被如实报告、
  `manageWorker:false` 拒绝拉起、`/generate` 错误原文回传、请求中途死掉只重建重试一次、
  `status` 的六态区分、失败启动的冷却、`repair` 只杀本会话自己持有的僵死 worker（**不碰别人的 pid**，
  记录在案的第三方 pid 只报告 + 给 `taskkill` 命令）。
  权重侧用**假镜像**（本地 http）：URL 清单、只规划不下载的 dry run、**断点续传 + sha256 + bnb 分离开关**、
  `lm_head.weight` 剔除后文件仍合法（偏移量下移、字节原样）、`install` dry run 不落盘、
  `repair` 把缺权重报成 `unfixable` 而不是假装成功
- `test/local-edit-budget.test.mjs`：**本地编辑尺寸门**。一层是**同源**：测试读 `resources/worker.py`、
  把 `_reference_budget` 的表达式取出来翻译成 JS 再求值，与 `src/ratio.ts` 的 `referenceBudget` 在
  整个合法窗口的 32 对齐网格（256–4096，**14641 个尺寸**）上逐点比对（任一侧单独改动都会红；翻译不了的新写法会**报错**而不是静默放过）；
  另一层是三条路径，全部走**真工具 + node 假 worker**：≤896 放行且回执 `local_edit_budget.budget` 与画布一致、
  897–960 放行且警告同时出现在 JSON 与 `summary`、>960 **在 spawn 之前拒绝**（假 worker 的事件文件都不存在）、
  开 `allowLocalEditOverBudget` 后同一请求放行且标注 `overridden`、以及同一张被拒画布在**文生图**上不受影响；
  另外钉住 7 档默认画布的 budget（1248/1216）**全部落在拒绝档**——这正是这道门存在的理由；
  `localReferenceBudget` 的四条语义也在这里钉住：**没配置时请求体里连 `reference_budget` 这个键都没有**（默认路径
  逐字节不变）、配了 `512` 时那张 1248×1248 画布**被放行**且 worker 真的收到 `reference_budget: 512`（画布不变）、
  配一个**本身超线**的值（1248）仍然被拒（旋钮两个方向都生效）、`500` 这种非 32 对齐值**点名报错**而不是被悄悄接受。
  `docs/evidence/r5-budget-canvas-matrix.md` 之后又加了**画布侧警告**这条（放行）：1248×1248 + 896 有警告、同一笔预算在 0.82 MP 画布上**没有**、
  1.5MP 画布 + 512 也**没有**、插值区的画布（1216×1024 = 1.25 MP）照样触发并如实报出面积，
  以及覆盖开关放行时同一条 warning 里同时含覆盖与画布两侧；最后一条**防回潮**断言钉住
  「`≤896` 与『画布停在 1.5MP』并列」这条被 `docs/evidence/r5-budget-canvas-matrix.md` 证伪的说法不再出现在 README、
  **compose 后的 skill 正文**与 `lib/index.js` 里的工具文案三处
- `test/edit-e2e.test.mjs`：**参考图编辑**。参考 PNG 由测试自己生成（尺寸要真，所以不能拿假字节糊弄）：
  假 ComfyUI 收到 `/upload/image` multipart（**上传字节与参考图逐字节一致**、文件名按内容哈希）、
  图里 `images.image_1`/`images.image_2` 接对、`resolution` 跟着画布面积、`/view` 的字节逐字节落盘；
  `ratio_follow`（`image1` / 直接给路径 / 不传则默认第一张）换算出的画布与偏差；
  `wh_ratio` + `ratio_follow` 同时给时**在碰后端之前**就报错；11 张 / 空表 / 缺文件 / 目录 / 相对路径 /
  0 字节 / 非图片 / 非 base64 data URI / 空 base64 各自点名 `images[n]`；
  `backend: "api"` 拒收参考图（`auto` + 有 key 时跳过云后端并如实回报）；以及走**真 worker 契约**的那半：
  `images[]` 以 base64 逐字节到达本地 worker，而文生图请求连 `images` 这个键都没有；尺寸门**只在本地生效**：
  超预算画布走假 ComfyUI 照常出图（回执 `local_edit_budget: null`），而 `auto` 回退到 worker 时，
  尺寸门的文本完整地嵌在「两个后端都跑不了」的错误里（否则用户会以为只剩「腾显存」一条路）
- `test/vram-gate.test.mjs`：**启动前显存门禁 + opt-in `/free` + 崩溃兜底**（假 worker + 假 ComfyUI；
  阈值抬到卡上限之上，所以**不需要占用显存**，`nvidia-smi` 不存在时按 SKIP 处理而不是失败）：
  余量不足时拒绝拉起（不 spawn、日志文件都不创建）、错误里带空闲/阈值/缺口、点名的占用者、可粘贴的 `POST /free` 命令；
  `status.worker_start_gate` 给出同一份判决（`would_refuse_start` / `shortfall_MiB` / `remedy` / `auto_free_enabled`）；
  **默认 `freeComfyBeforeLocalStart: false` 时假 ComfyUI 收到 0 个请求**（副作用为 0）、
  开启后恰好 1 次 `POST /free` 且 body 为 `{"unload_models":true,"free_memory":true}`、释放后仍不足就如实拒绝；
  门禁已满足时**任何请求都不发**；`minFreeVramMiB:0` 时门禁完全不参与（`vram_gate: null`）；
  worker 以 `3221225477`（`0xC0000005`）死在加载阶段的错误里含原因、实时显存、占用者与补救命令；
  worker 回报的 `stages_s` 逐字段出现在 `local_worker.stages_s` 里；
  另外用**注入的假 GPU 读数**（`probeVram`，不碰真卡）钉住门禁的措辞分档：**点名了占用者**时给针对它的
  `/free` 命令、**一个占用者都没报出来**时明说那是分配器缓存（`cudaMallocAsync` / 3.6 GiB）并给出
  `/free` + 「隔十几秒重试（`OSError 1455`）」、**放行但有占用者**时 `vram_gate.warning` 点名它们、
  空卡放行则完全没有警告（`status` 侧的 `no_visible_holder` / `suspicion` 同一套判断）
- `test/live-worker-e2e.mjs`：**真机端到端**（不在 `npm test` 里，需要 GPU + 10.63 GiB 权重）。  设 `FORGE_LIVE_WORKER=1`、`FORGE_LIVE_PYTHON=<venv python>`、`FORGE_LIVE_MODELS=<权重目录>` 后运行：
  真 `status` → 冷启动出图（打印 PNG 绝对路径与 IHDR）→ 外部杀掉 → 自动重拉再出图 →
  `nvidia-smi` 前后对照的 `/unload` → 卸载后重新加载再出图
- `test/live-edit-e2e.mjs`：**编辑的真机端到端**（不在 `npm test` 里）。`node test/live-edit-e2e.mjs [comfyui|local|both]`：
  真 ComfyUI（上传参考图 → 官方改图工作流 → 出图，并从 ComfyUI 自己的 `/history` 里取回**它记录的节点清单**）与
  真受管 worker（冷启动 → 编辑出图 → `unload` 交回显存 → dispose 停进程），两条都打印 PNG 绝对路径 + IHDR
  （宽高/bitDepth/colorType）。路径默认取本机（`_m0\venv`、`_m0\models`、`_comfyui_ref`、`_integration`），可用
  `FORGE_LIVE_*` 覆盖。

（用 `node test/xxx.test.mjs` 逐个跑，而不是 `node --test`：后者会 spawn 子进程并通过管道取输出，
在受限沙箱里会 `EPERM`。）

## 第三方与许可

本插件自身以 **MIT** 发布。与它协作的三方各自独立：

- **Qwen-Image-2.1 权重**：受 **Qwen RESEARCH LICENSE AGREEMENT** 约束，**限研究用途；商用需自行向权利方取得授权**。
  **权重归 Qwen 团队所有**，本插件仅按其许可使用、不主张任何权利。
  本插件**不随包分发任何权重**，但 `qwen_image_env action:"fetch-weights"` 会**按你的指令**从
  `hf-mirror.com` 拉取 `circulus/Qwen-Image-2.1-bnb-4bit`（10.63 GiB）到你的 `modelsDir`；
  是否下载由你决定，下载后的用途与合规由你负责。云端点不受此约束。
- **随包的 worker 脚本**（`resources/worker.py`）是本插件的一部分（MIT），它调用 diffusers /
  transformers / bitsandbytes / PyTorch（各自许可）来跑上述权重。
- **官方提示词文本**：本插件**不随包分发**任何 Qwen 官方提示词规范原文（`system_prompt_t2i.txt` /
  `guide_t2i.md` / `guide_edit.md` 等）。`skill.md` 与 `references/*.md` 是本插件**自撰**的规则文档；
  输出契约字段名（`rewritten_prompt` / `wh_ratio` / `ratio_follow`）沿用公开契约形状以便互操作。
- **ComfyUI**：**可选的外部依赖**（GPL-3.0）。本插件不包含、不修改、不分发 ComfyUI 代码，
  只通过 HTTP 与用户自行安装的实例通信；是否安装与本插件的 MIT 许可无关。
- **云 API 供应商**：由用户自带 key 并自行遵守对应服务条款；本插件只转发请求、不代理、不转存。

## 已知边界（v0.1）

- 云 API 后端**没有编辑通道**：`qwen_image_edit` 只走本机（`comfyui` / `local`）。
  云端的编辑是另一种请求形态（multipart `/images/edits`，或 DashScope 的原生异步任务接口），
  未实现；显式指定 `backend: "api"` 会明确报错，而不是把参考图丢掉。
- worker 侧的编辑路径需要给 `QwenImage21Pipeline.__call__` 补一个 `image_pad_mask`
  （它自己没有这个参数，而 `encode_prompt` 在「同时给 embeddings 与参考图」时强制要求）。
  做法是**只在这次调用期间**给该实例装一个转发包装，采样一结束立刻还原；文本编码器仍留在 CPU。
  实测「直接把 `prompt` 与 `image` 交给管线、让它自己编码」这条更漂亮的写法**不可用**
  （它在 `self._execution_device` 上编码，而文本编码器在 CPU：`Expected all tensors to be on the same device`）。
- 参考图的像素尺寸只认 PNG / JPEG / WebP 的文件头；其它容器（含 TIFF、AVIF）会被拒绝并给出原因。
- 没有局部重绘（inpaint / mask）、放大、相册 UI。
- `qwen_image_env action:"fetch-weights"` 的 `skipLmHead` 只在本机的**合成** safetensors 上验证过
  （文件重写 + 偏移量校验）；**没有**在真实 5.8 GiB 的 `text_encoder/model.safetensors` 上验证过
  「剔除 lm_head 后 transformers 仍能加载」，所以默认 `false`。
- 真实设备上只验证过 cu126 这一档（`torch 2.9.1+cu126`）；cu128 / cu118 是同一段矩阵代码里的备选路径，
  **未在真机下载验证过**。
- 冷启动实测约 10.5 s（Windows，权重已在页缓存里）；2K/8 步约 49 s（M0 spike 实测）。
  > 这条里原先还有「首次生成 992×992/8 步约 19 s」，**已被撤回**：后来的步数扫描在同样条件下测到
  > `local` 8 步 = **28.20 s**、4 步 = **18.81 s**，`19 s` 复现不出来（按受污染读数处理）。
  > 每步成本与跨后端倍率请以「设置页 → Qwen 出图」里的**斜率表**为准。
- **编辑路径在 8 GiB 卡上有实测的硬边界**（1312×736：ComfyUI 8 步 ≈ 19–23 s，受管 worker 6 步 ≈ 219 s）：
  根因是显存**超额认购**——编辑的联合序列 ≈ 7576 token，把 `reserved` 顶到 8666 MiB **越过 8188 MiB 物理上限**，
  驱动走 WDDM 分页，于是每步 20–40 s。**不是** bnb 逐层换入换出的锅（旧的猜测已实测排除：
  同一轮里把参考图预算减半即可把每步从 23.4 s 压到 1.7 s，全程没有 offload 参与）。
  分阶段数字、方法与"8 GB 卡上编辑优先用 `comfyui`"的结论见「后端 → 本地编辑为什么慢」。
  把参考图预算调小能换回十几倍，但会牺牲编辑保真度，所以本包**不擅自改默认值**——取而代之的是
  「后端 → 本地编辑尺寸门」：七档默认画布在 `local` 上预算都是 1216–1248，因此默认会被**明确拒绝**
  （而不是把一个已知必崩的请求送进 worker），要跑得显式开 `allowLocalEditOverBudget`，
  或把 `localReferenceBudget` 调到 **512**（1.5MP 画布上唯一实测跑得完的档：109.5 s / reserved 6488 MiB /
  worker 存活——**别照搬 896**：896 在同一张 1248×1248 上是 67 s/步、≈28 min，不报错但等于不可用；
  保真度：同画布 896 vs 512 目视看不出差别，n=1、1 位评判者）。
  「不擅自改默认值」仍然成立：旋钮的默认值就是 `0` = 与今天完全一致）。
- `install` 只实现到「建 venv + 装 torch + 装 worker 依赖」；CUDA toolkit、显卡驱动、Visual C++ 运行库
  由用户自己保证（装不上 torch 会在步骤里原文报出 pip 输出）。
- **判断「某个 pid 还活着」在本机不可靠**：Windows 的 libuv 没实现 signal 0（对活进程也抛 `ESRCH`），
  `tasklist` 在受限沙箱里被拒绝。所以插件的「僵死 worker」判定只用**自己能掌握的证词**——它持有的子进程句柄
  与 worker 自己写的 `worker-state.json`；`repair` **只停止本会话自己拉起的那个进程**，对历史记录里的 pid
  只报告并给出 `taskkill` 命令，不代替用户杀进程。代价：跨会话的僵死 worker 需要用户自己 `taskkill`（或直接再出图，
  插件会另选端口另起一个）。
- 客户端 `tool.call.toolview` 卡片已注册，但未在真实 web 客户端里验证过；
  图片显示的**主路径**始终是工具结果里的 Markdown 绝对路径。
