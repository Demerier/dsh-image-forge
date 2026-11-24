# 测试（详细）

## 测试

```powershell
pnpm typecheck
pnpm build
pnpm test
```

`pnpm typecheck` 对 `src/**/*.ts` 与 tsdown 配置运行严格 TypeScript 检查且不产出文件；CI 与发布流程都会在构建前执行它。

**32 个文件 / 651 个用例**（2026-11-24 计数），全部不需要 GPU、ComfyUI、comfy-mcp 或任何权重
（ratio 14 / surface 13 / comfyui-e2e 31 / edit-e2e 8 / moss-edit 3 / settings 60 /
studio 118 / canvas-flow-model 48 / studio-canvas 36 / boards 30 / board-migration 8 /
output 3 / package-contents 4 / studio-file-route 7 / studio-log-route 3 / model-profiles 7 /
progress 8 / runs 7 / environment 41 / layout-editor 25 / studio-lineage 5 /
canvas-interactions 27 / canvas-connections 21 / canvas-export 6 / moss-layout 9 /
mcp-backend 22 / workbench-tabs 30 / workbench-workspace 7 / workbench-shell 28 / bundle-xyflow 10 /
docs-consistency 5 / blind-pe 7）。

布局编辑器与 MOSS 布局测试使用 `test/fixtures/layout/` 中的公开 JSON 夹具；`verify/` 只保留本机私有证据，CI 不读取它。

`pnpm build` 会产出两个目录：`lib/`（`index.js` + `client.js`，**自包含**，Web 客户端只加载 `./client` 这一个入口）
和 `testlib/`（设置与 Studio 逻辑的独立 bundle，只给测试用，**不随包发布**——
为什么不把设置逻辑直接做成 `lib/` 的额外入口，见 `tsdown.config.ts` 的注释）。

前端观感的**布局**可以用 `node test/dev/preview/frontend.mjs` 生成 `.preview/client-preview.html`
（真实 `CLIENT_CSS` + 与 `client.ts` 同构的 DOM），再用无头浏览器看窄栏/宽栏；它不是
`pnpm test` 的一部分，也**不能替代**在真实 DSH web 客户端里过一遍设置页。

### PE 盲测 v1（开发工具，不随包发布）

PE 盲测脚本直接请求本机 ComfyUI，不经过插件工具或画板；图片和答案只写入
`.blindtest/pe-v1/`。固定流程是：

```powershell
pnpm blind:pe:audit
pnpm blind:pe:generate
pnpm blind:pe:score -- --reviewer reviewer-1
pnpm blind:pe:check
```

`generate` 会先用官方最小分支 `CLIPLoader → TextGenerateV2 → PreviewAny` 生成并冻结提示词，随后才生成评分图。v1 为 3 个通用题 + 4 个 IP 角色，共 42 张；v2 为 6 个通用题 × 2 seeds，共 96 张，不包含 IP。MOSS 评分图只接收冻结后的最终 prompt，不在评分工作流里重复跑增强节点。

v2 使用独立命令和输出目录：

```powershell
pnpm blind:pe2:audit
pnpm blind:pe2:generate
pnpm blind:pe2:score -- --reviewer reviewer-1
pnpm blind:pe2:score -- --reviewer reviewer-2
pnpm blind:pe2:check
pnpm blind:pe2:analyze -- --reviewer reviewer-1 --input .blindtest/pe-v2/reviewers/reviewer-1/rankings.txt
```

v2 的每道题以两个独立“样次”出现；评审页不会显示 seed。把页面导出的排名文本保存为对应评审目录的 `rankings.txt` 后，`analyze` 会输出逐组名次、来源平均名次、归一化平均名次、组内第一率和两个 seed 的名次波动。

`score` 每位评审人生成 `main-images` 主评审页和 `ip-images` 附加题页；不再生成
提示词评审页。人类评审只依据页面上的原始需求和图片打分，每个图片组都可填写意见描述，
每组必须完成唯一排名后才能导出。来源、模型、最终 prompt 与答案映射只留在评审目录的 `key.json`。
IP 只作尝试性附加题，主结论以通用题目为准。

`check` 验证任务矩阵、冻结提示词、随机文件名、PNG 尺寸、工作流参数、答案映射以及
HTML 不含来源或最终 prompt 泄露。`test/blind-pe.test.mjs` 用假 ComfyUI 覆盖 Qwen、MOSS、
TextGenerateV2 文本抓取、42 张图片映射与页面导出。单个 seed 只形成方向性结论，
建议 3 位评审人分别完成页面，再按多数排名和题材一致性报告。

## 每个文件钉住了什么

### `test/settings.test.mjs`（60）

设置分区的完整契约：

- **注册形状**：槽名 `settings.section`、`id`、`order`、`label`、组件、**不带 `key`**，以及 `inject`
  返回的释放函数真的会解绑。
- **入口 id 解析与镜像回绑**、`describe → 读 → 写` 往返、**revision 冲突被识别并重新读取而不是覆盖**、
  拒绝 / 不可写 / 同步抛错 / 传输失败四条失败路径、`mutateFields` 的 revision 透传。
- **「schema 里每个字段都有对应控件」的防漏测试**（新增配置字段却忘了补 UI 会在这里失败），
  以及**反向**的一条：`RETIRED_FIELDS` 里 26 个已删除字段（`runtimeDir`、`pythonPath`、`minFreeVramMiB`、
  `localReferenceBudget`、`backend`、`apiBaseUrl`、`apiKey`…）**一个都不许回到 schema 或设置页**。
- **步数解析**：`resolveSteps`（显式 > `comfyuiSteps` > `defaultSteps`）与
  `resolveTurboSteps`（显式 > `turboSteps` > **8**，**绝不**继承 25）各自的分支。
- **接线断言**：每个派发点都转发了解析后的步数（2 个 base + 2 个 turbo 解析点、4 个派发转发 + 2 个记录点，逐个计数）。
- **tab / group 覆盖**：配置两页签（工作台是第一个非配置页签）且每个可见分组只出现在一页里；ComfyUI 页签必须指向
  `docs/comfyui-deployment.md`，且该文档必须真的在包里。
- **文案纪律**：字段 hint ≤ 40 字（带路径的 ≤ 110）、分组 hint ≤ 36 字、advisory ≤ 180 字、
  总字数上限贴着实测值设；**全块禁止任何修复承诺**；**被撤回或被证伪的数字**
  （`8 倍` / `15 倍` / `7.75` / `0.98` / `37 s` / `口径存疑` / `219 s` / `2.77×`）一旦重新出现在 advisory 里就失败。
- **advisory 不得含 markdown 标记**：该分区把字符串当纯文本节点渲染，`**` 与反引号会原样显示给用户。
- **证据必须在随包散文面**（README + 全部 `docs/*.md`）而**不得只在页面上**：12 个实测数字逐个双向断言。
- **客户端产物断言**：三个工具都进了 `tool.call.toolview`、`qwen_image_env` **已从 bundle 里消失**、
  样式注入与窄栏容器查询在 bundle 里、数字控件带单位后缀、label 绑到控件、tabs 暴露成 `role=tab`。
- **一键部署卡片已删除**：`dsh-image-forge-deploy` / `一键部署` / `127.0.0.1:8411` 都不许再出现在 bundle 里。
- **T14 新方向断言**：随包散文面必须写到受管入口 `image_forge_setup`、下载判据 `/object_info`、Desktop 模型根 `ComfyUI-Shared` 与授权门槛 `computer use`；这是「新能力必须写进散文面」，不是旧口径回魂。

### `test/surface.test.mjs`（13）

`lib/index.js` 的四个导出、**四个**工具名（`generate` / `edit` / `status` / `setup`）、出图/改图**不带 `backend` 与 `transparent` 参数**、
`image_forge_status` 只收 `timeoutMs`、`image_forge_setup` 的 action 是 `status/start/stop/install/download` 且 `confirm` 是布尔（T14）、
schema 里 **10** 个字段齐全且 5 个云端字段绝迹、
`wh_ratio` enum 与它在 `skill.md` 里被引用的换算表、参考文件绝对路径、以及**compose 后的技能正文**：
里面必须只剩本机 ComfyUI 一条路、不许再提 `qwen_image_env` / `localReferenceBudget` / `freeComfyBeforeLocalStart` /
`minFreeVramMiB` / `local_edit_budget` / `apiKey`，并且必须写到 `comfyModel`、`turbo`、`8 步`、`turbo_fallback`
与部署文档的路径。

### `test/mcp-backend.test.mjs`（22；T15 新增，T22 +3）

后端接线与自研 MCP client。**假的是 stdio 连接缝，不是断言**：宿主随包的
`@modelcontextprotocol/client` 是 peerDependency，由 DSH profile 运行时解析，普通
`node` 里 import 不到（见 [usage-reference.md](usage-reference.md#执行后端与受管环境t22)），所以假对象实现的是
`McpConnectionLike`（`listTools`/`callTool`/close）——生产代码的每个分支都被真的走到：

- **工具过滤**：39 工具清单里只放行 `run_workflow` / `job` / `fetch_outputs` /
  `validate_workflow` / `system_stats`；缺 `run_workflow`/`job`/`fetch_outputs` 任一个在
  connect 时就报版本错误；非白名单工具在到达子进程前被拒。
- **提交/轮询/取图**：`run_workflow` 必须带 `wait: false`（首次加载权重常超 110 s，默认
  `wait=True` 会撒谎）；首轮 `timed_out: true` **不是失败**（§4.2 口径）；`fetch_outputs` 必须收到
  绝对 `out_dir`，落盘字节按真实 PNG 头识别 mime。
- **超时与杀进程树**：轮询到 `timeoutMs` 仍无终态时，用 transport pid 调 `taskkill /F /T`
  （POSIX `kill(-pid)`）并报出 prompt id；completed 却零图同样是错误。
- **后端链**：`auto` = mcp → cli，失败上报 skipped 后继续；`mcp`/`cli` 严格模式不回退；
  没有任何工具链时返回 `undefined`（HTTP 旧路径，零行为变化）。
- **CLI 降级**：`comfy --json --where local --skip-prompt run --workflow … --wait` 后
  `download <prompt_id> --out-dir`，失败 envelope 原文回传。
- **隐私断言（决策 6）**：`lib/index.js` 里不许出现 `mcpManager` 或 `mcp__`——MCP 工具
  不得进入对话模型工具表；同时 `fetch_outputs` 必须在主机侧 bundle 里。
- **配置边界**：后端选择/超时**不进 Config schema**，只读环境变量
  `DSH_IMAGE_FORGE_BACKEND` / `…_COMFY_MCP_BIN` / `…_COMFY_BIN` /
  `…_BACKEND_TIMEOUT_MS` / `…_MCP_DEBUG` / `…_BACKEND_TMPDIR`。原因：schema 新字段必须
  有设置页控件（`test/settings.test.mjs` 会失败），而 `src/settings-fields.ts` 不在 T15
  写入范围；「配置项进 schema + 控件」记为 T15 未完成项，交 T22/协调者。

### `test/comfyui-e2e.test.mjs`（31）

假 ComfyUI 端到端（多端口探测 → `/object_info` 选权重 → `/prompt` 注入工作流 → 轮询 `/history` →
`/view` 取图 → 落盘**逐字节一致**）、缺文件点名、没在跑时报出探过的端口、
非回环端点拒绝且**一个请求都不发**、`node_errors` 与 traceback 原文回传、
ComfyUI 没在跑时**永远走本机**这条唯一路径（报错点名探过的端口并指向部署文档，
不再提供任何云端补救）、以及 `image_forge_status` 读到的 `version` / `devices`
（来自 `/system_stats`，不是 `nvidia-smi`）、以及**权重缺失报错里的目录提示按「配置路径自己的风格」拼**——
Windows 路径出 `…\models\clip\`、POSIX 路径出 `…/models/clip/`，两种风格在任意宿主上都成立
（曾按 `process.platform` 拼，Windows 本地绿、Linux CI 红）。

### `test/edit-e2e.test.mjs`（8）

参考图编辑。参考 PNG 由测试自己生成（尺寸要真，所以不能拿假字节糊弄）：

- 假 ComfyUI 收到 `/upload/image` multipart（**上传字节与参考图逐字节一致**、`content-type` 正确、
  文件名按内容哈希），图里 `images.image_1`/`images.image_2` 接对、`resolution` 跟着画布面积、
  `/view` 的字节逐字节落盘。
- `ratio_follow`（`image1` / 直接给路径 / 不传则默认第一张）换算出的画布与偏差。
- `wh_ratio` + `ratio_follow` 同时给时**在碰后端之前**就报错。
- 11 张 / 空表 / 缺文件 / 目录 / 相对路径 / 0 字节 / 非图片 / 非 base64 data URI / 空 base64 各自点名 `images[n]`。
- 改图只走 ComfyUI：没起来时报错点名探过的端口并指向部署文档，**不丢参考图**、
  不再提供任何已删除的后端出路，返回里也没有 `api_skipped` / `transparent` 这些已删字段。
- **满画布不设门**：1248×1248 的编辑照常出图，结果里**没有** `local_edit_budget` / `local_worker` 这两个键。
- **文生图不上传**：同一台假 ComfyUI 上先编辑（2 次上传、2 个 `LoadImage`），再文生图（上传数不变、
  图里没有 `LoadImage` 节点）。

### `test/studio.test.mjs`（118）与 `test/studio-canvas.test.mjs`（36）

工作台的**纯函数契约**，在请求上线之前就拦住问题——请求体字段收窄（`undefined` 保持缺省而不是变 0/NaN）、
**画幅必须是选择器真正提供过的那 7 档**（未知比例直接拒绝，而不是悄悄当成正方形）、提示词长度上下界、
非数字的步数/种子/张数报错而不是静默归零、参考图的 base64 与空内容拒绝、**空参考图数组被规范化掉**、
**`board` 字段收进载荷**（空串等于「没有」，交给宿主决定落哪块画板）、
**画板操作的 action 是封闭集合**（未知操作拒绝而不是忽略；position 逐条校验，畸形条目被丢掉而不是连累整批；
`deleteFile` 只有字面 `true` 才算数）、优化器的上下文**截断而不是拒绝**、
**步数钳制**（1–200，缺省走 `comfyuiSteps ?? defaultSteps`）、
**7 档画幅解析出的像素与 `resolveDefaultSize` 逐格一致且 32 对齐**
（`studioSize` 曾误用会做网格搜索的 `resolveSize`，导致 4 档的画幅标签与实际画布不符——这条测试就是那次修复的钉子）、
`studioSettingsOf` 的字段映射与畸形端口串回退、优化器提示词拼接、`注：` 行的解析与**首行 `注` 不算 note**、
引号剥离只在最外层成对时发生、**六条路由**确实注册在宿主上（客户端半边带它实际会调的五条）、
以及画布（平移 / 缩放 / 适应 / 血缘连线）的纯函数。

### `test/model-profiles.test.mjs`（7）

P0（model profile 抽象 + MOSS 文生图）的注册表契约：三 profile 的 id / legacyIds 解析、
每 profile 自己的 latent classType 与对齐粒度（Qwen 32 / MOSS `EmptyFlux2LatentImage` 16）、clipType、采样器、
filenamePrefix；MOSS 双采样档（`comfy` 25 / CFG 2.5 / `er_sde`，`official` 50 / CFG 3 / `euler`）与 Qwen 忽略该值；
MOSS 改图在发请求前显式拒绝；MOSS 假服务端到端（不做 `/qwen/i` 硬门、`EmptyFlux2LatentImage`、16px 对齐）；
步数解析在 MOSS profile 下的分支。

### `test/progress.test.mjs`（8）

P3a 进度后端的纯函数契约：SSE 帧编解码、事件名与 JSON 载荷、心跳、关闭与错误路径。

### `test/environment.test.mjs`（28）

环境层 P1a/P1b。全部打**假** Comfy Desktop 注册表与 127.0.0.1 上的假 ComfyUI，不读真实注册表、不启动真实渲染器：
Desktop 注册表 → 启动计划（torch 解释器的选择、argv 顺序、envVars、port）、便携版扫描、
端口表探活、`start`（detached spawn + 等 `/system_stats`，不重试）、`stop`（Windows taskkill /T，POSIX SIGTERM）、
启动记录；**P1b**：模型根解析顺序（运行实例 argv → Desktop yaml → settings.json → 安装树）、yaml `base_path` 解析、
`/object_info` **精确文件名**判据（正则近似名不算）、`.part` + 字节数/sha256 + 原子改名、Range 续传与 200 回退、
**假闭环「下载 → 改名 → `/object_info` 可见」**、dry-run 不写盘、无运行实例时只报 `unverified` 绝不报 `ready`、
安装引导的授权门槛（未授权绝不调用自动化，授权后才调用执行器）。

### `test/boards.test.mjs`（24）

画板存储，全部打在**真实临时目录**上（契约是文件系统，mock 掉 `fs` 等于什么都没测）：
省略 `board` 时**按提示词新建**、再省略再新建；按 id / 按名字（大小写不敏感）找到同一块；
没见过的 `board` 值按新画板名字处理而不是报错；同一文件重复记录**合并不重排**（坐标与 id 不动、元数据刷新）；
未放置的图落三列网格；布局与相机往返（NaN 相机被清掉、未知 id 不连累保存）；
「移除」默认只摘记录，**删文件**必须显式要求且路径必须在 `outputDir` 里；
删画板不动图片；改名拒绝空名；素材页跨画板过滤（画板 / 自由文本 / 上限）；
**并发写同一画板不丢条目**（每目录写队列）；损坏的画板文件只隐藏那块画板，不拖垮库；
active 画板的记忆与 `state.json` 的形状。

### `test/ratio.test.mjs`（14）

7 档换算、32 对齐、确定性、显式尺寸校验。

### `test/output.test.mjs`（3）

落盘契约：`sanitizePrefix` 只留 ASCII 安全字符（纯多字节前缀塌回默认值）、空号查找在**每个已知扩展名**
（`.png`/`.jpg`/`.jpeg`/`.webp`）上都不算空闲、一批多张按序编号且**永不覆盖**已存在的旧文件。

### `test/package-contents.test.mjs`（4）

`npm pack` 的 `files` 白名单：Host 与技能按路径读取的文件（含 README 顶部的 `docs/images/repo-banner.png`）都在包里且真的存在、
显式 docs 白名单而不是 `docs/*.md` glob，避免本地调研被误打包；每个公共文档必须同时出现在 README
  和 `package.json.files`；`docs/plans/` **不入包**、
**`resources/` 与 6 个已删除的源文件不许再出现**、以及许可证与第三方声明随包分发。

### `test/docs-consistency.test.mjs`（5）

文档与发布边界的机器检查：README 必须引用每一个公共 `docs/*.md`，当前版本必须有对应发布说明；
README 和文档里的相对链接必须存在；`src` 里的 `docs/...` 注释链接必须指向已跟踪公共文档；
配置字段数量和字段表必须与 `src/index.ts` 的 `Config` 一致。

### `test/canvas-export.test.mjs`（6，T22 入链）

C15 的纯函数导出层：contact sheet 网格（行优先 256px cell、label 条、canvas 尺寸）、等比缩放不拉伸、
200 张上限与列/格钳制、空板零尺寸、prompt 首行 label、非图片节点不进拼版、画板 JSON 序列化与安全文件名；
外加 DD12 的服务端子集保存守护（只发 dirty id 时未命名条目坐标不变）。

## T22 断言变更清单（D5 可追溯）

T22 把 T15 的后端选择从「环境变量专属」提升为配置项、补上 stepper 与结果镜像，逐条改动如下：

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `test/settings.test.mjs` | schema 10 → 16 字段（`executionBackend` / `comfyMcpBin` / `comfyBin` / `backendTimeoutMs` / `mcpDebug` / `backendTmpDir`），新增 T22 覆盖断言；文本预算 470→700 / 125→165；resolved 类型集加入 `boolean` | 新配置必须有控件与默认值断言；预算显式上调用例说明 |
| `test/surface.test.mjs` | 文档化字段列表补 6 个新字段 | 已发布 schema 的字段集合必须可执行核对 |
| `test/mcp-backend.test.mjs` | +3：配置默认值/环境变量优先（含显式 `MCP_DEBUG=0`）、MCP `fetch_outputs` 工作区镜像保留、CLI `download` 镜像 | 结果镜像与「旧环境变量行为不变」必须机器判定 |
| `test/studio.test.mjs` | +3：stepper 四步纯函数映射（ready/未安装/权重缺失/运行中/失败/已有图）、面板渲染与「重新检测」、未就绪原因落到失败步 | stepper 是 P6 的可见交付，状态必须可测 |
| 本文件 | 12 个旧章节计数同步到 T22 当时的实际值（comfyui-e2e 31 / studio 75 / studio-canvas 29 / progress 8 / boards 24 / ratio 14）；补 canvas-export 与本节 | 这些数字是 T22 历史记录；当前计数以本文上方表格为准 |

口径边界不变：`backend`（旧云端字段）、`qwen_image_env`、`一键部署`/`127.0.0.1:8411` 仍禁止；
`RETIRED_FIELDS` 26 个字段一个不少。新增的 `executionBackend` 是**本地执行链选择**，不是云端后端回魂。
## T14 断言变更清单（D5 可追溯）

T14 把「零下载 / 一键部署」的旧口径换成了**受管安装 + 按需权重下载**，逐条改动如下：

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `test/surface.test.mjs` | 「三个工具」→ 四个（含 `image_forge_setup`）；新增 action 枚举与 `confirm` 断言；描述必须点名 `/object_info` 与 `computer use` | 新能力必须可被契约测到；`qwen_image_env` 旧名仍禁 |
| `test/settings.test.mjs` | 保留旧禁项（`dsh-image-forge-deploy` / `一键部署` / `127.0.0.1:8411` / `qwen_image_env` / `DeployStatusPayload`）；新增「随包散文面必须写到受管安装/下载方向」 | 旧字段与旧一键部署卡片**不回魂**；同时新能力不能只活在代码里 |
| 本文件 | 11 文件/159 → 14 文件/242；补 3 个测试文件章节；`surface` 的字段数 9 → 10 | 计数与实际一致；`schema` 已是 10 个字段 |
| `test/mcp-backend.test.mjs`（T15 新增） | 19 用例：假 stdio 连接缝覆盖提交/轮询/取图/超时/杀进程树、后端链严格/回退、CLI envelope、隐私（无 `mcpManager`/`mcp__`） | MCP 主通道必须可被契约测到；工具不进对话工具表要机器判定；后端选择走环境变量是刻意的范围裁决 |

口径边界：`qwen_image_env`（旧本地运行时工具）、`一键部署` 卡片、云端 `backend` 仍然**禁止**出现；
新增的是 `image_forge_setup` 的受管安装引导与权重下载（只与本机 ComfyUI 通信、只写 Desktop 模型目录）。

## 真机端到端（不在 `pnpm test` 里）

- `test/live-generate-e2e.mjs`：一次 1:1 文生图，打印落盘路径与 IHDR。`FORGE_LIVE_MODEL=turbo` 切权重家族，
  所以这一条同时是「turbo 契约在真卡上成立」的检查。
- `test/live-edit-e2e.mjs`：两次参考图编辑（默认跟随 `image1`、以及 `ratio_follow`），最后跑一次
  `image_forge_status`。需要本机 ComfyUI 在跑、三个权重就位。

两者都读插件自己的配置（`comfyEndpoint` / `comfyPorts` / `outputDir`），不额外要求环境变量。

T14 的首单真机验证（2026-11-17，Linux 无关、Windows 本机）：`resolveModelsBase` 经运行实例 argv 解析到
`D:\Comfy-Desktop\ComfyUI-Shared\models`；`ensureProfileWeights(dry-run/live)` 三个 Qwen 权重全部被 `/object_info` 列出（state=ready）；
真实下载 MOSS VAE `flux2-vae_small.safetensors`（249 521 340 B，hf-mirror，17 s，sha256 校验通过）；
并向真实 `vae\` 写入 1 个探针权重后**不重启** ComfyUI 即被 `/object_info/VAELoader` 列出、删掉后立即消失（T04 §5.3 的未核实项已消）。

（用 `node test/xxx.test.mjs` 逐个跑，而不是 `node --test`：后者会 spawn 子进程并通过管道取输出，
在受限沙箱里会 `EPERM`。）
