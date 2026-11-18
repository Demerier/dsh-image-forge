# dsh-image-forge 图像工作台外壳设计（WORKBENCH-SHELL）

本文是 [DIRECTION-ALIGNMENT.md](DIRECTION-ALIGNMENT.md)（方向文档）、[EXECUTION-PLAN.md](EXECUTION-PLAN.md)（执行计划）与 [CANVAS-DESIGN.md](CANVAS-DESIGN.md)（画布专项设计，下称「画布设计」）之后的**外壳专项设计**：把图像工作台从「左半输入配置 + 右半画布」的两栏面板，改造成**浏览器页签式外壳**——默认停在「项目管理」页签，打开项目后出现「无限画布」页签，复杂控制再开同级「节点详情」页签。第 14 节的任务拆分（U01–U10）按执行计划六段式体例写成，供后续并入 EXECUTION-PLAN.md（**本文不修改那三份文档**，并入是下一个工作者的事）。

行文约定：中文行文、技术名词保留英文；现状事实带 `文件:行号` 证据（2026-11-18 本会话逐条核实）；设计决策显式标注 **【设计决策】**；不承诺时间表，顺序用依赖/批次表达。

---

## 1. 决策记录（2026-11-18 用户拍板）

D10–D14 由用户于 2026-11-18 拍板，是对画布设计 D6–D9 的**外壳层补充**（编号接续执行计划/画布设计，不改动那两份文档）。

| # | 决策 | 含义与影响 |
|---|---|---|
| D10 | **外壳形态 = 浏览器页签式**；「项目管理」为**默认页签**；打开项目后出现「无限画布」页签 | 面板主体由「一个纵向长表单 + 右侧结果区」改为「一条页签条 + 一块页签内容」。默认落点是项目管理（不是某个画板），这推翻了现有「打开面板即回到上次画板」的隐式行为（`src/studio-routes.ts:247` 读 `activeBoardId` 的决定权从「面板打开时」下移到「用户点项目时」）。 |
| D11 | **项目单位 = 现有 board（画板）**，不新建层级 | 项目 = `BoardSummary`/`BoardDetail`（`src/studio-shared.ts:487-498,626-629`）。术语上本文把「项目」与「画板/board」当同义词，界面字符串用「项目」；不改存储模型，不引入 workspace/collection 中间层。 |
| D12 | 左半传统输入配置区（prompt/比例/步数/cfg/参考图等）**彻底去掉**，改为**节点属性**；从画布上新建节点、在节点上填参数 | 生成入口从「填表 → 出图」变成「建节点 → 填该节点 → 出图」。现有左栏 `studio-view.ts:1141-1159` 的一组 `useState`（prompt/ratio/steps/references/batches）里的**表单态**要挪到节点上；其中「已选参考图/已生成批次」这类**结果态**不能留在表单里，要随节点落盘（`BoardTaskParams`）。**注意**：`cfg`/采样器/底模实测并不在左栏（§7.1），本文按实际口径处理。 |
| D13 | 画布上选中节点 → 可在画布内做**简单控制**；**复杂控制开「新标签」**（面板内页签，与项目管理/画布同级），典型例子是 MOSS 布局控制节点 | 「简单/复杂」的分界由本文 §6.3 定义（简单 = 悬浮动作条 + 右键菜单项；复杂 = 需要大面积、需要精确输入、需要长时间停留的编辑）。MOSS 布局编辑器是第一个「复杂」用例：它现在**内嵌在画布节点里**（`studio-view.ts:1035` 挂 `mountLayoutEditor`），本设计把它搬进详情页签、画布节点退化为缩略预览。这与画布设计 D7「做成画布内布局节点，不是独立页签」**部分冲突**，处理口径见 §8.4 与 §16.2。 |
| D14 | **多项目并存**：可同时打开多个项目（多个画布页签），**重启后恢复**上次打开的页签 | 需要新的持久化面（§4 的 `workspace.json`）。现有 `state.json` 只记一个 `active` 画板（`src/boards.ts:18`），不足以表达「打开集合 + 激活页签 + 页签顺序」。 |

### 1.1 本文派生的设计决策（WD 编号，正文引用）

| # | 决策 | 依据所在节 |
|---|---|---|
| WD1 | 页签三类：`projects`（单例、不可关、恒在最左）/ `canvas:<boardId>`（每 board 一个）/ `node:<boardId>:<itemId>`（节点详情，引用来源画布） | §3.1 |
| WD2 | 关闭画布页签**连带关闭**其节点详情页签；关闭前若有未落盘的编辑，先 flush 再关（沿用现有 unmount flush 口径） | §3.3 |
| WD3 | 同时打开上限：画布页签 8 个、页签总数 16 个；超限时拒绝新开并聚焦已开的同目标页签，不静默丢弃 | §3.4 |
| WD4 | 权威状态文件 = 新文件 `workspace.json`（v1）；`state.json` 降级为**只写镜像**（`active` = 当前激活画布页签的 boardId），因为服务端 `/studio/board` 仍在读它做默认板 | §4.1、§4.4 |
| WD5 | 持久化沿用 board v2 的「读时内存迁移、写时落盘、读不写盘」与「版本号不认识就降级为空」策略；坏引用逐项丢弃而非整体失败 | §4.3 |
| WD6 | 项目列表 = 卡片网格（封面/条目数/最近修改），封面复用 `BoardSummary.cover`，无封面的板用类型占位图 | §5.2 |
| WD7 | 需要补两个存储/路由能力：**复制整个画板**、**画板占用字节数**；其余（列表/新建/重命名/删除/搜索排序）用现有 API 组合可得 | §5.5 |
| WD8 | 节点属性采用**右侧抽屉**（画布浮层，非内联、非固定分栏），只在画布页签内有选中节点时出现；宽度 320，可折叠 | §7.2 |
| WD9 | 属性**即时保存**（字段失焦/防抖 300ms 落盘到 board 条目或 task 参数），与现有几何的 700ms 防抖布局保存**分两条线**，互不覆盖 | §7.5 |
| WD10 | 同一份数据在「画布 + 详情页签」同时存在时**只有一个编辑主体**：谁有焦点谁写，另一侧降为只读镜像；布局节点进详情页签后画布节点显示只读缩略 | §8.4 |
| WD11 | 素材归位：`projects` 页签内有**全局素材库**入口（跨板，等价现有 `assetScope:'all'`）；`canvas` 页签内的素材 = 当前项目条目（`assetScope:'board'`）；导入走同一条 `/studio/import` | §9 |
| WD12 | 全局只保留**一条 SSE 连接**，事件按 `boardId` 分发到各画布页签的 store；环境状态轮询、撤销栈、run 注册表同样单例 | §10.1 |
| WD13 | 非激活画布页签**保活但不渲染**：DOM 保留（`hidden`），画布内部 effect 停摆；布局编辑器在离开页签时卸载、回来重挂 | §10.2 |
| WD14 | 不抢占宿主快捷键：**不用** Ctrl+Tab / Ctrl+W / Ctrl+T；页签切换用 Ctrl+Alt+←/→，Esc 只关详情页签且仅在页签内容有焦点时生效 | §12 |
| WD15 | 外壳与画布引擎解耦：`WorkbenchShell` 只依赖 `BoardSummary`/`BoardDetail`/`BoardItem` 三型与 6 个回调，不 import 画布内核模块 | §13 |

### 1.2 目录

- §2 现状基线（已核实，可抽查）
- §3 页签模型
- §4 状态与持久化（重点）
- §5 项目列表页签
- §6 画布页签
- §7 节点属性（替代左半表单，重点）
- §8 节点详情页签
- §9 素材的归位
- §10 全局单例资源与多页签渲染
- §11 空状态与引导
- §12 键盘与可达性
- §13 与画布引擎替换的隔离边界（§13.4 = 实施后的实测边界）
- §14 任务拆分 U01–U10（§14.12 = 实施进度回填）
- §15 测试策略
- §16 待决策与未核实项（§16.4 = 未核实项的结论）
- §17 人工验收清单现状
- 附录 A 线缆契约变更汇总

---

## 2. 现状基线（已核实，执行前可抽查不必重推导）

> 口径：下表为 2026-11-18 工作区实测（HEAD `80e73b2`）。**审计期间 `src/studio-view.ts` 与 `src/studio-shared.ts` 都在被另一 worker 并行修改**（`studio-view.ts` 本会话首读 4303 行、07:23 再读 4642 行；状态行已出现 `data-env-state`/`data-env-owned`）。本文行号是 **07:23 快照**，并同时给出符号/类名锚点（如 `dsh-forge-stepper`、`dsh-forge-studio-status`、`taskPromptLine`），行号失效时按锚点定位；执行 U 系列前请以当时工作树为准重核一次。**另一名 worker 正在改 `src/studio-view.ts` 的状态行与 stepper（环境启停按钮）**，本文所有 `studio-view.ts` 行号对应该提交；该 worker 落地后行号会漂移，按锚点文字（如 `dsh-forge-stepper`、`dsh-forge-studio-status`）定位而非按行号硬跳。

### 2.1 单组件承载的面

| 事实 | 证据 |
|---|---|
| 面板组件单文件 **4642 行**，一个组件承载全部界面（brief 说「4000+」；本会话首读 4303、07:23 再读 4642 —— 该文件正被并行修改，实测值一直涨） | `src/studio-view.ts`（`(Get-Content src/studio-view.ts \| Measure-Object -Line).Lines` → 4303） |
| 面板标题「图像工作台」+ 顶部状态行（ComfyUI endpoint / 未就绪 / 重新检测）；状态行现已带 `data-env-state` / `data-env-owned` 两个属性，说明在途的环境启停任务**已部分落进工作树** | `src/studio-view.ts:3712-3729`（`dsh-forge-studio-head` / `dsh-forge-studio-status`） |
| T22 安装→出图 stepper：固定在状态行下方、**始终可见**，四个步骤投影自 config 快照 + live SSE phase | `src/studio-view.ts:3802-3832`（`dsh-forge-stepper`、`role="list"`、`aria-label="从安装到出图"`） |
| 双栏布局是 CSS 硬结构：`.dsh-forge-studio-body` 为 `grid-template-columns: minmax(0,1fr) minmax(0,1fr)`，左半 `.dsh-forge-studio-form` | `src/client-styles.ts:41`、`:43`；860px 以下折单列 `:42` |
| 左半表单态：`prompt` / `ratio` / `steps` / `references` / `batches` / `promptStyle` 等一组 useState | `src/studio-view.ts:1141-1159` |
| prompt 改写（optimize）在左栏按钮上，写回同一个 `prompt` state | `src/studio-view.ts:1654-1687` |
| 结果区三视图用一组**分段按钮**（不是页签）：`canvas` / `list` / `assets`，靠 `view` state 切换 | `src/studio-view.ts:1161`、`:4171`（`dsh-forge-view-toggle`、`aria-pressed`）；样式 `src/client-styles.ts:80` |
| 素材视图有作用域开关 `board` / `all`（项目内 / 全板），说明「素材归位」的两种形态在代码里已存在 | `src/studio-view.ts:1206`（`assetScope`）、`:1598`、`:4295` |
| 画板管理（列表、新建、重命名、删除、切换）在面板内 | `src/studio-view.ts:1198-1202` |
| 面板内已有**一套页签样式**（`.dsh-image-forge-tabs` / `.dsh-image-forge-tab` / `-tab-active`），来自设置页分区 | `src/client-styles.ts:204-232` |
| 另一处既有页签反例：设置页签已改名「生图配置」（HEAD `80e73b2`），说明页签化在本仓有先例 | `git log --oneline -5` → `80e73b2 rename(ui): settings section 生图配置 and dual-model wording` |

### 2.2 数据模型与存储

| 事实 | 证据 |
|---|---|
| 项目摘要 `BoardSummary`：`id/name/itemCount/cover/createdAt/updatedAt/sessionId`；`cover` 是**最新图片的 markdownPath**，可为 `null` | `src/studio-shared.ts:487-498` |
| 节点 = 画板条目 `BoardItem`，`kind: 'image' \| 'task' \| 'layout'`（缺省按 `image`） | `src/studio-shared.ts:509`、`:585-623` |
| 画板详情 `BoardDetail` = 摘要 + `items` + `camera{x,y,zoom}`（可为 null） | `src/studio-shared.ts:626-629` |
| 落盘位置：`<outputDir>/.dsh-image-forge/boards/<id>.json`；`state.json` 为 `{"active":"b…"}`，注释即「last board the panel had open」 | `src/boards.ts:18`、`:174-185` |
| 版本与上限：`BOARD_VERSION=2`、v1 常量 1、`MAX_BOARDS=200`、`MAX_BOARD_ITEMS=1000` | `src/boards.ts:62-82` |
| 懒迁移：`migrateBoardFile` 接受 v1/v2，**其他版本返回 undefined（整板忽略）**；写盘时一律落 v2 | `src/boards.ts:303-345`、`:598` |
| 存储 API：`listBoards` / `readBoard` / `activeBoardId` / `setActiveBoard` / `createBoard` / `renameBoard` / `saveLayout` / `recordItems` / `copyItem` / `moveItem` / `saveTaskItem` / `saveLayout`（条目） | `src/boards.ts:473,496,502,523,585,640,747,809,867,974` |
| 板级请求是**一个路由 + 10 个 action**：`create/rename/layout/remove-item/delete/active/copy-item/move-item/save-task/save-layout-node` | `src/studio-shared.ts:647-660`；分发 `src/studio-routes.ts:281-330` |
| **没有**「复制整个画板」、**没有**画板字节数/文件大小字段 | `src/boards.ts` 全量 export 无 duplicate/boardSize；`BoardSummary` 无 size 字段（`src/studio-shared.ts:487-498`） |

### 2.3 画布与布局节点

| 事实 | 证据 |
|---|---|
| 画布内核为 DOM + CSS transform（非 canvas2D/SVG/tldraw），几何/裁剪/索引在 `studio-canvas.ts` | `src/studio-canvas.ts:30-59`（常量与 `Camera`）、`:92-252`（几何）、`:313-438`（裁剪/索引/边） |
| 交互纯函数层：框选/多选/对齐分布/快捷键表/命令栈（上限 100） | `src/canvas-interactions.ts:86-328`、`:384`（`CommandStack`）、`:470-631`（快捷键表与上下文）、`:693-700`（右键菜单项） |
| 导出：画板 JSON + 拼版 PNG（上限 200 条目 / 256px 缩略） | `src/canvas-export.ts:22-28` |
| 布局编辑器 1400+ 行原生 DOM，对外只暴露 `mountLayoutEditor` + 句柄 | `src/layout-editor.ts:1219`（`mountLayoutEditor`）、`:1146-1154`（`LayoutEditorOptions.pointerScale?` 可选，默认 1） |
| `pointerScale` 默认 1；且拖拽 delta 对**祖先 transform 缩放已经不变**（editor 用自身 `getBoundingClientRect` 换算），故非画布场景**无需传 1**——不传即 1 | `src/layout-editor.ts:779-786`、`:1326-1331` |
| 布局编辑器现以内嵌方式挂在画布节点里，**未传 pointerScale**，失败时只在节点上显示错误、不炸整个面板 | `src/studio-view.ts:1066-1103`（挂载/卸载）、`:1115-1119`（局部错误） |

### 2.4 任务 / 进度 / 线缆 / 测试

| 事实 | 证据 |
|---|---|
| run 注册表在服务端会话级单例，记录 `clientId`（画布任务 id）+ `boardId`，事件回带两者 | `src/runs.ts:9-11,44-47,116-127,164-169` |
| SSE：面板内 `new EventSource(STUDIO_EVENTS_ROUTE)`，卸载时 `close()`；**每个面板实例一条** | `src/studio-view.ts:1410-1428` |
| 进度显示是**面板顶部一条全局状态栏**（不是节点级），live 态为一个 `LiveProgress` | `src/studio-view.ts:1156`、`:826-860`（`reduceProgressEvent`）（事件折叠） |
| 现有线缆 9 条：`/studio/config`、`/studio/generate`、`/studio/optimize`、`/studio/boards`、`/studio/board`、`/studio/import`、`/studio/assets`、`/studio/file`、`/studio/events`（含 optimize 与 import，共 9 条） | `src/studio-routes.ts:34-49`、`:150,163,201,239,255,382,431,461,510` |
| 测试：`test/studio.test.mjs` 实测 **75 个 `test(`**（brief 说 44+，实际更多）；其中 T22 stepper 两条用例在 `:1936`、`:1970`（渲染断言到 `:2002`） | `test/studio.test.mjs:1933-2002`；`(Select-String -Pattern '^test\(').Count` → 75 |
| `npm test` 串跑 **23 个测试文件** | `package.json:57`（ratio/surface/comfyui-e2e/edit-e2e/moss-edit/settings/studio/studio-canvas/boards/board-migration/output/package-contents/studio-file-route/model-profiles/progress/runs/environment/layout-editor/studio-lineage/canvas-interactions/canvas-export/moss-layout/mcp-backend） |
| 面板座位断言：Studio 作为 `main` keyed panel + `sidebar.panellist` 两项座位 | `test/settings.test.mjs:259-269` |

---

## 3. 页签模型

### 3.1 页签类型与标识

**现状**：面板内只有一个「视图」分段按钮（`canvas`/`list`/`assets`，`src/studio-view.ts:1161`、`:4171`），切换只改一个 state，没有「打开集合」的概念；画板切换由画板管理区完成（`:1198-1202`），同一时刻只有一个画板在内存里。

**目标设计**：三层结构 = 页签条 + 页签内容 + （画布页签内的）节点属性抽屉。页签三类：

| 类型 | key 形态 | 数量 | 可关 | 内容 |
|---|---|---|---|---|
| `projects` 项目管理 | `projects` | 恒 1 | **否** | 项目卡片网格 + 全局素材入口（§5、§9） |
| `canvas:<boardId>` 无限画布 | `canvas:b_xxx` | 0..N | 是 | 该 board 的画布（§6） |
| `node:<boardId>:<itemId>` 节点详情 | `node:b_xxx:i_yyy` | 0..N | 是 | 布局大编辑器 / 任务参数与历史 / 大图查看（§8） |

**【设计决策】** 页签 key 用字符串而非对象：它同时是 `tabOrder` 数组元素、React `key`、URL/持久化里的稳定标识；`boardId` 与 `itemId` 都不含冒号（生成规则见 `src/boards.ts:294` 的 `makeItemId` 与 `b` 前缀），`split(':')` 无歧义。

**【设计决策】** 节点详情页签的**显示名可随数据变**（如 `布局 b_xxx 的 draft` → 重命名为「布局 1」），但 key 不变；不因为改名重排。

### 3.2 顺序与激活规则

**目标设计**：

1. `projects` 恒在 `tabOrder[0]`，不接受拖拽换位、不接受关闭。
2. `canvas:<id>` 按**打开顺序**追加在已有画布页签之后（不是按 board 列表顺序）。
3. `node:<boardId>:<itemId>` **插在其来源画布页签的右侧**；若来源画布已关闭（见 §3.3），插在页签条末尾并标「孤立」态。
4. 激活规则：打开某项目 → 激活该画布页签；从画布开节点详情 → 激活详情页签；关闭激活页签 → 激活**左侧相邻**页签（左边没有则激活右侧，两边都没有则回到 `projects`）。
5. 再次「打开」一个已打开的 board：**不新开页签**，改为激活已有页签并把相机 `centerOn` 到目标条目（已有 `centerOn`，`src/studio-canvas.ts:194`）。
6. 页签条保持单一横向滚动条，溢出时左端 `projects` 固定、其余横向滚动；不做「下拉的隐藏页签菜单」（首期）。

**【设计决策】** 激活态与「画布页签是否渲染」分开：非激活画布页签保活不渲染（WD13，§10.2），因为布局编辑器重挂成本高但渲染成本也高，二者不冲突。

### 3.3 关闭规则

| 场景 | 行为 |
|---|---|
| 关 `canvas` 页签 | 若该板有脏数据（未 flush 的几何/属性，见 §7.5）→ 先 flush 再关（沿用现有「卸载即 flush」口径 `src/studio-view.ts:1428`）；**连带关闭**该板的全部 `node:` 页签（WD2） |
| 关 `node` 页签 | 若详情编辑态脏（编辑器有未落盘 draft）→ flush 后关；不连带关画布 |
| 关最后一个画布页签 | 允许；自动激活 `projects` |
| 关页签导致 `tabOrder` 为空 | 不可能（`projects` 不可关） |
| 引用已被删除的 board | 页签进入「失效」态：内容区给一条「项目已删除」提示 + 「关闭页签」按钮，不自动静默关闭（用户可能刚在别处删掉、需要知道） |

**【设计决策】** 关闭时不弹模态确认框（面板内模态成本高且易被宿主遮挡），改为：脏数据先 flush（不丢），真正不可逆的动作（删项目）才用二次确认（§5.4）。

### 3.4 上限

**【设计决策】** 画布页签上限 **8**、页签总数上限 **16**。超限时：给出非阻断提示条（`「同时最多打开 8 个项目，已打开 <名字>」`）并激活已开的同目标页签；**不**做 LRU 自动驱逐（自动关用户页签是数据丢失风险）。上限常量化到 `src/workbench-tabs.ts` 的 `MAX_CANVAS_TABS` / `MAX_TABS`，可测。

### 3.5 数据模型 / 契约变更

- 客户端新增纯函数模块 `src/workbench-tabs.ts`（无 DOM、无 React）：`TabKey` 解析/构造、`openTab`、`closeTab`、`activateTab`、`reorderAfterClose`、`isTabAllowed`。状态机全部落在这里，供 §15 的纯函数测试直测。
- 服务端**无契约变更**（页签是纯客户端概念）。唯一涉及服务端的是 §4 的 workspace 持久化。

### 3.6 迁移与测试影响

- 迁移：无数据迁移（新概念）。行为迁移：**打开面板不再自动回到上次画板**，而是落在 `projects`；`state.json.active` 改为「恢复时自动打开该板的画布页签」的输入（D10 + WD5）。这会让现有「打开即画布」的手感变化，需在 §11 首次空态文案里交代。
- 测试影响：新增 `test/workbench-tabs.test.mjs`（纯函数）；`test/studio.test.mjs` 里任何「面板一渲染就有画布」的断言要改为「面板一渲染就是项目管理页签」。

---

## 4. 状态与持久化（重点）

### 4.1 哪些进内存、哪些落盘

| 状态 | 归属 | 落盘 | 理由 |
|---|---|---|---|
| 打开的 board 集合、激活页签、页签顺序、节点详情页签、最近项目 | **workspace** | 是 → `workspace.json` | D14 要求重启恢复 |
| 每个 board 的条目、相机、节点参数 | **board** | 是 → `boards/<id>.json`（现状不变） | 已有模型，`camera` 已随板存（`src/studio-shared.ts:628`） |
| 选中节点集合、框选矩形、右键菜单、抽屉开合、页签内滚动位置 | **会话内存** | 否 | 纯交互态，恢复它反而意外（撤销栈同理，画布设计 DD9） |
| 撤销/重做栈 | 会话内存 | 否 | 同上，且命令栈上限 100（`src/canvas-interactions.ts:44`） |
| 生成中的任务节点运行态 | 内存 + SSE | 否（终态失败才落盘，画布设计 DD6 / `save-task`） | 现状口径 |
| 环境探测快照、stepper 状态 | 内存（可短缓存） | 否 | 现状口径（`/studio/config` 快照） |

### 4.2 `workspace.json` v1 schema

路径与 boards 同级：`<outputDir>/.dsh-image-forge/workspace.json`。**【设计决策】** 新文件而不是塞进 `state.json`：`state.json` 已被服务端当作「默认板」读（`src/studio-routes.ts:247`），改它的形状会同时影响服务端行为；新文件让页面恢复与服务端默认板解耦。

```jsonc
{
  "version": 1,
  "openProjects": ["b_7fk2", "b_9xz1"],          // 打开的画布页签，按打开顺序
  "activeTab": { "kind": "canvas", "boardId": "b_9xz1" },
                                                  // kind: "projects" | "canvas" | "node"
                                                  // canvas 带 boardId；node 带 boardId + nodeId
  "nodeDetailTabs": [                             // 打开着的节点详情页签
    { "boardId": "b_7fk2", "nodeId": "i_a1b2", "kind": "layout" }
  ],
  "tabOrder": ["projects", "canvas:b_7fk2", "node:b_7fk2:i_a1b2", "canvas:b_9xz1"],
  "recentProjects": [                             // 项目管理页签的「最近」排序依据，上限 20
    { "boardId": "b_9xz1", "openedAt": "2026-11-18T06:12:00.000Z" }
  ]
}
```

字段约束（写入前一律归一化，读入后一律校验）：

- `version`：整数；**只写 1**。
- `openProjects`：字符串数组，按顺序去重，最多 `MAX_CANVAS_TABS`(8) 条。
- `activeTab.kind` ∈ `projects|canvas|node`；`canvas` 必带 `boardId`；`node` 必带 `boardId`+`nodeId`。
- `nodeDetailTabs[]`：`kind` 只写 `layout|task|image`（数据里另有 `BoardItemKind`，读入按实际条目再校验）。
- `tabOrder`：字符串数组；写入时保证 `tabOrder[0] === 'projects'`、且其集合 == `{projects} ∪ openProjects ∪ nodeDetailTabs`（不一致时以 `tabOrder` 为准补齐，见 §4.3）。
- `recentProjects[]`：`{boardId, openedAt}` ISO 字符串；时间不合法即丢弃该条。

**【设计决策】** `activeTab` 与 `tabOrder` 都写，看似冗余，但前者是「恢复后停在哪」、后者是「条怎么排」；只存一个就得在恢复时推导另一个，而推导规则（§3.2 第 3 条「插在来源右侧」）依赖当时的打开顺序，存下来更稳。

### 4.3 版本、读不写盘、坏数据降级

**现状可复用**：board 的迁移策略正是本文要沿用的模板——`migrateBoardFile` 只在读路径做内存迁移，写路径一律落当前版本（`src/boards.ts:303-345`）；版本号不认识就**整板忽略**（`:334`）。

**目标设计（WD5）**：

1. **读不写盘**：`GET` workspace 只读文件 + 内存归一化，绝不因「读到旧格式」就回写。回写只发生在用户**实际产生页签变化**后的那次 `POST`。
2. **版本策略**：`version === 1` → 直接校验；`version` 缺失 → 视为「旧 `state.json` 形状」尝试兼容（见 §4.4）；`version > 1` → **整体降级为空 workspace**（等价 board 的整板忽略），并给一条非阻断提示「工作区记录来自更新版本，已按空工作区打开」。
3. **坏数据逐项降级**（不整体失败）：

| 坏情况 | 降级 |
|---|---|
| JSON 解析失败 / 文件不存在 | 空 workspace（`projects` 激活），不报错 |
| `openProjects` 里有已删除的 board | 丢掉该项；若它是 `activeTab` 目标，`activeTab` 退回 `projects` |
| `nodeDetailTabs` 指向「board 还在但 item 没了」 | 丢掉该页签；`nodeId` 对应 board 不存在同样丢掉 |
| `tabOrder` 与 `openProjects` 集合不一致 | 以 `openProjects` + `nodeDetailTabs` 重建 `tabOrder`（顺序：`projects` → 保留原相对顺序 → 新增追加） |
| `tabOrder` 里有未知 key 形态 | 丢掉该 key |
| 超过上限 | 截断到上限（`openProjects` 取前 8，`tabOrder` 取前 16），不拒整份 |

4. **写入原子性**：沿用 board 的「临时文件 + rename」写法（`src/boards.ts` 的写盘套路）与 `serialized()` 串行化（`:227`），避免多页签并发保存互相覆盖。

### 4.4 与旧 `state.json` 的兼容与迁移

**现状**：`state.json` 只有 `{"active": "b…"}`（`src/boards.ts:18`），服务端画板路由在读它做默认板（`src/studio-routes.ts:247`）。

**目标设计（WD4）**：

- **权威 = `workspace.json`**；`state.json` **继续写**，值 = 当前激活画布页签的 `boardId`（无画布页签时为 `null`）。原因：删掉它会让服务端「默认板」逻辑与其它读 `activeBoardId` 的路径（`src/boards.ts:502`）失去输入，属于超范围的连带改动。
- **首次升级时的迁移**（一次性、读时内存完成）：

```
旧：state.json = {"active":"b_7fk2"}，无 workspace.json
→ 内存：{version:1,
        openProjects:["b_7fk2"],
        activeTab:{kind:"canvas",boardId:"b_7fk2"},
        nodeDetailTabs:[],
        tabOrder:["projects","canvas:b_7fk2"],
        recentProjects:[{boardId:"b_7fk2",openedAt:<now>}]}
```

  这把旧行为（打开即回上次画板）**保形**保留；用户第一次自己点「返回项目列表」后，`activeTab` 才变成 `projects`，此后不再自动回画布。
- **反向不兼容**：旧版本插件读不懂 `workspace.json`，但也不受影响（它只读 `state.json`，而 `state.json` 仍被正确维护）。

### 4.5 契约变更

**【设计决策】** 不新增路由，把 workspace 读写挂到现有 `/studio/boards` 这个「一个路由 + action 袋」上（`src/studio-shared.ts:647-660` 的 action 联合类型加两个成员）：

| action | 入参 | 出参 | 说明 |
|---|---|---|---|
| `workspace-get` | 无 | `{ ok: true, workspace: WorkspaceFile \| null }` | 只读；`null` 表示没有文件（走 §4.4 迁移） |
| `workspace-set` | `{ workspace: WorkspaceFile }` | `{ ok: true }` | 整体覆盖写；服务端做 schema 校验与归一化后再落盘 |

选择理由：这两个 action 与画板同源同守卫（`sameOrigin` + JSON-only + 256KB body cap），新开一条路由要复制一整套守卫与错误口径；代价是 `StudioBoardRequest` 的 action 联合从 10 个变 12 个，`parseBoardAction` 的校验表（`src/studio-routes.ts:276`）同步扩两项。

`StudioBoardsResponse`（`src/studio-shared.ts:632-635`）不动：它是「画板列表 + active」，页签状态另走 `workspace-get`。

### 4.6 迁移与测试影响

- 迁移：无 board 文件改动（`version` 仍是 2）；新增 `workspace.json` 文件（可缺省）。
- 测试：新增 `test/workbench-workspace.test.mjs`（schema 归一化/降级/上限/读写往返）；`test/boards.test.mjs` 加两个 action 的路由级用例（或放 `test/studio.test.mjs` 的 board 段落）；`test/board-migration.test.mjs` 保持只管 board 版本，workspace 迁移单独一个文件，避免混两套版本语义。

---

## 5. 项目列表页签

### 5.1 现状

- 画板列表存在，但形态是**面板内的管理区**（`src/studio-view.ts:1198-1202` 的 `boards` / `boardId` state），与画布、结果列表挤在同一列。
- 数据源：`listBoards()` 返回 `BoardSummary[]`（`src/boards.ts:473`，上限 200 板，`:62`），带 `id/name/itemCount/cover/createdAt/updatedAt/sessionId`（`src/studio-shared.ts:487-498`）。
- 新建/重命名/删除走 `/studio/board` 的 `create`/`rename`/`delete` action（`src/studio-routes.ts:282-293` 起）。
- **没有**整板复制、没有文件大小、没有服务端搜索/排序（排序是 `listBoards` 内部按 `updatedAt` 的口径，上限 200 条一次返回）。

### 5.2 目标设计

`projects` 页签结构（自上而下）：

```
┌ 工具条：[+ 新建项目] [搜索框] [排序: 最近修改 ▾] ────────── [全局素材] ┐
│ 网格：卡片 × N（自适应列，最小宽 220）                                │
└ 空态：见 §11.1 ──────────────────────────────────────────────────────┘
```

卡片字段与来源（WD6）：

| 字段 | 来源 | 缺省 |
|---|---|---|
| 封面 | `BoardSummary.cover`（最新图片的 markdownPath，可为 `null`）→ `GET /studio/file?path=…` 取缩略 | `cover === null` → 按主类型画占位（`layout` 用网格图、`task` 用失败图标、否则 🔲） |
| 名称 | `name`，双击就地重命名 | 无（必填，`sanitizeBoardName` 兜底 `src/boards.ts:275`） |
| 条目数 | `itemCount`，文案「12 个节点」 | 0 → 「空项目」 |
| 最近修改 | `updatedAt` 相对时间（「3 分钟前」），`title` 给绝对时间 | 无 |
| 大小 | **需新增**（§5.5）；缺省显示 `—` 而不是 0 | 无 |
| 副标识 | `sessionId` 非空时显示「来自对话」小徽标 | 隐藏 |

**【设计决策】** 封面只读一张（最新图），不做拼版缩略图：拼版 PNG 需要服务端渲染或客户端离屏画布（`src/canvas-export.ts` 的拼版逻辑是为导出服务的，200 条目上限），项目列表一屏十几张卡就翻倍成本；单图封面已经足够区分项目。

### 5.3 操作清单

| 操作 | 行为 | 线缆 |
|---|---|---|
| 新建 | 工具条主按钮 → 建空板 → **直接打开其画布页签**（激活） | `POST /studio/board {action:'create', name?}` |
| 打开 | 点卡片本体 → 打开/激活 `canvas:<id>` 页签（§3.2 第 5 条） | 已有 `GET /studio/board?board=id` |
| 重命名 | 卡片菜单「重命名」或在详情头就地编辑 → 失焦提交 | `{action:'rename', board, name}` |
| 复制 | 卡片菜单「复制项目」→ 新板 `<原名> 副本`，**复制条目与相机**（不复制 PNG 文件，条目共用同一 markdownPath） | **新增** `{action:'duplicate'}`（§5.5） |
| 删除 | 卡片菜单「删除项目」→ 二次确认（§5.4） | `{action:'delete', board}` |
| 搜索 | 前端按 `name` 子串过滤（200 条一次到手，无需服务端） | 无 |
| 排序 | 最近修改（默认）/ 创建时间 / 名称 / 条目数 | 前端本地排序 |
| 全局素材 | 工具条右侧入口 → 打开「全局素材」视图（§9） | `GET /studio/assets?scope=all` |

### 5.4 删除的二次确认

- `itemCount === 0`：一次确认（「删除空项目？此操作不可撤销」）。
- `itemCount > 0`：确认框内**必须显示条目数与是否连带删图**，两个选项：`只删项目（图片留在素材库）` / `删除项目与图片文件`（对应 `remove-item` 的 `deleteFile` 语义，`src/studio-shared.ts:669-670`）。
- 删的是当前打开的板：先按 §3.3 的失效态把页签标失效，再删；删除成功后关闭该页签并激活左邻。

### 5.5 与现有 `boards.ts` API 的对应关系（WD7）

| 需要 | 现有 API | 结论 |
|---|---|---|
| 列表 + 封面 + 条目数 + 时间 | `listBoards()`（`src/boards.ts:473`） | 够用 |
| 新建 / 重命名 / 删除 | board route `create`/`rename`/`delete`（`src/studio-routes.ts:282-293` 起） | 够用 |
| 读取单板 | `readBoard()`（`:496`） | 够用 |
| 复制整个项目 | **无** | **新增**：存储层 `duplicateBoard(outputDir, id, name?)`（复制 items/camera，`version` 落当前版本，`MAX_BOARDS`/`MAX_BOARD_ITEMS` 照样受控），路由层加 `{action:'duplicate'}` |
| 项目大小（字节） | **无**；`BoardSummary` 无量纲字段 | **新增**（可缓）：`listBoards` 顺带 `stat` 每个板文件，回 `bytes?: number`；**不**统计图片文件体积（跨目录、容易把列表拖慢到秒级） |
| 搜索 / 排序 | 无 | 前端完成，不加 API |

**【设计决策】** `duplicate` 复制**条目记录**而不是 PNG 文件：条目共用同一 `markdownPath`，删其一不会连带删另一的图（`remove-item` 默认只 unplace，`:669`），这与「素材库”里一张图被多个项目引用」的语义一致。若用户要独立副本，走素材的「导入为新文件」路径。

### 5.6 空状态

见 §11.1（首次打开、无项目）。

### 5.7 数据模型 / 契约变更与测试影响

- 契约：`StudioBoardRequest.action` 增 `duplicate`（10→11，再加 §4.5 的两个 workspace action，共 12）；`BoardSummary` 增可选 `bytes?: number`（向后兼容，老文件不需要该字段）。
- 存储：`boards.ts` 新增 `duplicateBoard`，复用现有写盘 + `serialized()`（`:227`）。
- 测试：`test/boards.test.mjs` 加 duplicate（条目/相机/上限/名称冲突）与 `bytes` 字段；`test/studio.test.mjs` 的 board 段落加 duplicate 路由用例；项目列表的渲染断言（封面缺省、排序、搜索）进新文件 `test/workbench-projects.test.mjs`（§15.2）。

---

## 6. 画布页签

### 6.1 现状

画布能力已完整（画布设计 C01–C15 收口）：几何/裁剪/索引（`src/studio-canvas.ts`）、框选多选对齐分布快捷键命令栈（`src/canvas-interactions.ts`）、导出（`src/canvas-export.ts`）、三类节点、血缘边、视口裁剪、增量保存。缺的是**外壳**：画布上方没有「项目」概念，环境状态与 stepper 在面板最顶部（`src/studio-view.ts:3712-3832`），与画板无关地常驻。

### 6.2 画布页签顶栏

```
┌ [← 项目]  <项目名>（双击重命名）  · 12 节点   ─────  [素材] [导出 ▾] │ ComfyUI ● 就绪 [启停] ┐
└ 画布视口（占据剩余高度）                                                                    ┘
```

| 区域 | 内容 | 数据/动作 |
|---|---|---|
| 左 | 「← 项目」返回按钮（激活 `projects` 页签，不关闭当前画布）+ 项目名（就地重命名）+ 条目数 | `BoardDetail.name`、`items.length` |
| 右 | 素材入口（打开当前项目素材视图，§9）、导出菜单（画板 JSON / 拼版 PNG，现有 `canvas-export.ts`） | 现有导出函数 |
| 最右 | **环境状态 + 启停** | ⚠ 与在途任务冲突，见下 |

**【依赖 · 不由本文拍板】** 环境状态行与 T22 stepper 的搬家方式（放进画布顶栏 / 放在 `projects` 页签顶部 / 两者都放）正由**另一个 worker 在改**（改 `src/studio-view.ts` 的状态行 `:3712-3730` 与 stepper `:3803`，新增环境启停按钮；工作树里状态行已带 `data-env-state`/`data-env-owned`（`src/studio-view.ts:3716-3721`），说明改动**尚未提交**）。⚠ 因此 U04 抽取 `studio-view.ts` 必须等它**提交**后开工，否则抽取基线会在中途变动。本文只规定外壳侧的硬约束：

1. 环境状态是**全局单例**，页签切换不重建它（§10.1）；
2. 它渲染在**页签内容之外的外壳层**（顶栏），因此不能依赖任何单个画布页签的 DOM；
3. 若最终形态是「画布顶栏放一份、项目列表页签再放一份提示」，两处必须读同一个 store，不允许各自轮询。

确切位置与 stepper 去留等该任务落地后由协调者对齐，本文不预设。

### 6.3 「简单控制」与「详细控制」的分界（D13）

| 控制 | 形态 | 判据 |
|---|---|---|
| **简单控制**（画布内） | 选中节点时的**悬浮动作条**（节点下方 6 个图标位）+ 右键菜单项（复用 `contextMenuItems`，`src/canvas-interactions.ts:693`） | 单次点击能完成、不需要读长文本、不需要精确数值 |
| **详细控制**（详情页签） | 面板级页签 `node:<boardId>:<nodeId>` | 需要大面积画布（布局编辑器）、需要长表单（任务全参数与历史）、需要与大图并排比较 |

动作条固定项（按节点类型）：

| 节点类型 | 悬浮动作条 | 右键菜单（增补） |
|---|---|---|
| `image` | 详细（打开大图详情）/ 作为参考（指派到某任务节点）/ 复制 / 删除 | 同左 + 「另存为素材」 |
| `task` | 重试（仅失败/中断可见）/ 详细（参数与历史）/ 转图片 / 删除 | 同左 + 「复制参数新建任务节点」 |
| `layout` | 详细（进布局编辑器）/ 生成（用该 draft 出图，画布设计 §8/C14 闭环）/ 删除 | 同左 + 「复制布局」 |

**【设计决策】** 悬浮动作条**只在单选时出现**（多选时显示现有的对齐/分布条，`src/studio-view.ts:4188-4200`），避免两套按钮叠在一起；动作条用 `aria-label` + `title` 双标，图标按钮必须有可访问名。

### 6.4 节点级进度 vs 全局状态栏

**现状**：进度是面板顶部一条全局状态栏 + `LiveProgress` 单态（`src/studio-view.ts:1156`、`:826`）；任务节点没有自己的进度显示，只有 `BoardTaskInfo` 的终态（`src/studio-shared.ts:577-582`）。多画布页签下「顶部一条全局进度」会直接失效——它不知道该属于哪个页签。

**目标设计**：

- 进度**下沉到任务节点**：节点的图片区显示骨架 + 百分比环，文字用 `17/50`（SSE 的 `label` 已有该字段，`:1991` 的测试即断言此形态）。
- 顶栏保留一条**摘要**（「2 个任务进行中」），点它跳到对应画布页签并 `centerOn` 该节点。
- 事件分发按 `boardId` 路由到对应页签的 store（§10.1），不再有「一个全局 live 态」。

### 6.5 契约变更

- SSE 事件已带 `clientId` + `boardId`（`src/runs.ts:116-127`、`src/studio-shared.ts:889`），**无需改线缆**提示：`run` 事件已带 `boardId?`。仍需确认 `progress`/`error` 事件是否也带 `boardId`（现状只有 `run` 事件显式标注，见 §16.3 未核实项）——若不带，客户端用 `promptId → clientId → boardId` 的本地映射补（`src/studio-view.ts:776-800` 已有折叠逻辑）。**【已核实，结论在 §16.4 N1】`progress`/`error` 都带 `boardId?`**（`start`/`node`/`progress`/`done`/`error`/`interrupted` 全部 `& StudioRunLink`），因此按 `boardId` 分桶是本口径，补映射只是兜底。
- 任务节点进度**不落盘**（沿用 DD6：只有终态失败/中断落盘）。

### 6.6 迁移与测试影响

- 迁移：无数据变更。行为变更：多画布并存后，`view` 三态（canvas/list/assets）里的 `list` 视图需要定去留——**【设计决策】** 首期保留为画布页签内的一个次级切换（结果列表对「刚出的 8 张图快速浏览」仍有用），但不再是同级页签；`assets` 迁到 §9 的素材入口。此点列入 §16.1 待确认。
- 测试：stepper 渲染断言（`test/studio.test.mjs:1970-2002`）若 stepper 位置变化需同步；节点级进度的渲染断言新增。

---

## 7. 节点属性（替代左半表单，重点）

### 7.1 现状：左半表单到底装了什么

| 表单字段 | 现状位置 | 线缆字段 | 备注 |
|---|---|---|---|
| prompt（含改写） | `src/studio-view.ts:1141`、optimize `:1654-1687` | `StudioGenerateRequest.prompt`（`src/studio-shared.ts:364`） | 改写结果**就地覆盖**同一个 state |
| 画幅比 | `:1142` | `ratio`（`:366`），取 `STUDIO_RATIOS` 七档（`:117`） | 选择器标签用 config 的 `sizes` 换算像素（`:206-210`） |
| 步数 | `:1143`（字符串态） | `steps?`（`:368`），缺省用 config `defaultSteps` | 空串 = 用宿主默认 |
| 参考图 | `:1145` | `references[]`（`:374`，`path` 或 `data`，`:342-359`） | 复用画布上的成品图时走 `path` 不重传字节 |
| 数量 | 未见独立控件（走 `count?`，`:285`，上限 `STUDIO_MAX_COUNT=4` `:124`） | `count?` | 需要 U 系列补一个控件，若产品要暴露 |
| 画板归属 | 画板管理区（`:1198-1202`） | `board?`（`:379`） | 缺省 = active board |
| 批次（结果） | `:1146` | — | 这是**结果态**不是输入态 |
| **负向词** | **无** | **无** | 负向词在 profile 里（见下） |
| **cfg / 采样器 / 底模** | **无** | **无** | 由 `ModelProfile` 决定（`src/index.ts:71-90`；`src/model-profiles.ts:98-107` 的 `KSampler.inputs.cfg/sampler_name`） |

> ⚠ **与 brief 不符**：brief 说左半配置含「cfg / 采样器 / 底模」。实测**这三项目前既不在左栏表单、也不在 `/studio/generate` 线缆里**，它们是 profile 级配置（`comfyModel` 等写在插件 profile patch，`src/index.ts:71-90`），MOSS 的 cfg/sampler 还由 `mossSampling` 档位管理（`src/index.ts:86-90`）。本文按实际写：节点属性**首期不包含**这三项，是否提升为节点级列入 §16.1 待决策（推荐不提升，理由见 §7.3 末）。

### 7.2 形态取舍与推荐

三种候选：

| 形态 | 优点 | 缺点 | 判定 |
|---|---|---|---|
| A. 节点内联（节点卡片里直接放输入框） | 零跳转 | 画布节点宽 208 世界单位（`src/studio-canvas.ts:30`），zoom 0.1–4 时可读性崩；prompt 是长文本，内联必然溢出行高，破坏画布布局稳定性；每次输入都触发节点尺寸变化，等于给布局加噪声 | **否** |
| B. 右侧固定分栏（把左栏搬到右边） | 改动最小，样式可复用 | 仍然是「面板分栏」思维，和「页签式外壳」冲突；画布在窄侧栏里更挤；多页签下每个画布页签都要一份 | **否** |
| C. **右侧抽屉浮层**（画布内、绝对定位、宽 320、可折叠、带关闭） | 不占画布布局、不参与 transform、随选中节点出现/消失；窄面板可退化为全宽 | 与画布右键菜单需要互斥（同时只开一个浮层） | **推荐（WD8）** |

**【设计决策】** 采纳 C。抽屉的定位与尺寸：

- 画布页签内容区 `position: relative`，抽屉 `position: absolute; right: 12px; top: 12px; bottom: 12px; width: 320px`，`max-width: calc(100% - 24px)`；容器宽度 < 520 时改为全宽抽屉（覆盖画布）。
- 抽屉**不在** `.dsh-forge-canvas-layer`（带 transform 的层）内部，否则会被 zoom 缩放（`src/studio-view.ts:4335-4336` 的 transform 施加在该层）。
- 打开条件：画布页签内**恰好选中 1 个节点**；多选/无选中时关闭。用户手动折叠后，若选中的还是同一个节点则保持折叠（不反复弹）。
- 与右键菜单互斥：打开抽屉即关菜单，反之亦然。

### 7.3 覆盖字段（分节点类型）

抽屉内容按 `BoardItem.kind`（`src/studio-shared.ts:509`）分支。**属性值写在哪里**是本节的核心决定：

**【设计决策】** 属性有两类宿主，不能都塞进 `BoardItem`：

| 宿主 | 存什么 | 为什么 |
|---|---|---|
| `BoardItem`（画板条目） | 已存在的结果字段（`prompt/ratio/steps/seed/mode/parents/x/y/w/h`，`:585-623`）只读展示，**不新增可编辑属性** | 条目是「已经发生的结果」，回改它的 prompt 会让血缘与重试语义失真（重试要用 `BoardTaskParams` 的原始快照，`:562-574`） |
| `BoardTaskParams`（任务节点参数快照，`:562-574`） | 可编辑的生成参数：`prompt`、`ratio`、`steps`、`count`、`seed`、`references`、`layout` | 它本来就是「一次生成的完整输入」，重试就是重发它（`:559-560`「a snapshot, not a live request」） |
| `BoardLayoutDraft`（布局草稿，`:520-553`） | 布局节点的框与文本 | 已有模型，不扩 |

于是三类节点的抽屉字段：

**A. 图片节点（`kind:'image'`）**

| 组 | 字段 | 可编辑 | 保存 |
|---|---|---|---|
| 图 | 缩略 + 「查看大图」（进详情页签 §8） | — | — |
| 出身 | prompt / ratio / steps / seed / mode / backend / 来源节点（`parents` 边） | 否 | — |
| 动作 | 作为参考（指派到某个任务节点）、复制参数新建任务节点、导出、删除 | 动作 | 各自走现有路径 |

**B. 任务节点（`kind:'task'`，`BoardTaskInfo`，`:577-582`）**

| 组 | 字段 | 说明 |
|---|---|---|
| 状态 | `status`（`failed`/`interrupted`）+ `error` 首行 | 只读 |
| 参数 | `params.*` 全部可编辑（prompt/ratio/steps/count/seed/references/layout） | **即时保存到条目**：编辑后写 `{action:'save-task', board, item?, task:{status, params}}`（现 action 已在，`src/studio-shared.ts:657`） |
| 动作 | 重试（用当前 params 发起一次新 run，原节点保留或原地？见下）/ 复制参数新建 / 删除 | 重试走 `/studio/generate` + 新 `clientId` |

**【设计决策】** 重试**新建一个任务节点**（继承原节点参数，`parents` 指向原节点），而不是原地复用：原地复用会让「失败一次 → 重试成功」丢掉失败那次的历史，而画布的价值就在这条血缘。这与画布设计 DD5「任务完成原地转图片节点」互补，不冲突（DD5 说的是成功后的转写）。

**【设计决策】** 运行中的任务节点（尚无 `BoardTaskInfo`）不落盘（沿用 DD6），其抽屉里的参数**来自发起时的内存快照**；若此刻关页签/刷新，运行中的节点消失，但 SSE 结果仍会以新图片节点落板（服务端 `boardId` 明确，`src/runs.ts:116-127`）。

**C. 布局节点（`kind:'layout'`）**

| 组 | 字段 | 说明 |
|---|---|---|
| 尺寸 | `w`/`h`（世界单位，钳 [96,480]，`src/studio-canvas.ts:37-39`） | 只读展示 + 「按内容适配」一个按钮 |
| 内容 | 条目数、画布像素尺寸（`draft.width/height`） | 只读 |
| 入口 | **「详细编辑」→ 打开 `node:<boardId>:<itemId>` 页签**（§8） | 抽屉里只放**入口**，不放编辑器 |
| 动作 | 生成（用该 draft 出图，`layout` 走 `/studio/generate` 的 `layout` 字段，`:388-396`）/ 复制 / 删除 | 现有线缆已支持 |

### 7.4 新建节点的入口

**【设计决策】** 新建节点从**画布空白处双击**或右键「新建任务节点 / 新建布局节点」开始，先落一个**占位节点**（本地临时 id，`c` 前缀的 `clientId` 复用规则 `src/studio-shared.ts:408-429`），抽屉自动打开并聚焦 prompt。点「生成」时：

1. 若节点还只是占位（未落盘）→ 先发一次 `save-task`（`status` 只能是 `failed|interrupted`，所以占位态**不入库**，见 §7.3 的 DD6 备注）——这里需要一个新决定，见 §16.1 待决策 Q2：「占位的草稿任务节点是否落盘」。
2. 发 `/studio/generate`，带 `clientId`、`board`、`parents`（当前节点若是有出身的派生节点）。
3. 成功后按 DD5 原地转图片节点 + 扇出。

### 7.5 保存语义（WD9）

| 数据 | 保存触发器 | 线缆 | 与 700ms 防抖的关系 |
|---|---|---|---|
| 节点**几何**（x/y、相机） | 拖拽停下后 700ms 防抖（现状 `src/studio-view.ts:1508-1516`），卸载时 flush | `{action:'layout', items[], camera}` | 保持不变（DD12 增量保存口径） |
| 节点**属性**（prompt/steps/ratio/…） | 字段失焦立即保存 + 输入停止 300ms 兜底（防「打完字直接点别处且没失焦」） | `{action:'save-task'}` | **独立一条线**，不并进 layout 请求：layout 只接受坐标与相机（`src/studio-shared.ts:663-666`），塞属性进去要改契约且会让每次拖拽都重传几 KB 的 prompt |
| 布局**草稿** | 编辑器内部 onChange 后 700ms 防抖（现状口径，`src/studio-view.ts:1508` 注释） | `{action:'save-layout-node', draft, w, h}` | 不变 |

**【设计决策】** 属性保存是**乐观写入**：本地 state 立即更新，请求失败时在抽屉顶部给一条可重试的错误条，不回滚用户输入（回滚会让正在打字的人丢掉内容）。冲突处理：同一条目的并发保存按「最后写入者胜」，与 board 现有 `serialized()` 串行化（`src/boards.ts:227`）配合即可。

### 7.6 契约变更

| 变更 | 形态 | 兼容性 |
|---|---|---|
| `save-task` 支持「无 `task.error`、带完整 params」的草稿态 | 若 §16.1 Q2 决定要草稿态，`BoardTaskInfo.status` 需加 `'draft'` | **破坏性**（现有 `status: 'failed'|'interrupted'`，`src/studio-shared.ts:578`）；若决定不要，则不改 |
| `save-task` 支持对**已存在条目**更新 params | 现有 action 已收 `item?`（`:668`），确认路由是否接受对已有 task 条目覆盖 | 需核实（§16.3）→ **已证实接受**（§16.4 N2） |
| 节点级进度 | **不改线缆**：进度不进 board 文件，只在内存 | — |

### 7.7 迁移与测试影响

- 迁移：无需改 board 文件版本（不新增持久字段，除非 Q2 决定引入 `'draft'` 状态）。
- 测试：`test/studio.test.mjs` 里对左栏表单的渲染断言（prompt 输入框、比例选择器、步数输入）**全部改为对抽屉的断言**；新增「选中节点 → 抽屉出现」「失焦即保存」「保存失败不回滚」三组；`test/boards.test.mjs` 加 `save-task` 覆盖已存在条目的用例。

---

## 8. 节点详情页签

### 8.1 现状

- 布局编辑器以**内嵌**方式挂在画布节点上：`mountLayoutEditor(host, {draft, onChange})`（`src/studio-view.ts:1073-1081`），节点 id 变化或卸载时 `destroy()`（`:1088-1100`），失败时只在节点上显示错误（`:1115-1119`）。
- `pointerScale` **没有传**，默认 1（`src/layout-editor.ts:1326-1331`）。这是对的：拖拽 delta 用编辑器自身 `getBoundingClientRect()` 换算，对祖先 transform 的缩放**已经不变**（`src/layout-editor.ts:779-786`）。
- 任务节点没有「完整参数与历史」界面，只有节点卡片上的标题行（`src/studio-view.ts:928` 的 `taskPromptLine`）。
- 图片节点没有大图查看（导出走 Blob 下载，`:592` 的注释说明 `window.open` 会被拦）。

### 8.2 三类详情页签

| 节点类型 | 详情页签内容 | 复用 |
|---|---|---|
| `layout` | **大尺寸布局编辑器**（全宽 × 剩余高度）+ 顶部工具栏（编译/导出 JSON、生成、保存状态） | `mountLayoutEditor`（`src/layout-editor.ts:1219`），`pointerScale` 保持默认 1（非画布场景，无祖先缩放） |
| `task` | 完整参数表单 + 该节点的 run 历史（时间/耗时/错误/输出） + 重试 | 参数组件与 §7.3-B 共用（同一份表单组件，两种容器） |
| `image` | 大图查看（适应窗口/1:1/缩放）+ 右侧信息栏（prompt/ratio/seed/父子血缘/文件路径）+ 「复制参数」「作为参考」 | 图片字节走 `/studio/file`（`src/studio-routes.ts:461`） |

页签标题：`布局 · <项目名>` / `任务 · <prompt 首行>` / `图片 · <时间>`。**【设计决策】** 标题里的节点名一律从数据算（`taskPromptLine` 那种首行截断），不额外引入用户命名图层。

### 8.3 来源画布引用

- 每个详情页签自带面包屑：`项目名 › 画布 › 节点类型`，点「画布」激活来源 `canvas:<boardId>` 页签并 `centerOn` 该节点（`src/studio-canvas.ts:194`）。
- 来源画布已关闭（页签被关但节点详情还在）：面包屑降级为纯文本 + 「重新打开项目」按钮。

### 8.4 同一份数据的双写问题（WD10）

布局节点是唯一真正会双写的对象：画布节点内嵌编辑器 + 详情页签编辑器，**两个 `mountLayoutEditor` 实例操作同一份 draft**，各自 `onChange` 都往同一处 `onDraft` 写 → 后写的覆盖前写的，中间态互相覆盖。

**目标设计（单一数据源 + 单一编辑主体）**：

1. **数据源唯一**：draft 只存在于画布页签的 board store（一个 `Map<itemId, BoardLayoutDraft>`）；`mountLayoutEditor` 是**受控外壳**——它拿到 draft 的副本用于渲染，变更以 `onChange(draft)` 上抛。
2. **编辑主体唯一**：某个 layout 节点**同时只被一个编辑器实例挂载**。规则：
   - 未打开详情页签 → 画布节点内嵌编辑器是编辑主体（现状行为）；
   - 打开详情页签 → **画布节点内的编辑器卸载**，节点显示只读缩略（把 draft 渲染成一张静态缩略：条目框 + 文本占位，不做交互），编辑主体是详情页签；
   - 关闭详情页签 → 画布节点重新挂载编辑器，用最新 draft。
3. 这需要 `mountLayoutEditor` 提供只读预览能力，或由外壳用 draft 数据直接画缩略（**推荐后者**：不扩编辑器 API，只加一个 `LayoutThumb` 纯渲染组件，吃 `BoardLayoutDraft`）。此点列入 §16.1 Q3 待确认（若希望复用编辑器渲染，需给 `mountLayoutEditor` 加 `readOnly` 选项，改动 `src/layout-editor.ts`）。
4. 保存仍按 §7.5：draft 变更 700ms 防抖 → `save-layout-node`。两个容器不并存，所以不会出现「两个实例各存一次」。

### 8.5 与画布设计 D7 的冲突处理

画布设计 D7 明确「MOSS 布局编辑器做成画布内布局节点（不是独立页签）」；本次 D13 说「复杂控制开新标签，典型例子是 MOSS 布局控制节点」。两者**部分冲突**，本文的调和口径：

- **保留** D7 的核心成果：布局仍是**画布上一等节点**（可摆放、可连线、可生成、可持久化），不是弹窗也不是另一个面板；
- **改变** D7 的编辑器容器：从「内嵌可交互」改为「节点内缩略 + 详情页签全尺寸编辑」；
- 触发条件是节点尺寸（208×240 世界单位，`:30-32`）装不下精确编辑的事实——D7 落地时用内嵌方案是对的（当时没有页签外壳），D13 提供了更好的容器。**这不是推翻 D7，是给它换容器**。此口径需协调者在并入执行计划时确认（§16.2）。

### 8.6 迁移与测试影响

- 迁移：无数据变更。
- 测试：`test/layout-editor.test.mjs` 不受影响（纯函数 + 编辑器内部）；`test/studio.test.mjs` 里「画布节点内嵌编辑器」的断言要改为「详情页签内挂载编辑器」；新增「双写防护」用例：模拟详情页签打开时画布节点不挂编辑器（可用一个 mount 计数断言）。

---

## 9. 素材的归位

### 9.1 现状

素材是面板内三个视图之一（`view === 'assets'`，`src/studio-view.ts:1161`、`:4166-4186`），带作用域开关 `assetScope: 'board' | 'all'`（`:1206`，渲染分支 `:1598`、`:4295`）。路由 `/studio/assets` 的查询凭据是 `AssetQuery{ board?, q?, limit? }`（`src/boards.ts:159-163`），返回 `AssetPage{ assets, boards, total }`（`:166-171`）；`board` 缺省即「全部板」。跨板复制/移动与外文件导入在 C12 已做（`copy-item`/`move-item` + `/studio/import`）。

### 9.2 两种素材的语义区分（WD11）

新外壳下必须把「一个视图里两种作用域」拆成两处，否则页签切换会把这个隐式开关带进不一致状态：

| 素材形态 | 归属页签 | 语义 | 查询 |
|---|---|---|---|
| **项目内素材**（当前画布条目） | `canvas:<boardId>` 的素材抽屉 | 这个项目里已摆上的东西，可拖回画布、可作为参考指派给节点 | `{ board: <id> }` |
| **全局素材库**（跨项目） | `projects` 页签的「全局素材」入口（主视图的一个子视图，不是页签） | 所有项目产出的图，可导入到任意项目 | `{}` 或 `{ q }` |

**【设计决策】** 全局素材库**不做成独立页签**：它是「项目管理」的一个子视图（页签内二级切换），因为它属于「项目之外的操作台」，与项目列表同层级；做成独立页签会让页签条出现两个「非项目」类页签，语义重复。

### 9.3 交互

- 画布页签内点顶栏「素材」→ 右侧滑出素材抽屉（与属性抽屉同一定位系统，互斥），抽屉顶部有「本项 12 张 / 全部 380 张」的作用域切换（保留现状语义，但默认 `board`）。
- 拖拽：素材→画布 = `copy-item`（跨板）或本地放置（同板）；素材→属性抽屉的参考图槽 = 记为 `references[{path}]`（`src/studio-shared.ts:342-359`，走 path 不传字节）。
- 导入：任意入口都走 `/studio/import`（`src/studio-routes.ts:382`），body 上限与字节校验不变（`:378-381`）。

### 9.4 契约变更

无。素材两处作用域都用现有 `AssetQuery`；若全局素材库需要「按项目分组显示」，`AssetPage.boards` 已回全部 `BoardSummary`（`src/boards.ts:166-171`），前端可自行归组。

### 9.5 迁移与测试影响

- 迁移：无。行为变更：`view === 'assets'` 不再是一个同级 tab，相关渲染断言要改写。
- 测试：素材作用域断言（`test/studio.test.mjs` 的 assets 段）改为「画布页签内抽屉默认 board 作用域」+「projects 页签全局素材 = 无 board 参数」。

---

## 10. 全局单例资源与多页签渲染

### 10.1 单例清单（WD12）

多画布页签最容易出的事故是「每个页签各开一条 SSE、各轮询一次环境、各有一份撤销栈」，结果事件重复、状态互相打架。

| 资源 | 现状 | 多页签目标 | 单例归属 |
|---|---|---|---|
| SSE `/studio/events` | 面板实例内一条，卸载关闭（`src/studio-view.ts:1410-1428`） | **全外壳一条**，在页签层挂载（页签内容外），按事件的 `boardId` 分发 | `WorkbenchStore`（外壳级） |
| run 注册表（服务端） | 会话级单例（`src/runs.ts:139` `createRunRegistry`，`:106-113`） | 不变（服务端本来就一份） | 服务端 |
| 环境探测 / config 快照 | `loadConfig()` 随面板调用 | **一次探测、全外壳共享**；画布页签切换不重探；stepper 与顶栏读同一份 | `WorkbenchStore.config` |
| 撤销栈 | 每个画布一份 `CommandStack`（`src/canvas-interactions.ts:384`，上限 100 `:44`） | **每个画布页签一份**（按 boardId 分桶），不是全局一份——跨板撤销没有语义 | 每 board 的 `CanvasStore` |
| 任务进度 | 单一 `LiveProgress`（`src/studio-view.ts:1156`） | 按 `boardId` / `clientId` 分桶的 `Map` | `WorkbenchStore.runs` |
| 选中/框选/菜单 | 面板 state | 按 boardId 分桶（非激活页签保留自己的选中） | 每 board 的 `CanvasStore` |

**【设计决策】** 事件分发规则：事件自带 `boardId` 时直接投递到该板的桶（`src/runs.ts:116-127` 已保证 `run` 事件带 `clientId`+`boardId?`）；不带 `boardId` 时用本地 `promptId → clientId → boardId` 映射补（现有折叠逻辑在 `src/studio-view.ts:776-800`）；两者都缺则投到「当前激活画布页签」并在顶栏摘要里标注「未归属事件」。**不丢事件、不错投**：宁可显示在激活页签，也不要静默丢弃导致任务节点永远转圈。

### 10.2 非激活画布页签的渲染策略（WD13）

| 方案 | 评价 |
|---|---|
| 卸载重挂（切换即销毁 DOM） | 简单，但相机/选中丢失、图片重新加载、一次切换几百毫秒白屏 | **否** |
| 保活 + 继续渲染（所有页签都画） | 多板同时渲染，视口裁剪（`src/studio-canvas.ts:333-438`）也救不了 8 个板的图片解码开销 | **否** |
| **保活但不渲染**（DOM 保留、`hidden` 属性、effect 停摆） | 状态全留、代价只在一份 DOM | **推荐** |

**【设计决策】** 采纳「保活不渲染」：

- 容器 `hidden` 属性（不是 `display:none` 手写样式，语义与可访问性正确：隐藏内容不进无障碍树，正是我们要的）。
- 进入隐藏：取消 `ResizeObserver`（视口 `viewport` state，`src/studio-view.ts:1166`）、暂停 700ms 防抖计时器的**调度**（但先把已脏数据 flush 一次，避免隐藏期间丢改动）、卸载布局编辑器实例。
- 回到可见：重测 `viewport`、按需重算 `visibleNodes`；若该板的 `dirty` 集合非空，恢复防抖。
- **图片 `<img src>` 保留**（浏览器缓存命中，不重新请求字节）。

### 10.3 契约变更

- 无服务端变更。`boardId` 已在 `run` 事件上（`src/studio-shared.ts:889`）；`progress`/`error` 事件是否带 `boardId` 待核实（§16.3）→ **已核实：都带**（§16.4 N1）。
- 客户端新增 `src/workbench-store.ts`（外壳级单例：SSE、config、runs 分桶）+ 每板的 `CanvasStore` 数据（可先内联在外壳 state 里，U 系列按任务拆）。

### 10.4 迁移与测试影响

- 迁移：无。
- 测试：新增「两个画布页签同时打开时，SSE 只建立一次」的断言（可用一个计数版的 EventSource 桩，现有测试已有 EventSource 桩，见 `test/studio.test.mjs:1990-1991` 的 `source.emit`）；新增「事件按 boardId 投递到正确页签」「非激活页签不渲染（hidden 属性）」。

---

## 11. 空状态与引导

### 11.1 首次打开（无项目）

- 落点：`projects` 页签；中部大卡：「还没有项目。项目 = 一块无限画布，你的图、布局和迭代都在里面。」
- 主行动：**新建项目**（主色按钮）→ 见 §5.3。
- 次行动：「导入一张图作为起点」（走 `/studio/import` 到新建板）。
- 若 `config.ready === false`：卡片上方加一条**环境提示**（不是阻断）：文案用 `config.reason`（`src/studio-shared.ts:196-` 的 `reason` 字段，原文即用户语言），主按钮「重新检测」。

### 11.2 无模型（权重未就位）

- 触发：`config.ready === true` 但 `models` 缺（stepper 的 `weights` 步失败；状态投影见 `stepperStepsOf`，`test/studio.test.mjs:1956` 的用例）。
- 文案：「三个权重文件还没就位，现在还不能出图。」行动：**在设置里打开生图配置** + 「重新检测」。
- 位置：`projects` 页签顶部一条可关闭的提示带；画布页签里点「生成」时同样弹一条（不阻断编辑）。

### 11.3 ComfyUI 未就绪

- 触发：`config.ready === false`（`src/studio-shared.ts:196-` 的 `ready`）。
- 文案：「ComfyUI 还没连上（`<endpoint 或 未配置>`）。」
- 行动：**启动 ComfyUI**（环境启停按钮 —— ⚠ 该按钮正由在途任务加入 `src/studio-view.ts` 的状态行/stepper，本节只规定「空态与它读同一份 `config` 与同一个 action 句柄」，具体按钮形态随该任务）；次行动「重新检测」。
- 编辑类操作（摆节点、画布局）**一律不阻断**，只是不能生成——这是画布式产品的关键手感。

### 11.4 无素材

- 画布页签内的素材抽屉空态：「这个项目还没有素材。生成一张，或把图片拖进来。」
- 全局素材库空态：「所有项目产出的图都会出现在这里。」+ 「新建项目」。

**【设计决策】** 四种空态的判定顺序：`config 未就绪` > `无项目` > `无素材`。理由：环境问题是唯一「做什么都没用」的状态，优先告知；素材空态最轻，放最后且不阻断。

### 11.5 契约变更与测试影响

- 契约：无（全部读现有 `StudioConfigResponse`）。
- 测试：四种空态各一条渲染断言；重点是「未就绪时画布编辑仍可用」这一条（防止把整个画布页签当成阻断态）。

---

## 12. 键盘与可达性

### 12.1 现状

画布有一张冻结的快捷键表，按上下文分发（`src/canvas-interactions.ts:470-631` 的 `ShortcutContext` / `resolveShortcut` / `shortcutContext`），画布容器 `tabIndex=0` 才拥有键盘（`src/studio-view.ts:4306-4310`）。输入框内、编辑器内快捷键返回 `none`（`:3252-3262`）。

### 12.2 页签层快捷键（WD14）

| 键 | 行为 | 理由 |
|---|---|---|
| `Ctrl+Alt+ArrowRight` / `Ctrl+Alt+ArrowLeft` | 下一个 / 上一个页签 | **不用** `Ctrl+Tab`：宿主（浏览器/IDE/DSH 面板外壳）普遍占用它，抢占会破坏宿主切换；`Ctrl+Alt+方向`在 Chromium 系里通常空闲 |
| `Ctrl+Alt+1` | 跳到 `projects` 页签 | 一键回项目列表 |
| `Esc` | 关闭当前节点详情页签（仅当页签内容有焦点）；在画布页签内 `Esc` 仍是「取消选择/退出多选」 | 与画布语义不冲突 |
| `Ctrl+W` / `Ctrl+T` / `Ctrl+Tab` | **不绑定**（留给宿主） | 关闭页签不走 `Ctrl+W`，改用页签上的 `×` 与右键菜单「关闭」 |

**【设计决策】** 页签快捷键只在**外壳容器**（`tabIndex=-1`、`role="tablist"`）内生效，且当焦点在输入框/布局编辑器内一律返回 `none`（复用 `shortcutContext` 的判定思路，`src/canvas-interactions.ts:613-641`）。实现上新加一个 `resolveShellShortcut` 纯函数，与画布那张表**分开**，避免把页签键塞进已冻结的 C08 表。

### 12.3 可达性

| 要求 | 实现 |
|---|---|
| 页签语义 | `role="tablist"` + 每个页签 `role="tab"` + `aria-selected`；内容区 `role="tabpanel"` + `aria-labelledby` 指向页签 id |
| 键盘导航 | 页签条内 `ArrowLeft/ArrowRight` 移动焦点、`Enter/Space` 激活（WAI-ARIA tabs 模式）；`Home/End` 到首/末 |
| 关闭按钮 | 页签内独立 `button`，`aria-label="关闭 <名>"`；不可关的 `projects` 不渲染关闭按钮（不是禁用，避免「为什么点不动」） |
| 抽屉 | `role="complementary"` + `aria-label="节点属性"`；打开时焦点进第一个可编辑控件，`Esc` 关闭并把焦点还给画布节点 |
| 图标按钮 | 全部带 `aria-label` + `title`（悬浮动作条的 6 个图标尤其需要） |
| 焦点可见 | 沿用主题的 `:focus-visible`，不自造 outline |
| 读屏播报 | 生成完成/失败用 `aria-live="polite"` 一条摘要（避免逐个节点播报） |

### 12.4 契约变更与测试影响

- 契约：无（纯客户端）。
- 测试：`resolveShellShortcut` 纯函数用例（含「输入框内返回 none」「不吞 Ctrl+Tab」）；页签 ARIA 属性的渲染断言（`role`/`aria-selected`/不可关页签无关闭按钮）。

---

## 13. 与画布引擎替换的隔离边界

### 13.1 现状

画布内核是自研 DOM + CSS transform（`src/studio-canvas.ts`、`src/canvas-interactions.ts`、`src/canvas-export.ts`），全部导出为纯函数 + 一个 `CommandStack` 类，没有框架依赖。这已经是一个不错的接缝，但**渲染与交互目前长在 `studio-view.ts` 里**（07:23 时 4642 行单组件），所以「换引擎」今天等于改那个文件。

> **【实施回填 2026-11-18】** 上面这段描述的是**替换前**的现状。`594457b` 起画布由 **@xyflow/react v12** 渲染（`src/canvas-pane.ts` + `src/canvas-flow-model.ts`），自研 DOM 渲染器仍留在 `studio-view.ts` 里作为「没有画布插槽」时的回退分支，`studio-canvas.ts`/`canvas-interactions.ts`/`canvas-export.ts` 的几何、快捷键表、撤销栈**全部保留复用**——换的是渲染与手势层，不是状态机。§13.2 的三条硬约束对**外壳模块**仍然成立，但对 `canvas-pane.ts` 本身不成立，真实边界见 §13.4。

### 13.2 目标边界（WD15）

```
┌────────────────────────────── WorkbenchShell ─────────────────────────────┐
│  只知道：TabKey / BoardSummary / BoardDetail / BoardItem                   │
│  只调用 6 个回调：                                                          │
│    openProject(boardId) · closeTab(key) · activateTab(key)                 │
│    onBoardChanged(boardId, patch) · onRunEvent(evt) · onDirty(boardId)     │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ props / callbacks（不含任何画布模块 import）
                    ┌───────────▼────────────┐
                    │  CanvasPane（可替换）   │  ← 现在：DOM+transform 实现
                    │  NodeInspector         │  ← 引擎无关（吃 BoardItem）
                    │  NodeDetailPane        │  ← 引擎无关（吃 draft/params）
                    └────────────────────────┘
```

**【设计决策】** 硬约束三条：

1. `src/workbench-view.ts` / `src/workbench-tabs.ts` / `src/workbench-workspace.ts` **不得 import** `studio-canvas.ts`、`canvas-interactions.ts`、`canvas-export.ts`（可用一条测试守：读文件源码断言无这些 import 路径）。
2. 画布能力对外的形状 = `CanvasPaneProps`：`{ board: BoardDetail; camera; selection; onCamera; onSelect; onLayout; onOpenDetail; onGenerate }`。React Flow/tldraw 版本只要能实现同一组 props 就能替换。
3. 导出（JSON/PNG）与布局编辑器**不属于画布引擎**：它们挂在详情页签/顶栏动作上，引擎替换不影响它们。

**【实施回填 2026-11-18】三条约束的实际情况**

| 约束 | 结论 | 真实情况 |
|---|---|---|
| 1. 外壳不得 import 画布内核 | **成立** | `src/workbench-view.ts` / `src/workbench-tabs.ts` 未 import `studio-canvas.ts`、`canvas-interactions.ts`、`canvas-export.ts`，也未 import `@xyflow/react`；它们只 import `canvas-pane.ts` 的 `CanvasPane` |
| 2. 画布能力对外形状 = `CanvasPaneProps` | **改成别的形状了** | 实际 `CanvasPane` 的 props 是 **tab 的 `boardId` + 面板级回调**，画布能力靠 `StudioPanel` 的 `canvas` 插槽传给 studio；`Camera`/`selection`/`onLayout` 这些没有作为 props 穿过外壳 |
| 3. 导出与布局编辑器不属于引擎 | **部分成立** | 导出仍是独立模块；但**布局编辑器仍在画布节点里内嵌挂载**（`mountLayoutEditor`），U06 只是把它在详情页签里再挂一份，没有搬出画布 |

**原说法**：「外壳禁止依赖画布内核，`CanvasPane` 只吃一组 `CanvasPaneProps`，替换只碰一个文件。」
**新事实**：`CanvasPane` **组合** `StudioPanel`（`src/canvas-pane.ts:136` `import { StudioPanel } from './studio-view.ts'`，`:184` `createElement(StudioPanel, …)`），两者**共享同一份 studio 状态**（结果列表、素材页、撤销栈、画板写入器都在 `studio-view.ts`）。`src/canvas-pane.ts:17-33` 对此有明确自述：tab 要拥有自己的 `boardId`，同时又不能把 studio 的面板丢掉，所以「组合而非拆分」，拆出去是 **S5** 的清理工作。

因此**真实的替换边界**是：换引擎只需改 `canvas-pane.ts` + `canvas-flow-model.ts`（加样式与打包配置），`workbench-view.ts`/`workbench-tabs.ts` 不动；但 `studio-view.ts` 仍然是面板的唯一宿主，**它的体积与状态耦合没有因为换引擎而减少**——这正是 §13.1 原本想解决的问题，目前只解决了一半。

### 13.3 与引擎替换的先后（顺序约束）

- 若 React Flow 评估**未定**：U01–U03 照做（不动画布内核，零风险）；U04 抽取时把画布渲染收进 `CanvasPane` 内部、外壳不留任何内核假设——这样将来替换只碰 `CanvasPane` 一个文件。
- 若评估**结论是替换**：**不要**先做「抽取 + 立即换引擎」两次改动；让 U04 与替换合并为一个任务（抽取后的 `CanvasPane` 直接写成新引擎实现），避免同一个渲染路径改两遍。
- 无论哪种，U01–U03 的产物（页签状态机、workspace 持久化、项目管理页签）都**不依赖**画布实现，可先行。

**【实施回填 2026-11-18】** 实际走了**第二条**（U04 与引擎替换合并），并且比预想更细：因为「一次改完」会让一次提交同时动打包、渲染、交互三件不相干的事，最终拆成 **S1a 打包 → S1b 渲染 → S2 交互 → S3 连线 → S4 节点行为** 五步（§14.12）。代价与收益都是实测的：

- **收益**：每一步都能单独回滚，S1b 落地时画布「能看不能动」是已知状态而不是回归；40 条 DOM 用例在 S1b 一次性移出自动化，清单与替代覆盖写在同一处（`test/studio.test.mjs:24-85`）。
- **代价**：计划里「抽取后 `CanvasPane` 只碰一个文件」没有兑现——`CanvasPane` 选择**组合** `StudioPanel` 而不是把它拆掉，于是 U05（删左栏表单）与 U06（详情页签与 `CanvasIntent` 交接）又回头改了两轮 `src/studio-view.ts`，这部分原本是 U04 该做完的。真正把 studio 状态抽出去，是尚未开始的 **S5**。

### 13.4 引擎与打包边界的实测结论（回填）

| 问题 | 实测结论 | 证据 |
|---|---|---|
| React Flow 能否嵌进宿主面板？（原 §16 未核实项） | **能**。`FlowCanvas` 先量容器再挂引擎，随面板尺寸变化重排；引擎样式以内联 CSS 注入，不与宿主样式冲突 | `src/canvas-pane.ts`（`FlowCanvas`）、`src/xyflow-styles.ts` |
| 打包链路 | 客户端 bundle 由 `tsdown.client.config.ts` 打包，`@xyflow/react` **内联进产物**（0 次裸 `require`），并因此移到 `devDependencies`（安装本包的 profile 不该再下载它） | `test/bundle-xyflow.test.mjs:117-121`；`package.json` |
| 宿主模块白名单 | 产物里**仅剩 3 个裸 require**：`react`、`react-dom`、`react/jsx-runtime`——React Flow 本身不需要宿主再提供 | `test/bundle-xyflow.test.mjs:170-171` |
| 体积 | `lib/client.js` **968,219 B / gzip 257,925 B**（纯 CSS 的 S1a 产物是 409,772 B / 108,342 B）；测试里设了 300,000 B gzip 的预算上限 | `test/bundle-xyflow.test.mjs:176-187`；`node -e` 实测 |
| 仓库级副作用 | `.gitignore` 增加仓库级 pnpm store（`.pnpm-store/`），随 `594457b` 入库 | `.gitignore` |

---

## 14. 任务拆分 U01–U10

体例同执行计划：目标 / 前置 / 写入范围（路径粒度）/ 步骤 / 验收（机器判定优先）/ 停止条件。**【设计决策】** 所有 U 任务都**不修改** `docs/DIRECTION-ALIGNMENT.md`、`docs/EXECUTION-PLAN.md`、`docs/CANVAS-DESIGN.md` 与 `docs/WORKBENCH-SHELL.md`（本文只被协调者在并入时更新「状态」列）。

### 14.1 依赖与批次总览

| 批 | 任务 | 前置 | 并行性 | 写入范围（概要） | 与在途/引擎任务的冲突 |
|---|---|---|---|---|---|
| 一 | U01 | 无 | ∥ U02 | `src/workbench-tabs.ts`(新)、`test/workbench-tabs.test.mjs`(新) | 无冲突（全新文件） |
| 一 | U02 | 无 | ∥ U01 | `src/workbench-workspace.ts`(新)、`src/boards.ts`、`src/studio-shared.ts`、`src/studio-routes.ts`、`test/workbench-workspace.test.mjs`(新)、`test/boards.test.mjs` | 与在途任务（改 `studio-view.ts`）不冲突；**与 U07 共享三文件 → U02 先、U07 后，串行** |
| 二 | U03 | U01、U02 | ∥ U07（文件不重叠） | `src/workbench-view.ts`(新)、`src/workbench-projects.ts`(新)、`src/client.ts`、`src/client-styles.ts`、`test/workbench-shell.test.mjs`(新)、`test/settings.test.mjs` | 不碰 `studio-view.ts`；若在途任务同时改 `client-styles.ts` 需串行（**先核对该文件是否被占用**） |
| 二 | U07 | U02 | ∥ U03 | `src/boards.ts`、`src/studio-shared.ts`、`src/studio-routes.ts`、`src/workbench-projects.ts`、`test/boards.test.mjs`、`test/workbench-projects.test.mjs`(新) | 与 U02 同文件 → 串行；与 U03 在 `workbench-projects.ts` 上相交 → **U03 先落、U07 接** |
| 三 | U04 | U03、**在途任务已提交** | 独占（串行） | `src/studio-view.ts`、`src/canvas-pane.ts`(新)、`src/workbench-store.ts`(新)、`src/workbench-view.ts`、`src/client-styles.ts`、`test/studio.test.mjs`、`test/workbench-store.test.mjs`(新) | ⚠ **与在途任务（环境启停/状态行/stepper）同文件 `studio-view.ts` → 必须等其提交** |
| 四 | U05 | U04 | ∥ U09 | `src/node-inspector.ts`(新)、`src/canvas-pane.ts`、`src/client-styles.ts`、`test/workbench-inspector.test.mjs`(新)、`test/studio.test.mjs` | `canvas-pane.ts` 与 U06/U08 相交 → 串行链 U05→U08、U05→U06 |
| 四 | U09 | U04 | ∥ U05 | `src/workbench-shortcuts.ts`(新)、`src/workbench-view.ts`、`src/canvas-pane.ts`、`src/client-styles.ts`、`test/workbench-shell.test.mjs`、`test/workbench-store.test.mjs` | 与在途任务**部分重叠**：环境状态/启停的接线要读它的产物，接 U04 之后做 |
| 五 | U06 | U05 | ∥ U08（文件相交，实际串行） | `src/node-detail-pane.ts`(新)、`src/canvas-pane.ts`、`src/workbench-tabs.ts`、`src/client-styles.ts`、`test/workbench-nodetab.test.mjs`(新)、`test/studio.test.mjs` | 若引擎替换进行中，详情页签里的布局编辑器不受影响（引擎无关） |
| 五 | U08 | U05、U03 | 串行于 U06（同改 `canvas-pane.ts`） | `src/workbench-assets.ts`(新)、`src/canvas-pane.ts`、`src/workbench-projects.ts`、`src/client-styles.ts`、`test/workbench-assets.test.mjs`(新) | 无服务端改动 |
| 六 | U10 | U06、U07、U08、U09 | 独占 | `src/canvas-pane.ts`、`src/workbench-view.ts`、`src/client-styles.ts`、`docs/usage-reference.md`、`docs/testing.md`、`test/*`（收尾） | 收口批：全部冲突处置与文档同步在这里 |

**文件级互斥表（同一文件的写入必须串行）**

| 文件 | 串行顺序 |
|---|---|
| `src/studio-shared.ts`、`src/boards.ts`、`src/studio-routes.ts` | U02 → U07 |
| `src/studio-view.ts` | 在途任务 → U04（此后该文件应只剩注册/薄壳，后续任务不再改） |
| `src/canvas-pane.ts` | U04 → U05 → U06 → U08 → U09 → U10（单线，无并行） |
| `src/workbench-view.ts` | U03 → U04 → U09 → U10 |
| `src/workbench-tabs.ts` | U01 → U06 |
| `src/workbench-projects.ts` | U03 → U07 → U08 |
| `src/client-styles.ts` | 所有 UI 任务都会碰 → **按批次串行**（建议每批一人） |
| `test/studio.test.mjs` | U04 → U05 → U06 → U10 |

### 14.2 U01 — 页签状态机（纯函数）

- **目标**：把 §3 的页签规则做成无 DOM、无 React 的纯函数模块，全部边界用单测钉死。
- **前置**：无。
- **写入范围**：`src/workbench-tabs.ts`（新）、`test/workbench-tabs.test.mjs`（新）。
- **步骤**：定义 `TabKey` 与解析/构造（`projects` / `canvas:<id>` / `node:<id>:<id>`）；实现 `openTab` / `closeTab`（含连带关闭 node 页签）/ `activateTab`（含左邻回退）/ `rebuildOrder`（§4.3 的集合不一致修复）/ `isTabAllowed`（上限 8/16）；导出 `MAX_CANVAS_TABS=8`、`MAX_TABS=16`。
- **验收（机器判定）**：`node --test test/workbench-tabs.test.mjs` 通过；用例覆盖：①关画布连带关其 node 页签；②关激活页签回退到左邻、无左邻回退右邻、都无则 `projects`；③重复打开同一个 board 不新增页签；④超上限返回拒绝且顺序不变；⑤node 页签关闭不影响画布；⑥`rebuildOrder` 对「集合不一致」输入产出 `projects` 在首、相对顺序保留。
- **停止条件**：需要改 React/画布代码才能表达某条规则（说明规则没抽干净）→ 停，回到 §3 补规则。

### 14.3 U02 — workspace 持久化与迁移

- **目标**：落地 §4 的 `workspace.json` v1 + 两个 action + 旧 `state.json` 迁移。
- **前置**：无。
- **写入范围**：`src/workbench-workspace.ts`（新）、`src/boards.ts`、`src/studio-shared.ts`、`src/studio-routes.ts`、`test/workbench-workspace.test.mjs`（新）、`test/boards.test.mjs`。
  <br>**【实施回填】** `402e71a` 实际**没有新建** `src/workbench-workspace.ts`：schema 的类型与降级逻辑落在 `src/boards.ts` 的 `readWorkspaceFile`（`src/boards.ts:554`）/ `writeWorkspaceFile`（`:572`），两个 action 走 `src/studio-routes.ts`，`test/workbench-workspace.test.mjs` 新建（7 用例）；`test/boards.test.mjs` 未改。
- **步骤**：①`src/workbench-workspace.ts` 写 schema 类型 + `normalizeWorkspace`（逐项降级，§4.3 表）+ `migrateLegacyState`（§4.4）；②`boards.ts` 加 `readWorkspace`/`writeWorkspace`（原子写 + `serialized`）；③`StudioBoardRequest.action` 加 `workspace-get`/`workspace-set`，`parseBoardAction` 校验同步；④`state.json` 继续由 `setActiveBoard` 维护（不改行为）。
- **验收（机器判定）**：`npm test` 全绿；新用例覆盖：①无文件 → 空 workspace；②`{"active":"b_x"}` 旧文件 → `openProjects:["b_x"]` 且 `activeTab.kind==='canvas'`；③`version:2` → 空 workspace + 提示字段；④坏 JSON / 坏字段 → 逐项丢弃且不抛；⑤超过上限截断；⑥往返读写字节级稳定（同输入两次 normalize 结果相等）；⑦`workspace-get` 在无文件时返回 `workspace:null`（**不写盘**，用目录时间戳断言）。
- **停止条件**：需要改 `state.json` 的形状才能完成（说明违反了 WD4 的解耦口径）→ 停。

### 14.4 U03 — 外壳组件 + 项目管理页签

- **目标**：页签条 + 两个页签类型（`projects` 与占位 `canvas`），注册进宿主；默认落在项目管理。
- **前置**：U01、U02。
- **写入范围**：`src/workbench-view.ts`（新）、`src/workbench-projects.ts`（新）、`src/client.ts`、`src/client-styles.ts`、`test/workbench-shell.test.mjs`（新）、`test/settings.test.mjs`。
- **步骤**：①`WorkbenchShell` 组件：`role="tablist"` 页签条 + `tabpanel` 容器 + 读 `workspace-get` 决定初始页签；②`ProjectsPane`：卡片网格（封面走 `/studio/file`、条目数、相对时间）、新建/重命名/删除（§5.3，`duplicate` 留给 U07）、搜索、排序、空态（§11.1）；③`client.ts` 把注册的面板组件从 `studio-view` 换成 `workbench-view`（**不改 studio-view.ts**，画布页签先渲染一个「打开中…」占位或直接挂现有 Studio 组件作为临时画布页签）；④样式：页签条复用 `.dsh-image-forge-tabs`（`src/client-styles.ts:204-232`）的视觉语言，新增 `.dsh-forge-workbench-*` 命名空间。
  <br>**【实施回填 2026-11-18】** 实际走的是**第二种**：`ca17a4f` 的画布页签**直接挂现有 `StudioPanel`**（当时该组件不接 props），**没有**出现过「打开中…」占位；`8775a93` 之后 `594457b` 把这里的 `StudioPanel` 换成了 `CanvasPane`（React Flow 12 渲染 + 把 tab 的 `boardId` 传下去）。原文「占位」二字与实际不符，以本条为准。
- **验收（机器判定）**：①渲染断言：初始 `aria-selected="true"` 的页签是「项目管理」且存在；②点卡片 → 出现 `canvas:<id>` 页签且激活；③关画布页签 → 回 `projects`；④`projects` 页签**没有**关闭按钮；⑤重新挂载后按 `workspace.json` 恢复（与 U02 的迁移用例联动）；⑥`test/settings.test.mjs` 的座位断言仍通过（座位不变，组件变了）。
- **停止条件**：需要改 `src/studio-view.ts` 才能完成（说明页签层与画布层耦合未完）→ 停，把耦合点写进 §13 边界清单后再来。

### 14.5 U04 — 画布页签抽取 + 单例 store

- **目标**：把画布/结果区从 `studio-view.ts` 抽成 `CanvasPane`，SSE/config/runs 上提到外壳 store，多页签保活不渲染。
- **前置**：U03，且**在途任务（`studio-view.ts` 状态行/stepper/环境启停）已提交**。
- **写入范围**：`src/studio-view.ts`、`src/canvas-pane.ts`（新）、`src/workbench-store.ts`（新）、`src/workbench-view.ts`、`src/client-styles.ts`、`test/studio.test.mjs`、`test/workbench-store.test.mjs`（新）。
  <br>**【实施回填】** U04 实际拆成 **S1a 打包 → S1b 渲染 → S2 交互 → S3 连线 → S4 节点行为**五步分别提交（见 §14.12 表），并且**把引擎替换合并进来了**（走了 §13.3 的第二条路：不自研 DOM 直扩，直接换 **@xyflow/react v12**）。因此实际写入范围比计划多出：`src/canvas-flow-model.ts`（新，纯函数 ×3 组）、`src/xyflow-styles.ts`（新）、`tsdown.client.config.ts`、`pnpm-lock.yaml`、`test/canvas-flow-model.test.mjs`（新）、`test/bundle-xyflow.test.mjs`（新）、`test/harness.mjs`、`.gitignore`；而 **`src/workbench-store.ts` 与 `test/workbench-store.test.mjs` 至今未创建**——store 上提、多页签保活、`EventSource` 单条都还留在未开始的 **S5** 里，当前外壳仍只挂载激活页签的画布（`src/workbench-view.ts:26-28` 自述该约束）。
- **步骤**：①机械抽取画布视图 + 列表视图 + 画板管理到 `CanvasPane`，props 按 §13.2 的 `CanvasPaneProps`；②`WorkbenchStore`：单条 `EventSource`（现状 `src/studio-view.ts:1410-1428`）+ config 快照 + runs 分桶 + 每板脏集合；③SSE 分发按 `boardId`（§10.1），无 `boardId` 时用 `promptId→clientId` 映射；④多页签挂载策略（`hidden` + 卸载布局编辑器 + flush 脏数据，§10.2）；⑤`studio-view.ts` 缩为「注册 + 委托」。
- **验收（机器判定）**：①`EventSource` 构造计数 === 1（两个画布页签同时打开）；②事件只投递到目标板的桶（断言另一板状态未变）；③非激活页签容器有 `hidden` 属性且无 `ResizeObserver` 回调触发（可用桩计数）；④切换页签后相机与选中保持；⑤现有 `test/studio.test.mjs` 只改「如何挂载」而不改断言语义，全绿。
- **停止条件**：抽取过程中发现画布逻辑与表单逻辑**双向耦合**（例如表单直接读 `nodes`）→ 停，先补 §7 的属性边界，再继续抽取。

### 14.6 U05 — 节点属性抽屉（替代左半表单）

- **目标**：按 §7 实现 `NodeInspector`，删除左半表单从画布页签的呈现。
- **前置**：U04。
- **写入范围**：`src/node-inspector.ts`（新）、`src/canvas-pane.ts`、`src/client-styles.ts`、`test/workbench-inspector.test.mjs`（新）、`test/studio.test.mjs`。
  <br>**【实施回填】** `a29ebfc` 实际改了：`src/node-inspector.ts`（新，977 行）、`src/canvas-pane.ts`（+26/-）、`src/client-styles.ts`、`test/studio.test.mjs`（+357），**外加计划里没列的 `src/studio-view.ts`（+557/-）与 `lib/client.js`**——左半表单的渲染就在 `studio-view.ts` 里，删它等于改那个文件，这是 U04 没有真正把状态抽出去的连带结果（同一原因推迟到 S5）。**`test/workbench-inspector.test.mjs` 没有创建**：抽屉的用例全部并入 `test/studio.test.mjs`。行为口径不变：**画布页签内**已无左栏表单，列表/素材页签仍保留旧表单。
- **步骤**：①抽屉容器（`role="complementary"`，宽 320，浮在画布层**外**）；②三类节点的字段分组（§7.3 A/B/C）；③保存线：失焦即存 + 300ms 兜底，`save-task` 写 `params`；④乐观写入 + 失败错误条（不回滚）；⑤新建节点入口（双击空白 / 右键 → 占位 → 抽屉聚焦 prompt）。
- **验收（机器判定）**：①选中 1 个节点 → 抽屉出现且 `aria-label="节点属性"`；多选/无选中 → 不存在；②改 prompt 失焦 → 发一次 `save-task`（fetch 桩断言 payload 含新 prompt、旧 prompt 不出现）；③保存失败 → 输入值仍在（不回滚）+ 错误条可见；④抽屉不随画布 zoom 缩放（断言它不在 transform 层内）；⑤左栏表单元素在画布页签内**不存在**（断言旧选择器查不到）。
- **停止条件**：需要给 `BoardItem` 新增可编辑持久字段才能完成（违反 §7.3 的两宿主口径）→ 停，回 §7 讨论。

### 14.7 U06 — 节点详情页签

- **目标**：`node:<boardId>:<itemId>` 页签 + 三类详情 + 双写防护。
- **前置**：U05。
- **写入范围**：`src/node-detail-pane.ts`（新）、`src/canvas-pane.ts`、`src/workbench-tabs.ts`、`src/client-styles.ts`、`test/workbench-nodetab.test.mjs`（新）、`test/studio.test.mjs`。
  <br>**【实施回填】** `c59b8ea` 实际改了：`src/node-detail-pane.ts`（新，1112 行）、`src/canvas-pane.ts`、`src/node-inspector.ts`、`src/client-styles.ts`、`test/studio.test.mjs`（+534）、`test/workbench-shell.test.mjs`（+269），**外加计划里没列的 `src/workbench-view.ts`（+221，页签条与 `node:` 页签的挂载在这里）与 `src/studio-view.ts`（+148，`CanvasIntent` 一次性交接）**。**`src/workbench-tabs.ts` 一行未改**——双写防护没有改状态机，而是做在两层：画布侧按「详情页签是否开着」降级成只读缩略（`detailOpen`），页面侧用 `DetailEditorClaims` 拒掉同一节点的第二次 `mountLayoutEditor`。**`test/workbench-nodetab.test.mjs` 没有创建**，用例并入上面两个测试文件。
- **步骤**：①页签打开/关闭/面包屑（§8.3）；②布局：全尺寸 `mountLayoutEditor`（`pointerScale` 保持默认 1）+ 工具栏（编译/生成/保存状态）；③画布侧 layout 节点改只读 `LayoutThumb`（`draft` → 静态缩略，不挂编辑器）；④任务：参数表单（与 U05 共用组件）+ 历史；⑤图片：大图 + 信息栏。
- **验收（机器判定）**：①选中 layout 节点开详情 → 画布内 `mountLayoutEditor` 调用次数为 0（桩计数），详情页签内为 1；②关闭详情页签 → 画布内挂载恢复 1；③`mountLayoutEditor` 收到的 `pointerScale` 未传或为 1；④面包屑「画布」按钮激活来源 `canvas:` 页签；⑤来源画布关闭后页签仍可用（降级面包屑）。
- **停止条件**：需要给 `layout-editor.ts` 加 `readOnly`/多实例同步才能完成（说明双写防护方案不成立）→ 停，回 §8.4 与 §16.1 Q3。

### 14.8 U07 — 项目能力补齐（duplicate / bytes / 删除确认）

- **目标**：§5.5 的 API 缺口 + §5.4 删除语义。
- **前置**：U02（同文件串行）、U03（`workbench-projects.ts` 已有卡片）。
- **写入范围**：`src/boards.ts`、`src/studio-shared.ts`、`src/studio-routes.ts`、`src/workbench-projects.ts`、`test/boards.test.mjs`、`test/workbench-projects.test.mjs`（新）。
- **步骤**：①`duplicateBoard`（复制 items/camera、名称「副本」、受上限约束）；②路由 `{action:'duplicate'}`；③`BoardSummary.bytes?`（`stat` 板文件，失败则缺省）；④删除确认 UI（条目数 + 是否连图）。
- **验收（机器判定）**：①duplicate 后新板 `items.length` 与原板相等、`camera` 相等、`id` 不同、`MAX_BOARDS` 达上限时报错；②`bytes` 为板文件字节数（与 `stat` 一致），文件缺失时为 `undefined` 而非 0；③删空板只要一次确认、删非空板必须选「是否连带删图」才可提交；④`npm test` 全绿。
- **停止条件**：duplicate 需要复制 PNG 才能满足验收（与本设计的共享引用口径冲突）→ 停，回 §5.5 决策。

### 14.9 U08 — 素材归位

- **目标**：§9 的两处素材（画布抽屉 / 全局素材库）。
- **前置**：U05（抽屉定位系统）、U03（`projects` 页签）。
- **写入范围**：`src/workbench-assets.ts`（新）、`src/canvas-pane.ts`、`src/workbench-projects.ts`、`src/client-styles.ts`、`test/workbench-assets.test.mjs`（新）。
- **步骤**：①画布页签素材抽屉（默认 `board` 作用域，可切 `all`）；②`projects` 页签的全局素材子视图（无 board 参数）；③拖拽落画布（`copy-item`/本地放置）；④参考指派（写 `references[{path}]`）；⑤导入入口复用 `/studio/import`。
- **验收（机器判定）**：①画布抽屉首次打开请求带 `board=<当前板>`；②全局素材请求**不带** board；③跨板拖拽发出一次 `copy-item` 且目标板条目 +1；④参考指派后任务节点 `params.references` 含该 path；⑤三种导入源都走同一路由（fetch 桩断言 URL）。
- **停止条件**：素材要新增服务端聚合能力才能实现（现有 `/studio/assets` 不够）→ 停，回报缺口。

### 14.10 U09 — 空状态、键盘与节点级进度

- **目标**：§11 四态 + §12 键盘/可达性 + §6.4 节点级进度摘要。
- **前置**：U04（store 与 runs 分桶）；环境状态/启停的接线依赖在途任务产物。
- **写入范围**：`src/workbench-shortcuts.ts`（新）、`src/workbench-view.ts`、`src/canvas-pane.ts`、`src/client-styles.ts`、`test/workbench-shell.test.mjs`、`test/workbench-store.test.mjs`。
- **步骤**：①四种空态组件与判定顺序（`config` > 无项目 > 无素材）；②`resolveShellShortcut` 纯函数 + 页签条 ARIA/键盘导航；③节点进度环 + 顶栏摘要；④`aria-live` 完成/失败播报。
- **验收（机器判定）**：①`resolveShellShortcut` 在输入框上下文返回 `none`、不响应 `Ctrl+Tab`；②空态判定顺序用例（未就绪 + 有项目 → 只显示环境提示）；③未就绪时画布仍可摆节点（无阻断层）；④运行中任务节点显示百分比（SSE 桩喂 `progress` 事件）；⑤页签 ARIA 断言（`role`/`aria-selected`/不可关页签无关闭按钮）。
- **停止条件**：环境启停按钮的最终形态未定而无法接线 → 停在该子项，先交付其余部分并注明「环境空态待接线」。

### 14.11 U10 — 收口与文档同步

- **目标**：删残余、改既有测试、同步文档、跑全量。
- **前置**：U06、U07、U08、U09。
- **写入范围**：`src/canvas-pane.ts`、`src/workbench-view.ts`、`src/client-styles.ts`、`docs/usage-reference.md`、`docs/testing.md`、`test/*`（收尾）。
- **步骤**：①删除 `studio-view.ts` 中的死代码与旧表单残余（若还留着）；②按 §15.3 改既有测试；③`docs/usage-reference.md` 更新使用路径（工作台 → 项目 → 画布 → 节点）；④`docs/testing.md` 的反向断言同步（若涉及）；⑤`npm test` 全量 + 手测清单（见 §15.4）。
- **验收（机器判定）**：①`npm test` 全绿（23+ 文件、用例数不低于当前 411）；②`grep -r "dsh-forge-view-toggle" src/` 无命中（旧三 tab 已删）或仍在使用处有注释说明；③`docs/usage-reference.md` 无「左侧填写参数」字样；④新测试文件全部进 `package.json` 的 `test` 串（`package.json:57`）。
- **停止条件**：发现某面设计在实现中已偏离本文（且偏离更合理）→ 停，回报偏离点，由协调者决定回写本文还是回退实现。

### 14.12 实施进度（2026-11-18 回填）

> 本节由实施侧在 U06 落地后回填。

**一句话**：U01–U06 已全部落地并通过全量测试；U07–U10 未开始；U04 在开工时被拆成五步，且**换了画布引擎**（这一步原设计没有预见，见 §13.4）。

| 任务 | 状态 | 提交 | 落地要点 |
|---|---|---|---|
| U01 页签状态机 | ✅ 已提交 | `f789729` | `src/workbench-tabs.ts`（832 行，纯函数）+ `test/workbench-tabs.test.mjs`（681 行）；29 用例 |
| U02 workspace 持久化 | ✅ 已提交 | `402e71a` | `src/boards.ts` 的 `readWorkspaceFile`/`writeWorkspaceFile` + `workspace-get`/`workspace-set` 两个 action + 旧 `state.json` 惰性迁移；7 用例。**未新建 `workbench-workspace.ts`** |
| U03 外壳 + 项目管理页签 | ✅ 已提交 | `ca17a4f` + `30780c1` | `src/workbench-view.ts`、`src/workbench-projects.ts`；测试基座抽到 `test/harness.mjs`（`30780c1`），13 用例 |
| U04 画布页签抽取 | ✅ 已提交（拆五步） | `bf21f44` / `594457b` / `44ee33e` / `3a27630` / `e4343a0` | **引擎换成 @xyflow/react v12**；`CanvasPane` 组合 `StudioPanel`；store/多页签保活**未做**，留给 S5 |
| U05 节点属性抽屉 | ✅ 已提交 | `a29ebfc` | `src/node-inspector.ts`（977 行）；**画布页签内的左栏表单已移除**（列表/素材页签保留旧表单） |
| U06 节点详情页签 | ✅ 已提交 | `c59b8ea` | `src/node-detail-pane.ts`（1112 行）；布局节点全尺寸编辑器 + 双写防护（画布侧缩略降级 + 页面侧 `DetailEditorClaims` claim） |
| U07 项目能力补齐 | ⬜ 未开始 | — | `duplicate` / `bytes` / 删除确认仍缺 |
| U08 素材归位 | ⬜ 未开始 | — | 无 `src/workbench-assets.ts` |
| U09 空状态/键盘/节点级进度 | ⬜ 未开始 | — | 无 `src/workbench-shortcuts.ts` |
| U10 收口与文档同步 | ⬜ 未开始 | — | 本节即由协调者代做的一次文档同步，不等于 U10 |

**U04 的五步拆分与实际范围**

| 步 | 提交 | 范围 |
|---|---|---|
| S1a 打包 | `bf21f44` | `@xyflow/react` 进客户端产物：`tsdown.client.config.ts`、`src/xyflow-styles.ts`（新）、`test/bundle-xyflow.test.mjs`（新）、`package.json`、`pnpm-lock.yaml` |
| S1b 渲染 | `594457b` | `src/canvas-flow-model.ts`（新，纯函数）+ `src/canvas-pane.ts`（新）+ `StudioPanel` 新增 `canvas` 插槽；`test/canvas-flow-model.test.mjs`（新）；**40 条画布 DOM 用例移出自动化**（清单见 §17）；`test/harness.mjs` 扩到能过 `react-dom` |
| S2 交互 | `44ee33e` | 拖动写回（`onNodesChange` → `foldDragChanges` 单次提交）、选择/框选（复用 `toggleSelection` 与 `marqueeWorldRect`）、键盘转发、右键菜单、灯箱、fit/zoom |
| S3 连线 | `3a27630` | 拖线建节点：三种落点（空白 → 菜单、图片 → 建血缘、其余 → 取消）、**零生成请求**、防环/自环/跨板拒绝；隐藏句柄只在该做事的地方出现 |
| S4 节点行为 | `e4343a0` | 任务节点按钮集（`taskNodeActions`）+ 布局节点持久化断言 + **相机恢复**（`flowViewportOf`/`initialFlowView`/`flowViewportProps` 决定「存过的视口 XOR 取景」）+ **居中揭示修复**（`planReveal` 指名驱动对象）+ 进度 tick **只重绘单节点**（`reuseFlowNodes`） |

**为什么换了引擎（原设计没预见）**：§13.3 给了两条路，「评估未定就自研直扩」与「结论是替换就合并」，但没有预设「替换会先落地、抽取得分步」。实际是：自研 DOM 渲染器要补齐框选命中、句柄屏幕尺寸、相机恢复、单节点重绘这些能力，工程量与新写一层引擎映射接近，而 @xyflow/react 现成提供相机/句柄/连线/平移缩放，所以选了它。**代价**：`studio-view.ts` 仍是面板唯一宿主（未拆分），于是 U05/U06 不得不再回去改它（两次，`+557/-` 与 `+148/-`），这正是 §13.4 记下的「只解决了一半」。

**测试与产物体量**（按提交顺序）：`594457b` 29 文件 / 524 用例 → `44ee33e` 539 → `3a27630` 551 → `e4343a0` 562 → `a29ebfc` 570 → `c59b8ea` 之后全量 **29 个测试文件 / 587 用例 / 0 失败**。`lib/client.js` 现为 **968,219 B / gzip 257,925 B**（`test/bundle-xyflow.test.mjs` 的 gzip 预算上限是 300,000 B）。

---

## 15. 测试策略

原则沿用执行计划 D1：**机器判定优先**，每条设计面至少一条可自动断言的判据；人眼判据单独列在 §15.5 并标明「非机器判定」。

### 15.1 页签状态机（纯函数，最优先）

`test/workbench-tabs.test.mjs`，直测 §3 全部规则（用例清单见 §14.2 验收）。这一层必须**先绿**再动 UI：它是唯一能在没有 DOM 的情况下证明「关闭画布连带关详情」「超限拒绝」「激活动回退」正确的手段。

### 15.2 渲染断言（新文件 `test/workbench-shell.test.mjs` 等）

| # | 断言 | 层 |
|---|---|---|
| R1 | 初始渲染 `aria-selected="true"` 的页签是「项目管理」 | 外壳 |
| R2 | 点项目卡片 → 出现 `canvas:<id>` 页签并激活；原 `projects` 页签仍在 | 外壳 |
| R3 | `projects` 页签不渲染关闭按钮；画布页签渲染且 `aria-label` 含项目名 | 外壳 |
| R4 | 关画布页签 → 其 `node:` 页签同时消失（R4 与 U01 的纯函数用例互为双保险） | 外壳 |
| R5 | 选中 1 节点 → 属性抽屉出现；多选 → 不出现 | 抽屉 |
| R6 | layout 节点开详情页签 → 画布内编辑器挂载数为 0 | 详情 |
| R7 | 两个画布页签同时打开 → `EventSource` 构造计数为 1 | store |
| R8 | 非激活画布容器带 `hidden` | store/render |
| R9 | 四种空态判定顺序（§11.4） | 外壳 |
| R10 | 未就绪时空态不阻断画布编辑（无覆盖层、节点仍可摆） | 外壳 |

### 15.3 迁移测试

`test/workbench-workspace.test.mjs`：

- M1 无 `workspace.json` + 有 `state.json{active}` → 恢复为「一个画布页签且激活」（§4.4 迁移表）；
- M2 新旧并存（`workspace.json` 与 `state.json` 都有效）→ **以 `workspace.json` 为准**，`state.json` 的 `active` 不覆盖它；
- M3 `version` 未知 → 空 workspace，不抛；
- M4 引用已删 board / 已删 item → 逐项丢弃，其余页签保留；
- M5 读一次不写盘（比对 `workspace.json` 的 mtime 与内容不变）；
- M6 上限截断（9 个 openProjects → 8 个）。

### 15.4 既有测试的影响面（必须改的清单）

| 文件 | 影响 | 处置 |
|---|---|---|
| `test/studio.test.mjs`（实测 75 个用例） | 左栏表单、三视图 toggle、内嵌布局编辑器、进度栏这四类断言全部依赖旧结构 | U04 改「挂载方式」；U05 把表单断言迁到抽屉；U06 把编辑器断言迁到详情页签；**用例语义不变、选择器变** |
| `test/studio.test.mjs:1936-2002`（T22 stepper，2 条） | stepper 的位置（面板顶部固定）会变 | 若在途任务已改位置，按新位置断言；否则 U09 里随顶栏一起改 |
| `test/studio.test.mjs:1990-1991`（SSE 桩 `source.emit`） | SSE 上提到 store 后，桩的注入点变 | U04 改为注入 store 的 EventSource 工厂，保留 `emit` 形态 |
| `test/settings.test.mjs:259-269`（座位断言） | 座位（main keyed panel + sidebar.panellist）**不变** | U03 只需保证注册的组件换了但座位与 id/label 不变；该文件预期**无需改**，若失败说明座位被动了 |
| `test/layout-editor.test.mjs` | 纯函数 + 编辑器内部 | 预期不改（`pointerScale` 默认 1 口径不变） |
| `test/boards.test.mjs` | 新增 2 个 workspace action + `duplicate` + `bytes` | U02/U07 扩展 |
| `test/board-migration.test.mjs` | 只管 board 版本 | **不改**（workspace 迁移另立文件，避免混版本语义） |
| `package.json:57` | 新测试文件要进 `test` 串 | U10 收口时统一加（各任务自己加也行，但收口时必须核对） |

### 15.5 手测清单（非机器判定，U10 执行）

1. 两个画布页签来回切 10 次：相机不丢、图片不闪、无「白屏一瞬」；
2. 一个板里放 30 个节点 + 1 个布局节点，切到别的页签再回来：拖动仍跟手；
3. 布局节点在详情页签里编辑 5 分钟再回画布：画布缩略与详情内容一致；
4. 断网/拔掉 ComfyUI：空态文案正确、画布仍可用、生成给出可读错误；
5. 重启插件：页签与激活项完全恢复（含顺序）。

### 15.6 明确不做的测试

- 不做像素级截图对比（沿用执行计划验收口径）；
- 不做跨浏览器矩阵（宿主只跑 Chromium 系）；
- 不为「页签条溢出滚动」写自动化（视觉判断，进手测第 1 条）。

---

## 16. 待决策与未核实项

### 16.1 待用户/协调者拍板（本文不自行拍板）

| # | 问题 | 本文推荐 | 影响面 |
|---|---|---|---|
| Q1 | 旧「列表视图」（结果批次快速浏览）在新外壳里保留还是删除？ | **保留**，降为画布页签内的次级切换（§6.6） | U04/U10；删除会少一个测试面 |
| Q2 | 「占位草稿任务节点」是否落盘？（决定 `BoardTaskInfo.status` 是否加 `'draft'`） | **不落盘**：草稿只在内存，刷新即丢。理由：加 `'draft'` 是**破坏性**改 `status: 'failed'\|'interrupted'`（`src/studio-shared.ts:578`），且草稿价值低于「一次干净的重试」 | U05；若改为落盘，§7.3/§7.6 与 board 测试要一起改 |
| Q3 | 画布内 layout 节点缩略：新写 `LayoutThumb` 还是给 `mountLayoutEditor` 加 `readOnly`？ | **新写 `LayoutThumb`**：不扩编辑器 API，只吃 `BoardLayoutDraft`（`src/studio-shared.ts:539-553`） | U06；影响是否要改 `src/layout-editor.ts` |
| Q4 | cfg / 采样器 / 负向词 / 底模是否提升为**节点级**属性？ | **不提升**（首期）：它们在 profile 级（`src/index.ts:71-90`、`src/model-profiles.ts:98-107`），提升要改 `/studio/generate` 线缆 + 每个 profile 的采样语义（MOSS 的 cfg 还受 `mossSampling` 档位约束） | U05；若提升，需新增 §7 之外的线缆设计 |
| Q5 | 页签上限 8 画布 / 16 总数是否合适？ | 先按此实现，常量化可调（§3.4） | U01 一行常量 |
| Q6 | 环境状态行与 T22 stepper 的最终位置（画布顶栏 / 项目页签 / 两处） | **不预设**，与在途的环境启停任务对齐（§6.2） | U04/U09 的接线点 |
| Q7 | 全局素材库要不要独立页签？ | **不要**，做「项目管理」的子视图（§9.2） | U03/U08 |

### 16.2 与既有文档的口径冲突（需协调者裁定）

| 冲突 | 出处 | 本文口径 |
|---|---|---|
| 布局编辑器：**画布内节点编辑器** vs **详情页签里的全尺寸编辑器** | 画布设计 D7（文档 §1）vs 本次 D13 | 保留「布局是画布一等节点」，只换编辑器容器（节点内缩略 + 详情页签编辑），不是推翻 D7（§8.5） |
| 面板打开即回到上次画板 vs 默认停在项目管理 | `state.json` 语义（`src/boards.ts:18`）+ `src/studio-routes.ts:247` vs 本次 D10 | 首次升级**保形**（迁移自动打开上次那板），用户主动返回列表后不再自动回画布（§4.4） |

### 16.3 未核实项（执行者请自行确认，不要以本文为准）

| # | 未核实 | 怎么确认 |
|---|---|---|
| N1 | `progress` / `error` 事件是否也带 `boardId`（本文只确认 `run` 事件带，`src/studio-shared.ts:889`） | 读 `src/studio-shared.ts:876-900` 的 `StudioProgressEvent` 联合全文 |
| N2 | `save-task` action 是否接受对**已存在** task 条目覆盖 params（`item?` 的语义是「新建时指定 id」还是「更新已有」） | 读 `src/boards.ts:974` 起的 `saveTaskItem` |
| N3 | `npm test` 的用例总数是否为 brief 说的 411（本文只实测了 23 个文件与 `studio.test.mjs` 的 75 条） | `npm test` 末行计数 |
| N4 | 在途任务是否也改 `src/client-styles.ts`（决定 U03 能否与它并行）；以及它是否已提交（`git status` 在本会话内不可用：`git.exe` 因命名管道被拒，见汇报） | 由协调者确认该任务写入范围；`studio-view.ts` 当前 4642 行且带 `data-env-state`，说明改动在工作树中 |
| N5 | 详情页签内 `mountLayoutEditor` 全尺寸挂载后，是否需要新的尺寸适配（编辑器按容器测 `getBoundingClientRect`，全尺寸应更简单，但未实测） | 起一个 1:1 的容器手测拖拽 |
| N6 | `StudioConfigResponse` 是否已有「当前底模/profile」字段（本文读到的字段里没有，`src/studio-shared.ts:196-231`） | 读该接口全文；若要显示底模需新增字段 |

### 16.4 未核实项的结论（2026-11-18 回填）

| # | 结论 | 依据 |
|---|---|---|
| N1 | **证实**：带 `promptId` 的事件（`start`/`node`/`progress`/`done`/`error`/`interrupted`）全部 `& StudioRunLink`，而 `StudioRunLink = { clientId?: string; boardId?: string }`，所以 `progress`/`error` **确实带 `boardId`**（可选，Agent 工具发起的运行不带）。SSE 按 `boardId` 分桶可行，不需要 `promptId → clientId → boardId` 的补映射兜底 | `src/studio-shared.ts:892-897`、`:926-941` |
| N2 | **证实**：`saveTaskItem` 用 `entry.id` 找既有条目并**原地覆盖**（`existing?.id ?? requestedId ?? makeItemId()`），只有在 id 空闲时才采纳调用方给的 id，被占用才换新 id 并把答案交回调用方 | `src/boards.ts:1037-1056` |
| N3 | **已更新**：全量已是 **29 个测试文件 / 587 用例**（不是 411）；本文实测的 23 个文件是旧快照。**注意**：文中的 29/587 是 U06 落地时的运行记录，本轮文档同步没有重跑 `npm test` | 目录内 `*.test.mjs` 实测 29 个；用例数来自 U06 交付记录 |
| N4 | **证实已提交**：在途的环境启停任务就是 `d7347ec`（`feat(env): start/stop ComfyUI from the workbench with ownership checks`），在 `f789729` 之前，U04 的抽取基线没有中途变动。它也确实改了 `src/client-styles.ts`，所以 U03 与它**不能并行**（当初的判断正确） | `git log` |
| N5 | **未采用新适配**：全尺寸挂载**不需要**改 `src/layout-editor.ts`（`c59b8ea` 未碰该文件，`pointerScale` 仍保持默认 1）；编辑器按容器 `getBoundingClientRect` 自适应，详情页签只是给了一个更大的容器。真实手感仍待人工（§17） | `c59b8ea` 文件清单；`src/node-detail-pane.ts` |
| N6 | **仍无 profile 字段**：`StudioConfigResponse` 只有 `models.{unet,clip,vae}`（权重文件名）与 `optimizeModel`（对话模型），**没有**「当前底模/profile」字段；面板要显示「用的是哪个 profile」仍需新增字段 | `src/studio-shared.ts:227-260` |
| N7 | **新增（原 §16 没列，但影响最大）**：React Flow 能否嵌进宿主面板——**能**，详见 §13.4；产物 968,219 B / gzip 257,925 B，裸 require 只剩 `react`、`react-dom`、`react/jsx-runtime` | §13.4；`test/bundle-xyflow.test.mjs` |

---

## 17. 人工验收清单现状（2026-11-18）

U04 S1b 把**40 条画布 DOM 用例**移出了自动化（不是弱化、是移出），原因是 React Flow 需要真实 DOM：可测量的容器、`ResizeObserver`、pointer capture、浏览器事件模型——`test/harness.mjs` 的渲染器一样都没有。**清单与逐类去向写在 `test/studio.test.mjs` 顶部注释**（`test/studio.test.mjs:24-85`，13 类），本节只记状态，不复制清单。

### 17.1 移出自动化的 13 类能力与当前状态

| 能力 | 阶段 | 状态 |
|---|---|---|
| 选择 / Ctrl 切换 / 框选 | S2 | 已接线，待人工验收 |
| Delete / Ctrl+Z / Ctrl+Shift+Z | S2 | 已接线，待人工验收 |
| 快捷键表与 Esc 清除 | S2 | **机器可见**：Ctrl+A、Esc 经画布容器驱动 |
| 右键菜单（空白 / 节点） | S2 | 已接线，待人工验收；菜单数据仍由 `canvas-interactions.test.mjs` 断言 |
| 节点拖动与写回 | S2 | **半自动**：`foldDragChanges` + `snapshotCommand` 的撤销链已断言，真实指针拖动待人工 |
| fit（`F` / 适应）与缩放下限 | S2 | **半自动**：`fitWouldClamp` 已断言，实际取景待人工 |
| 输出句柄 / 屏幕尺寸 / 拖线 | S3 | 已接线，待人工验收；纯函数 `planConnectionDrop`/`judgeConnection` 已有断言 |
| 松手建节点（draft / 布局 / 素材） | S3 | 已接线，待人工验收；标签与三种映射由 `canvas-connections.test.mjs` 断言 |
| 跨板 copy/move | S3 | 保持原样，待人工验收 |
| 灯箱（G22）与方向键 | S2 | 双击已接线，覆盖层与 ←/→ 待人工验收 |
| 任务节点：clientId、重试、中断 | S4 | 已接线，待人工验收；状态→按钮集由 `taskNodeActions` 断言 |
| 布局节点：重建 / 新建 / 生成 / 保存 | S4 | **半自动**：重建后尺寸与草稿一致性已断言，内嵌编辑器手感待人工 |
| 相机恢复与居中揭示 | S4 | **半自动**：三个纯函数断言了「存过的视口 XOR 取景」与揭示目标，真实不闪/真居中待人工 |

替代覆盖见 `test/canvas-flow-model.test.mjs`（映射、拖动 reducer、视口换算、框选命中、库侧被关掉的按键绑定）、`test/bundle-xyflow.test.mjs`（产物）、以及 `test/studio.test.mjs` 里的 `U04 S2/S3/S4` 接线用例。手势状态机本身**没有丢覆盖**：`canvas-interactions.test.mjs`、`canvas-connections.test.mjs`、`canvas-export.test.mjs` 原封未动。

### 17.2 已补齐的人工清单段落

`test/studio.test.mjs` 顶部现有人工验收段落四段 + 一段行内标注：

| 段落 | 位置 | 内容 |
|---|---|---|
| `## What left automation in U04 step 1b, and where it stands after step 2` | `:24-85` | 40 条用例的 13 类清单与 S2 状态（**S2 的判据写在这里的行内标注**，没有独立段落） |
| `## U04 step 3 的人工验收清单(拖线)` | `:87` | 6 条：句柄/虚线/吸附/变色、空白处建节点、已有节点只加边零请求、四种取消、40% 缩放下贴指针、菜单 Esc |
| `## U04 step 4 的人工验收清单(相机、任务节点、布局节点)` | `:105` | 4 条：相机恢复与空板取景、居中揭示单次位移、任务四态与重试/编辑参数、布局节点手势隔离与缩放一致性 |
| `## U05 的人工验收清单(节点属性抽屉)` | `:120` | 8 条：左栏无表单、新建生成链路、只读图片属性、按这张继续、多选退回、失败后原地替换、<760 px 覆盖层、列表/素材保留旧表单 |
| `## U06 的人工验收清单(节点详情页签)` | `:143` | 9 条：页签位置与自动激活、全宽编辑器、`save-layout-node` 请求体、**双写防护**（只读缩略 ↔ 编辑器回来）、生成后详情页签仍开、返回画布、连带关闭、图片/任务详情、窄面板堆叠 |

另：§15.5 的 5 条手测（页签来回切、30 节点拖动手感、详情编辑 5 分钟后缩略一致、断网空态、重启恢复）**一条都还没执行**。

### 17.3 当前最大风险

> **这批能力在真实浏览器里尚未验收。**

`FlowCanvas` 要量容器才挂引擎，而 Node 侧的测试渲染器没有 DOM——**引擎在自动化里永远停在「画布准备中…」**。因此 587 条绿灯**不能**证明下列任何一条：拖动跟手、框选命中准、拖线吸附对、相机恢复不闪、布局编辑器在引擎容器里的手感、窄面板下抽屉不遮挡。这些全部依赖一次真实浏览器验收（ego-browser 或人工），**尚未进行**；U10 收口前必须先补这一遍。

---

## 附录 A 线缆契约变更汇总

| 变更 | 类型 | 位置 | 兼容性 | 任务 |
|---|---|---|---|---|
| `action: 'workspace-get'` | 新增（可选值） | `StudioBoardRequest`（`src/studio-shared.ts:647-660`）；路由 `src/studio-routes.ts:281` | 向后兼容（老客户端不发） | U02 |
| `action: 'workspace-set'` | 新增 | 同上 | 向后兼容 | U02 |
| `action: 'duplicate'` | 新增 | 同上；存储 `src/boards.ts` | 向后兼容 | U07 |
| `BoardSummary.bytes?: number` | 新增可选字段 | `src/studio-shared.ts:487-498` | 向后兼容（缺省 undefined，不是 0） | U07 |
| `workspace.json` v1 | 新增文件 | `<outputDir>/.dsh-image-forge/workspace.json` | 新文件；旧版本插件不读它 | U02 |
| `state.json` | **不变**（继续写 `active`） | `src/boards.ts:174-185` | 完全兼容 | U02 |
| board 文件 `version` | **不变**（仍是 2） | `src/boards.ts:76` | 不需要迁移 | — |
| `/studio/generate` | **不变** | `src/studio-shared.ts:362-406` | 属性都在 `BoardTaskParams` 侧承接（§7.3） | — |
| `/studio/events` | **不变**（`boardId` 已在 `run` 事件上） | `src/studio-shared.ts:889` | 兼容；见 §16.4 N1（`progress`/`error` 亦带 `boardId?`） | — |
| `BoardTaskInfo.status` 加 `'draft'` | **可能破坏性**（待 Q2） | `src/studio-shared.ts:578` | 若采纳需同步 board 迁移与测试 | 待决 |

---

## 附录 B 术语对照

| 本文用词 | 代码/存储实体 | 说明 |
|---|---|---|
| 项目 | `Board` / `BoardSummary` / `BoardDetail` | 界面一律叫「项目」，存储仍是 board（D11） |
| 节点 | `BoardItem` | `kind: image \| task \| layout` |
| 画布页签 | `canvas:<boardId>` | 一个项目一块无限画布 |
| 节点详情页签 | `node:<boardId>:<itemId>` | 复杂控制的容器 |
| 项目内素材 / 全局素材 | `assetScope: 'board' \| 'all'`（现有） | 两处不同入口（§9） |
| 简单控制 / 详细控制 | 悬浮动作条+右键 / 详情页签 | 分界判据见 §6.3 |






