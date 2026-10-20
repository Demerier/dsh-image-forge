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

显存：这张表对**两个后端都用同一套值**，插件不再按后端分表，也不做任何前置显存门禁。
8 GB 卡上的实测代价见 [后端 → 基准](backends.md#8-gb-卡上的实测基准)；**编辑时的显存压力要自己看着办**——
真不够是 ComfyUI 回报的 CUDA OOM，缩 `width`/`height` 是唯一可靠的减法。
要显式像素就用 `width`/`height`（必须 32 的倍数，否则报错并给出最近的合法值）——**显式值永远优先**。

落盘命名：`<outputDir>/<prefix>_<W>x<H>_<n>.png`，`prefix` 默认 `qwen`，可用 `preset` 覆盖；
编号从 1 起且**跳过已占用的名字**，所以重复调用不会覆盖旧图。

## 画板：成果的存储与显示单位

PNG 落在同一个 `outputDir` 里，但「哪几张图属于同一件事」由**画板**回答——一个题材、一次拍摄、
一轮改稿就是一个画板。存储在 `<outputDir>/.dsh-image-forge/`：

```text
.dsh-image-forge/
  state.json          { "active": "b…" }   工作台上次打开的画板
  boards/<id>.json    一块画板：名字 + 每张图的出处（prompt/步数/种子/模式）+ 画布坐标
```

规则（两个入口共用同一套）：

- **对话调用省略 `board` 就新建一个画板**，用提示词首行命名；返回载荷里的 `board.id` 就是它，
  `summary` 末尾会点名。同一组图继续出图/改图时**把这个 id 传回 `board`**，成果才落进同一块画板。
- `board` 也收**名字**（大小写不敏感）；一个没见过的值按「新画板的名字」处理，而不是报错——
  拒绝就意味着这次出图白跑。
- 每张图在画板里记：`path`、尺寸、字节数、prompt、`ratio`/`steps`/`seed`、`mode`（generate/edit）、
  来源会话（`sessionId`，来自宿主）、画布坐标。同一路径重复记录只更新元数据，不会长出第二份。
- 工作台按画板组织：顶部选画板 / 新建 / 重命名，画布位置与相机**自动保存**（拖动后 700 ms 落盘），
  重开页面恢复上次的画板与排布。
- 「素材」页是跨画板的资产视图：本画板 / 全部画板两个范围 + 文本过滤（prompt、文件名、画板名），
  每张图可「用作参考」「定位」（跳到它所在画布）「移除」（只摘出画板）「删文件」（确认后删 PNG）。
- 删除有双重护栏：默认只把图从画板摘掉（可逆）；「删文件」要求二次确认，且只允许删
  `outputDir` 里面的文件——画板数据被手工改坏也删不到目录外的任何东西。
- 画板记录失败**不会**让出图失败：图已在盘上，返回里的 `board_note`（工具）/`boardNote`（工作台）
  说明原因。

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
- **后端只有 `comfyui` 一个**。`backend: "auto"` 在编辑场景**不看 key**，直接走 ComfyUI（返回里的
  `api_skipped` 如实说明）；显式传 `backend: "api"` 会明确报错，并且**不丢参考图**。
  两条都不通时的错误会点名缺什么，并指向 [部署文档](comfyui-deployment.md)。
- 参考图由 ComfyUI 按画布缩放（工作流的 `resolution` 预算），插件侧**没有**参考图预算旋钮。
- 落盘命名与文生图一致，`preset` 默认是 `edit`（`<outputDir>/<prefix>_<W>x<H>_<n>.png`）。

## 工具一览

| 工具 | 说明 |
|---|---|
| `qwen_image_generate` | 出图主入口。`prompt`（成品，必填）、`wh_ratio`（一等参数，官方 7 档）、`width`/`height`（可选覆盖）、`steps`、`seed`、`count`(1–4)、`transparent`、`backend`（`auto`/`api`/`comfyui`）、`preset`、`board`（画板 id/名字，**省略就新建**，见「画板」一节） |
| `qwen_image_edit` | **参考图编辑（图生图）**。`prompt`（成品修改指令，必填）、`images`（1–10 张绝对路径或 `data:image/…;base64,…`，必填，按序对应 `<image1>`…）、`ratio_follow`（画布跟随某张参考图的宽高比；`image1`… 或该图在 `images` 里的原字符串）、`wh_ratio`（**与 `ratio_follow` 互斥**）、`width`/`height`、`steps`、`seed`、`count`、`transparent`、`backend`、`preset`（默认 `edit`）、`board`（改图通常传参考图所在画板的 id）。编辑**只走 `comfyui`**；`api` 没有编辑通道，会明确报错而**不丢参考图** |
| `qwen_image_status` | **只读**体检：云端点是否可达、key 是否被接受（401/403 会点名）、**本机 ComfyUI 是否在跑**（探了哪几个端口、三个权重能不能枚举到、显卡型号与显存余量）、输出目录能否写。不产图、不写盘、不改配置、不回显 key，也不拉起或杀掉任何进程 |

排障顺序：先 `qwen_image_status`，`next_steps` 非空就照着那句话做。

### `qwen_image_status` 返回什么

```jsonc
{
  "checked_at": "2026-10-19T…",
  "configured_backend": "auto",
  "api": {
    "baseUrl": "https://…", "model": "qwen-image", "style": "openai",
    "keySource": "env" | "config" | null,
    "keyPresent": true, "reachable": true, "authenticated": true,
    "modelsProbeStatus": 200, "note": "endpoint answered"
  },
  "comfyui": {
    "modelsDir": "D:\\Comfy-Desktop\\ComfyUI-Shared\\models",   // 探测到的值，探不到是 null
    "endpoint": "http://127.0.0.1:8188", "port": 8188, "reachable": true,
    "probed": [ … 每个端口的尝试记录 … ],
    "models": { "unet": "…", "clip": "…", "vae": "…", "clipType": "qwen_image", "ok": true },
    "note": "ComfyUI 在跑，且三个 Qwen-Image 权重都能被它的加载器枚举到。",
    "version": "0.41.3",
    "devices": [{ "name": "cuda:0 NVIDIA GeForce RTX 4070 Laptop GPU : cudaMallocAsync",
                  "type": "cuda", "vram_total_MiB": 8188, "vram_free_MiB": 7068 }],
    "stats_note": null
  },
  "output": { "dir": "…", "writable": true },
  "next_steps": null
}
```

- `version` / `devices` / `stats_note` 来自 ComfyUI 自己的 `GET /system_stats`，**不是** `nvidia-smi`：
  真正要紧的那张卡是 ComfyUI 加载权重的那张。ComfyUI 没起来时这三项是 `null`（不是缺键）。
- `api.keyPresent` / `keySource` 只报**状态**，不回显 key 本身；载荷里不会出现 `Bearer …`。
- 整个载荷是 **lossless JSON**：没有 `undefined`，不适用的字段一律 `null`——DSH 的工具层会拒收带
  `undefined` 的值（`value is not lossless JSON`），这条由测试钉住。
