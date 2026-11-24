# 配置与设置页（详细）

## 配置

在 profile 的插件配置里给出（`Config` schema 见 `src/index.ts`）。**一共 16 个字段**。
插件不下载、不托管 ComfyUI 或权重，但可以选择 MCP / CLI / HTTP 三种执行路径；云端 API 字段
（`backend` / `apiBaseUrl` / `apiKey` / `apiModel` / `apiStyle`）已删除，旧 profile 里残留的键会被忽略。

| 字段 | 默认 | 说明 |
|---|---|---|
| `comfyEndpoint` | 空 | ComfyUI 地址，如 `http://127.0.0.1:8188`；**空 = 自动探测 `comfyPorts`**。非回环地址会被拒绝（本地生成只与本机通信） |
| `comfyPorts` | `8000,8188,8189,8190,8191,8192` | `comfyEndpoint` 为空时依次尝试的端口（桌面版常见 8000/8188，便携版 8188） |
| `comfyModelsDir` | **探测**：候选目录里第一个存在的 | ComfyUI 的 `models` 根目录，**只用于报错里写清「文件该放到哪」**；探测不到就留空 |
| `comfyModel` | `qwen21-base` | `qwen21-base` / `qwen21-turbo` / `moss-sft`；旧值 `base` / `turbo` 仍兼容 |
| `mossSampling` | `comfy` | MOSS 采样档位：`comfy`（25 步 / CFG 2.5 / `er_sde`）或 `official`（50 步 / CFG 3 / `euler`） |
| `turboSteps` | 空 | turbo 专用步数；**空 = 8**，不继承 `defaultSteps` |
| `defaultSteps` | `40` | Qwen base 的默认步数；MOSS 使用自己的采样档位 |
| `comfyuiSteps` | 空 | ComfyUI 专用步数；**空 = `defaultSteps`** |
| `executionBackend` | `auto` | `auto` 依次尝试 MCP → CLI → HTTP；`mcp` / `cli` 为严格模式，失败不会静默回退；`http` 直接走内置路径 |
| `comfyMcpBin` | 空 | `comfy-mcp` 可执行文件路径；**空 = 从 PATH 查找** |
| `comfyBin` | 空 | 传给 MCP 子进程的 comfy CLI 路径；**空 = 从 PATH 查找** |
| `backendTimeoutMs` | 空 | 单个后端的超时预算；**空 = 使用 `timeoutMs`** |
| `mcpDebug` | `false` | 开启后每次 MCP 工具调用写一行 stderr |
| `backendTmpDir` | 空 | 后端临时/镜像目录；**空 = 工作区 `.dsh-image-forge/backend-mirror`** |
| `outputDir` | `~/Pictures/dsh-image-forge` | 图片落盘目录 |
| `timeoutMs` | `180000` | 单次调用预算（ComfyUI 首次冷加载模型很慢，可调到 `900000`） |

执行后端只改变「怎么把图请求交给本机 ComfyUI」，不改变图的内容或画板落盘语义。详细链路和结果镜像见
[usage-reference.md](usage-reference.md#执行后端与受管环境t22)。

**步数解析优先级**（三条，互不越界）：

```text
Qwen base :  调用方显式 steps  >  comfyuiSteps  >  defaultSteps（默认 40）
turbo     :  调用方显式 steps  >  turboSteps    >  8
MOSS      :  调用方显式 steps  >  comfyuiSteps  >  采样档位自带（comfy 25 / official 50）
```

`defaultSteps` 是 **Qwen base 的默认**；MOSS 的步数是模型家族属性（官方模板口径 25、OpenMOSS 卡片
口径 50），由 `mossSampling` 直接给出，不会被 `defaultSteps` 带着走——想改 MOSS 的步数用
`comfyuiSteps` 或换档位。Qwen 两个 profile 没有档位表，所以 `comfyuiSteps` → `defaultSteps`
这条链对它们逐字不变。Agent 工具与 Studio 走的是**同一条**链（`resolveSteps` /
`resolveStudioSteps`），两条通路不会给出不同的步数。

结果里恒带 `steps_used`（实际步数）与 `steps_source`（`explicit` / `backend` / `default`），
所以「为什么这张不一样」可以直接从返回值回答。档位自带的值报 `default`（它是模型家族自己的
工作点，不是你覆盖的、也不是共享的 ComfyUI 覆盖）。解析发生在**每次派发时**，
设置页改完步数、权重档、档位、端口，下一次调用立即生效（工具在每次调用时重新读取配置）。
turbo 之所以不落回 `defaultSteps`：蒸馏按 8 步调，把 Qwen base 的默认步数递给它只会「更贵且更差」，不是「更精细」。

**为什么默认是 40 步**：官方 GitHub 模型卡推荐 `num_inference_steps: 40`，官方教程描述 25→40 的收益是
细节区「fizzle」减少、手指这类固执细节约 30 步内收敛；代价是耗时近似线性，40 步 ≈ **1.6 × 25 步**
（本机 8 GB 卡 25 步 45–55 s/张，按官方口径外推 40 步约 70–90 s，未重新实测）。

**但不是越多越好**：同提示词、同 seed 下 25 → 50 步，本机旧对照的客观指标反而**变差**——
lapvar **1019 → 970**、hf_frac **0.0317 → 0.0279**（高频占比变小 = 没有更多细节）。40 是官方推荐的
起点，`defaultSteps` **没有被锁死**，觉得慢或够用可以调回 25。**要更多细节就把画布提上去，不是无脑堆步数。**

## 设置页（DSH Web GUI）

**16 个字段全部可写，也全部在页面上**——没有隐藏项。云端 API 标签页随该后端一起删除了。

- 菜单位置：**设置 → 「生图配置」**——和「通用设置 / 模式 / 插件 / Agent 预设」同级的**一级菜单项**
  （注册进 `settings.section` 这个 **list 槽**，用 `id` 定位）。
- **工作台不在这里**：它是 web 客户端的**全局面板**（T17 迁出设置页），两处注册都由 `registerStudioPanel`
  发出——`main` **keyed 槽**（`{ name: 'main', key: 'dsh-image-forge' }`）放面板本体，`sidebar.panellist`
  **list 槽**（`{ name: 'sidebar.panellist', id: 'dsh-image-forge', order, label: '图像工作台' }`）放左侧栏那一行；
  同一个 `id` 让侧栏那行把主列切到工作台。席位细节与宿主契约证据见 [client-bundle.md](client-bundle.md)。
  宿主 shell 没有这两个槽时注册不会发生（面板不出现），**工具与设置页照常可用**（座位失败不拖累出图）。
- **两个配置标签页**，字段在宽栏下两列铺开：

  | 标签 | 内容 |
  |---|---|
  | 出图 | 步数与输出分组：`defaultSteps` / `comfyuiSteps` / `turboSteps` / `comfyModel` / `mossSampling` / `outputDir` / `timeoutMs` |
  | ComfyUI / 执行后端 | ComfyUI 分组：`comfyEndpoint` / `comfyPorts` / `comfyModelsDir`；执行后端分组：`executionBackend` / `comfyMcpBin` / `comfyBin` / `backendTimeoutMs` / `mcpDebug` / `backendTmpDir` |

- **页面可见字段**（四块，每块都有标题与一行说明）：

  | 分区 | 字段 |
  |---|---|
  | 步数（画质与耗时） | `defaultSteps`、`comfyuiSteps`、`comfyModel`、`mossSampling`、`turboSteps` |
  | ComfyUI | `comfyEndpoint`、`comfyPorts`、`comfyModelsDir` |
  | 执行后端 | `executionBackend`、`comfyMcpBin`、`comfyBin`、`backendTimeoutMs`、`mcpDebug`、`backendTmpDir` |
  | 输出与超时 | `outputDir`、`timeoutMs` |

- `comfyModel` 是**下拉**，数值字段带默认值与上下限提示，其余是文本框（带说明文案）。
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

- 步数扫描拟合出的**斜率**（而不是「总时长 ÷ 步数」）——两个推理栈都在的时候量的：

  | 推理栈 | 量化档 | 斜率 | 截距 |
  |---|---|---|---|
  | ComfyUI（现行） | `int8-convrot` | **0.727 s/步**（复测 0.768） | 1.60 s |
  | 受管 worker（v0.1，已删除） | bnb `nf4` | **2.014 s/步**（11 个稳态样本，2.012–2.016） | — |

  ⇒ 每步倍率 2.77×（同机、同画布 992×992、同 prompt、seed 0，两侧都是 1 次前向/步）。
  ⚠️ 两侧量化档不同，所以这个倍率**不是纯「后端差异」**。这组对照的用处只有一个：说明为什么 v0.1 的
  自建 worker 被删掉。

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

- **显存调度：先交给 ComfyUI（8 GB 卡必读）**。NVIDIA Windows/Linux 上 ComfyUI **默认已开 dynamic VRAM**：
  按需逐层 fault-in 权重，而不是整包常驻后 OOM；文本编码器也跟着这套驻留策略走，8 GB 卡上让它 offload 是正解。
  所以**不要**用 `--novram` / `--highvram` / `--gpu-only` / `--cpu` 去「手动省显存」——它们会关掉 dynamic VRAM，
  反而更糟；`--lowvram` 在 dynamic VRAM 开启时**无效**。要调就调新参数：`--dynamic-vram`、`--vram-headroom N`、
  `--fast-disk`（官方启动参数文档）。
- ⚠️ **`/free` 不是常规轮询手段**：ComfyUI 跑完会在自己进程里留下约 **3.6 GiB** 的 `cudaMallocAsync` 分配器缓存，
  而 `nvidia-smi --query-compute-apps` **列不出占用进程**。只有「卡被别的程序挤占、这一轮必须立刻回收显存」时，
  才让 ComfyUI 自己交回：`POST /free` + `{"unload_models":false,"free_memory":true}`——`free_memory=true` 清 VRAM，
  `unload_models=true` 会连 RAM 里的模型一起清、下一轮被迫重载，所以**别在轮次之间调**。插件**不会再替你发**
  这个请求（它不碰别人的进程），只在 `image_forge_status` 里把显存数字报出来，由你决定。
- **权重档位选择（8 GB 卡口径）**：插件按 `/object_info` 枚举到的**文件名打分**，不硬编码文件名。
  文本编码器优先 `qwen3vl_8b_w4a8.safetensors`（≈5.88 GiB，比 `int8_convrot` 的 8.71 GiB 省 ~2.8 GiB；
  8 GB 卡上它是**驻 RAM / 按需 offload**，不是常驻显存），没有 w4a8 才回落 `qwen3vl_8b_int8_convrot`，
  bf16（16.33 GiB，8 GB 卡放不下）排最后。DiT 仍是 `int8_convrot`（≈6.76 GiB）优先，两处打分互不影响；
  MOSS 的文本编码器走它自己的规则（见 `docs/comfyui-deployment.md`）。
- **QwenImage21Cache（前缀 KV cache）**：官方 Qwen-Image 2.1 工作流在 UNETLoader 后串了
  `QwenImage21Cache`（`device=auto`、`dtype=default`），把文本/参考图 token 的前缀只算一次、全步复用；
  官方说明**改图的大部分加速来自这里**。插件已把它接进 base / turbo 的 t2i 与 edit 四张图。它需要
  **ComfyUI ≥ 0.37.0**：老版本缺这个节点时插件会**自动跳过并提示**（图照常出，只是没有前缀缓存），
  不会提交一张必失败的工作流；`image_forge_status` 会把 `/system_stats` 的版本与要求对比，给出
  `qwen_cache.version_satisfied`（版本读不到时为 `null`，不猜）。`gpu` 档有已知损坏 bug
  （ComfyUI #16879 / #16900），所以固定用 `auto` 与无损的 `default` dtype。
  **加速数字不写死**：开/关 × t2i/edit × turbo 的 A/B 由 X04 实验补齐，本表不编造。
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
