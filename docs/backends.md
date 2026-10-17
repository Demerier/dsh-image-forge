# 后端（详细）

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
  没有它，「这次编辑花了 260 秒」是一个无法追问的数字——而追问出来的结论见[下一节](#出图--编辑都优先用-comfyui速度--画质)。

### 出图 / 编辑都优先用 `comfyui`（速度 + 画质）

`backend: "auto"` 的默认顺序就是「有 key 走云 API，否则先试本机 ComfyUI，最后才落到 worker」，
正常情况不需要手动指定。两条**独立**理由都指向同一个顺序：

1. **速度**：同画布 992×992 的步数扫描里 `comfyui` 0.727 s/步、`local`（本插件 worker）2.014 s/步，
   每步 **2.77×**（两侧量化档不同，别读成纯后端差异）；编辑路径差得更远，见[下一节](#本地编辑为什么慢8-gb-卡上请优先用-comfyui)。
2. **画质**：同提示词、同 seed、**同尺寸**的对照里 `comfyui` 更好——这是目视判断，不是客观指标；
   结构上也说得通：`comfyui` 走真·低比特 GEMM（`convrot_w4a4_linear`，int8-convrot 权重），
   而本插件 worker 的 bnb nf4 权重会先反量化成 bf16 再走 bf16 GEMM（内核画像见[配置与设置页](configuration.md#设置页dsh-web-gui)）。

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
| **≤ 896** | 放行，不插话；但**画布 > 1.0 MP 且预算 > 512** 时会附一条**画布侧建议**（`local_edit_budget.warning`，仍放行） | 1216×672 → 峰值 reserved **7458 MiB**，3/3 次逐位一致；同一预算在 1248×1248 上是 **67 s/步**（本机实测） |
| **897–960** | **放行，但结果里带警告**（`local_edit_budget.warning`，并写进 `summary` 的可见文本） | 960×960 通过，但峰值 reserved **8492 MiB > 卡总量 8188**（走 WDDM 共享内存），去噪 21.19 s ≈ 928 档的 2 倍 |
| **> 960** | **默认拒绝**，抛一条点明失败形态与四条出路的错误 | 992–1024 = GPU 去噪 `torch.OutOfMemoryError`；≥1216 = CPU 文本编码段 **访问违例**，worker 进程有时直接消失 |

分档判的是**生效的** `_reference_budget`，而它有两个来源：配置 `localReferenceBudget`（优先），没有配置才按画布
推导。回执里的 `local_edit_budget.budget_source`（`config` / `canvas`）、`canvas_budget` 与 `configured_budget`
把这次用的是哪一个说明白。

> ⚠️ **分档只按预算，不含画布本身的代价**——这是本节最容易读错的一处，也是本机实测纠正的地方：
> 896 那条「可靠线」的出处是 **1216×672**（0.82 MP）。

> **`localReferenceBudget` 让 `local` 编辑在 1.5MP 画布上可跑，但只有 `512` 这一档**：七档默认画布算出的预算都是
> 1216–1248，落在拒绝档；把预算设成 `512` 后**同一张 1248×1248 画布会被放行**，实测 wall **109.5 s**、
> 峰值 reserved **6488 MiB**、worker 存活。**`896` 不能照搬到这里**：同一张 1248×1248 用 896 实测 **67 s/步**、
> 25 步外推 **≈28 min**，两次都被运行器墙钟杀掉而**没有任何报错**——等于不可用（**不是**「会 OOM / 会崩」）。
> （换到的是速度：§19 预算 992 → 512 时编码 37.7 → 16.5 s、每步 3.4 → 1.67 s。）
> 保真度：同画布（1216×672）896 vs 512 **目视看不出差别**（n=1、1 位评判者），1.5MP 画布上只测了 512；
> **513–895 这段在 1.5MP 画布上没有量过**，所以文档与工具文案都不写「无副作用」。预算填 `0`（默认）= 由画布推导，
> 与没有这个旋钮时逐位一致。

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

**画布侧警告（后加的一条，**放行**、不是拒绝）**：**生效预算 > 512** 且**画布面积 > 1.0 MP** 时，
尺寸门在放行的同时把一条画布侧建议写进同一个 `local_edit_budget.warning`（并照旧进 `summary`）——
它只在预算本身没被拒的档（可靠档的新增情形、贴边档、以及覆盖开关放行的档）里出现，措辞与那一档的原有结论并列
而不冲突（覆盖放行时同一条警告里既有「按用户显式授权放行」，也有画布侧实测）。阈值 **1.0 MP** 是插值：
两个实测端点是 `0.82 MP / 896 = 1.9 s/步` ↔ `1.55 MP / 896 = 67 s/步`，**中间没有测过**（本机实测）；
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

