# 配置与设置页（详细）

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
| `comfyEndpoint` | 空 | ComfyUI 地址，如 `http://127.0.0.1:8188`；**空 = 自动探测 `comfyPorts`**。非回环地址会被拒绝（见[后端](backends.md)） |
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
| `torchWheels` | 空 | 空 = 设备矩阵 `cu128,cu126,cu118` 逐级降级（**建议留空走默认**，各档不做真机验证） |
| `pipIndexUrl` | 空 | 非 torch 包的索引地址（内网镜像）；空 = 默认 PyPI |
| `reuseBaseTorch` | `true` | 基础解释器里已有 CUDA torch 就以 `--system-site-packages` 复用，**不重复下载 torch** |
| `minFreeVramMiB` | `5500` | **启动前门禁**的阈值，也是 `status` 的预警线：空闲显存低于它，插件**拒绝拉起本地 worker**（点名占用者 + 给出 `POST /free` 命令），而不是硬起。`0` = 关掉这道门禁。⚠️ 它守的是**加载那一次约 4.5 GiB 的分配**，**不是**编辑画布尺寸——编辑的画布上限由[本地编辑尺寸门](backends.md#本地编辑尺寸门只在-local-后端生效)管（见[后端](backends.md)），那道门的失败形态也不是显存不足 |
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

除了在 profile 里手写配置，**schema 里 33 个字段仍全部可写**；但设置页**只展示日常需要的 16 个**，
自定义环境配置（解释器路径、wheel 标签、镜像、端口段…）**不外露**——本地安装交给「一键部署」。

- 菜单位置：**设置 → 「Qwen 出图」**——这是和「通用设置 / 模式 / 插件 / Agent 预设」同级的**一级菜单项**
  （注册进 `settings.section` 这个 **list 槽**，用 `id` 定位）。
- **多标签布局**：页面不是一条长卷轴，而是四个标签页，字段在宽栏下两列铺开：

  | 标签 | 内容 |
  |---|---|
  | 出图 | `backend`、步数三项、`outputDir` / `timeoutMs`，以及后端性能说明 |
  | 云端 API | `apiBaseUrl`、`apiKey`、`apiModel`、`apiStyle` |
  | 本地环境 | **一键部署卡片** + `minFreeVramMiB`、`freeComfyBeforeLocalStart`、`allowLocalEditOverBudget`、`localReferenceBudget` |
  | ComfyUI | `comfyEndpoint`、`comfyPorts` |

- **本地运行时一键部署**：调用宿主侧回环桥（`127.0.0.1:8411`，`GET /status` / `POST /deploy`），
  自动建 venv、装 CUDA torch、下载 nf4 权重（约 10.63 GiB）。胶囊实时显示 venv / 权重就绪度。
- **页面可见字段**（六块）：

  | 分区 | 字段 |
  |---|---|
  | 后端选择 | `backend` |
  | 步数（画质与耗时） | `defaultSteps`、`comfyuiSteps`、`localSteps` |
  | 云端 API | `apiBaseUrl`、`apiKey`、`apiModel`、`apiStyle` |
  | 本地运行时 | `minFreeVramMiB`、`freeComfyBeforeLocalStart`、`allowLocalEditOverBudget`、`localReferenceBudget`（+ 一键部署卡片） |
  | ComfyUI | `comfyEndpoint`、`comfyPorts` |
  | 输出与超时 | `outputDir`、`timeoutMs` |

- **不外露（schema 仍可写，profile/测试可设）**：`runtimeDir`、`modelsDir`、`modelRepo`、`hfMirror`、
  `localEndpoint`、`workerPorts`、`workerStartTimeoutMs`、`idleUnloadMs`、`manageWorker`、`comfyModelsDir`，
  以及整块 `python`（`pythonPath`、`workerScript`、`basePython`、`torchWheels`、`pipIndexUrl`、`reuseBaseTorch`、`skipLmHead`）。
  这些进阶项的默认值就是一键部署用的那一套；要改请写 profile，或等将来需要时再暴露。

- **`apiKey` 只写不读**：输入框是密码框，已保存的密钥永远只显示成掩码（`••••••••`），
  留空表示「不修改已保存的密钥」。保存失败时的提示里也不会出现密钥内容。
- `backend` / `apiStyle` 是**下拉**，数值字段带默认值与上下限提示，其余是文本框（带说明文案）。
- `comfyuiSteps` / `localSteps` 是**可留空**的：清空输入框并失焦 = 写回「未设置」，也就是回落到 `defaultSteps`。
  分区文案里直接写清了取舍（`localSteps: 8` 快但不是官方口径；`25` 对齐官方，约慢 2.7 倍）。

**路径类字段要么给出探测到的真实值，要么在文案里说清「留空 = 什么」。** 页面上直接能看到实际会用哪个：

| 字段 | 默认值 | 会不会陈旧 |
|---|---|---|
| `runtimeDir` / `outputDir` | `~/.dsh-image-forge` / `~/Pictures/dsh-image-forge` | 不适用（本身就是可改的源） |
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
下面这些实测细节**只留在随包散文面（`README.md` + `docs/*.md`）里**——2024 年那次真机评审时，用户的第一反应是页面「暴露了相当多并不适合展示给用户的解释性文本」，
所以现在有**文本预算测试**（`test/settings.test.mjs`）钉死：字段 hint ≤ 40 字、分组 hint ≤ 20 字、
说明块 ≤ 400 字；而「证据必须留在随包散文面、不得只存在于设置页文案里」也有断言守着，两边都不能悄悄搬家。

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
      见[后端 → 本地编辑尺寸门](backends.md#本地编辑尺寸门只在-local-后端生效)。）
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

