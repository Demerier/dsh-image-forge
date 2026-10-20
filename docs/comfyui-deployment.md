# 本机 ComfyUI 部署指引（推荐方案）

本插件**不自带任何本地运行时**：不建 venv、不下权重、不拉进程。出图只有两条路——云端 key，或
**你自己装好的 ComfyUI**。这份文档讲第二条路怎么从零搭起来。

两条路的边界先讲清楚，省得白折腾：

| 能力 | 云端 key（`api`） | 本机 ComfyUI（`comfyui`） |
|---|---|---|
| 文生图 | ✅ | ✅ |
| 改图 / 融图（`qwen_image_edit`） | ❌ **没有编辑通道** | ✅ |
| 需要联网 | ✅ 每次调用都要 | ❌ 首次下载权重之后可离线 |
| 需要显卡 | ❌ | ✅（8 GB 显存起步，实测见 §8） |

所以：**只要你想改图，ComfyUI 就是必装项**，不是可选项。

> 本文所有路径、大小、sha256、端口都来自**本机实测**（Windows 11 + ComfyUI Desktop 0.41.3 +
> RTX 4070 Laptop 8188 MiB），不是照抄文档。你的安装盘符不同就把 `D:` 换成你自己的。

---

## 0. 先看这三个数字

| 项 | 要求 | 说明 |
|---|---|---|
| 显存 | **≥ 8 GB** | int8_convrot 权重就是按这个量级放的；6 GB 卡会 OOM |
| 磁盘 | **≥ 30 GiB 空闲** | 权重 base 三件套 16.10 GiB，加 turbo 主干共 22.86 GiB，ComfyUI 本体另占 2–3 GiB |
| 网络 | 能到 `hf-mirror.com` | `huggingface.co` 直连本机实测 **502**，走镜像 |

---

## 1. 装 ComfyUI 桌面版

1. 打开官方下载页 **<https://www.comfy.org/download>**，下载 Windows 安装包（`.exe`）。
   macOS / Linux 也在同一页；不想用桌面版可以退而用 portable 压缩包，后面 §3 的目录会不一样。
2. 安装时它会问你**装到哪个盘**。本机装在 `D:\Comfy-Desktop`，于是得到：

   ```
   D:\Comfy-Desktop\
   ├─ ComfyUI-Installs\ComfyUI\      ← 程序本体（ComfyUI 源码 + Python 环境）
   ├─ ComfyUI-Shared\               ← 共享目录（输入 / 输出 / 模型树）
   │  ├─ input\
   │  ├─ output\
   │  └─ models\                    ← ★ 权重放这里
   └─ ComfyUI-Cache\
   ```

   **为什么是「Shared」而不是 `Installs\…\models`**：桌面版把模型树独立出来，好让多个实例复用同一份
   权重，不至于装第二个实例时再下一遍 20 GB。`ComfyUI-Installs\ComfyUI\ComfyUI\models` 里那个
   `diffusion_models\`、`text_encoders\` 是**空目录**——往里放权重，插件和 ComfyUI 都看不到。

3. 选计算后端时选 **CUDA**（NVIDIA 卡）。AMD / Apple Silicon 走各自的分支，本插件不区分，只要
   ComfyUI 自己能出图就行。

---

## 2. 建实例并启动

桌面版首次启动会建一个实例（instance），然后自动拉起 ComfyUI。启动完成后浏览器会开一个界面；
**不用管界面，只要它活着**。验证它监听在哪：

```bash
curl -s http://127.0.0.1:8188/system_stats
```

本机返回（截取）：

```json
{"system": {"os": "win32", "comfyui_version": "0.41.3",
            "python_version": "3.13.12 ...", "embedded_python": false},
 "devices": [{"name": "cuda:0 NVIDIA GeForce RTX 4070 Laptop GPU : cudaMallocAsync",
              "type": "cuda", "vram_total": 8585216000, "vram_free": 7411335168}]}
```

要点：

- **端口**：本机桌面版是 **8188**（桌面版也可能给 8000）。插件的 `comfyPorts` 默认依次探
  `8000,8188,8189,8190,8191,8192`，一般不用改；监听在别的端口就把端口写进 `comfyPorts`，
  或直接写死 `comfyEndpoint = http://127.0.0.1:<端口>`。
- **版本**：`comfyui_version` 要 **≥ 0.37**（Qwen-Image 2.1 的节点从这一版起提供）。本机 0.41.3。
  太老的版本装不上模板，也认不了 `int8_convrot` 权重。
- 桌面版启动参数里带 `--lowvram`（本机实测），这是它自己的省显存策略，和插件无关；插件不会传
  任何启动参数，也不重启 ComfyUI。

---

## 3. 找到「三个 loader 真正会去看」的目录

这是整件事最容易错的一步。桌面版不是读 `models\unet`，而是通过一个**生成出来的 yaml** 把所有模型
目录重新映射一遍。找它的办法有两种，任选：

**办法 A（看命令行参数，最准）**：

```bash
curl -s http://127.0.0.1:8188/system_stats | grep -o '"--extra-model-paths-config", *"[^"]*"'
```

本机拿到的参数里有：

```
"--extra-model-paths-config", "C:\\Users\\Demeri\\AppData\\Roaming\\Comfy Desktop\\instance-model-paths\\inst-…….yaml"
```

（PowerShell 一行版：`(Invoke-RestMethod http://127.0.0.1:8188/system_stats).system.argv`）

打开那个 yaml，第一行有效配置就是答案：

```yaml
comfy.desktop_0:
  base_path: 'D:\Comfy-Desktop\ComfyUI-Shared\models'     # ★ 就是它
  is_default: true
  ...
  'text_encoders': 'text_encoders/'
  'vae': 'vae/'
  'unet': 'unet/'
```

**办法 B（界面）**：ComfyUI 界面 → 设置（齿轮）→ 搜 `model` → 看「模型路径 / Models path」。

于是**权重要去的地方**是：

```
<base_path>\unet\    ← DiT 主干
<base_path>\clip\    ← 文本编码器
<base_path>\vae\     ← VAE
```

本机 `base_path` 是 `D:\Comfy-Desktop\ComfyUI-Shared\models`，所以：

| 权重 | 落到 |
|---|---|
| 主干（base） | `D:\Comfy-Desktop\ComfyUI-Shared\models\unet\` |
| 主干（turbo） | 同上（turbo 是**另一份文件**，不是同一个文件改名） |
| 文本编码器 | `D:\Comfy-Desktop\ComfyUI-Shared\models\clip\` |
| VAE | `D:\Comfy-Desktop\ComfyUI-Shared\models\vae\` |

### 目录名为什么和 HuggingFace 仓库里不一样

镜像上的仓库是按 HF 的分类命名的，**下载路径**和**落盘路径**是两套名字，别混：

| HF 仓库里的路径（下载用） | 桌面版目录名（落盘用） | 谁读它 |
|---|---|---|
| `diffusion_models/qwen_image_2.1_*.safetensors` | `models\unet\` | `UNETLoader.unet_name` |
| `text_encoders/qwen3vl_8b_*.safetensors` | `models\clip\` | `CLIPLoader.clip_name` |
| `vae/qwen_image_2.1_vae_bf16.safetensors` | `models\vae\` | `VAELoader.vae_name` |

`models\diffusion_models\` 和 `models\text_encoders\` 虽然在 yaml 里也映射了，但**那是给别的
节点用的**（新版 `UNETLoader` 只列 `unet\`）。放错地方的典型症状是：文件明明在，ComfyUI 的
下拉框里就是没有它。

---

## 4. 下权重（走当前网络能通的镜像）

### 4.1 先认清为什么不用 huggingface.co

本机实测：

| 目标 | 结果 |
|---|---|
| `https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/...` | **HTTP 502**（连不上） |
| `https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/...` | **HTTP 302 → 206**（可下、可续传） |

所以下面全部用 `hf-mirror.com`。镜像和官方是同一份文件：镜像响应头里的 `X-Linked-Size` /
`X-Linked-Etag` 与本地文件的字节数、sha256 完全一致（见 §6）。

### 4.2 四个文件

| 文件 | 大小（字节） | ≈ | sha256 |
|---|---|---|---|
| `qwen_image_2.1_int8_convrot.safetensors` | 7 256 783 064 | 6.76 GiB | `cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d` |
| `qwen_image_2.1_turbo_int8_convrot.safetensors` | 7 256 787 829 | 6.76 GiB | `8144a0182964aa8403ad6dbc011db837304167d235161b9aabaa8532e967314c` |
| `qwen3vl_8b_int8_convrot.safetensors` | 9 350 798 360 | 8.71 GiB | `8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f` |
| `qwen_image_2.1_vae_bf16.safetensors` | 675 509 688 | 0.63 GiB | `bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9` |

**必须下三个**（主干 + 文本编码器 + VAE）；主干下 **base** 还是 **turbo** 看你用哪一档：

- 只下 base → base 三件套 = **16.10 GiB**，`comfyModel: "base"` 可用。
- base + turbo 都下 → **22.86 GiB**，两档随时切（推荐，省得以后补下）。
- 只下 turbo → turbo 三件套 = 16.10 GiB，但 `comfyModel: "base"` 会找不到主干。

### 4.3 命令（Windows）

**PowerShell（Win11 默认终端）**：

```powershell
$BASE   = 'https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main'
$MODELS = 'D:\Comfy-Desktop\ComfyUI-Shared\models'

curl.exe -L -C - --retry 5 --retry-delay 5 -o "$MODELS\unet\qwen_image_2.1_int8_convrot.safetensors"       "$BASE/diffusion_models/qwen_image_2.1_int8_convrot.safetensors"
curl.exe -L -C - --retry 5 --retry-delay 5 -o "$MODELS\unet\qwen_image_2.1_turbo_int8_convrot.safetensors" "$BASE/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors"
curl.exe -L -C - --retry 5 --retry-delay 5 -o "$MODELS\clip\qwen3vl_8b_int8_convrot.safetensors"           "$BASE/text_encoders/qwen3vl_8b_int8_convrot.safetensors"
curl.exe -L -C - --retry 5 --retry-delay 5 -o "$MODELS\vae\qwen_image_2.1_vae_bf16.safetensors"             "$BASE/vae/qwen_image_2.1_vae_bf16.safetensors"
```

**cmd**（`$MODELS` → `%MODELS%`，其余相同）：

```bat
set BASE=https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main
set MODELS=D:\Comfy-Desktop\ComfyUI-Shared\models

curl.exe -L -C - --retry 5 --retry-delay 5 -o "%MODELS%\unet\qwen_image_2.1_int8_convrot.safetensors" "%BASE%/diffusion_models/qwen_image_2.1_int8_convrot.safetensors"
```

- **必须写 `curl.exe` 而不是 `curl`**：PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，
  不认 `-C -` 和 `--retry`。
- `-C -` 是**断点续传**：断了重跑同一条命令就从断处接着下，不会从 0 开始（实测镜像支持
  `Range` → `206`）。GB 级文件必开。
- `--retry 5` 兜住偶发断流。下载失败的常见死法是「文件只有几百 KB」，一看大小就知道（§6）。
- **别用浏览器点链接**下 8 GB 的文件：断了没有续传，白等。

**已经有 HF CLI 的话**（`pip install -U huggingface_hub`，命令名 `hf`）：

```powershell
$env:HF_ENDPOINT = 'https://hf-mirror.com'
hf download Comfy-Org/Qwen-Image-2.1 --local-dir $MODELS `
  --include "diffusion_models/qwen_image_2.1_int8_convrot.safetensors" `
            "diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors" `
            "text_encoders/qwen3vl_8b_int8_convrot.safetensors" `
            "vae/qwen_image_2.1_vae_bf16.safetensors"
```

它保留了 HF 的目录结构（`diffusion_models\` / `text_encoders\` / `vae\`），**所以下完还得按 §3
的表手工搬一次：`diffusion_models\*.safetensors` → `unet\`，`text_encoders\*.safetensors` → `clip\`。**
这也是为什么 §4.3 的第一种写法更省事——直接下到目标目录。

---

## 5. 让 ComfyUI 认出新权重

放完文件**必须让 ComfyUI 重新扫一遍模型目录**，否则下拉框里还是没有：

- 桌面版：界面右上角**重启**（或退出应用再打开）。改 `extra_model_paths` 之后更是必须重启。
- portable / 源码版：`Ctrl+C` 停掉进程再起。

---

## 6. 校验（别跳过，这一步能省掉几小时排障）

下面统一把 `$M` 当作 `D:\Comfy-Desktop\ComfyUI-Shared\models`（照你自己的 `base_path` 换）。

### 6.1 大小对不对

```powershell
Get-ChildItem "$M\unet\*.safetensors", "$M\clip\qwen3vl*.safetensors", "$M\vae\qwen_image_2.1*.safetensors" |
  Select-Object Name, Length
```

对照 §4.2 的字节数。**差一个字节都不行**——`safetensors` 头里带张量偏移，截断的文件会在加载时
报 `Error while deserializing header` 之类，很难往「下载不全」上想。

### 6.2 sha256 对不对

```powershell
Get-ChildItem "$M\unet\*.safetensors", "$M\clip\qwen3vl*.safetensors", "$M\vae\qwen_image_2.1*.safetensors" |
  Get-FileHash -Algorithm SHA256 | Select-Object Hash, Path
```

或者逐个来（cmd 也行）：

```bat
certutil -hashfile "D:\Comfy-Desktop\ComfyUI-Shared\models\unet\qwen_image_2.1_int8_convrot.safetensors" SHA256
```

四个文件逐个对 §4.2 的表。以 `cb7411…` 开头的那一行就是对的。

> 这些 sha256 不是手抄的：它们是**本地文件的实测哈希**，同时也等于镜像响应头里的 `X-Linked-Etag`。
> 两边对得上，才敢说镜像给的是同一份文件。

### 6.3 ComfyUI 自己能不能枚举到（最权威）

```bash
curl -s http://127.0.0.1:8188/object_info > object_info.json
```

在返回的 JSON 里找这三个键（本机实测值）：

```json
"UNETLoader":  {"input":{"required":{"unet_name":[["...","qwen_image_2.1_int8_convrot.safetensors",
                                                   "qwen_image_2.1_turbo_int8_convrot.safetensors"]]}}}
"CLIPLoader":  {"input":{"required":{"clip_name":[["...","qwen3vl_8b_int8_convrot.safetensors"]],
                                        "type":[["...","qwen_image","..."]]}}}
"VAELoader":   {"input":{"required":{"vae_name":[["...","qwen_image_2.1_vae_bf16.safetensors","pixel_space"]]}}}
```

三条都对上就装好了。特别看 `CLIPLoader.type` 的候选里**有没有 `qwen_image`**——没有就是 ComfyUI
版本太老（§2 的版本要求），换权重没用，得升级。

---

## 7. 插件侧配置

设置页「ComfyUI」一栏：

| 字段 | 建议值 | 说明 |
|---|---|---|
| `comfyEndpoint` | 留空 | 留空 = 按 `comfyPorts` 挨个探。端口固定的话写死 `http://127.0.0.1:8188` 更快 |
| `comfyPorts` | `8000,8188,8189,8190,8191,8192`（默认） | 监听在别的端口就把那个端口加进来 |
| `comfyModelsDir` | 自动探测到的 `…\ComfyUI-Shared\models` | **只用于把错误信息写具体**（「把文件放进 X」）。插件不往这里读写任何东西，ComfyUI 自己管它的目录 |
| `comfyModel` | `turbo` | 8 步，同画质约快 2.7×。写实人像 / 画面里有中文文字 / 古典绘画性构图切 `base` |
| `turboSteps` | 留空 = 8 | turbo 的步数。`base` 用 `defaultSteps`（25） |
| `comfyuiSteps` | 留空 | 只对 `comfyui` 后端生效的步数覆盖；一般不用填 |

做完跑一次体检：

```
qwen_image_status
```

它会把三件事一次报清：云 API 通不通、ComfyUI 通不通（探了哪几个端口、三个权重能不能被枚举到、
显卡型号与显存余量）、输出目录能不能写。`next_steps` 非空就照着那句话做。

---

## 8. 实测基准（8 GB 卡）

RTX 4070 Laptop（8188 MiB，`cudaMallocAsync`）、ComfyUI 0.41.3、int8_convrot 权重：

| 场景 | 步数 | 耗时 |
|---|---|---|
| 文生图 1312×736 | 8（turbo） | 19–23 s，约 2 s/步 |
| 编辑 1312×736，1 张参考图 | 8（turbo） | 19–23 s |

- 比 base（25 步）快约 **2.7×**，画质盲测无显著差异——**除了写实人像、画面中文字、古典构图**这三类，
  turbo 会掉细节，那几类切 `base`。
- 显存由 ComfyUI 自己调度（本机桌面版带 `--lowvram`）。真不够时是**干净的 CUDA OOM**回报，
  不是插件拒绝你：调小 `width`/`height`，或先关掉别的吃显存程序。
- 卡上同时跑第二个 ComfyUI 实例 / 游戏 / Blender，会显著拖慢甚至 OOM。

---

## 9. 排障对照表

| 症状 | 病因 | 处理 |
|---|---|---|
| `qwen_image_status` 说 ComfyUI 没在跑，但界面明明开着 | 端口不在探测列表 | 看 §2 拿到真实端口，写进 `comfyPorts` 或 `comfyEndpoint` |
| 报「缺 unet / 找不到主干」 | 权重放进了 `diffusion_models\` 或 `Installs\…\models` | 搬到 `<base_path>\unet\`（§3） |
| 文件在 `unet\` 里，下拉框却没有 | 没重启 ComfyUI | 重启实例（§5） |
| 加载时报 `header` / 反序列化错误 | 下载被截断 | 比对字节数，删掉重下（`-C -` 续传，§4.3） |
| `CLIPLoader` 的 `type` 里没有 `qwen_image` | ComfyUI 版本 < 0.37 | 升级桌面版 |
| 编辑 CUDA OOM | 画布太大 / 卡被占 | 减小 `width`/`height`；关掉别的吃显存程序；必要时让 ComfyUI 走 `/free` |
| `diffusion_models\` 里放对了还是不行 | 桌面版两个 `models` 目录搞混了 | 认 `system_stats` 的 `extra-model-paths-config` → `base_path`（§3 办法 A），只信这个 |
| 下载速度为 0 / 反复断 | 直连 HF 或镜像抖动 | 确认域名是 `hf-mirror.com`；`--retry 5`；`-C -` 反复续传 |

---

## 10. 不用桌面版的话

portable 压缩版 / 源码克隆版没有 `ComfyUI-Shared` 那层，权重直接放：

```
<ComfyUI>\models\unet\        ← diffusion_models 里的两个
<ComfyUI>\models\clip\        ← text_encoders 里的那个
<ComfyUI>\models\vae\         ← vae 里的那个
```

portable 版默认端口是 **8188**（桌面版可能是 8000/8188）。插件 `comfyModelsDir` 的探测列表里
也包含 `<安装目录>\models`、`~/ComfyUI/models`、`/opt/ComfyUI/models` 这些常见位置——探错了就在
设置页改掉，它只影响报错文案。
