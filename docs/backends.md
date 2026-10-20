# 后端（详细）

## 只有两条后端

| 后端 | 谁提供算力 | 文生图 | 改图 | 需要联网 | 需要显卡 |
|---|---|---|---|---|---|
| `api` | 云端（OpenAI 兼容端点） | ✅ | ❌ **没有编辑通道** | 每次调用 | ❌ |
| `comfyui` | 你自己装好的本机 ComfyUI | ✅ | ✅ | 首次下载权重 | ✅ |

插件**不自带任何本地运行时**——没有 venv、没有权重缓存、没有受管进程。所以「本地推理」这四个字在这个包里
等价于「**用户自己的 ComfyUI**」，部署步骤见 [comfyui-deployment.md](comfyui-deployment.md)。

`backend: "auto"`（默认）只做一次判断：

```text
有 API key → api     没有 key → comfyui
```

传了参考图时（`qwen_image_edit`）**不看 key**，直接走 ComfyUI，并在结果里给 `api_skipped` 说明原因。
两条都不通时的错误长这样（分项点名缺什么，末尾指向部署文档）：

```text
qwen_image_generate: no backend is available.
  • cloud: no API key found — set `apiKey` ...
  • comfyui: comfyui backend: 没找到在跑的 ComfyUI（已探测 1 个端口）：
  • http://127.0.0.1:8188 — ... 请求失败 — fetch failed (connect ECONNREFUSED ...)
  启动 ComfyUI（桌面版/便携版都可以）后重试；...
  本机部署（ComfyUI 桌面版 + 三个权重，含下载地址）见 docs/comfyui-deployment.md。
```

## 云 API（`api`）

`POST {apiBaseUrl}/images/generations`，OpenAI 图片接口形状：
`{model, prompt, n, size:"WxH", response_format:"b64_json", seed?, steps?, transparent?}`，兼容阿里云百炼的
OpenAI 兼容端点。原生 DashScope 异步任务 API 只留扩展点（`apiStyle: "dashscope"` 已声明、未实现）。

- **没有编辑通道**。官方 Edit 是另一种请求形态（`multipart POST /images/edits`，或 DashScope 的原生异步任务），
  本插件没有实现它，所以 `qwen_image_edit` + `backend: "api"` 会**明确报错**，而不是把参考图丢掉。
- key 读取顺序：`apiKey` → `QWEN_IMAGE_API_KEY` → `DASHSCOPE_API_KEY` → `OPENAI_API_KEY`，**调用时读**，
  不写盘、不进日志；上游 401/403 回传的原文里若带 key，会被 `<redacted-key>` 顶掉。
- 探活走 `GET {apiBaseUrl}/models`：只有 401/403 才算「key 不被接受」，其它状态码说明端点活着。

## 本机 ComfyUI（`comfyui`）

本包**不下载、不转换任何权重**，也不改它的启动参数，只经 HTTP 驱动你已经装好的实例。

1. **找服务**：依次 `GET 127.0.0.1:{comfyPorts 里的端口}/system_stats`，第一个应答得像 ComfyUI 的胜出
   （默认端口 `8000,8188,8189,8190,8191,8192`；桌面版常见 8000/8188）。`comfyEndpoint` 非空时只用它，
   并且**非回环地址直接拒绝**（`127.0.0.0/8` / `localhost` / `::1`，不接受任何域名）。
2. **枚举权重**：`GET /object_info/UNETLoader`、`/object_info/CLIPLoader`、`/object_info/VAELoader`，
   用 `unet_name` / `clip_name` / `vae_name` 的**选项列表**按名字挑文件——**文件名不写死在代码里**。
   `CLIPLoader.type` 同样从它自己的选项里取（优先 `qwen_image`）。
   **一个都挑不到就在送 `/prompt` 之前报错**，点名缺哪个文件、该放进 `comfyModelsDir\unet|clip|vae\`。
3. **提交与取图**：`POST /prompt` → 轮询 `GET /history/{prompt_id}` → `GET /view?filename=…` 取字节，
   再交给本包的落盘逻辑（命名规则与云端一致）。上游的 `node_errors` 与执行 traceback **原文回传**，不吞。
4. **工作流**是官方 Qwen-Image 2.1 txt2img 模板（内联在 `src/comfyui.ts`，`{{placeholder}}` 注入）：
   `UNETLoader → KSampler.model`、`CLIPLoader(type=qwen_image) → TextEncodeQwenImage21 → KSampler`、
   `VAELoader → VAEDecode`、`EmptyLatentImage → KSampler.latent_image`、`VAEDecode → SaveImage`；
   `KSampler` 用模板自带的 `steps=25 / cfg=1 / euler / simple / denoise=1`（`steps` 可被工具参数覆盖）。
5. **改图**（`qwen_image_edit`）：参考图先用 `POST /upload/image`（multipart）送进 ComfyUI 的 `input/` 目录——
   `LoadImage` 只认那里，ComfyUI 没有「按绝对路径加载」的输入；文件名按内容哈希
   （`dsh-forge-ref-<sha256 前 16 位>.png`，`overwrite=true`），同一张图重复送只覆盖自己那份，也不会撞名。
   工作流是**上面那张图 + 官方改图模板的编码节点**：`TextEncodeQwenImage21` 多接 `vae` 与
   `images.image_1`…`images.image_10`（官方 autogrow 槽位，最多 10 张），并收一个 `resolution` 像素预算——
   由插件按画布面积算出（`round(sqrt(W×H)/32)×32`），让参考图缩放后与画布同量级（官方模板警告过：
   两者不一致会让编辑「位移」）。`ComfySwitchNode`（custom_size 开关）不需要，因为插件**总是**给出显式画布；
   `QwenImage21Cache` 同样略去。
6. **硬件信息来自 ComfyUI 自己**：`GET /system_stats` 的 `system.comfyui_version` 与
   `devices[].vram_total/vram_free`（字节 → MiB）。插件不跑 `nvidia-smi`，也不 spawn 任何进程——
   真正要紧的那张卡就是 ComfyUI 加载权重的那张，它自己最清楚。
   `qwen_image_status` 把这几项原样报出来，包括那次请求的 `stats_note`（探测失败时的原因）。

已知代价：ComfyUI 自己也会把每张图存进它的 output 目录（`<ComfyUI>/output/dsh-image-forge_*.png`），
本插件不删它（盘是你的）。

## 两个权重家族：`base` 与 `turbo`

配置 `comfyModel` 决定跑哪一档，`steps` 的解析也随之不同：

| `comfyModel` | 权重文件 | 默认步数 | 什么时候用 |
|---|---|---|---|
| `base`（默认） | `qwen_image_2.1_int8_convrot.safetensors` | 25（`defaultSteps`） | 写实人像、画面里要出现**中文文字**、古典 / 绘画性构图 |
| `turbo` | `qwen_image_2.1_turbo_int8_convrot.safetensors` | 8（`turboSteps`） | 其余日常场景。同画质下快约 **2.7×** |

- **turbo 不继承 25**：蒸馏按 8 步调，把 `defaultSteps` 或 `comfyuiSteps` 的 25 递给它会让画面变差。
  解析优先级是 **调用方显式 `steps` > `turboSteps` > 8**，与 base 那一支完全分开。
- **`turbo` 是请求不是保证**：`/object_info` 里没有 turbo unet 时自动回落 base，结果里
  `comfyui.turbo_fallback` 会写明「已选 turbo，但 /object_info 里没有 turbo 权重，本次用 base 跑」。
- **turbo t2i 用 `cfg=1`、turbo edit 用 `cfg=8`**，走 `SamplerCustomAdvanced + RandomNoise + CFGGuider +
  KSamplerSelect + ManualSigmas`，sigma 表 `1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534,
  0.414568, 0`（9 个值 = 8 步）。这与 base 那一支的 `KSampler(25 步)` 是两套图，不是同一张图改个数字。
- 盲测（5 题、同 prompt 同 seed、1 位评判者）：**base 3 : 2 turbo**；单张 **27–29 s → 9–11 s**。
  turbo 赢在高对比氛围（夜市、动物），输在材质细节、中文小字与印章、古典构图。

## 8 GB 卡上的实测基准

RTX 4070 Laptop **8188 MiB**（`cudaMallocAsync`）、ComfyUI **0.41.3**、int8_convrot 权重：

| 场景 | 步数 | 耗时 |
|---|---|---|
| 文生图 1312×736 | 8（turbo） | 19–23 s，约 2 s/步 |
| 编辑 1312×736，1 张参考图 | 8（turbo） | 19–23 s |

- 显存由 ComfyUI 自己调度（桌面版启动参数里带 `--lowvram`）。真不够时是**干净的 CUDA OOM**回报，
  不是插件拒绝：调小 `width`/`height`，或先关掉别的吃显存程序。
- 卡上同时跑第二个 ComfyUI 实例 / 游戏 / Blender，会显著拖慢甚至 OOM。

## 归档：v0.1 的受管 worker（已删除）

v0.1 随包带过一个受管 worker：`resources/worker.py`（diffusers + bitsandbytes nf4，文本编码器留 CPU、
transformer 在 GPU、VAE tiling 强制开启）、一份 `~/.dsh-image-forge` 运行时（venv + CUDA torch + 10.63 GiB
nf4 权重）、一套进程生命周期与启动前显存门禁。v0.2 全部删除，理由是一组**实测**：

| 项 | 受管 worker（已删） | ComfyUI（保留） |
|---|---|---|
| 每步耗时（992×992 扫描） | `2.014` s/步 | `0.727` s/步 |
| 编辑联合序列（1312×736，6 步） | ≈ 7576 token（文生图 ≈ 3791） | 同画布 8 步 19–23 s |
| 编辑去噪循环 | **179.13 s / 6 步**（合计 219.19 s） | — |
| 编辑峰值 reserved | **8666 MiB > 8188 MiB 物理上限** | — |
| 越界后果 | 驱动走 **WDDM** 共享内存分页，每步 20–40 s（实测波动 14.6 / 31.4 / 31.5 / 42.3 / 20.7 s） | — |
| 前缀 KV cache 对照（A/B/A/B） | cache on **24.06 / 23.20 s** 每步、reserved 8666 / 8514 MiB；cache off **3.40 s** 每步、reserved 6178 MiB | — |
| 1.5MP 画布、预算 512 | wall **109.5 s**、峰值 reserved 6488 MiB（唯一跑得完的档）；预算 896 则 **67 s/步**、25 步外推 ≈28 min（不报错，等于不可用） | — |
| 编码 992 → 512 预算 | `18.81` s → `16.5` s，每步 `3.4` → `1.67` s | — |
| 权重 | 10.63 GiB nf4（`circulus/Qwen-Image-2.1-bnb-4bit`），插件自己下 | 用户按部署文档装一次 |

这是**结构性差距**，不是调参能追上的：两边的量化档不同——ComfyUI 走真·低比特 GEMM
（`convrot_w4a4_linear`，int8-convrot 权重），而 nf4 权重要先反量化成 bf16 再走 bf16 GEMM，
内核画像里 `kDequantizeBlockwise` 反量化段占 **60.3%** 的时间。此外 ComfyUI 进程里还常驻约
`3.6 GiB` 的 `cudaMallocAsync` 分配器缓存（`nvidia-smi --query-compute-apps` 看不到它，这是 v0.1
「显存门禁报不出占用者」的根因）。

要把这条路做到能用等于**换推理栈**，**超出本插件的范围**，所以直接删掉而不是继续优化。上面这些数字
只作为删除决定的依据保留，**不给出改善承诺**。
