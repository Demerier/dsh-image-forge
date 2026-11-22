/**
 * The Studio's pure contract: what the panel is allowed to send, what the host
 * resolves it to, and how the optimiser's answer is taken apart.
 *
 * Everything here runs against the `testlib/` logic bundles rather than a live
 * socket, because the interesting failures are all *before* the wire: a ratio
 * the panel invented, a step count past the clamp, a body that carries a
 * megabyte of JSON pretending to be a reference image. The HTTP framing
 * (`readBody`'s cap, the heartbeat, the 500 guard) is exercised by the e2e
 * harnesses instead; asserting it here would mostly test `node:http`.
 *
 * The one thing this file deliberately does *not* do is generate. A real draw
 * needs ComfyUI, and a fake one would assert that a mock returns what the mock
 * was given. The split points that make generation deterministic — the resolved
 * canvas and the resolved step count — are covered directly instead.
 *
 * The T18 section at the bottom is the one exception to "logic bundles only":
 * the workbench now consumes the plugin's SSE progress stream, and that path
 * (event → state → rendered text) is worth executing rather than grepping. It
 * runs the real §lib/client.js§ through a fake module loader, a minimal React
 * and a fake EventSource; see the section note for what that does and does not
 * prove.
 *
 * ## What left automation in U04 step 1b, and where it stands after step 2
 *
 * Step 1b replaced the hand-rolled canvas with React Flow (`src/canvas-pane.ts`).
 * React Flow needs a real DOM: a measured container, `ResizeObserver`, pointer
 * capture and a browser's event model. The renderer in `./harness.mjs` has none
 * of those — it calls function components against a hook store and walks
 * descriptors — so every case that *drove or inspected the rendered canvas* was
 * moved out of automation rather than weakened. They are listed here because a
 * green run must not read as "these still pass":
 *
 *   - selection, Ctrl-toggle and marquee box            (S2 — 已接线,待人工验收)
 *   - Delete / Ctrl+Z / Ctrl+Shift+Z on the canvas      (S2 — 已接线,待人工验收)
 *   - the shortcut table and Escape-clear               (S2 — 已接线,机器可见: Ctrl+A 与 Esc
 *                                                        由 `U04 S2` 用例经 canvas 容器驱动)
 *   - the right-click menu, on blank canvas and a node  (S2 — 已接线,待人工验收: 菜单数据
 *                                                        `contextMenuItems` 与其映射仍由
 *                                                        `canvas-interactions.test.mjs` 断言)
 *   - node drag and its write-back                      (S2 — 半自动: 纯函数 `foldDragChanges`
 *                                                        + `snapshotCommand` 的 undo 链路已断言,
 *                                                        真实指针拖动待人工/ego-browser)
 *   - fit (`F` / 适应) 与缩放下限提示                    (S2 — 半自动: `fitWouldClamp` 已断言,
 *                                                        React Flow 的实际取景待人工)
 *   - the output handle, its screen size and the wire   (S3 — 已接线,待人工验收: 判据见下方
 *                                                        "U04 step 3" 清单；纯函数
 *                                                        `planConnectionDrop`/`judgeConnection` 由
 *                                                        `canvas-flow-model.test.mjs` 断言)
 *   - drop-to-create: draft / 布局 / 素材 picker         (S3 — 已接线,待人工验收: 菜单数据与三条
 *                                                        动作的映射由 `canvas-connections.test.mjs`
 *                                                        断言,卡片由 `runConnectTarget` 复用)
 *   - copy/move to another board from the node menu     (S3 — 保持原样,仍待人工验收)
 *   - the lightbox (G22) and its arrow keys             (S2 — 双击经 `onOpen` 接线,覆盖层
 *                                                        与 ←/→ 待人工验收)
 *   - the task node: clientId binding, retry, interrupt (S4 — 已接线,待人工验收: 状态→按钮集合由
 *                                                        `taskNodeActions` 纯函数断言，四颗按钮到
 *                                                        studio 回调的桥接由 `U04 S4` 用例断言；
 *                                                        引擎里的实际点击待人工)
 *   - the layout node: rebuild, create, generate, save  (S4 — 半自动: 重建后的尺寸与草稿一致性由
 *                                                        `canvas-flow-model.test.mjs` 断言，编辑→
 *                                                        `save-layout-node` 的接线由 `U04 S4`
 *                                                        断言，内嵌编辑器在引擎容器里的手感待人工)
 *   - the camera a board reopens at, and 居中揭示        (S4 — 半自动: `initialFlowView` /
 *                                                        `flowViewportProps` / `planReveal` 三个纯函数
 *                                                        断言了"恢复 xor 取景"与揭示目标，引擎里真的
 *                                                        不闪、真的居中待人工)
 *
 * Their replacements are, in order: `test/canvas-flow-model.test.mjs` for the
 * board→flow mapping (geometry, kinds, edges, selection — the part that *is*
 * decidable without a browser, including the C13 "persisted layout entry
 * rebuilds with its draft and display box" assertion) and for step 2's
 * interaction glue (the drag reducer, the viewport→camera conversion, the
 * marquee hit test and the library's switched-off key bindings); the `U04 S2`
 * cases at the bottom of this file for the wiring that a host element can still
 * expose; `test/bundle-xyflow.test.mjs` for the shipped artifact; and a manual /
 * ego-browser checklist per phase for the rest. The gesture state machines
 * themselves never lost coverage: `canvas-interactions.test.mjs`,
 * `canvas-connections.test.mjs` and `canvas-export.test.mjs` are untouched.
 *
 * What remains here about the canvas is what a Node process can still prove:
 * the copy the bundle ships (`dsh-forge-canvas` strings), the pure geometry
 * (zoom floor, thumbnails), the board writers' validation, and — since step 2 —
 * the keyboard the flow canvas forwards to the studio's shortcut table, plus the
 * `U04 S3` case for the wire's wiring and its "no generation" guarantee.
 *
 * ## U04 step 3 的人工验收清单(拖线)
 *
 * React Flow's drag needs a measured viewport, `XYHandle`'s document listeners
 * and pointer capture — none of which this renderer produces — so the gesture
 * itself is a browser check. What to look at, in order:
 *
 *   1. 悬停任意图片/布局节点,右侧出现输出点;按住拖动,出现**蓝色虚线**,终点跟着指针;
 *      越过图片节点时线**吸附到该节点左侧输入点**并转蓝,越过任务/草稿节点转红。
 *   2. 松手在**空白画布**:弹"在这里新建(血缘指向来源)"卡片,原地建节点
 *      (图片生成 → 草稿节点 + 表单参考图预填 + 焦点进 prompt;布局 → 布局节点即时落库;
 *      放入素材 → 卡片内长出素材列表)。三种都不发 `/studio/generate`。
 *   3. 松手在**已有图片节点**上:只多一条血缘线,节点数不变,网络面板里**没有任何
 *      `/studio/generate`**;Ctrl+Z 撤掉这一条边。重复拖同一条线不再产生撤销步。
 *   4. 取消:拖回源节点松手 / 按下不动(<4 px)/ 拖动中按 Esc / 拖到会成环或到非图片
 *      节点 —— 四者都**不建节点、不入撤销栈**;后两者给一句提示。
 *   5. 平移/缩放到 40% 后再拖:预览线终点仍贴着指针(这条最容易暴露坐标系错误)。
 *   6. 菜单打开后按 Esc:卡片关闭,画布上不多任何节点。
 *
 * ## U04 step 4 的人工验收清单(相机、任务节点、布局节点)
 *
 * 1. 相机恢复:把画布平移到一块空白处并缩放到 ~150%,切到另一个页签再切回来 ——
 *    视野**就是离开时的那一块**,不是"全部节点被框住";关掉页签重开(重新读盘)也一样。
 *    新建一个没有存过相机的空画板 —— 它**被框住**(fitView),而不是跳到某个角落。
 * 2. 居中揭示:素材页点一张图"在画布中显示" —— 该节点**出现在视口中央**且缩放不变;
 *    同一动作在引擎里只移动一次,没有"先框住再跳过去"的两段位移。
 * 3. 任务节点:发起一次生成,节点从 待开始 → 排队中 → 生成中 且进度条随流推进;
 *    期间画布其它节点**不闪烁**(含被拖动中的节点不回弹);中断任务后出现 重试,
 *    点 重试 复用同一份参数原地重跑;失败后点 编辑参数 **抽屉变成可编辑**(U05 起不再
 *    回填表单)、改完「重新生成」替换该节点;移除不删文件。
 * 4. 布局节点:拖入/新建一个布局节点,拖动里面任何一个框 —— 画布不跟着平移(手势被隔离);
 *    改完刷新页面,草稿与显示框都还在;拉宽节点,高度按草稿比例走,草稿不变;
 *    在 50% 与 200% 缩放下各拖一次框,框的位移与指针**一致**(不出现双倍/半速)。
 *
 * ## U05 的人工验收清单(节点属性抽屉)
 *
 * 左栏表单在**画布页签**已经不存在了;它只剩在 列表 / 素材 两个页签里。要看的:
 *
 * 1. 打开一个画布页签:左半边**没有**表单,画布占满宽度,右边缘是一条 320 px 的
 *    抽屉位;未选中任何节点时那里只有一句"选中一个节点查看属性",不可编辑。
 * 2. 点画布左上"新建生成":画布上出现一个虚线"待生成"节点,抽屉切到**可编辑**:
 *    描述 / 七档比例 / 步数 / 张数 / 种子 都在里面,光标已在描述框里。
 * 3. 填完点「生成」:图落在那个虚线节点的位置(不是画布末尾),血缘线指向来源;
 *    抽屉随后显示**图片**的属性(提示词首行 / 尺寸 / 步数 / 种子 / 底模 / 文件路径),
 *    全部只读。
 * 4. 选中一张图 → 抽屉里「按这张继续」:图片右侧多一个待生成节点,抽屉的参考图里
 *    就是这张图;写一句改图描述再生成,出图能与原图对比。
 * 5. Ctrl+A 选中多个节点:抽屉退回"选中一个节点查看属性"(多选不是单个节点的属性);
 *    点空白处取消选择,抽屉同样退回。
 * 6. 把一个生成任务拖到失败(停掉 ComfyUI 再生成):节点上有 重试 / 编辑参数;
 *    点「编辑参数」抽屉变成可编辑,**改完点「重新生成」在原地替换**这个节点,
 *    布局参数(如果来自布局节点)没有被丢掉。
 * 7. 面板拉窄到 760 px 以下:抽屉变成画布右侧的**覆盖层**(不再挤压画布),
 *    仍可点击、可滚动;拉宽回去恢复并排。
 * 8. 切到 列表 / 素材 页签:老表单仍在(本轮不动它们);切回画布页签,表单不在,
 *    抽屉回来。刷新页面后草稿节点不会被持久化(它是内存态,重开画板就没了)。
 *
 * ## U06 的人工验收清单(节点详情页签)
 *
 * 详情页签是**面板内**页签,和「项目管理」「画布:xxx」同级。机器能验的是页签出现/消失、
 * 标题、pane 的字段与按钮、`save-layout-node` 的请求体、以及「生成」回到画布走同一条
 * 请求;验不了的是**画布里那个节点长什么样**(`FlowCanvas` 要量容器,这个渲染器没有 DOM,
 * 引擎永远停在「画布准备中…」)和编辑器的拖拽手感。要看的:
 *
 * 1. 选中一个布局节点 → 右侧抽屉底部出现「打开详情」;点它 → 页签条上多出一个
 *    「布局 · <项目名>」页签,**紧挨着**来源画布页签,并自动激活。
 * 2. 详情页签里是**全宽**的 MOSS 编辑器(不是 480 世界单位的小框),上面一行是
 *    草稿尺寸 / 画框数量 / 映射画幅;拖任意一个框,框跟手,画布不跟着平移。
 * 3. 松手后 700 ms 内网络面板里出现一次 `save-layout-node`,body 里的 `draft` 与
 *    编辑器所见一致,`w` 仍是节点自己的、`h` 按草稿比例;点「撤销」把上一版找回来。
 * 4. **双写防护**:在详情页签打开的情况下切回画布页签 → 那个布局节点变成**只读缩略**
 *    (灰底 + 蓝框 + 「在详情页编辑」),里面**没有**可拖的框;点「在详情页编辑」回到
 *    详情页签;关掉详情页签再回画布,编辑器**回来了**且是最新草稿。
 * 5. 详情页签里点「生成」→ 自动切到画布页签,画布上出现任务节点并跑完,
 *    结果图的血缘线指回布局节点;详情页签本身**仍然开着**(没被关掉)。
 * 6. 「返回画布」回到来源画布页签;先关掉画布页签再点它 → 项目被重新打开。
 * 7. 关掉画布页签 → 它的详情页签**一起消失**(WD2);只关详情页签时画布不受影响。
 * 8. 图片节点:抽屉「打开详情」→ 「图片 · <时间>」页签,大图 + 元信息 + 「按这张继续」;
 *    任务节点:「任务 · <prompt 首行>」页签,全参数 + 失败原因 + 「重试」。
 * 9. 窄面板(< 760 px)下详情页签的大图与信息栏**上下堆叠**,不出现横向滚动。
 *
 * ## U08 的人工验收清单(全局素材库)
 *
 * 机器能验的是:库在 projects 页签里(`/studio/assets` 请求**不带 board**)、条目数、
 * 搜索/范围/排序的过滤结果、跨板动作的请求体、无画布时按钮 disabled,以及
 * `remove-item` 的 `deleteFile` 口径。验不了的是拖拽手感、缩略图是否真的清晰、
 * 以及"在画布中打开"之后**画布里那张图的样子**(React Flow 要量容器,这个渲染器没有 DOM)。
 * 要看的:
 *
 * 1. 项目管理页签工具条右侧「全局素材」→ 页签条**不新增页签**,面板内换成素材库;
 *    工具条变成 搜索 / 全部项目 / 排序 / 张数 / 刷新 / 返回项目。
 * 2. 一个项目都没打开时:每张卡片的「在画布中打开」是**灰的**,上方一行提示
 *    "先打开一个项目…";打开一个项目再回到素材库,同一个按钮变成可用,提示改成
 *    "…放进「<项目名>」的画布"。
 * 3. 搜索框输入提示词片段 / 文件名 / 项目名都能筛到图;清空即恢复;切"全部项目 ↔ 单个项目"
 *    即时生效,**网络面板里不出现第二次 `/studio/assets`**。
 * 4. 排序切 最新 / 最大 / 名称,顺序随之变化,且相同时按最新在前。
 * 5. 点一张别的项目的图「在画布中打开」:自动切到那个画布页签,画布上**多出一个节点**
 *    (落在网格位),网络面板里只有一次 `copy-item`;同一项目里的图点它 → **不复制**,
 *    只切到页签并提示"已经在这个画布里"。
 * 6. 「复制 / 移动…」→ 选目标项目 → 复制:目标项目卡片条目数 +1,文件仍是同一张
 *    (磁盘上**没有**多一个 PNG);移动:源项目 −1、目标 +1,图片文件不变。
 * 7. 「删除文件」→ 先出现确认(说明项目名、体积、"不可撤销"),**未点击前不删**;
 *    确认后文件从磁盘消失、条目消失。另一项目也引用同一张图时,文件**保留**,
 *    提示明确说"文件还在",另一个项目里的图仍能显示。
 * 8. 切到别的页签再切回项目管理:素材库**还在**(子视图是外壳状态，不因页签切换退回项目网格）；
 *    搜索词与范围会重置——与项目网格的搜索框行为一致(两个视图都随面板卸载复位)。
 * 9. 画布页签内那条老「素材」视图仍在(三视图之一,默认本画板)——它列出的是**同一个项目**
 *    的图;两处列表的关系是"全局 vs 当前项目",不是两份不同的数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The renderer is shared with `test/workbench-shell.test.mjs`: since the shell
// seats the studio inside a tab, a harness that only walked host elements
// could no longer see it (see `test/harness.mjs`).
import {
  collectChildren,
  createPanel,
  fakeElementWithClass,
  fakeResponse,
  fakeText,
  fakeVisit,
  findAll,
  loadClientBundle,
  sameDeps,
  settle,
} from './harness.mjs'
import {
  CHILD_OFFSET_X,
} from '../testlib/studio-canvas.js'
import {
  decodeImportData,
  parseBoardAction,
  parseGenerate,
  parseImport,
  parseOptimize,
  registerStudioRoutes,
} from '../testlib/studio-routes.js'
import {
  resolveStudioSteps,
  studioSettingsOf,
  studioSize,
  studioSizeTable,
  studioTextToImageRequestOf,
} from '../testlib/studio-service.js'
import {
  DEFAULT_MOSS_SAMPLING,
  MODEL_PROFILES,
  MOSS_SAMPLING_PRESETS,
  TURBO_SIGMAS,
  renderTextToImage,
  TURBO_STEPS,
  effectiveProfile,
  presetSteps,
  resolveProfile,
  resolveSampling,
  turboUnetOf,
} from '../testlib/comfyui.js'
import {
  FORMULA_SYSTEM_PROMPT,
  PROSE_SYSTEM_PROMPT,
  buildOptimizeUserText,
  systemPromptFor,
  llmOf,
  resolveOptimizerFor,
  splitOptimizerAnswer,
  stripWrappingQuotes,
} from '../testlib/studio-prompt.js'
import {
  STUDIO_ASSETS_ROUTE,
  STUDIO_BOARD_ROUTE,
  STUDIO_CLIENT_ID_MAX_CHARS,
  STUDIO_CONFIG_ROUTE,
  STUDIO_ENVIRONMENT_ROUTE,
  STUDIO_EVENTS_ROUTE,
  STUDIO_GENERATE_ROUTE,
  STUDIO_IMPORT_MAX_ITEM_BYTES,
  STUDIO_IMPORT_ROUTE,
  STUDIO_LAYOUT_RATIO_TOLERANCE,
  STUDIO_MAX_COUNT,
  STUDIO_MAX_PROMPT_CHARS,
  STUDIO_RATIOS,
  fitStudioRatio,
  formatBytes,
  isStudioClientId,
  stepperStepsOf,
} from '../testlib/studio-shared.js'
import { compileLayout } from '../src/layout-editor.ts'
// G26: the edge's persistence is asserted against the *current* route parser and
// board store rather than the `testlib/` snapshot — that snapshot is rebuilt only
// when the whole host bundle is, and this contract is newer than it.
import { parseBoardAction as parseBoardActionLive } from '../src/studio-routes.ts'
import {
  readBoard as readBoardLive,
  recordItems as recordItemsLive,
  saveLayout as saveLayoutLive,
} from '../src/boards.ts'
// G27: the handle's size rule is split between the constants the state machine
// owns and the `calc()` the stylesheet writes; reading both from source is what
// lets the test pin one to the other instead of restating the numbers.
import { HANDLE_SCREEN_HIT, HANDLE_SCREEN_SIZE } from '../src/canvas-connections.ts'
import { STUDIO_CSS, WORKBENCH_CSS } from '../src/client-styles.ts'
// U05: the drawer's decisions are pure and live in their own module — the same
// split the canvas uses (`canvas-flow-model.ts`). Importing the *source* keeps the
// assertions on the code that ships rather than on a `testlib/` snapshot that is
// only rebuilt with the whole host bundle; this module has no Node-only imports
// (its one dependency is `react`, which only the renderer needs).
import {
  EMPTY_DRAFT_VALUES,
  INSPECTOR_EMPTY_HINT,
  INSPECTOR_MAX_SEED,
  INSPECTOR_MAX_STEPS,
  canGenerateFromDrawer,
  draftParamsOf,
  generateParamsBody,
  inspectorRatio,
  inspectorSpecFor,
  inspectorTargetOf,
  inspectorValuesOf,
  inspectorVisible,
  patchDraftParams,
} from '../src/node-inspector.ts'
// U06: the node detail tab's decisions, imported from the shipped source for the
// same reason as the drawer's above — they are pure, and a `testlib/` snapshot
// would only be rebuilt with the whole host bundle.
import {
  EMPTY_DRAFT_HISTORY,
  NODE_DETAIL_KIND_LABELS,
  NODE_DETAIL_TITLE_MAX,
  DetailEditorClaims,
  clockOf,
  detailIntentOf,
  detailKindOfNodeKind,
  detailViewOf,
  draftPreviewBoxes,
  intentAppliesTo,
  intentFor,
  layoutDetailSummary,
  layoutEditorOwner,
  layoutGeneratePlan,
  layoutWriteOf,
  nodeDetailTitle,
  openDetailItemIds,
  pushDraftHistory,
  shortSubject,
  undoDraftHistory,
} from '../src/node-detail-pane.ts'
// U08: the asset library's filters, orders and cross-tab rule are pure and live
// in their own module — imported from the source that ships, like the drawer's
// and the detail tab's decisions above. `react` is its only dependency.
import {
  ASSET_SCOPE_ALL,
  ASSETS_BOARD_EMPTY_COPY,
  ASSETS_EMPTY_BODY,
  ASSET_NEEDS_PROJECT_COPY,
  ASSET_PAGE_LIMIT,
  ASSET_SORT_LABELS,
  ASSET_SORTS,
  ASSET_THUMB_WIDTH,
  assetDimensions,
  assetFilter,
  assetSizeLabel,
  assetSort,
  assetThumbUrl,
  assetTimeLabel,
  assetTitle,
  assetsScopeHint,
  canvasTargetBoard,
} from '../src/workbench-assets.ts'

/** The authoritative compiled-layout sample (T21's format authority). */
const LAYOUT_SAMPLE = readFileSync(fileURLToPath(new URL('../verify/layout_prompt.json', import.meta.url)), 'utf8')
import { resolveDefaultSize } from '../testlib/ratio.js'

// The published surface is exactly `Config, apply, inject, name` (asserted in
// settings.test.mjs), so the Studio constants are deliberately *not* re-exported
// from the plugin entry — importing them above reads the same module the host
// and the panel both compile against.

// ---------------------------------------------------------------------------
// Request validation: the panel is not trusted, even though we wrote it.
// ---------------------------------------------------------------------------

test('a generated body is narrowed to exactly the fields the pipeline reads', () => {
  const parsed = parseGenerate({ prompt: '  一只橘猫坐在窗台上  ', ratio: '16:9', steps: 24, count: 2, seed: 7 })
  assert.deepEqual(parsed, { prompt: '一只橘猫坐在窗台上', ratio: '16:9', steps: 24, count: 2, seed: 7 })
  // Omitted fields stay absent rather than becoming 0 or NaN: `undefined` is the
  // signal that lets the host fall back to its configured default.
  const minimal = parseGenerate({ prompt: '猫', ratio: '1:1' })
  assert.deepEqual(minimal, { prompt: '猫', ratio: '1:1' })
  assert.ok(!('steps' in minimal), 'an omitted step count must not appear as a key')
})

test('the ratio must be one the picker actually offered', () => {
  // A ratio is the one field that becomes pixels, so an unknown one is refused
  // here rather than silently coerced into a square.
  assert.throws(() => parseGenerate({ prompt: '猫', ratio: '5:4' }), /不支持的画幅比例：5:4/)
  assert.throws(() => parseGenerate({ prompt: '猫', ratio: '16x9' }), /不支持的画幅比例/)
  // Surrounding whitespace is trimmed before the comparison, so a trailing space
  // from the DOM is not a refusal.
  assert.equal(parseGenerate({ prompt: '猫', ratio: ' 16:9 ' }).ratio, '16:9')
  for (const ratio of STUDIO_RATIOS) {
    assert.equal(parseGenerate({ prompt: '猫', ratio }).ratio, ratio)
  }
})

test('an empty or oversized prompt is refused with a message the panel can show', () => {
  assert.throws(() => parseGenerate({ ratio: '1:1' }), /请输入提示词/)
  assert.throws(() => parseGenerate({ prompt: '   ', ratio: '1:1' }), /请输入提示词/)
  assert.throws(() => parseGenerate({ prompt: 'x'.repeat(STUDIO_MAX_PROMPT_CHARS + 1), ratio: '1:1' }), /最多 4000 个字符/)
  // Exactly at the cap is legal — an off-by-one here would reject a prompt the
  // optimiser itself can produce.
  assert.equal(parseGenerate({ prompt: 'x'.repeat(STUDIO_MAX_PROMPT_CHARS), ratio: '1:1' }).prompt.length, STUDIO_MAX_PROMPT_CHARS)
})

test('a non-numeric step, seed or count is a refusal, not a silent zero', () => {
  for (const field of ['steps', 'seed', 'count']) {
    assert.throws(() => parseGenerate({ prompt: '猫', ratio: '1:1', [field]: 'many' }), /必须是数字/, `${field} as a string`)
    assert.throws(() => parseGenerate({ prompt: '猫', ratio: '1:1', [field]: Number.NaN }), /必须是数字/, `${field} as NaN`)
    assert.throws(() => parseGenerate({ prompt: '猫', ratio: '1:1', [field]: Infinity }), /必须是数字/, `${field} as Infinity`)
  }
  // Fractions truncate; the clamp in `resolveStudioSteps` handles the rest.
  assert.equal(parseGenerate({ prompt: '猫', ratio: '1:1', steps: 23.9 }).steps, 23)
})

test('a body that is not an object is refused', () => {
  for (const body of [undefined, null, 'a string', 42, []]) {
    assert.throws(() => parseGenerate(body), /请求格式无效/)
  }
})

test('reference images carry base64 and are rejected when empty', () => {
  const parsed = parseGenerate({
    prompt: '把背景换成夜景',
    ratio: '4:3',
    references: [{ data: 'AAAA', mediaType: 'image/jpeg', name: '  base.png  ' }],
  })
  assert.deepEqual(parsed.references, [{ data: 'AAAA', mediaType: 'image/jpeg', name: 'base.png' }])

  // An absent mediaType falls back to PNG rather than reaching a filename empty.
  const noType = parseGenerate({ prompt: 'x', ratio: '1:1', references: [{ data: 'AAAA' }] })
  assert.equal(noType.references[0].mediaType, 'image/png')

  assert.throws(() => parseGenerate({ prompt: 'x', ratio: '1:1', references: 'nope' }), /参考图格式无效/)
  assert.throws(() => parseGenerate({ prompt: 'x', ratio: '1:1', references: [{ data: '' }] }), /第 1 张参考图内容为空/)
  // An empty list is normalised away so the pipeline sees "no references" and
  // takes the text-to-image path, not the edit path with an empty gallery.
  assert.ok(!('references' in parseGenerate({ prompt: 'x', ratio: '1:1', references: [] })))
})

test('a reference may point at a file this host wrote, but never at both channels', () => {
  // The canvas hands back a path instead of bytes: the browser never had them.
  const byPath = parseGenerate({
    prompt: 'x',
    ratio: '1:1',
    references: [{ path: 'D:/out/studio_1.png', mediaType: 'image/png' }],
  })
  assert.equal(byPath.references?.[0]?.path, 'D:/out/studio_1.png')
  assert.equal(byPath.references?.[0]?.data, undefined)

  // Both at once is ambiguous about which one wins, so it is refused.
  assert.throws(
    () => parseGenerate({
      prompt: 'x',
      ratio: '1:1',
      references: [{ path: 'D:/out/a.png', data: 'AAAA', mediaType: 'image/png' }],
    }),
    /同时给了 path 和 data/,
  )

  // Neither is still the old "empty reference" error.
  assert.throws(
    () => parseGenerate({ prompt: 'x', ratio: '1:1', references: [{}] }),
    /内容为空/,
  )
})

test('a generation body carries its board, and a blank one means "new board"', () => {
  assert.equal(parseGenerate({ prompt: '猫', ratio: '1:1', board: '  b1234567  ' }).board, 'b1234567')
  // Absent and blank are both "the host decides", which for the panel is the
  // active board — never an empty-string board id.
  assert.ok(!('board' in parseGenerate({ prompt: '猫', ratio: '1:1' })))
  assert.ok(!('board' in parseGenerate({ prompt: '猫', ratio: '1:1', board: '   ' })))
  assert.ok(!('board' in parseGenerate({ prompt: '猫', ratio: '1:1', board: 42 })))
  assert.equal(parseGenerate({ prompt: '猫', ratio: '1:1', board: 'x'.repeat(200) }).board.length, 80)
})

test('a generation body carries an optional canvas clientId, and a malformed one is refused', () => {
  // Absent is the old wire: the parsed body is exactly the pre-DD7 shape, so a
  // tab that predates the canvas behaves identically.
  assert.deepEqual(parseGenerate({ prompt: '猫', ratio: '1:1' }), { prompt: '猫', ratio: '1:1' })
  assert.ok(!('clientId' in parseGenerate({ prompt: '猫', ratio: '1:1' })))

  // Present is the canvas wire: `c` + base36, bounded at 32 characters.
  assert.deepEqual(
    parseGenerate({ prompt: '猫', ratio: '1:1', clientId: 'c1a2b3' }),
    { prompt: '猫', ratio: '1:1', clientId: 'c1a2b3' },
  )
  assert.equal(
    parseGenerate({ prompt: '猫', ratio: '1:1', clientId: 'c' + 'z'.repeat(31) }).clientId.length,
    STUDIO_CLIENT_ID_MAX_CHARS,
  )
  // A single-value field is refused when malformed, unlike the board route's
  // per-entry coordinate lists: a typo here would silently detach a task node
  // from every event of its own run.
  for (const clientId of ['', 'abc', 'Cabc123', 'cABC123', 'c-123', 'c' + 'z'.repeat(32), 42, {}]) {
    assert.throws(
      () => parseGenerate({ prompt: '猫', ratio: '1:1', clientId }),
      /clientId 格式无效/,
      'malformed clientId must be refused: ' + JSON.stringify(clientId),
    )
  }
  // The validator is shared with the panel's id generator, so both halves agree
  // on what a canonical id is.
  assert.equal(isStudioClientId('c1a2b3'), true)
  assert.equal(isStudioClientId('c'), false)
  assert.equal(isStudioClientId('x123'), false)
  assert.equal(isStudioClientId(42), false)
})

test('a board mutation is a closed action set with bounded payloads', () => {
  const layout = parseBoardAction({
    action: 'layout',
    board: ' b1 ',
    items: [{ id: 'i1', x: 12, y: -4 }, { id: 'bad' }, { id: 'i2', x: Number.NaN, y: 1 }, null],
    camera: { x: 1, y: 2, zoom: 0.5 },
  })
  assert.equal(layout.action, 'layout')
  assert.equal(layout.board, 'b1')
  // Only fully specified positions survive; one malformed entry must not fail
  // the whole save (the user just dragged twenty nodes).
  assert.deepEqual(layout.items, [{ id: 'i1', x: 12, y: -4 }])
  assert.deepEqual(layout.camera, { x: 1, y: 2, zoom: 0.5 })

  // A typo in the panel must look like a refusal, not a successful save.
  assert.throws(() => parseBoardAction({ action: 'nope' }), /未知的画板操作/)
  assert.throws(() => parseBoardAction(null), /请求格式无效/)
  assert.throws(() => parseBoardAction({}), /未知的画板操作/)

  assert.equal(parseBoardAction({ action: 'remove-item', item: 'i9', deleteFile: true }).deleteFile, true)
  // Deleting the file is opt-in: only the literal boolean counts.
  assert.equal(parseBoardAction({ action: 'remove-item', item: 'i9', deleteFile: 'yes' }).deleteFile, undefined)

  // A camera the store cannot use is dropped rather than written as NaN.
  assert.equal(parseBoardAction({ action: 'layout', camera: { x: Number.NaN, y: 0, zoom: 1 } }).camera, undefined)
  assert.equal(parseBoardAction({ action: 'layout', camera: { x: 0, y: 0, zoom: 0 } }).camera, undefined)
})

test('the optimise body keeps context but truncates it instead of refusing', () => {
  const parsed = parseOptimize({
    prompt: '  做个赛博朋克街景  ',
    editing: true,
    ratio: '3:4',
    context: [
      { role: 'user', text: ' 想想画面 ' },
      { role: 'assistant', text: '好的' },
      { role: 'system', text: 'ignored' },
      { role: 'user', text: '   ' },
    ],
  })
  assert.equal(parsed.prompt, '做个赛博朋克街景')
  assert.equal(parsed.editing, true)
  assert.equal(parsed.ratio, '3:4')
  // The system turn and the blank turn are dropped, not forwarded as context.
  assert.deepEqual(parsed.context, [
    { role: 'user', text: '想想画面' },
    { role: 'assistant', text: '好的' },
  ])

  // An unknown ratio is not a refusal here: the optimiser only uses it for
  // wording, so a bad one costs nothing.
  assert.equal(parseOptimize({ prompt: 'x', ratio: 'weird' }).ratio, 'weird')
  // `editing` defaults to false rather than being truthy-coerced.
  assert.equal(parseOptimize({ prompt: 'x', editing: 'yes' }).editing, false)
  assert.throws(() => parseOptimize({ prompt: '' }), /请输入提示词/)
})

// ---------------------------------------------------------------------------
// The two resolutions that decide what reaches the GPU.
// ---------------------------------------------------------------------------

/** Settings with only the fields `resolveStudioSteps` reads. */
function stepsSettings(defaultSteps, comfyuiSteps) {
  return { defaultSteps, comfyuiSteps }
}

test('a requested step count is clamped, and an absent one falls back to the config', () => {
  // Explicit request wins, inside the clamp.
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), 30), 30)
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), 1), 1)
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), 1000), 200)
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), -5), 1)
  // Absent or unusable → the ComfyUI override, then the global default.
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), undefined), 12)
  assert.equal(resolveStudioSteps(stepsSettings(25, undefined), undefined), 25)
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), Number.NaN), 12)
  // Rounded, so a slider that produces 23.6 cannot put a fraction on the wire.
  assert.equal(resolveStudioSteps(stepsSettings(25, 12), 23.6), 24)
})

test('every advertised ratio resolves, and to the same canvas the Agent tool uses', () => {
  const table = studioSizeTable()
  assert.deepEqual(table.map((entry) => entry.ratio), [...STUDIO_RATIOS])
  for (const entry of table) {
    const resolved = studioSize(entry.ratio)
    assert.ok(resolved !== undefined, `${entry.ratio} must resolve`)
    assert.equal(resolved.width, entry.width)
    assert.equal(resolved.height, entry.height)
    // 32-alignment is what Qwen-Image's VAE requires; a picker label that lied
    // about it would produce the wrong aspect on every draw.
    assert.equal(resolved.width % 32, 0, `${entry.ratio} width must be 32-aligned`)
    assert.equal(resolved.height % 32, 0, `${entry.ratio} height must be 32-aligned`)
    // And the Studio must agree with the ratio module, not merely with itself.
    const shared = resolveDefaultSize(entry.ratio)
    assert.equal(entry.width, shared.width, `${entry.ratio} must match resolveDefaultSize`)
    assert.equal(entry.height, shared.height, `${entry.ratio} must match resolveDefaultSize`)
  }
  assert.equal(studioSize('5:4'), undefined)
  assert.equal(studioSize(''), undefined)
})

test('the studio reads the same config fields the Agent tools do', () => {
  const settings = studioSettingsOf({
    comfyEndpoint: 'http://127.0.0.1:8188',
    comfyPorts: '8188, 8189 8190',
    comfyModelsDir: '/models',
    timeoutMs: 150_000,
    outputDir: '/out',
    defaultSteps: 25,
    comfyuiSteps: 12,
    comfyModel: 'turbo',
    mossSampling: 'official',
    turboSteps: 6,
  })
  assert.deepEqual(settings, {
    comfyEndpoint: 'http://127.0.0.1:8188',
    comfyPorts: [8188, 8189, 8190],
    comfyModelsDir: '/models',
    timeoutMs: 150_000,
    outputDir: '/out',
    defaultSteps: 25,
    comfyuiSteps: 12,
    comfyModel: 'turbo',
    mossSampling: 'official',
    turboSteps: 6,
  })
  // A malformed port list falls back to the defaults rather than yielding `[]`,
  // which would leave the probe with no port to try at all.
  assert.ok(studioSettingsOf({ ...settings, comfyPorts: '' }).comfyPorts.length > 0)
  assert.ok(studioSettingsOf({ ...settings, comfyPorts: 'nope, -1, 99999' }).comfyPorts.length > 0)
})

// ---------------------------------------------------------------------------
// The optimiser: prompt assembly and answer parsing.
// ---------------------------------------------------------------------------

test('the optimiser turn tells the model the mode and the canvas', () => {
  const t2i = buildOptimizeUserText({ prompt: '  橘猫  ', editing: false, ratio: '1:1' })
  assert.match(t2i, /用户需求：橘猫/)
  assert.match(t2i, /文生图/)
  assert.match(t2i, /目标画幅比例：1:1/)
  assert.ok(!t2i.includes('用户需求：  橘猫'), 'the prompt must be trimmed before it is embedded')

  const edit = buildOptimizeUserText({ prompt: '换成夜景', editing: true })
  assert.match(edit, /图像编辑/)
  assert.ok(!edit.includes('目标画幅比例'), 'no ratio means no ratio line, not an empty one')
})

test('the prose system prompt carries the house skeleton, not just a tone', () => {
  // The Studio rewrites prompts on the same contract as skill.md, so the four
  // properties that make a prompt "Qwen-Image shaped" must be stated, and the
  // ones that silently degrade output must be banned by name.
  assert.match(PROSE_SYSTEM_PROMPT, /20 句/, 'the prose length target must be explicit')
  assert.match(PROSE_SYSTEM_PROMPT, /方位短语/, 'spatial phrases are what stop the subject floating in the centre')
  assert.match(PROSE_SYSTEM_PROMPT, /光照必须单独成句/)
  assert.match(PROSE_SYSTEM_PROMPT, /只准一句/, 'the closing sentence must be capped at one')
  assert.match(PROSE_SYSTEM_PROMPT, /8K/)
  assert.match(PROSE_SYSTEM_PROMPT, /masterpiece/)
  assert.match(PROSE_SYSTEM_PROMPT, /绝不把比例/, 'ratio belongs to the picker, never to the prose')
  assert.match(PROSE_SYSTEM_PROMPT, /<image1>/, 'edit mode must name its references')
  // The old instruction to "keep the user's language" fought the skeleton: a
  // Chinese request now yields English prose with the on-image text untouched.
  assert.ok(!/用中文就写中文/.test(PROSE_SYSTEM_PROMPT), 'the prose language rule must not contradict the skeleton')
})

test('the formula style is the other school, and the two are never interchangeable', () => {
  // The keyword formula must keep the six slots and its own output shape.
  assert.match(FORMULA_SYSTEM_PROMPT, /主体\s*\+\s*场景\s*\+\s*风格\s*\+\s*镜头\s*\+\s*氛围\s*\+\s*细节修饰/)
  assert.match(FORMULA_SYSTEM_PROMPT, /一行/, 'a formula answer is one line, not a paragraph')
  assert.match(FORMULA_SYSTEM_PROMPT, /4K/, 'the formula school treats 4K as a legitimate detail modifier')
  assert.match(FORMULA_SYSTEM_PROMPT, /不写画幅比例/, 'the ratio still belongs to the picker in both schools')

  // Load-bearing difference: what prose bans by name, formula invites.
  assert.ok(!/masterpiece/.test(PROSE_SYSTEM_PROMPT) === false, 'prose bans masterpiece')
  assert.ok(!/禁止空话[^\n]*4K/.test(FORMULA_SYSTEM_PROMPT), 'formula must not ban the words it lists as modifiers')

  // Dispatch: absent means prose, and an unknown value must never select formula.
  assert.equal(systemPromptFor(undefined), PROSE_SYSTEM_PROMPT)
  assert.equal(systemPromptFor('prose'), PROSE_SYSTEM_PROMPT)
  assert.equal(systemPromptFor('formula'), FORMULA_SYSTEM_PROMPT)
  assert.equal(systemPromptFor('v2'), PROSE_SYSTEM_PROMPT)
})

test('the optimise route keeps a known style and silently drops an unknown one', () => {
  assert.equal(parseOptimize({ prompt: 'x', editing: false, style: 'formula' }).style, 'formula')
  assert.equal(parseOptimize({ prompt: 'x', editing: false, style: 'prose' }).style, 'prose')
  assert.equal(parseOptimize({ prompt: 'x', editing: false, style: 'v2' }).style, undefined)
  assert.equal(parseOptimize({ prompt: 'x', editing: false }).style, undefined)
  // A non-string style (an older panel sending a boolean) must not crash.
  assert.equal(parseOptimize({ prompt: 'x', editing: false, style: true }).style, undefined)
})

test('conversation history is bounded and labelled by role', () => {
  const context = Array.from({ length: 10 }, (unused, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第${String(index)}句`,
  }))
  const text = buildOptimizeUserText({ prompt: 'x', editing: false, context })
  assert.match(text, /最近对话/)
  // The tail is kept, the head is dropped: recent turns carry the subject.
  assert.match(text, /第9句/)
  assert.ok(!text.includes('第0句'), 'only the most recent turns may be forwarded')
  assert.match(text, /用户：第8句/)
  assert.match(text, /助手：第9句/)
})

test('a bare answer is the prompt, and a 注 line becomes the note', () => {
  assert.deepEqual(splitOptimizerAnswer('一只橘猫坐在窗台上，午后侧光。'), {
    prompt: '一只橘猫坐在窗台上，午后侧光。',
  })
  assert.deepEqual(splitOptimizerAnswer('一只橘猫。\n注：补全了光线描述'), {
    prompt: '一只橘猫。',
    note: '补全了光线描述',
  })
  // Full-width colon, which the model uses about as often as the ASCII one.
  assert.deepEqual(splitOptimizerAnswer('一只橘猫。\n注：补全了光线'), {
    prompt: '一只橘猫。',
    note: '补全了光线',
  })
  // A `注` on the *first* line is not a note — the prompt itself must survive.
  assert.deepEqual(splitOptimizerAnswer('注：这是一个测试'), { prompt: '注：这是一个测试' })
  // A note whose body is empty is dropped rather than rendered as "注：".
  assert.deepEqual(splitOptimizerAnswer('一只橘猫。\n注：'), { prompt: '一只橘猫。\n注：'.split('\n')[0] })
  assert.deepEqual(splitOptimizerAnswer('   '), { prompt: '' })
})

test('wrapping quotes are stripped only when they are the outer pair', () => {
  assert.equal(stripWrappingQuotes('"一只橘猫"'), '一只橘猫')
  assert.equal(stripWrappingQuotes('“一只橘猫”'), '一只橘猫')
  assert.equal(stripWrappingQuotes('「一只橘猫」'), '一只橘猫')
  // Quotes that close early are content, not wrapping — stripping them would
  // truncate a prompt that legitimately contains a quoted phrase.
  assert.equal(stripWrappingQuotes('"猫"和"狗"'), '"猫"和"狗"')
  assert.equal(stripWrappingQuotes('一只橘猫'), '一只橘猫')
  // Too short to be a pair.
  assert.equal(stripWrappingQuotes('""'), '""')
})

/** A context whose `get` serves exactly the services a test names. */
const ctxOf = (services) => ({ get: (name) => services[name] })

/** The smallest `llm` face that passes the shape check. */
const llmFace = (overrides = {}) => ({ listProviders: () => [], prepareCall: async () => ({}), ...overrides })

test('a host without the llm service reports llm-missing instead of throwing', async () => {
  // Every shape a context can take: no `get` at all, `get` returning nothing,
  // `get` returning something that is not an LLM, and `get` itself throwing.
  // All mean the same stage — and the stage is the point.
  for (const ctx of [
    {},
    { get: () => undefined },
    { get: () => null },
    { get: () => ({ stream: () => {} }) },
    { get: () => { throw new Error('service not mounted') } },
  ]) {
    assert.equal(llmOf(ctx), undefined)
    const resolution = await resolveOptimizerFor(ctx)
    assert.equal(resolution.ok, false)
    assert.equal(resolution.stage, 'llm-missing')
    assert.ok(resolution.detail.length > 0, 'the failure has to say something')
  }
})

test('agentDefaultModel wins over enumerating providers', async () => {
  // The conversation's own selection is the answer even when a second provider
  // would have enumerated fine: "seamless" means the model the chat is using.
  const ctx = ctxOf({
    agentDefaultModel: { currentSelection: () => ({ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }) },
    llm: llmFace({ listProviders: () => [{ name: 'somebody-else' }], listModels: async () => [{ id: 'other-model' }] }),
  })
  assert.deepEqual(await resolveOptimizerFor(ctx), {
    ok: true,
    provider: 'dsh-opencode-go',
    model: 'deepseek-v4.1-flash',
    via: 'agentDefaultModel',
  })
})

test('each resolution failure names its own stage, with the upstream words kept', async () => {
  // 1. `listProviders` throws.
  let resolution = await resolveOptimizerFor(ctxOf({
    llm: llmFace({ listProviders: () => { throw new Error('registry exploded') } }),
  }))
  assert.equal(resolution.stage, 'list-providers-failed')
  assert.match(resolution.detail, /registry exploded/)

  // 2. It returns nothing at all.
  resolution = await resolveOptimizerFor(ctxOf({ llm: llmFace({ listProviders: () => [] }) }))
  assert.equal(resolution.stage, 'list-providers-empty')

  // 3. Every provider fails to list models: each error is quoted, not merged.
  resolution = await resolveOptimizerFor(ctxOf({
    llm: llmFace({
      listProviders: () => [{ name: 'alpha' }, { id: 'beta' }],
      listModels: async () => { throw new Error('401 unauthorized') },
    }),
  }))
  assert.equal(resolution.stage, 'list-models-failed')
  assert.match(resolution.detail, /alpha: 401 unauthorized/)
  assert.match(resolution.detail, /beta: 401 unauthorized/)

  // 4. `listModels` absent — the typert remote façade only exposes listProviders.
  resolution = await resolveOptimizerFor(ctxOf({ llm: llmFace({ listProviders: () => [{ name: 'alpha' }] }) }))
  assert.equal(resolution.stage, 'list-models-failed')
  assert.match(resolution.detail, /listModels 不可用/)

  // 5. The old fallback still works when no default selection exists: one broken
  //    provider must not stop the search for a working one.
  resolution = await resolveOptimizerFor(ctxOf({
    llm: llmFace({
      listProviders: () => [{ name: 'broken' }, { id: 'second' }, { name: '' }],
      listModels: async (provider) => {
        if (provider === 'broken') throw new Error('nope')
        return [{ id: 'qwen-max' }]
      },
    }),
  }))
  assert.deepEqual(resolution, { ok: true, provider: 'second', model: 'qwen-max', via: 'listModels' })
})

// ---------------------------------------------------------------------------
// The built artifacts and the published surface.
// ---------------------------------------------------------------------------

test('the Studio routes are registered on the host, and the constants ship with them', () => {
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  // The routes are the whole host-side surface of the Studio; if one name
  // blurts, the panel 404s with no other symptom.
  const routes = [
    '/plugins/dsh-image-forge/studio/config',
    '/plugins/dsh-image-forge/studio/generate',
    '/plugins/dsh-image-forge/studio/optimize',
    '/plugins/dsh-image-forge/studio/boards',
    '/plugins/dsh-image-forge/studio/board',
    '/plugins/dsh-image-forge/studio/assets',
    '/plugins/dsh-image-forge/studio/import',
  ]
  for (const route of routes) {
    assert.ok(host.includes(route), `${route} must be present in the host bundle`)
  }
  // `dsh-llm` is reached only through a dynamic import: a static one would make
  // the whole plugin fail to load on a host that never installed it.
  assert.ok(host.includes('await import("@deepseek-ai/dsh-llm")'), 'the assembler must be loaded dynamically')
  assert.ok(!/^import [^;]*from "@deepseek-ai\/dsh-llm"/m.test(host), 'dsh-llm must not be statically imported')

  // And the panel half must carry the same paths, or it posts into the void.
  // `studio/boards` is host-only: the panel gets the board list inside the
  // capability snapshot, so it never calls that route itself.
  const clientRoutes = routes.filter((route) => !route.endsWith('/studio/boards'))
  const client = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  for (const route of clientRoutes) {
    assert.ok(client.includes(route), `${route} must be present in the client bundle`)
  }
})

test('the workbench still ships in the client bundle, now as a main panel', () => {
  const client = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  // The panel is no longer mounted from the settings section; its surface and
  // the seat that mounts it must still be in the bundle, or the sidebar row
  // would switch the main column to nothing.
  // U04 step 1b gave the panel its props (`boardId`, `canvas`), so the signature
  // is no longer the zero-argument one; the surface itself still has to be here.
  assert.match(client, /function StudioPanel\(/, 'the workbench component must stay in the bundle')
  assert.ok(client.includes('"图像工作台"'), 'the panel title must stay')
  assert.match(client, /icon: StudioPanelIcon/, 'the sidebar glyph must be handed to the seat')
  assert.match(client, /registerStudioPanel\(ctx, \{/, 'the panel seats must be wired into apply()')
})

test('the constants the panel and the host must agree on are shared, not restated', () => {
  // These are exported so the panel's limits come from one place; a mismatch
  // here is a form that submits a body the host refuses.
  assert.equal(STUDIO_MAX_COUNT, 4)
  assert.deepEqual([...STUDIO_RATIOS], ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'])
})

// ---------------------------------------------------------------------------
// Turbo: the distilled checkpoint is a different sampler graph, and its step
// default must never borrow the base checkpoint's 25.
// ---------------------------------------------------------------------------

test('the turbo schedule is the official one, and describes exactly its own step count', () => {
  // Copied verbatim from the official template's ManualSigmas node; changing it
  // silently would invalidate the "8 steps" contract the whole turbo path leans on.
  assert.equal(TURBO_SIGMAS, '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0')
  // 9 entries = 8 intervals = 8 steps.
  assert.equal(TURBO_SIGMAS.split(',').length, TURBO_STEPS + 1)
  assert.equal(TURBO_STEPS, 8)
})

test('turbo steps never borrow the base checkpoint defaults', () => {
  // NB: this feeds the **legacy** `'turbo'` / `'base'` spellings, i.e. what an
  // old config document says — not what production hands the Studio, which is
  // always a canonical profile id (see the regression test at the bottom of this
  // section). It covers `resolveProfile`'s legacy mapping, nothing more.
  const base = { defaultSteps: 25, comfyuiSteps: 12, turboSteps: undefined, comfyModel: 'turbo' }
  // An omitted count means 8, NOT the 25/12 the base family would resolve to —
  // handing 25 steps to a checkpoint distilled for 8 makes the picture worse.
  assert.equal(resolveStudioSteps(base, undefined), 8)
  // The turbo override applies before the distilled default.
  assert.equal(resolveStudioSteps({ ...base, turboSteps: 6 }, undefined), 6)
  // An explicit request still wins, inside the shared clamp.
  assert.equal(resolveStudioSteps(base, 4), 4)
  assert.equal(resolveStudioSteps(base, 1000), 200)
  assert.equal(resolveStudioSteps(base, 23.6), 24)
  // And the base family keeps its own fallback unchanged.
  const notTurbo = { defaultSteps: 25, comfyuiSteps: 12, turboSteps: undefined, comfyModel: 'base' }
  assert.equal(resolveStudioSteps(notTurbo, undefined), 12)
  assert.equal(resolveStudioSteps({ ...notTurbo, comfyuiSteps: undefined }, undefined), 25)
})

test('turbo is a preference, not a requirement: only a turbo unet name matches', () => {
  assert.equal(turboUnetOf({ unet: 'qwen_image_2.1_turbo_int8_convrot.safetensors', clip: '', vae: '', clipType: '' }), 'qwen_image_2.1_turbo_int8_convrot.safetensors')
  assert.equal(turboUnetOf({ unet: 'qwen_image_2.1_int8_convrot.safetensors', clip: '', vae: '', clipType: '' }), undefined)
  // Renamed but keeping the marker still matches; the name is only ever an
  // example in error text.
  assert.equal(turboUnetOf({ unet: 'my-turbo-copy.safetensors', clip: '', vae: '', clipType: '' }), 'my-turbo-copy.safetensors')
  assert.equal(turboUnetOf({ unet: '', clip: '', vae: '', clipType: '' }), undefined)
})

test('the turbo graphs use the advanced sampler, and the edit graph is wired for references', async () => {
  const { editTurboWorkflow, QWEN_IMAGE_TURBO_WORKFLOW, QWEN_IMAGE_TURBO_EDIT_WORKFLOW } = await import('../testlib/comfyui.js')
  // The turbo skeleton drives SamplerCustomAdvanced, not KSampler — that
  // separation is the only way to hand it the manual sigma schedule.
  assert.equal(QWEN_IMAGE_TURBO_WORKFLOW['10'].class_type, 'SamplerCustomAdvanced')
  assert.equal(QWEN_IMAGE_TURBO_WORKFLOW['9'].class_type, 'ManualSigmas')
  assert.ok(!Object.values(QWEN_IMAGE_TURBO_WORKFLOW).some((n) => n.class_type === 'KSampler'))
  // And the ingredients are actually connected.
  assert.deepEqual(QWEN_IMAGE_TURBO_WORKFLOW['10'].inputs, {
    noise: ['6', 0], guider: ['7', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: ['5', 0],
  })

  // The edit variant swaps the encode node and takes a reference slot per image.
  const graph = editTurboWorkflow(['ref-a.png', 'ref-b.png'])
  assert.equal(graph['4'].class_type, 'TextEncodeQwenImage21')
  assert.deepEqual(graph['4'].inputs['images.image_1'], ['13', 0])
  assert.deepEqual(graph['4'].inputs['images.image_2'], ['14', 0])
  assert.equal(graph['13'].class_type, 'LoadImage')
  assert.equal(graph['13'].inputs.image, 'ref-a.png')
  // The skeleton the references hang off is the turbo one, not the base one.
  assert.equal(graph['10'].class_type, 'SamplerCustomAdvanced')
  // Empty or over-long reference lists are refused before any upload happens.
  assert.throws(() => editTurboWorkflow([]), /至少一张|needs at least one/)
})

// ---------------------------------------------------------------------------
// Regression: the Studio used to compare `comfyModel` against the literal
// `'turbo'`, a value `resolveConfig` never hands it (it normalises to
// `qwen21-turbo`), so the turbo step branch was dead and `turboSteps` never
// applied. Everything below therefore starts from the *normalised* config value,
// exactly like production, instead of the legacy spelling.
// ---------------------------------------------------------------------------

/** What `resolveConfig` writes into `comfyModel` before anything downstream runs. */
const asConfigured = (raw) => resolveProfile(raw).id

/** The settled settings a production activation would hand the Studio. */
function configuredSettings(comfyModel, overrides = {}) {
  return studioSettingsOf({
    comfyEndpoint: 'http://127.0.0.1:8188',
    comfyPorts: '8188',
    comfyModelsDir: '/models',
    timeoutMs: 150_000,
    outputDir: '/out',
    defaultSteps: 25,
    comfyuiSteps: 12,
    comfyModel: asConfigured(comfyModel),
    mossSampling: 'comfy',
    turboSteps: undefined,
    ...overrides,
  })
}

const TURBO_MODELS = { unet: 'qwen_image_2.1_turbo_int8_convrot.safetensors', clip: 'qwen3vl_8b.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors', clipType: 'qwen_image' }
const BASE_MODELS = { unet: 'qwen_image_2.1_int8_convrot.safetensors', clip: 'qwen3vl_8b.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors', clipType: 'qwen_image' }
const MOSS_MODELS = { unet: 'moss_image_sft_int8_convrot.safetensors', clip: 'qwen3.5_9b_w4a8_gptq.safetensors', vae: 'flux2-vae_small.safetensors', clipType: 'moss_image' }

test('a canonical turbo id resolves the turbo step default, not the base one', () => {
  // Pin the normalisation this test depends on: `resolveConfig` stores the
  // canonical id, so `'turbo'` is a value the Studio never receives in production.
  assert.equal(asConfigured('turbo'), 'qwen21-turbo')
  assert.equal(asConfigured('base'), 'qwen21-base')

  const settings = configuredSettings('qwen21-turbo')
  assert.equal(settings.comfyModel, 'qwen21-turbo')
  // 8, not `comfyuiSteps` 12 and not `defaultSteps` 25 — the whole point of
  // `turboSteps` existing. On the pre-fix code this returned 12 (the base
  // fallback), because the branch compared against the literal `'turbo'`.
  assert.equal(resolveStudioSteps(settings, undefined), 8)
  // The configured override still wins over the distilled default.
  assert.equal(resolveStudioSteps(configuredSettings('qwen21-turbo', { turboSteps: 6 }), undefined), 6)
  // An explicit request still wins over both, inside the shared clamp.
  assert.equal(resolveStudioSteps(settings, 5), 5)
})

test('the turbo step default follows the profile that actually runs, not just the request', () => {
  const settings = configuredSettings('qwen21-turbo')
  // Turbo requested *and* a turbo checkpoint installed: the turbo graph runs, so
  // the turbo step default is right.
  const onTurbo = effectiveProfile(settings.comfyModel, TURBO_MODELS)
  assert.equal(onTurbo.variant, 'turbo')
  assert.equal(resolveStudioSteps(settings, undefined, onTurbo), 8)
  // Turbo requested but only base weights installed: the run degrades to the base
  // graph (same rule as `tools.ts`), so it must take the base default — handing a
  // base checkpoint the turbo 8 would be the mirror image of the bug.
  const degraded = effectiveProfile(settings.comfyModel, BASE_MODELS)
  assert.equal(degraded.variant, 'base')
  assert.equal(resolveStudioSteps(settings, undefined, degraded), 12)
})

test('a MOSS profile is never mistaken for turbo', () => {
  // `moss-sft` is a third variant, not a turbo in disguise: it runs a plain
  // KSampler at 25 steps, has no manual sigma schedule, and must keep the ordinary
  // `comfyuiSteps` / `defaultSteps` fallback.
  assert.equal(asConfigured('moss-sft'), 'moss-sft')
  assert.equal(resolveProfile('moss-sft').variant, 'sft')
  assert.equal(resolveProfile('moss-sft').steps.sigmas, undefined)

  const settings = configuredSettings('moss-sft')
  assert.equal(settings.comfyModel, 'moss-sft')
  assert.notEqual(resolveStudioSteps(settings, undefined), 8)
  assert.equal(resolveStudioSteps(settings, undefined), 12)
  assert.equal(resolveStudioSteps(configuredSettings('moss-sft', { comfyuiSteps: undefined }), undefined), 25)

  // And once the weights are known the effective profile is still MOSS, so the
  // step fallback stays the ordinary one.
  const effective = effectiveProfile(settings.comfyModel, MOSS_MODELS)
  assert.equal(effective.id, 'moss-sft')
  assert.equal(resolveStudioSteps(settings, undefined, effective), 12)
  // A `turboSteps` sitting in the config must not leak into a MOSS run.
  assert.equal(resolveStudioSteps(configuredSettings('moss-sft', { turboSteps: 6 }), undefined), 12)
})

// ---------------------------------------------------------------------------
// MOSS-Image's two sampling registers: a table, not an `if` in the adapter.
//
// Both registers are real and both are documented — the ComfyUI template's
// faster settings (which the verified sample ran) and OpenMOSS's own card. The
// tests below pin each pair verbatim, prove the register selects a *whole* pair
// rather than one field, and prove neither Qwen profile can be moved by it.
// ---------------------------------------------------------------------------

test('the MOSS sampling registers carry the two published pairs, verbatim', () => {
  const moss = MODEL_PROFILES['moss-sft']
  assert.deepEqual([...MOSS_SAMPLING_PRESETS], ['comfy', 'official'])
  assert.equal(DEFAULT_MOSS_SAMPLING, 'comfy')

  // Register 1 — the ComfyUI template (`image_moss_image_t2i.json`, which notes
  // it uses kijai's faster settings): 25 steps / CFG 2.5 / er_sde / simple. It is
  // also the profile's own pair, so the default run cannot drift from it.
  assert.deepEqual(moss.samplingPresets.comfy.sampler, {
    node: 'KSampler',
    name: 'er_sde',
    scheduler: 'simple',
    cfg: 2.5,
  })
  assert.equal(moss.samplingPresets.comfy.steps.default, 25)
  assert.equal(moss.sampler, moss.samplingPresets.comfy.sampler, 'the profile pair must be the default register')
  assert.equal(moss.steps, moss.samplingPresets.comfy.steps)
  assert.equal(moss.defaultPreset, 'comfy')

  // Register 2 — OpenMOSS's own card: 50 steps / CFG 3 / euler / simple. The
  // scheduler is `simple` in both registers; that is not part of the difference.
  assert.deepEqual(moss.samplingPresets.official.sampler, {
    node: 'KSampler',
    name: 'euler',
    scheduler: 'simple',
    cfg: 3,
  })
  assert.equal(moss.samplingPresets.official.steps.default, 50)

  // Neither register carries a manual sigma schedule: MOSS runs the model's own
  // default shift of 5, which is why there is no `ModelSampling*` node either.
  assert.equal(moss.steps.sigmas, undefined)
  assert.equal(moss.samplingPresets.official.steps.sigmas, undefined)
})

test('the register selects a whole pair, steps and sampler together', () => {
  const moss = MODEL_PROFILES['moss-sft']
  const comfy = resolveSampling(moss, 'comfy')
  assert.equal(comfy.preset, 'comfy')
  assert.equal(comfy.sampler.cfg, 2.5)
  assert.equal(comfy.sampler.name, 'er_sde')
  assert.equal(comfy.steps.default, 25)

  const official = resolveSampling(moss, 'official')
  assert.equal(official.preset, 'official')
  assert.equal(official.sampler.name, 'euler')
  assert.equal(official.sampler.cfg, 3)
  assert.equal(official.steps.default, 50)

  // An unknown value falls back to the profile's own pair: a stale settings
  // document must never produce a graph with an undefined sampler.
  const unknown = resolveSampling(moss, 'karras')
  assert.equal(unknown.preset, undefined)
  assert.equal(unknown.sampler, moss.sampler)
  assert.equal(unknown.steps, moss.steps)
})

test('the sampling register never moves either Qwen profile', () => {
  for (const id of ['qwen21-base', 'qwen21-turbo']) {
    const profile = MODEL_PROFILES[id]
    assert.equal(profile.samplingPresets, undefined, `${id} must not publish a register table`)
    for (const preset of ['comfy', 'official', undefined]) {
      const sampling = resolveSampling(profile, preset)
      assert.equal(sampling.sampler, profile.sampler, `${id} sampler moved under ${String(preset)}`)
      assert.equal(sampling.steps, profile.steps, `${id} steps moved under ${String(preset)}`)
      assert.equal(sampling.preset, undefined)
    }
    // ...and no register contributes a step count either, so the shared
    // `comfyuiSteps` → `defaultSteps` chain is what still decides.
    assert.equal(presetSteps(profile, 'official'), undefined)
    assert.equal(presetSteps(profile, 'comfy'), undefined)
  }
})

test('a published register owns its step count, the default one included', () => {
  const moss = MODEL_PROFILES['moss-sft']
  // MOSS's counts are model properties, so the Qwen-tuned shared `defaultSteps`
  // never moves MOSS off its template's 25 — the register always answers.
  assert.equal(presetSteps(moss, 'comfy'), 25)
  assert.equal(presetSteps(moss, undefined), undefined)
  assert.equal(presetSteps(moss, 'official'), 50)
  assert.equal(presetSteps(moss, 'karras'), undefined)
})

test('the Studio step chain honours the register and still lets comfyuiSteps win', () => {
  const official = configuredSettings('moss-sft', { mossSampling: 'official', comfyuiSteps: undefined })
  // No explicit request and no `comfyuiSteps`: the selected register decides.
  assert.equal(resolveStudioSteps(official, undefined), 50)
  // `comfyuiSteps` still overrides the register in the official mode, exactly as
  // it overrides the shared default in the comfy one.
  assert.equal(
    resolveStudioSteps(configuredSettings('moss-sft', { mossSampling: 'official', comfyuiSteps: 30 }), undefined),
    30,
  )
  // An explicit request wins over everything, inside the shared clamp.
  assert.equal(resolveStudioSteps(official, 12), 12)
  assert.equal(resolveStudioSteps(official, 10_000), 200)
  // The comfy register owns 25 even when `defaultSteps` (Qwen's default) was raised:
  // MOSS never inherits a step count tuned for the other family.
  assert.equal(
    resolveStudioSteps(
      configuredSettings('moss-sft', { mossSampling: 'comfy', comfyuiSteps: undefined, defaultSteps: 40 }),
      undefined,
    ),
    25,
  )
  // And neither Qwen profile is affected by the setting at all.
  assert.equal(
    resolveStudioSteps(configuredSettings('qwen21-base', { mossSampling: 'official', comfyuiSteps: undefined }), undefined),
    25,
  )
})

// ---------------------------------------------------------------------------
// T18: live progress in the workbench.
//
// `lib/client.js` cannot be imported here: its single bare dependency,
// `react`, is resolved by the web client and is deliberately not a dependency
// of this package (see the note in `settings.test.mjs`). So this section runs
// the real built bundle the way the web loader does — evaluate it against a
// fake `window.__ModuleLoader__`, hand the factory a minimal React (element
// descriptors plus a hook runtime), and take the workbench component back out
// of the slot registry through `apply`. The component is then mounted against
// stubbed `fetch` / `EventSource`: no DOM, no browser, but the real
// event → state → rendered-text path.
//
// What this cannot prove: the browser's own EventSource retry cadence, actual
// paint, or a run against a live ComfyUI. Those stay unverified in the report.
// ---------------------------------------------------------------------------

/** The built browser half, read as text for the bundle assertions below. */
const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/** The capability snapshot the fake host serves to a mounting panel. */
const HARNESS_CONFIG = {
  ready: true,
  endpoint: 'http://127.0.0.1:8188',
  models: { unet: 'qwen.safetensors', clip: 'clip.safetensors', vae: 'vae.safetensors' },
  defaultSteps: 40,
  outputDir: 'C:/out',
  sizes: [{ ratio: '1:1', width: 1024, height: 1024 }],
  optimizeAvailable: false,
  boards: [],
  activeBoard: null,
}

/**
 * A board with three 1:1 nodes, for the interaction section.
 *
 * The x positions are far enough apart that a marquee can sweep exactly one node:
 * a 1024×1024 picture is a 200×240 node (`nodeDisplaySize`), so these sit at
 * 0–200, 600–800 and 1200–1400 world units.
 */
const HARNESS_BOARD = {
  id: 'cbrdharness',
  name: '交互测试板',
  camera: { x: 0, y: 0, zoom: 1 },
  items: ['iaaa1', 'ibbb2', 'iccc3'].map((id, index) => ({
    id,
    path: `C:/out/${id}.png`,
    markdownPath: `C:/out/${id}.png`,
    width: 1024,
    height: 1024,
    bytes: 1024,
    mediaType: 'image/png',
    batchId: 'bharness',
    prompt: '一只橘猫坐在窗台上',
    ratio: '1:1',
    steps: 8,
    seed: index + 1,
    mode: 'generate',
    backend: 'studio',
    parents: [],
    x: index * 600,
    y: 0,
  })),
}

/*
 * The tree helpers (`fakeResponse` / `fakeText` / `fakeVisit` /
 * `fakeElementWithClass` / `sameDeps` / `collectChildren`) and the renderer
 * (`createPanel` / `settle`) now live in `./harness.mjs`, shared with
 * `test/workbench-shell.test.mjs`. They were moved verbatim; the renderer grew
 * one capability — it calls function components instead of giving up on them —
 * because the panel is a tabbed shell now and the studio sits one level deeper.
 */

/*
 * `createHookRuntime` and `settle` moved to `./harness.mjs` (`createPanel` /
 * `settle`). The panel handle they return keeps the same shape — `mount`,
 * `render`, `tree`, `dirty`, `pendingEffects`, `takeEffects`, `runEffect`,
 * `unmount` — so every test below is written exactly as before.
 */

/** Load the built client bundle the way `window.__ModuleLoader__` does. */
let loadedClient
/**
 * What the panel's `window.confirm` answers.
 *
 * The bundle is evaluated with a *parameter* named `window` (that is how the real
 * loader shapes it), so the panel's `window.confirm` resolves to this fake window,
 * not to `globalThis`. Tests flip this before a click that must be cancelled.
 */
let harnessConfirm = () => true
/** Load the built bundle once; `active` binds hooks to the mounting host. */
function clientEntry() {
  if (loadedClient !== undefined) return loadedClient
  // The bundle is plain CJS wrapped by the loader; it is evaluated, not
  // imported, because `require("react")` is what the web client resolves. The
  // loader also hands it a `window` — that is where `confirm` comes from, since
  // the bundle is evaluated with a *parameter* named `window` and never touches
  // `globalThis` for it.
  loadedClient = loadClientBundle(CLIENT_SOURCE, { confirm: (message) => harnessConfirm(message) })
  return loadedClient
}

/** Run `apply` and return the component seated in the `main` keyed slot. */
function seatedPanelComponent(exports) {
  const events = []
  const slots = {
    inject(name, register) {
      events.push({ kind: 'inject', name, register })
    },
    register(options, component) {
      events.push({ kind: 'register', options, component })
      return () => {}
    },
  }
  exports.apply({ slots, get: () => undefined })
  // Declaring a slot is what runs its `inject` body, exactly like the shell.
  for (const event of events) {
    if (event.kind === 'inject') event.register()
  }
  const seat = events.find((event) => event.kind === 'register' && event.options.name === 'main')
  assert.ok(seat, 'the workbench must be seated in the main keyed slot')
  return seat.component
}

/**
 * The open-canvas tab the shell is told about, and the throwaway project it
 * needs when a case never had one.
 *
 * Since U03 the panel is the tabbed shell: it lands on the projects tab and only
 * renders the studio **inside a canvas tab** (§3.2, §11.1). These tests all drive
 * the studio, so the harness stubs `workspace-get` with one open canvas tab. The
 * cases that never had a board fixture get this empty project to open — without
 * it there is no tab, hence no studio, hence nothing to assert about. Nothing
 * about the studio's own fixture changes: it still sees `activeBoard: null` and
 * an empty canvas, exactly as before.
 */
const PROBE_BOARD = {
  id: 'cbrdprobe',
  name: '测试画板',
  itemCount: 0,
  cover: null,
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
  sessionId: null,
}

/** The workspace document `workspace-get` answers with (§4.2). */
function openCanvasWorkspace(boardId) {
  return {
    version: 1,
    openProjects: [boardId],
    activeTab: { kind: 'canvas', boardId },
    nodeDetailTabs: [],
    tabOrder: ['projects', `canvas:${boardId}`],
    recentProjects: [],
  }
}

/**
 * Stub the two globals the panel reaches for: `fetch` (capability snapshot,
 * workspace and boards) and `EventSource`.
 */
function installFakeNetwork(options) {
  const previousFetch = globalThis.fetch
  const previousEventSource = globalThis.EventSource
  const calls = []
  const sources = []
  // C09: a stubbed board (and a config that names it as the active one) is what
  // lets the interaction section mount a canvas with nodes on it. Without one the
  // harness serves exactly what it always did: an empty library and a 404.
  const board = options === undefined ? undefined : options.board
  // C11: generation is stubbed per test — the panel's POST is the conversion
  // authority, so a test owns when (and whether) the response arrives.
  const generate = options === undefined ? undefined : options.generate
  // G28: the library the asset page *and* the wire menu's picker read, plus a
  // copy/move echo. The picker turns one of these into a canvas node, and the
  // node is built from the item the route returns, so the stub has to answer.
  const assetItems = options === undefined || options.assets === undefined ? [] : options.assets
  let copiedItems = 0
  const baseConfig = board === undefined
    ? { ...HARNESS_CONFIG, boards: [PROBE_BOARD] }
    : {
      ...HARNESS_CONFIG,
      boards: [{
        id: board.id,
        name: board.name,
        itemCount: board.items.length,
        createdAt: '2026-11-17T00:00:00.000Z',
        updatedAt: '2026-11-17T00:00:00.000Z',
      }],
      activeBoard: board.id,
    }
  // T22: tests need snapshots that are *not* ready (stepper failure states).
  const overrides = options === undefined ? undefined : options.configOverrides
  const config = overrides === undefined ? baseConfig : { ...baseConfig, ...overrides }
  // The tab has to name a board the shell will accept: it validates the
  // workspace against the library before opening anything (§4.3), so an id the
  // `configOverrides` removed would be dropped and the studio would never render.
  const libraryIds = Array.isArray(config.boards) ? config.boards.map((entry) => entry.id) : []
  const tabBoardId = libraryIds.length > 0 ? libraryIds[0] : PROBE_BOARD.id
  const workspace = openCanvasWorkspace(tabBoardId)
  // P2: the environment line is its own route. A test owns the answer, so the
  // start/stop/owned cases are deterministic; the default is a plain read.
  const environment = options === undefined ? undefined : options.environment
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({
      url,
      method: init === undefined || init.method === undefined ? 'GET' : init.method,
      body: init === undefined ? undefined : init.body,
    })
    if (url.indexOf(STUDIO_CONFIG_ROUTE) === 0) return fakeResponse(config, 200)
    if (url.indexOf(STUDIO_ENVIRONMENT_ROUTE) === 0) {
      let body = {}
      try {
        body = init !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : {}
      } catch {
        body = {}
      }
      const answer = environment === undefined
        ? { environment: { state: config.ready === true ? 'ready' : 'not-running', owned: false } }
        : environment(body)
      return fakeResponse(answer, 200)
    }
    if (url.indexOf(STUDIO_GENERATE_ROUTE) === 0) {
      if (generate === undefined) return fakeResponse({ error: 'no generate stub' }, 500)
      return generate(init === undefined ? {} : init)
    }
    if (url.indexOf(STUDIO_ASSETS_ROUTE) === 0) {
      // The route's own filter, honoured: `board=` narrows to one board and `q=`
      // is a substring match over prompt, file name and board name (§7.3), so a
      // test can assert both scopes of the picker without a second stub.
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1))
      const board = query.get('board')
      const text = (query.get('q') ?? '').trim()
      const matching = assetItems.filter((entry) => {
        if (board !== null && board !== '' && entry.boardId !== board) return false
        if (text.length === 0) return true
        return [entry.prompt, entry.path, entry.boardName].some((field) => String(field).includes(text))
      })
      return fakeResponse({ assets: matching, boards: [], total: matching.length }, 200)
    }
    if (url.indexOf(STUDIO_BOARD_ROUTE) === 0) {
      // A board mutation is accepted: the wiring section asserts the canvas, not
      // the store. C14's two node writers answer even without a fixture board —
      // that is how the empty-library "a failure creates the board" path is
      // exercised — and echo the item they would have stored, so the panel can
      // adopt the id and later remove the right board entry.
      if (init !== undefined && init.method === 'POST') {
        let action
        try {
          action = JSON.parse(init.body)
        } catch {
          action = undefined
        }
        if (action !== undefined && action.action === 'workspace-get') {
          // U03: the shell reads the workspace before it decides which tab to
          // show. One open canvas tab is what puts the studio on screen.
          return fakeResponse({ ok: true, workspace }, 200)
        }
        if (action !== undefined && action.action === 'workspace-set') {
          // Accepted, never inspected: the shell's own persistence is asserted in
          // `test/workbench-shell.test.mjs`; these tests are about the studio.
          return fakeResponse({ ok: true }, 200)
        }
        if (action !== undefined && (action.action === 'copy-item' || action.action === 'move-item')) {
          // G28: the picker's write, echoed the way the route does it — a new id,
          // the same file and metadata, the landing spot it was given.
          const original = assetItems.find((entry) => entry.id === action.item)
          copiedItems += 1
          const id = 'icopy' + String(copiedItems)
          const now = '2026-11-18T00:00:00.000Z'
          return fakeResponse({
            ok: true,
            item: {
              id,
              kind: 'image',
              path: original === undefined ? '' : original.path,
              markdownPath: original === undefined ? '' : original.markdownPath,
              width: original === undefined ? 1024 : original.width,
              height: original === undefined ? 1024 : original.height,
              bytes: original === undefined ? 1024 : original.bytes,
              mediaType: 'image/png',
              prompt: original === undefined ? '' : original.prompt,
              ratio: '1:1',
              steps: 8,
              seed: 1,
              mode: 'generate',
              backend: 'studio',
              parents: [],
              createdAt: now,
              sessionId: null,
              batchId: 'bcopy',
              x: typeof action.x === 'number' ? action.x : 0,
              y: typeof action.y === 'number' ? action.y : 0,
            },
            board: {
              id: board === undefined ? 'cbrdauto' : board.id,
              name: board === undefined ? '自动画板' : board.name,
              itemCount: board === undefined ? 1 : board.items.length + 1,
              cover: null,
              createdAt: now,
              updatedAt: now,
              sessionId: null,
            },
          }, 200)
        }
        if (action !== undefined && (action.action === 'save-task' || action.action === 'save-layout-node')) {
          const kind = action.action === 'save-task' ? 'task' : 'layout'
          const id = typeof action.item === 'string' && action.item.length > 0
            ? action.item
            : kind === 'task' ? 'itask1' : 'ilayout1'
          return fakeResponse({
            ok: true,
            item: {
              id,
              kind,
              x: typeof action.x === 'number' ? action.x : 0,
              y: typeof action.y === 'number' ? action.y : 0,
              parents: Array.isArray(action.parents) ? action.parents : [],
              ...(kind === 'task' ? { task: action.task } : { draft: action.draft, w: action.w, h: action.h }),
            },
            board: {
              id: board === undefined ? 'cbrdauto' : board.id,
              name: board === undefined ? '自动画板' : board.name,
              itemCount: board === undefined ? 1 : board.items.length,
              cover: null,
              createdAt: '2026-11-17T00:00:00.000Z',
              updatedAt: '2026-11-17T00:00:00.000Z',
              sessionId: null,
            },
          }, 200)
        }
        return fakeResponse({ ok: true }, 200)
      }
      if (board === undefined) return fakeResponse({ error: 'no board in this harness' }, 404)
      return fakeResponse(board, 200)
    }
    return fakeResponse({ error: 'unstubbed fetch: ' + url }, 500)
  }
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.closed = false
      this.listeners = new Map()
      sources.push(this)
    }
    addEventListener(type, listener) {
      const list = this.listeners.get(type) === undefined ? [] : this.listeners.get(type)
      list.push(listener)
      this.listeners.set(type, list)
    }
    close() {
      this.closed = true
      this.readyState = 2
    }
    emit(type, payload) {
      if (this.closed) return
      const list = this.listeners.get(type)
      if (list === undefined) return
      for (const listener of list) {
        if (type === 'message') listener({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
        else listener({ type })
      }
    }
  }
  if (options !== undefined && options.eventSource === false) globalThis.EventSource = undefined
  else globalThis.EventSource = FakeEventSource
  return {
    calls,
    sources,
    /** The one stream the mounted panel should have opened. */
    open() {
      assert.equal(sources.length, 1, 'the panel must open exactly one SSE stream')
      return sources[0]
    },
    restore() {
      globalThis.fetch = previousFetch
      if (previousEventSource === undefined) delete globalThis.EventSource
      else globalThis.EventSource = previousEventSource
    },
  }
}

/** The rendered live-progress line: phase, bridge state and its text. */
function progressView(panel) {
  const element = fakeElementWithClass(panel.tree, 'dsh-forge-progress')
  assert.ok(element !== undefined, 'the panel must render a live-progress line')
  return {
    phase: element.props['data-phase'],
    bridge: element.props['data-bridge'],
    text: fakeText(element),
  }
}

/** Width of the rendered progress bar, e.g. `34%`. */
function progressFillWidth(panel) {
  const fill = fakeElementWithClass(panel.tree, 'dsh-forge-progress-fill')
  return fill === undefined ? undefined : fill.props.style.width
}

/**
 * Mount a fresh workbench against a fresh network stub.
 *
 * Since U03 the seated component is the tabbed shell, so "mount the workbench"
 * means: seat the shell, and let the workspace stub give it one open canvas tab
 * — the studio is what these tests assert on, and it lives in that tab.
 */
async function mountWorkbench(networkOptions) {
  const harness = clientEntry()
  const network = installFakeNetwork(networkOptions)
  const panel = createPanel(harness.active)
  panel.mount(seatedPanelComponent(harness.exports))
  await settle(panel)
  return { network, panel }
}

// ---------------------------------------------------------------------------
// The bundle contract: subscribe same-origin, never open ComfyUI's socket.
// ---------------------------------------------------------------------------

test('the workbench streams from the plugin route and never opens ComfyUI itself', () => {
  assert.ok(CLIENT_SOURCE.includes(STUDIO_EVENTS_ROUTE), 'the same-origin SSE route must be in the client bundle')
  assert.ok(CLIENT_SOURCE.includes('new EventSource(STUDIO_EVENTS_ROUTE)'), 'the panel must subscribe with EventSource')
  assert.ok(CLIENT_SOURCE.includes('实时进度已连接'), 'the live-progress copy must ship')
  assert.ok(!CLIENT_SOURCE.includes('new WebSocket('), 'the browser must not open a WebSocket')
  assert.ok(!CLIENT_SOURCE.includes('ws://'), 'the browser bundle must not carry a ws:// URL')
  assert.ok(!CLIENT_SOURCE.includes('/ws?clientId='), 'the browser must not know ComfyUI socket ids')
})

// ---------------------------------------------------------------------------
// The state sequence: queue → start → progress → done, asserted on the
// rendered text and on the element attributes the CSS/tests can address.
// ---------------------------------------------------------------------------

test('queue, start, 17/50 progress and done drive the rendered progress line', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    const source = network.open()
    assert.equal(source.url, STUDIO_EVENTS_ROUTE)

    const phases = []
    const record = () => {
      const view = progressView(panel)
      phases.push(view.phase)
      return view
    }

    const idle = record()
    assert.equal(idle.phase, 'idle')
    assert.equal(idle.bridge, 'connecting')
    assert.ok(idle.text.includes('等待生成'))
    assert.ok(idle.text.includes('实时进度连接中'))

    source.emit('message', { type: 'state', state: 'connected', endpoint: 'http://127.0.0.1:8188' })
    await settle(panel)
    assert.equal(record().bridge, 'connected')
    assert.ok(progressView(panel).text.includes('实时进度已连接 · http://127.0.0.1:8188'))

    source.emit('message', { type: 'queue', remaining: 3 })
    await settle(panel)
    assert.equal(record().phase, 'queued')
    assert.ok(progressView(panel).text.includes('排队中 · 前面还有 3 个任务'))

    source.emit('message', { type: 'start', promptId: 'prompt-1' })
    await settle(panel)
    assert.equal(record().phase, 'running')
    assert.ok(progressView(panel).text.includes('生成中…（等待第一步）'))
    assert.equal(progressFillWidth(panel), '0%')

    source.emit('message', { type: 'progress', promptId: 'prompt-1', value: 17, max: 50, percent: 34, label: '17/50' })
    await settle(panel)
    assert.equal(record().phase, 'running')
    assert.ok(progressView(panel).text.includes('第 17/50 步'))
    assert.equal(progressFillWidth(panel), '34%')

    source.emit('message', { type: 'progress', promptId: 'prompt-1', value: 25, max: 50, percent: 50, label: '25/50' })
    await settle(panel)
    assert.ok(record().text.includes('第 25/50 步'))
    assert.equal(progressFillWidth(panel), '50%')

    source.emit('message', { type: 'done', promptId: 'prompt-1' })
    await settle(panel)
    assert.equal(record().phase, 'done')
    assert.ok(progressView(panel).text.includes('本次生成完成（25/50）'))
    assert.equal(progressFillWidth(panel), '100%')

    // ComfyUI broadcasts the queue on every change, including after this run
    // ends. That must not turn a finished run back into "queued".
    source.emit('message', { type: 'queue', remaining: 0 })
    await settle(panel)
    assert.equal(record().phase, 'done')
    assert.equal(progressView(panel).phase, 'done')

    assert.deepEqual(phases, ['idle', 'idle', 'queued', 'running', 'running', 'running', 'done', 'done'])
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// Failures and a stopped ComfyUI: visible, friendly, never a hang.
// ---------------------------------------------------------------------------

test('failures, interruption and a stopped ComfyUI stay visible and friendly', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    const source = network.open()
    source.emit('message', { type: 'state', state: 'connected', endpoint: 'http://127.0.0.1:8188' })
    await settle(panel)

    source.emit('message', { type: 'error', promptId: 'prompt-2', node: '5', nodeType: 'KSampler', message: 'CUDA out of memory' })
    await settle(panel)
    const failed = progressView(panel)
    assert.equal(failed.phase, 'error')
    assert.ok(failed.text.includes('生成失败：CUDA out of memory'))

    source.emit('message', { type: 'interrupted', promptId: 'prompt-2' })
    await settle(panel)
    assert.equal(progressView(panel).phase, 'interrupted')
    assert.ok(progressView(panel).text.includes('生成已中断'))

    // ComfyUI goes away: the bridge says why, and that HTTP generation still
    // works. The run's own phase is untouched.
    source.emit('message', { type: 'state', state: 'disconnected', reason: 'ComfyUI 的 /ws 连接已断开' })
    await settle(panel)
    const broken = progressView(panel)
    assert.equal(broken.bridge, 'disconnected')
    assert.ok(broken.text.includes('实时进度断开：ComfyUI 的 /ws 连接已断开'))
    assert.ok(broken.text.includes('出图仍会走 HTTP'))
    assert.equal(broken.phase, 'interrupted')

    // The host's own stream drops: EventSource retries by itself, and the
    // panel says "reconnecting" instead of freezing on the last step.
    source.emit('error')
    await settle(panel)
    assert.equal(progressView(panel).bridge, 'reconnecting')
    assert.ok(progressView(panel).text.includes('正在重连'))

    // A later state frame clears it: the message is not sticky.
    source.emit('message', { type: 'state', state: 'connected', endpoint: 'http://127.0.0.1:8188' })
    await settle(panel)
    assert.equal(progressView(panel).bridge, 'connected')
  } finally {
    network.restore()
  }
})

test('a malformed or unknown frame is dropped, not allowed to break the panel', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    const source = network.open()
    source.emit('message', 'not json at all')
    source.emit('message', '{"type":42}')
    source.emit('message', { type: 'cached', promptId: 'prompt-3', nodes: ['1'] })
    source.emit('message', { type: 'cam.monitor', data: { cpu: 0 } })
    await settle(panel)
    assert.equal(progressView(panel).phase, 'idle')

    source.emit('message', { type: 'progress', promptId: 'prompt-3', value: 2, max: 4, percent: 50, label: '2/4' })
    await settle(panel)
    assert.ok(progressView(panel).text.includes('第 2/4 步'))
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// Degraded hosts: no EventSource still renders; leaving the panel cleans up.
// ---------------------------------------------------------------------------

test('a host without EventSource shows the reason and keeps working', async () => {
  const { network, panel } = await mountWorkbench({ eventSource: false })
  try {
    const view = progressView(panel)
    assert.equal(view.bridge, 'disconnected')
    assert.ok(view.text.includes('实时进度断开：当前环境不支持 EventSource'))
    assert.ok(view.text.includes('出图仍会走 HTTP'))
    assert.equal(network.sources.length, 0)
  } finally {
    network.restore()
  }
})

test('unmounting the panel closes the stream and late frames do nothing', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    const source = network.open()
    source.emit('message', { type: 'start', promptId: 'prompt-4' })
    await settle(panel)
    assert.equal(progressView(panel).phase, 'running')

    panel.unmount()
    assert.equal(source.closed, true, 'the panel must close its SSE stream on unmount')
    assert.equal(network.sources.length, 1)
    assert.doesNotThrow(() => source.emit('message', { type: 'progress', promptId: 'prompt-4', value: 1, max: 2, percent: 50, label: '1/2' }))
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// C09: canvas interactions — selection, marquee, keys, undo, menus.
//
// The T18 harness below drives the *real* bundle: the handlers a pointer or a key
// would call are called directly, so selection state, the marquee's screen→world
// arithmetic, the §6.3 dispatch, the undo stack's effect on the canvas and the
// §6.4 menus are all executed rather than grepped. Pointer capture, paint and the
// feel of a drag stay manual spot checks (§14.5) — no DOM, no browser here.
// ---------------------------------------------------------------------------

/** The canvas element the interaction handlers are attached to. */
function canvasElement(panel) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found !== undefined) return
    if (typeof entry.props.className !== 'string') return
    // `dsh-forge-canvas` gains `is-pan` while Space is held.
    if (entry.props.className.split(' ')[0] === 'dsh-forge-canvas') found = entry
  })
  assert.ok(found !== undefined, 'the panel must render the canvas')
  return found
}

/** Every rendered node, in render order (`dsh-forge-node`, not its children). */
function nodeElements(panel) {
  const nodes = []
  fakeVisit(panel.tree, (entry) => {
    if (typeof entry.props.className !== 'string') return
    if (entry.props.className.split(' ')[0] === 'dsh-forge-node') nodes.push(entry)
  })
  return nodes
}

/** Board-route POST bodies this panel sent, parsed (C14 persistence checks). */
function boardMutations(network) {
  return network.calls
    .filter((call) => call.method === 'POST' && call.url.indexOf(STUDIO_BOARD_ROUTE) === 0 && typeof call.body === 'string')
    .map((call) => JSON.parse(call.body))
}

/** Every rendered hint/note line, joined — the panel's user-facing copy. */
function noteText(panel) {
  const notes = []
  fakeVisit(panel.tree, (entry) => {
    if (typeof entry.props.className === 'string' && entry.props.className.split(' ')[0] === 'dsh-forge-studio-hint') {
      notes.push(fakeText(entry))
    }
  })
  return notes.join('\n')
}
/** The ids of the nodes painted as selected. */
function selectedIds(panel) {
  return nodeElements(panel)
    .filter((entry) => entry.props.className.split(' ').includes('is-selected'))
    .map((entry) => entry.props['data-node-id'])
}

/** Shaped like the pointer events the canvas reads. */
function pointerEvent(options = {}) {
  const box = { left: 0, top: 0, width: 800, height: 600 }
  return {
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
    ...options,
    currentTarget: {
      focus() {},
      setPointerCapture() {},
      getBoundingClientRect: () => box,
    },
    target: options.target === undefined ? { closest: () => null } : options.target,
  }
}

/** Shaped like the keyboard events the canvas reads. */
function keyEvent(key, modifiers = {}, targetFlags = {}) {
  const event = {
    key,
    prevented: false,
    ctrlKey: modifiers.ctrl === true,
    metaKey: modifiers.meta === true,
    shiftKey: modifiers.shift === true,
    target: {
      tagName: targetFlags.tagName ?? 'DIV',
      isContentEditable: targetFlags.contentEditable === true,
      closest: () => null,
    },
    preventDefault() { event.prevented = true },
  }
  return event
}

/** The first button whose text is exactly `text`. */
function buttonWithText(panel, text) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found !== undefined || entry.type !== 'button') return
    if (fakeText(entry) === text) found = entry
  })
  return found
}

/** Find a button whose label *starts with* `prefix` (labels that carry a size). */
/** The state label of every weight row in the drawer, in render order. */
function weightRowLabels(panel) {
  const labels = []
  const drawer = fakeElementWithClass(panel.tree, 'dsh-forge-weights-drawer')
  if (drawer === undefined) return labels
  fakeVisit(drawer, (entry) => {
    if (typeof entry.props.className !== 'string') return
    if (!entry.props.className.includes('dsh-forge-weight-state')) return
    const text = fakeText(entry)
    if (typeof text === 'string') labels.push(text)
  })
  return labels
}

/** Find a button whose label *starts with* `prefix` (labels that carry a size). */
function buttonStartingWith(panel, prefix) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found !== undefined || entry.type !== 'button') return
    const label = fakeText(entry)
    if (typeof label === 'string' && label.startsWith(prefix)) found = entry
  })
  return found
}

/** The open context menu's entries, or `undefined` when no menu is open. */function menuEntries(panel) {
  const menu = fakeElementWithClass(panel.tree, 'dsh-forge-context')
  if (menu === undefined) return undefined
  const entries = []
  fakeVisit(menu, (entry) => {
    if (typeof entry.props.className !== 'string') return
    if (entry.props.className.split(' ')[0] === 'dsh-forge-context-item') entries.push(entry)
  })
  return entries
}

/** The open board picker's buttons, or `undefined` when it is not open. */
function transferPicker(panel) {
  const picker = fakeElementWithClass(panel.tree, 'dsh-forge-transfer')
  if (picker === undefined) return undefined
  const buttons = []
  fakeVisit(picker, (entry) => {
    if (entry.type !== 'button') return
    buttons.push(entry)
  })
  return { head: fakeText(fakeElementWithClass(picker, 'dsh-forge-context-head') ?? []), buttons }
}

/** Mount the workbench with the three-node board, and give Node a rAF. */
async function mountCanvasWorkbench(options) {
  // §10.3 coalesces pointer moves into one animation frame; Node has none, so the
  // test frames immediately. This is the only browser API the wiring needs here.
  const requestFrame = globalThis.requestAnimationFrame
  const cancelFrame = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1 }
  globalThis.cancelAnimationFrame = () => {}
  const mounted = await mountWorkbench({ board: HARNESS_BOARD, ...(options ?? {}) })
  mounted.restoreFrames = () => {
    if (requestFrame === undefined) delete globalThis.requestAnimationFrame
    else globalThis.requestAnimationFrame = requestFrame
    if (cancelFrame === undefined) delete globalThis.cancelAnimationFrame
    else globalThis.cancelAnimationFrame = cancelFrame
  }
  return mounted
}

// ---------------------------------------------------------------------------
// G26: drag a wire out of a node's handle.
//
// The pointer plumbing is executed for real (the handlers the browser would
// call are called directly), so what a drag decides — an edge, a menu, or
// nothing at all — is asserted end to end through the bundle. What this cannot
// prove is the feel: capture, paint and the hover reveal stay a manual check
// (§14.5), exactly like every other gesture here.
// ---------------------------------------------------------------------------

/** Every output handle on the canvas, in render order. */
function handleElements(panel) {
  const handles = []
  fakeVisit(panel.tree, (entry) => {
    if (entry.props['data-connect'] === 'out') handles.push(entry)
  })
  return handles
}

/** The wire being dragged, or `undefined` when none is in flight. */
function previewWire(panel) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found === undefined && entry.props['data-connect-preview'] !== undefined) found = entry
  })
  return found
}

/** How many committed lineage edges the canvas paints. */
function edgeCount(panel) {
  let count = 0
  fakeVisit(panel.tree, (entry) => {
    if (entry.props['data-connect-preview'] !== undefined) return
    const className = entry.props.className
    if (typeof className === 'string' && className.split(' ')[0] === 'dsh-forge-edge') count += 1
  })
  return count
}

/** The node-type menu a blank drop opens, or `undefined`. */
function connectMenu(panel) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found === undefined && entry.props['data-connect-menu'] === 'open') found = entry
  })
  if (found === undefined) return undefined
  const items = []
  fakeVisit(found, (entry) => {
    // G28 put the asset picker *inside* this card, and its rows are buttons too —
    // so the node-type entries are addressed by their own data contract.
    if (entry.type === 'button' && entry.props['data-connect-target'] !== undefined) items.push(entry)
  })
  return { card: found, items }
}

/**
 * The asset picker the third entry grows, or `undefined` when it is closed.
 *
 * Rows are addressed by `data-pick-board` / `data-pick-item` rather than by their
 * rendered text: the caption is a prompt, and asserting on a prompt would make
 * the fixture the subject instead of the wiring.
 */
function connectPicker(panel) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found === undefined && entry.props['data-connect-picker'] === 'open') found = entry
  })
  if (found === undefined) return undefined
  const rows = []
  fakeVisit(found, (entry) => {
    if (entry.props['data-pick-item'] !== undefined) rows.push(entry)
  })
  const inputs = []
  const toggles = []
  fakeVisit(found, (entry) => {
    if (entry.type === 'input') inputs.push(entry)
    if (entry.type === 'button' && entry.props['data-pick-item'] === undefined) toggles.push(entry)
  })
  return { card: found, rows, inputs, toggles, text: fakeText(found) }
}

/**
 * Mount the canvas board with a **queued** animation frame.
 *
 * §10.3 coalesces pointer moves into one frame, and the two other gesture tests
 * drive that with `requestAnimationFrame(callback)` running the callback
 * immediately. That stub cannot express two moves in a row: the id is assigned
 * *after* the synchronous callback has already cleared the slot, so the next move
 * would be read as "a frame is pending" and swallowed, which a browser never
 * does. A wire drag is the first gesture that needs several moves, so this
 * mount queues them and the test runs the frames a browser would have run.
 */
async function mountWireWorkbench(options) {
  const previous = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame }
  let nextId = 1
  let pending = []
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextId
    nextId += 1
    pending.push({ id, callback })
    return id
  }
  globalThis.cancelAnimationFrame = (id) => {
    pending = pending.filter((entry) => entry.id !== id)
  }
  const mounted = await mountWorkbench({ board: HARNESS_BOARD, ...(options ?? {}) })
  return {
    ...mounted,
    /** Run the frames a browser would have run before the next assertion. */
    frames() {
      const run = pending
      pending = []
      for (const entry of run) entry.callback()
    },
    restoreFrames() {
      if (previous.raf === undefined) delete globalThis.requestAnimationFrame
      else globalThis.requestAnimationFrame = previous.raf
      if (previous.caf === undefined) delete globalThis.cancelAnimationFrame
      else globalThis.cancelAnimationFrame = previous.caf
    },
  }
}

/** Press a node's handle at a screen point (the canvas box is 0,0 in the harness). */
function pressHandle(panel, index, point) {
  const handle = handleElements(panel)[index]
  assert.ok(handle !== undefined, 'every node must carry an output handle')
  handle.props.onPointerDown(pointerEvent({ clientX: point.x, clientY: point.y }))
  return handle
}

/** Drag the pointer across the canvas and run the frame that applies it. */
function movePointer(mounted, point) {
  canvasElement(mounted.panel).props.onPointerMove(pointerEvent({ clientX: point.x, clientY: point.y }))
  mounted.frames()
}

/** Release the pointer on the canvas. */
function releasePointer(mounted) {
  canvasElement(mounted.panel).props.onPointerUp({})
}

test('G27: the handle is sized in screen pixels, so it stays clickable at any zoom', async () => {
  // The dot is painted inside the layer that scales the board. Sized in board
  // units it came out at 1.1 px at the 10 % floor: present, painted, impossible
  // to hit. The fix is one division, and it has two halves that both have to
  // ship — the layer publishing its zoom, and the handle dividing by it.
  assert.ok(CLIENT_SOURCE.includes('--dsh-forge-zoom'), 'the canvas layer must publish its zoom to the stylesheet')
  assert.ok(CLIENT_SOURCE.includes('var(--dsh-forge-zoom'), 'and the handle must divide by it')
  // The numbers are interpolated from the state machine's constants, so this
  // pins the shipped CSS to the same 11 / 16 the unit tests assert: a later edit
  // cannot move the paint without moving the constant, or the other way round.
  const screenLength = (amount) => `calc(${String(amount)}px / var(--dsh-forge-zoom, 1))`
  assert.ok(
    STUDIO_CSS.includes(`.dsh-forge-handle{position:absolute;right:0;top:50%;width:${screenLength(HANDLE_SCREEN_HIT)}`),
    'the click target keeps a screen size',
  )
  assert.ok(
    STUDIO_CSS.includes(`width:${screenLength(HANDLE_SCREEN_SIZE)};height:${screenLength(HANDLE_SCREEN_SIZE)}`),
    'and the painted dot keeps one too',
  )
})

// ---------------------------------------------------------------------------
// G26: what a wire dropped on blank canvas actually builds.
//
// The three choices are exercised through the real bundle: the menu the gesture
// opens, the node each one creates at the drop point, the lineage they inherit,
// and the one thing none of them may do — start a generation from a drop.
// ---------------------------------------------------------------------------

/** Drop a wire from node 0 onto blank canvas and click one choice. */
async function dropAndChoose(mounted, label, point = { x: 400, y: 300 }) {
  const { panel } = mounted
  pressHandle(panel, 0, { x: 200, y: 120 })
  movePointer(mounted, point)
  await settle(panel)
  releasePointer(mounted)
  await settle(panel)
  const menu = connectMenu(panel)
  assert.ok(menu !== undefined, 'a blank drop opens the node-type menu')
  const choice = menu.items.find((entry) => fakeText(entry) === label)
  assert.ok(choice !== undefined, `the menu must offer ${label}`)
  choice.props.onClick()
  await settle(panel)
}

// ---------------------------------------------------------------------------
// G28: 放入素材 — the third choice puts a library picture where the wire was
// released, parented to the source, without moving the file or generating.
//
// The library lives in another view, so the entry grows a picker inside the same
// card. These tests drive that through the real bundle: open the picker, filter
// it with the asset page's own scope + keyword, pick a row, and assert the node
// it becomes — plus the three ways to back out with nothing built.
// ---------------------------------------------------------------------------

/** One picture on *another* board, so the picker has a cross-board case. */
const LIBRARY_ASSET = {
  id: 'ishiba9',
  boardId: 'cbrdother',
  boardName: '收藏板',
  path: 'C:/out/shiba.png',
  markdownPath: 'C:/out/shiba.png',
  width: 1024,
  height: 768,
  bytes: 4096,
  mediaType: 'image/png',
  prompt: '一只柴犬在海边奔跑',
  ratio: '4:3',
  steps: 8,
  seed: 3,
  mode: 'generate',
  backend: 'studio',
  parents: [],
  createdAt: '2026-11-17T00:00:00.000Z',
  sessionId: null,
  batchId: 'blib',
  x: null,
  y: null,
}

/**
 * Let an asset read land: flush the effect that schedules it, wait out its 220 ms
 * debounce, then flush the answer.
 *
 * The order matters — the effect body only runs inside `settle`, so waiting first
 * would just sit in front of a timer nobody had started yet.
 */
async function settleAssets(panel) {
  await settle(panel)
  await new Promise((resolve) => setTimeout(resolve, 260))
  await settle(panel)
}

/** Drop a wire on blank canvas and click 放入素材; returns the open picker. */
async function openAssetPicker(mounted, point = { x: 400, y: 300 }) {
  const { panel } = mounted
  pressHandle(panel, 0, { x: 200, y: 120 })
  movePointer(mounted, point)
  await settle(panel)
  releasePointer(mounted)
  await settle(panel)
  const menu = connectMenu(panel)
  assert.ok(menu !== undefined, 'a blank drop opens the node-type menu')
  const choice = menu.items.find((entry) => fakeText(entry) === '放入素材')
  assert.ok(choice !== undefined, 'the menu must offer 放入素材')
  assert.notEqual(choice.props.disabled, true, 'and it must not be greyed out any more')
  choice.props.onClick()
  await settle(panel)
  return connectPicker(panel)
}

/** The picture a node paints, if it paints one — its `src`, or `undefined`. */
function nodeImageSrc(node) {
  let src
  fakeVisit(node, (entry) => {
    if (src === undefined && entry.type === 'img') src = entry.props.src
  })
  return src
}

/** Click the picker's 全部画板 scope, so a cross-board asset is in range. */
async function showAllBoards(panel) {
  const picker = connectPicker(panel)
  assert.ok(picker !== undefined, 'the picker must be open')
  const toggle = picker.toggles.find((entry) => fakeText(entry) === '全部画板')
  assert.ok(toggle !== undefined, 'the picker offers the same two scopes as the asset page')
  toggle.props.onClick()
  await settle(panel)
  await settleAssets(panel)
  return connectPicker(panel)
}

// ---------------------------------------------------------------------------
// G26: the edge reaches the store.
//
// The gesture is only worth anything if the edge survives a reload, and that is
// the half the pure functions cannot prove: the flush has to carry it, the route
// has to pass it through, and `saveLayout` has to merge it without dropping what
// was already there. Asserted against the real modules from `src/` — the testlib
// bundles are a snapshot, and this contract is current.
// ---------------------------------------------------------------------------

/** A board on a temp dir with two recorded pictures. */
async function seededBoard() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-g26-'))
  const write = await recordItemsLive(dir, undefined, [
    { path: 'C:/out/iaaa1.png', markdownPath: 'C:/out/iaaa1.png', width: 1024, height: 1024, bytes: 1, mediaType: 'image/png', prompt: 'a' },
    { path: 'C:/out/ibbb2.png', markdownPath: 'C:/out/ibbb2.png', width: 1024, height: 1024, bytes: 1, mediaType: 'image/png', prompt: 'b' },
  ])
  return { dir, boardId: write.board.id, items: write.items }
}

test('G26: a layout entry passes parents through, and drops junk instead of refusing', () => {
  const withParents = parseBoardActionLive({
    action: 'layout',
    items: [{ id: 'ia', x: 1, y: 2, parents: ['ib', 'ib', '  ', 7] }],
  })
  assert.deepEqual(withParents.items, [{ id: 'ia', x: 1, y: 2, parents: ['ib', 'ib'] }])

  // Without parents the entry is **byte-identical** to what this parser always
  // produced — no empty `parents: []` appearing in every board write.
  const bare = parseBoardActionLive({ action: 'layout', items: [{ id: 'ia', x: 1, y: 2 }] })
  assert.deepEqual(bare.items, [{ id: 'ia', x: 1, y: 2 }])
  assert.ok(!('parents' in bare.items[0]))

  // A malformed lineage payload must not cost the user the position they dragged.
  assert.deepEqual(
    parseBoardActionLive({ action: 'layout', items: [{ id: 'ia', x: 1, y: 2, parents: 'nope' }] }).items,
    [{ id: 'ia', x: 1, y: 2 }],
  )
  assert.deepEqual(
    parseBoardActionLive({ action: 'layout', items: [{ id: 'ia', x: 1, y: 2, parents: [1, 2] }] }).items,
    [{ id: 'ia', x: 1, y: 2 }],
  )
})

test('G26: saveLayout merges parents as a union, and a position-only write changes nothing', async () => {
  const seeded = await seededBoard()
  try {
    const [first, second] = seeded.items
    // A pre-existing edge on the target, to prove the merge never replaces.
    await saveLayoutLive(seeded.dir, seeded.boardId, { items: [{ id: second.id, x: 600, y: 0, parents: [first.id] }] })
    let board = await readBoardLive(seeded.dir, seeded.boardId)
    assert.deepEqual(board.items.find((item) => item.id === second.id).parents, [first.id])

    // A position-only write (the pre-G26 request shape) leaves the edge alone.
    await saveLayoutLive(seeded.dir, seeded.boardId, { items: [{ id: second.id, x: 640, y: 20 }] })
    board = await readBoardLive(seeded.dir, seeded.boardId)
    const moved = board.items.find((item) => item.id === second.id)
    assert.deepEqual(moved.parents, [first.id], 'a drag must not erase lineage')
    assert.equal(moved.x, 640, 'and the position still lands')

    // Adding an edge is additive and de-duplicated; the stored order is kept.
    await saveLayoutLive(seeded.dir, seeded.boardId, { items: [{ id: second.id, x: 640, y: 20, parents: ['iz9', first.id] }] })
    board = await readBoardLive(seeded.dir, seeded.boardId)
    assert.deepEqual(board.items.find((item) => item.id === second.id).parents, [first.id, 'iz9'])
  } finally {
    rmSync(seeded.dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// G01/G23/G05/G12: canvas feel — wheel semantics, edge width, zoom ceiling and
// where a paste lands. The camera maths is unit-tested in studio-canvas.test.mjs;
// what these assert is that the *bundle* actually ships that behaviour and that
// the paste flows through the real handlers.
// ---------------------------------------------------------------------------

test('the canvas bundle ships the pan/zoom wheel split, a pixel-wide edge and the hint', () => {
  // G01: the wheel handler is registered natively (React's wheel listener is
  // passive, so `preventDefault` there is ignored), which means the harness
  // cannot call it. The decision function is unit-tested; this is the other half
  // — that the panel routes the wheel through it instead of the old
  // "any wheel zooms" branch.
  assert.ok(CLIENT_SOURCE.includes('wheelIntent('), 'the wheel handler must read the shared decision helper')
  assert.ok(CLIENT_SOURCE.includes('panByScroll('), 'a bare wheel must pan through the scroll helper')
  assert.ok(!CLIENT_SOURCE.includes('zoomAt(current, event.deltaY < 0'), 'the old zoom-on-every-wheel branch must be gone')
  // The user-facing legend (§G01): one line in the canvas corner, no toast.
  assert.ok(CLIENT_SOURCE.includes('滚轮平移 · Ctrl/⌘+滚轮缩放'), 'the wheel gesture has to be stated somewhere on screen')
  // G23: an SVG stroke in the world layer scales with the zoom, so at 0.1× every
  // wire was a fifth of a pixel wide. `vector-effect` is what pins it to screen px.
  assert.ok(CLIENT_SOURCE.includes('vector-effect:non-scaling-stroke'), 'edges must keep a screen-pixel stroke width')
})

test('the fit path reports the zoom-floor clamp instead of failing silently', () => {
  // G15: `fitCamera` clamps at 10%, and past ~36 nodes the far columns stayed
  // off-screen with no message. The predicate is unit-tested in
  // studio-canvas.test.mjs; this asserts the panel asks it and says so. The
  // canvas element is not measurable in this harness, so the handler itself
  // cannot run here.
  assert.ok(CLIENT_SOURCE.includes('fitNeedsClamp('), '适应 must ask whether the clamp bit')
  assert.ok(CLIENT_SOURCE.includes('已到最小缩放（10%）'), 'and say so instead of silently framing part of the board')
})

// ---------------------------------------------------------------------------
// G25: the copy/move-to-board menu entries are wired to the C12 routes.
// ---------------------------------------------------------------------------

/** A second board so the picker has somewhere to send the item. */
const OTHER_BOARD_SUMMARY = {
  id: 'cbrdother',
  name: '收藏板',
  itemCount: 2,
  cover: null,
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
  sessionId: null,
}

/** Right-click the second node so its image menu is open, selection = it. */
async function openImageMenu(panel) {
  canvasElement(panel).props.onContextMenu(pointerEvent({
    clientX: 700,
    clientY: 60,
    target: { closest: (selector) => (selector === '.dsh-forge-node' ? { dataset: { nodeId: 'ibbb2' } } : null) },
  }))
  await settle(panel)
  return menuEntries(panel)
}

// ---------------------------------------------------------------------------
// G22: the in-canvas lightbox.
// ---------------------------------------------------------------------------

/** The open lightbox's parts, or `undefined` when it is closed. */
function lightboxView(panel) {
  const box = fakeElementWithClass(panel.tree, 'dsh-forge-lightbox')
  if (box === undefined) return undefined
  const image = fakeElementWithClass(box, 'dsh-forge-lightbox-img')
  return {
    title: fakeText(fakeElementWithClass(box, 'dsh-forge-lightbox-title') ?? []),
    meta: fakeText(fakeElementWithClass(box, 'dsh-forge-lightbox-meta') ?? []),
    src: image === undefined ? undefined : image.props.src,
    element: box,
  }
}

test('G20: the canvas asks for thumbnails and the lightbox asks for the original', () => {
  // The route half is asserted against a real socket in
  // studio-file-route.test.mjs; this is the other half — that the panel actually
  // requests a width where a width helps, and does not where it would hurt.
  assert.ok(CLIENT_SOURCE.includes('function studioFileUrl(path, width)'), 'the URL helper must be able to carry ?w=')
  assert.ok(CLIENT_SOURCE.includes('studioFileUrl(node.image.markdownPath, 512)'), 'a canvas node loads a 512-px thumbnail')
  assert.ok(CLIENT_SOURCE.includes('studioFileUrl(asset.markdownPath, 256)'), 'an asset card loads a 256-px thumbnail')
  assert.ok(CLIENT_SOURCE.includes('studioFileUrl(image.markdownPath, 512)'), 'the batch grid loads a 512-px thumbnail')
  assert.ok(
    CLIENT_SOURCE.includes('studioFileUrl(lightboxNode.image.markdownPath)'),
    'the lightbox must load the original, not the thumbnail it is meant to enlarge',
  )
  // G22's overlay ships with the bundle.
  assert.ok(CLIENT_SOURCE.includes('dsh-forge-lightbox'), 'the lightbox markup must ship')
  assert.ok(CLIENT_SOURCE.includes('放大查看'), 'and the menu entry that opens it')
})

// ---------------------------------------------------------------------------
// T22: the install → first picture stepper (P6).
// ---------------------------------------------------------------------------

test('T22: the stepper maps snapshot + live phase onto four steps', () => {
  const models = { unet: 'unet.safetensors', clip: 'clip.safetensors', vae: 'vae.safetensors' }
  assert.deepEqual(
    stepperStepsOf({ ready: true, models, endpoint: 'http://127.0.0.1:8188', itemCount: 0 }).map((step) => step.id),
    ['runtime', 'install', 'weights', 'first-run'],
  )
  assert.deepEqual(
    stepperStepsOf({ ready: true, models, endpoint: 'http://127.0.0.1:8188', itemCount: 0 }).map((step) => step.state),
    ['done', 'done', 'done', 'pending'],
    'ready on a fresh board: everything installed, first picture still to do',
  )

  // Not installed: the runtime step fails with the reason's first line only.
  const off = stepperStepsOf({ ready: false, reason: 'ComfyUI 未连接：探了 8188\n第二行不展示', itemCount: 0 })
  assert.equal(off[0].state, 'failed')
  assert.ok(off[0].detail.includes('ComfyUI 未连接'))
  assert.ok(!off[0].detail.includes('第二行'), 'only the headline reaches the row')
  assert.equal(off[2].state, 'pending')

  // Connected but weights missing is a distinct failure (the T14 download step).
  const noWeights = stepperStepsOf({ ready: true, itemCount: 0 })
  assert.equal(noWeights[2].state, 'failed')
  assert.ok(noWeights[2].detail.includes('qwen_image_setup'), 'the row names the managed download entry')

  // The live SSE phase drives the last step.
  const running = stepperStepsOf({ ready: true, models, itemCount: 0, livePhase: 'running', livePercent: 34 })
  assert.equal(running[3].state, 'active')
  assert.ok(running[3].detail.includes('34%'))
  const failed = stepperStepsOf({ ready: true, models, itemCount: 0, livePhase: 'error', liveMessage: 'CUDA out of memory' })
  assert.equal(failed[3].state, 'failed')
  assert.ok(failed[3].detail.includes('CUDA out of memory'))
  assert.equal(stepperStepsOf({ ready: true, models, itemCount: 2 }).at(-1).state, 'done', 'an existing picture finishes the ladder')
})

test('T22: the panel renders the stepper, and 重新检测 re-reads the snapshot', async () => {
  const { network, panel } = await mountWorkbench()
  try {
    const steps = []
    fakeVisit(panel.tree, (entry) => {
      if (typeof entry.props.className === 'string' && entry.props.className.split(' ')[0] === 'dsh-forge-step') steps.push(entry)
    })
    assert.deepEqual(steps.map((step) => step.props['data-step']), ['runtime', 'install', 'weights', 'first-run'])
    assert.deepEqual(steps.map((step) => step.props['data-step-state']), ['done', 'done', 'done', 'pending'])

    const configCalls = () => network.calls.filter((call) => call.url.indexOf(STUDIO_CONFIG_ROUTE) === 0).length
    const before = configCalls()
    const retry = buttonWithText(panel, '重新检测')
    assert.ok(retry !== undefined, 'the stepper must offer a recheck entry')
    retry.props.onClick()
    await settle(panel)
    assert.ok(configCalls() > before, '重新检测 re-reads the capability snapshot')

    // The live stream advances the last step to active with its percent.
    const source = network.open()
    source.emit('message', { type: 'start', promptId: 'p-stepper' })
    source.emit('message', { type: 'progress', promptId: 'p-stepper', value: 17, max: 50, percent: 34, label: '17/50' })
    await settle(panel)
    let firstRun
    fakeVisit(panel.tree, (entry) => {
      if (entry.props['data-step'] === 'first-run') firstRun = entry
    })
    assert.equal(firstRun.props['data-step-state'], 'active')
    assert.ok(fakeText(firstRun).includes('34%'))
  } finally {
    network.restore()
  }
})

test('T22: a not-ready snapshot puts its reason on the failed step', async () => {
  const { network, panel } = await mountWorkbench({
    configOverrides: { ready: false, reason: 'ComfyUI 未连接：探了 8188 等端口', models: undefined },
  })
  try {
    let runtime
    let weights
    fakeVisit(panel.tree, (entry) => {
      if (entry.props['data-step'] === 'runtime') runtime = entry
      if (entry.props['data-step'] === 'weights') weights = entry
    })
    assert.equal(runtime.props['data-step-state'], 'failed')
    assert.ok(fakeText(runtime).includes('ComfyUI 未连接'))
    assert.equal(weights.props['data-step-state'], 'pending', 'weights cannot be checked before the runtime is up')
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// C11: task nodes — generate drops one, SSE drives it, the response converts it.
//
// The panel's generate is a fetch whose response the test resolves by hand:
// that is what makes the "done frame before the response" race observable, and
// it is C11's stop-condition plan asserted rather than hoped for. What still
// needs a browser: pointer capture, paint, and a live ComfyUI run.
// ---------------------------------------------------------------------------

/** A response the test resolves when it chooses (the POST outlives the run). */
function deferredResponse() {
  let settleResponse
  const promise = new Promise((resolve) => { settleResponse = resolve })
  return {
    promise,
    resolve(payload, status = 200) { settleResponse(fakeResponse(payload, status)) },
  }
}

/** One generated image in the shape the panel expects back. */
function resultImage(id, overrides = {}) {
  return {
    id,
    path: `C:/out/${id}.png`,
    markdownPath: `C:/out/${id}.png`,
    width: 1024,
    height: 1024,
    bytes: 2048,
    mediaType: 'image/png',
    ...overrides,
  }
}

/** A full `StudioGenerateResponse` with one or more pictures. */
function generateResult(images, overrides = {}) {
  return {
    images,
    prompt: '一只橘猫坐在窗台上',
    ratio: '1:1',
    width: 1024,
    height: 1024,
    steps: 8,
    seed: 7,
    elapsedMs: 1200,
    endpoint: 'http://127.0.0.1:8188',
    mode: 'generate',
    turboFallback: false,
    ...overrides,
  }
}

/** Every painted node of one kind. */
function nodesOfKind(panel, kind) {
  return nodeElements(panel).filter((entry) => entry.props['data-node-kind'] === kind)
}

/** The single task node on the canvas. */
function taskNodeElement(panel) {
  const tasks = nodesOfKind(panel, 'task')
  assert.equal(tasks.length, 1, 'exactly one task node is expected')
  return tasks[0]
}

/** The edge keys (`parent->child`) the canvas drew. */
function edgeKeys(panel) {
  const keys = []
  fakeVisit(panel.tree, (entry) => {
    if (entry.type === 'path' && typeof entry.props.key === 'string') keys.push(entry.props.key)
  })
  return keys
}

/** Type into the form's prompt box, the way the user would. */
async function typePrompt(panel, text) {
  fakeElementWithClass(panel.tree, 'dsh-forge-textarea').props.onChange({ target: { value: text } })
  await settle(panel)
}

/** Mount the canvas board with a generation stub; the stub sees each body. */
async function mountGeneration(generate, board = HARNESS_BOARD) {
  const requests = []
  const mounted = await mountWorkbench({
    board,
    generate: (init) => {
      requests.push(JSON.parse(init.body))
      return generate(requests.length - 1)
    },
  })
  return { ...mounted, requests }
}

// ---------------------------------------------------------------------------
// C12: asset flow — cross-board copy/move, OS-file import, locate camera.
//
// The drag gestures themselves have no DOM automation (§14.5); asserted here
// is every contract they call: the closed board action set, the import route
// end to end (real socket, real files), and the bundle both halves must carry.
// The side effects live in boards.test.mjs; the camera maths in
// studio-canvas.test.mjs.
// ---------------------------------------------------------------------------

test('C12: the board action set is closed at eight, and copy/move need a destination', () => {
  const actions = ['create', 'rename', 'layout', 'remove-item', 'delete', 'active', 'copy-item', 'move-item']
  // `toBoard` is ignored by the other actions and required by these two.
  for (const action of actions) assert.equal(parseBoardAction({ action, toBoard: 'b2' }).action, action)
  assert.throws(() => parseBoardAction({ action: 'copy' }), /未知的画板操作/, 'still a closed set')
  assert.throws(() => parseBoardAction({ action: 'copy-item', item: 'i1' }), /toBoard/)
  assert.throws(() => parseBoardAction({ action: 'move-item', item: 'i1' }), /toBoard/)

  const parsed = parseBoardAction({ action: 'copy-item', board: 'b1', item: 'i1', toBoard: ' b2 ', x: 10, y: -20 })
  assert.equal(parsed.board, 'b1')
  assert.equal(parsed.toBoard, 'b2')
  assert.deepEqual({ x: parsed.x, y: parsed.y }, { x: 10, y: -20 })
  // A malformed coordinate is dropped, and the pair goes with it — the same
  // per-entry leniency the layout coordinates already have.
  const dropped = parseBoardAction({ action: 'move-item', board: 'b1', item: 'i1', toBoard: 'b2', x: 'nope', y: 20 })
  assert.equal(dropped.x, undefined)
  assert.equal(dropped.y, undefined)
})

test('C12: the import body is shape-checked and base64-bounded before allocation', () => {
  assert.throws(() => parseImport({}), /缺少文件名/)
  assert.throws(() => parseImport({ name: 'a.png' }), /缺少图片内容/)
  assert.throws(() => parseImport('nope'), /请求格式无效/)
  const parsed = parseImport({ name: ' a.png ', data: 'AAAA', board: ' b1 ', x: 1, y: 2, mediaType: 'image/png' })
  assert.equal(parsed.name, 'a.png')
  assert.equal(parsed.board, 'b1')
  assert.deepEqual({ x: parsed.x, y: parsed.y }, { x: 1, y: 2 })

  assert.throws(() => decodeImportData(''), /缺少图片内容/)
  assert.throws(() => decodeImportData('not*b_a$se64!'), /base64/)
  // The 32 MB cap is enforced on the string before decoding: a body that could
  // never fit is refused without allocating the image.
  const maxBase64 = Math.ceil(STUDIO_IMPORT_MAX_ITEM_BYTES / 3) * 4
  assert.throws(() => decodeImportData('A'.repeat(maxBase64 + 4)), /上限/)
  assert.equal(decodeImportData(Buffer.from([137, 80]).toString('base64')).byteLength, 2)
})

/** A minimal PNG header with real dimensions: enough for sniffing and sizing. */
function pngHeader(width, height) {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'latin1')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

/** Mount the Studio routes on a throwaway server over one temp output dir. */
async function withStudioServer(run) {
  const registered = []
  const fakeWebServer = { register: (route) => { registered.push(route); return () => {} } }
  const fakeCtx = { webServer: fakeWebServer, logger: { warn() {} } }
  const dir = mkdtempSync(join(tmpdir(), 'forge-c12-'))
  try {
    registerStudioRoutes(fakeCtx, { settings: () => ({ outputDir: dir }), ctx: fakeCtx })
    const route = registered.find((entry) => entry.path === STUDIO_IMPORT_ROUTE)
    assert.ok(route, 'the import route must be registered')
    const server = createServer((req, res) => { void route.handler(req, res) })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      return await run({ base, dir })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** POST the import route the way the panel does, with a browser-like Origin. */
function postImport(base, body, options = {}) {
  return fetch(base + STUDIO_IMPORT_ROUTE, {
    method: options.method ?? 'POST',
    headers: {
      'content-type': options.contentType ?? 'application/json',
      ...(options.origin === null ? {} : { origin: options.origin ?? `http://${new URL(base).host}` }),
    },
    ...(options.method === 'GET' ? {} : { body: options.raw ?? JSON.stringify(body) }),
  })
}

test('C12: importing a dropped file records a board item and writes the bytes', async () => {
  await withStudioServer(async ({ base }) => {
    const bytes = pngHeader(1024, 768)
    const res = await postImport(base, {
      name: '窗台橘猫.png',
      mediaType: 'image/png',
      data: bytes.toString('base64'),
      x: 260,
      y: 44,
    })
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.item.width, 1024)
    assert.equal(payload.item.height, 768)
    assert.equal(payload.item.mediaType, 'image/png')
    assert.equal(payload.item.prompt, '', 'an imported file was not generated by a prompt')
    assert.equal(payload.item.mode, 'generate')
    assert.equal(payload.item.backend, 'studio')
    assert.equal(payload.item.x, 260)
    assert.equal(payload.item.y, 44)
    assert.equal(payload.board.itemCount, 1)
    assert.ok(existsSync(payload.item.path), 'the decoded bytes are on disk')
    // A non-ASCII file name collapses to the documented fallback prefix; the
    // size suffix comes from the sniffed dimensions, not from the claim.
    assert.match(payload.item.path.split(/[\\/]/).pop(), /^import_1024x768_1\.png$/)
  })
})

test('C12: the import route refuses cross-origin, wrong method/type and non-images', async () => {
  await withStudioServer(async ({ base }) => {
    const goodBody = { name: 'a.png', data: pngHeader(32, 32).toString('base64') }

    const cross = await postImport(base, goodBody, { origin: 'http://evil.example' })
    assert.equal(cross.status, 403, 'cross-origin is refused')

    const wrongMethod = await postImport(base, goodBody, { method: 'GET' })
    assert.equal(wrongMethod.status, 405, 'GET is not an import')

    const wrongType = await postImport(base, goodBody, { contentType: 'text/plain' })
    assert.equal(wrongType.status, 415, 'only JSON bodies are accepted')

    const notImage = await postImport(base, { name: 'notes.png', data: Buffer.from('不是图片').toString('base64') })
    assert.equal(notImage.status, 400)
    assert.match((await notImage.json()).error, /PNG \/ JPEG \/ WebP/)

    const malformed = await postImport(base, { name: 'a.png', data: '!!not base64!!' })
    assert.equal(malformed.status, 400)
    assert.match((await malformed.json()).error, /base64/)
  })
})

test('C12: the import contract and the drag MIME ship to both halves', () => {
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.ok(host.includes(STUDIO_IMPORT_ROUTE), 'the host must register the import route')
  const client = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  assert.ok(client.includes(STUDIO_IMPORT_ROUTE), 'the panel must post to the import route')
  assert.ok(client.includes('application/x-dsh-forge-asset'), 'the private drag MIME must ship')
  assert.ok(client.includes('copy-item'), 'the cross-board copy action must ship')
  assert.ok(client.includes('move-item'), 'the cross-board move action must ship')
})

// ---------------------------------------------------------------------------
// C13: layout nodes on the canvas — board rebuild, creation and its undo.
// The editor's DOM mount cannot be driven here (§14.5); what is asserted is
// the node contract around it (data/geometry/footnote) that C14 consumes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// C14: the layout loop — ratio mapping, T21 request seam, generation from a
// layout node, and the persisted task/layout entries (save-task /
// save-layout-node). The adapter itself is exercised through the same graph
// builder a real ComfyUI receives; a live GPU run is the manual evidence.
// ---------------------------------------------------------------------------

test('C14: a draft maps onto the official ratio ladder, and a stretched draft is detectable', () => {
  // Exact drafts used by the layout editor's own presets.
  assert.deepEqual(
    (({ ratio, deviation }) => ({ ratio, deviation }))(fitStudioRatio(1536, 1024)),
    { ratio: '3:2', deviation: 0 },
    'the default 1536x1024 draft is exactly 3:2',
  )
  // Every official ratio resolves from a 16-aligned draft.
  const cases = [
    [1024, 1024, '1:1'],
    [1024, 768, '4:3'],
    [768, 1024, '3:4'],
    [1024, 683, '3:2'],
    [683, 1024, '2:3'],
    [1024, 576, '16:9'],
    [576, 1024, '9:16'],
  ]
  for (const [width, height, ratio] of cases) {
    assert.equal(fitStudioRatio(width, height).ratio, ratio, String(width) + 'x' + String(height))
  }

  // An unofficial aspect maps to the nearest rung and reports how far off it is;
  // §8.4's rule is that a deviation past the tolerance is prompted, not stretched.
  const stretched = fitStudioRatio(1536, 1000)
  assert.equal(stretched.ratio, '3:2')
  assert.ok(stretched.deviation > STUDIO_LAYOUT_RATIO_TOLERANCE, 'a 1.536 aspect is not silently 3:2')
  assert.equal(fitStudioRatio(0, 100), undefined)
})

test('C14: the layout request is T21-shaped, and the no-layout graph stays byte-identical', () => {
  const resolved = { width: 1248, height: 832, count: 1, steps: 25, seed: 7 }
  const plain = studioTextToImageRequestOf({ prompt: '  A minimalist poster.  ' }, resolved)
  assert.deepEqual(
    plain,
    { prompt: 'A minimalist poster.', width: 1248, height: 832, count: 1, steps: 25, seed: 7 },
    'without layout the adapter request has exactly the pre-T21 keys',
  )
  assert.equal('layout' in plain, false)

  const withLayout = studioTextToImageRequestOf({ prompt: 'A minimalist poster.', layout: LAYOUT_SAMPLE }, resolved)
  assert.equal(withLayout.layout, LAYOUT_SAMPLE, 'the compiled text is forwarded verbatim')

  // The graph builder is the fake server here: no layout must not change a byte.
  const control = renderTextToImage(MODEL_PROFILES['moss-sft'], MOSS_MODELS, {
    prompt: 'A minimalist poster.',
    width: 1248,
    height: 832,
    count: 1,
    steps: 25,
    seed: 7,
  })
  assert.equal(JSON.stringify(renderTextToImage(MODEL_PROFILES['moss-sft'], MOSS_MODELS, plain)), JSON.stringify(control))
  const conditioned = renderTextToImage(MODEL_PROFILES['moss-sft'], MOSS_MODELS, withLayout)
  assert.equal(conditioned['4'].inputs.text, LAYOUT_SAMPLE, 'MOSS positive encoder text = compiled layout')
  assert.equal(JSON.stringify(conditioned['5']), JSON.stringify(control['5']), 'the negative prompt is untouched')
  assert.deepEqual(Object.keys(conditioned).sort(), Object.keys(control).sort(), 'no extra nodes are injected')
})

test('C14: the generate route accepts layout and canvas parents, and refuses a bad layout', () => {
  const parsed = parseGenerate({
    prompt: '按布局出图',
    ratio: '3:2',
    layout: LAYOUT_SAMPLE,
    parents: ['i1', 'i2', 3, '  '],
  })
  assert.equal(parsed.layout, LAYOUT_SAMPLE)
  assert.deepEqual(parsed.parents, ['i1', 'i2'], 'only usable ids survive')

  // Backwards compatibility: the plain body gains no new keys.
  const plain = parseGenerate({ prompt: 'x', ratio: '1:1' })
  assert.equal('layout' in plain, false)
  assert.equal('parents' in plain, false)

  assert.throws(
    () => parseGenerate({ prompt: 'x', ratio: '1:1', layout: '{"bbox_coord_space":"abs"}' }),
    /abs_centralized/,
    'the shared MOSS parser names the failing field',
  )
  assert.throws(() => parseGenerate({ prompt: 'x', ratio: '1:1', layout: 'not json' }), /布局不是合法 JSON/)
  assert.throws(() => parseGenerate({ prompt: 'x', ratio: '1:1', parents: 'i1' }), /parents 必须是数组/)
})

test('C14: the board action set reaches ten and the node writers validate their payloads', () => {
  const actions = [
    'create', 'rename', 'layout', 'remove-item', 'delete', 'active',
    'copy-item', 'move-item', 'save-task', 'save-layout-node',
  ]
  const payloads = {
    'save-task': { task: { status: 'failed', params: { prompt: 'p' } } },
    'save-layout-node': { draft: { width: 1536, height: 1024, items: [] }, w: 480, h: 420 },
  }
  for (const action of actions) {
    assert.equal(parseBoardAction({ action, toBoard: 'b2', ...(payloads[action] ?? {}) }).action, action)
  }
  assert.throws(() => parseBoardAction({ action: 'save-task' }), /缺少 task/)
  assert.throws(
    () => parseBoardAction({ action: 'save-task', task: { status: 'running', params: { prompt: 'p' } } }),
    /failed 或 interrupted/,
    'a running task is never stored (DD6)',
  )

  const task = parseBoardAction({
    action: 'save-task',
    item: 'ct1',
    x: 10,
    y: 20,
    parents: ['i1'],
    task: { status: 'failed', error: 'boom', params: { prompt: 'p', layout: '{"x":1}' } },
  })
  assert.deepEqual(task.task, { status: 'failed', error: 'boom', params: { prompt: 'p', layout: '{"x":1}' } })
  assert.deepEqual(task.parents, ['i1'])

  const layout = parseBoardAction({
    action: 'save-layout-node',
    item: 'il1',
    draft: { width: 1536, height: 1024, items: [] },
    w: 480,
    h: 420,
  })
  assert.equal(layout.w, 480)
  assert.throws(
    () => parseBoardAction({ action: 'save-layout-node', draft: { width: 1536, height: 1024, items: [] } }),
    /w \/ h/,
  )
  assert.throws(
    () => parseBoardAction({ action: 'save-layout-node', draft: { width: 'x', items: [] }, w: 1, h: 1 }),
    /draft.width/,
  )
})

// ---------------------------------------------------------------------------
// U07: 项目能力补齐 — duplicate / bytes / the two delete modes.
// The store's side effects live in boards.test.mjs; here is the wire: the closed
// action set, the flag's strictness, the size formatter the card uses, and the
// route's answer for both delete modes over a real socket.
// ---------------------------------------------------------------------------

test('U07: 复制项目 is a thirteenth board action, and duplicate takes a name', () => {
  assert.equal(parseBoardAction({ action: 'duplicate', board: 'b1' }).action, 'duplicate')
  assert.equal(parseBoardAction({ action: 'duplicate', board: 'b1', name: ' 副本 A ' }).name, ' 副本 A ')
  // Still a closed set: a typo is refused rather than treated as a no-op.
  assert.throws(() => parseBoardAction({ action: 'copy' }), /未知的画板操作/)
  assert.throws(() => parseBoardAction({ action: 'duplicate-board' }), /未知的画板操作/)
})

test('U07: the delete action carries deleteFiles only when it is literally true', () => {
  assert.equal(parseBoardAction({ action: 'delete', board: 'b1' }).deleteFiles, undefined, '默认只删项目')
  assert.equal(parseBoardAction({ action: 'delete', board: 'b1', deleteFiles: true }).deleteFiles, true)
  // A truthy non-boolean must not become a file purge — the two 口径 stay explicit.
  assert.equal(parseBoardAction({ action: 'delete', board: 'b1', deleteFiles: 'yes' }).deleteFiles, undefined)
  assert.equal(parseBoardAction({ action: 'delete', board: 'b1', deleteFiles: 1 }).deleteFiles, undefined)
  // `deleteFile` (one item) and `deleteFiles` (whole board) are different fields;
  // sending the singular one to `delete` deletes no file.
  const singular = parseBoardAction({ action: 'delete', board: 'b1', deleteFile: true })
  assert.equal(singular.deleteFile, true)
  assert.equal(singular.deleteFiles, undefined)
})

test('U07: the size label is three tiers, and every edge reads as a number', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(900), '900 B')
  assert.equal(formatBytes(1024), '1024 B', 'below one MiB stays in bytes, so nothing rounds to 0 MB')
  assert.equal(formatBytes(86 * 1024 * 1024), '86 MB')
  assert.equal(formatBytes(Math.round(1.2 * 1024 * 1024 * 1024)), '1.2 GB')
  // Boundaries: negative and non-finite clamp to `0 B` rather than print `NaN B`.
  assert.equal(formatBytes(-5), '0 B')
  assert.equal(formatBytes(Number.NaN), '0 B')
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), '0 B')
  assert.equal(formatBytes(undefined), '0 B')
  // Over a terabyte stays in the gigabyte tier — three tiers, not four.
  const oneAndAHalfTb = 1536 * 1024 * 1024 * 1024
  assert.equal(formatBytes(oneAndAHalfTb), '1536 GB')
  // The tier edge is the *printed* value: 1023 MiB is megabytes, a full GiB is
  // the next tier, and 1023.6 MiB is promoted rather than printed as `1024 MB`.
  assert.equal(formatBytes(1023 * 1024 * 1024), '1023 MB')
  assert.equal(formatBytes(1024 * 1024 * 1024), '1 GB')
  assert.equal(formatBytes(Math.round(1023.6 * 1024 * 1024)), '1 GB')
})

/** Mount just the board route on a throwaway server over one temp output dir. */
async function withBoardServer(run) {
  const registered = []
  const fakeWebServer = { register: (route) => { registered.push(route); return () => {} } }
  const fakeCtx = { webServer: fakeWebServer, logger: { warn() {} } }
  const dir = mkdtempSync(join(tmpdir(), 'forge-u07-'))
  try {
    registerStudioRoutes(fakeCtx, { settings: () => ({ outputDir: dir }), ctx: fakeCtx })
    const route = registered.find((entry) => entry.path === STUDIO_BOARD_ROUTE)
    assert.ok(route, 'the board route must be registered')
    const server = createServer((req, res) => { void route.handler(req, res) })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      return await run({ base, dir })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** POST one board action the way the panel does, with a browser-like Origin. */
function postBoard(base, body) {
  return fetch(base + STUDIO_BOARD_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://${new URL(base).host}` },
    body: JSON.stringify(body),
  })
}

/** One recorded picture with a unique file name, for the U07 route cases. */
function u07Item(dir, name, bytes) {
  const path = join(dir, `${name}.png`)
  writeFileSync(path, 'png')
  return {
    path,
    markdownPath: path,
    width: 64,
    height: 64,
    bytes,
    mediaType: 'image/png',
    prompt: name,
    mode: 'generate',
    backend: 'studio',
    parents: [],
  }
}

test('U07: the board route copies a project, and both delete 口径 reach the store', async () => {
  await withBoardServer(async ({ base, dir }) => {
    const recorded = await recordItemsLive(dir, undefined, [
      u07Item(dir, 'u07a', 1024),
      u07Item(dir, 'u07b', 2048),
    ], { prompt: 'U07 项目' })
    const boardId = recorded.board.id
    const [pngA, pngB] = recorded.items.map((entry) => entry.path)

    const copyRes = await postBoard(base, { action: 'duplicate', board: boardId, name: '副本 A' })
    assert.equal(copyRes.status, 200)
    const copy = await copyRes.json()
    assert.equal(copy.ok, true)
    assert.equal(copy.board.name, '副本 A')
    assert.notEqual(copy.board.id, boardId, 'the copy is its own board')
    assert.equal(copy.board.itemCount, 2, '条目数一致')
    assert.equal(copy.board.bytes, 3072, 'the summary reports the summed item bytes')
    assert.equal(copy.droppedParents, 0)

    // 口径二 on the original: the copy still references both files, so the
    // shared-reference guard keeps them — the answer says so instead of lying.
    const swept = await postBoard(base, { action: 'delete', board: boardId, deleteFiles: true })
    assert.deepEqual(await swept.json(), { ok: true, filesDeleted: 0, filesKept: 2 })
    assert.ok(existsSync(pngA) && existsSync(pngB), 'a shared picture survives')

    // The last board holding them may take them with it.
    const last = await postBoard(base, { action: 'delete', board: copy.board.id, deleteFiles: true })
    assert.deepEqual(await last.json(), { ok: true, filesDeleted: 2, filesKept: 0 })
    assert.equal(existsSync(pngA), false)
    assert.equal(existsSync(pngB), false)
  })
})

test('U07: a delete with no deleteFiles keeps every picture on disk', async () => {
  await withBoardServer(async ({ base, dir }) => {
    const recorded = await recordItemsLive(dir, undefined, [u07Item(dir, 'u07keep', 512)], { prompt: '只删项目' })
    const png = recorded.items[0].path
    const res = await postBoard(base, { action: 'delete', board: recorded.board.id })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, filesDeleted: 0, filesKept: 0 })
    assert.equal(await readBoardLive(dir, recorded.board.id), undefined, 'the project is gone')
    assert.ok(existsSync(png), '只删项目时图片仍在素材库')
  })
})

test('U07: the panel ships 复制/两口径, and the stylesheet carries their classes', () => {
  const client = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  assert.ok(client.includes('duplicate'), 'the pane must be able to ask for a copy')
  assert.ok(client.includes('deleteFiles'), 'and to ask for the destructive delete mode')
  assert.ok(client.includes('连图片一起删除'), 'the destructive option says what it does')
  assert.ok(client.includes('只删项目'), 'and the safe one says what it keeps')
  // The two U07 classes live in the workbench sheet, not the studio's.
  assert.ok(WORKBENCH_CSS.includes('.dsh-forge-workbench-confirm-warn'), 'the irreversibility line is styled')
  assert.ok(WORKBENCH_CSS.includes('.dsh-forge-workbench-card-size'), 'so is the size chip')
})

/* -------------------------------------------------------------------------- */
/* U08 — the global asset library's pure half (§9.2, §9.3)                    */
/* -------------------------------------------------------------------------- */

/*
 * The library lives in the projects tab as a **view** (§9.2/Q7), so nothing here
 * opens a tab. What is decidable without a browser is the part the pane spends
 * its time on: filtering by scope and text, the three orders, the three labels
 * that have to agree with the project cards, and the cross-tab rule that decides
 * where 在画布中打开 lands. The rendering side is in the shell suite.
 */

/** One library asset; every field the pane reads, overridable per case. */
function u08Asset(overrides = {}) {
  const base = {
    id: 'i1',
    boardId: 'b_one',
    boardName: '橘猫计划',
    path: 'C:/out/cat.png',
    markdownPath: 'C:/out/cat.png',
    width: 1024,
    height: 1024,
    bytes: 2 * 1024 * 1024,
    mediaType: 'image/png',
    prompt: '一只橘猫坐在窗台上\n光影很好',
    ratio: '1:1',
    steps: 8,
    seed: 7,
    mode: 'generate',
    backend: 'studio',
    parents: [],
    createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  }
  return { ...base, ...overrides }
}

/** 'projects' + two canvas tabs, the strip the library is read from. */
const U08_TABS = [
  { key: 'projects', kind: 'projects', orphaned: false },
  { key: 'canvas:b_one', kind: 'canvas', boardId: 'b_one', orphaned: false },
  { key: 'canvas:b_two', kind: 'canvas', boardId: 'b_two', orphaned: false },
]

test('U08: the library filters by scope and text locally, no board query involved', () => {
  const assets = [
    u08Asset({ id: 'i1', boardId: 'b_one', boardName: '橘猫计划', prompt: '一只橘猫' }),
    u08Asset({ id: 'i2', boardId: 'b_two', boardName: '海报草图', prompt: '蓝色海报', path: 'C:/out/poster.png' }),
    u08Asset({ id: 'i3', boardId: 'b_two', boardName: '海报草图', prompt: '', path: 'C:/out/DSC_0042.png' }),
  ]

  // 全部项目: everything, in the order it arrived (sorting is a separate step).
  assert.deepEqual(
    assetFilter(assets, { query: '', scope: ASSET_SCOPE_ALL }).map((asset) => asset.id),
    ['i1', 'i2', 'i3'],
  )
  // 指定项目: the board's own pictures only.
  assert.deepEqual(
    assetFilter(assets, { query: '', scope: 'b_two' }).map((asset) => asset.id),
    ['i2', 'i3'],
  )
  // The needle the route's `q=` matches: prompt, file name and project name.
  assert.deepEqual(
    assetFilter(assets, { query: '海报', scope: ASSET_SCOPE_ALL }).map((asset) => asset.id),
    ['i2', 'i3'],
    'a project name is a searchable field',
  )
  assert.deepEqual(
    assetFilter(assets, { query: 'DSC_0042', scope: ASSET_SCOPE_ALL }).map((asset) => asset.id),
    ['i3'],
    'so is the file name — an imported picture has no prompt',
  )
  assert.deepEqual(
    assetFilter(assets, { query: '橘猫', scope: 'b_two' }),
    [],
    'scope and text are both applied (searching one project cannot leak the other)',
  )
  // Whitespace is not a needle, and the filter never reorders or mutates.
  assert.equal(assetFilter(assets, { query: '   ', scope: ASSET_SCOPE_ALL }).length, 3)
  assert.equal(assets[0].id, 'i1')
})

test('U08: the three orders sort a copy, and a tie falls back to newest', () => {
  const assets = [
    u08Asset({ id: 'old', createdAt: '2026-11-01T00:00:00.000Z', bytes: 900, prompt: 'b 图' }),
    u08Asset({ id: 'new', createdAt: '2026-11-18T00:00:00.000Z', bytes: 100, prompt: 'a 图' }),
    u08Asset({ id: 'mid', createdAt: '2026-11-10T00:00:00.000Z', bytes: 900, prompt: 'c 图' }),
  ]
  assert.deepEqual(assetSort(assets, 'recent').map((asset) => asset.id), ['new', 'mid', 'old'])
  assert.deepEqual(
    assetSort(assets, 'largest').map((asset) => asset.id),
    ['mid', 'old', 'new'],
    'equal sizes keep the newest first',
  )
  assert.deepEqual(assetSort(assets, 'name').map((asset) => asset.id), ['new', 'old', 'mid'], 'A→Z by title')
  assert.deepEqual(assets.map((asset) => asset.id), ['old', 'new', 'mid'], 'the input array is untouched')
  // The picker and the label table never drift apart.
  assert.deepEqual(ASSET_SORTS.map((sort) => ASSET_SORT_LABELS[sort]), ['最新', '最大', '名称'])
})

test('U08: a card reuses the project card’s size and time spellings, and names itself by prompt', () => {
  // formatBytes is U07's: the same 86 MB on a project card is the same here.
  assert.equal(assetSizeLabel({ bytes: 86 * 1024 * 1024 }), formatBytes(86 * 1024 * 1024))
  assert.equal(assetSizeLabel({ bytes: 0 }), '0 B')
  // relativeTime is U07's too, so `3 分钟前` cannot be spelled two ways.
  const at = new Date(2026, 10, 18, 12, 0, 0).toISOString()
  assert.equal(assetTimeLabel({ createdAt: at }, new Date(2026, 10, 18, 12, 3, 0).getTime()), '3 分钟前')
  assert.equal(assetTimeLabel({ createdAt: 'not a date' }), '')

  // The title rule: prompt's first line, else the file name, else the id.
  assert.equal(assetTitle({ prompt: '  一只橘猫\n第二行', path: 'C:/out/a.png', id: 'i1' }), '一只橘猫')
  assert.equal(assetTitle({ prompt: '   ', path: 'C:\\out\\imported.png', id: 'i1' }), 'imported.png')
  assert.equal(assetTitle({ prompt: '', path: '', id: 'i9' }), 'i9')
  // Geometry is omitted rather than printed as 0×0 on a task/layout entry.
  assert.equal(assetDimensions({ width: 1024, height: 768 }), '1024×768')
  assert.equal(assetDimensions({ width: 0, height: 0 }), '')
})

test('U08: thumbnails ask the file route for the 256-px contact-sheet cell', () => {
  const url = assetThumbUrl({ markdownPath: 'C:/out/cat.png', path: 'C:/out/cat.png' })
  assert.equal(ASSET_THUMB_WIDTH, 256)
  assert.ok(url.includes(encodeURIComponent('C:/out/cat.png')), 'the path is encoded into ?path=')
  assert.ok(url.endsWith('&w=256'), 'one whitelisted width, never a free number')
  // An item the host stored without a markdown path still gets a URL.
  assert.ok(assetThumbUrl({ markdownPath: '', path: 'C:/out/b.png' }).includes('b.png'))
})

test('U08: 在画布中打开 lands on the active canvas, then the last one — never on a closed tab', () => {
  // 1. The active tab *is* a canvas: that board.
  assert.equal(canvasTargetBoard(U08_TABS, 'canvas:b_two', 'b_one'), 'b_two')
  // 2. The projects tab is in front (which is where the library lives): the
  //    canvas the user looked at last, as long as it is still open.
  assert.equal(canvasTargetBoard(U08_TABS, 'projects', 'b_one'), 'b_one')
  // 3. That tab was closed → no destination, so the action is disabled.
  const closed = U08_TABS.filter((tab) => tab.key !== 'canvas:b_one')
  assert.equal(canvasTargetBoard(closed, 'projects', 'b_one'), undefined)
  // Nothing remembered, and only the projects tab: still nothing.
  assert.equal(canvasTargetBoard([U08_TABS[0]], 'projects'), undefined)

  // The hint says the same thing the disabled button's title does.
  assert.equal(assetsScopeHint(), ASSET_NEEDS_PROJECT_COPY)
  assert.match(assetsScopeHint('橘猫计划'), /橘猫计划/)
})

test('U08: the library’s constants match the routes and the copy §9/§11 ask for', () => {
  // One read asks for the route's own cap (`listAssets` clamps to 1..500).
  assert.equal(ASSET_PAGE_LIMIT, 500)
  assert.match(ASSETS_EMPTY_BODY, /所有项目产出的图/)
  assert.match(ASSETS_BOARD_EMPTY_COPY, /这个项目还没有素材/)
  // The scope sentinel cannot collide with a board id (`b<base36><4 hex>`).
  assert.equal(/^b[0-9a-z]/.test(ASSET_SCOPE_ALL), false)
  // The classes the pane renders are in the workbench sheet, not the studio's.
  for (const className of [
    '.dsh-forge-workbench-assets-grid',
    '.dsh-forge-workbench-asset-hint',
    '.dsh-forge-workbench-asset-transfer',
    '.dsh-forge-workbench-asset-confirm',
  ]) {
    assert.ok(WORKBENCH_CSS.includes(className), `${className} must be styled`)
  }
})

/** Mount a board holding exactly one layout node with `draft`. */
function layoutBoard(draft, extra = {}) {
  return {
    id: 'cbrdloop',
    name: '布局闭环板',
    camera: { x: 0, y: 0, zoom: 1 },
    items: [
      {
        id: 'ilayout1',
        kind: 'layout',
        x: 120,
        y: 60,
        parents: [],
        w: 480,
        draft,
        ...extra,
      },
    ],
  }
}

/** The layout node's own 生成 button (the form has a 生成 button too). */
function layoutGenerateButton(panel) {
  const node = nodesOfKind(panel, 'layout')[0]
  assert.ok(node !== undefined, 'the layout node must render')
  let found
  fakeVisit(node, (entry) => {
    if (found === undefined && entry.type === 'button' && fakeText(entry) === '生成') found = entry
  })
  return found
}

// ---------------------------------------------------------------------------
// C15: incremental layout save (DD12) and the activated §6.4 entries.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P2: start / stop ComfyUI from the workbench.
//
// Two layers, tested separately on purpose: the *route* owns the guards (origin,
// single-flight, ownership) and is exercised through a fake web server with
// injected machine seams, so nothing here spawns Python or kills anything; the
// *panel* is exercised through the built client bundle with a stubbed fetch.
// ---------------------------------------------------------------------------

/** A minimal Comfy Desktop fixture: a usable install plus the registry naming it. */
function makeEnvironmentMachine() {
  const root = mkdtempSync(join(tmpdir(), 'forge-studio-env-'))
  const installPath = join(root, 'ComfyUI-Installs', 'ComfyUI')
  const mainPy = join(installPath, 'ComfyUI', 'main.py')
  mkdirSync(dirname(mainPy), { recursive: true })
  writeFileSync(mainPy, '# fake ComfyUI main.py\n')
  const venv = join(installPath, 'ComfyUI', '.venv')
  const python = join(venv, 'Scripts', 'python.exe')
  mkdirSync(dirname(python), { recursive: true })
  writeFileSync(python, '')
  mkdirSync(join(venv, 'Lib', 'site-packages', 'torch'), { recursive: true })
  const desktop = join(root, 'Comfy Desktop')
  mkdirSync(desktop, { recursive: true })
  writeFileSync(join(desktop, 'installations.json'), JSON.stringify([
    { id: 'inst-p2', name: 'ComfyUI', status: 'installed', installPath, port: 18188, launchArgs: '', envVars: {} },
  ]))
  return { root, installPath, mainPy, python }
}

/** The settings shape the routes read; the environment route never asks for more. */
function environmentRouteSettings(machine) {
  return {
    comfyEndpoint: '',
    comfyPorts: [18188],
    comfyModelsDir: '',
    timeoutMs: 500,
    outputDir: machine.root,
    defaultSteps: 20,
    comfyuiSteps: undefined,
    comfyModel: 'qwen21-base',
    turboSteps: undefined,
  }
}

/** Register the routes against a fake web server and return them by path. */
function routeHandlers(deps) {
  const routes = new Map()
  const ctx = {
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => {} } },
    get: () => undefined,
    logger: { warn() {} },
  }
  registerStudioRoutes(ctx, { ...deps, ctx })
  return routes
}

/** One POST through a registered handler, captured as `{ status, body }`. */
async function exchange(handler, body) {
  const payload = Buffer.from(JSON.stringify(body))
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:51791', origin: 'http://127.0.0.1:51791' },
    async *[Symbol.asyncIterator]() { yield payload },
    once() {},
  }
  const res = {
    status: 0,
    headers: {},
    text: '',
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; this.headersSent = true; return this },
    write(chunk) { this.text += String(chunk); return true },
    end(chunk) { if (chunk !== undefined) this.text += String(chunk); this.writableEnded = true; return this },
    once() {},
    on() {},
    removeListener() {},
  }
  await handler(req, res)
  return { status: res.status, headers: res.headers, text: res.text, body: res.text.length > 0 ? JSON.parse(res.text) : undefined }
}

test('P2: the environment route answers status, and a second start in flight is refused', async () => {
  const machine = makeEnvironmentMachine()
  try {
    const routes = routeHandlers({
      settings: () => environmentRouteSettings(machine),
      environment: {
        options: () => ({ endpoint: '', ports: [18188], probeTimeoutMs: 60, installTimeoutMs: 120, waitIntervalMs: 20 }),
        deps: {
          env: {},
          platform: 'win32',
          appData: machine.root,
          scanRoots: [],
          fetchImpl: async () => { throw new Error('connect ECONNREFUSED') },
          spawn: () => ({ pid: 3131, exitCode: null, unref() {} }),
          // Blocks long enough for a second click to arrive, then reports free.
          portProbe: () => new Promise((resolve) => setTimeout(() => resolve(false), 200)),
          commandLineOf: () => null,
          kill: () => {},
        },
      },
    })
    const handler = routes.get(STUDIO_ENVIRONMENT_ROUTE)
    assert.equal(typeof handler, 'function', 'the environment route must be registered')

    const status = await exchange(handler, { action: 'status' })
    assert.equal(status.status, 200)
    assert.equal(status.body.environment.state, 'not-running')
    assert.equal(status.body.environment.owned, false, 'a record-less install owns nothing')
    assert.match(String(status.body.environment.note), /安装/)

    // Click twice: the second must be refused instead of spawning a second Python.
    const first = exchange(handler, { action: 'start' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const second = await exchange(handler, { action: 'start' })
    assert.equal(second.status, 409, 'one start at a time, even from a double click')
    assert.match(String(second.body.error), /正在启动/)
    const finished = await first
    assert.equal(finished.status, 200)
    assert.equal(finished.body.environment.state, 'timeout', 'the fake renderer never answers')
    assert.equal(finished.body.environment.owned, false)

    // An unknown action is a refusal, not a silent read.
    const typo = await exchange(handler, { action: 'restart' })
    assert.equal(typo.status, 400)
    assert.match(String(typo.body.error), /未知的环境操作/)

    // A stop after a failed start: the record from the failed attempt exists, but
    // its pid cannot be proved to be ours (no command line), so nothing is killed.
    // The refusal crosses the wire instead of the plugin guessing.
    const stop = await exchange(handler, { action: 'stop' })
    assert.equal(stop.status, 200)
    assert.equal(stop.body.stop.stopped, false)
    assert.equal(stop.body.stop.reason, 'unverified')
    assert.match(String(stop.body.stop.note), /无法确认/)
    assert.equal(stop.body.environment.state, 'not-running')
  } finally {
    rmSync(machine.root, { recursive: true, force: true })
  }
})

test('P2: a not-ready panel offers one background start, and clicking it posts the action', async () => {
  const { network, panel } = await mountWorkbench({
    configOverrides: { ready: false, reason: 'ComfyUI 没在跑（connect ECONNREFUSED）' },
    environment: (body) => (body.action === 'start'
      ? { environment: { state: 'ready', owned: true, pid: 4242, endpoint: 'http://127.0.0.1:8188', note: '已后台拉起 ComfyUI' } }
      : { environment: { state: 'not-running', owned: false, note: '找到安装，可以启动' } }),
  })
  try {
    const start = buttonWithText(panel, '启动')
    assert.ok(start !== undefined, 'a not-ready status line must offer 启动')
    assert.equal(buttonWithText(panel, '启动并看日志'), undefined, 'no external-window log mode')
    assert.equal(start.props.disabled, undefined, 'the start button is enabled')

    start.props.onClick()
    await settle(panel)

    const posts = network.calls.filter((call) => call.url.indexOf(STUDIO_ENVIRONMENT_ROUTE) === 0 && call.method === 'POST')
    // The mount already posted one `status`; the click must add a `start`.
    const starts = posts.filter((call) => call.body === JSON.stringify({ action: 'start' }))
    assert.equal(starts.length, 1, 'the click must post exactly one start')
    // `loadConfig` re-reads the snapshot afterwards, so the line follows the host.
    assert.ok(
      posts.slice(posts.indexOf(starts[0]) + 1).some((call) => String(call.body).includes('"status"')),
      'a start is followed by a status re-read',
    )
  } finally {
    network.restore()
  }
})

test('P2: a failed start prints the host note and the log path verbatim', async () => {
  const { network, panel } = await mountWorkbench({
    configOverrides: { ready: false, reason: '未就绪' },
    environment: (body) => (body.action === 'start'
      ? { environment: { state: 'launch-failed', owned: false, note: '端口被占：18188 上已有进程在监听', logPath: 'C:/logs/launch-x.log' } }
      : { environment: { state: 'not-running', owned: false } }),
  })
  try {
    const start = buttonWithText(panel, '启动')
    assert.ok(start !== undefined)
    start.props.onClick()
    await settle(panel)

    const hints = noteText(panel)
    assert.ok(hints.includes('端口被占'), 'the host note must be shown: ' + hints)
    assert.ok(hints.includes('C:/logs/launch-x.log'), 'the log path is what makes a failure actionable')
  } finally {
    network.restore()
  }
})

test('P2: a running instance the plugin started offers 停止, and confirm gates it', async () => {
  const answers = []
  let confirmed = false
  harnessConfirm = () => confirmed
  const { network, panel } = await mountWorkbench({
    environment: (body) => {
      answers.push(body.action)
      return body.action === 'stop'
        ? { environment: { state: 'not-running', owned: false }, stop: { stopped: true, pid: 4242, exitCode: 0, note: '已停止本插件拉起的 pid 4242' } }
        : { environment: { state: 'ready', owned: true, pid: 4242, endpoint: 'http://127.0.0.1:8188', note: 'ComfyUI 在跑' } }
    },
  })
  try {
    const endpointLine = fakeElementWithClass(panel.tree, 'dsh-forge-studio-endpoint')
    assert.ok(endpointLine !== undefined)
    assert.ok(fakeText(endpointLine).includes('本次由插件拉起'), 'the panel must say the process outlives it')
    assert.ok(fakeText(endpointLine).includes('pid 4242'))

    const stop = buttonWithText(panel, '停止')
    assert.ok(stop !== undefined, 'an owned instance offers 停止')
    assert.notEqual(stop.props.disabled, true)

    const stopPosts = () => network.calls.filter((call) => call.url.indexOf(STUDIO_ENVIRONMENT_ROUTE) === 0 && String(call.body).includes('"stop"'))
    confirmed = false
    stop.props.onClick()
    await settle(panel)
    assert.equal(stopPosts().length, 0, 'a declined confirm must not stop anything')

    confirmed = true
    buttonWithText(panel, '停止').props.onClick()
    await settle(panel)
    assert.equal(stopPosts().length, 1, 'a confirmed stop is posted once')
    assert.ok(answers.includes('stop'))
  } finally {
    harnessConfirm = () => true
    network.restore()
  }
})

test('P2: an instance the user started is not offered a stop button', async () => {
  const { network, panel } = await mountWorkbench({
    environment: () => ({ environment: { state: 'ready', owned: false, pid: 9001, endpoint: 'http://127.0.0.1:8188' } }),
  })
  try {
    const stop = buttonWithText(panel, '停止')
    assert.ok(stop !== undefined, 'the button stays visible, so the absence of an action is explicit')
    assert.equal(stop.props.disabled, true, 'the plugin never offers to kill a process it cannot claim')
    assert.ok(noteText(panel).includes('由你自己启动的实例'), 'the reason is printed next to it')
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// U04 step 2: the interaction layer on the React Flow canvas.
//
// What can be driven here is the **wiring**, not the gesture: the pane's
// container is a host element, so its handlers can be called and the studio's
// reaction asserted through the tree. What cannot: pointer capture, React Flow's
// own drag, and the engine's `onInit` (it only runs in a measured container,
// which the DOM-less renderer never produces). Those stay on the manual list —
// see the note at the top of this file.
// ---------------------------------------------------------------------------

/** The flow canvas's container: the element that owns the keyboard. */
function flowContainer(panel) {
  const found = fakeElementWithClass(panel.tree, 'dsh-forge-flow')
  assert.ok(found !== undefined, 'the canvas tab must render the flow container')
  return found
}

/** The first host element with `className`, re-read after a re-render. */
function byClassNow(panel, className) {
  return fakeElementWithClass(panel.tree, className)
}

test('U04 S2: the flow canvas takes the canvas’ keyboard, and the studio acts on it', async () => {
  const mounted = await mountCanvasWorkbench()
  try {
    const container = flowContainer(mounted.panel)
    // §6.3: the canvas owns the shortcut table, so its container must be
    // focusable and must carry the studio's own handler — not a second table.
    assert.equal(container.props.tabIndex, 0, 'the canvas container must be focusable')
    assert.equal(typeof container.props.onKeyDown, 'function')
    assert.equal(typeof container.props.onKeyUp, 'function')
    // The same container carries the pointer gestures the marquee needs.
    for (const handler of ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel']) {
      assert.equal(typeof container.props[handler], 'function', `${handler} must be wired`)
    }

    // Nothing is selected on a fresh board: no alignment toolbar.
    assert.equal(byClassNow(mounted.panel, 'dsh-forge-align'), undefined)

    // Ctrl+A is the studio's `resolveShortcut` → select-all; the toolbar appears
    // because the multi-selection rule is "two or more" (§6.2).
    flowContainer(mounted.panel).props.onKeyDown(keyEvent('a', { ctrl: true }))
    await settle(mounted.panel)
    assert.ok(byClassNow(mounted.panel, 'dsh-forge-align') !== undefined, 'Ctrl+A must select the board')

    // Escape clears it (§6.3), and the toolbar goes away with the selection.
    flowContainer(mounted.panel).props.onKeyDown(keyEvent('Escape'))
    await settle(mounted.panel)
    assert.equal(byClassNow(mounted.panel, 'dsh-forge-align'), undefined, 'Escape must clear the selection')

    // The engine path is the same studio callback the fallback canvas drives, so
    // pressing a key there must also yield: a text field keeps its own keys.
    flowContainer(mounted.panel).props.onKeyDown(keyEvent('a', { ctrl: true }, { tagName: 'INPUT' }))
    await settle(mounted.panel)
    assert.equal(byClassNow(mounted.panel, 'dsh-forge-align'), undefined, 'inside an input the canvas yields')
  } finally {
    mounted.restoreFrames()
    mounted.network.restore()
  }
})

test('U04 S2: the flow container is the canvas box the overlays are positioned in', async () => {
  // The menu, the board picker and the lightbox are drawn by the studio and
  // positioned in screen coordinates. Step 2 puts the engine *inside* the old
  // canvas container, so those overlays keep one origin and one markup instead of
  // growing a second copy — this asserts the container is still rendered (the
  // overlays' positioning context) while the engine branch is taken.
  const mounted = await mountCanvasWorkbench()
  try {
    const canvasBox = canvasElement(mounted.panel)
    assert.ok(canvasBox !== undefined, 'the canvas container survives the engine swap')
    assert.ok(
      String(canvasBox.props.className).split(' ').includes('is-flow'),
      'and says which engine it holds',
    )
    // The container itself is no longer the keyboard owner when the engine is
    // mounted: two tab stops for one canvas would fight over focus.
    assert.equal(canvasBox.props.tabIndex, undefined)
    assert.equal(canvasBox.props.onPointerDown, undefined, 'the DOM gesture refs stay off with the engine mounted')
  } finally {
    mounted.restoreFrames()
    mounted.network.restore()
  }
})

test('U04 S2: the engine wiring ships in the artifact, one call per gesture', () => {
  // The engine's own handlers only run in a measured container, which this
  // harness cannot produce. What a Node process can still prove is that the
  // wiring is in the shipped bundle and points at the studio's callbacks: a
  // missing `onMoveNodes` would mean drags are painted and never saved.
  for (const marker of [
    'onMoveNodes: moveNodesFromGesture',
    'onContextMenu: openContextMenuFromEngine',
    'onCameraChange: adoptEngineCamera',
    'onApi: adoptEngineApi',
    'onKeyDown: onCanvasKeyDown',
  ]) {
    assert.ok(CLIENT_SOURCE.includes(marker), `${marker} must be in the canvas pane’s contract`)
  }
  // And the menu the pane opens is the §6.4 one the DOM canvas opens.
  assert.ok(CLIENT_SOURCE.includes('openContextMenuAt'), 'both engines must share one menu builder')
  // Drag write-back is one commit per gesture: the reducer is in the bundle.
  assert.ok(CLIENT_SOURCE.includes('foldDragChanges'), 'the drag reducer must ship')
})

// ---------------------------------------------------------------------------
// U04 step 3: the wire, from the studio's side.
//
// The gesture needs a browser (see the checklist at the top), and the engine's
// props only exist inside a measured container, which this harness never
// produces. What *is* provable here is the half that is this file's: the two
// callbacks the studio hands the engine, what each plan does, and — the promise
// the whole feature is judged on — that recording lineage cannot reach a
// generation route.
// ---------------------------------------------------------------------------

/**
 * The text of one `const name = useCallback(…)` block, up to its dependency list.
 *
 * The shipped bundle calls it as `(0, react.useCallback)(…)` (the bundler's
 * import-inlining form) and prints strings with double quotes, so the slice is
 * quoted back to the source spelling before any `includes` runs: what is being
 * asserted is the shape of the code, not the build's punctuation.
 */
function sourceBlock(name) {
  const start = CLIENT_SOURCE.indexOf(`const ${name} = `)
  assert.ok(start >= 0, `${name} must be a const in the shipped source`)
  const head = CLIENT_SOURCE.slice(start, start + 120)
  assert.ok(head.includes('useCallback'), `${name} must be wrapped in useCallback`)
  const end = CLIENT_SOURCE.indexOf('}, [', start)
  assert.ok(end > start, `${name} must close with a dependency array`)
  return CLIENT_SOURCE.slice(start, end).replace(/"/g, "'")
}

test('U04 S3: a released wire is executed by the studio, through one dispatcher', () => {
  // The contract between the engine and this file: the wire's start closes the
  // cards behind it, its release lands on `endEngineConnection`.
  assert.ok(CLIENT_SOURCE.includes('onConnectStart: beginEngineConnection'))
  assert.ok(CLIENT_SOURCE.includes('onConnectEnd: endEngineConnection'))

  const dispatch = sourceBlock('endEngineConnection')
  // The three outcomes, each on the callback the DOM canvas already uses.
  assert.ok(dispatch.includes("plan.kind === 'edge'"), 'the edge branch must exist')
  assert.ok(dispatch.includes('commitWireEdge(plan.sourceId, plan.toId)'), 'and go through the tested lineage writer')
  assert.ok(dispatch.includes("plan.kind === 'menu'"), 'the blank branch must exist')
  assert.ok(dispatch.includes('openWireMenu(plan.worldPoint, plan.sourceId, event.screen)'), 'at the release point, in container pixels')
  // The two refusals a user cannot see the reason for say why; the rest are silent.
  assert.ok(dispatch.includes("plan.reason === 'cycle'"))
  assert.ok(dispatch.includes("plan.reason === 'kind'"))

  // **The zero-generation guarantee.** Dragging a wire onto a picture records
  // lineage: no request of any kind is made by the dispatcher, and none by the
  // writer it calls. This is asserted on the shipped source because the branch
  // is a side effect, not a return value — a behavioural test would need the
  // engine's props, which no Node harness can reach.
  for (const forbidden of ['STUDIO_GENERATE_ROUTE', 'fetch(', 'postBoardRaw(', '/studio/generate']) {
    assert.ok(!dispatch.includes(forbidden), `a wire drop must never ${forbidden}`)
  }
  const lineage = sourceBlock('commitWireEdge')
  for (const forbidden of ['STUDIO_GENERATE_ROUTE', 'fetch(', 'postBoardRaw(', '/studio/generate']) {
    assert.ok(!lineage.includes(forbidden), `recording lineage must never ${forbidden}`)
  }
  // What it *does* do: one undo step and one debounced board write.
  assert.ok(lineage.includes("snapshotCommand('connect-edge'"))
  assert.ok(lineage.includes('markDirty([toId])'))
  assert.ok(lineage.includes('scheduleLayout()'))
})

test('U04 S3: the three menu entries are the three node kinds, each on its own writer', () => {
  const run = sourceBlock('runConnectTarget')
  // The mapping is by `ConnectTarget`, so the labels live in `connectMenuItems`
  // (`canvas-connections.test.mjs` pins their ids and order) and this switch
  // decides what each id builds.
  assert.ok(run.includes("target === 'image'"), '图片生成 must have its own branch')
  // U05 moved this one: the drop used to pre-fill the left form's reference row,
  // which the canvas tab no longer has. The picture now rides into the new draft
  // node's own reference list, which is exactly what the drawer shows.
  assert.ok(run.includes('referenceOf(source)'), 'the source picture becomes a reference')
  assert.ok(run.includes('{ references: [reference] }'), 'and the draft node is born holding it')
  assert.ok(run.includes('addDraftNode(open.world, open.sourceId'), 'at the release point, parented to the source')
  assert.ok(run.includes('pendingReplaceRef.current = { id: draft.id }'), 'the next generation lands in place')
  assert.ok(run.includes("target === 'layout'"), '布局 must have its own branch')
  assert.ok(run.includes('addLayoutNode({'), 'built immediately (a layout draft is cheap)')
  assert.ok(run.includes('spot: open.world'), 'at the release point')
  assert.ok(run.includes('parents: [open.sourceId]'), 'with the lineage it was dragged from')
  assert.ok(run.includes("setAssetPick("), '放入素材 grows the picker instead of building')
  // Building never generates: the draft is a promise, the layout is a draft, the
  // asset is a copy. A generation happens only when the user presses 生成.
  for (const forbidden of ['STUDIO_GENERATE_ROUTE', '/studio/generate', 'fetch(']) {
    assert.ok(!run.includes(forbidden), `choosing a node kind must never ${forbidden}`)
  }
  // The card that offers them is the shipped one, from the shipped data.
  assert.ok(CLIENT_SOURCE.includes('connectMenuItems()'), 'the card renders the data the unit tests pin')
  assert.ok(CLIENT_SOURCE.includes('data-connect-menu'), 'and keeps its addressable marker')
})

test('U04 S3: the pane’s side of the wire ships with a preview and a three-way planner', () => {
  // The engine's half: the drop is decided by the pure planner, not re-decided in
  // the renderer.
  assert.ok(CLIENT_SOURCE.includes('planConnectionDrop('), 'the pane must classify with the tested planner')
  assert.ok(CLIENT_SOURCE.includes('connectionNodesOf('), 'and hit-test against the painted boxes')
  // The preview, in container pixels, with the committed edge's cubic.
  assert.ok(CLIENT_SOURCE.includes('dsh-forge-flow-wire'))
  assert.ok(CLIENT_SOURCE.includes('data-connect-preview'))
  assert.ok(CLIENT_SOURCE.includes('previewPath('), 'the preview and the edge share one cubic')
  // Escape abandons the wire without building anything (the engine has no Esc).
  assert.ok(CLIENT_SOURCE.includes('onDocumentKeyDown'), 'the pane listens for the abandon key itself')
  assert.ok(CLIENT_SOURCE.includes('Escape'), 'Esc must cancel an in-flight wire')
  assert.ok(CLIENT_SOURCE.includes('escapedRef'), 'and the release that follows must be ignored')
  // Only pictures start a wire; every lineage target renders an inbound handle
  // so a wire-created task/draft keeps its edge drawable.
  assert.ok(CLIENT_SOURCE.includes('canStartConnection(props.kind)'))
  assert.ok(CLIENT_SOURCE.includes('hasInboundHandle(props.kind)'))
})

// ---------------------------------------------------------------------------
// U04 step 4: what a board opens at, 居中揭示, and the two node behaviours.
//
// The engine's half of each needs a measured container — `onInit`, `setCenter`,
// the rendered button list — which this harness cannot produce (see the note at
// the top of this file). What *is* provable here is the bridge: the props the
// studio hands the engine, the dispatcher `revealNodeId` became, and the fact that
// a task's buttons land on the studio callbacks that already own those actions.
// The decisions themselves — which viewport, which camera, which buttons — are
// pure, and asserted in `canvas-flow-model.test.mjs`.
// ---------------------------------------------------------------------------

test('U04 S4: a board reopens at the camera it stored instead of being framed again', () => {
  // The studio always knew the stored view (`board.camera`); the engine never
  // asked for it, so every reopen was a fresh fit. Two props carry it now.
  assert.ok(CLIENT_SOURCE.includes('initialCamera: boardView.camera'), 'the engine must be given the stored view')
  assert.ok(CLIENT_SOURCE.includes('boardLoaded: boardView.loaded'), 'and must wait until a read has finished')
  // What the pane does with them is the tested decision, not an unconditional fit.
  assert.ok(CLIENT_SOURCE.includes('flowViewportProps(initialView)'), 'one decision, spread onto the flow')
  assert.ok(CLIENT_SOURCE.includes('initialFlowView('), 'and the decision is the pure function')
  assert.equal(
    CLIENT_SOURCE.includes('fitViewOptions: { padding: 0.2, maxZoom: 1 }'),
    false,
    'the unconditional fit must be gone: the fit lives in the decision now',
  )

  // The stored camera comes from the board read, never from the live mirror — a
  // mirror that moves while the user pans cannot say where the board was left.
  const read = sourceBlock('openBoard')
  assert.ok(read.includes('setBoardView('), 'a board read must record the stored view')
  assert.ok(read.includes('board.camera'), 'from `board.camera` itself')
})

test('U04 S4: 居中揭示 moves the mounted engine’s viewport, and still falls back to the DOM camera', () => {
  const reveal = sourceBlock('revealNodeId')
  // The classification is the tested planner: which canvas, which point.
  assert.ok(reveal.includes('planReveal('), 'the reveal must be classified by the pure planner')
  assert.ok(reveal.includes("'flow'"), 'the engine branch must exist')
  assert.ok(reveal.includes('.reveal(plan.center, plan.zoom)'), 'and land on the engine handle')
  // The DOM fallback is unchanged: same centre, its own camera arithmetic.
  assert.ok(reveal.includes('centerOn('), 'the DOM canvas still gets its camera')
  assert.ok(reveal.includes('setCamera('), '…as a camera, not a viewport')
  // And the handle's implementation is a real camera move on the engine.
  assert.ok(CLIENT_SOURCE.includes('setCenter('), 'the engine must call React Flow’s setCenter')
  assert.ok(CLIENT_SOURCE.includes('reveal: (center, zoom)'), 'with the zoom the caller kept')
})

test('U04 S4: a task node’s buttons reach the studio callbacks that own them', () => {
  // The four actions the pure mapping can return, each onto the callback the DOM
  // canvas already drives. This is the bridge step 1b was missing: a button that
  // renders and does nothing.
  for (const [marker, label] of [
    ['onRetry: retryTask', '重试'],
    ['onEditParams: editTaskParams', '编辑参数'],
    ['onCancel: cancelTask', '取消'],
    ['onRemove: removeNode', '移除'],
  ]) {
    assert.ok(CLIENT_SOURCE.includes(marker), `${label} must be wired to the studio`)
  }
  // The pane's side: the set comes from the tested mapping, and every id it can
  // return has a handler path of its own.
  assert.ok(CLIENT_SOURCE.includes('taskNodeActions(status'), 'the buttons come from the pure mapping')
  assert.ok(CLIENT_SOURCE.includes('data-task-action'), 'and each is addressable in the DOM')
  for (const call of [
    'actions.onRetry?.(nodeId)',
    'actions.onEditParams?.(nodeId)',
    'actions.onCancel?.(nodeId)',
    'actions.onRemove?.(nodeId)',
  ]) {
    assert.ok(CLIENT_SOURCE.includes(call), call + ' must exist')
  }
  // Each one really is the existing studio action, not a second implementation.
  assert.ok(sourceBlock('retryTask').includes('startGeneration('), '重试 re-submits through the run path')
  // U05 moved this one: 编辑参数 used to refill the left form and leave a
  // `pendingReplaceRef` behind. The canvas no longer shows a form, so the
  // parameters stay on the node and the button switches the *drawer* to an editor
  // over that very snapshot — and 重新生成 goes through `retryTask`, which is the
  // path that already replaces the node in place (asserted on the line above).
  const edit = sourceBlock('editTaskParams')
  assert.ok(edit.includes('setTaskEditId('), '编辑参数 switches the drawer to that node')
  assert.ok(edit.includes('setSelection('), 'and selects it, so the drawer is showing it')
  assert.ok(!edit.includes('setPrompt('), 'it no longer writes into the list/asset form')
  assert.ok(sourceBlock('cancelTask').includes('.abort()'), '取消 aborts that run')
  // 移除 takes the entry off the board; it never deletes the file (that is the
  // separate, explicit delete path) — and it goes through the same local drop
  // every other removal uses, undo step included.
  const remove = sourceBlock('removeNodes')
  assert.ok(remove.includes("'remove-item'"), '移除 takes the entry off the board')
  assert.ok(remove.includes('dropNodesLocally('), 'through the shared local removal')
  assert.ok(remove.includes('deleteFile &&'), 'and only an explicit delete asks for the file')
})

test('U04 S4: a layout node saves its draft, and its box is the box its editor is mounted in', () => {
  // 编辑后保存: the editor's change is one coalesced undo step plus the debounced
  // `save-layout-node` write — which is what makes the draft survive a reload.
  const draft = sourceBlock('updateLayoutDraft')
  assert.ok(draft.includes('scheduleLayoutPersist(id)'), 'the edit must be persisted')
  assert.ok(draft.includes('snapshotCommand('), 'and undoable')
  assert.ok(draft.includes('layoutNodeHeight('), 'the node height follows the draft')
  assert.ok(draft.includes('clampLayoutNodeWidth('), 'and the width stays inside the band')
  assert.ok(CLIENT_SOURCE.includes('onDraft: updateLayoutDraft'), 'the embedded editor reports into it')
  // The node is the draft plus chrome: a 480×420 box leaves 320 px for a 1536×1024
  // draft, while the standalone editor needs ~690 px for its toolbar, caption rows,
  // hint and export box. So the node's host **scrolls** (nothing is clipped away)
  // and the one field a generation cannot do without — `summary.caption`, which T21
  // takes as the prompt — is a real input on the node itself.
  assert.ok(CLIENT_SOURCE.includes('dsh-forge-flow-layout-caption-input'), 'the caption is an input on the node')
  assert.ok(CLIENT_SOURCE.includes('onLayoutCaption'), 'and it writes through the draft path')
  assert.ok(/dsh-forge-flow-layout-host.{0,80}overflow:auto/.test(CLIENT_SOURCE) || CLIENT_SOURCE.includes('dsh-forge-flow-layout-host{position:absolute;inset:0;overflow:auto'), 'the node host scrolls instead of clipping the editor fields')

  // 尺寸与 zoom 来源: the editor measures its own box with `getBoundingClientRect`
  // *inside* the zoomed viewport, so the zoom is already in that measurement and
  // `pointerScale` must stay at its default of 1 in both renderers — passing it
  // would apply the canvas zoom twice. Nothing shipped may set the hook.
  assert.equal(CLIENT_SOURCE.includes('pointerScale:'), false, 'the canvas must not double-apply the engine zoom')
  // And the one zoom a node publishes for its screen-sized affordances is the
  // engine's own transform, not a second copy of the camera.
  assert.ok(CLIENT_SOURCE.includes('state.transform[2]'), 'a node’s screen size reads the engine zoom')
})

test('U04 S4: a progress tick reuses every node it did not change', () => {
  // Step 2's reseed was fine until the stream arrived: the model is rebuilt per
  // frame, so the array handed to the engine was all-new objects and the whole
  // board repainted once per step. The fix has to be in the shipped pane; the
  // behaviour itself is asserted in `canvas-flow-model.test.mjs`.
  assert.ok(CLIENT_SOURCE.includes('reuseFlowNodes('), 'the pane must reuse unchanged nodes')
  assert.ok(CLIENT_SOURCE.includes('seedRef'), 'against what it handed out last time')
  // And the action bundle is one stable object, or nothing could ever be reused:
  // a fresh closure per render makes every node look changed.
  const actionsAt = CLIENT_SOURCE.indexOf('const actions = ')
  assert.ok(actionsAt > 0, 'the pane must build one action bundle')
  const declaration = CLIENT_SOURCE.slice(actionsAt, actionsAt + 1600)
  assert.ok(declaration.startsWith('const actions = (0, react.useMemo)'), 'built once, not per render')
  assert.ok(declaration.includes('}), []);'), 'with no dependencies, so its identity never changes')
})

// ---------------------------------------------------------------------------
// U05: the node property drawer.
//
// The product decision this encodes: the canvas tab has **no left form**. A node
// is selected, and the drawer on the right is its properties; a draft node is the
// thing you type into before generating, and it carries its own parameters so two
// drafts can be described at once.
//
// What is provable here: the drawer's decisions are pure (`inspectorSpecFor` and
// the value→body mapping, imported from source), and the wiring is host elements
// — the toolbar button, the drawer's inputs, its 生成 — so the whole path
// "新建生成 → 填参数 → 生成 → 请求体" runs through the real bundle. What is not:
// the look of the 320 px column and the narrow-panel overlay, which are CSS and
// stay on the manual list.
// ---------------------------------------------------------------------------

/** An empty board: U05's first-run path starts with nothing on the canvas. */
const U05_BOARD = { id: 'cbrdu05', name: '抽屉测试板', camera: { x: 0, y: 0, zoom: 1 }, items: [] }

/** The drawer (or the empty-hint box that stands in for it). */
function inspectorElement(panel) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found !== undefined) return
    if (typeof entry.props.className !== 'string') return
    if (entry.props.className.split(' ')[0] === 'dsh-forge-inspector') found = entry
  })
  return found
}

/** One drawer input by its field id (`prompt`, `steps`, `count`, `seed`). */
function inspectorInput(panel, id) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found === undefined && entry.props['data-inspector-input'] === id) found = entry
  })
  return found
}

/** One drawer button by its action id. */
function inspectorAction(panel, id) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found === undefined && entry.type === 'button' && entry.props['data-inspector-action'] === id) found = entry
  })
  return found
}

/** One ratio button of the drawer's picker. */
function inspectorRatioButton(panel, ratio) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found === undefined && entry.props['data-inspector-ratio'] === ratio) found = entry
  })
  return found
}

test('U05: the drawer is about exactly one node, or nobody', () => {
  assert.equal(inspectorVisible(new Set()), false, 'nothing selected is no drawer')
  assert.equal(inspectorVisible(new Set(['a'])), true)
  assert.equal(
    inspectorVisible(new Set(['a', 'b'])),
    false,
    'a multi-selection is the align toolbar’s job — one drawer would lie about its subject',
  )
  const nodes = [{ id: 'a', kind: 'draft' }, { id: 'b', kind: 'image' }]
  assert.deepEqual(inspectorTargetOf(nodes, new Set(['b'])), { id: 'b', kind: 'image' })
  assert.equal(inspectorTargetOf(nodes, new Set(['gone'])), undefined, 'a removed id resolves to nothing')
  assert.equal(inspectorTargetOf(nodes, new Set(['a', 'b'])), undefined)
})

test('U05: the field set and the buttons follow the node kind', () => {
  // A draft is the editable one: the five parameters, its own reference list, and
  // 生成 as the primary action.
  const draft = inspectorSpecFor({ kind: 'draft', id: 'd1', parents: [], params: { prompt: '', ratio: '1:1' } })
  assert.deepEqual(draft.fields.map((field) => field.id), ['prompt', 'ratio', 'steps', 'count', 'seed'])
  assert.ok(draft.fields.every((field) => field.editable), 'every parameter of a draft is editable')
  assert.equal(draft.canEditReferences, true, 'a draft holds its own reference row')
  assert.deepEqual(draft.actions.map((action) => action.id), ['generate', 'remove'])
  assert.equal(draft.actions[0].disabled, true, 'an empty prompt keeps 生成 grey')

  const ready = inspectorSpecFor({ kind: 'draft', id: 'd2', parents: [], params: { prompt: '猫', ratio: '1:1' } })
  assert.equal(ready.actions[0].disabled, false, 'a written prompt enables it')
  assert.ok(String(ready.status).includes('生成'), 'and the status line says what to do next')

  // A picture: every field is history, so none of them is an input.
  const image = inspectorSpecFor(
    { kind: 'image', id: 'i1', parents: ['p1'], image: { markdownPath: 'C:/out/a.png', path: 'C:/out/a.png', width: 1248, height: 1248, bytes: 2048 } },
    { item: { prompt: '一只橘猫坐在窗台上\n第二行不该出现', steps: 8, seed: 7, ratio: '1:1' }, model: 'qwen_image_2.1.safetensors' },
  )
  const fieldOf = (spec, id) => spec.fields.find((field) => field.id === id)
  assert.equal(image.fields.every((field) => !field.editable), true, 'a picture’s parameters are not editable')
  assert.equal(fieldOf(image, 'prompt').value, '一只橘猫坐在窗台上', 'the first line is the title')
  assert.equal(fieldOf(image, 'steps').value, '8')
  assert.equal(fieldOf(image, 'seed').value, '7')
  assert.equal(fieldOf(image, 'model').value, 'qwen_image_2.1.safetensors', '底模 is profile-level, shown read-only')
  assert.equal(fieldOf(image, 'size').value, '1248×1248')
  assert.deepEqual(image.lineage, ['p1'], 'where it grew from')
  // U06: 打开详情 sits between "look at it" and "remove" — every persisted node
  // kind has a detail tab now (§8.2), so the picture offers the same entry.
  assert.deepEqual(image.actions.map((action) => action.id), ['continue', 'open', 'open-detail', 'remove'])
  assert.notEqual(image.actions[2].disabled, true, 'U06’s node detail tab is reachable from a picture')

  // A task: the canvas's own status→buttons mapping, plus 重新生成 in edit mode.
  const task = inspectorSpecFor({ kind: 'task', id: 't1', status: 'failed', params: { prompt: '猫' }, error: 'CUDA out of memory' })
  assert.deepEqual(task.actions.map((action) => action.id), ['retry', 'edit', 'open-detail', 'remove'])
  assert.equal(fieldOf(task, 'error').value, 'CUDA out of memory', 'the reason is the point of the node')
  const editing = inspectorSpecFor(
    { kind: 'task', id: 't1', status: 'failed', params: { prompt: '猫' }, error: 'x' },
    { editing: true },
  )
  assert.deepEqual(editing.actions.map((action) => action.id), ['generate', 'retry', 'edit', 'open-detail', 'remove'])
  assert.equal(editing.fields.every((field) => field.editable), true, '编辑参数 makes the snapshot an editor')
  const running = inspectorSpecFor({ kind: 'task', id: 't2', status: 'running', params: { prompt: '猫' }, progress: { percent: 40 } })
  assert.deepEqual(
    running.actions.map((action) => action.id),
    ['cancel', 'open-detail', 'remove'],
    'a live run can be interrupted — and still has a detail tab, which is where its parameters are',
  )

  // A layout: generate, the U06 entry, remove.
  const layout = inspectorSpecFor({
    kind: 'layout',
    id: 'l1',
    parents: [],
    draft: { width: 1536, height: 1024, items: [{}, {}] },
  })
  assert.ok(String(layout.status).includes('2 个画框'))
  assert.equal(fieldOf(layout, 'ratio').value, '3:2', 'a 1536×1024 draft maps onto the 3:2 tier')
  assert.deepEqual(layout.actions.map((action) => action.id), ['layout-generate', 'open-detail', 'remove'])
  assert.notEqual(layout.actions[1].disabled, true, 'U06 landed: the detail entry is a real button')
  assert.match(layout.actions[1].title, /详情页签/, 'and it says what it opens')
  // Off the ladder, the drawer says so instead of silently stretching (§8.4).
  const skewed = inspectorSpecFor({ kind: 'layout', id: 'l2', draft: { width: 1000, height: 700, items: [] } })
  assert.ok(String(fieldOf(skewed, 'ratio').value).includes('无法生成'), 'a 10:7 draft is not an official tier')
})

test('U05: one field edit maps onto the numbers the host validates', () => {
  const base = { prompt: '猫', ratio: '1:1', steps: 8, count: 1, seed: 4 }
  assert.equal(patchDraftParams(base, 'steps', '12').steps, 12)
  assert.equal('steps' in patchDraftParams(base, 'steps', ''), false, 'blank means "use the config default"')
  assert.equal('seed' in patchDraftParams(base, 'seed', '   '), false)
  assert.equal(patchDraftParams(base, 'seed', '0').seed, 0, '0 is a seed, not a blank')
  assert.equal(patchDraftParams(base, 'count', '99').count, STUDIO_MAX_COUNT, 'the count is clamped')
  assert.equal(patchDraftParams(base, 'count', '0').count, 1)
  assert.equal(patchDraftParams(base, 'steps', '9999').steps, INSPECTOR_MAX_STEPS, 'the step ceiling is the form’s')
  assert.equal(patchDraftParams(base, 'seed', '99999999999999').seed, INSPECTOR_MAX_SEED)
  assert.equal('steps' in patchDraftParams(base, 'steps', 'nope'), false, 'garbage is a blank, never a NaN')
  assert.equal(patchDraftParams(base, 'ratio', '5:4').ratio, '1:1', 'an unknown ratio falls back to 1:1')
  assert.equal(inspectorRatio('16:9'), '16:9')
  assert.equal(
    patchDraftParams(base, 'prompt', 'x'.repeat(STUDIO_MAX_PROMPT_CHARS + 50)).prompt.length,
    STUDIO_MAX_PROMPT_CHARS,
  )
  assert.equal(patchDraftParams(base, 'nope', 'x'), base, 'an unknown field never rewrites the snapshot')
  // The assembler is the same mapping, from the drawer's string inputs.
  assert.deepEqual(inspectorValuesOf({ kind: 'task', params: { prompt: '猫', steps: 8, count: 2, seed: 0 } }), {
    prompt: '猫', ratio: '1:1', steps: '8', count: '2', seed: '0',
  })
  assert.deepEqual(inspectorValuesOf(undefined), EMPTY_DRAFT_VALUES)
})

test('U05: the drawer’s values are the generate body, key for key', () => {
  const values = { prompt: '  一只橘猫坐在窗台上  ', ratio: '16:9', steps: '12', count: '2', seed: '7' }
  assert.deepEqual(generateParamsBody(draftParamsOf(values)), {
    prompt: '一只橘猫坐在窗台上',
    ratio: '16:9',
    count: 2,
    steps: 12,
    seed: 7,
  })
  // Omitted keys stay absent: the host reads a blank step count as "the profile's
  // default" and reports the seed it actually drew with.
  assert.deepEqual(generateParamsBody(draftParamsOf({ ...EMPTY_DRAFT_VALUES, prompt: '猫' })), {
    prompt: '猫', ratio: '1:1', count: 1,
  })
  // A layout-derived task keeps its conditioning text through an edit.
  assert.equal(generateParamsBody({ prompt: '猫', layout: '{"a":1}' }).layout, '{"a":1}')

  assert.equal(canGenerateFromDrawer({ ...EMPTY_DRAFT_VALUES, prompt: '   ' }, 0), false)
  assert.equal(canGenerateFromDrawer({ ...EMPTY_DRAFT_VALUES, prompt: '猫' }, 0), true)
  assert.equal(canGenerateFromDrawer({ ...EMPTY_DRAFT_VALUES, prompt: '猫' }, 11), false, 'over the reference cap')
})

test('U05: the canvas tab has no left form, and the drawer stands in for it', async () => {
  const { network, panel } = await mountWorkbench({ board: U05_BOARD })
  try {
    // §U05-1: the form is *gone* from this view, not hidden by CSS. Its textarea
    // has a different class too, so a selector cannot accidentally match.
    assert.equal(byClassNow(panel, 'dsh-forge-studio-form'), undefined, 'the canvas tab has no left form')
    assert.equal(byClassNow(panel, 'dsh-forge-textarea'), undefined, 'and no prompt box of its own')
    assert.ok(byClassNow(panel, 'dsh-forge-canvas-shell') !== undefined, 'the canvas keeps its box')
    const drawer = inspectorElement(panel)
    assert.ok(drawer !== undefined, 'the drawer is a standing part of the canvas tab')
    assert.ok(drawer.props.className.split(' ').includes('is-empty'), 'with nothing selected it is only the hint')
    assert.ok(fakeText(drawer).includes(INSPECTOR_EMPTY_HINT), 'and the hint says what to do')

    // §U05-2: the other two views are untouched — they still own the old form.
    buttonWithText(panel, '列表').props.onClick()
    await settle(panel)
    assert.ok(byClassNow(panel, 'dsh-forge-studio-form') !== undefined, '列表 keeps the form')
    assert.ok(byClassNow(panel, 'dsh-forge-textarea') !== undefined)
    assert.equal(inspectorElement(panel), undefined, 'and the drawer belongs to the canvas tab alone')
  } finally {
    network.restore()
  }
})

test('U05: 新建生成 → draw in the drawer → 生成 sends exactly those values', async () => {
  const requests = []
  const { network, panel } = await mountWorkbench({
    board: U05_BOARD,
    generate: (init) => {
      requests.push(JSON.parse(init.body))
      return fakeResponse(generateResult([resultImage('u05i1')]))
    },
  })
  try {
    buttonWithText(panel, '新建生成').props.onClick()
    await settle(panel)
    assert.equal(inspectorElement(panel).props['data-inspector-kind'], 'draft', 'the new node is the subject')
    assert.equal(inspectorAction(panel, 'generate').props.disabled, true, 'an empty prompt cannot be submitted')

    inspectorInput(panel, 'prompt').props.onChange({ target: { value: '一只橘猫坐在窗台上' } })
    await settle(panel)
    inspectorRatioButton(panel, '16:9').props.onClick()
    await settle(panel)
    inspectorInput(panel, 'steps').props.onChange({ target: { value: '12' } })
    inspectorInput(panel, 'count').props.onChange({ target: { value: '2' } })
    inspectorInput(panel, 'seed').props.onChange({ target: { value: '7' } })
    await settle(panel)
    // The edits are on the node, not in a panel buffer: the inputs read back.
    assert.equal(inspectorInput(panel, 'steps').props.value, '12')
    assert.equal(inspectorInput(panel, 'count').props.value, '2')
    assert.equal(inspectorInput(panel, 'seed').props.value, '7')
    assert.equal(
      inspectorRatioButton(panel, '16:9').props.className.split(' ').includes('is-active'),
      true,
      'the chosen ratio is the active one',
    )

    assert.equal(inspectorAction(panel, 'generate').props.disabled, false)
    inspectorAction(panel, 'generate').props.onClick()
    await settle(panel)

    assert.equal(requests.length, 1, 'exactly one submission')
    const body = requests[0]
    assert.equal(body.prompt, '一只橘猫坐在窗台上')
    assert.equal(body.ratio, '16:9')
    assert.equal(body.steps, 12)
    assert.equal(body.count, 2)
    assert.equal(body.seed, 7)
    assert.equal(body.references, undefined, 'no reference list means a text-to-image run')
    assert.equal(body.parents, undefined, 'a node with no source has no lineage')
    assert.equal(body.board, U05_BOARD.id)
    assert.match(body.clientId, /^c[0-9a-z]+$/, 'the canvas id rides along so the stream can find it')

    // The draft became the picture in place (the §4.5 replace channel), and the
    // drawer followed the selection onto the result.
    assert.equal(inspectorElement(panel).props['data-inspector-kind'], 'image')
  } finally {
    network.restore()
  }
})

test('U05: a multi-selection puts the drawer away again', async () => {
  const mounted = await mountCanvasWorkbench()
  try {
    flowContainer(mounted.panel).props.onKeyDown(keyEvent('a', { ctrl: true }))
    await settle(mounted.panel)
    const drawer = inspectorElement(mounted.panel)
    assert.ok(drawer !== undefined, 'the drawer slot stays')
    assert.ok(
      drawer.props.className.split(' ').includes('is-empty'),
      'but three selected nodes are not one node’s properties',
    )
  } finally {
    mounted.restoreFrames()
    mounted.network.restore()
  }
})

test('U05: the drawer’s wiring ships — its edits land on the node, not on a form', () => {
  assert.ok(CLIENT_SOURCE.includes('inspectorSpecFor('), 'the drawer renders the tested spec')
  assert.ok(CLIENT_SOURCE.includes('data-inspector-action'), 'its buttons are addressable')
  assert.ok(CLIENT_SOURCE.includes('data-inspector-input'), 'and so are its inputs')
  // The one editor: a field edit goes through the tested mapping and onto the node.
  const patch = sourceBlock('patchInspectorField')
  assert.ok(patch.includes('patchDraftParams('), 'a field edit uses the tested mapping')
  assert.ok(patch.includes('writeNodes('), 'and lands on the node list')
  assert.ok(!patch.includes('setPrompt('), 'never on the list/asset form')
  // The one submit: values → params → body, replacing the draft in place.
  const submit = sourceBlock('generateDraftNode')
  assert.ok(submit.includes('draftParamsOf('), 'the request is assembled from the node’s values')
  assert.ok(submit.includes('replaceId: node.id'), 'and replaces the draft in place')
  assert.ok(submit.includes('canGenerateFromDrawer('), 'with the same emptiness rule the button uses')
  // The wire body itself is the drawer's builder — one mapping, not two.
  assert.ok(sourceBlock('startGeneration').includes('...generateParamsBody(params)'))
})

// ---------------------------------------------------------------------------
// U06: the node detail tab (§8.2, §8.4).
//
// The product decision: **simple controls live on the canvas, complex ones get
// their own panel tab.** The MOSS layout is the case that forced it — its editor
// needs the width of a tab, and a canvas node is 480 world units.
//
// What is provable here: every decision the pane makes is pure (kinds, titles,
// the draft's readout and its MOSS request, the save body, the undo stack, the
// preview, the intent), and the wiring around it is host markup — 打开详情 in the
// drawer, the detail tab's toolbar, 生成 going back through the canvas. What is
// not: the *canvas side* of the single-editor rule (the thumbnail instead of the
// editor), because React Flow needs a measured container this renderer has no
// DOM for. That half is `layoutEditorOwner` here, the shipped-source check at the
// bottom, and the U06 manual checklist at the top of this file.
// ---------------------------------------------------------------------------

/** A two-box, 3:2 draft: the ladder's own tier, so it can generate. */
const U06_DRAFT = {
  width: 1536,
  height: 1024,
  bbox_coord_space: 'abs',
  bbox_format: 'xyxy',
  summary: { caption: '三栏海报：左边一只橘猫，右边标题' },
  items: [
    { label: 'object', caption: '左边的橘猫', bbox: [0, 0, 512, 1024] },
    { label: 'text', caption: '右边的标题', text: '右边的标题', bbox: [1024, 0, 1536, 400] },
  ],
}

/** A board whose only node is that layout — one node, so Ctrl+A is single select. */
const U06_LAYOUT_BOARD = {
  id: 'cbrdu06',
  name: '详情页签板',
  camera: { x: 0, y: 0, zoom: 1 },
  items: [{ id: 'ilayout1', kind: 'layout', x: 120, y: 60, parents: [], w: 480, draft: U06_DRAFT }],
}

/** The same board with one picture on it, for the image detail view. */
const U06_IMAGE_BOARD = {
  id: 'cbrdu06i',
  name: '大图板',
  camera: { x: 0, y: 0, zoom: 1 },
  items: [{
    ...HARNESS_BOARD.items[0],
    id: 'iimg1',
    path: 'C:/out/iimg1.png',
    markdownPath: 'C:/out/iimg1.png',
    prompt: '一只橘猫坐在窗台上\n第二行不是标题',
    createdAt: '2026-11-18T09:05:00.000Z',
    parents: [],
  }],
}

/** And one with a failed task node, for the task detail view. */
const U06_TASK_BOARD = {
  id: 'cbrdu06t',
  name: '任务板',
  camera: { x: 0, y: 0, zoom: 1 },
  items: [{
    id: 'itask1',
    kind: 'task',
    x: 0,
    y: 0,
    parents: [],
    task: {
      status: 'failed',
      params: { prompt: '一只橘猫', ratio: '16:9', steps: 8, count: 2, seed: 7, layout: '{"bboxes":[]}' },
      error: 'CUDA out of memory',
    },
  }],
}

/** Click the drawer's 打开详情 for whatever is selected. */
async function openDetailOf(panel) {
  const button = inspectorAction(panel, 'open-detail')
  assert.ok(button !== undefined, 'the drawer must offer 打开详情')
  assert.notEqual(button.props.disabled, true, 'and it must be enabled')
  button.props.onClick()
  await settle(panel)
}

/** One row of the detail pane, by its field id. */
function detailField(panel, id) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found === undefined && entry.props['data-detail-field'] === id) found = entry
  })
  return found === undefined ? '' : fakeText(found)
}

/** One button of the detail pane's toolbar, by its action id. */
function detailAction(panel, action) {
  let found
  fakeVisit(panel.tree, (entry) => {
    if (found === undefined && entry.type === 'button' && entry.props['data-detail-action'] === action) found = entry
  })
  return found
}

/** The detail pane itself (its class list carries the view as a second class). */
function detailPane(panel) {
  return findAll(panel.tree, (element) => {
    const value = element.props.className
    return typeof value === 'string' && value.split(' ')[0] === 'dsh-forge-detail'
  })[0]
}

/** The key of the selected tab on the strip (`aria-selected`). */
function selectedTabKey(panel) {
  const selected = findAll(panel.tree, (element) => element.props.role === 'tab' && element.props['aria-selected'] === true)[0]
  return selected === undefined ? undefined : selected.props['data-tab-key']
}

/**
 * One `function name(…) { … }` block of the shipped bundle.
 *
 * `sourceBlock` above only understands the studio's `const x = useCallback(…)`
 * shape; a component or a plain helper is not that. Braces are counted with
 * string and template literals skipped, so the slice ends at the function's own
 * closing brace rather than at the first `}` it meets.
 */
function functionBlock(name) {
  const start = CLIENT_SOURCE.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} must be a function in the shipped source`)
  let depth = 0
  let quote = ''
  for (let index = start; index < CLIENT_SOURCE.length; index += 1) {
    const char = CLIENT_SOURCE[index]
    if (quote !== '') {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return CLIENT_SOURCE.slice(start, index + 1).replace(/"/g, "'")
    }
  }
  assert.fail(`${name} must close at the top level`)
}

test('U06: a node kind has one detail view, and a tab is named from its data', () => {
  // Three kinds, three views (§8.2); anything else has none.
  for (const kind of ['layout', 'image', 'task']) assert.equal(detailViewOf(kind), kind)
  for (const bad of ['draft', '', 'LAYOUT', undefined, null, 7]) assert.equal(detailViewOf(bad), 'unknown')
  assert.equal(detailKindOfNodeKind('layout'), 'layout')
  assert.equal(detailKindOfNodeKind('draft'), undefined, 'a draft node is not a board item yet')
  assert.equal(detailKindOfNodeKind('nope'), undefined)

  // §8.2's titles, each from the data that names it.
  assert.equal(nodeDetailTitle('layout', { boardName: '橘猫计划' }), '布局 · 橘猫计划')
  assert.equal(
    nodeDetailTitle('task', { boardName: '橘猫计划', prompt: '一只橘猫坐在窗台上\n第二行不是标题' }),
    '任务 · 一只橘猫坐在窗台上',
    'a task is named by the first line of its prompt',
  )
  assert.equal(
    nodeDetailTitle('image', { boardName: '橘猫计划', createdAt: '2026-11-18T09:05:11.000Z' }),
    '图片 · 09:05',
    'a picture is named by when it was made',
  )
  // Degrades instead of going blank, and the parts it lacks are not invented.
  assert.equal(nodeDetailTitle('layout'), '布局 · 未命名项目')
  assert.equal(nodeDetailTitle('task', { boardName: '板子' }), '任务 · 板子', 'no prompt yet, so the project names it')
  assert.equal(nodeDetailTitle('image', { boardName: '板子', createdAt: 'nope' }), '图片 · 板子')
  assert.deepEqual(NODE_DETAIL_KIND_LABELS, { layout: '布局', task: '任务', image: '图片' })

  // Clipping and the clock are string operations: no zone, no locale.
  assert.equal(shortSubject('  一只猫  '), '一只猫')
  assert.equal(shortSubject('一'.repeat(NODE_DETAIL_TITLE_MAX + 5)).endsWith('…'), true)
  assert.equal(shortSubject(null), '')
  assert.equal(clockOf('2026-11-18T09:05:00.000Z'), '09:05')
  assert.equal(clockOf('2026-11-18'), undefined)
  assert.equal(clockOf(12), undefined)
})

test('U06: one editor per node — the strip decides, the registry is the second guard', () => {
  // The tab strip is the input: whichever pane is on screen, an open detail tab
  // means the canvas may not mount that node's editor (§8.4).
  const tabs = [
    { key: 'projects', kind: 'projects', orphaned: false },
    { key: 'canvas:b1', kind: 'canvas', boardId: 'b1', orphaned: false },
    { key: 'node:b1:l1', kind: 'node', boardId: 'b1', itemId: 'l1', detailKind: 'layout', orphaned: false },
    { key: 'node:b1:i1', kind: 'node', boardId: 'b1', itemId: 'i1', detailKind: 'image', orphaned: false },
    { key: 'node:b2:l9', kind: 'node', boardId: 'b2', itemId: 'l9', detailKind: 'layout', orphaned: true },
  ]
  const open = openDetailItemIds(tabs, 'b1')
  assert.deepEqual([...open].sort(), ['i1', 'l1'], 'only this board’s nodes are locked')
  assert.equal(openDetailItemIds(tabs, 'b2').has('l9'), true, 'an orphaned tab still owns its node')
  assert.equal(openDetailItemIds(tabs, 'b9').size, 0)
  assert.equal(layoutEditorOwner('l1', open), 'detail')
  assert.equal(layoutEditorOwner('l2', open), 'canvas', 'no detail tab, so the canvas edits it')
  assert.equal(layoutEditorOwner('l1', undefined), 'canvas')
  assert.equal(layoutEditorOwner('', open), 'canvas', 'an empty id is never an editor')

  // The instant-level guard: the same node cannot be mounted twice in one page.
  const claims = new DetailEditorClaims()
  assert.equal(claims.claim('b1:l1'), true)
  assert.equal(claims.claim('b1:l1'), false, 'a second mount of the same node is refused')
  assert.equal(claims.size, 1)
  assert.equal(claims.has('b1:l1'), true)
  claims.release('b1:l1')
  assert.equal(claims.has('b1:l1'), false)
  assert.equal(claims.claim('b1:l1'), true, 'closing the tab gives the node back')
  assert.equal(claims.claim(''), false, 'an empty key is never claimable')
  claims.release('never-claimed')
  assert.equal(claims.size, 1)
})

test('U06: a draft is read out, and becomes the MOSS request or a stated refusal', () => {
  const summary = layoutDetailSummary(U06_DRAFT)
  assert.equal(summary.size, '1536×1024')
  assert.equal(summary.boxes, 2)
  assert.equal(summary.ratio, '3:2', 'the draft maps onto an official tier')
  assert.equal(summary.mappable, true)
  assert.equal(layoutDetailSummary(undefined).mappable, false)
  // Off the ladder, the readout says so rather than pretending a tier.
  const skewed = layoutDetailSummary({ ...U06_DRAFT, width: 1000, height: 700 })
  assert.equal(skewed.mappable, false)

  const plan = layoutGeneratePlan(U06_DRAFT)
  assert.equal(plan.ok, true, 'a drawn, captioned, on-ladder draft can generate')
  assert.equal(plan.params.prompt, U06_DRAFT.summary.caption, 'the whole-image caption is the prompt')
  assert.equal(plan.params.ratio, '3:2')
  assert.equal(plan.params.count, 1)
  assert.equal(typeof plan.params.layout, 'string', 'the compiled layout is the conditioning text')
  assert.ok(plan.params.layout.includes('abs_centralized'), 'and it is the compiled form, not the draft')
  assert.ok(plan.params.layout.includes('yxyx'))

  // Every refusal names the one thing to fix — the same words the canvas shows.
  const noBoxes = layoutGeneratePlan({ ...U06_DRAFT, items: [] })
  assert.equal(noBoxes.ok, false)
  assert.match(noBoxes.reason, /画框/)
  const noCaption = layoutGeneratePlan({ ...U06_DRAFT, summary: { caption: '   ' } })
  assert.equal(noCaption.ok, false)
  assert.match(noCaption.reason, /summary\.caption/)
  const stretched = layoutGeneratePlan({
    width: 1024,
    height: 640,
    bbox_coord_space: 'abs',
    bbox_format: 'xyxy',
    summary: { caption: '一张 16:10 的板子' },
    items: [{ label: 'object', caption: '整块', bbox: [0, 0, 512, 640] }],
  })
  assert.equal(stretched.ok, false)
  assert.match(stretched.reason, /不在官方七档内/, 'a 16:10 draft is refused, never silently stretched')
  const broken = layoutGeneratePlan({ width: 0, height: 0, items: [{ label: 'object', caption: 'x', bbox: [0, 0, 0, 0] }], summary: { caption: 'x' } })
  assert.equal(broken.ok, false)
  assert.equal(layoutGeneratePlan(undefined).ok, false)

  // One decision for two containers: the canvas node's 生成 uses this function,
  // so the detail tab cannot submit something the canvas would have refused.
  const canvasGenerate = sourceBlock('generateLayoutNode')
  assert.ok(canvasGenerate.includes('layoutGeneratePlan('), 'the canvas generates through the same plan')
  assert.ok(!canvasGenerate.includes('fitStudioRatio('), 'and does not re-derive the ratio on its own')
})

test('U06: a draft write keeps the node’s place and follows the draft’s proportion', () => {
  const write = layoutWriteOf({ x: 120, y: 60, w: 480 }, U06_DRAFT)
  assert.equal(write.x, 120)
  assert.equal(write.y, 60)
  assert.equal(write.w, 480, 'the display width is the node’s own decision')
  assert.equal(write.h, 420, '100 px chrome + 480 × (1024/1536)')
  // The width is clamped to the editor's own range, and a missing item still
  // produces a legal body (a hand-written board entry can lack x/y/w).
  assert.equal(layoutWriteOf({ x: 0, y: 0, w: 10 }, U06_DRAFT).w, 320)
  assert.equal(layoutWriteOf({ x: 0, y: 0, w: 5000 }, U06_DRAFT).w, 960)
  const bare = layoutWriteOf(undefined, U06_DRAFT)
  assert.equal(bare.x, 0)
  assert.equal(bare.y, 0)
  assert.equal(bare.w, 480, 'the default canvas-node width')
  assert.equal(bare.draft, U06_DRAFT)
})

test('U06: undo walks the pane’s own drafts back, bounded', () => {
  const first = { ...U06_DRAFT, summary: { caption: '第一版' } }
  const second = { ...U06_DRAFT, summary: { caption: '第二版' } }
  let history = EMPTY_DRAFT_HISTORY
  assert.equal(undoDraftHistory(history).draft, undefined, 'nothing to undo on a fresh pane')
  history = pushDraftHistory(history, first)
  history = pushDraftHistory(history, second)
  const step = undoDraftHistory(history)
  assert.equal(step.draft, second, 'the newest recorded draft comes back first')
  assert.equal(step.history.entries.length, 1)
  assert.equal(undoDraftHistory(step.history).draft, first)
  assert.equal(undoDraftHistory(undoDraftHistory(step.history).history).draft, undefined)
  // Bounded: a long editing session cannot grow the stack without limit.
  let bounded = EMPTY_DRAFT_HISTORY
  for (let index = 0; index < 6; index += 1) bounded = pushDraftHistory(bounded, { ...U06_DRAFT, width: 1536 + index * 16 }, 3)
  assert.equal(bounded.entries.length, 3)
  assert.equal(bounded.entries[2].width, 1536 + 5 * 16, 'the newest survive')
})

test('U06: the canvas thumbnail is the draft drawn as percentages', () => {
  const boxes = draftPreviewBoxes(U06_DRAFT)
  assert.equal(boxes.length, 2)
  assert.deepEqual(boxes[0], { left: 0, top: 0, width: (512 / 1536) * 100, height: 100 })
  assert.deepEqual(boxes[1], {
    left: (1024 / 1536) * 100,
    top: 0,
    // The right edge is the one clamped, so the span is derived from 100.
    width: 100 - (1024 / 1536) * 100,
    height: (400 / 1024) * 100,
  })
  // Degenerate input is dropped, never painted outside the node.
  assert.deepEqual(draftPreviewBoxes(undefined), [])
  assert.deepEqual(draftPreviewBoxes({ ...U06_DRAFT, width: 0 }), [])
  const odd = draftPreviewBoxes({
    ...U06_DRAFT,
    items: [
      { label: 'object', caption: 'x', bbox: [10, 10, 10, 400] },
      { label: 'object', caption: 'x', bbox: [-200, -200, 100, 100] },
      { label: 'object', caption: 'x', bbox: [0, 0, 99999, 99999] },
    ],
  })
  assert.equal(odd.length, 2, 'the zero-width box is dropped')
  assert.deepEqual(
    odd[0],
    { left: 0, top: 0, width: (100 / 1536) * 100, height: (100 / 1024) * 100 },
    'a box hanging off the canvas shows the part that is on it',
  )
  assert.deepEqual(odd[1], { left: 0, top: 0, width: 100, height: 100 }, 'and one past the far edge stops at it')
})

test('U06: a detail tab’s one action is the intent the canvas executes, once', () => {
  assert.equal(detailIntentOf('layout'), 'generate-layout')
  assert.equal(detailIntentOf('image'), 'continue-from')
  assert.equal(detailIntentOf('task'), 'retry')
  assert.equal(detailIntentOf('nope'), undefined)

  const intent = intentFor('generate-layout', 'b1', 'l1', 'u06-1')
  assert.deepEqual(intent, { kind: 'generate-layout', boardId: 'b1', nodeId: 'l1', token: 'u06-1' })
  assert.equal(intentFor('layout', 'b1', 'l1', 't'), undefined, 'the node kind is not an action')
  assert.equal(intentFor('generate-layout', '', 'l1', 't'), undefined)
  assert.equal(intentFor('generate-layout', 'b1', '', 't'), undefined)
  assert.equal(intentAppliesTo(intent, 'b1'), true)
  assert.equal(intentAppliesTo(intent, 'b2'), false, 'a request never runs on another board')
  assert.equal(intentAppliesTo(intent, undefined), false, 'nor before the board is known')
  assert.equal(intentAppliesTo(undefined, 'b1'), false)
})

test('U06: 生成 in the detail tab runs the canvas’s own layout request', async () => {
  const requests = []
  const { network, panel } = await mountWorkbench({
    board: U06_LAYOUT_BOARD,
    generate: (init) => {
      requests.push(JSON.parse(init.body))
      return fakeResponse(generateResult([resultImage('u06i1')]))
    },
  })
  try {
    flowContainer(panel).props.onKeyDown(keyEvent('a', { ctrl: true }))
    await settle(panel)
    assert.equal(inspectorElement(panel).props['data-inspector-kind'], 'layout')
    await openDetailOf(panel)

    // The pane is the layout's, and the primary action is the one §8.2 gives it.
    assert.equal(detailPane(panel).props['data-detail-kind'], 'layout')
    const generate = detailAction(panel, 'intent')
    assert.ok(generate !== undefined, 'the detail toolbar has the primary action')
    assert.equal(generate.props.disabled, false, 'a valid draft can generate from here')
    assert.equal(fakeText(generate), '生成')
    generate.props.onClick()
    await settle(panel)

    assert.equal(requests.length, 1, 'exactly one submission')
    const body = requests[0]
    assert.equal(body.prompt, U06_DRAFT.summary.caption, 'the caption is the MOSS prompt')
    assert.equal(body.ratio, '3:2', 'the draft’s mapped tier')
    assert.equal(body.count, 1)
    assert.ok(String(body.layout).includes('abs_centralized'), 'the compiled layout rides along')
    assert.equal(body.board, U06_LAYOUT_BOARD.id)
    assert.deepEqual(body.parents, ['ilayout1'], 'the picture keeps the edge to the layout node')
    // The canvas tab is where it ran, and the detail tab stays on the strip.
    assert.equal(selectedTabKey(panel), 'canvas:' + U06_LAYOUT_BOARD.id)
  } finally {
    network.restore()
  }
})

test('U06: a picture’s detail tab is the big picture, its facts, and 按这张继续', async () => {
  const { network, panel } = await mountWorkbench({ board: U06_IMAGE_BOARD })
  try {
    flowContainer(panel).props.onKeyDown(keyEvent('a', { ctrl: true }))
    await settle(panel)
    await openDetailOf(panel)

    const image = findAll(panel.tree, (element) => element.props['data-detail-image'] === 'true')[0]
    assert.ok(image !== undefined, 'the picture itself, full size')
    assert.ok(image.props.src.includes('?path='), 'served through the file route')
    assert.equal(image.props.alt, '一只橘猫坐在窗台上', 'the first line names it')
    assert.match(detailField(panel, 'size'), /1024×1024/)
    assert.match(detailField(panel, 'prompt'), /第二行不是标题/, 'the full prompt, not just the first line')
    assert.match(detailField(panel, 'seed'), /1/)
    assert.equal(fakeText(detailAction(panel, 'intent')), '按这张继续')
    // A picture's facts are history: only the one action is interactive.
    assert.equal(detailAction(panel, 'save'), undefined, 'nothing here is editable')
  } finally {
    network.restore()
  }
})

test('U06: a task’s detail tab is its parameters, and 重试 re-runs the same snapshot', async () => {
  const requests = []
  const { network, panel } = await mountWorkbench({
    board: U06_TASK_BOARD,
    generate: (init) => {
      requests.push(JSON.parse(init.body))
      return fakeResponse(generateResult([resultImage('u06i2')]))
    },
  })
  try {
    flowContainer(panel).props.onKeyDown(keyEvent('a', { ctrl: true }))
    await settle(panel)
    await openDetailOf(panel)

    assert.match(detailField(panel, 'status'), /失败/)
    assert.match(detailField(panel, 'error'), /CUDA out of memory/)
    assert.match(detailField(panel, 'prompt'), /一只橘猫/)
    assert.match(detailField(panel, 'ratio'), /16:9/)
    assert.match(detailField(panel, 'layout'), /字符/, 'the compiled layout is part of the record')
    const retry = detailAction(panel, 'intent')
    assert.equal(fakeText(retry), '重试')
    retry.props.onClick()
    await settle(panel)

    assert.equal(requests.length, 1, 'the canvas runs it, in place')
    assert.equal(requests[0].prompt, '一只橘猫')
    assert.equal(requests[0].ratio, '16:9')
    assert.equal(requests[0].steps, 8)
    assert.equal(requests[0].count, 2)
    assert.equal(requests[0].seed, 7)
  } finally {
    network.restore()
  }
})

test('U06: the detail pane ships, and the canvas keeps its half of the single-editor rule', () => {
  assert.ok(CLIENT_SOURCE.includes('dsh-forge-detail'), 'the pane’s markup is in the bundle')
  assert.ok(CLIENT_SOURCE.includes('data-detail-action'), 'its buttons are addressable')
  assert.ok(CLIENT_SOURCE.includes('layoutGeneratePlan('), 'the draft→request mapping ships')
  // §8.4's canvas side: the painter branches on the strip's answer, and the tab
  // strip is what computes it.
  const painter = functionBlock('LayoutFlowNode')
  assert.ok(painter.includes('detailOpen'), 'the node painter knows the detail tab')
  assert.ok(painter.includes('LayoutThumb'), 'and draws the read-only thumbnail instead of the editor')
  const pane = functionBlock('NodeDetailPane')
  assert.ok(pane.includes('mountLayoutEditor('), 'the tab mounts the editor')
  assert.ok(pane.includes('detailEditorClaims.claim('), 'and claims the node before it does')
  assert.ok(pane.includes('save-layout-node'), 'writing through §8.1’s one route')
  // The editor is mounted at 1:1 in a tab too: no `pointerScale` option is
  // passed, which is the only correct value when the editor measures its own box.
  assert.ok(!pane.includes('pointerScale:'), 'the detail tab does not scale the pointer')
})





test('P2: 看日志 opens an inline drawer and reads the log through the log route', async () => {
  const { network, panel } = await mountWorkbench({
    configOverrides: { ready: false, reason: 'ComfyUI 没在跑' },
    environment: () => ({ environment: { state: 'ready', owned: true, pid: 4242, endpoint: 'http://127.0.0.1:8188', note: '已后台拉起', logPath: 'C:/logs/dsh-image-forge-launch-1.log' } }),
  })
  try {
    const logBtn = buttonWithText(panel, '看日志')
    assert.ok(logBtn !== undefined, 'a log path offers the inline viewer')
    logBtn.props.onClick()
    await settle(panel)
    const logCalls = network.calls.filter((call) => call.url.indexOf('/plugins/dsh-image-forge/studio/log') === 0)
    assert.ok(logCalls.length >= 1, 'the drawer fetches the log through the same-origin route')
    const drawer = byClassNow(panel, 'dsh-forge-log-drawer')
    assert.ok(drawer !== undefined, 'the log is shown inline, not in an external window')
  } finally {
    network.restore()
  }
})

// ---------------------------------------------------------------------------
// P2b: the panel can download missing weights itself, and shows a live log.
// ---------------------------------------------------------------------------

test('P2b: the panel offers the download button, renders the plan, and posts confirm', async () => {
  const { network, panel } = await mountWorkbench({
    environment: () => ({
      environment: { state: 'ready', owned: true, pid: 4242, endpoint: 'http://127.0.0.1:8188', logPath: 'C:/logs/dsh-image-forge-launch-1.log' },
      weights: {
        profile: 'qwen21-base',
        base: 'D:/models',
        dryRun: true,
        state: 'partial',
        note: '1/3 个权重被 /object_info 列出',
        weights: [
          { kind: 'unet', filename: 'qwen_image_2.1_int8_convrot.safetensors', bytes: 7256783064, targetPath: 'D:/models/diffusion_models/x.safetensors', state: 'present', note: '' },
          { kind: 'clip', filename: 'qwen3vl_8b_int8_convrot.safetensors', bytes: 9350798360, targetPath: 'D:/models/text_encoders/y.safetensors', state: 'would-download', note: '' },
          { kind: 'vae', filename: 'qwen_image_2.1_vae_bf16.safetensors', bytes: 675509688, targetPath: 'D:/models/vae/z.safetensors', state: 'present', note: '' },
        ],
      },
    }),
  })
  try {
    assert.ok(byClassNow(panel, 'dsh-forge-weights-drawer') !== undefined, 'the weight plan is rendered in the panel')
    // The label carries the total size, so match on its stem.
    const download = buttonStartingWith(panel, '下载缺失权重')
    assert.ok(download !== undefined, 'a missing weight offers a download button inside the panel')
    download.props.onClick()
    await settle(panel)
    const posts = network.calls.filter((call) => call.url.indexOf(STUDIO_ENVIRONMENT_ROUTE) === 0 && call.method === 'POST')
    assert.ok(posts.some((call) => String(call.body).includes('download')), 'the click posts the download action')
    assert.ok(posts.some((call) => String(call.body).includes('confirm')), 'the button downloads for real, not the plan again')
  } finally {
    network.restore()
  }
})
test('P2b: when the weights are already on disk, the drawer says so and offers no download', async () => {
  // The bug this pins: the dry run reported an on-disk file as `dry-run` (the
  // same value it used for "planned"), so the panel counted it as missing and
  // offered 下载缺失权重 for files that were already there. `already-present` is
  // the dry run's "done", and nothing is offered when every row is done.
  const { network, panel } = await mountWorkbench({
    environment: () => ({
      environment: { state: 'ready', owned: true, pid: 4242, endpoint: 'http://127.0.0.1:8188' },
      weights: {
        profile: 'moss-sft',
        base: 'D:/Comfy-Desktop/ComfyUI-Shared/models',
        dryRun: true,
        state: 'ready',
        note: '3/3 个权重已在盘；无需下载。',
        weights: [
          { kind: 'unet', filename: 'moss_image_sft_int8_convrot.safetensors', bytes: 5413698958, targetPath: 'D:/models/diffusion_models/a.safetensors', state: 'already-present', note: '已在位（大小匹配）。' },
          { kind: 'clip', filename: 'qwen3.5_9b_w4a8_gptq.safetensors', bytes: 7343591088, targetPath: 'D:/models/text_encoders/b.safetensors', state: 'already-present', note: '已在位（大小匹配）。' },
          { kind: 'vae', filename: 'flux2-vae_small.safetensors', bytes: 249521340, targetPath: 'D:/models/vae/c.safetensors', state: 'already-present', note: '已在位（大小匹配）。' },
        ],
      },
    }),
  })
  try {
    // Nothing is missing, so the drawer is not drawn at all: there is no plan to
    // read, no size to warn about, and above all no 下载缺失权重 button to press.
    assert.equal(byClassNow(panel, 'dsh-forge-weights-drawer'), undefined, 'a full disk needs no weight drawer')
    assert.equal(buttonStartingWith(panel, '下载缺失权重'), undefined, 'and no download button')
    assert.equal(buttonWithText(panel, '查看计划'), undefined, 'nor an empty plan viewer')
    const posts = network.calls.filter((call) => call.url.indexOf(STUDIO_ENVIRONMENT_ROUTE) === 0 && call.method === 'POST')
    assert.equal(posts.some((call) => String(call.body).includes('download')), false, 'no download is requested')
  } finally {
    network.restore()
  }
})

test('P2b: a partial dry run still labels the on-disk row 已在盘 and the rest 待下载', async () => {
  // The mixed case is what the drawer is for, and the labels have to distinguish
  // "the disk has it" from "we would fetch it".
  const { panel } = await mountWorkbench({
    environment: () => ({
      environment: { state: 'ready', owned: true, pid: 4242, endpoint: 'http://127.0.0.1:8188' },
      weights: {
        profile: 'moss-sft',
        base: 'D:/Comfy-Desktop/ComfyUI-Shared/models',
        dryRun: true,
        state: 'ready',
        note: '1/3 个权重已在盘；其余待下载。',
        weights: [
          { kind: 'unet', filename: 'moss_image_sft_int8_convrot.safetensors', bytes: 5413698958, targetPath: 'D:/models/a.safetensors', state: 'already-present', note: '已在位（大小匹配）。' },
          { kind: 'clip', filename: 'qwen3.5_9b_w4a8_gptq.safetensors', bytes: 7343591088, targetPath: 'D:/models/b.safetensors', state: 'would-download', note: '待下载' },
          { kind: 'vae', filename: 'flux2-vae_small.safetensors', bytes: 249521340, targetPath: 'D:/models/c.safetensors', state: 'would-download', note: '待下载' },
        ],
      },
    }),
  })
  try {
    assert.ok(byClassNow(panel, 'dsh-forge-weights-drawer') !== undefined, 'two missing files keep the drawer')
    const plan = buttonWithText(panel, '查看计划')
    assert.ok(plan !== undefined)
    plan.props.onClick()
    await settle(panel)
    const labels = weightRowLabels(panel)
    assert.equal(labels.length, 3)
    assert.ok(labels[0].indexOf('已在盘') >= 0, 'the on-disk row is done, got ' + labels[0])
    assert.ok(labels[1].indexOf('待下载') >= 0, 'a planned row says so, got ' + labels[1])
    // The button counts only what is actually missing.
    const download = buttonStartingWith(panel, '下载缺失权重')
    assert.ok(download !== undefined, 'the missing two offer the download')
  } finally {
    panel.unmount?.()
  }
})