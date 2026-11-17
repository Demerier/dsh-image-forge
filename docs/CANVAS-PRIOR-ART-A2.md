# CANVAS-PRIOR-ART-A2：画布批 C01–C15 的「已落地追溯查重」调查

- 日期：2026-11-18（本会话）
- 模式：**A2 已落地追溯查重**（问题形状＝"这些已提交模块该不该换成现成的、换要放弃什么"；成本判据＝期望节省 < 本轮成本）。单位：分钟（1 分钟 = 150 token），全程不换算。
- 上游：动手前查重报告 [CANVAS-PRIOR-ART.md](CANVAS-PRIOR-ART.md)（2026-11-17，模式 A1）。本报告是它落地后的追溯版，账本 e1–e9 直接引用，不重写来源。
- 对应计划：[EXECUTION-PLAN.md](EXECUTION-PLAN.md) §6d 批次六；设计权威 [CANVAS-DESIGN.md](CANVAS-DESIGN.md)

---

## 0. 一句话结论

**逐模块：10 个已提交画布模块里，2 个有成熟小库值得包一层（空间索引 rbush、键盘/撤销 tinykeys+immer patches），1 个只该抄契约不引库（任务节点状态机对齐 ComfyUI/InvokeAI），其余 7 个自研保留（导出、布局编辑器 516 pitch、板 schema 迁移、几何纯函数、DOM 交互接线、素材流）。集成级：换画布引擎依旧不成立——tldraw 生产需商业许可 + 15.3 MB，而当前整个客户端产物只有 282 KiB；xyflow/Excalidraw 是别的数据模型。品类级：Weavy/Flora/Krea/InvokeAI/ComfyUI 前端的范式可借鉴，可接手的只有契约层（prompt_id 生命周期、queue_item_ids），不是代码。**

- 置信度：**medium**（git 清单、行数、bundle 体积、许可原文来自一手/本地实测；本轮**网络完全不可达**，产品官网与 npm/GitHub API 全部 000，产品面与库体积沿用 2026-11-17 的一手读数并按"历史读数"标注）。
- 四态汇总：接现成 **0** / 包一层 **2** / 只抄思路 **1（模块级）+ 5（引擎与竞品级）** / 自研保留 **7**。

---

## 1. 方法与证据来源

### 1.1 先盘自己：git 审计清单（未提交部分单列）

命令：`git log --format='%h %ad %s' --date=short -25`、`git status --short`、`git show --stat <commit>`、`wc -l`。

| 任务 | commit | 主要涉及文件（自研行数量级） | 一句话职责 |
|---|---|---|---|
| C01 血缘持久化 | `6f27195` | studio-service.ts（12 行改动）+ 测试 330 行 | 面板生成结果回写父路径，形成派生血缘 |
| C02 参考图去重修复 | `5f61b31` | studio-view/studio-shared（小改） | `payload.path` 口径统一，`hasReference` 纯函数 |
| C03 TODO 清理 | `599fe13` | 文档 | 陈旧 moss-edit TODO 与放置说明 |
| C04 板 schema v2 | `a725dca` | boards.ts（+162）、studio-shared.ts（+90）、迁移测试 359 行 | v1 懒迁移、516 网格节距 |
| C05 比例几何 | `ff23f51` | studio-canvas.ts（+40）+ 测试 88 行 | 按源图宽高比决定节点框，纯函数 |
| C06 比例渲染接线 | `876698e` | studio-canvas.ts、studio-view.ts（+77） | 缩放区间 0.1–4、D6 声明改写 |
| C07 裁剪/索引/节流 | `53f3684` | studio-canvas.ts（+216）、studio-view.ts（+156）、client.js 318 行 | 视口裁剪、边索引、手势节流 |
| C08 交互纯函数 | `d184906` | canvas-interactions.ts（**新增 565**）+ 测试 349 行 | 框选、对齐分布、快捷键、撤销栈 |
| C09 交互接线 | `3770a95` | studio-view.ts（+806）、canvas-interactions.ts（+191）、测试 531 行 | 多选、框选、右键菜单、撤销 |
| C10 后端关联链 | `7c53dde` | runs.ts（**213 新增**）、progress.ts（+52）、studio-routes.ts | clientId + run registry + SSE 扩展 |
| C11 任务节点 | `c7d423d` | studio-view.ts（+870）、client-styles.ts（+19） | 占位/进度/重试/就地转结果 |
| C12 素材流 | `1cf90d6` | boards.ts（+191）、studio-routes.ts（+162）、view（+329） | 跨板复制移动、OS 文件导入、定位相机 |
| C13 布局节点 | `4655acc` | layout-editor.ts（+153）、studio-view.ts（+347） | mountLayoutEditor 嵌入画布 |
| C14 布局闭环 | `cdbea14` | boards.ts（+206）、routes（+134）、view（+305） | 布局节点→生成→结果回画布 |
| C15 导出与压测 | `5450ef6` | canvas-export.ts（**188 新增**）+ 测试 163 行 | 增量保存、JSON/拼版 PNG、161fps 实测 |

**未提交（单列，不算"已落地"）**：`M lib/client.js`、`M src/layout-editor.ts`、`M src/studio-view.ts`、`M test/layout-editor.test.mjs`。

自研体量基线（`wc -l`，一手）：canvas-interactions.ts 793、studio-canvas.ts 453、canvas-export.ts 188、layout-editor.ts 1585、boards.ts 1244，合计 4,263 行；客户端产物 lib/client.js **289,224 B**。

### 1.2 三路并行：每路只绑一个决策问题

| 路 | 唯一决策问题 | 产出形状 | 账本 id |
|---|---|---|---|
| L1 引擎选型 | 继续自研几何+交互层，还是换成熟画布引擎？ | 三态 + 许可/bundle/弃码量三数 | a2-13…a2-15、e1–e9 |
| L2 产品范式与契约 | 生成式画布的成熟范式哪些可借鉴，能接手的一手契约是什么？ | 可落地契约（消息类型、任务 id 生命周期） | a2-16…a2-19 |
| L3 单模块替换 | 这批自研模块里哪些有成熟小库可接替？ | 逐模块四态 + 删多少行 | a2-01…a2-12 |

三路问题不重叠：L1 决定"要不要整体换引擎"，L3 只决定"单个模块换不换库"，L2 不产依赖、只产契约。

**停止判据（模式 A）**：p′ = p × 0.5^轮；期望节省 = p′ × B × V。tooling 域 p=0.60，V 取 0.3（包一层平均吻合度）→ 第 1 轮期望节省 ≈ 0.30×14,400×0.3 ≈ 1,296 分钟 ≫ 本轮成本；第 2 轮 p′=0.15 → ≈648 分钟仍高于成本，但**网络不可达导致 V 无法再提升**，第 2 轮即停（未凑满 3 轮，理由是边际信息为 0，继续只是烧时间）。

### 1.3 触达失败清单（不静默跳过，不算证据）

| URL/端点 | 实测 | 处置 |
|---|---|---|
| `https://api.github.com/rate_limit` | HTTP **000**（连接失败，2026-11-18 本轮） | 降级为历史一手读数（2026-11-17 的 stars/pushed_at）+ 标注 |
| `https://registry.npmjs.org/react` | HTTP **000** | 同上；体积数字按历史一手读数引用 |
| `https://raw.githubusercontent.com/xyflow/xyflow/main/LICENSE` | HTTP **000** | 许可结论沿用 2026-11-17 已读原文 |
| krea.ai / drawdy.io / beemmvision.com / reactflow.dev / tldraw.dev | 2026-11-17 已记失败（超时/SPA 空文） | 沿用二手口径 |

**结论**：本轮为离线追溯，许可/体积字段一律标"历史一手读数（2026-11-17）"，不冒充实测。

---

## 2. 结论细则

### 2.1 模块级：逐模块四态判定

| # | 模块（任务） | 自研量 | 现成先例 | 四态 | 删/留多少 |
|---|---|---|---|---|---|
| M1 | 比例几何（C05/C06，studio-canvas.ts 453） | 453 行 | React Flow NodeResizer 思路 | **自研保留** | 纯函数 + 宽高比规则无库对位；不留依赖，只留思路 |
| M2 | 视口裁剪 + 边索引（C07） | 约 100–140 行（studio-canvas.ts 内） | **rbush**（MIT，a2-01，15/18，V 0.6） | **包一层** | 可删自研"矩形/边的线性扫描与索引桶"约 60–90 行，改调 `rbush.search(bbox)`；重绘与节流保留 |
| M3 | 交互纯函数（C08：框选/对齐/快捷键/撤销栈，793 行） | 793 行 | **tinykeys**（MIT，16/18，V 0.7）+ **immer produceWithPatches**（MIT，15/18，V 0.6） | **包一层** | 键盘匹配约 80–120 行可删；撤销栈由"整板快照"改 patch 栈，约 120–150 行可删。框选/对齐分布保留自研（几何语义自有） |
| M4 | 交互接线（C09，studio-view.ts 内） | 数百行 | 无对位 | **自研保留** | 宿主 keyed panel、DOM 事件与槽生命周期是本项目约束 |
| M5 | 板 schema v2 + v1 迁移（C04，boards.ts 1244） | 迁移 ~200 行 | zod（14/18，V 0.4） | **自研保留** | 模型含任务/布局节点语义，zod 只抄"schema 先行校验"思路；引入 ≈ 一个额外依赖与数十 KB |
| M6 | 导出 JSON/拼版 PNG（C15，canvas-export.ts 188） | 188 行 | html-to-image（12/18，V 0.3） | **自研保留** | 已按 161fps/206ms 验收；DOM 栅格化遇跨域画布会污染，反而不稳 |
| M7 | 布局编辑器（C13，layout-editor.ts 1585） | 1585 行 | react-grid-layout（10/18）、muuri | **自研保留** | 516 节距 + MOSS 编译契约是私有语义；库的栅格模型对不上 |
| M8 | 布局闭环（C14） | 见 C14 清单 | 无开源先例 | **自研保留** | 无先例即差异化 |
| M9 | 任务节点 + 后端关联（C10/C11，runs.ts 213 / progress.ts 611） | ~800 行 | ComfyUI /ws 契约、InvokeAI queue API（11/18） | **只抄思路** | 契约对齐（见 §2.3），不引库：许可证（ComfyUI 前端 GPL-3.0）与栈（MCP 0.10.0 锁定）双重排除 |
| M10 | 素材流（C12） | boards/routes 内 | 通用 drop 模式 | **自研保留** | 无专门库必要 |

判定能回答"删掉我们多少代码"：**本轮可删总量约 260–360 行 src（M2 60–90 + M3 200–270），占画布自研 4,263 行的 6%–8.5%**；其余四态均为"保留"，因为删了要付许可、bundle 或数据模型代价。

### 2.2 集成级：换引擎的三项硬数（缺一即为空话）

1. **许可证（raw LICENSE 原文，2026-11-17 一手读数）**
   - tldraw：自定义许可，LICENSE.md 明确 Production Environment 需 License Key 或购买替代许可 → **商用红线**。
   - xyflow/React Flow：MIT（e6）；Excalidraw：MIT（e8）；Konva/Fabric：MIT。
   - ComfyUI_frontend：**GPL-3.0**（e?，仓库级）→ 代码不可拷入 MIT 项目。
   - InvokeAI：Apache-2.0，思路可借、代码不 vendor。
2. **bundle 代价**：现 lib/client.js **289,224 B（282 KiB）**，且产物必须是单文件 lazy-CJS factory、零相对 require、React 由宿主 PLATFORM_MODULES 冻结表提供（[client-bundle.md](client-bundle.md)）。tldraw 15,299 KB unpacked / 18 deps ≈ **当前产物的 54 倍**；xyflow 1,283 KB / 4 deps ≈ 4.4 倍；Excalidraw 874 KB / 9 deps ≈ 3 倍。任一项都把首屏加载从"一屏脚本"推到"多请求 + 依赖树"。
3. **弃码量**：换引擎直接弃 **3 个模块 / 1,434 行**（canvas-interactions 793 + studio-canvas 453 + canvas-export 188）+ **3 个测试文件 / 1,115 行**（508 + 444 + 163）；间接还要重写 studio-view.ts（4,474 行）中的画布接线段——**该段落未逐段切分，按 TODO 计，不给伪精确数字**。
   → 弃码 1,434 行 ≫ 模块级可删的 260–360 行，**换引擎不成立**；结论与 A1 一致，但这次有可量化的分母。

### 2.3 品类级：可借鉴的范式与"可接手的契约"

五个参照物的共同范式（四点，均为产品行为观察，二手/历史读数）：

1. **生成请求＝画布上一等节点**（Weavy 一节点一步；Flora 无限画布多模型；Krea 实时画布 + node builder）；
2. **结果就地落为图片节点**，可继续作为下一次输入（派生而非复制）；
3. **派生/分支边承载 remix 迭代**（Weavy 的 branch/remix 是产品主轴）；
4. **队列与进度是画布内一等状态**，不是外部进度条（InvokeAI、ComfyUI 前端）。

可接手的**契约层**（本轮无法抓文档，标"未验证"，快照如下，联网后须以 raw/官方文档逐条核对）：

| 契约 | 消息/端点 | 对我们 C10/C11 的落点 |
|---|---|---|
| ComfyUI WS `/ws?clientId=` | `status{exec_info.queue_remaining}`、`execution_start{prompt_id}`、`executing{node,prompt_id}`、`progress{value,max,prompt_id,node}`、`executed{node,output,prompt_id}`、`execution_cached`、`execution_error` | 任务节点状态机应显式区分 **排队/执行中/已缓存(秒回)/失败** 四态；`execution_cached` 目前无对应 UI 态，重试会看起来"卡住" |
| ComfyUI HTTP | `POST /prompt` → `{prompt_id,number,node_errors}`；`GET /history/{prompt_id}`；`GET /view?filename&subfolder&type`；`POST /interrupt` | 重试必须**新 prompt_id**（旧 id 的 history 已终态）；断线重连用 `/queue` 快照对账，而不是重放 SSE |
| InvokeAI 队列 | `enqueue_batch` → `{queue_item_ids, batch_id}`；socket.io `/queue` 的 `queue_item_status_changed`；单 item 取消 | 我们 runs.ts 已有 run registry：建议补 `batch_id` 层，一次多点生成的多个任务可成组取消 |

---

## 3. 证据账本（六维分：覆盖/接口/许可/活跃/体积/集成风险，上限 18；门槛 12）

| id | 来源 | 类型 | 六维分 | 判定 | 状态 |
|---|---|---|---|---|---|
| e1–e9 | 见 [CANVAS-PRIOR-ART.md](CANVAS-PRIOR-ART.md) §3（tldraw LICENSE/定价、xyflow、Excalidraw、ComfyUI_frontend、InvokeAI、npm 体积） | 一手（2026-11-17） | 见原表 | 沿用 | 已用 |
| a2-01 | rbush（npm/GitHub，MIT，静态 R 树，~5–8 KB） | 历史一手 | 3/2/3/2/3/2 = **15** | 覆盖裁剪与命中，V 0.6 → **包一层** | 用到了 |
| a2-02 | tinykeys（MIT，~1 KB，作用域键盘绑定） | 历史一手 | 3/2/3/3/3/2 = **16** | V 0.7 → **包一层** | 用到了 |
| a2-03 | immer `produceWithPatches`/patches（MIT） | 历史一手 | 3/2/3/3/2/2 = **15** | 撤销栈 patch 化，V 0.6 → **包一层** | 用到了 |
| a2-04 | zundo（zustand 撤销中间件，MIT） | 历史一手 | 2/1/3/2/2/1 = **11** | <12 → 排除（React hook 绑定） | 只读过 |
| a2-05 | d3-zoom（ISC） | 历史一手 | 2/1/3/3/2/1 = **12** | 达门限但 V 0.3（接管事件/transform 属性，冲突大）→ **只抄思路** | 用到了 |
| a2-06 | react-zoom-pan-pinch（MIT） | 历史一手 | 2/1/3/2/2/1 = **11** | <12 → 排除 | 只读过 |
| a2-07 | @use-gesture/react（MIT） | 历史一手 | 2/1/3/3/3/1 = **13** | V 0.4 → **只抄思路**（轮盘/pinch 归一化常数） | 用到了 |
| a2-08 | html-to-image（MIT） | 历史一手 | 2/1/3/2/2/2 = **12** | V 0.3（跨域画布污染）→ 自研保留 | 用到了 |
| a2-09 | react-grid-layout（MIT） | 历史一手 | 2/1/3/2/1/1 = **10** | <12 → 排除 | 只读过 |
| a2-10 | zod（MIT） | 历史一手 | 3/2/3/3/2/1 = **14** | V 0.4（bundle + 单文件契约）→ **只抄思路** | 用到了 |
| a2-11 | @dnd-kit/core（MIT） | 历史一手 | 2/1/3/2/1/1 = **10** | <12 → 排除 | 只读过 |
| a2-12 | flatbush（ISC，静态索引） | 历史一手 | 2/2/3/2/3/2 = **14** | 排除（不支持动态增删，被 rbush 取代） | 只读过 |
| a2-13 | xyflow/React Flow（e6 重引用，13/18，V 0.3） | 一手（2026-11-17） | 13 | **只抄思路** | 用到了 |
| a2-14 | tldraw（e1/e2/e3/e5，9–11 分，V 0.2） | 一手 | 9–11 | **排除**（生产许可 + 15.3 MB） | 用到了 |
| a2-15 | Excalidraw（e8，13/18，V 0.3） | 一手 | 13 | **只抄思路**（增量 patch 撤销、格式迁移） | 用到了 |
| a2-16 | ComfyUI `/ws` + `/prompt` + `/history` 契约 | **未验证**（本轮 000） | 3/2/–/–/–/– | **只抄思路** | 触达失败 |
| a2-17 | InvokeAI queue API（Apache-2.0） | **未验证** | 2/1/3/2/1/2 = 11 | **只抄思路**（仅队列语义） | 触达失败 |
| a2-18 | Weavy/Figma Weave、Flora、Krea 产品行为 | 二手（官网/媒体，2026-11-17） | 覆盖 3 / 接口 1 | 范式借鉴，不产依赖 | 只读过 |
| a2-19 | 本轮三处网络探测（api.github.com / registry.npmjs.org / raw.githubusercontent） | 实测 | – | 触达失败，已入 §1.3 | 触达失败 |

---

## 4. 逐任务先例对照与建议

| 任务 | 先例 | 四态 | 建议动作 |
|---|---|---|---|
| C01 血缘 | 画布产品的 edge 持久化 | 自研保留 | 无动作 |
| C02 去重修复 | — | 自研保留 | 无动作 |
| C03 文档 | — | — | 无动作 |
| C04 schema v2 | Excalidraw 迁移、tldraw store 迁移 | 自研保留 | 只借"迁移函数幂等 + 版本探针"写法 |
| C05 比例几何 | React Flow NodeResizer | 自研保留 | 无动作 |
| C06 渲染接线 | 同 | 自研保留 | 无动作 |
| C07 裁剪/索引 | **rbush** | **包一层** | 单开一个 P 任务：替换索引桶，保留重绘与节流；先量 bbox 查询热点 |
| C08 交互纯函数 | tinykeys、immer patches | **包一层** | 拆两步：键盘匹配先换（低风险），撤销栈 patch 化后换（需回归 508 行测试） |
| C09 接线 | 无 | 自研保留 | 无动作 |
| C10 后端关联 | ComfyUI /ws、InvokeAI queue | **只抄思路** | 补 `execution_cached` 态；补 `batch_id` 分组取消；重连走 `/queue` 对账 |
| C11 任务节点 | 同 | **只抄思路** | 状态机四态对齐（排队/执行/秒回/失败） |
| C12 素材流 | 通用 drop | 自研保留 | 无动作 |
| C13 布局编辑器 | react-grid-layout、muuri | 自研保留 | 无动作 |
| C14 布局闭环 | 无开源先例 | 自研保留 | 标注"差异化" |
| C15 导出 | html-to-image、Excalidraw export utils | 自研保留 | 只借"分块拼版 + 内存上限"思路 |

---

## 5. 反证（站在"应该采用现成库"一侧找证据）

1. **零依赖不是铁律**：rbush(≈6 KB)、tinykeys(≈1 KB)、immer 都是 MIT 且远小于一次图标替换，"不引依赖"若一刀切，会连 6% 的可删代码也留着。
2. **撤销栈确实可被 patch 替代**：Excalidraw 的增量撤销证明"整板快照"是落后做法——我们的 793 行里约 1/5 是快照搬运。
3. **布局编辑器是最像轮子的那个**：react-grid-layout/muuri 已解决拖拽、占位、吸附；我们的 516 pitch 只是常量，1,585 行里真正私有的是"编译成 MOSS 布局串"那一段。
4. **延迟成本**：若将来做多人协作，Yjs 类依赖不可避免，今天把状态写成不可序列化的闭包，未来要重写。
   反驳：D6 明确不含协作；且 patch 化撤销（a2-03）本身就把状态推向可序列化，已部分对冲第 4 条。

---

## 6. 对计划与任务书的修订建议

1. **§6d 增补本报告小节**（已回填，见计划 §6d）。
2. **新增两个 P 级小任务**（不动已验收行为）：
   - P-A：C07 索引换 rbush（预计可删 60–90 行，先跑 verify/canvas-perf 基线对比）；
   - P-B：C08 键盘匹配换 tinykeys + 撤销栈 patch 化（需 508 行测试全绿 + 撤销深度回归）。
3. **C10/C11 任务书补三行契约要求**：`execution_cached` 态、重试取新 `prompt_id`、重连用队列快照对账。
4. **不新增任何"换引擎"条目**：集成级三数（许可 15.3 MB / 54 倍 bundle / 弃码 1,434 行）已封死该方向。

---

## 7. 本轮收口（按模式 A 第 7 步模板）

- **结论**：两个小库（rbush、tinykeys/immer）值得包一层，任务节点契约要抄；换引擎与整体接库不成立。
- **置信度**：medium（本地一手 + 历史一手；本轮网络 000，产品面与库体积为历史读数）。
- **证据**：a2-01/a2-02/a2-03（历史一手，15/16/15）、a2-13/a2-14（一手，13/9）、a2-16/a2-17（未验证）。
- **能推翻它的条件**：①拿到 tldraw 生产许可且接受 15 MB；②出现 MIT 的"图片节点+任务节点+血缘边"画布库；③实际测出 rbush 替换后性能无收益或回归；④联网核出 `execution_cached` 语义与我方假设不符。
- **未解**：本轮网络不可达 → ComfyUI/InvokeAI 契约未逐条核对；rbush/tinykeys 实际版本号与 unpacked 体积未实测；studio-view.ts 画布接线段的精确行数未切分（TODO）。
- **本轮成本**：≈22.5 分钟 / ≈34,500 token（1 轮深搜当量：批搜 1.5 + 一手读取 4×3 + 记账 3，含 git 盘点）；覆盖率：10/10 模块有判定，证据账本 19 条。

---

## 附：原始读数（一手，2026-11-18 本机）

- `wc -l`：canvas-interactions 793 / studio-canvas 453 / canvas-export 188 / layout-editor 1585 / boards 1244；测试 canvas-interactions 508、studio-canvas 444、canvas-export 163、layout-editor 665。
- `ls -l`：lib/client.js 289,224 B；lib/index.js 387,691 B。
- `git status --short`：4 个未提交改动（见 §1.1）。
- 网络探测：api.github.com 000、registry.npmjs.org 000、raw.githubusercontent.com 000。
