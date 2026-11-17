# dsh-image-forge 无限画布工作台设计（CANVAS-DESIGN）

本文是 [DIRECTION-ALIGNMENT.md](DIRECTION-ALIGNMENT.md)（方向文档）与 [EXECUTION-PLAN.md](EXECUTION-PLAN.md)（执行计划）之后的**画布专项设计**：把 Studio 画布从「结果陈列板」升级为 Weavy/Krea/Flora 式的**创意生成画布**——生成任务是画布上一等节点，结果落为图片节点，派生/参考血缘以边持久化，可从任意节点分支迭代，素材可拖入。第 11 节的任务拆分（C01–C15）按执行计划六段式体例写成，供后续并入 EXECUTION-PLAN.md（**本文不修改那两份文档**，并入是下一个工作者的事）。

行文约定：中文行文、技术名词保留英文；现状事实带 `文件:行号` 证据（2026-11-17 本会话逐条核实）；设计决策显式标注 **【设计决策】**；不承诺时间表，顺序用依赖/批次表达。

---

## 1. 决策记录（2026-11-17 用户拍板）

| # | 决策 | 含义与影响 |
|---|---|---|
| D6 | 画布定位 = 生图类网页产品那种无限画布（用户原话「生图生视频之类的网页产品那种的无限画布」） | Weavy/Krea/Flora 式创意生成画布：生成任务是画布上一等节点（占位/进度/失败重试），结果落为图片节点，派生/参考关系以边持久化，可从任意节点分支迭代，素材可拖入。**这推翻了现有代码宣言「节点=结果，不是工作流步骤」**（`src/studio-view.ts:20-27`「Deliberately not ported」、`:99-105`「A node is a *result*, not a workflow step」）——本文明写这是**方向变更**，不是对旧注释的修补。但它**不是 Comfy 式参数工作流**：边表达派生/参考血缘，不做参数连线编排；出图后端链路（HTTP/MCP）不变，画布只是交互层。视频生成不在本期范围（插件是生图插件），数据模型 media-agnostic：节点带 `kind` 字段，视频节点留扩展点不实现。 |
| D7 | MOSS 布局编辑器做成**画布内布局节点**（不是独立页签） | 需要世界坐标 ↔ 布局 draft 画布坐标的**第二套映射**，与 T21（布局 JSON 进 prompt 接线）联动，形成「画框 → 出图 → 结果回画布」闭环。T20 原「独立挂载进面板」方案被本设计取代（见 §8.5）。 |
| D8 | 节点图片**按原图宽高比显示**（高度固定、宽度随比例） | 消除 `object-fit:cover` 裁剪失真（`src/client-styles.ts:94`）。同步更新几何常量与全部几何测试（见 §3.4、§14）。 |
| D9 | 设计范围全覆盖 | 交互补全（多选/框选/对齐分布/快捷键/右键/撤销重做/定位移相机）+ 素材双向流（拖入/跨板复制移动/外部文件落画布）+ 性能与持久化演进（视口裁剪/边索引/增量保存/board version 2 迁移/导出）+ 两个已实锤 bug 修复 + 生成任务节点。 |

### 1.1 本文派生的设计决策（DD 编号，正文引用）

| # | 决策 | 依据所在节 |
|---|---|---|
| DD1 | 技术路线：扩展现有 DOM+CSS transform，不引入 tldraw | §12 |
| DD2 | 节点类型本期三种：`image` / `task` / `layout`；`text`、`video` 只留 kind 枚举扩展点不实现 | §3 |
| DD3 | 图片节点显示尺寸：图片区高度固定 200 世界单位，宽度 = 200×(w/h)，钳制 [96, 480]；节点头尾不变，总高仍 240 | §3.4 |
| DD4 | 边模型沿用 `parents[]` 邻接表（子节点记父 id），不引入独立边表；客户端建 Map 索引 | §3.5 |
| DD5 | 任务节点完成时**原地转图片节点**（count>1 时首张原地、其余向右扇出） | §4.4 |
| DD6 | 任务节点运行态不落盘；**终态失败/中断的任务节点落盘**（kind:'task'），刷新后可重试 | §4.6、§9.2 |
| DD7 | SSE 关联采用「clientId + 服务端 run 注册表」：generate 请求新增可选 `clientId`，事件附加可选 `clientId`/`boardId`，向后兼容 | §4.3 |
| DD8 | zoom 范围放开为 0.1–4；视口裁剪常开（可见矩形 + 256 世界单位余量）；小地图本期不做 | §5 |
| DD9 | 撤销重做 = 内存命令栈、会话级、上限 100 步、不落盘；不覆盖相机与生成 | §6.5 |
| DD10 | 外部文件落画布走**新增 import 路由**（现状无上传路由，brief 口径「既有 asset 路由」与事实不符，见 §15.2） | §7.3 |
| DD11 | board v1→v2 **读时内存迁移 + 写时落盘**（lazy migration），version>2 仍整板忽略 | §9.3 |
| DD12 | 增量布局保存：客户端 dirty 集合只发移动过的节点 + 相机；线缆形状不变、700ms 防抖保留 | §9.4 |
| DD13 | 上限口径维持 200 板 / 1000 条（裁剪后渲染成本与板大小解耦） | §9.5 |
| DD14 | 导出：画板 JSON（Blob 下载）+ 拼版 PNG（offscreen canvas，同源图无 taint） | §9.6 |
| DD15 | Bug1 修复口径照协调者已定方案：服务端 path→id 解析（复用 `boards.resolveParents`），**不改生成请求线缆契约**；本设计未发现硬伤（§11.1 含两个边界说明） | §11.1 |
| DD16 | 未摆放条目网格间距 X 由 244 改为 516（最大节点宽 480 + 36），保证变宽节点不重叠；对应存储测试显式更新 | §3.4、§14.2 |

---

## 2. 现状基线（已核实，执行前可抽查不必重推导）

架构与渲染：

- DOM + CSS transform，非 canvas2D/SVG/tldraw。单 `.dsh-forge-canvas-layer` div 施加 `translate(...) scale(zoom)`（`src/studio-view.ts:1670-1675`；样式 `src/client-styles.ts:89`）。
- 节点固定 208×240 世界单位（`src/studio-canvas.ts:24-26`）；图片 `object-fit:cover` 裁 200px 高（`src/client-styles.ts:92-94`）——D8 要消除的失真。
- 血缘边是 1×1 `overflow:visible` SVG 里的三次贝塞尔（`src/studio-view.ts:1676-1688`、`src/studio-canvas.ts:159-166`）；边查找 O(n×parents)，内层 `nodes.find`（`src/studio-view.ts:1679-1680`）。
- zoom 钳 0.3–2.5（`src/studio-canvas.ts:29-31`）；相机数学全部纯函数（screen/world 互逆、锚点缩放、pan 除 zoom、fit 居中、落位不重叠），9 个几何测试（`test/studio-canvas.test.mjs:28-106`）。
- 全量 DOM 渲染，`img loading:lazy` 是唯一缓解（`src/studio-view.ts:1699-1704`）。

数据与持久化：

- 节点 = 画板条目 `BoardItem`（id/path/width/height/bytes/mediaType/prompt/ratio/steps/seed/mode/backend/parents[]/batchId/sessionId/x,y 可空，`src/studio-shared.ts:283-310`）；画板带 `camera{x,y,zoom}|null`（`:313-316`）。
- 落盘 `<outputDir>/.dsh-image-forge/boards/<id>.json` + `state.json`，`version=1`，**版本不符整板忽略不迁移**（`src/boards.ts:60-61,285`）；原子写（staging+rename，`:408-417`）+ 每目录写队列（`:192-199`）；上限 200 板 / 1000 条，超限丢最旧**排布**不丢文件（`:55-58,550-552`）；未摆放条目 3 列网格 244/276 间距、原点 40（`:63-67,561-566`）。
- 布局保存：700ms 防抖、全量坐标 + 相机 POST board `action:'layout'`（`src/studio-view.ts:599-633`）；路由封闭 action 集 + 逐条校验（`src/studio-routes.ts:252-296,470,484-521`）；board 路由 body 上限 256KB（`:247`）。
- `resolveParents`：path→id 在写锁内解析，分隔符/大小写归一，显式 `parents` 优先，匹配不到的 path 静默丢弃（`src/boards.ts:576-588`）。

出图链路：

- 表单 → POST `/studio/generate`（`src/studio-view.ts:803-917`）→ `runStudioGeneration`（`src/studio-service.ts:347-351`）→ ComfyUI HTTP → `writeImages` → `recordItems`（`:447-474`）→ 响应带条目 id → 前端 `nextNodeSpot` 落最右节点右侧 +40、off-screen 才移相机（`src/studio-view.ts:866-909`、`src/studio-canvas.ts:142-151`）。
- 「用作参考」走 path 引用 + `nodeId` 记边（`src/studio-view.ts:993-1009`、`src/studio-shared.ts:176-185`）；参考图线缆二选一：base64 `data` 或宿主已写文件的 `path`（`src/studio-routes.ts:578-600`）。
- ComfyUI `/prompt` 返回的 `prompt_id` 在适配器内部用于轮询 `/history`，**不外露**（`src/comfyui.ts:1186-1194`）。

SSE（T16/T18 已完成）：

- Node 订阅 ComfyUI `/ws` → 归一化 → 同源 SSE（`src/progress.ts`，归一化在 `:365-441`）；前端 reducer 折叠（`src/studio-view.ts:365-399`），进度渲染为**面板顶部全局一条状态栏**（`:1275-1309`），与画布节点零关联。
- 事件联合类型（`src/studio-shared.ts:390-411`）只有 `promptId`，**无 board/item/clientId 关联字段**——任务节点需要扩展（§4.3）。

素材页与缺失能力：

- 素材页只有 用作参考/定位/移除/删文件 四按钮（`src/studio-view.ts:1188-1234`）；无 drag&drop（全文件无 onDrop/onDragOver）；「定位」只切板 + 选中不移相机（`:1040-1044`）；跨板只能引用，`boards.ts` 无 copy/move API；**无文件上传路由**（`src/studio-routes.ts` 全部路由：config/generate/optimize/boards/board/assets/file/events，file 路由只读不写）。
- 缺失：多选/框选（单选 `selectedNodeId`，`src/studio-view.ts:462`）、快捷键/右键（全文件仅 `:1325-1328` 一处 onKeyDown，是重命名输入框的 Enter/Esc）、撤销重做（grep 零命中）、导出（仅单图原图链接 `:1724-1733`）、视口裁剪、节点 resize。

布局编辑器（T20 核心完成，挂载待做）：

- `src/layout-editor.ts`（1406 行，14 测试，compiled 对 verify/ 8 对样本逐字节回归）是独立固定画布编辑器：无平移缩放，按显示宽度缩放 draft（`:1110-1111` canvas `width:100%`）；画框/移动/8 向 resize/Delete/双导出 draft+compiled。
- `mountLayoutEditor(container, options)`（`:1069`）返回 handle（`:1012-1022`：getState/setState/getDraft/getCompiled/addBox/deleteSelected/destroy）；options 有 `onChange`/`onExport` 回调（`:997-1009`）；**未被任何入口 import**。
- 布局格式：draft `abs/xyxy` 左上原点像素 → compiled `abs_centralized/yxyx` 中心原点像素（`:42-51`，方向文档决策 7）；画布边长 16 的倍数（`:54`）。

执行进度（`verify/EXECUTION-PROGRESS.md`，2026-11-17，权威）：T01–T14、T16–T19 已提交；T20 核心完成挂载待做（`:43`）；T15（MCP client）/T21（布局接线）/T22（收口）未开始（`:33,44-45`）；实验批未开始。T19 已完成的实证：`src/model-profiles.ts:918` moss-sft 已有 `imageToImage`。

产品硬边界：浏览器不得直连 ComfyUI（cross-site 403，DEEP_RESEARCH L15/L73）；许可事实只写文档不进 UI；不引入第三方 ComfyUI 节点包。

竞品输入（DEEP_RESEARCH_dsh-image-forge竞争定位.md）：「跨画板归档 + 显式派生血缘 + 七档比例」是未见文档化先例的差异化组合（L7/L65）；InvokeAI Unified Canvas/持久图层/Workflows 是能力基线（L47/L63）；Weavy 把 node 定义为「有特定输入输出的函数」、点 Run 消耗 credits（L63）——本设计吸收其「生成即节点」交互，但不做参数连线编排（D6）。注意该报告的行动清单未被定稿采纳，本文只取其能力基线事实。

---

## 目录

- §3 设计面 1：定位与节点体系
- §4 设计面 2：画布上生成（任务节点生命周期）
- §5 设计面 3：相机与视口
- §6 设计面 4：交互（选择/快捷键/右键/拖拽/撤销重做/对齐分布）
- §7 设计面 5：素材双向流
- §8 设计面 6：布局节点（D7 重点）
- §9 设计面 7：持久化 v2（迁移/增量保存/上限/导出）
- §10 设计面 8：性能
- §11 设计面 9：Bug 修复与卫生
- §12 设计面 10：技术路线（DOM+transform vs tldraw）
- §13 设计面 11：分阶段任务拆分（C01–C15，六段式）
- §14 设计面 12：测试策略
- §15 待决策点、与 brief 不符的发现、未核实项
- §16 与 T20/T21/T22 的冲突矩阵补充

## 3. 设计面 1：定位与节点体系

### 3.1 定位变更（D6 落地）

**现状**：画布是结果陈列板——节点只持有已完成的文件（`src/studio-view.ts:99-105`），生成过程发生在面板表单里，画布只在响应回来后被动落图（`:866-886`）。代码宣言明确拒绝 tldraw 与工作流形态（`:20-27`）。

**目标**【设计决策，D6 方向变更】：画布成为创意生成的主界面——

1. **生成任务是画布上一等节点**：点「生成」的瞬间任务节点就落画布（占位），排队/采样进度在节点上显示，失败可原地重试；
2. **结果落为图片节点**，与任务节点的位置意图连续（DD5，§4.4）；
3. **派生/参考血缘以边持久化**，从任意图片节点可「分支迭代」（用作参考 → 改参数 → 再生成，边自动连上）；
4. **素材可拖入**（素材页/外部文件，§7）。

明确不做的：Comfy 式参数连线编排（边只有血缘语义，没有端口/参数流）；多 provider 对比网格（单后端定位不变）；视频生成（kind 留扩展点）。出图后端链路（HTTP，未来 MCP）一律不动——画布只是交互层。**`src/studio-view.ts:20-27` 与 `:99-105` 的旧宣言注释随 C06 改写**，写明 D6 变更，避免后来者按旧注释理解代码。

### 3.2 节点类型（DD2）

| kind | 本期 | 内容 | 尺寸规则 |
|---|---|---|---|
| `image` | 实现 | 结果图或导入素材：图片 + 元信息（尺寸/KB）+ 选中动作条。现有 `CanvasNode`（`src/studio-view.ts:106-113`）演进而来 | 图片区高固定 200，宽随比例（DD3）；总高 240 不变 |
| `task` | 实现 | 生成任务：状态机（§4.2）+ 参数摘要（prompt 首行/ratio/steps/count/参考图数）+ 进度条 + 失败原因 + 重试/编辑按钮 | 固定 208×240（与默认图片节点同框，落位网格无需特判） |
| `layout` | 实现（D7） | MOSS 布局编辑器嵌入（§8）：draft 画布 + 工具条 + 摘要字段 | 默认 480×420，可 resize（宽 [320, 960]，高随 draft 比例 + 工具区） |
| `text` | **本期不做，留扩展** | prompt/笔记节点 | — |
| `video` | **本期不做，留扩展**（D6 media-agnostic） | 视频结果节点 | — |

**text 节点不纳入本期的建议依据**【设计决策】：prompt 编辑已有表单 + 任务节点参数摘要 + 「编辑参数重发」（§4.5）覆盖；Weavy 式文本节点的价值在多节点参数编排，而 D6 明确不做编排。kind 枚举预留 `'text'`，v2 读校验遇到未知 kind 按「不可渲染条目」过滤（不整板丢弃，沿用 `src/boards.ts:306-311` 宽松校验哲学）。

**video 扩展点**：`BoardItem.mediaType` 已存在（`src/studio-shared.ts:290`），v2 的 `kind` 判定按 mediaType 前缀（`image/*` → image，未来 `video/*` → video）；渲染层按 kind 分发，本期 video 分支不存在。数据模型不出现任何 image-only 的硬假设（宽高字段对视频同样成立）。

### 3.3 客户端节点模型

**现状**：`CanvasNode`（`src/studio-view.ts:106-113`）只有 id/image/batchId/x/y/parents。

**目标**【设计决策】：判别联合——

```ts
type CanvasNode =
  | { kind: 'image'; id: string; image: StudioImage; batchId: string; x: number; y: number; parents: readonly string[] }
  | { kind: 'task'; id: string; clientId: string; x: number; y: number; parents: readonly string[];
      params: TaskParams; status: TaskStatus; progress?: { label: string; percent: number }; error?: string }
  | { kind: 'layout'; id: string; x: number; y: number; w: number; h: number; draft: LayoutDraft; parents: readonly string[] }
```

`TaskParams` = 生成请求的快照（prompt/ratio/steps/count/seed/references 的 path+name 摘要），供失败重试与「编辑参数重发」；`TaskStatus` 见 §4.2。layout 节点的 `w/h` 是**显示尺寸**（世界单位），draft 内部像素坐标独立（§8.2）。

### 3.4 尺寸策略与几何常量（D8 落地，DD3/DD16）

**现状**：`CANVAS_NODE_WIDTH=208`、`CANVAS_NODE_HEIGHT=240` 是常量（`src/studio-canvas.ts:24-26`）；CSS 把图片裁成 200px 高 cover（`src/client-styles.ts:94`）；`nodeRect` 用常量拼矩形；服务端网格间距 244/276（`src/boards.ts:64-66`）。

**目标**【设计决策】：

- 新增纯函数 `nodeDisplaySize(width: number, height: number): { width: number; height: number }`（放 `src/studio-canvas.ts`，该文件纯数学无 DOM，**服务端 boards.ts 可直接 import**，保证两端同一套几何）：
  - 图片区高 `IMAGE_AREA_HEIGHT = 200`（不变）；图片区宽 = `round(200 × width / height)`，钳制 `[MIN_NODE_WIDTH=96, MAX_NODE_WIDTH=480]`；
  - 节点总高 = 200 + 40（meta+actions）= 240，`CANVAS_NODE_HEIGHT` 不变；
  - `CANVAS_NODE_WIDTH = 208` 保留为**默认/兜底宽**（task 节点、未知尺寸条目用），不再是图片节点的唯一宽。
- 七档比例下的实际宽：1:1→200、4:3→267、3:4→150、3:2→300、2:3→133、16:9→356、9:16→113——全部落在钳制区间内，**七档无裁剪**；钳制只影响导入的任意比例素材（极端长图宁可缩窄也不拉破布局）。
- CSS：`.dsh-forge-node img` 改 `height:200px; width:100%; object-fit:contain`（节点宽已按比例算好，contain 只是兜底防变形）；`.dsh-forge-node` 的固定 `width:208px`（`src/client-styles.ts:92`）改为内联 style 按节点宽写入。
- `nodeRect(node)` 按 kind 取尺寸：image 用 `nodeDisplaySize(image.width, image.height)`，task 用 208×240，layout 用自身 w/h。
- **落位**：`nextNodeSpot`（`src/studio-canvas.ts:142-151`）本来就按实际矩形算最右 +40，变宽后自动正确，不改逻辑。
- **网格**（DD16）：`GRID_PITCH_X` 244→516（= MAX_NODE_WIDTH 480 + 36 间隙），`GRID_PITCH_Y` 276 不变，`GRID_COLUMNS=3` 不变。依据：网格是无坐标条目的兜底排布，**不重叠保证优先于密度**；516 间距对 1:1 图偏松，但用户拖拽后走增量保存，网格只影响首次落位。这是显式契约变更，`test/boards.test.mjs` 的 3 列网格断言同步更新（§14.2）。
- **边锚点**：`edgePath`（`src/studio-canvas.ts:159-166`）从 from 右缘中点到 to 左缘中点，本来就吃 Rect，变宽后自动正确；`reach` 系数不动。

### 3.5 边模型（DD4）

**现状**：边 = 子节点的 `parents[]`（`src/studio-shared.ts:300-301`），渲染时双层 flatMap + `nodes.find`（`src/studio-view.ts:1679-1687`）。

**目标**【设计决策】：**沿用 `parents[]` 邻接表，不引入独立边表**。依据：(a) 现有存储/测试/resolveParents 全在这套语义上；(b) 本设计的边永远 node→node、无独立属性（没有边标签/权重/端口），独立边表只增加一致性负担；(c) 「布局节点→结果」的血缘同样用 parents 表达——结果节点的 parents 含布局节点 id（布局节点也是持久化条目，§8.4）。变更只在客户端：建 `Map<id, CanvasNode>` 索引 + 预计算邻接（§10.2），渲染 O(可见边数)。

边的三种语义来源（不新增字段，由两端 kind 与 mode 区分）：改图派生（image→image，mode:'edit'）、参考引用（素材→image）、布局派生（layout→image）。视觉上统一现有虚线贝塞尔（`src/client-styles.ts:91`），本期不做分色。

---

## 4. 设计面 2：画布上生成（任务节点生命周期）

### 4.1 发起入口

**现状**：唯一入口是面板表单按钮（`src/studio-view.ts:803-917`）；生成期间画布无任何表示，只有顶部全局状态栏（`:1275-1309`）。

**目标**【设计决策】三个入口，汇聚到同一条 `startGeneration(params, origin)` 前端动作：

1. **表单**（保留）：点生成 → 任务节点落画布。落位沿用 `nextNodeSpot`（最右 +40）；表单不再是唯一视觉焦点。
2. **节点右键 / 选中动作条**：图片节点「分支迭代」= 以该节点为参考预填表单（复用 `referenceNode`，`:993-1009`）+ 打开参数确认 → 生成；任务节点失败后「重试」「编辑参数重发」（§4.5）。
3. **布局节点**「生成」按钮（D7 闭环，§8.4；T21 落地前先走「发送到表单」过渡）。

任务节点落位后**立即移相机使其可见**（沿用现有 off-screen 判定逻辑 `:894-909`，但任务节点是用户主动发起的，判定放宽为「不在视口内就居中」——用户盯着表单点生成时画布可能被滚走过）。【设计决策】

### 4.2 任务状态机

```
idle(占位) → queued(排队, 显示前方任务数) → running(采样, label/percent)
  → done(转图片节点, DD5)
  → failed(失败原因 + 重试/编辑按钮)
  → interrupted(已中断 + 重试按钮)
```

【设计决策】reducer 纯函数化：新 `reduceTaskEvent(task, event)` 与现有 `reduceProgressEvent`（`src/studio-view.ts:365-399`）并存——全局状态栏保留（它服务对话工具发起的、无画布关联的 run），任务节点 reducer 只消费带本节点 clientId 的事件。沿用现有纪律：`queue` 帧只能把 queued/idle 往后推，不能让已开始的 run 回到排队（`:374-384` 的注释语义逐条保留）。

### 4.3 promptId ↔ 节点映射与 SSE 扩展（DD7）

**现状缺口**（已核实）：`prompt_id` 只在适配器内部（`src/comfyui.ts:1186`），不外露；SSE 事件只有 promptId（`src/studio-shared.ts:390-411`）；前端无从知道哪个事件属于哪次面板生成。

**目标**【设计决策】clientId + 服务端 run 注册表，四步接线：

1. **前端**：`startGeneration` 生成 `clientId`（`c` + 随机 base36，仿 `makeItemId` 风格，`src/boards.ts:261-263`），任务节点以 clientId 为临时 id；generate 请求体新增**可选** `clientId` 字段。
2. **适配器钩子**：`ComfyOptions`（`src/comfyui.ts:127`）新增可选 `onPromptId?: (promptId: string) => void`，在 `/prompt` 返回 prompt_id 处（`:1186`）回调。默认不给 = 行为逐字节不变（对话工具路径不受影响）。
3. **run 注册表**：新模块 `src/runs.ts`——内存 Map `promptId → { clientId, boardId }`，`studio-service.ts` 在提交前登记（clientId 来自请求，boardId 来自目标板解析），run 结束（响应返回/抛错）后延迟清理（TTL 5 分钟，防 SSE 晚到帧）。**不落盘**：注册表是会话级桥接，重启后旧 run 的 SSE 帧本来就无意义。
4. **SSE 附加**：`progress.ts` 归一化后查注册表，给 `start/node/progress/done/error/interrupted` 事件附加可选 `clientId`/`boardId`；查不到（对话工具 run）不附加。另新增事件 `{ type:'run'; clientId; promptId; boardId? }` 在登记时发出——前端据此把任务节点从 idle 推进到 queued，并建立 clientId↔promptId 本地映射（断线重连后仍能对上）。

**线缆契约变更**（全部加法、向后兼容）：

- `StudioGenerateRequest` + `clientId?: string`（`src/studio-shared.ts:193-211`）；路由 parse 收窄处同步（长度/字符集校验，仿 board id 护栏）。
- `StudioProgressEvent` 各 run 事件 + `clientId?: string; boardId?: string`；+ `run` 事件类型（`src/studio-shared.ts:390-411`）。
- 旧前端消费新事件：多余字段被忽略、未知 `run` 类型走 reducer default 分支（`:395-397`）——**现有 6 个 SSE 渲染测试的行为断言全部保留**，只新增字段断言（§14.3）。
- **Bug1 修复不改这条契约**（DD15）：clientId 是任务节点的新增字段，与 parents 修复完全解耦，两任务可独立验收。

### 4.4 完成转换（DD5：原地转结果）

**二选一给依据**：选**任务节点原地变图片节点**，不选「任务节点消失、结果另落 nextNodeSpot」。依据：(a) 用户把任务节点拖到哪，就是想要结果出现在哪——原地转换保留空间意图，这是生成画布与陈列板的本质区别；(b) 避免完成瞬间节点「跳走」导致的视觉追踪失败；(c) 血缘连续：任务的 parents 直接移交结果节点。

规则【设计决策】：

- count=1：任务节点被图片节点**替换**（id 从 clientId 换成服务端条目 id——响应 `images[].id` 就是条目 id，`src/studio-service.ts:452,478,484-485`），位置/parents 保留。
- count>1：首张原地替换，其余按 `nextNodeSpot` 向右扇出（现有逻辑 `:871-885` 复用）。
- 替换后立即 `scheduleLayout`（沿用 `:888`），并触发增量保存（§9.4）。
- 面板关闭/刷新时 run 仍在跑：结果由服务端 `recordItems` 落板（`:458-474`），下次打开画板自然可见——任务节点本身不恢复（DD6），全局状态栏仍显示进度。

### 4.5 失败重试与分支迭代

【设计决策】：

- **重试**：failed/interrupted 任务节点显示原因首行（`firstLine` 纪律，`src/studio-shared.ts:372-376`）+「重试」按钮 → 用 `params` 快照原样重发（新 clientId、新任务节点原地替换旧节点）。
- **编辑参数重发**：把 params 回填表单（复用 `reuse` 的模式，`:920-924`），用户改完再生成；旧失败节点保留还是替换？——**替换**（同一位置同一意图，避免失败节点堆积；参数快照已进表单，无信息丢失）。
- **分支迭代**：图片节点「用作参考」现有链路不动（path 引用 + nodeId 记边，`:993-1009`）；生成时 parents 由两部分合成——客户端 nodeId 集合（即时画边）与服务端 resolveParents 结果（持久化，Bug1 修复后两者一致，§11.1）。刷新后边从持久化 parents 重建，不再依赖会话内 references。

### 4.6 任务态持久化口径（DD6）

【设计决策】**运行态不落盘；终态失败/中断落盘**。依据：(a) 运行态落盘会引入 stale 恢复难题——面板关闭期间 run 可能已成功，恢复一个「运行中」节点是错的，而「查服务端结果」需要按 clientId 查 run 的持久化日志，成本与收益不成比例（结果本来就会经 recordItems 落板）；(b) 失败节点落盘有真实价值：用户第二天打开画板还能看到「昨晚这单失败了、原因、一键重试」，这正是 D6「失败重试」一等公民的完整语义。v2 条目 `kind:'task'` 仅允许 `status:'failed'|'interrupted'`（读校验强制，运行态字段出现即过滤该条），`params` 快照随条目保存（prompt 全文 + ratio/steps/count/seed + 参考图 path 列表）。

## 5. 设计面 3：相机与视口

### 5.1 zoom 范围（DD8）

**现状**：钳 0.3–2.5（`src/studio-canvas.ts:29-31`），注释理由是「再小看不清、再大位图无收益」。

**目标**【设计决策】：**0.1–4**。依据：0.3 下限下 500 节点（约 15000×8000 世界单位）无法一屏总览，fit 会被钳位截断（`fitCamera` 里 `clampZoom`，`:126`）——生成画布的「退后看全局」是核心动作；0.1 时节点约 21×24 屏幕像素，作为色块总览够用。上限 4 服务于导入素材的像素级检查（200 世界单位高的图放大到 800px）。常量改名语义不变（`CANVAS_MIN_ZOOM`/`CANVAS_MAX_ZOOM`），`clampZoom`/`zoomAt` 逻辑不动；**钳位测试的边界值断言显式更新**（§14.1）。

### 5.2 视口裁剪（DD8）

**现状**：全量 DOM 渲染（`src/studio-view.ts:1689-1747`），边双层 flatMap 全量算（`:1679-1687`），`img loading:lazy` 是唯一缓解。

**目标**【设计决策】：纯函数 `visibleNodes(nodes, camera, viewport, margin=256)` 放 `src/studio-canvas.ts`：

- 可见世界矩形 = camera 左上 + viewport/zoom，四边外扩 `margin` 世界单位（预渲染余量，平移时不露白边）；
- 节点矩形与可见矩形相交即渲染；**常开，无开关**——裁剪成本 O(n) 矩形相交，远低于全量 DOM 差量，小板也无害；
- 边：两端点任一在可见集合内，或边的包围盒与可见矩形相交，即渲染（长边穿过视口但两端在外的情形）；
- React 侧 `useMemo` 依赖 camera/nodes/viewport；pointermove 平移用 rAF 节流合并 setState（§10.3）。
- `loading:lazy` 保留（裁剪 + lazy 双保险：余量内的图也不立即下载）。

### 5.3 小地图（可选，取舍）

【设计决策】**本期不做**。依据：fit（总览）+ 素材定位移相机（§7.4）+ 0.1 下限已覆盖导航需求；小地图是第二套渲染通道（缩略节点 + 视口框 + 点击跳转），在 DOM 方案里要么再渲一遍节点（成本翻倍）要么画抽象色块（信息量低）。留扩展点：`visibleNodes` 的矩形数据可直接喂未来的小地图。若后续板均节点数实测 >300 且用户反馈导航困难，再立项。

### 5.4 fit 与定位移相机

**现状**：`fitCamera` 已实现且测试覆盖（`src/studio-canvas.ts:110-133`）；工具栏「适应」按钮已接（`src/studio-view.ts:1639-1643`）；但素材「定位」只切板 + 选中，**不移相机**（`:1040-1044`）。

**目标**【设计决策】：

- fit 保留，zoom 下限放开后大板 fit 真正可用；fit 后相机走增量保存。
- 新纯函数 `centerOn(rect, viewport, zoom): Camera`——保持当前 zoom，把矩形中心对到视口中心；「定位」、任务节点落位、快捷键 F 之外的「聚焦选中」（双击节点）共用。
- 定位跨板时：先 `selectBoard`（现有），再对目标条目 rect 调 `centerOn`；条目无坐标（x/y null）时先按网格公式算出兜底位置再居中。

---

## 6. 设计面 4：交互

### 6.1 选择模型与框选

**现状**：单选 `selectedNodeId: string | undefined`（`src/studio-view.ts:462`）；手势只有 pan/node 两种（`:116-118`）。

**目标**【设计决策】：

- 状态改 `selection: ReadonlySet<string>`；单击 = 替换选择，Ctrl/Cmd+单击 = 切换成员，空白单击 = 清空（现状语义的超集）。
- 手势联合新增 `{ kind:'marquee'; startX; startY; currentX; currentY; additive: boolean }`：空白处按下拖动 = 框选（additive = 按住 Shift）；屏幕矩形 → 世界矩形用 `screenToWorld`（现有纯函数），命中判定 = 节点矩形相交（新纯函数 `rectsIntersect` / `nodesInRect`）。
- 框选矩形渲染为 canvas 层外的屏幕空间 div（不随 zoom 缩放线宽）。
- 多选拖动：手势记 `{ kind:'nodes'; ids; origins: Map<id,Point>; startX; startY }`，位移 = 屏幕 delta / zoom（沿用 `:977-982` 的换算），一次 setState 批量更新。
- 全部命中/位移逻辑抽纯函数进 `src/studio-canvas.ts`（或新 `src/canvas-interactions.ts`，C08 定），沿用「相机数学纯函数 + 组件只拿状态」的既有纪律（`src/studio-canvas.ts:9-11`）——这是指针手势无自动化现状下唯一可测的形态（§14.5）。

### 6.2 对齐与分布

【设计决策】选择 ≥2 时工具栏出现对齐组（左/水平中/右/顶/垂直中/底 6 个），≥3 时出现分布组（水平等距/垂直等距 2 个）。纯函数 `alignNodes(rects, mode)` / `distributeNodes(rects, axis)` 返回新坐标表：对齐以选择集包围盒为基准；分布按**中心点**等距（首尾不动）。结果走一次批量移动命令（进撤销栈，§6.5）+ 增量保存。不做「相对画板对齐」（画板无限，无意义）。

### 6.3 快捷键表

【设计决策】canvas 容器 `tabIndex=0` 聚焦时生效；输入框/布局编辑器内部聚焦时**全部让位**（事件 target 判定 + 编辑器 stopPropagation，§8.3）。现状全文件仅重命名输入框一处 onKeyDown（`src/studio-view.ts:1325-1328`），无全局快捷键。

| 键 | 动作 | 备注 |
|---|---|---|
| Del / Backspace | 移除选中节点（unplace，不删文件） | 沿用「移除≠删除」双护栏哲学（`:1046-1052`）；删文件只在右键菜单显式项 |
| Ctrl/Cmd+Z | 撤销 | §6.5 |
| Ctrl/Cmd+Y / Ctrl/Cmd+Shift+Z | 重做 | |
| Ctrl/Cmd+A | 全选（当前板可见节点） | 输入框聚焦时让位 |
| Esc | 清空选择 / 关闭右键菜单 / 退出框选 | |
| Space + 拖动 | 平移（任何元素上） | 手势优先级最高 |
| F | fit 全部节点 | |
| 双击节点 | 聚焦该节点（centerOn） | |
| + / −（含小键盘） | 以视口中心 zoomBy(1.25 / 0.8) | 复用现有 `zoomBy`（`:1011-1022`） |
| Ctrl/Cmd+C / V | 跨板复制 / 粘贴到当前板 | 走 §7.2 服务端 API，剪贴板存 {boardId, itemIds} 内存态即可，不写系统剪贴板 |
| 方向键 | 微移选中节点 1 世界单位（Shift=10） | 进撤销栈（合并连续微移为一条命令） |

### 6.4 右键菜单（按节点类型分菜单）

【设计决策】canvas 内 `onContextMenu` 阻止默认，屏幕坐标定位菜单；菜单项按 kind：

- **image**：用作参考 / 分支迭代（预填表单）/ 原图（新窗）/ 复制到画板…（子菜单列板）/ 移动到画板… / 移除（不删文件）/ 删除文件（confirm 二次确认，沿用 `:1228` 文案）。
- **task（failed/interrupted）**：重试 / 编辑参数重发 / 移除。运行中：取消（AbortController，现有 `abortRef` 机制 `:812-813`）/ 移除。
- **layout**：生成（T21 后）/ 发送到表单（过渡）/ 导出 draft / 导出 compiled / 删除节点。
- **空白**：新建布局节点 / 粘贴 / 全选 / 适应视图 / 导出画板（§9.6）。
- 多选时：菜单作用于选择集（批量移除/复制/移动/对齐）。

菜单本身是屏幕空间 DOM，不进 canvas layer（不随 zoom 缩放）。

### 6.5 撤销重做（DD9）

**现状**：grep 零命中，无任何撤销机制。

**目标**【设计决策】：**内存命令栈，会话级，上限 100 步，不落盘**。命令类型：节点移动（含批量/微移/对齐分布）、添加节点（导入/布局新建）、移除节点、layout draft 编辑（经编辑器 onChange 快照）。每条命令 = { do, undo } 闭包或前后快照；生成与相机**不进栈**——生成不可撤销（GPU 已跑），相机撤销与用户空间预期不符（业界画布惯例）。

依据（不落盘）：(a) 画板是多写者共享的（对话工具也写，`src/boards.ts:27-39`），持久化 op log 需要跨写者全序，与现有「每目录写队列 + 最后写赢」语义冲突；(b) 会话级撤销覆盖「手滑拖错/误删」这一真实高频场景，跨会话撤销需求未见证据；(c) 成本：纯内存栈 + 纯函数 reducer 可单测，一天量级；持久化方案是周量级且引入新一致性面。刷新后栈清空，UI 不承诺跨会话撤销。

### 6.6 拖拽手势汇总

| 手势 | 触发 | 现状 | 目标 |
|---|---|---|---|
| 平移 | 空白拖动 / Space+拖动 / 中键 | 空白拖动已有（`:116-118` pan） | + Space/中键 |
| 节点拖动 | 节点上左键拖动 | 已有（单选） | 多选批量；layout 节点只从标题栏拖（§8.3） |
| 框选 | 空白拖动（无 Space） | 无 | §6.1（与平移的区分：空白默认框选，Space/中键平移——**变更现状默认**，空白直接拖动从平移改为框选，平移入口保留三个，写进 usage 文档） |
| 素材拖入 | 素材页卡片 → 画布 | 无 | §7.1 |
| 外部文件 drop | OS 文件 → 画布 | 无 | §7.3 |
| 节点 resize | layout 节点右下角手柄 | 无 | 仅 layout 节点（image 尺寸由比例决定不可 resize，task 固定；D8 语义） |

## 7. 设计面 5：素材双向流

### 7.1 素材页 → 画布拖入

**现状**：素材页四按钮（用作参考/定位/移除/删文件，`src/studio-view.ts:1188-1234`），无 drag&drop（全文件无 onDrop/onDragOver）；跨板只能「用作参考」。

**目标**【设计决策】：

- 素材卡片 `draggable:true`，`dataTransfer` 携带 `{ kind:'forge-asset', boardId, itemId }`（JSON 字符串，自定义 MIME `application/x-dsh-forge-asset`）；
- 画布 `onDragOver` 判定 MIME 后 `preventDefault` 显示落点预览（屏幕坐标 → `screenToWorld` 得世界落点）；`onDrop`：
  - **同板**：条目已存在 → 只更新 x/y（走增量布局保存，不新建条目）；
  - **跨板**：调 §7.2 的 `copy-item`（默认复制，按住 Alt 为移动——拖拽修饰键语义写进 usage 文档）。
- 素材页按钮区新增第五按钮「拖到画布」提示文案不需要——卡片本身可拖，按钮保持四个不动（减少 UI 噪音）。

### 7.2 跨板复制/移动（boards 新 API）

**现状**：`boards.ts` 无 copy/move；`removeItem` 有 unplace/deleteFile 双护栏（`src/studio-routes.ts:275-282`）。

**目标**【设计决策】两个新 board action（封闭集扩为 8 个）：

- `copy-item { board, item, toBoard, x?, y? }`：目标板新建条目——**新 id**（`makeItemId`）、同 path/markdownPath/尺寸/字节/prompt/ratio/steps/seed/mode/backend、`parents` 原样复制（血缘随图走；父 id 在目标板解析不到时渲染层自然不画边，与 resolveParents 的「缺边不失败」哲学一致）、batchId 沿用、坐标给定为给定否则目标板网格兜底。**不复制文件**——两板共享同一 PNG，删文件护栏必须意识到共享（见下）。
- `move-item { board, item, toBoard, x?, y? }`：源板移除条目 + 目标板新增，**保留原 id**（id 只需板内唯一，`assertBoardId` 护栏只管板 id，`src/boards.ts:171-175`）；parents 随迁。
- 两者都在 `serialized(boardsRoot)` 写队列内做「读源板 → 改两板 → 原子写两板」，与 recordItems 同一串行语义（`src/boards.ts:192-199`），两板写之间崩溃的窗口由「先写目标板、后删源板」顺序兜底（move 最坏退化为 copy，不丢数据）。【设计决策】
- **删文件护栏升级**：`remove-item deleteFile:true` 前检查该 path 是否被**其他板**引用（listBoardFiles 扫一遍，200 板 × 小文件，成本可接受）；被引用则拒绝删文件、只 unplace，响应带提示。这是 copy 引入共享所有权后的必要护栏，现有「删文件双护栏」测试保留、新增共享场景断言（§14.2）。
- 路由：`parseBoardAction` 封闭集 + 逐字段校验同步扩展（`src/studio-routes.ts:470,484-521`）；线缆测试「action 封闭集」断言显式更新（§14.3）。

### 7.3 外部文件落画布（DD10）

**现状核实与 brief 差异**：brief 说「外部文件 drop 上传走既有 asset 路由」——**不存在上传路由**。`src/studio-routes.ts` 全部路由为 config/generate/optimize/boards/board/assets/file/events；assets 是 GET 查询（`:300-315`），file 是只读流（`:317-332` 注释明写读不写）；board 路由 body 上限 256KB（`:247`）装不下图片。唯一现成的「字节进宿主」通道是 generate 请求的 base64 参考图（`:595-598`），但那是出图不是归档。

**目标**【设计决策】新增 `STUDIO_IMPORT_ROUTE`（POST `/studio/import`）：

- 请求：`{ board?, name, mediaType, data(base64), x?, y? }`；同源校验 + 扩展名/sniff 白名单（png/jpeg/webp，沿用 file 路由与参考图的白名单哲学）+ 单文件 ≤32MB + body 上限独立于 board 路由（readBody 参数化，`:631-641` 已支持传上限）。
- 服务端：经现有 `writeImages`（`src/output.ts`，free-index 命名 + staging 原子写）落盘到 outputDir，再 `recordItems` 登记（mode:'generate'、prompt:''、backend:'studio'、parents:[]），响应带条目——与面板生成落图同一套身份语义。
- 前端：画布 `onDrop` 收到 OS 文件（`dataTransfer.files`）→ 读 bytes → base64 → import → 图片节点落落点。多文件依次 import、落点向右排开。非图片文件明确拒绝并提示。
- 导入图同样可「用作参考」（path 引用通道现成，`src/studio-shared.ts:176-185`）。
- 线缆测试新增：import 路由同源/白名单/超限/畸形 base64 拒绝断言（§14.3）。

### 7.4 「定位」移相机

**现状**：`showOnCanvas` 只切板 + 选中（`src/studio-view.ts:1040-1044`），节点可能在视口外，用户还要自己找。

**目标**【设计决策】：切板 + 选中 + `centerOn`（§5.4）；跨板时等板数据加载完再算坐标。素材卡片缩略图双击 = 定位（与画布双击聚焦一致）。

---

## 8. 设计面 6：布局节点（D7 重点）

### 8.1 形态

**现状**：`mountLayoutEditor`（`src/layout-editor.ts:1069-1406`）是独立固定画布编辑器，无平移缩放、按显示宽度缩放 draft（`:1110-1111`），**未被任何入口 import**；T20 原计划把它挂进面板独立区域（EXECUTION-PLAN T20 写入范围含 `src/studio-view.ts`（挂载））。

**目标**【设计决策，D7】：布局编辑器作为 `kind:'layout'` 节点嵌进无限画布。节点结构：标题栏（拖拽手柄 + 「布局」标签 + 生成按钮）+ 编辑器容器（mountLayoutEditor 的 element）+ 状态脚注（框数 / draft 尺寸）。默认显示尺寸 480×420 世界单位，可 resize（§8.3）。

### 8.2 双坐标映射（D7 核心）

两套映射各司其职，**互不污染**：

1. **世界 ↔ 屏幕**（现有相机数学）：布局节点作为整体在无限画布上的位置/显示尺寸，走 `screenToWorld`/`worldToScreen`（`src/studio-canvas.ts:62-75`）。节点显示宽 w 世界单位 → 屏幕 w×zoom px。
2. **节点显示 ↔ draft 像素**（编辑器内部）：draft 有自己的像素坐标系（`LayoutDraft.width/height`，16 的倍数，`src/layout-editor.ts:54,121-128`）。编辑器按容器显示宽度缩放 draft（现状机制）：`displayScale = 容器CSS宽 / draft.width`。容器 CSS 宽 = w×zoom（canvas layer 的 scale 已施加），所以**编辑器内部无需知道 zoom**——它看到的容器就是缩放后的 CSS 尺寸。

**关键不变量**【设计决策】：resize 节点（改 w/h）只改 displayScale，**draft 像素坐标一个字节都不动** → `getCompiled()` 输出不变 → 与 14 个逐字节回归测试完全兼容（那些测试测的是纯编译函数 `compileLayout` 链路，不测 mount；mount 本来就没有 DOM 自动化，`verify/EXECUTION-PROGRESS.md:54`「T20 DOM 拖拽未自动化」）。

**但有一个必须修的指针问题**：mountLayoutEditor 的拖拽增量直接用 `clientX/clientY` 差值换算 draft 像素（独立编辑器无 zoom 概念）。嵌进 zoom≠1 的 canvas layer 后，屏幕 1px = 世界 1/zoom px，编辑器增量会**错一个 zoom 因子**。方案【设计决策】：`LayoutEditorOptions`（`:997-1009`）新增可选 `pointerScale?: () => number`——mount 内部所有「屏幕 delta → draft delta」处除以 `pointerScale()`（默认返回 1，独立使用行为不变）；画布挂载时传 `() => cameraRef.current.zoom`。这是加法变更，14 个纯函数测试不受影响；mount 的指针修正用「抽纯函数 delta 换算 + 单测」覆盖（§14.5）。

### 8.3 节点内交互与画布手势的边界

【设计决策】：

- **拖节点只从标题栏**：编辑器区域 `pointerdown` 一律 `stopPropagation`（画布手势不触发），标题栏走画布节点拖拽。
- **键盘让位**：编辑器 wrapper 已 `tabIndex=0`（`:1080`）；聚焦在编辑器内时画布快捷键全部失效（§6.3 的 target 判定），Delete 由编辑器自己消费（删框，现状已有）。
- **resize**：节点右下角手柄（屏幕空间判定，delta/zoom 换算世界尺寸），宽钳 [320, 960]，高 = 标题栏 + draft 按宽等比 + 工具区（即 resize 只改宽，高随比例——与 D8「高度固定宽度随比例」的图片节点不同，布局节点是**宽驱动**，因为 draft 比例固定）。resize 进撤销栈、走增量保存（w/h 是节点字段，§9.2）。
- **滚轮**：编辑器区域内滚轮 = 画布缩放（编辑器自身无滚动需求，draft 全量显示）；不拦截。

### 8.4 闭环：布局节点 → 任务节点 → 结果回画布

【设计决策】分两阶段：

- **T21 落地前（过渡）**：布局节点「发送到表单」——`getCompiled()` 文本 + `summary.caption` 进表单 prompt 区（用户可再编辑），生成走现有链路；结果与布局节点的血缘**由前端 parents 记边**（布局节点 id 进 parents），持久化依赖 v2（布局节点是持久化条目，parents 引用它合法）。
- **T21 落地后（完整闭环）**：布局节点「生成」→ `startGeneration`，params 带 `layout`（compiled JSON + draft 尺寸对应的 ratio）；generate 请求新增可选 `layout` 字段透传给 T21 的布局入参（T21 写入范围含 `src/tools.ts` 布局入参，Studio 路由侧的透传是本设计 C13 的工作，**依赖 T21 先定契约**）；任务节点 parents 含布局节点 id；完成转图片节点，边持久化。布局节点 draft 可继续编辑、再次生成——同一布局节点扇出多个结果，血缘呈星形，这正是「画框→出图→结果回画布」的迭代形态。
- ratio 联动【设计决策】：布局节点生成时 ratio 取 draft 宽高比映射到七档最近档（draft 1536×1024 → 3:2）；若 draft 比例不在七档（MOSS 画布 16 对齐任意比例），**提示用户选择最近档或改 draft 尺寸**，不静默拉伸——七档比例是一等契约（DEEP_RESEARCH L65 差异化组合之一）。

### 8.5 T20 原方案如何被取代（明写）

T20 任务书的挂载步骤（「mountLayoutEditor 挂进 studio-view」，EXECUTION-PLAN §6b T20 写入范围）原本语义是**面板内独立编辑区**（固定画布、与画布视图并列）。D7 拍板后：

- T20 **核心成果全部保留**：纯函数层（draft/compiled/画框几何）+ 14 测试 + 8 对样本逐字节回归，一行不改语义；
- T20 **挂载步骤被本设计 C13 取代**：挂载目标从「面板独立区域」变为「画布内 layout 节点」，新增 pointerScale 钩子与节点容器集成；
- `src/layout-editor.ts` 的写入所有权从 T20 移交 C13（T20 核心已提交 `12368dc`，`verify/EXECUTION-PROGRESS.md:43`，无在途冲突）；
- EXECUTION-PLAN.md 的 T20 条目由下一个工作者并入时标注「挂载方案被 CANVAS-DESIGN D7/C13 取代」，本文不改那份文档。

## 9. 设计面 7：持久化 v2

### 9.1 现状与问题

**现状**：`BoardFile.version=1`（`src/boards.ts:60-61`），`readBoardFile` 对 `version !== 1` **整板返回 undefined**（`:285`）——升级后老用户的板静默消失（文件还在磁盘，UI 不再显示）。条目宽松校验只查 id/path/markdownPath 三个字符串（`:306-311`）。布局保存全量坐标（`src/studio-view.ts:606`）。

### 9.2 v2 数据模型

【设计决策】`BoardItem` 演进为节点条目（**全部加法字段，旧字段语义不动**）：

```ts
interface BoardItem {
  // —— v1 既有字段全部保留（id/path/markdownPath/width/height/bytes/mediaType/
  //    prompt/ratio/steps/seed/mode/backend/parents/createdAt/sessionId/batchId/x/y）——
  kind?: 'image' | 'task' | 'layout'   // 缺省 'image'（v1 条目迁移后的默认）
  // kind:'layout' 专用：
  draft?: LayoutDraft                 // 布局草稿（像素坐标，与显示尺寸无关）
  w?: number; h?: number              // 布局节点显示尺寸（世界单位）
  // kind:'task' 专用（仅终态，DD6）：
  task?: { status: 'failed' | 'interrupted'; params: TaskParams; error?: string }
}
```

- `kind:'task'` 条目的 path/markdownPath 为空字符串、width/height 为 0（读校验对 task 条目放宽 path 非空要求，改为按 kind 分支校验）；**渲染层不显示图片区**。
- `kind:'layout'` 条目同样无文件（path:''），draft 必填（缺失即过滤该条）。
- 未知 kind（未来 'text'/'video'）：读时过滤该条、不整板丢弃（向前兼容，沿用宽松校验哲学 `:306-311`）。
- `BoardFile.version=2`；camera 字段不变。
- 类型落点：`src/studio-shared.ts`（BoardItem/BoardDetail 区域，`:283-316`）；`LayoutDraft` 类型从 layout-editor.ts import 会引入 client 模块进 shared——**改为在 studio-shared.ts 内联声明结构等价类型**（或 layout-editor 的类型段抽到 shared，C04 执行时二选一，倾向前者：不动 layout-editor 的既有 import 面）。【设计决策】

### 9.3 v1→v2 迁移（DD11）

【设计决策】**读时内存迁移 + 写时落盘**（lazy migration）：

```ts
// boards.ts 新纯函数（可单测，无 IO）
function migrateBoardFile(raw: unknown): BoardFile | undefined {
  // version===1：逐条补 kind:'image'（其余字段原样），version 置 2；
  //   条目校验沿用 isBoardItem 宽松规则，坏条目过滤不整板丢。
  // version===2：走 v2 校验（按 kind 分支）。
  // 其他/缺失 version：undefined（整板忽略，现状语义保留——防未来版本降级写坏）。
}
```

- `readBoardFile`（`:270-298`）改为调 `migrateBoardFile`；**读不写盘**——迁移结果随下一次任何写操作（recordItems/saveLayout/removeItem）自然落盘为 v2。依据：读路径写盘会让「打开画板列表」变成写操作，与只读 outputDir 的 best-effort 哲学（`:384-385`）冲突；lazy 迁移无额外 IO。
- **幂等**：v2 文件再过迁移函数不变（测试断言）。
- **不丢数据**：v1 条目的 id/坐标/parents/batchId 逐字段保留（测试用 v1 fixture 逐字段断言）。
- 降级保护：version>2 整板忽略（老版本插件读新板不写坏）；**不做 v2→v1 降级写**。
- 迁移测试（新 `test/board-migration.test.mjs`）：v1 fixture 迁移往返、坏条目过滤、幂等、version 0/3/缺失拒绝、v1 板经 saveLayout 后磁盘为 v2（§14.2）。
- **这是升级用户的静默丢板修复，排最前批次**（C04）。

### 9.4 增量布局保存（DD12）

**现状**：每次防抖到期发**全量**节点坐标 + 相机（`src/studio-view.ts:606-607`）；服务端 saveLayout 本来就按 id 合并、未知 id 忽略（`src/boards.ts:590-609`）。

**目标**【设计决策】：客户端维护 `dirtyIds: Set<string>`（移动/resize/新增/移除时加入），防抖到期只发 dirty 条目 + 相机（相机变化才发），发送后清空；700ms 防抖与 unmount flush 保留（`:619-633`）。**线缆形状不变**（items 数组本来就允许子集），服务端零改动；收益：1000 节点板拖一个节点从 ~40KB 请求降到 ~100B，且写锁内 JSON.stringify 的板体积不变但请求解析成本下降。移除节点走 remove-item 既有通道，不进 layout diff。测试：现有 layout 往返断言保留，新增「子集保存不动其他条目坐标」断言（服务端语义已如此，补显式守护）。

### 9.5 上限口径（DD13）

【设计决策】**维持 200 板 / 1000 条**（`src/boards.ts:55-58`）。依据：视口裁剪后渲染成本与板大小解耦（§10）；1000 条 × ~400B ≈ 400KB JSON，原子写与读解析都在毫秒级；超限丢最旧排布不丢文件的护栏（`:548-552`）语义不变。布局节点与失败任务节点**计入** 1000 条（它们是条目）；运行中任务节点不计（不落盘）。若未来实测板均条目 >500 且保存延迟可感，再议分页/分片，本期不做。

### 9.6 导出（DD14）

**现状**：仅单图原图链接（`src/studio-view.ts:1724-1733`）。

**目标**【设计决策】两种导出，入口在空白右键菜单 + 画板工具条：

1. **画板 JSON**：当前 BoardDetail（v2 含 kind/draft）序列化为 Blob 下载 `<板名>.board.json`。纯客户端，无服务端改动；导入（从 JSON 恢复画板）**本期不做**——涉及文件路径重映射与 id 冲突，留扩展点。
2. **拼版 PNG**（contact sheet）：offscreen canvas（`document.createElement('canvas')`，不需要 OffscreenCanvas API）按网格绘制全部图片节点缩略图 + 底部 prompt 首行标注。图片经 `studioFileUrl`（同源路由，`src/studio-routes.ts:317-332`）加载 → **无 CORS taint**，`canvas.toBlob` 可导出。网格布局抽纯函数 `contactSheetLayout(items, cols, thumbSize)` 可单测；绘制是浏览器侧薄层。上限：单次 ≤200 张、缩略图 256px（防内存峰值）；layout/task 节点不画（无图）。加载失败的图位画灰块 + 文件名，不中断整版。

---

## 10. 设计面 8：性能

### 10.1 现状成本

全量 DOM（`src/studio-view.ts:1689-1747`）+ 边 O(n×parents) 内层 `nodes.find`（`:1679-1680`）+ 每次 pointermove 全节点 map 重建（`:980-982`）+ 全量坐标保存（`:606`）。1000 节点时每次平移帧 = 1000 个 div 的 style 重算 + 全量边路径字符串拼接。

### 10.2 措施汇总（与前文对应）

| 措施 | 落点 | 节 |
|---|---|---|
| 视口裁剪（节点 + 边，margin 256） | `visibleNodes` 纯函数 + useMemo | §5.2 |
| 边索引：`Map<id, node>` + 预计算邻接表，渲染 O(可见边) | studio-view 渲染层 | §3.5 |
| 增量布局保存（dirty 集合） | 客户端，服务端零改动 | §9.4 |
| pointermove rAF 节流：一帧最多一次 setState | 手势层 | §10.3 |
| 拖动中的节点用 transform 临时位移，手势结束才写回 x/y | 手势层（可选优化） | §10.3 |
| `img loading:lazy` 保留 + 裁剪双保险 | 现状已有 | §5.2 |

### 10.3 手势渲染纪律

【设计决策】：pointermove 事件只更新 ref 里的最新指针位置，rAF 回调统一 setState（相机或节点坐标）——现状每个 pointermove 直接 setState（`:974,980`），高刷屏一帧多次渲染。拖动中的节点可选走 CSS transform 临时位移（不进 React state），pointerup 一次性写回坐标 + 进撤销栈 + 增量保存；此项若实现复杂度超预期可降级为「rAF 节流 + 批量 setState」，验收数字不变。

### 10.4 大板压测口径（目标，非实测）

【设计决策】验收数字（**全部标注为目标值，落地时实测回填，不宣称未测得的结论**）：

- 500 节点板，视口内 ~30 节点：连续平移 10 秒，帧率 ≥55fps（Chrome DevTools Performance 面板或 rAF 计数脚本测）；
- 1000 节点板：打开到首帧可交互 ≤300ms（含板 JSON fetch + 解析 + 首屏渲染）；
- 单节点拖动：pointermove 到画面更新 ≤1 帧；增量保存请求体 ≤1KB（单节点 dirty）；
- 边查找：构造 1000 节点 × 平均 2 parents，渲染耗时与节点总数无关（裁剪后只算可见边）——用纯函数基准断言（Node 侧计时，阈值宽松防抖）。

压测基建：新增 `verify/canvas-perf/`（脚本 + 记录 md），复用现有 preview 基建（`test/preview-frontend.mjs`/`test/preview-boards-shot.mjs` 存在，**其可复用程度未核实**，C15 执行时先读再定）。造数脚本生成 N 节点 fixture 板 JSON（含 parents 链），不依赖 GPU。

## 11. 设计面 9：Bug 修复与卫生

### 11.1 Bug1：面板生成血缘刷新即丢（DD15，口径已定）

**实锤**：面板路径 `recordItems` 硬编码 `parents: []`（`src/studio-service.ts:472`）→ 面板改图的边只存在于会话内存（前端从 references 的 nodeId 画边，`src/studio-view.ts:866-881`），刷新后从板重建时 parents 为空，边消失。对话工具路径经 `parentPaths` 正确持久化（`src/tools.ts:1208` → `src/boards.ts:576-588`）。

**修复口径（协调者已定，本设计照写）**：服务端 path→id 解析，复用 `boards.resolveParents`，**不改生成请求线缆契约**。具体：

- `src/studio-service.ts:458-474` 的条目构造中，**删除 `parents: []` 这一行**，改为 `parentPaths: input.references?.filter(r => typeof r.path === 'string' && r.path.length > 0).map(r => r.path)`。
- **必须删除而不是并存**：`resolveParents` 对显式 `parents` 优先（`src/boards.ts:577` `if (incoming.parents !== undefined) return [...incoming.parents]`）——留着 `parents: []` 会让 parentPaths 被短路，修复无效。这是本修复最容易踩的坑，写进 C01 步骤。
- 前端零改动：会话内边仍由 nodeId 即时画（体验不变），刷新后由持久化 parents 重建（修复生效）。

**口径核查结论：未发现硬伤**。两个边界如实记录（不是硬伤，是既有语义的自然延伸）：

1. **base64 上传的参考图**（`data` 通道，无 path）不产生血缘——它们本来就不是画板条目，无 id 可连；与对话工具路径语义一致。
2. **跨板参考**的 path 在目标板 resolveParents 匹配不到，静默丢弃（`src/boards.ts:104-107` 注释明写「缺边不失败」）——跨板血缘本期不持久化；§7.2 的跨板复制流让用户可以把参考图复制进当前板再改，作为产品层缓解。若未来要跨板边，需要边模型升级为跨板引用（DD4 的 parents 邻接表不支持），届时另立决策。

**测试**：新 `test/studio-lineage.test.mjs`——沿用 `test/comfyui-e2e.test.mjs` 假 ComfyUI 基建跑 `runStudioGeneration`（假服务端出图 → 真实 boards 落盘），断言：带 path 参考的面板生成后板条目 parents 含参考图条目 id；刷新语义（重读板文件）边仍在；base64 参考 parents 为空；跨板参考不失败 generation。`test/boards.test.mjs` 的 parentPaths 既有断言保留不动。

### 11.2 Bug2：素材去重恒 false

**实锤**：`referenceAsset` 去重判定 `entry.path === asset.path`（`src/studio-view.ts:1028`），但 `HeldReference` 接口（`:89-96`）**没有 path 字段**（path 在 `entry.payload.path`）→ `undefined === string` 恒 false → 同一素材可重复添加进参考图行。构建走 tsdown 无 tsc 类型检查，所以编译不报。`lib/client.js:1661` 带着同样的错（构建产物，修 src 后重建即消）。

**修复**【设计决策】：`entry.path` → `entry.payload.path`（一字之改）。顺带核查同型隐患：`referenceNode` 的去重用 `entry.nodeId === node.id`（`:997`）——nodeId 是 HeldReference 的合法字段，正确；`removeAsset` 的 `entry.payload.path === asset.path`（`:1079`）正确。全文件仅此一处。

**测试**：该逻辑在组件回调里，现状无 DOM 自动化——把去重判定抽成纯函数 `hasReference(references, key)`（C02 顺手做，放 studio-view 内导出或 canvas-interactions），新增纯函数断言；`lib/client.js` 重建后 grep 确认 `entry.path` 残留消失（机器判定）。

### 11.3 卫生任务（C03）

| 项 | 证据 | 处理 |
|---|---|---|
| 陈旧注释 TODO(moss-edit) | `src/comfyui.ts:1265-1266` 仍写「fill it in and this refusal disappears」，但 T19 已完成（`src/model-profiles.ts:918` moss imageToImage 在位，`verify/EXECUTION-PROGRESS.md:42`） | 删 TODO 段，注释改为「MOSS edit 已接线（T19）；无 imageToImage 的 profile 仍走此拒绝」——拒绝逻辑本身保留（它是通用护栏） |
| 文档旧口径「工作台在设置页」 | T17 已迁 main keyed panel（`src/studio-view.ts:5-18` 注释、`verify/EXECUTION-PROGRESS.md:35`），README/configuration 若仍有设置页口径则过时 | grep「设置页」「settings.section」相关表述，改为 main 面板口径；**README 定位措辞禁改**（D5 边界，只改事实性座位描述，不碰定位宣传语）；与 T22 文档改写重叠的部分标注「T22 终态核对」 |
| `src/studio-view.ts:20-27,99-105` 旧宣言 | D6 方向变更 | 随 C06 改写（不在 C03，避免同文件双任务） |

---

## 12. 设计面 10：技术路线（DD1）

### 12.1 结论

【设计决策】**扩展现有 DOM + CSS transform 方案，不引入 tldraw**。

### 12.2 依据

1. **相机数学已沉淀且测试覆盖**：screen/world 互逆、锚点缩放、钳位 no-op、pan 除 zoom、fit 居中、落位不重叠、边路径——9 个纯函数测试（`test/studio-canvas.test.mjs:28-106`）。tldraw 自带相机意味着这套资产作废重写，而本设计新增的交互（框选/对齐/裁剪/双坐标映射）全部可以沿用「纯函数 + 组件拿状态」的既有纪律（`src/studio-canvas.ts:9-11`）继续沉淀。
2. **bundle 体积**：现有代码宣言已量过 tldraw ≈1MB client 依赖（`src/studio-view.ts:22-24`）；宿主面板环境里插件 bundle 由 tsdown 打进 lib/client.js，1MB 级依赖对面板首屏是实打实的成本。本设计新增代码估算 <40KB（交互纯函数 + 任务节点 + 菜单 + 裁剪）。
3. **宿主环境约束**：面板跑在 DSH web client 的 slot 里，tldraw 的样式重置/字体/全局事件假设与宿主共存风险未验证；DOM 方案现状已验证共存（T17 实机）。
4. **需求匹配度**：D6 要的是「生成节点 + 血缘边 + 分支迭代」，不是自由绘图/手写笔/复杂图形编辑——tldraw 的核心能力（shape 系统、绘图工具、协作）本期用不到；用得到的（平移缩放/选择/对齐）自研成本已被 9 测试证明可控。
5. **布局节点集成**：mountLayoutEditor 是原生 DOM 组件（`src/layout-editor.ts:1069`），嵌进 DOM 节点是自然组合；嵌进 tldraw shape 需要 foreignObject/HTML shape 包装，pointerScale 问题（§8.2）反而更绕。

### 12.3 什么情况下需要重新评估（待决策点，不自行拍板）

若执行中出现以下任一信号，**停下汇报**，由协调者/用户决定是否引 tldraw（或 react-flow 类轻量方案）：

- 交互纯函数层（C08/C09）两次实现仍无法稳定通过手势验收（框选/多选拖动在 zoom≠1 下坐标漂移修不平）；
- 实测 500 节点平移帧率在裁剪 + rAF 节流后仍 <30fps（DOM 方案天花板证据）；
- 用户明确提出自由绘图/蒙版笔刷需求（超出 D6 范围，属新决策）。

对比备查：tldraw（≈1MB，全功能画布 SDK，相机/选择/对齐/撤销内置，但 shape 系统学习成本 + 宿主共存未验证 + 既有几何资产作废）；react-flow（节点图专用，血缘边天然匹配，但无框选/对齐/无限画布手感需补，且引入 React 依赖版本耦合——宿主 React 版本由 profile 决定，未核实）；自研扩展（本设计，增量成本最低，风险在交互手感需自己打磨）。**本设计评估结论：自研扩展足以达到 D6 体验，tldraw 非必需**——依据是上述 1–5，而非实测对比（未做原型对比，如实标注）。

## 13. 设计面 11：分阶段任务拆分（C01–C15）

体例与 EXECUTION-PLAN.md §4 任务书一致（目标/前置/写入范围/步骤/验收/停止条件六段式），供下一个工作者直接并入。**共同守则沿用执行计划 §9**：写入范围即权限边界；`npm test` 全绿是底线；同一构造两次改失败 → 停；权限拒绝 → 停；证据带 `文件:行号`。共同停止条件（各任务不再重复）：需要改写入范围外文件（哪怕一行）→ 停下汇报；需要安装新依赖 → 停；现状与本设计基线严重不符 → 按实际停下汇报差异。

**安全独占区**（执行计划内无任务触碰，可先行）：`src/studio-canvas.ts`、`src/boards.ts`、`src/client-styles.ts`、`src/studio-service.ts`、`test/studio-canvas.test.mjs`、`test/boards.test.mjs`。
**串行竞争面**：`src/studio-view.ts`、`src/studio-shared.ts`、`test/studio.test.mjs`、`docs/usage-reference.md` 与 T20 挂载（已被 C13 取代）、T22 竞争；`src/comfyui.ts`、`src/tools.ts`、`src/model-profiles.ts` 与 T21 竞争。

### 13.0 批次总览与建议顺序

| 批次 | 任务 | 并行性 | 说明 |
|---|---|---|---|
| A（先行，安全区） | C01 ∥ C05 ∥ C08 ∥ C03 | 四者写入范围完全不相交 | bug 修复与几何/交互纯函数层最先；C03 卫生只动注释与文档座位口径 |
| B | C04 ∥ C02 | boards/shared vs studio-view 不相交 | v2 迁移（升级用户丢板修复）与 Bug2（view 链首）并行 |
| C | C06 ∥ C10 | view vs 后端文件不相交（C10 的 shared 窗口需 C04 完成） | 渲染接线与任务节点后端关联链并行 |
| D | C07 → C09 | view 链串行 | 裁剪/索引 → 交互接线 |
| E | C11 → C12 → C13 | view 链串行；C12 的 boards/routes 部分可在 C10 后提前 | 任务节点前端 → 素材流 → 布局节点 |
| F | C14 | **外部前置 T21**；与 T21 共享文件须串行 | 布局闭环 |
| G | C15 | view 链末位；export 纯函数部分可提前并行 | 增量保存 + 导出 + 压测收口 |

studio-view.ts 串行链全序：**C02 → C06 → C07 → C09 → C11 → C12 → C13 → C14 → C15**（与 T22 的 stepper UI 窗口由协调者排程，T22 收口性质建议排 C15 后或按时间片错开）。

### C01 Bug1：面板生成血缘持久化

- **目标**：面板改图的血缘边刷新后仍在——服务端 path→id 解析（DD15 口径），不改生成请求线缆契约。
- **前置**：无。安全独占区（studio-service.ts），批次 A 先行。
- **写入范围**：`src/studio-service.ts`（:458-474 条目构造）、`test/studio-lineage.test.mjs`（新增）、`package.json`（仅 test 脚本加行，沿用 T01 先例）。**不改** studio-routes.ts / studio-shared.ts / studio-view.ts / boards.ts。
- **步骤**：
  1. 读 `src/boards.ts:576-588` resolveParents 与 `src/tools.ts:1200-1210` 对话路径用法，确认语义。
  2. `src/studio-service.ts:472` **删除 `parents: []`**，改 `parentPaths: input.references?.filter(r => typeof r.path === 'string' && r.path.length > 0).map(r => r.path)`（§11.1：必须删除而非并存，显式 parents 会短路 parentPaths）。
  3. 新测试沿用 `test/comfyui-e2e.test.mjs` 假 ComfyUI 基建：假服务端出图 → runStudioGeneration → 真实 boards 落盘 → 重读板文件断言 parents。
  4. 用例：path 参考 → parents 含参考条目 id；重读板（模拟刷新）边仍在；base64 参考 → parents 空且生成成功；跨板参考 path → 生成成功、parents 空（缺边不失败语义）。
- **验收（机器判定）**：`npm test` 全绿；新测试文件被 npm test 执行；上述 4 用例各有断言；`grep -n "parents: \[\]" src/studio-service.ts` 零命中；generate 请求/响应类型零 diff（`git diff src/studio-shared.ts` 为空）。
- **停止条件**：发现 resolveParents 语义与 §11.1 描述不符 → 停，汇报差异；假 ComfyUI 基建无法驱动 runStudioGeneration（需要真实 GPU）→ 停，汇报最小替代方案（如注入 fake adapter），不自行扩写入范围。

### C02 Bug2：素材去重字段修正

- **目标**：同一素材不再重复添加进参考图行（`entry.path` → `entry.payload.path`）。
- **前置**：无逻辑前置；studio-view.ts 串行链首（批次 B）。
- **写入范围**：`src/studio-view.ts`（:1028 一行 + 去重判定抽纯函数）、`test/canvas-interactions.test.mjs` 或 `test/studio.test.mjs`（纯函数断言；**优先新文件**避开 studio.test.mjs 竞争面，C08 会建该文件，若 C08 未开工则本任务自建）、`lib/`（构建产物重建）、`package.json`（仅 test 脚本行，若用新测试文件）。
- **步骤**：
  1. 修 `:1028`：`entry.path` → `entry.payload.path`。
  2. 去重判定抽纯函数 `hasReference(references: readonly {payload:{path?:string}; nodeId?:string}[], key: {path?:string; nodeId?:string}): boolean`（path 与 nodeId 双通道），referenceAsset/referenceNode 共用。
  3. 纯函数断言：同 path 二次添加被拒；同 nodeId 被拒；不同 path 放行；空 references 放行。
  4. `npm run build` 重建 lib，grep `lib/client.js` 确认 `entry.path` 残留消失。
- **验收（机器判定）**：`npm test` 全绿；4 条纯函数断言在案；`grep -c "entry\.path" lib/client.js` 为 0；`git diff src/studio-view.ts` 仅去重相关行（不夹带）。
- **停止条件**：发现第三处同型字段错误 → 一并列出汇报，只修写入范围内的；lib 重建失败 → 停，汇报构建错误原文。

### C03 卫生批：陈旧注释与文档座位口径

- **目标**：清掉已完成工作的 TODO 残留与过时座位描述（§11.3）。
- **前置**：无。批次 A 并行（comfyui.ts 只动注释，与 T21 的代码改动错开窗口；T21 未开始，先做无冲突）。
- **写入范围**：`src/comfyui.ts`（:1257-1271 注释段，**不改任何代码逻辑**）、`README.md`（仅座位事实句，**定位措辞禁改**，D5）、`docs/configuration.md`（工作台座位相关段）。
- **步骤**：
  1. comfyui.ts:1265-1266 TODO(moss-edit) 段改写为「MOSS edit 已接线（T19）；无 imageToImage 的 profile 仍走此拒绝」；requireEditGraph 逻辑与报错文案逐字节不动。
  2. grep README/configuration「设置页」「settings.section」「settings tab」相关表述，逐条核对是否座位口径（T17 已迁 main keyed panel），是则改为「侧边栏『图像工作台』全局面板」口径。
  3. 与 T22 文档改写重叠的段落在 commit message 标注「T22 终态核对」。
- **验收（机器判定）**：`npm test` 全绿；`git diff src/comfyui.ts` 仅注释行；`grep -n "TODO(moss-edit)" src/comfyui.ts` 零命中；README diff 不含定位宣传语（人工核对清单列进汇报）。
- **停止条件**：座位口径牵动 README 定位措辞（D5 禁区）→ 跳过该句，汇报留给 T22/用户；发现其他已完成 TODO 残留 → 列清单汇报，不扩范围顺手改。

### C04 board v2 模型与 v1→v2 迁移

- **目标**：节点 kind 字段 + 布局/失败任务条目类型 + 读时迁移（DD11），消除升级用户静默丢板。
- **前置**：无逻辑前置；批次 B。boards.ts/test/boards.test.mjs 属安全独占区；**studio-shared.ts 窗口与 T22 串行**（T20 挂载已被 C13 取代，无在途竞争）。
- **写入范围**：`src/boards.ts`（BoardFile/migrateBoardFile/readBoardFile/isBoardItem 按 kind 分支/GRID_PITCH_X 516）、`src/studio-shared.ts`（BoardItem 加法字段 + LayoutDraft 结构等价类型内联）、`test/boards.test.mjs`（网格间距断言更新 + 共享删文件护栏预留）、`test/board-migration.test.mjs`（新增）、`package.json`（仅 test 脚本行）。
- **步骤**：
  1. studio-shared.ts 加 `kind?/draft?/w?/h?/task?` 字段（§9.2），v1 字段语义零改动。
  2. boards.ts 实现 `migrateBoardFile` 纯函数（§9.3）：v1 逐条补 kind:'image'、version 置 2；v2 按 kind 分支校验（task 仅终态、layout 必有 draft、未知 kind 过滤）；其他 version 拒绝。readBoardFile 改调它，读不写盘。
  3. `GRID_PITCH_X` 244→516（DD16）；gridSpot 逻辑不变。
  4. 迁移测试：v1 fixture 逐字段保留（id/坐标/parents/batchId）、幂等、坏条目过滤不整板丢、version 0/3/缺失拒绝、v1 板经 saveLayout 后磁盘 version===2。
  5. 既有 18 存储测试逐条核对：同路径合并且坐标 id 不动/3 列网格（**期望值更新为 516 间距**）/layout+camera 往返/移除可逆/删文件双护栏/并发写/坏文件隐藏单板/id 防穿越/parentPaths——除网格期望值外全部原样保留。
- **验收（机器判定）**：`npm test` 全绿；迁移测试 ≥6 用例；v1 fixture 迁移后逐字段 diff 为空（除 kind/version）；`grep -n "BOARD_VERSION = 2" src/boards.ts` 命中；未迁移读路径无 writeFile 调用（代码审查断言）。
- **停止条件**：发现 v1 板文件实际字段与 BoardItem 类型不符（历史脏数据）→ 按宽松校验哲学过滤该条并汇报样本；迁移函数两次构造失败 → 停，汇报文件/构造/verbatim 错误。

### C05 几何 D8：宽高比保真纯函数层

- **目标**：节点显示尺寸按原图比例（DD3），几何常量与测试同步更新——纯函数 + 样式层，不动 view。
- **前置**：无。安全独占区，批次 A 先行。
- **写入范围**：`src/studio-canvas.ts`（nodeDisplaySize/MIN/MAX/IMAGE_AREA_HEIGHT 常量、CANVAS_NODE_WIDTH 语义注释改兜底）、`src/client-styles.ts`（:92-94 节点宽内联化 + img contain）、`test/studio-canvas.test.mjs`（新增尺寸断言 + 既有断言核对）。
- **步骤**：
  1. 实现 `nodeDisplaySize(width, height)`：高 200 固定，宽 round(200×w/h) 钳 [96,480]；非法尺寸（0/负/NaN）回落 208×240。
  2. 七档比例逐档断言：1:1→200、4:3→267、3:4→150、3:2→300、2:3→133、16:9→356、9:16→113（§3.4）。
  3. 钳制断言：极端长图（10000×100）→ 宽 96；极端宽图（100×10000）→ 宽 480。
  4. CSS：`.dsh-forge-node` 去掉固定 width（改由内联 style 提供，C06 接线）；img `object-fit:contain`。
  5. 既有 9 测试核对：本任务**不改 zoom 常量**（zoom 放开在 C06，与 view 接线同批，避免钳位测试改两次）；edgePath/nextNodeSpot/fit 测试吃 Rect，不受影响。
- **验收（机器判定）**：`npm test` 全绿；七档 + 钳制 + 非法尺寸 ≥10 条新断言；`grep -n "object-fit:cover" src/client-styles.ts` 在 `.dsh-forge-node img` 规则零命中（其余 cover 用法如素材缩略图不动）。
- **停止条件**：发现 nodeDisplaySize 与服务端网格需要共享但 import 方向有问题（boards.ts import studio-canvas.ts 的循环依赖）→ 停，汇报依赖图（studio-canvas 无 import，预期无环）。

### C06 画布渲染接线：变宽节点 + zoom 放开 + 宣言改写

- **目标**：D8 在画布上真正生效；zoom 0.1–4（DD8）；旧「节点=结果」宣言注释按 D6 改写。
- **前置**：C05、C02（view 链）。串行竞争面：studio-view.ts。
- **写入范围**：`src/studio-view.ts`（nodeRect 按 kind/尺寸计算、节点内联宽、zoom 常量引用处、:20-27 与 :99-105 注释改写）、`src/studio-canvas.ts`（CANVAS_MIN_ZOOM 0.1 / CANVAS_MAX_ZOOM 4）、`test/studio-canvas.test.mjs`（钳位边界断言更新）。
- **步骤**：
  1. `nodeRect` 改调 `nodeDisplaySize(node.image.width, node.image.height)`；节点 div 内联 `width`；img 高度 200 不变。
  2. zoom 常量改 0.1/4；钳位测试边界值同步（0.3/2.5 的旧断言改新边界，no-op 语义保留）。
  3. 注释改写：:20-27「Deliberately not ported」段更新为 D6 口径（tldraw 仍不引入，理由见 CANVAS-DESIGN §12；「节点=结果」宣言改为「节点=图片/任务/布局，血缘边持久化」）；:99-105 CanvasNode 注释同步。
  4. 生成落图路径（:871-885）核对：nextNodeSpot 吃实际 Rect，变宽后自动正确，不改逻辑。
- **验收（机器判定）**：`npm test` 全绿；钳位测试断言含 0.1/4；`grep -n "CANVAS_NODE_WIDTH" src/studio-view.ts` 仅剩兜底用途（task/未知尺寸）；实机抽查一张 16:9 与一张 9:16 结果节点无裁剪（截图存 verify/canvas-d8/，人工核对项如实标注）。
- **停止条件**：变宽后选中动作条/meta 排版破版且 CSS 两次修不平 → 停，汇报破版截图与构造；发现第三处隐藏固定宽假设 → 列清单汇报。

### C07 视口裁剪 + 边索引 + 手势节流

- **目标**：渲染成本与板大小解耦（§5.2、§10）。
- **前置**：C06（view 链）。
- **写入范围**：`src/studio-canvas.ts`（visibleNodes/rectsIntersect/边包围盒相交纯函数）、`src/studio-view.ts`（渲染层裁剪 + Map 索引 + 邻接预计算 + rAF 节流）、`test/studio-canvas.test.mjs`（裁剪纯函数断言）。
- **步骤**：
  1. 纯函数：可见矩形（camera + viewport/zoom + margin 256）、节点相交判定、边渲染判定（任一端可见或包围盒相交）。
  2. 渲染层：`useMemo` 建 `Map<id, node>` 与邻接表；边渲染改查 Map（消灭 :1679-1680 的 nodes.find）；节点/边都过裁剪。
  3. pointermove 改 rAF 节流（§10.3）：ref 存最新指针，rAF 统一 setState；手势结束语义（endGesture/scheduleLayout）不变。
  4. 测试：裁剪边界（节点恰在 margin 边缘）、边两端在外但穿视口、空板、zoom 极值（0.1/4）下可见集正确。
- **验收（机器判定）**：`npm test` 全绿；裁剪纯函数 ≥6 断言；`grep -n "nodes.find" src/studio-view.ts` 渲染路径零命中；1000 节点 fixture 下渲染节点数 === 可见集大小（纯函数断言，不依赖浏览器）。
- **停止条件**：rAF 节流与 pointer capture 语义冲突（手势丢失）两次修不平 → 停，汇报手势状态机构造；裁剪导致框选/定位回归（C09 未开工，本任务自测基础手势）→ 停。

### C08 交互纯函数层

- **目标**：框选/多选/对齐分布/撤销栈/快捷键映射全部沉淀为可单测纯函数（§6），沿用 studio-canvas 模式。
- **前置**：无。安全独占区（新文件），批次 A 先行，与 C01/C05/C03 并行。
- **写入范围**：`src/canvas-interactions.ts`（新增）、`test/canvas-interactions.test.mjs`（新增；若 C02 已建则追加）、`package.json`（仅 test 脚本行）。
- **步骤**：
  1. 选择模型：`toggleSelection(set, id, additive)`、`nodesInRect(nodes, worldRect)`、`selectionBounds(rects)`。
  2. 框选几何：屏幕矩形 → 世界矩形（复用 screenToWorld）、`rectsIntersect`（若 C07 已放 studio-canvas 则 import，不重复实现——执行时按先到者为准，汇报里写明落点）。
  3. 多选拖动：`moveSelection(origins, screenDelta, zoom)` 返回 id→新坐标表。
  4. 对齐分布：`alignNodes(rects, mode)` 6 模式、`distributeNodes(rects, axis)` 中心等距（首尾不动）。
  5. 撤销栈：`CommandStack`（push/undo/redo/cap 100，命令 = {apply, revert} 纯数据或函数对），相机/生成不入栈的约束由调用方保证，栈本身不判类型。
  6. 快捷键映射表：`resolveShortcut(key, mods, context)` → 动作枚举（context 区分 canvas/输入框/编辑器，§6.3 让位规则）。
- **验收（机器判定）**：`npm test` 全绿；每族 ≥4 断言（含 zoom≠1 下框选命中、多选拖动位移除 zoom、对齐包围盒基准、分布首尾不动、栈 cap/undo/redo 边界、输入框 context 让位）；模块零 DOM 依赖（Node type-stripping 直接 import 成功即证明）。
- **停止条件**：与 C07 的 rectsIntersect 落点冲突 → 以先提交者为准，后到者 import，不重复实现；撤销栈命令形态两次设计失败 → 停，汇报构造。

### C09 交互接线：多选/框选/快捷键/右键/撤销重做/对齐

- **目标**：C08 纯函数接进画布，§6 全部交互落地。
- **前置**：C08、C07（view 链）。
- **写入范围**：`src/studio-view.ts`（selection 状态替换 selectedNodeId、手势联合扩展、键盘/右键监听、对齐工具条、撤销栈实例）、`src/client-styles.ts`（框选矩形/菜单/多选高亮样式）、`test/studio.test.mjs`（**仅新增**交互相关断言，既有 SSE/线缆断言不动；与 T22 串行）。
- **步骤**：
  1. `selectedNodeId` → `selection: Set<string>`；既有引用点（选中动作条/定位/移除）逐个迁移，单选语义 = 选择集大小 1。
  2. 手势：空白默认框选（**变更现状平移默认**，§6.6）、Space/中键平移、多选批量拖动；全部走 C08 纯函数。
  3. 键盘：canvas tabIndex=0 + resolveShortcut 分发；Del 移除走现有 removeNode（unplace 语义）；Ctrl+Z/Y 接 CommandStack；移动/对齐/移除/添加进栈。
  4. 右键菜单：按 kind 分菜单（§6.4），屏幕空间 DOM；本期 task/layout 菜单项先占位（节点类型 C11/C13 才出现），image/空白菜单全量。
  5. 对齐分布工具条：选择 ≥2/≥3 时出现，结果批量移动进栈 + scheduleLayout。
  6. usage 文档口径变更（空白拖动=框选）记入汇报，docs/usage-reference.md 的更新留给 C15 统一做（避开竞争面碎片化）。
- **验收（机器判定）**：`npm test` 全绿；既有 SSE 6 测试与线缆断言零改动通过；新增断言覆盖选择/快捷键分发/菜单项生成（纯函数层）；实机抽查清单（框选/多选拖动/撤销重做/右键/Del）逐项截图或录屏存 verify/canvas-interact/（人工核对项如实标注「无自动化，人工抽查」）。
- **停止条件**：pointer capture 与框选/多选手势冲突两次修不平 → 停，汇报手势状态机；右键菜单与宿主全局菜单冲突 → 停，汇报宿主事件面。

### C10 任务节点后端关联链（clientId + run 注册表 + SSE 扩展）

- **目标**：DD7 四步接线落地，SSE 事件可关联到面板发起的 run；向后兼容。
- **前置**：C01（studio-service.ts 串行）、C04（studio-shared.ts 串行）、C03（comfyui.ts 注释窗口先过）。**comfyui.ts 代码窗口与 T21 串行**（T21 未开始，先做；若 T21 已开工则协调者排程）。
- **写入范围**：`src/studio-shared.ts`（StudioGenerateRequest + clientId?、StudioProgressEvent + clientId?/boardId? + run 事件）、`src/studio-routes.ts`（generate parse 收 clientId、字符集/长度校验）、`src/studio-service.ts`（提交前登记注册表、onPromptId 接线、结束清理）、`src/comfyui.ts`（ComfyOptions + onPromptId? 钩子，:1186 处回调）、`src/runs.ts`（新增，内存注册表 + TTL）、`src/progress.ts`（归一化后附加 clientId/boardId、登记时发 run 事件）、`test/progress.test.mjs`（附加断言）、`test/studio.test.mjs`（线缆向后兼容断言）、`test/runs.test.mjs`（新增）、`package.json`（仅 test 脚本行）。
- **步骤**：
  1. runs.ts：`registerRun(promptId, {clientId, boardId})` / `lookupRun(promptId)` / TTL 5min 清理；纯内存、可单测（注入时钟）。
  2. comfyui.ts：ComfyOptions 加可选钩子，/prompt 返回处回调；**不给钩子时注入图与请求序列逐字节不变**（回归断言）。
  3. studio-service.ts：解析 input.clientId → 提交时经钩子登记 → 响应返回/抛错后延迟清理；boardId 用目标板解析结果（:456-457）。
  4. progress.ts：归一化事件查注册表附加字段；登记时向 SSE  subscribers 发 run 事件（沿用现有广播通道）。
  5. 线缆：generate parse 接受可选 clientId（`c` + base36，≤32 字符，仿 board id 护栏哲学）；畸形 clientId 拒绝或丢弃（二选一写进断言，倾向拒绝——与畸形坐标逐条丢弃的 layout 语义区分：clientId 是单值字段，畸形即 400）。
  6. 向后兼容断言：不带 clientId 的请求行为与现状逐字节一致；旧事件形状（无 clientId）reducer 行为不变；未知 run 事件类型走 default 分支。
- **验收（机器判定）**：`npm test` 全绿；runs 注册表 ≥5 断言（登记/查询/TTL/清理/未知 promptId）；progress 附加断言（有注册附加、无注册不附加）；线缆兼容断言（旧请求体通过、新字段可选、畸形拒绝）；comfyui 默认路径逐字节回归；`git diff src/tools.ts` 为空（对话路径零改动）。
- **停止条件**：ComfyOptions 钩子位置发现 /prompt 提交有多条路径（turbo/edit 分叉）需要多处回调 → 列全路径清单再动，漏一条即关联失败；progress.ts 广播通道无法注入 run 事件 → 停，汇报通道构造。

### C11 任务节点前端：占位/进度/失败重试/原地转换

- **目标**：D6 核心体验——生成即节点（§4 全部）。
- **前置**：C10、C09（view 链）。
- **写入范围**：`src/studio-view.ts`（CanvasNode 联合扩展、startGeneration 动作、任务节点渲染、reduceTaskEvent、重试/编辑参数、完成转换 DD5）、`src/client-styles.ts`（任务节点样式：进度条/状态色/参数摘要）、`test/studio.test.mjs`（任务 reducer 断言，沿用自制 hook runtime + 假 EventSource 基建）、`test/studio-canvas.test.mjs`（task 节点尺寸兜底断言）。
- **步骤**：
  1. CanvasNode 扩联合（§3.3）；task 节点固定 208×240（C05 兜底宽）。
  2. startGeneration：clientId 生成 → 任务节点落位（nextNodeSpot）→ 移相机可见 → POST 带 clientId；表单/右键/布局三入口汇聚（布局入口 C13 才接，本任务留函数签名）。
  3. reduceTaskEvent 纯函数：idle→queued（run 事件）→running（start/progress）→done/failed/interrupted；queue 帧回推约束沿用（§4.2）；全局状态栏 reducer 不动。
  4. 完成转换（DD5）：响应 images → 首张原地替换（id 换条目 id、parents 移交）、其余向右扇出；scheduleLayout。
  5. 失败节点：原因首行 + 重试（params 原样重发、新 clientId 原地替换）+ 编辑参数重发（回填表单）；失败/中断终态经 board layout 通道落盘（kind:'task'，依赖 C04 v2；**落盘走新 board action 'save-task'**——封闭集第 9 个 action，路由校验同步；或复用 layout 通道扩展条目字段，执行时二选一汇报，倾向独立 action：语义清晰、校验独立）。
  6. 运行中任务节点不落盘（DD6）；刷新后失败节点从板重建、可重试。
  7. reducer 测试：假 EventSource 注入 run/start/progress/done/error 序列，断言节点状态迁移与转换后位置/parents；无 clientId 事件不影响任务节点。
- **验收（机器判定）**：`npm test` 全绿；reducer ≥8 断言（含 queue 不回推、done 转换 id/位置/parents、failed 重试新 clientId、无关联事件隔离）；既有 SSE 6 测试行为断言保留；实机一单生成全程（占位→进度→结果原地）截图存 verify/canvas-task/（人工核对项如实标注）。
- **停止条件**：SSE run 事件与 POST 响应竞态（done 事件先于响应到达）两次修不平 → 停，汇报时序构造（设计预案：以 POST 响应为转换权威，done 事件只推状态，转换等响应——若预案也不平再停）；save-task action 与封闭集测试冲突面扩大 → 汇报裁决。

### C12 素材双向流：拖入/跨板复制移动/外部文件/定位移相机

- **目标**：§7 全部落地。
- **前置**：C04（boards v2）、C10（routes 串行）、C11（view 链）。boards.ts API 部分可在 C10 后提前与 view 链并行。
- **写入范围**：`src/boards.ts`（copyItem/moveItem/删文件共享护栏）、`src/studio-shared.ts`（BoardRequest + copy-item/move-item、import 请求/响应类型、STUDIO_IMPORT_ROUTE 常量）、`src/studio-routes.ts`（board action 封闭集 6→8：copy-item/move-item；import 是独立路由不占 action；readBody 上限参数化）、`src/studio-view.ts`（素材卡片 draggable、画布 onDragOver/onDrop、定位 centerOn、Ctrl+C/V）、`src/studio-canvas.ts`（centerOn 纯函数）、`test/boards.test.mjs`（copy/move/共享护栏断言）、`test/studio.test.mjs`（新 action 线缆 + import 路由断言）、`test/studio-canvas.test.mjs`（centerOn 断言）。
- **步骤**：
  1. boards.ts：copyItem（新 id、同文件、parents 复制）/moveItem（保留 id、先写目标后删源）在 serialized 队列内；removeItem deleteFile 前扫他板引用，被共享则拒删只 unplace（§7.2）。
  2. 路由：parseBoardAction 扩 copy-item/move-item（逐字段校验：toBoard 必填、坐标有限性沿用 parsePosition）；import 路由（同源/sniff 白名单/32MB/独立 body 上限）→ writeImages → recordItems。
  3. 前端：素材卡 draggable + 自定义 MIME；画布 drop 分流（forge-asset 同板移动/跨板 copy，Alt=move；OS 文件 → import）；落点 screenToWorld；定位按钮接 centerOn。
  4. 测试：copy 后两板条目同 path 不同 id、move 后源板无目标板有且 id 不变、共享文件删文件被拒、import 畸形/超限/非白名单拒绝、centerOn 居中数学。
- **验收（机器判定）**：`npm test` 全绿；boards 新断言 ≥6；线缆封闭集断言更新为当时的实际 action 集（copy/move 后为 8；C11 的 save-task 若已落地则 9，§14.3）；import 拒绝路径 ≥4 断言；既有删文件双护栏测试保留通过。
- **停止条件**：move 两板写原子性无法在现有队列语义内保证 → 按「先目标后源」降级方案落地并汇报窗口风险；import 的 writeImages 命名与现有前缀冲突 → 停，汇报命名方案。

### C13 布局节点：mountLayoutEditor 嵌进画布（取代 T20 挂载）

- **目标**：D7 布局节点落地（§8.1–8.3、8.5），双坐标映射 + pointerScale 修正。
- **前置**：C04（v2 kind:'layout'）、C06（变宽渲染）、C11（view 链）。layout-editor.ts 所有权自 T20 移交（核心已提交，无在途冲突）。
- **写入范围**：`src/layout-editor.ts`（LayoutEditorOptions + pointerScale?、mount 内 delta 换算除 scale，**纯函数层与 14 测试语义零改动**）、`src/studio-view.ts`（layout 节点渲染/标题栏拖拽/resize 手柄/编辑器挂载与销毁/键盘让位）、`src/client-styles.ts`（布局节点样式）、`test/layout-editor.test.mjs`（pointerScale 默认行为回归 + delta 换算纯函数断言）、`test/studio.test.mjs`（layout 节点落盘/重建断言）。
- **步骤**：
  1. layout-editor.ts：抽「屏幕 delta → draft delta」为纯函数（含 scale 参数），mount 内调用处传 `pointerScale()`（默认 1）；14 个既有测试逐字节回归必须原样通过。
  2. 节点容器：标题栏（拖拽手柄 + 生成按钮占位）+ 编辑器 element；useEffect 挂载/destroy（节点卸载/板切换必须 destroy，防泄漏）；draft 经 onChange 写回节点状态 + 防抖落盘（v2 layout 条目，走 save-task 同型的 'save-layout-node' action 或 layout 通道扩展——与 C11 步骤 5 的裁决保持一致，汇报写明）。
  3. 双坐标映射验证：zoom 0.5/1/2 下画框/移动/resize 的 draft 坐标正确（pointerScale 生效）；resize 节点宽后 getCompiled() 逐字节不变（§8.2 不变量，测试断言）。
  4. 手势边界：编辑器区域 stopPropagation、键盘让位、滚轮不拦截（§8.3）。
  5. 空白右键「新建布局节点」落地（C09 占位项激活）；默认 draft 1536×1024（DEFAULT_LAYOUT_*，layout-editor.ts:66-67）。
- **验收（机器判定）**：`npm test` 全绿；14 个布局回归测试零改动通过；compiled 不变量断言（resize 前后逐字节相等）；pointerScale delta 断言 ≥3（zoom 0.5/1/2）；实机 zoom≠1 画框一单截图存 verify/canvas-layout/（人工核对项如实标注）。
- **停止条件**：mount 内 delta 换算点分散两次改不平 → 停，汇报构造（预期集中在 pointermove 处理）；编辑器 destroy 与 React 严格模式双挂载冲突 → 停，汇报生命周期构造。

### C14 布局闭环：布局节点 → 生成 → 结果回画布（依赖 T21）

- **目标**：§8.4 完整闭环；T21 落地前过渡路径（发送到表单）在 C13 已可用，本任务做完整路径。
- **前置**：**T21 完成**（外部依赖：MOSSImageLayoutPrompt/MOSSImageControl 接线 + 布局入参契约）+ C13。与 T21 共享 comfyui.ts/tools.ts/model-profiles.ts 的窗口必须串行；GPU 实机验收与 T21/T22 互斥排程。
- **写入范围**：`src/studio-shared.ts`（StudioGenerateRequest + layout? 可选字段，形状以 T21 定的契约为准）、`src/studio-routes.ts`（layout 透传校验）、`src/studio-service.ts`（layout 传给适配器）、`src/studio-view.ts`（布局节点生成按钮激活、ratio 最近档映射与提示、任务节点 parents 含布局 id）、`test/studio.test.mjs`（layout 线缆断言）、`docs/usage-reference.md`（布局闭环用法；与 T22 串行）。
- **步骤**：
  1. 读 T21 落定的布局入参契约（compiled JSON 字符串 + 尺寸），Studio 侧透传形状对齐，不另造格式。
  2. 布局节点生成：getCompiled() + summary.caption → startGeneration（params.layout）；ratio 取 draft 比例最近七档，不在七档时提示选择/改 draft（§8.4，不静默拉伸）。
  3. 任务节点 parents 含布局节点 id；完成转换后边持久化（布局节点是 v2 条目，parents 引用合法）。
  4. 无 layout 请求回归：注入图与响应逐字节不变（T21 已有此断言，Studio 侧补线缆层）。
  5. 实机一单「画框→出图→结果回画布→改框→再生成」星形血缘验收（GPU 互斥）。
- **验收（机器判定）**：`npm test` 全绿；无 layout 回归断言；带 layout 请求透传断言（假服务端收到 T21 契约形状）；实机产物 + 血缘截图存 verify/canvas-layout-loop/（seed/prompt/版本在案）。
- **停止条件**：T21 未开始/未完成 → 本任务挂起，不提前动共享文件；T21 契约与 compiled 格式不符 → 停，汇报差异（以 verify/ 样本为格式权威）；布局 + 改图叠加行为未定义 → 只支持 t2i+布局，叠加场景汇报待决策（沿用 T21 停止条件口径）。

### C15 增量保存 + 导出 + 压测收口

- **目标**：DD12/DD14 落地 + §10.4 压测口径实测回填；usage 文档统一更新。
- **前置**：C07（裁剪）、C09（交互）；view 链末位。export 纯函数部分（contactSheetLayout）可提前并行（新文件无冲突）。
- **写入范围**：`src/studio-view.ts`（dirtyIds 增量保存、导出入口）、`src/canvas-export.ts`（新增：contactSheetLayout 纯函数 + 画板 JSON 序列化）、`test/canvas-export.test.mjs`（新增）、`verify/canvas-perf/`（压测脚本 + 记录 md）、`docs/usage-reference.md`（画布交互/快捷键/素材流/布局节点/导出口径统一更新；与 T22 串行）、`package.json`（仅 test 脚本行）。
- **步骤**：
  1. 增量保存：dirtyIds 集合（移动/resize/新增加入），防抖到期只发 dirty + 相机（变化才发），发送后清空；700ms 防抖与 unmount flush 保留；服务端零改动。
  2. 导出：画板 JSON Blob 下载；拼版 PNG（offscreen canvas + studioFileUrl 同源加载 + toBlob），contactSheetLayout 纯函数（网格/缩略图/标注位），≤200 张/256px 上限，失败图位灰块不中断。
  3. 压测：造数脚本生成 500/1000 节点 fixture 板（含 parents 链）；复用 preview 基建（先读 test/preview-frontend.mjs 评估可复用性，不可复用则独立脚本）；测 §10.4 四项数字，**实测值回填 verify/canvas-perf/README.md，目标值与实测值分列**。
  4. usage 文档：空白拖动=框选（C09 变更）、快捷键表、素材拖入/跨板/外部文件、布局节点、导出、撤销会话级口径。
- **验收（机器判定）**：`npm test` 全绿；增量保存断言（子集请求不动其他条目、相机变化才发）；contactSheetLayout ≥4 断言；压测记录 md 含四项实测数字与测试环境（机器/浏览器/板规模）；**达标判据：500 节点平移 ≥55fps、1000 节点首帧 ≤300ms——未达标不阻塞提交，但必须如实记录并汇报差距**（性能调优另立任务，不在本任务内无限迭代）。
- **停止条件**：preview 基建不可复用且独立压测脚本需要新依赖 → 停，汇报最小方案；拼版 PNG 出现 canvas taint（同源假设被破坏）→ 停，汇报 file 路由响应头；usage 文档与 T22 改写窗口冲突 → 协调者排程，不抢写。

## 14. 设计面 12：测试策略

总原则：**既有契约默认保留，显式变更逐条列出**；交互逻辑抽纯函数可测（沿用 studio-canvas.ts 模式，指针手势无自动化的现状不假装解决）；实机/人工核对项如实标注，不宣称未测得的观感。

### 14.1 几何 9 测试（test/studio-canvas.test.mjs:28-106）——D8/zoom 显式变更

| 测试（行号） | 处置 | 变更内容 |
|---|---|---|
| screen/world 互逆（:28） | **保留** | 数学不变；若用例取 zoom 边界值 0.3/2.5 则改 0.1/4 |
| 锚点缩放（:39） | **保留** | zoomAt 逻辑不动 |
| 钳位 no-op（:50） | **显式变更**（C06） | 边界断言 0.3/2.5 → 0.1/4，no-op 语义保留 |
| pan 除 zoom（:59） | **保留** | |
| fit 居中（:65） | **保留** | fitCamera 吃 Rect，变宽自动正确；zoom 钳位放开后大板 fit 不再被截断（可加新断言） |
| 空板 fit 不动（:86） | **保留** | |
| 落位不重叠（:90） | **保留** | nextNodeSpot 吃实际 Rect |
| 边 M/C 路径（:98） | **显式变更**（C06） | 固定 208 宽的期望路径改为按 nodeDisplaySize 计算的宽；edgePath 函数本身不动 |
| zoom 整百分比（:106） | **保留** | |

新增：nodeDisplaySize 七档/钳制/非法尺寸（C05）、visibleNodes 裁剪（C07）、centerOn（C12）、task 节点尺寸兜底（C11）。

### 14.2 存储 18 测试（test/boards.test.mjs）——迁移/网格/共享护栏

| 契约 | 处置 |
|---|---|
| 同路径合并且坐标 id 不动 | **保留**（recordItems 语义不动） |
| 3 列网格落位 | **显式变更**（C04）：GRID_PITCH_X 244→516（DD16），期望坐标同步；列数/原点/行数语义不变 |
| layout+camera 往返 | **保留**；新增「子集保存不动其他条目」断言（C15，服务端语义已如此，补守护） |
| 移除可逆 / 删文件双护栏 | **保留**；新增共享文件拒删断言（C12） |
| 并发写队列 | **保留**；copy/move 入同一队列语义（C12 新增断言） |
| 坏文件隐藏单板 | **保留**；迁移后语义不变（version 0/3/缺失仍整板忽略） |
| id 防穿越 | **保留**（assertBoardId 不动） |
| parentPaths 解析 | **保留**（resolveParents 零改动；Bug1 修复在 service 层，新测试文件覆盖） |

新增：test/board-migration.test.mjs（C04，v1 逐字段保留/幂等/坏条目过滤/版本拒绝/lazy 落盘）；copy/move/共享护栏（C12）。

### 14.3 线缆与 SSE（test/studio.test.mjs）

| 契约 | 处置 |
|---|---|
| 请求体收窄（:73-203） | **保留 + 加法**：clientId 可选（C10）、layout 可选（C14）；**向后兼容断言**：不带新字段的请求体行为与现状逐字节一致；畸形 clientId 拒绝 |
| board action 封闭集 | **显式变更**：6 → 8（copy-item/move-item，C12）→ 9+（save-task/save-layout-node，C11/C13 裁决后定数）；未知 action 仍拒绝 |
| 畸形坐标逐条丢弃 | **保留**（parsePosition 不动） |
| SSE 渲染 6 测试（:1219-1398，自制 hook runtime + 假 fetch/EventSource） | **行为断言全部保留**；新增：事件带 clientId/boardId 附加字段、run 事件推进任务节点、无关联事件不影响任务节点（C10/C11）；旧事件形状（无新字段）reducer 行为不变 |
| 面板座位（settings.test.mjs:259-304,1229-1241，main keyed + panellist 双注册） | **保留不动**（本设计不改座位） |

新增路由断言：import 同源/白名单/32MB/畸形 base64 拒绝（C12）；copy/move 逐字段校验（C12）。

### 14.4 布局与进度桥

- 布局 14 测试（test/layout-editor.test.mjs）：**compiled 对 verify/ 8 对样本逐字节回归零改动保留**（C13 的 pointerScale 是 mount 层加法，纯函数层不动）；新增 delta 换算纯函数断言与「resize 节点 compiled 不变」不变量断言。
- 进度桥 7 测试（test/progress.test.mjs）：**归一化契约保留**；新增注册表附加断言（有注册附加 clientId/boardId、无注册不附加、run 事件发出）（C10）。
- 对话工具路径（tools.ts）：**零改动**，其既有测试全部保留（C10 验收含 `git diff src/tools.ts` 为空）。

### 14.5 新增测试与「手势无自动化」的诚实口径

新增文件：test/studio-lineage.test.mjs（C01）、test/board-migration.test.mjs（C04）、test/canvas-interactions.test.mjs（C02/C08）、test/runs.test.mjs（C10）、test/canvas-export.test.mjs（C15）。

指针手势（框选拖拽/多选拖动/节点 resize/编辑器画框）**维持无 DOM 自动化现状**（`verify/EXECUTION-PROGRESS.md:54` 已记录 T20 同样口径）——策略是把全部坐标换算/命中判定/状态迁移抽纯函数单测（C08 模式），DOM 接线层用实机抽查清单 + 截图/录屏证据（verify/canvas-*/），汇报里如实标「人工抽查，无自动化」。不引入 Playwright 类新依赖（共同停止条件：需要安装新依赖 → 停）。

---

## 15. 待决策点、与 brief 不符的发现、未核实项

### 15.1 待用户/协调者决策点

| # | 事项 | 本设计立场 | 需要谁拍板 |
|---|---|---|---|
| 1 | 空白处直接拖动：现状=平移，本设计改=框选（Space/中键平移保留） | 改（生成画布惯例，框选频率高于平移） | 用户手感偏好，C09 前可推翻 |
| 2 | 失败任务节点落盘走独立 board action（save-task）还是扩展 layout 通道 | 倾向独立 action（语义清晰） | 协调者（C11 执行时裁决，封闭集测试同步） |
| 3 | 跨板血缘不持久化（resolveParents 板内语义） | 接受现状 + 跨板复制缓解 | 若用户要跨板边，需升级边模型，另立决策 |
| 4 | tldraw 重新评估触发条件（§12.3） | 自研扩展足以达 D6，未做原型对比 | 触发信号出现时由协调者/用户拍板，本设计不自行引入 |
| 5 | 小地图、画板 JSON 导入、text 节点 | 本期不做，留扩展点 | 用户后续立项 |
| 6 | C14 与 T21 的契约对齐顺序 | T21 先定布局入参契约，C14 透传 | 协调者排程（T21 未开始） |

### 15.2 与 brief 不符的发现（按实际写，已核实）

1. **「外部文件 drop 上传走既有 asset 路由」不成立**：studio-routes.ts 无任何上传路由（assets 是 GET 查询 :300-315，file 是只读流 :317-332，board body 上限 256KB :247）。本设计改为新增 STUDIO_IMPORT_ROUTE（DD10，§7.3），这是新增契约而非复用，工作量与测试面已计入 C12。
2. **brief 引「studio-view.ts:1325 一处 onKeyDown」**：核实为 :1325-1328（重命名输入框 Enter/Esc），语义一致，行号微调。
3. 其余 brief 所列现状（架构/数据模型/出图链路/两 bug/SSE/素材页/缺失能力/布局编辑器/测试契约/执行进度/冲突面）**逐条抽查核实，无实质出入**。Bug1 服务端解析口径核查无硬伤（两个边界见 §11.1）。

### 15.3 未核实项（如实标注，不编造）

- preview 基建（test/preview-frontend.mjs / preview-boards-shot.mjs）对压测的可复用程度——只确认文件存在，未读内容；C15 先读再定。
- 宿主 web client 的 React 版本与全局事件面（右键菜单/快捷键是否与宿主冲突）——C09 实机抽查时验证。
- tldraw/react-flow 对比为静态评估，未做原型实测（§12.3 已标注）。
- 性能数字（55fps/300ms 等）全部是**目标值**，实测回填 C15。
- ComfyUI `/prompt` 提交路径是否全部经过 :1186 单一回调点（turbo/edit 分叉）——C10 步骤 2 执行时核全路径，漏一条即关联失败（已列停止条件）。
- lib/client.js:1661 的 Bug2 残留行号引自 brief，本会话未逐行核对 lib 产物（src 层 :1028 已实锤）；C02 重建后 grep 验证。

---

## 16. 与 T20/T21/T22 的冲突矩阵补充（并入 EXECUTION-PLAN §7 时用）

| 文件 | 涉及任务 | 裁决 |
|---|---|---|
| `src/studio-view.ts` | C02→C06→C07→C09→C11→C12→C13→C14→C15（链内串行）；T20 挂载（**被 C13 取代，不再单独执行**）；T22 stepper | view 链全序见 §13.0；T22 与 C 链由协调者按时间片错开，建议 T22 排 C15 后（收口性质） |
| `src/studio-shared.ts` | C04、C10、C12、C14；T22 | C 链内串行；T22 窗口错开 |
| `test/studio.test.mjs` | C09、C10、C11、C12、C13、C14；T22 | 各任务只新增/改自己触发的断言；T22 终态核对 |
| `docs/usage-reference.md` | C14、C15；T20（原）、T22 | C15 统一更新画布口径；T22 终态核对；T20 原挂载用法段被 C13 取代 |
| `src/comfyui.ts` | C03（注释）、C10（钩子）；T21、T23–T25 | C03/C10 先于 T21（T21 未开始）；T21 开工后 C 链不再碰该文件 |
| `src/layout-editor.ts` | C13；T20（核心已提交 `12368dc`） | 所有权移交 C13；纯函数层与 14 测试语义冻结 |
| `src/boards.ts`、`src/studio-canvas.ts`、`src/client-styles.ts`、`src/studio-service.ts`、`test/studio-canvas.test.mjs`、`test/boards.test.mjs` | C01/C04/C05/C07/C08/C12 | **安全独占区**（执行计划内无任务触碰），C 链内按前置串行，链外可先行 |
| `src/studio-routes.ts` | C10、C12、C14；T16（已完成） | C 链内串行 |
| `src/progress.ts`、`test/progress.test.mjs` | C10；T16（已完成） | C10 独占窗口 |
| GPU / ComfyUI 实机 | C14 验收；T21、T22、X01–X06 | 资源互斥，沿用执行计划 §7 末行口径 |

**与执行计划的衔接说明**：T15（MCP client）/T21/T22 未开始（`verify/EXECUTION-PROGRESS.md:33,44-45`）。C 链不依赖 T15（画布只是交互层，后端链路不变，D6）；C14 硬依赖 T21；T22 的 stepper 会消费 C10 扩展后的 SSE 事件（run/clientId 字段对 stepper 同样有用），建议 T22 任务书并入时注明「SSE 契约以 CANVAS-DESIGN §4.3 为准」。本文不修改 EXECUTION-PLAN.md / DIRECTION-ALIGNMENT.md，并入与 T20 条目标注由下一个工作者执行。

（完）