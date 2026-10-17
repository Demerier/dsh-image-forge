# 用法与工具细节（原文）

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
而且是一道**尺寸门**，不是显存门——见 [本地编辑尺寸门](backends.md#本地编辑尺寸门只在-local-后端生效)）。

> ⚠️ **上面这组数字只覆盖文生图，完全不覆盖参考图编辑**（本仓库早些时候把它读成「编辑也没问题」，
> 那是过期依据）。同一张卡上编辑路径是另一个量级，实测：可靠上限是参考图条件化预算
> **`_reference_budget` ≤ 896**（例如 1216×672，峰值 reserved **7458 MiB**，3/3 次一致）；
> **928–960 贴边**（960×960 峰值 reserved **8492 MiB 已超过卡总量 8188 MiB**，靠 WDDM 共享内存撑住）；
> **≥992 在 GPU 去噪段 CUDA OOM**（碎片签名）；**≥1216 在 CPU 文本编码段以访问违例崩掉**，
> 有时直接带走 worker 进程（同一张 1248×1248 画布：t2i reserved 5700 MiB，edit 500）。
> ⚠️ **896 这条可靠线只按预算分档，画布自身的代价不在内**：它的实测出处是 1216×672（0.82 MP，1.9 s/步）；
> 同一预算搬到 1.5MP 画布（1248×1248）上实测 **67 s/步**、25 步外推 ≈28 min（**不报错**，但等于不可用）——
> 那张画布上唯一实测跑得完的是 **512**（wall **109.5 s**、峰值 reserved **6488 MiB**、worker 存活）。
> 依据：本机逐次实测记录（报告未随包发布）。
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

