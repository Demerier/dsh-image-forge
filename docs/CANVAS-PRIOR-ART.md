# CANVAS-PRIOR-ART：画布批 C01–C15 的「先例/查重」调查

- 日期：2026-11-17（本会话）
- 作者：执行侧 AI（coordinator）
- 对应计划：[EXECUTION-PLAN.md](EXECUTION-PLAN.md) §6d 批次六（C01–C15）；设计权威 [CANVAS-DESIGN.md](CANVAS-DESIGN.md)
- 触发：用户提出「这批任务大部分模块似乎都在别人的项目中见过，需要进行调查」
- 检索模式：**A 查重**（问题形状＝有没有人做过、要不要接现成；成本判据＝期望节省 vs 本轮成本）。单位：分钟（1 分钟 = 150 token）。

---

## 0. 一句话结论

**模块级：用户的直觉成立——C01–C15 里绝大多数模块都是画布/编辑器类产品的标准件，成熟开源实现和商业产品先例都存在。集成级：没有任何一个现成库可以作为依赖接进来（许可、体积、数据模型三重不吻合），因此 DD1「扩展现有 DOM+CSS transform、不引 tldraw」在"不引新依赖"约束下仍然成立；但任务书应当显式写明"先例参考"并只借 MIT 项目的算法思路，不 vendor 代码。**

- 置信度：**medium**（许可/体积/仓库元数据是一手强证据；产品功能面部分靠官网标题与二手媒体，React Flow/Excalidraw 源码细节未逐行读）
- 三态判定：**接现成＝0 个**；**线索（可借思路/源码，不可依赖）＝2 个**（React Flow/xyflow、Excalidraw）；**排除＝其余**（tldraw、Konva、Fabric、LiteGraph、ComfyUI_frontend、InvokeAI 作为整体依赖）

---

## 1. 方法与证据来源

| 来源类别 | 具体 | 用途 |
|---|---|---|
| GitHub REST API | `api.github.com/repos/{owner}/{repo}`（8 个仓库） | stars/许可/最近推送/仓库体积（一手） |
| raw 文件 | `raw.githubusercontent.com/.../LICENSE.md`、`README.md`（6 个） | 许可原文与自述能力（一手） |
| npm registry | `registry.npmjs.org/{pkg}/latest`（5 个包） | 版本/许可/unpackedSize/依赖数（一手） |
| 本地依赖树 | 本仓库 `package.json` + `node_modules`、宿主 `resources/app/node_modules` | 判断宿主/插件是否已自带画布库（一手） |
| 产品官网（ego-browser / web_fetch） | weave.figma.com（原 Weavy）、flora.ai、tldraw.dev、reactflow.dev | 产品形态与能力面（一手页面，部分正文因 SPA/网络未取到） |
| 搜索索引（web_search） | Figma 官方博客、presti.ai、Reddit/HN、tldraw pricing 页 | 行业共识与商业约束（二手） |

**触达失败清单（不静默跳过）**：krea.ai 直连 ERR_CONNECTION_TIMED_OUT；drawdy.io compare 页 fetch failed；beemmvision.com 正文 fetch failed（标题/描述经索引可得）；reactflow.dev 与 tldraw.dev 正文在 ego-browser 中 innerText 为空（SPA 未水合，仅标题可用）；beemmvision 正文未取。以上事实均按"二手/仅标题"降级记账。

---

## 2. 结论细则

### 2.1 模块级：确实现成（用户直觉正确）

| 模块（对应 C 任务） | 现成先例 |
|---|---|
| 无限画布 + pan/zoom + 视口裁剪 + 边索引 + 手势节流（C06/C07） | tldraw（商业 SDK）、React Flow（MIT）、Excalidraw（MIT）、LiteGraph（MIT，Canvas2D 渲染，"优化数百节点"） |
| 选择/框选/对齐分布/快捷键/右键/撤销重做（C08/C09） | Excalidraw（MIT）、tldraw、React Flow；LiteGraph README 明列 searchbox/keyboard/multiple selection/context menu |
| 版本化持久化 + 旧格式迁移（C04） | Excalidraw 文件格式与 "convert to new format" 流程（社区可见）；tldraw 的 store 迁移 |
| 变宽/按比例节点与 NodeResizer（C05/C06） | React Flow 自带 NodeResizer / NodeToolbar 示例（官方示例页）；各画布产品均按源图比例显示 |
| 导出 JSON / 拼版 PNG（C15） | Excalidraw export utils（MIT）、tldraw export（商业）、Fabric/Konva 的 toDataURL |
| 任务节点 + 队列 + 进度 + 失败重试（C10/C11） | InvokeAI（Apache-2.0，"Canvas and Workflows"）、ComfyUI Frontend（GPL-3.0，官方队列 UI）、Figma Weave / FLORA / Krea（产品形态） |
| 素材拖入 / 跨板复制 / 外部文件导入（C12） | 通用 drop + 上传路由模式；无专门库的必要 |
| 画布内布局/区域节点（C13/C14） | Figma Weave 的节点式工具（Inpaint/Outpaint/Mask/Relight/Compositing）、Krea 的 canvas + node workflow builder；MOSS 布局格式自身是私有契约，无开源实现 |
| 血缘/派生边（C01） | tldraw/React Flow 的 edge 持久化模式；但"面板生成血缘"是本项目特有业务语义，无直接先例 |

### 2.2 集成级：为什么"看到过"但不能"直接接"

| 候选 | 许可（一手） | 体积/依赖（npm 一手） | 数据模型与定位 | 判定 |
|---|---|---|---|---|
| tldraw | **自定义许可**：LICENSE 原文允许开发环境使用/修改/打包，但 **Production Environment 需要 License Key 或向 tldraw 购买替代许可** | 15,299 KB unpacked / 18 deps | 无限画布 SDK，最接近 D6 的自由画布 | **排除**（生产许可 + 体积，且与"不引新依赖"停止条件冲突） |
| React Flow（xyflow） | MIT（repo README + badge） | 1,283 KB unpacked / 4 deps | **节点图/流程图**编程模型（node+edge+handle），不是"自由摆放图片 + 任务节点"的图片画布 | **线索**：可读其 viewport/选择/NodeResizer 实现思路，不依赖 |
| Excalidraw | MIT | 874 KB unpacked（主包）/ 9 deps | 白板元素模型（矩形/文本/箭头/手绘），无任务节点、无图片生成链路 | **线索**：持久化版本迁移、选择/框选、导出工具可参考 |
| Konva | MIT（npm；GitHub API 显示 NOASSERTION 属识别误差，需以 npm LICENSE 为准） | 1,866 KB / 0 deps | Canvas2D 渲染引擎，只给"画/命中/变换"底层，不含编辑器状态机、持久化、节点体系 | **排除**：换引擎等于重写现有 DOM+transform 路线，收益不抵成本 |
| Fabric.js | MIT | 21,702 KB / 0 deps | Canvas 对象模型 + SVG 解析，偏"设计编辑器画布" | **排除**：体积与范式不匹配 |
| LiteGraph.js | MIT | 单文件无依赖 | 蓝图式节点图编辑器（Canvas2D），最后推送 2024-08，活跃度低 | **排除**；但"性能优化数百节点"的做法可作 C07 参考 |
| ComfyUI Frontend | **GPL-3.0** | 仓库体积 1.7 GB | 官方 ComfyUI 前端（节点工作流 + 队列） | **排除且许可红线**：GPL 代码不得拷入本项目 |
| InvokeAI | Apache-2.0 | 仓库 460 MB | 专业创作引擎，含 Canvas 与 Workflows | **排除**（体量与栈不匹配）；**UX/队列语义可参考**（Apache-2.0 允许借鉴思路） |

补充（一手）：本仓库与宿主 `resources/app/node_modules` 中都**没有任何**上述画布库（tldraw/xyflow/konva/fabric/excalidraw/litegraph 全部零命中），所以"宿主已经带了可复用库"这条捷径不存在。

### 2.3 生成式画布是成熟产品品类（D6 定位不孤）

- **Figma Weave（原 Weavy，2025 年末被 Figma 收购，传闻 >2 亿美元）**：节点式 AI 创作平台，一个节点一步、可分支/remix，内置 Invert/Outpaint/Crop/Inpaint/Mask Extractor/Upscale/Z Depth/Relight/图层与混合（官网一手文本）。Figma 称之为 "generative craft"。
- **FLORA**：自称 "Generative AI Canvas for Creative Teams"（官网标题，一手）。
- **Krea**：实时生成画布 + node workflow builder（二手媒体口径；官网本次直连失败）。
- **Freepik / Playground / Recraft / Higgsfield** 等同类；一篇比较文直接以「六个 node-based AI 画布」为题（二手，正文触达失败仅标题）。
- 结论：**"生成任务＝画布上一等节点、结果＝图片节点、可分支迭代"是行业共识形态**，与 D6 描述一致；我们的差异化在"本地 ComfyUI + 双底模 + 布局节点"这条链路，而非画布交互本身。

---

## 3. 证据账本（六维分 0–3：覆盖/接口吻合/许可/活跃/体积/集成风险，上限 18）

| id | 来源 | 类型 | 六维分 | 判定 | 状态 |
|---|---|---|---|---|---|
| e1 | https://raw.githubusercontent.com/tldraw/tldraw/main/LICENSE.md | 一手 | 4/1/0/2/1/1 = 9 | 生产需商业许可 | 用到了 |
| e2 | npm tldraw@5.6.1 registry | 一手 | –/–/–/–/–/– （体积 15,299 KB，18 deps） | 体积排除 | 用到了 |
| e3 | https://tldraw.dev/pricing（索引摘要） | 二手 | 覆盖 3 / 接口 2 / 许可 0 / 活跃 3 / 体积 1 / 风险 2 = 11 | **低于 12 分门限 → 排除** | 用到了 |
| e4 | HN 讨论 "massive license fee"（索引摘要） | 二手 | – | 佐证商业成本 | 只读过 |
| e5 | GitHub API tldraw/tldraw（51,457★，pushed 2026-11-17） | 一手 | 活跃 3 | 项目健康但许可不合格 | 用到了 |
| e6 | GitHub API xyflow/xyflow（39,059★，MIT，pushed 2026-11-17） | 一手 | 覆盖 2 / 接口 1 / 许可 3 / 活跃 3 / 体积 2 / 风险 2 = 13 | **≥12 分但 V≈0.3（node-graph 非图片画布）→ 线索** | 用到了 |
| e7 | https://reactflow.dev/examples（索引摘要，NodeToolbar/NodeResizer） | 二手 | – | C05/C06 先例 | 用到了 |
| e8 | GitHub API excalidraw/excalidraw（135,854★，MIT） + npm 874 KB | 一手 | 覆盖 2 / 接口 1 / 许可 3 / 活跃 3 / 体积 3 / 风险 1 = 13 | **线索**（数据模型不同） | 用到了 |
| e9 | Reddit "convert to new format"（索引摘要） | 二手 | – | C04 版本迁移先例 | 只读过 |
| e10 | InvokeAI README + GitHub API（29,105★，Apache-2.0） | 一手 | 覆盖 2 / 接口 1 / 许可 3 / 活跃 3 / 体积 0 / 风险 2 = 11 | 排除依赖；UX 参考 | 用到了 |
| e11 | GitHub API Comfy-Org/ComfyUI_frontend（2,132★，GPL-3.0） | 一手 | 许可 0 | **许可红线** | 用到了 |
| e12 | LiteGraph README + GitHub API（8,185★，MIT，pushed 2024-08） | 一手 | 覆盖 1.5 / 接口 1 / 许可 3 / 活跃 1 / 体积 3 / 风险 2 = 11.5 | 排除；算法参考 | 用到了 |
| e13 | GitHub API konvajs/konva（14,989★）；npm MIT 1,866 KB | 一手（许可以 npm 为准，API NOASSERTION 为识别误差） | 12 | 引擎层，不采用 | 用到了 |
| e14 | GitHub API fabricjs/fabric.js（31,559★，MIT）；npm 21,702 KB | 一手 | 11 | 排除 | 用到了 |
| e15 | Figma 官方博客标题 "Introducing Figma Weave: The Next Generation of AI-Native Creation at Figma" | 一手（标题） | – | 品类确认 | 用到了 |
| e16 | presti.ai "Figma Weave alternatives"（正文已抓） | 二手 | – | Weavy/Freepik/Flora 同idea；Figma 收购 Weavy >2 亿美元；Krea 实时画布 + node builder | 用到了 |
| e17 | weave.figma.com 首页文本（ego-browser 一手） | 一手 | – | 多模型 + 节点式 + Inpaint/Outpaint/Mask/Relight 工具 | 用到了 |
| e18 | flora.ai 标题（ego-browser 一手） | 一手（标题） | – | "Generative AI Canvas for Creative Teams" | 用到了 |
| e19 | beemmvision.com 标题/描述（索引；正文触达失败） | 二手 | – | "six node-based AI canvases compared"（Figma Weave/FLORA/Krea/ComfyUI/Higgsfield） | 用到了 |
| e20 | 本地依赖树扫描（repo + 宿主） | 一手 | – | 零命中，宿主无可用画布库 | 用到了 |
| e21 | tldraw 演讲摘要 "people building canvas apps got stuck on the canvas itself, on selection and resizing and matrix math" | 二手 | – | **反证：采用派的最强论据** | 用到了 |

触达失败（记账）：krea.ai 直连超时；drawdy.io compare 页 fetch 失败；beemmvision 正文 fetch 失败；reactflow.dev/tldraw.dev 正文 innerText 空（仅标题）。

---

## 4. C01–C15 逐任务先例对照与建议

| 任务 | 先例 | 吻合度 | 判定与建议 |
|---|---|---|---|
| C01 血缘持久化 | tldraw/React Flow 的 edge 持久化；本业务语义无先例 | 低 | 自研（业务语义），实现可参考邻接表+索引两种存法；现状方案（path→id 解析）已落地 |
| C02 去重字段 bug | 无（本地 bug） | – | 自研修 bug |
| C03 卫生批 | 无 | – | 自研 |
| C04 board v2 + 懒迁移 | Excalidraw 文件格式版本与 "convert to new format"；tldraw store 迁移 | 中 | 自研，但**格式版本字段与迁移函数命名/测试策略参照 Excalidraw**（MIT，可读源码） |
| C05 宽高比几何 | React Flow NodeResizer、各产品按比例节点 | 高（模式） | 自研纯函数；无需库（一行 clamp 公式） |
| C06 渲染接线 | 同上 | 高 | 自研；zoom 范围 0.1–4 与 Figma/Krea 一致区间 |
| C07 裁剪/边索引/节流 | React Flow（@xyflow/system 的可见性计算）、Excalidraw scene culling、LiteGraph 大图优化 | 高 | **自研，算法读 MIT 源码后重写**（不 vendor）；验收用"节点数→帧耗时"压测 |
| C08 交互纯函数层 | Excalidraw selection/marquee/align/undo（MIT）；tldraw（许可不可读码生产） | 高 | 自研；**参考 Excalidraw 的 undo 栈与对齐吸附实现** |
| C09 交互接线 | 同上 | 高 | 自研；DOM 手势层无自动化，沿用"纯函数全覆盖 + 实机抽查"策略 |
| C10 任务节点后端 | ComfyUI Frontend 队列（GPL，仅读）、InvokeAI（Apache-2.0，读思路） | 中 | 自研（我们已有 T16 SSE/prompt_id 语义）；**clientId+runs 注册表是标准做法** |
| C11 任务节点前端 | Figma Weave / FLORA / Krea 的产品形态；InvokeAI 队列 UI | 高（UX） | 自研；UX 参考先行产品（占位→进度→失败重试→原地转结果） |
| C12 素材双向流 | 通用 drop/upload 模式 | 高（模式） | 自研；无库需求 |
| C13 布局节点 | Figma Weave 工具节点/蒙版、Krea region 控制；MOSS 布局格式无开源实现 | 中（UX） | 自研；**这是本项目最强差异化，无从借用** |
| C14 布局闭环 | Regional Prompter / Attention Couple / InvokeAI regional prompts（思路） | 中 | 自研；契约以 T21 落定为准 |
| C15 保存/导出/压测 | Excalidraw export utils、tldraw export、Fabric/Konva toDataURL | 高 | 自研；PNG 拼版用 offscreen canvas 是标准做法，可参考 Excalidraw 的边界计算 |

**总判定**：15 个任务里 **12 个有可直接阅读的先例、3 个（C01/C02/C03）是本项目特有点**；但"有先例"不等于"该依赖"——上表全部判定为**自研 + 借用思路**，与 DD1/「不引新依赖」一致。

---

## 5. 反证（必做：站在"应该采用现成库"一侧找证据）

1. **tldraw 的论点成立且锋利**：tldraw 官方演讲摘录——"people building canvas apps got stuck on the canvas itself, on selection and resizing and matrix math, and never got to the actual product"（e21）。这正好是 C07–C09 的工作量；若采用 tldraw，这些代码一行不用写。**这是本轮最强的反面证据。**
2. **React Flow 的 NodeResizer/NodeToolbar 内置**（e7）说明 C05/C06 类工作也有现成组件。
3. **但三条硬约束把"采用"挡住**：
   - 许可：tldraw 生产环境必须买许可（e1 原文 + e3 pricing + e4 社区吐槽）；ComfyUI_frontend 是 GPL-3.0（e11）——拷代码即传染，读代码也有合规风险；
   - 体积/依赖面：tldraw 15.3 MB unpacked/18 deps（e2），本项目 client bundle 目前 ~125 KB（见 `lib/client.js`），相差两个数量级；
   - 数据模型：React Flow 是"编程思考用"的节点图（handle 连线、参数），D6 明确"不做 Comfy 式参数连线编排"；Excalidraw 是白板元素，无任务/血缘/布局节点。接进来都要包一层适配，等于两套模型并存。
4. **迁移成本 vs 剩余范围**：C01/C03–C08 已提交（约一半已实现完），现在换 tldraw 等于把已完成部分推翻重写，且 T20 布局编辑器（compiled 契约）、boards v2、T14 下载通道等周边都要重接。成本远高于"继续自研 + 借思路"。
5. **如果将来 D6 扩到自由绘制/文本/图层/实时协作**（tldraw 的强项），结论应翻转——那时 tldraw 的许可费可能是合理成本。触发条件已记在 EXECUTION-PLAN §8b-4。

---

## 6. 对计划与任务书的修订建议

1. **EXECUTION-PLAN §6d 增加"先例参考"约定**：每个 C 任务的执行者开工前读本报告 §4 对应行；MIT 项目（React Flow/Excalidraw）**只读源码提炼算法，不复制代码、不引依赖**；GPL/自定义许可项目（ComfyUI_frontend/tldraw）**只可看公开文档与产品行为，不读拷源码**。
2. **不新增依赖**（沿用共同停止条件）；若某任务确需库，停下报协调者。
3. **C04/C07/C08/C15 的建议**写入任务书执行注记：C04 参照 Excalidraw 的 version+迁移测试形态；C07 参照 @xyflow/system 的可见性计算思路；C08 参照 Excalidraw 的 undo/align 语义；C15 参照 Excalidraw 导出边界计算。
4. **C13/C14 明确标注"无开源先例，是本项目差异化"**——执行者不要期待找到可直接抄的实现，UX 只参考 Figma Weave/Krea 的产品行为。
5. **§8b-4（tldraw 重评）补一句**：本报告 §5 已给出重评触发条件（自由绘制/文本/图层/协作成为需求；或预算允许商业许可），当前结论维持"不引入"。

---

## 7. 本轮收口（按 skill 模板）

- 结论：模块确实现成（12/15 有先例），但没有可接的库（0 个"接现成"），维持自研 + 借思路。
- 置信度：medium（许可/体积/元数据一手；产品功能面部分二手）。
- 能推翻它的条件：① D6 范围扩大到自由绘制/文本/图层/实时协作；② 拿到 tldraw 商业许可且接受 ~15 MB client 体积；③ 出一版"用 React Flow 重写 C06–C09"的原型，证明适配层成本低于自研剩余量；④ 发现任一 MIT 库（如 Excalidraw）可直接承载"图片节点+任务节点+血缘边"而不改数据模型。
- 未解子问题：Excalidraw 源码级实现细节（本轮只到 README/二手）；Krea 官网直连失败，其 canvas 规格按二手描述；beemmvision/drawdy 正文未取到，比较结论仅按标题与摘要。
- 覆盖率：7 个子问题（引擎/交互/持久化/导出/任务节点/产品形态/许可约束）中 4 answered + 3 partial → coverage = (4 + 1.5)/7 ≈ **0.79**（未达 0.9，但 pFlip 按"稳定技术事实"0.15 判停：继续查不会改变"没有可接库"的结论）。
- 本轮成本：约 45 分钟（3 批搜 ≈4.5 + 6 处一手读取 ≈24 + 2 轮扩展 ≈19.5），约 6,750 token 折算。

---

## 附：原始读数（一手，2026-11-17）

| 仓库 | ★ | 许可 | 最近推送 | 仓库体积 |
|---|---|---|---|---|
| xyflow/xyflow | 39,059 | MIT | 2026-11-17 | 47,447 KB |
| tldraw/tldraw | 51,457 | NOASSERTION（自定义许可，生产需商业授权） | 2026-11-17 | 1,655,394 KB |
| excalidraw/excalidraw | 135,854 | MIT | 2026-11-17 | 109,933 KB |
| konvajs/konva | 14,989 | NOASSERTION（npm 为 MIT） | 2026-11-16 | 23,558 KB |
| fabricjs/fabric.js | 31,559 | MIT | 2026-11-17 | 262,445 KB |
| jagenjo/litegraph.js | 8,185 | MIT | 2024-08-01 | 28,827 KB |
| Comfy-Org/ComfyUI_frontend | 2,132 | **GPL-3.0** | 2026-11-17 | 1,766,328 KB |
| invoke-ai/InvokeAI | 29,105 | Apache-2.0 | 2026-11-17 | 460,829 KB |

| npm 包 | 版本 | 许可 | unpacked | 直接依赖数 |
|---|---|---|---|---|
| @xyflow/react | 13.0.1 | MIT | 1,283 KB | 4 |
| tldraw | 5.6.1 | SEE LICENSE IN LICENSE.md | 15,299 KB | 18 |
| konva | 10.9.1 | MIT | 1,866 KB | 0 |
| fabric | 7.4.0 | MIT | 21,702 KB | 0 |
| excalidraw | 0.6.4 | MIT | 874 KB | 9 |

（完）