# dsh-image-forge

![dsh-image-forge：肥鱼女仆指着一张画布，画面上是「dsh-image-forge」标题与画板/素材库的功能示意](docs/images/repo-banner.png)

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

在 DeepSeek Harness 里用 Qwen-Image 出图、改图。

说「画一张 16:9 的夏日饮料海报」，出图；丢一张客厅照片说「改成晚上的」，改图。比例、像素由插件换算，不用你查表。

后端二选一：**你自带的云端 key**，或**你本机装好的 ComfyUI**。插件不自带运行时，不下载权重。

---

## 能不能用

| 你手上有的 | 能做什么 |
|---|---|
| 只有云端 API key | 文生图。**改图不行**，云 API 没有编辑通道 |
| 只有 ComfyUI（+ 三个权重） | 出图 + 改图，全离线 |
| 两者都有 | 出图走 key，改图自动落到 ComfyUI |
| 两者都没有 | 先看 [ComfyUI 部署指引](docs/comfyui-deployment.md) |

---

## 安装

```bash
dsh plugin --profile <profile> add github:Demerier/dsh-image-forge
```

装完重启 DSH。对话里能看到 `qwen_image_generate` / `qwen_image_edit` / `qwen_image_status` 三个工具，设置页左侧出现「Qwen 出图」，第一页就是工作台。

本机改代码时：

```bash
pnpm install
pnpm build
dsh plugin --profile <profile> add <本仓库绝对路径>
```

> 别用 `npm install` 装它——这是 DSH 插件，脱离宿主跑不起来。
> `pnpm build` 报 `Cannot find package 'ansis'` 时，删掉 `node_modules` 重装（本仓库用 `nodeLinker: hoisted` 绕开这个问题）。

---

## 配置

14 个字段都有默认值，日常只看这 6 个：其余见 [docs/configuration.md](docs/configuration.md)。

| 字段 | 默认 | 说明 |
|---|---|---|
| `backend` | `auto` | `auto` / `api` / `comfyui`。**改图只能 `comfyui`** |
| `apiKey` | 空 | 建议留空，改用环境变量，key 就不进 profile 文件 |
| `comfyEndpoint` | 空 | 如 `http://127.0.0.1:8188`。留空自动探测端口；非回环地址会被拒绝 |
| `comfyModelsDir` | 自动探测 | ComfyUI 的 `models` 目录，只影响报错信息里写的路径 |
| `comfyModel` | `base` | `turbo`（8 步，快约 2.7×）或 `base`（25 步）。写实、中文文字、古典构图用 `base` |
| `outputDir` | `~/Pictures/dsh-image-forge` | 图片存哪 |

- Key 依次读 `apiKey` → `QWEN_IMAGE_API_KEY` → `DASHSCOPE_API_KEY` → `OPENAI_API_KEY`。不写盘、不进日志。
- 步数优先级：调用时显式传的 > `comfyuiSteps` > `defaultSteps`。turbo 用自己的 `turboSteps`（默认 8）。
- 设置页三个页签：出图、云端 API、ComfyUI。

---

## 出图

在对话里直接说需求就行。模型会把话改写成契约再调工具，你不用管：

```json
{"rewritten_prompt": "A wide photograph of …", "wh_ratio": "16:9"}
```

`wh_ratio` 七档，对应像素（约 1.5MP，32 对齐）：

| `wh_ratio` | 像素 | 备注 |
|---|---|---|
| `1:1` | 1248×1248 | |
| `4:3` | 1408×1056 | |
| `3:4` | 1056×1408 | |
| `3:2` | 1536×1024 | |
| `2:3` | 1024×1536 | |
| `16:9` | 1664×928 | 32 网格上无法精确，偏差 +0.86% |
| `9:16` | 928×1664 | 偏差 −0.86% |

- 要固定像素就传 `width` / `height`（32 的倍数），优先于 `wh_ratio`。
- 图片存为 `<outputDir>/<prefix>_<W>x<H>_<n>.png`，编号自动跳过已占用的名字，重复出图不会覆盖旧的。

---

## 改图

给了参考图就是改图任务。

```text
qwen_image_edit(prompt = <改图指令>, images = ["D:\\pictures\\room.png"], ratio_follow = "image1")
```

画布怎么定，三选一：

| 你说的话 | 传什么 | 画布 |
|---|---|---|
| 明说了比例或像素 | `wh_ratio`（或 `width`+`height`） | 该比例 |
| 没说，但想跟随某张图 | `ratio_follow: "image1"` | 按该图长宽比取最接近的像素 |
| 什么都没说 | 都不传 | 跟随第一张参考图 |

- 路径必须绝对；只认 PNG / JPEG / WebP。
- `wh_ratio` 和 `ratio_follow` 同时传会直接报错，二选一。
- 改图只走 ComfyUI。`backend: "api"` 会明确报错，不会把参考图丢掉。
- 多张参考图时用 `<image1>` `<image2>` 指明用途，并说清哪张是画布。
- 显存不够就先调小 `width` / `height`。

---

## 工作台

设置页第一个页签。不想每次在对话里贴参数，就在这里点。

- **画幅只有七档**，标的像素就是实际送进 ComfyUI 的像素。
- **传了参考图就是改图**（最多 10 张），留空就是文生图。
- **提示词优化**用当前会话的模型改写，结果写回输入框，你改完再生成。
- **结果是一块画布**：拖空白处平移、滚轮缩放。选中一张点「用作参考」，下一轮就变成改图，新图会从原图拉一条虚线过来，改了哪几轮一眼看清。
- **按画板归档**：顶部切换 / 新建 / 重命名，画布位置自动保存，重开页面回到上次的画板。「素材」页可以跨画板搜索，把图用作参考、定位回画布、或删掉。

ComfyUI 没起来时面板照样打开，顶部会写清查了哪些端口、为什么失败。

> 「优化提示词」需要宿主装了 `@deepseek-ai/dsh-llm`。没有的话只有这个按钮不可用，出图不受影响。

---

## 工具

| 工具 | 用途 | 主要参数 |
|---|---|---|
| `qwen_image_generate` | 出图 | `prompt`、`wh_ratio`、`width`/`height`、`steps`、`seed`、`count`、`transparent`、`backend`、`preset`、`board` |
| `qwen_image_edit` | 改图 | `prompt`、`images`（1–10 张）、`ratio_follow` 或 `wh_ratio`、`board` |
| `qwen_image_status` | 检查环境 | 无 |

不确定为什么跑不通时，先跑 `qwen_image_status`。它会告诉你云 API 通不通、ComfyUI 在不在、三个权重能不能识别、显卡剩多少显存、输出目录能不能写。不产图、不写盘。

`board` 不传时会新建一块画板，把返回的 `board.id` 传回后续调用就能归到同一块。

---

## 提示词怎么写

模型会自动改写，这里只说改写的方向。完整规则见 [T2I 规则](references/t2i_rules.md) 与 [改图规则](references/edit_rules.md)。

| 场景 | 你可以这么说 | 改写方向 |
|---|---|---|
| 海报、页面、多物宽景 | 「画一张夏日饮料海报」 | 一整段英文散文，从背景到顶部到主体再到下方依次描写。**比例不写进正文** |
| 肖像、特写、单品 | 「画我的猫的大头照」 | 同上，顺序是背景 → 姿态 → 头脸 → 身体 → 手持物 → 边缘细节 |
| 单张参考图改图 | 「把这张客厅改成晚上的」 | 只动点名的属性，其余保持。不加 `<image1>` 标签 |
| 多张参考图 | 「把我放进那张客厅照片」 | 必须用 `<image1>` `<image2>` 逐张说明，并指明哪张是画布 |
| 只想问怎么写 | 「这种需求提示词怎么写」 | 只给改写结果，不出图 |

工作台里可切两种风格：「长散文」（约 20 句英文细节描写）和「关键词」（`主体+场景+风格+镜头+氛围+细节修饰`，逗号分隔）。两派都遵守：比例不写进正文、画面里的文字逐字照抄。

---

## 后端

`auto` 的判断只有一步：有 key 走云 API，没有走 ComfyUI。

- **云 API**：一次 HTTP 请求，不占本机显存。没有编辑通道，每张图都要联网。
- **ComfyUI**：本机唯一能改图的路。8 GB 卡（RTX 4070 Laptop）实测，文生图 1312×736 约 2 s/步，1.5MP 的 8 步改图 19–23 s。
- **turbo 不保证生效**：没装 turbo 权重会自动退回 `base`，结果里会有提示。盲测 5 题 base 3 : 2 turbo，单张 27–29 s → 9–11 s。turbo 氛围更强，但材质细节、中文小字、印章、古典构图会输给 base。

部署见 [ComfyUI 部署指引](docs/comfyui-deployment.md)，两条路的详细取舍见 [docs/backends.md](docs/backends.md)。

---

## 可能踩的坑

- **云 API 不能改图**。给了参考图又指定 `backend: "api"` 会报错，不会静默丢图。
- 参考图只认 PNG / JPEG / WebP 的文件头，TIFF、AVIF 会被拒绝并说明原因。
- 没有局部重绘、没有放大。素材页只做检索和整理，不做批量导出或调色。
- 插件不会替你装 ComfyUI、不下权重、不改它的启动参数。
- 显存不够时报的是 ComfyUI 自己的 CUDA OOM，插件不做前置检查。卡上同时跑游戏或 Blender 会明显变慢。
- 图在对话里的显示靠工具结果里的 Markdown 绝对路径。

---

## 许可

插件本体 MIT。**权重和官方提示词原文都不随包分发。**

- Qwen-Image-2.1 权重受 **Qwen RESEARCH LICENSE** 约束，限研究用途，商用需自行向权利方取得授权。插件不下载、不携带。
- ComfyUI 是可选外部依赖（GPL-3.0），插件只通过 HTTP 与你的实例通信。
- `skill.md` 和 `references/*.md` 是本插件自撰的规则，不是官方原文。

> 「Qwen」「千问」是阿里巴巴集团商标。本项目是第三方作品，与阿里巴巴无关联、未获其背书。开源许可不授予商标使用权。详见 [docs/license-and-limits.md](docs/license-and-limits.md)。

ComfyUI 后端与工作流占位符协议（`{{prompt}}` / `{{seed}}` / `{{image}}`）参考并移植自 [dsh-image-gen](https://github.com/shanliuling/dsh-image-gen)（Copyright 2026 shanliuling，Apache-2.0），许可全文见 [THIRD-PARTY](THIRD-PARTY/dsh-image-gen/LICENSE)。

---

## 更多文档

| 文档 | 内容 |
|---|---|
| [docs/comfyui-deployment.md](docs/comfyui-deployment.md) | 本机部署：下载、建实例、放权重、校验、排障 |
| [docs/configuration.md](docs/configuration.md) | 14 个配置字段的默认值和边界 |
| [docs/usage-reference.md](docs/usage-reference.md) | 像素怎么算、表外比例、`board` 用法、`status` 各字段 |
| [docs/backends.md](docs/backends.md) | 两条后端的详细对比 |
| [docs/license-and-limits.md](docs/license-and-limits.md) | 分发和商用前的注意事项 |
| [docs/testing.md](docs/testing.md) | 开发：怎么跑测试 |
| [docs/client-bundle.md](docs/client-bundle.md) | 开发：改客户端和设置页 UI |
