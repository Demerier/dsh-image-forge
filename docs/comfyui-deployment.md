# 本机 ComfyUI 部署指引（推荐方案）

本插件**不自带任何本地运行时**：不建 venv、不下权重、不拉进程。出图与改图**只有一条路**——
**你自己装好的 ComfyUI**（云端 API 已随 0.3 方向调整删除，本文不再涉及）。这份文档讲它怎么从零搭起来。

一句话边界：文生图、改图 / 融图（`image_forge_edit`）都跑在这台机器上；首次下载权重之后**完全离线**；
需要显卡（8 GB 显存起步，实测见 §8）。**ComfyUI 是必装项**，不是可选项。

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

## 0.5 先跑一条命令，别急着读下面的手工步骤

仓库自带 `scripts/start-comfyui.mjs`，它把以前最费手的四步（找安装 → 拼启动参数 → 起进程 →
等 `/system_stats` 应答）做成一条命令。**它不下载任何东西，也不改 ComfyUI 的任何配置**：启动参数是
从 Comfy Desktop 自己的 `%APPDATA%\Comfy Desktop\installations.json`（`launchArgs` / `envVars` /
`port`）和 `instance-model-paths\<id>.yaml`（模型树）里读出来的，也就是「桌面版点启动」会用的那一套。

```bash
node scripts/start-comfyui.mjs           # 发现 → 启动 → 等就绪 → 打印显卡/版本/下一步
node scripts/start-comfyui.mjs --doctor  # 只体检，不启动：安装、torch、五个权重、显存
node scripts/start-comfyui.mjs --stop    # 关掉它替你起的那个进程（记在 pid 文件里）
node scripts/start-comfyui.mjs --print   # 只看它准备怎么起，不执行
node scripts/start-comfyui.mjs --dir D:\path\to\ComfyUI   # 手动指定安装目录
```

本机实测输出（RTX 4070 Laptop / 8 GB，ComfyUI 0.45.3）：

```text
[discover] Comfy Desktop (ComfyUI v0.34.0)
[discover] python   D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\.venv\Scripts\python.exe
[wait] /system_stats ..................................... ok
[ready] http://127.0.0.1:8188 (started by this script)
[ready] ComfyUI 0.45.3 · python 3.13.12 · win32
[ready] cuda:0 NVIDIA GeForce RTX 4070 Laptop GPU : cudaMallocAsync 8188 MiB
```

`--doctor` 的输出直接替代了 §6 那套手工 `dir /s` + sha256 对表：

```text
[doctor] model dirs: D:\Comfy-Desktop\ComfyUI-Shared\models (37 个模型文件)
  ✔ 基础 unet（25 步）            6.8 GiB  qwen_image_2.1_int8_convrot.safetensors
  ✔ turbo unet（8 步）          6.8 GiB  qwen_image_2.1_turbo_int8_convrot.safetensors
  ✔ VAE                      0.6 GiB  qwen_image_2.1_vae_bf16.safetensors
  ✔ 文本编码器 t2i                8.8 GiB  qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors
  ✔ 文本编码器 i2i（改图）            8.8 GiB  qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors
[doctor] 结论：可以出图。pnpm run test:live 会真跑一张。
```

> 上面是更早一次实测的快照。T04 在 2026-11-17 复测同一模型根：**39 个模型文件、合计 178.3 GiB**（递归数 `.safetensors`）。
> `--doctor` 自己按扩展名白名单限深度统计（`scripts/start-comfyui.mjs`），计数随本机装/删模型变化，
> 对不上时以 `--doctor` 的现场输出为准，别把这里的数字当校验值。同一时期 base 默认步数还是 25（T05 起改为 40），块内「25 步」只是当时快照里的标签。

退出码：`0` 就绪 / `1` 没找到安装或缺权重 / `2` 进程起不来（会打日志最后 25 行）/ `3` 等超时。

**你只需要读下面这些章节的情形**：脚本说「没找到 ComfyUI」（→ §1 装）、说缺权重（→ §4 下权重）。
其余情况（起不来、端口不对、ComfyUI 看不见权重）先看它的报错原文，比照 §9 排障对照表。

---

## 0.7 出图走哪条后端（T15 引入，T22 变成设置项）

插件的执行链是**一条图、三种运输方式**：图由 `src/comfyui.ts` 构建，随后按顺序尝试

1. **MCP（主通道）**：拉起官方 `comfy-mcp`（stdio），用宿主提供的 `@modelcontextprotocol/client` 驱动；
   `run_workflow` 提交、`job` 轮询、`fetch_outputs` 取回。
2. **comfy CLI（回退）**：直接 `comfy run --workflow …` + `comfy download`，不需要 MCP 层。
3. **HTTP（兜底）**：插件内置的 `/prompt → /history → /view`，任何工具链缺失都不会丢功能。

默认 `executionBackend = auto`：MCP → CLI → HTTP 依次回退；`mcp` / `cli` 是**严格模式**，
该后端失败就是本次调用失败，不会静默换路；`http` 跳过工具链（等价 T15 之前的全部行为）。

设置页「ComfyUI → 执行后端」暴露全部旋钮：`executionBackend`、`comfyMcpBin`、`comfyBin`、
`backendTimeoutMs`、`mcpDebug`、`backendTmpDir`。T15 的环境变量仍**优先于设置**，旧部署不用改：
`DSH_IMAGE_FORGE_BACKEND` / `…_COMFY_MCP_BIN` / `…_COMFY_BIN` / `…_BACKEND_TIMEOUT_MS` /
`…_MCP_DEBUG` / `…_BACKEND_TMPDIR`。

结果镜像（T22）：MCP 的 `fetch_outputs` 与 CLI 的 `download` 的 `out_dir` 落在
`<outputDir>/.dsh-image-forge/backend-mirror/<prompt_id>/`（工作区内画板目录旁），**跑完保留**，
随后仍由现有写图/画板机制归档出图；`backendTmpDir` 可改父目录。

## 0.8 工作台里的「从安装到出图」stepper（T22）

工作台顶部常驻四步：**ComfyUI 运行 → 安装/受管环境 → 权重就绪 → 首次出图**。状态来自能力快照
（宿主用环境探测/`/object_info` 生成）与实时 SSE；安装与下载动作由 `image_forge_setup` 执行。
任一步失败时该行直接显示原因首行，不把失败藏进日志。

### 状态行上的「启动 / 停止」（P2）

stepper 右上的「重新检测」只重读快照；**真正拉起与停止在标题行右侧的状态行上**：

- 未就绪时是主按钮**「启动」**：调 `POST /plugins/dsh-image-forge/studio/environment`（`{"action":"start"}`），
  宿主按 **Comfy Desktop 自己记录的 Python 与启动参数**后台拉起，等 `/system_stats` 就绪后回填面板。
  这是一次**在你显式点击时才发生**的动作，面板不会自己拉进程。
- 运行中且**归属确认**（启动记录里的 pid 还活着、进程命令行里仍是记录的那个 `main.py`）时是**「停止」**，
  点击前要过一次 `window.confirm`。停止会返回 `taskkill` 的退出码，并在停后再探一次 `/system_stats`
  确认端口真的不再应答；成功后删掉启动记录，所以再点一次得到的是 `stopped:false, reason:"no-record"`。
- 运行中但**不是本插件拉起的**（你自己从桌面版/命令行开的）时，「停止」是禁用的并写明
  「由你自己启动的实例，插件不提供停止」。插件永远不会去杀一个它无法证明归属的进程：
  读不到命令行时同样拒绝，并回报「无法确认该进程归属，未执行停止」。
- 面板关闭后进程**继续存活**（`unref`）。所以状态行会明确写出「本次由插件拉起 · pid N」——
  它是在告诉你有个进程比窗口活得久。
- 失败时直接把宿主的 `note` 与**日志路径**原文显示在状态行下方（例：`端口被占：8188 上已有进程在监听`）。
- **看日志在页签栏，不在设置页**：点击「看日志」打开与项目管理/画布同级的日志页；页面显示连接状态、日志来源与路径，默认载入最新 200 行，每行带行号、可解析的时间戳和级别；可「加载更早」向前翻页，也可暂停、刷新或复制。没有可解析时间戳的旧日志不会被伪造时间，页面会明确提示按行号判断先后。没有日志时页面仍会打开并说明原因。
- **端口只有一处真理**：`comfyEndpoint` 配了 loopback 端口（如 `http://127.0.0.1:8000`）时，拉起用的
  `--port`、等待的端点、探活的端点、写进启动记录的端口**全部**是 8000；没配时用 Desktop 记录里的端口。
  端口已被应答时（可能是你自己开的 ComfyUI）直接回报「没有重复拉起」，不会傻等满 180 s。
- 启动参数定制（`extraArgs`）是**阶段 3**：接口已在环境层留好（默认空、不追加任何 flag），本阶段 UI 不暴露输入框。

对应 CLI 仍是 `node scripts/start-comfyui.mjs` / `--stop`；`--stop` 与启动用**同一套发现策略**
（`--dir`/`COMFYUI_DIR` → Desktop 注册表 → 有界扫描），所以便携安装也能停。
---

## 0.6 让 image_forge_setup 带你装、带你下权重（P1b）

插件里的环境工具 `image_forge_setup` 是从零到能出图的入口，能力与上面的手工步骤一一对应：

| action | 做什么 |
|---|---|
| `status`（默认） | 探活 + 读 Desktop 注册表；未安装时返回安装引导，已就绪时附当前 `comfyModel` 三个权重的在位情况 |
| `start` / `stop` | 没在跑就按 Desktop 记录的 Python 与启动参数后台拉起（只停自己拉起的实例） |
| `install` | 安装引导：官方下载页、选盘、CUDA、首次启动。**未获 computer use 授权时只输出图文步骤，绝不执行自动安装** |
| `download` | 按 T04 方案把当前 `comfyModel` 的三个权重下到 Desktop 模型根；先 dry-run 看计划，`confirm: true` 才真的下载 |

下载与手工命令等价，但替你做了校验：

- 落盘目录按 §3 的同一条链解析（运行实例 argv → Desktop 生成的模型路径 yaml → `settings.json` → 安装树），
  不吃设置页里那个旧的 `comfyModelsDir` 探测值（它不含 `ComfyUI-Shared`，探不到就留空）。
- 先写 `<文件名>.part`，校验字节数（Qwen 四个文件另有实测 sha256）再原子改名——半截文件不会出现在 `/object_info` 里冒充成功。
- 断点续传：中断后重跑会从 `.part` 接着下（镜像支持 `Range` → 206）。
- **成功唯一判据**：`GET /object_info/<Loader>` 的候选列表包含**精确文件名**。文件在位不是判据，正则匹配也不是。
- **不需要重启 ComfyUI**：新增/改名文件会改变目录 mtime，下一次 `/object_info` 自动重扫（2026-11-17 本机实测，见下）。
- 失败时返回目标绝对路径与当时 `/object_info` 的可见列表，照 §9 排障。

`download` 不带 `confirm` 时只返回计划（下哪些文件、落到哪、多大、URL 是否已实测）。

> **本机实测（2026-11-17）**：往 `<base_path>\vae\` 写入一个探针权重文件后**不重启** ComfyUI，
> `GET /object_info/VAELoader` 立即列出它；删掉后立即消失。这消掉了 T04 文档 §5.3 的“未核实项”。

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
**不用管界面，只要它活着**。

不想开界面的话（无头、或只是想给插件一个可用的后端），直接跑仓库自带的启动器——它用的就是桌面版
记在这台机器上的启动参数：

```bash
node scripts/start-comfyui.mjs            # 起 + 等就绪 + 报显卡
node scripts/start-comfyui.mjs --print    # 先看它准备传什么参数
```

两种方式都行，任选其一，**别同时起两份**（会抢 8188）。验证它监听在哪：

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
- 桌面版自带的启动参数（本机 `installations.json` 实测：`--fast-disk`、`--reserve-vram 1`、`--vram-headroom 0.5` 等）
  是它自己的显存调度，和插件无关；插件不会传任何启动参数，也不重启 ComfyUI。**别再给桌面版加 `--lowvram`**：
  dynamic VRAM 默认开启时它不起作用；`--novram` / `--highvram` / `--gpu-only` / `--cpu` 反而会关掉 dynamic VRAM
  （见 §8）。

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

`models\diffusion_models\` 和 `models\text_encoders\` 在 yaml 里也映射了，而且**它们和 `unet\` / `clip\`
是合并列出的**：ComfyUI 0.45.3 实测（`folder_paths.py` 把 `unet` 与 `diffusion_models` 并进同一个
folder，`text_encoders` 与 `clip` 同理），放在 `diffusion_models\` 的主干同样会出现在
`UNETLoader.unet_name` 下拉框里。所以 §3 表格里的落盘目录是「推荐放法」，不是唯一放法；真正放错的是
yaml **没有映射**的自造目录，以及 `ComfyUI-Installs\…\models` 那棵没在用的老树（§2.2、§9）。

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

**先跑 `node scripts/start-comfyui.mjs --doctor`**：它按角色列出五个权重（存在/大小/文件名）并问
ComfyUI 自己能不能枚举到 Qwen 权重，一条命令覆盖 §6.1、§6.3。只有它报「大小不对」或你想核对
`sha256` 时才需要往下看 §6.2 的手工命令。

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
| `comfyModelsDir` | **探测**候选目录，第一个存在的；探不到就留空 | **只用于把错误信息写具体**（「把文件放进 X」）。候选只有 `%APPDATA%\ComfyUI\models`、`%LOCALAPPDATA%\ComfyUI\models`、`~\ComfyUI\models` 等常见位置（`src/config-defaults.ts`），**不含桌面版的 `ComfyUI-Shared\models`**——本机实测探不到、值为空；想让报错带上绝对路径就手填 `D:\Comfy-Desktop\ComfyUI-Shared\models`。插件不往这里读写任何东西 |
| `comfyModel` | `qwen21-turbo`（旧值 `turbo` 仍可用） | 8 步；25 步 base 基准实测约快 2.7×（base 现默认 40 步，按线性外推约 4–5×，未重新实测）。写实人像 / 画面里有中文文字 / 古典绘画性构图切 `qwen21-base` |
| `turboSteps` | 留空 = 8 | turbo 的步数。`base` 用 `defaultSteps`（40） |
| `comfyuiSteps` | 留空 | 只对 `comfyui` 后端生效的步数覆盖；一般不用填 |

做完跑一次体检：

```
image_forge_status
```

它会把两件事一次报清：ComfyUI 通不通（探了哪几个端口、三个权重能不能被枚举到、
显卡型号与显存余量）、输出目录能不能写。`next_steps` 非空就照着那句话做。

---

## 8. 实测基准（8 GB 卡）

RTX 4070 Laptop（8188 MiB，`cudaMallocAsync`）、ComfyUI 0.41.3、int8_convrot 权重：

| 场景 | 步数 | 耗时 |
|---|---|---|
| 文生图 1312×736 | 8（turbo） | 19–23 s，约 2 s/步 |
| 编辑 1312×736，1 张参考图 | 8（turbo） | 19–23 s |

- 比 40 步的 base 快得多（25 步基准下实测约 **2.7×**；40 步按线性外推约 4–5×，未重新实测），画质盲测无显著差异——**除了写实人像、画面中文字、古典构图**这三类，
  turbo 会掉细节，那几类切 `base`。
- 显存由 ComfyUI 的 **dynamic VRAM** 自己调度（NVIDIA Windows/Linux 默认开启：按需逐层把权重 fault-in，
  不再整包常驻）。`--lowvram` 在它开启时**无效**；`--novram` / `--highvram` / `--gpu-only` / `--cpu` 会把它关掉、
  反而更容易 OOM。要调就调 `--vram-headroom N`（给别的程序留显存）或 `--fast-disk`。
  真不够时是**干净的 CUDA OOM**回报，不是插件拒绝你：调小 `width`/`height`，或先关掉别的吃显存程序。
- 卡上同时跑第二个 ComfyUI 实例 / 游戏 / Blender，会显著拖慢甚至 OOM。

---

## 8.5 画质小瑕疵：VAE 网格纹（degrid）

Qwen-Image 2.1 的 VAE 解码在部分图上会留下 **2px 网格 / halftone / 菱形交叉纹**（社区多源报告；插件不处理，也不把它包装成没有）。

社区现成方案是 **Nyquist Notch 去网格节点**，代表实现：

- [lunaaispace-eng/ComfyUI-DeGrid](https://github.com/lunaaispace-eng/ComfyUI-DeGrid)（Apache-2.0）：自动校准的
  Nyquist notch + 锁相网格检测，纯 PyTorch、无额外依赖；接线位置是 **VAE Decode 之后、其余节点之前**。
- comfy.icu 节点目录里的 `VAE DeGrid (Nyquist Notch)` 是同类包装。

**本插件不内置、不下载、不自动接线**：节点包是第三方依赖，引入它超出本项目的边界；要用就自己装到 ComfyUI 里，
插件发给 ComfyUI 的工作流里没有它。

**与超分链路的兼容性（社区口径，未在本插件验证）**：网格是 VAE 解码带出来的，超分 / 细节增强会把它一起放大
或强化，所以去网格要放在 **超分之前**；部分超分、锐化、降噪节点本身也抹细节，与 degrid 叠加可能「去纹也去纹理」，
需要自己 A/B 对照。本插件不给出画质承诺。

---

## 9. 排障对照表

| 症状 | 病因 | 处理 |
|---|---|---|
| `image_forge_status` 说 ComfyUI 没在跑，但界面明明开着 | 端口不在探测列表 | 看 §2 拿到真实端口，写进 `comfyPorts` 或 `comfyEndpoint` |
| 报「缺 unet / 找不到主干」 | 权重放进了 `Installs\…\models`（没被 yaml 映射的目录） | 搬到 `<base_path>\unet\`（§3） |
| 文件在 `unet\` 里，下拉框却没有 | 没重启 ComfyUI | 重启实例（§5） |
| 加载时报 `header` / 反序列化错误 | 下载被截断 | 比对字节数，删掉重下（`-C -` 续传，§4.3） |
| `CLIPLoader` 的 `type` 里没有 `qwen_image` | ComfyUI 版本 < 0.37 | 升级桌面版 |
| 编辑 CUDA OOM | 画布太大 / 卡被占 | 减小 `width`/`height`；关掉别的吃显存程序。只有「卡被别的程序挤占、这一轮必须立刻回收」时才 `POST /free` + `{"free_memory":true}`——常规轮次不要调，卸载模型只会让下一轮重新加载（§8） |
| 权重明明在共享模型根里，ComfyUI 还是看不见 | 桌面版两个 `models` 目录搞混了 | 认 `system_stats` 的 `extra-model-paths-config` → `base_path`（§3 办法 A），只信这个 |
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
