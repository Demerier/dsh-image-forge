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

**高级采样器档（可选，仅 Qwen base）**：`sampler` / `scheduler` 默认 `euler` / `simple`（官方模板口径；
都不传时请求与改动前逐字节一致）。枚举里只有 ComfyUI **原生**采样器（`res_multistep`、`er_sde`、`heun`…）
与原生调度器（`simple` / `normal` / `karras` / `exponential` / `sgm_uniform` / `beta`）。替代组合的收益
都是社区〔孤证/轶闻〕、无严格对照，**换之前先用同 seed 对比**；`er_sde + beta` 是其中被提到最多的一组。
turbo 与 MOSS 不接受这两个参数（采样器/调度器分别由蒸馏 sigma 表与 `mossSampling` 档位管理）。
**RES4LYF 等第三方节点包不内置**：想试 `abnorsett_3m` + `beta_57` + shift 16 那套配方，只能在 ComfyUI 里
自己装第三方节点包，本插件不引入、不保证可用（产品边界）。

**2K 档（可选，默认不开）**：`size_tier: "2k"` 把上表换成官方模型卡的 **4.2MP 七档表**
（默认仍是 1.5MP，8GB 卡友好）：

| `wh_ratio` | 2K 像素 | 像素数 |
|---|---|---|
| `1:1` | 2048×2048 | 4.194 MP |
| `4:3` | 2400×1792 | 4.301 MP |
| `3:4` | 1792×2400 | 4.301 MP |
| `3:2` | 2528×1696 | 4.287 MP |
| `2:3` | 1696×2528 | 4.287 MP |
| `16:9` | 2752×1536 | 4.227 MP |
| `9:16` | 1536×2752 | 4.227 MP |

`3:4` / `2:3` 是官方 `4:3` / `3:2` 的精确转置（比例与面积都一致，不是自算值）；`16:9` / `9:16`
在 32 网格上有 ±0.78% 的固定残差，返回里的 `ratio_deviation_percent` 会照实报。**2K 的像素约为默认档
2.8 倍**，8GB 卡上耗时与显存压力明显上升——只在「画面里要出现文字」或出终稿时才开；**4K 不是一个档**：
官方明确 4K 会丢提示词贴合度。显式 `width`/`height` 仍优先于 `size_tier`；表外比例（`21:9`）在
2K 档下按 4.2MP 预算搜索。返回里带 `size_tier` 与 `size_tier_applied`（被显式像素覆盖时为 false）。

显存：插件不做任何前置显存门禁，**编辑时的显存压力要自己看着办**——
真不够是 ComfyUI 回报的 CUDA OOM，缩 `width`/`height` 是唯一可靠的减法。
要显式像素就用 `width`/`height`（必须 32 的倍数，否则报错并给出最近的合法值）——**显式值永远优先**。

**采样步数**：Qwen base 默认 **40 步**（官方 GitHub 卡片推荐 40–50，模板的 25 只是起步值；40 步耗时 ≈ 1.6× 25 步），
解析链是「显式 `steps` > `comfyuiSteps` > `defaultSteps`」；`turbo` 走蒸馏档（8 步，`turboSteps` 可覆盖）；
`moss-sft` 的步数由 `mossSampling` 档位决定（comfy 25 / official 50），不受 `defaultSteps` 影响。
结果里恒带 `steps_used` 与 `steps_source`，可以直接回答「这张为什么和上一张不一样」。

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

## 工作台画布：任务节点与布局节点

工作台的画布是**生成发生的地方**，节点有三种：图片（结果/导入素材）、任务（一次生成）、布局（MOSS 布局稿）。
三者都存在同一块画板里，连线表示**来源**（改图派生、参考引用、布局派生），不是参数流。

### 任务节点

- 点「生成」的瞬间，任务节点就落在画布上并进入「排队中 → 正在生成」；出图后**原地变成图片节点**
  （首张替换、其余向右排开），成功结果的位置就是任务节点的位置。
- 失败/中断会停在任务节点上（原因首行 + 参数摘要），节点内可直接「重试」（同一份参数快照、新 clientId、
  原位置）或「编辑参数」（回填表单后替换该节点重发）。
- **落盘口径**：运行中的任务不落盘；失败/中断节点落盘（`kind:'task'` + 参数快照），重开画板还能看到并重试。
  重试开始时旧的失败条目会从画板移除，失败后再写新的，避免重开后同一意图出现两个节点。

### 布局节点（MOSS 布局闭环，需 `comfyModel: "moss-sft"`）

- 画布工具条「新建布局」落一个默认 1536×1024 draft 的布局节点。节点里直接拖动画框、移动/缩放框；
  节点右下角拖动只改**显示宽度**（高度按 draft 比例，draft 坐标不变）。
- 节点标题栏下方有**整图描述输入框**（`summary.caption`）——MOSS 把它当布局 prompt，空着就生成不了，
  所以它是画布上唯一必须就地能填的字段。其余编辑器字段（工具条、说明、导出框）在节点内可滚动，
  也可以右键「打开详情（完整编辑器）」在大页签里编辑。
- 点节点标题栏的「生成」：`compiled` 导出（abs_centralized / yxyx）作为 **layout** 透传给 MOSS，
  `summary.caption` 作为 prompt，结果节点以布局节点为父（星形血缘：同一布局改框后可继续扇出结果）。
  **比例必须落在官方七档**：draft 比例与最近档偏差 ≤1% 时按该档生成并提示；超出时明确提示「改 draft 尺寸」，
  不静默拉伸。
- 右键菜单的布局项全部可用：**生成**、**打开详情**、**发送到表单**（把 `summary.caption` 送进提示词框）、
  **导出 draft / compiled**。
- 布局与参考图改图的叠加仍未定义（T21 边界）：布局节点只走文生图。
- **落盘口径**：draft 与显示尺寸防抖（500 ms）写入画板（`kind:'layout'`），removal 一并删条目；
  重开画板后布局节点与草稿原样恢复、可继续改框再生成。

画布交互（框选/快捷键/拖入素材/右键菜单/撤销）见 `docs/CANVAS-DESIGN.md` §6–§8，此处只记与生成/存储有关的口径。

## 工作台画布：交互、素材与导出

### 选择与平移

- **空白处左键拖动 = 平移**（v2 恢复自然画布手势）。**Shift + 左键拖动 = 框选**；Ctrl/Meta+Shift 把框选结果并入现有选择。Space+拖动、中键拖动、工具栏抓手也是平移入口。
- 平移有三个入口：`Space`+拖动、鼠标中键拖动、工具条「平移」模式（粘性，点一下切换）。
- 单击节点替换选择，`Ctrl/Cmd`+单击切换成员；选中多个后可一起拖动。选择 ≥2 出现对齐工具条，≥3 出现水平/垂直等距。

### 快捷键（画布聚焦时；输入框/布局编辑器内全部让位）

| 键 | 动作 |
|---|---|
| `Del` / `Backspace` | 从画布移除选中节点（unplace，不删文件） |
| `Ctrl/Cmd+Z` | 撤销；`Ctrl/Cmd+Y` / `Ctrl/Cmd+Shift+Z` 重做 |
| `Ctrl/Cmd+A` | 全选当前画板节点 |
| `Esc` | 清空选择 / 关闭右键菜单 / 退出框选 |
| `F` | 适应视图（fit 全部节点） |
| `+` / `-` | 以视口中心缩放 |
| 方向键 | 微移 1 世界单位，Shift=10；连续微移合并成一条撤销 |
| `Ctrl/Cmd+C` / `V` | 复制选中节点 / 粘贴到当前画板（剪贴板是会话内存，不写系统剪贴板） |
| 双击节点 | 居中聚焦该节点 |

**撤销是会话级的**：内存命令栈、上限 100 步、刷新后清空；生成与相机移动不进栈（GPU 已跑不可撤销，相机撤销也不符合画布预期）。画板写入不在撤销步内——撤销只回滚画面，因此「撤销一次删除」后刷新仍以服务端为准。

### 从节点拉线建立下一个节点

每个节点右缘中点有一个**连接点**（蓝色圆点，hover 或选中时出现）。从它拖出一条线，落点决定发生什么：

- **拖到空白处松手**：在落点弹「在这里新建（血缘指向来源）」三选一。
  **图片生成**落一个虚线框的待生成草稿节点（写明来源），左侧表单的参考图自动填成来源节点、光标进提示词框，
  点「生成」后图片**原地替换**这个草稿并带着血缘；**布局**在落点建一个 MOSS 布局节点，血缘同样指向来源；
  **放入素材**灰显、暂未接线（走素材页 → `Ctrl+V` 放到画布，见下节「素材流」）。
- **拖到已有节点上松手**：只建立**参考关系**（目标节点的 `parents` 多一条来源），**不触发出图**、不发任何生成请求——
  这个手势存在的意义就是让「这张是从那张来的」不必再烧一次 GPU。悬停时落点节点显示绿色描边。
- **取消**：`Esc`，或把线拖回来源节点上松手（等于把它放回去）。在连接点上点一下（位移不足 4 屏幕像素）什么都不做。
- 连线是**血缘**，不是参数连线：线只记录来源，不会把来源的参数（比例/步数/参考图）带过来，也不会被表单读到；
  反过来会形成环的连线（把来源连到它自己的后代）会被直接拒绝，线消失、不报错。
- 连线是一次撤销步（`Ctrl/Cmd+Z`），并随画布防抖写进画板；重连一条已经存在的线不产生新的撤销步，只提示一句。
- **低倍缩放下连接点仍可点**：它的尺寸按**屏幕像素**定死（约 11 px 的点、16 px 的点击范围），不随画布缩放变小，
  所以在 10% 的适应视图里也能拖出线；拖动期间来源节点的点保持可见，线的起点不会消失。

### 素材流

- **素材页 → 画布**：素材卡片可拖到画布。同板拖动 = 重定位（一次撤销步）；跨板默认**复制**，按住 `Alt` 为**移动**；落点是鼠标位置。
- **外部文件 → 画布**：把 PNG/JPEG/WebP 文件拖进画布即导入（单文件 ≤32 MB），落点向右依次排开；非图片文件会被明确拒绝并提示。导入图与生成图同一套身份（写进当前画板，可「用作参考」）。
- 「定位」按钮：切到素材所在画板、选中并**把相机移到它**（不再需要自己找）。
- 删除仍有双重护栏：默认只从画板移除；「删文件」二次确认且只允许删 `outputDir` 内的文件；被其他画板共享的 PNG 会拒绝删除、只摘出画板。

### 导出

入口两处：画布工具条的「导出」「拼版」，以及空白右键菜单。

- **画板 JSON**：下载当前画板的 v2 JSON（`<板名>.board.json`），含节点 kind、布局 `draft`、失败任务 `task`、坐标、相机与出处元数据。**只导出不导入**（导入涉及路径重映射与 id 冲突，本期不做，见画布设计 §9.6）。
- **拼版 PNG**：把画板里的图片按 4 列、256 px 缩略图拼成一张图（≤200 张，超出截断并在提示里说明），每格下方是 prompt 首行。图片经插件同源文件路由加载，正常情况**不会被跨源污染**；某张加载失败只留灰块 + 文件名，不中断整版；若 `canvas.toBlob` 仍因污染失败，面板会明确报错而不是给一张空图。
- **增量保存口径**：拖动/对齐/微移只把变化的节点 ID 与（变化了的）相机发给服务端，700 ms 防抖，页面关闭时冲刷。用户可见的结果不变：拖完很快落盘，重开画板恢复排布与相机。

## ComfyUI 的两种启动方式

工作台状态行的启动入口给两种选择：

- **后台启动**（默认）：ComfyUI 完全后台运行，不弹任何窗口，输出写入 `logs/dsh-image-forge-launch-*.log`。这是推荐方式——没有可被误关的窗口。
- **启动并看日志**：同样后台拉起 ComfyUI，但另开一个 **实时刷新的日志窗口**（Windows 上用 PowerShell `Get-Content -Wait` tail 日志）。这个窗口只是**查看器**，关掉它不会停止 ComfyUI；要看回日志，用状态行的日志路径。

两种方式下 ComfyUI 进程本身都是 detached + 隐藏的：面板关闭、日志窗口关闭都不影响它继续跑。工具侧 `qwen_image_setup` 的 `action="start"` 也支持 `showLog: true` 选择第二种。

## 执行后端与受管环境（T22）

### 三条运输方式，一条图

出图/改图只有一份图构建逻辑（`src/comfyui.ts`），执行按设置里的 `executionBackend` 选择：

| 值 | 行为 |
|---|---|
| `auto`（默认） | MCP → comfy CLI → HTTP 依次尝试；前两者失败只记录 skipped，最后走 HTTP |
| `mcp` | 只走 comfy-mcp；它失败就是本次调用失败（不静默回退） |
| `cli` | 只走 comfy CLI（`comfy run` + `comfy download`） |
| `http` | 跳过工具链，等价 T15 之前的直连路径 |

MCP 主通道需要宿主提供 `@modelcontextprotocol/client`（peerDependency）；没有工具链时 `auto` 自然落回 HTTP，
功能不丢。设置页可配 `comfyMcpBin` / `comfyBin` / `backendTimeoutMs` / `mcpDebug` / `backendTmpDir`，
T15 的 `DSH_IMAGE_FORGE_*` 环境变量仍优先于设置；默认值与原环境变量行为一致。

### 结果镜像

MCP `fetch_outputs` 与 CLI `download` 的 `out_dir` 指向**工作区内**的
`<outputDir>/.dsh-image-forge/backend-mirror/<prompt_id>/`，跑完保留；画板归档仍走原有
「写图 → recordItems」链路，所以 MCP、CLI、HTTP 三条路径的画板行为一致。`backendTmpDir` 可改
镜像父目录；空的临时目录设置不再把产物写到系统 temp 后删掉。

### 受管安装 stepper

工作台顶部常驻四步：**ComfyUI 运行 → 安装/受管环境 → 权重就绪 → 首次出图**。

- 状态来自能力快照（环境探测 + `/object_info`）与实时 SSE；失败步骤显示原因首行。
- 「重新检测」只重新读快照。**权重下载在工作台内就能做**：缺权重时状态行下方出现
  「下载缺失权重（约 N GB）」抽屉，先给「查看计划」（文件名、体积、目标目录），再点下载
  才写字节；`POST /studio/environment {action:"download", confirm:true}` 以 NDJSON 回流
  逐文件进度。同一个能力也可由 agent 调 `qwen_image_setup action=download`（默认 dry-run）。
- 双底模口径：`qwen21-base` 40 步 / `qwen21-turbo` 8 步（缺 turbo 权重明确退化到 base）/ `moss-sft`
  MOSS-Image（25 步模板；缺权重直接报错，不静默）。

### 状态行上的「启动 / 停止」

标题行右侧的状态行（「ComfyUI 未就绪 / ComfyUI http://…」那一行）现在自带启停：

| 显示 | 含义 | 点了会发生什么 |
|---|---|---|
| **后台启动**（主按钮） | 没探到在跑的 ComfyUI | `POST /studio/environment {"action":"start"}`：完全后台拉起，**不弹任何终端窗口**；输出写日志文件；等 `/system_stats` 就绪；`comfyEndpoint` 配了 loopback 端口就以它为 `--port` |
| **看日志** | 有启动日志路径时 | 在工作台内展开日志抽屉：读 `GET /studio/log?path=…` 的尾部 200 行，抽屉打开时每 2 秒刷新一次；**不弹外部窗口**。本插件拉起的实例读自己的 launch 日志，你自己启动的实例退回读 Comfy Desktop 的 `logs/comfyui.log`，所以这个按钮两种情况下都在 |
| **停止**（次按钮） | 在跑，且**归属确认**（启动记录的 pid 还活着、命令行里仍是那个 `main.py`） | 先 `window.confirm`，再停；停完回报 `taskkill` 退出码并复核端口已关，成功则删启动记录 |
| **停止**（禁用）+「由你自己启动的实例，插件不提供停止」 | 在跑，但不是本插件拉起的 | 什么都不会发生。插件不杀无法证明归属的进程 |
| **启动中… / 停止中…** | 请求在路上（宿主侧单飞：连点第二次会被 409 拒绝） | 等它回来；面板不会拉起第二个实例 |

- 「本次由插件拉起 · pid N」出现在端点后面时，说明进程**比窗口活得久**（已 `unref`），关面板不会关它。
- 失败直接把宿主的 `note` 与日志路径显示在状态行下方，例如 `端口被占：8188 上已有进程在监听`。
- 启动参数定制（`extraArgs`）属阶段 3：环境层接口已留（默认不追加任何 flag），UI 暂不暴露输入。
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
- **后端只有本机 ComfyUI 一个**。它没起来或缺权重时，错误会点名缺什么（探测过哪些端口、缺哪个文件），
  并指向 [部署文档](comfyui-deployment.md)。
- 参考图由 ComfyUI 按画布缩放（工作流的 `resolution` 预算），插件侧**没有**参考图预算旋钮。
- 落盘命名与文生图一致，`preset` 默认是 `edit`（`<outputDir>/<prefix>_<W>x<H>_<n>.png`）。

### MOSS-Image 的改图（`comfyModel: "moss-sft"`）

MOSS 的改图走**社区 edit LoRA + 原生节点**，不是 Qwen 的编码器通路：图里在 `UNETLoader`
之后串 `LoraLoaderModelOnly`（`loras/moss_image_edit_lora_rank_64_bf16.safetensors`，
`strength_model` 1.0），正向/负向各一个 `TextEncodeMOSSImageEdit`（`edit_format`
`Moss-Image-Edit`，两张图都拿同一组参考），画布仍由 `ratio_follow`/`wh_ratio` 决定，
参考图缩放到与采样画布同尺寸后再编码。用法与 Qwen 完全相同：

```text
qwen_image_edit(prompt = <成品修改指令>, images = ["D:\\pictures\\cup.png"], comfyModel 由插件配置为 "moss-sft")
```

- **前置**：LoRA 必须在 ComfyUI 的 `models/loras/` 里（本机装载脚本见
  [部署文档](comfyui-deployment.md)）；缺它时 ComfyUI 会拒绝 `LoraLoaderModelOnly`，
  错误原文会点名该文件名。
- 采样步数/Cfg/采样器走 `mossSampling` 档位（comfy 25 步 / CFG 2.5 / `er_sde`；
  official 50 步 / CFG 3 / `euler`），与文生图同一个工作点；返回的 `steps_used`
  和注入图一致。
- **能力边界（实测）**：社区 edit LoRA 的指令遵循不完美——本机验证里「把杯身文字改成
  『春晓』」被写成「春晕」，且原英文行没删掉、只新增一行（`verify/results.json` 的
  edit LoRA 条目）。**改字/换局部元素可以，重度重构（换机位、换构图）不要指望它**。
- 另一条**未接入插件**的通路：不接 VAE、`edit_format` 用 `ai-toolkit` 时，
  `TextEncodeMOSSImageEdit` 会把参考图当 vision tokens 喂给 Qwen3.5（无需 LoRA），
  本机实测能更好地继承参考图设计；但它同时**锁死构图先验**，换视角必须靠结构性框架
  （`.workbuddy/memory/2026-11-10.md` 的实测记录）。插件目前只接上面那条 LoRA 通路。
- 写改图 prompt 时沿用两条已沉淀准则：**vision 参考会锁构图**（想换视角/机位要靠结构性
  描述，不靠「主体小一点」这类形容词）；**布局 caption 的视觉语汇会扩散到全图**（改图
  prompt 里也别堆远景高频细节词，否则参考图之外会被补出同类纹理）。

### MOSS-Image 的布局控制（`layout`，仅 `comfyModel: "moss-sft"`）

`qwen_image_generate` 的 `layout` 参数把布局编辑器导出的 **compiled JSON** 作为 MOSS 的
**正向编码文本**：MOSS 的布局 prompt 本来就是这段 JSON（原生 `MOSSImageLayoutPrompt` 节点的输出
就是 `{summary:{caption},items,bbox_coord_space:"abs_centralized",bbox_format:"yxyx"}`），
官方模板把它直接喂给正向 `CLIPTextEncode`。插件在本地完成同一份编译，所以布局通路只换一个
文本值，**不注入任何额外节点**。

```text
qwen_image_generate(
  prompt  = <整图描述：布局 summary.caption，工具会把它与布局一起校验>,
  layout  = <布局编辑器「导出 compiled」原文（abs_centralized / yxyx）>,
  wh_ratio = "1:1",   // 或 width/height，需与布局 draft 的坐标空间一致
  comfyModel 由插件配置为 "moss-sft",
)
```

- **只对 MOSS-Image 生效**：Qwen 两个 profile 没有布局通路，传 `layout` 会在调用前明确报错
  （不会提交一张忽略布局的图）。
- **校验在工具边界完成**：布局必须是合法 JSON、`bbox_coord_space=abs_centralized`、
  `bbox_format=yxyx`、`items` 非空、`summary.caption` 非空（整图描述是布局 prompt 的语义锚点）、
  每个 bbox 是四个有限数字；任何一条不满足都会点名报错。
- **无布局回归**：不传 `layout` 时走原来的 `MOSS_IMAGE_WORKFLOW`，注入图与之前逐字节一致。
- **为什么不是节点链**：ComfyUI 0.45.3 的原生 `MOSSImageLayoutPrompt` 需要 `CreateBoundingBoxes`
  的 element 数组，而该数组/节点状态无法通过 HTTP API 传入（列表会被当作 linked input，
  `editor_state` 是必填 widget 且无生产者）。本地编译是同一变换提前一层完成，输出字节等价。
- **本期边界**：只支持「MOSS 文生图 + 布局」；布局与参考图改图叠加的行为未定义（T21 停止条件），
  改图请去掉 `layout`。布局强度由布局稿本身决定（本版不暴露 `MOSSImageControl` 的强度旋钮，
  那个节点管的是 color/depth control map，不是画框布局）。

| 工具 | 说明 |
|---|---|
| `qwen_image_generate` | 出图主入口。`prompt`（成品，必填）、`wh_ratio`（一等参数，官方 7 档）、`size_tier`（`1.5mp` 默认 / `2k` 官方 4.2MP 表）、`width`/`height`（可选覆盖）、`steps`、`seed`、`count`(1–4)、`preset`、`board`（画板 id/名字，**省略就新建**，见「画板」一节）、`layout`（MOSS 专用：布局编辑器导出的 compiled JSON，见「MOSS-Image 的布局控制」）、以及只对 base 生效的 `cfg`/`negative_prompt`（质量档，见[配置](configuration.md)） |
| `qwen_image_edit` | **参考图编辑（图生图）**。`prompt`（成品修改指令，必填）、`images`（1–10 张绝对路径或 `data:image/…;base64,…`，必填，按序对应 `<image1>`…）、`ratio_follow`（画布跟随某张参考图的宽高比；`image1`… 或该图在 `images` 里的原字符串）、`wh_ratio`（**与 `ratio_follow` 互斥**）、`size_tier`、`width`/`height`、`steps`、`seed`、`count`、`preset`（默认 `edit`）、`board`（改图通常传参考图所在画板的 id） |
| `qwen_image_status` | **只读**体检：**本机 ComfyUI 是否在跑**（探了哪几个端口、三个权重能不能枚举到、显卡型号与显存余量）、输出目录能否写。不产图、不写盘、不改配置，也不拉起或杀掉任何进程 |

排障顺序：先 `qwen_image_status`，`next_steps` 非空就照着那句话做。

### `qwen_image_status` 返回什么

```jsonc
{
  "checked_at": "2026-10-19T…",
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
- 整个载荷是 **lossless JSON**：没有 `undefined`，不适用的字段一律 `null`——DSH 的工具层会拒收带
  `undefined` 的值（`value is not lossless JSON`），这条由测试钉住。
