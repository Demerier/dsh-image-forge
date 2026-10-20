# 配置与设置页（详细）

## 配置

在 profile 的插件配置里给出（全部有默认值，`Config` schema 见 `src/index.ts`）。**一共 14 个字段**，
没有一个是「本地运行时」相关的——插件不拥有任何运行时。

| 字段 | 默认 | 说明 |
|---|---|---|
| `backend` | `auto` | `auto`（有 key 走 `api`，否则走 `comfyui`）/ `api` / `comfyui`。**改图只有 `comfyui`** |
| `apiBaseUrl` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 云端点（OpenAI 兼容） |
| `apiKey` | 空 | **建议留空**，改用环境变量，key 就不会进 profile 文件 |
| `apiModel` | `qwen-image` | 模型 id——**以你的供应商文档为准** |
| `apiStyle` | `openai` | `openai` 已实现；`dashscope`（原生异步任务 API）为扩展点，调用时会明确报未实现 |
| `comfyEndpoint` | 空 | ComfyUI 地址，如 `http://127.0.0.1:8188`；**空 = 自动探测 `comfyPorts`**。非回环地址会被拒绝（见[后端](backends.md)） |
| `comfyPorts` | `8000,8188,8189,8190,8191,8192` | `comfyEndpoint` 为空时依次尝试的端口（桌面版常见 8000/8188，便携版 8188） |
| `comfyModelsDir` | **探测**：候选目录里第一个存在的 | ComfyUI 的 `models` 根目录，**只用于报错里写清「文件该放到哪」**；探测不到就留空，错误只说相对路径 |
| `comfyModel` | `base` | `base`（25 步，官方全量）/ `turbo`（8 步，蒸馏版）。turbo 缺失时自动回落 base |
| `turboSteps` | 空 | turbo 专用步数；**空 = 8**。它**不**继承 `defaultSteps`（把 25 递给蒸馏版会让画面变差） |
| `defaultSteps` | `25` | **默认采样步数**。后端没单独指定时用它。25 = 官方 ComfyUI 2.1 模板口径 |
| `comfyuiSteps` | 空 | ComfyUI 专用步数（只对 base 那一支生效）；**空 = 用 `defaultSteps`** |
| `outputDir` | `~/Pictures/dsh-image-forge` | 图片落盘目录 |
| `timeoutMs` | `180000` | 单次调用预算（ComfyUI 首次冷加载模型很慢，可调到 `900000`） |

**步数解析优先级**（两套，互不越界）：

```text
base :  调用方显式 steps  >  comfyuiSteps（仅 comfyui 后端）  >  defaultSteps
turbo:  调用方显式 steps  >  turboSteps                        >  8
```

结果里恒带 `steps_used`（实际步数）与 `steps_source`（`explicit` / `backend` / `default`），
所以「为什么这张不一样」可以直接从返回值回答。解析发生在**每次派发时**。
turbo 之所以不落回 `defaultSteps`：蒸馏按 8 步调，25 步在它身上是「更贵且更差」，不是「更精细」。

**「更大不等于更好」的实测**：同提示词、同 seed 下 25 → 50 步，客观指标反而**变差**——
lapvar **1019 → 970**、hf_frac **0.0317 → 0.0279**（高频占比变小 = 没有更多细节），用户目视也说 25 步更好。
所以默认值就是 25，`defaultSteps` **没有被锁死**，仍可自由配置。**要更多细节就把画布提上去，不是把步数堆上去。**

**Key 的读取顺序**：`apiKey`（config）→ `QWEN_IMAGE_API_KEY` → `DASHSCOPE_API_KEY` → `OPENAI_API_KEY`。
key 只存在于内存，随 `Authorization: Bearer` 发出；**不写盘、不进日志**，报错信息里会被 `<redacted-key>` 顶掉。

## 设置页（DSH Web GUI）

**14 个字段全部可写，也全部在页面上**——没有隐藏项了，因为隐藏的那批（解释器、wheel 标签、镜像、端口段、
venv/权重目录）随本地运行时一起删掉了。

- 菜单位置：**设置 → 「Qwen 出图」**——和「通用设置 / 模式 / 插件 / Agent 预设」同级的**一级菜单项**
  （注册进 `settings.section` 这个 **list 槽**，用 `id` 定位）。
- **三个标签页**，字段在宽栏下两列铺开：

  | 标签 | 内容 |
  |---|---|
  | 出图 | `backend`、`defaultSteps` / `comfyuiSteps` / `comfyModel` / `turboSteps`、`outputDir` / `timeoutMs`，以及 turbo/base 说明 |
  | 云端 API | `apiBaseUrl`、`apiKey`、`apiModel`、`apiStyle` |
  | ComfyUI | `comfyEndpoint`、`comfyPorts`、`comfyModelsDir`（+ 部署文档入口） |

- **页面可见字段**（五块，每块都有标题与一行说明）：

  | 分区 | 字段 |
  |---|---|
  | 后端选择 | `backend` |
  | 步数（画质与耗时） | `defaultSteps`、`comfyuiSteps`、`comfyModel`、`turboSteps` |
  | 云端 API | `apiBaseUrl`、`apiKey`、`apiModel`、`apiStyle` |
  | ComfyUI | `comfyEndpoint`、`comfyPorts`、`comfyModelsDir` |
  | 输出与超时 | `outputDir`、`timeoutMs` |

- **`apiKey` 只写不读**：输入框是密码框，已保存的密钥永远只显示成掩码（`••••••••`），
  留空表示「不修改已保存的密钥」。保存失败时的提示里也不会出现密钥内容。
- `backend` / `apiStyle` / `comfyModel` 是**下拉**，数值字段带默认值与上下限提示，其余是文本框（带说明文案）。
- `comfyuiSteps` / `turboSteps` 是**可留空**的：清空输入框并失焦 = 写回「未设置」，也就是回落到各自的默认值。

**路径类字段要么给出探测到的真实值，要么在文案里说清「留空 = 什么」。** 页面上直接能看到实际会用哪个：

| 字段 | 默认值 | 会不会陈旧 |
|---|---|---|
| `outputDir` | `~/Pictures/dsh-image-forge` | 不适用（本身就是可改的源） |
| `comfyModelsDir` | **`existsSync` 探测**：候选目录列表（桌面版共享树优先） | **不会** —— 每次构造 schema 时现探 |
| `comfyEndpoint` | **空**，文案写「留空 = 依次探 8000/8188/8189/8190/8191/8192」 | 不适用 —— 空值就是「探测」这条规则本身 |

- **`comfyModelsDir` 只影响措辞，不影响行为**：插件不往这个目录读写任何东西，ComfyUI 自己管它的模型树。
  探到了、错误信息就能说「把文件放进 `D:\…\models\unet\`」；探不到就说「放进 ComfyUI 的 `models\unet\`」。
- 探测**找不到就留空**——**绝不编一个不存在的路径**。
- **不做网络探测**。`comfyEndpoint` 刻意保持空（文档语义就是「留空 = 按 `comfyPorts` 探测」，
  在构造 schema 时开 socket 是坏味道），所以文案直接把端口写出来。

**页面上只放结论；论证在这里。** 设置页那条性能说明是**两行**（推荐 + 一句数字），
下面这些实测细节**只留在随包散文面（`README.md` + `docs/*.md`）里**——早前一次真机评审时，用户的第一反应是
页面「暴露了相当多并不适合展示给用户的解释性文本」，所以现在有**文本预算测试**（`test/settings.test.mjs`）钉死：
字段 hint ≤ 40 字、分组 hint ≤ 36 字、说明块 ≤ 180 字；而「证据必须留在随包散文面、不得只存在于设置页文案里」
也有断言守着，两边都不能悄悄搬家。

### 完整证据（页面上已不再出现）

- 步数扫描拟合出的**斜率**（而不是「总时长 ÷ 步数」）——两个后端都在的时候量的：

  | 后端 | 量化档 | 斜率 | 截距 |
  |---|---|---|---|
  | `comfyui` | `int8-convrot` | **0.727 s/步**（复测 0.768） | 1.60 s |
  | 受管 worker（v0.1，已删除） | bnb `nf4` | **2.014 s/步**（11 个稳态样本，2.012–2.016） | — |

  ⇒ 每步倍率 **2.77×**（同机、同画布 992×992、同 prompt、seed 0，两侧都是 1 次前向/步）。
  ⚠️ **两侧量化档不同**，所以 2.77× **不是纯「后端差异」**。这组对照的用处只有一个：说明为什么 v0.1 的
  自建 worker 被删掉（见[后端 → 归档](backends.md#归档v01-的受管-worker已删除)）。

- 端到端实测（不含权重加载）：

  | 步数 | 受管 worker（已删） | `comfyui` | 倍率 |
  |---|---|---|---|
  | 1 | 13.39 s | 2.21 s | 6.06× |
  | 2 | 14.69 s | 2.94 s | 5.00× |
  | 4 | 18.81 s | 4.90 s | 3.84× |
  | 8 | 28.20 s | 7.27 s | 3.88× |

- 一步的内核画像（@992²、3844 token）：cutlass **bf16 tensor-core GEMM 占 60.3%**（329 次调用）、
  mem-efficient 注意力 14.1%、20 多个小核合计 22.9%，而 **nf4 反量化只占 3.4%**
  （`kDequantizeBlockwise`，334 次调用）。**bitsandbytes 自己的 4-bit GEMM 只被调用 5 次、合计 0.33 ms**——
  等于没用到：权重先被反量化成 bf16 再走 bf16 GEMM。⇒ 主要成本是 **bf16 GEMM**，而 ComfyUI 走的是
  真·低比特 GEMM（`convrot_w4a4_linear`）。这是**结构性差距：要换推理栈才能改，超出本插件的范围**，
  本插件不把它记作待办、也不给出改善承诺。

- 参考图编辑（1312×736 / 6 步）的长序列问题：前缀 KV cache 使 `reserved` 越过 8188 MiB 物理上限
  （实测 8666 MiB）→ 驱动走 **WDDM 分页**；A/B/A/B 对照（每次先 `empty_cache()`）：
  cache 开 **24.06 / 23.20 s** 每步、关 **3.40 / 3.40 s** 每步，**7 倍、可复现、与顺序无关**。
  这条也是删除 worker 的直接依据之一：同一个画布 ComfyUI 8 步 19–23 s。

- ⚠️ **一个仍然会让人卡住的显存陷阱（8 GB 卡必读）**：ComfyUI 跑完会在自己进程里留下约 **3.6 GiB** 的
  `cudaMallocAsync` 分配器缓存，而 `nvidia-smi --query-compute-apps` **列不出占用进程**。
  所以「显存看着不够但没人占着」的时候，正确动作是让 ComfyUI 自己交回：
  `POST /free` + `{"unload_models":false,"free_memory":true}`。插件**不会再替你发**这个请求（它不碰别人的进程），
  只在 `qwen_image_status` 里把显存数字报出来，由你决定。
- 这一块是**静态说明**，不做动态探测。文案纪律由 `test/settings.test.mjs` 守住：
  结论性措辞（`已定位` / `WDDM` / `对照实验`）**必须**出现在已定位的 finding 里且**必须**带实测数字；
  同时**全块禁止**任何修复承诺（`正在优化` / `即将修复` / `预计` / `会修好` / `保证` 一律测试失败），
  并**禁止**任何被撤回或被证伪的数字（`8 倍` / `15 倍` / `7.75` / `0.98` / `37 s` / `口径存疑`）重新出现。

### 保存语义

- **保存即写入**：改动直接落到本插件的配置里，不需要重启。写入是**带 revision 校验**的——
  如果同一份配置在别处被改过（比如你手改了 profile 文件），这次写入会被拒绝并**重新读取**当前值，
  页面会明确报「已在别处被修改，请核对后重试」，而不是拿过期值覆盖别人的改动。
- 配置条目为只读时（宿主把该条目标成不可写），页面会直接说明**无法保存修改**，并且**一个写请求都不会发出去**。

> 这一节要生效，要求 DSH **0.2.0-rc.2 或更高**：0.1.18 起一级入口才改为 `settings.section` 槽，
> 且 0.2.0 的设置模型才由宿主按插件自身的 `Config` schema 生成可写页面（字段需标 `volatile()`）。
> 插件的一半（工具与技能）在更老的 DSH 上照常可用——**设置页不可用时不会影响出图工具**。
