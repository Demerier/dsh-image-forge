# 测试（详细）

## 测试

```powershell
pnpm build
pnpm test
```

**11 个文件 / 162 个用例**，全部不需要 GPU、ComfyUI 或任何权重
（ratio 12 / surface 9 / api-e2e 8 / comfyui-e2e 9 / edit-e2e 9 / settings 56 / studio 28 / studio-canvas 9 / boards 15 / package-contents 4 / studio-file-route 3）。

`pnpm build` 会产出两个目录：`lib/`（`index.js` + `client.js`，**自包含**，Web 客户端只加载 `./client` 这一个入口）
和 `testlib/`（设置与 Studio 逻辑的独立 bundle，只给测试用，**不随包发布**——
为什么不把设置逻辑直接做成 `lib/` 的额外入口，见 `tsdown.config.ts` 的注释）。

前端观感的**布局**可以用 `node test/preview-frontend.mjs` 生成 `test/client-preview.html`
（真实 `CLIENT_CSS` + 与 `client.ts` 同构的 DOM），再用无头浏览器看窄栏/宽栏；它不是
`pnpm test` 的一部分，也**不能替代**在真实 DSH web 客户端里过一遍设置页。

## 每个文件钉住了什么

### `test/settings.test.mjs`（56）

设置分区的完整契约：

- **注册形状**：槽名 `settings.section`、`id`、`order`、`label`、组件、**不带 `key`**，以及 `inject`
  返回的释放函数真的会解绑。
- **入口 id 解析与镜像回绑**、`describe → 读 → 写` 往返、**revision 冲突被识别并重新读取而不是覆盖**、
  拒绝 / 不可写 / 同步抛错 / 传输失败四条失败路径、`mutateFields` 的 revision 透传。
- **`apiKey` 的展示值与失败文案都不含明文**。
- **「schema 里每个字段都有对应控件」的防漏测试**（新增配置字段却忘了补 UI 会在这里失败），
  以及**反向**的一条：`RETIRED_FIELDS` 里 21 个已删除字段（`runtimeDir`、`pythonPath`、`minFreeVramMiB`、
  `localReferenceBudget`…）**一个都不许回到 schema 或设置页**。
- **步数解析**：`resolveSteps`（显式 > `comfyuiSteps` > `defaultSteps`，`api` 没有专属档）与
  `resolveTurboSteps`（显式 > `turboSteps` > **8**，**绝不**继承 25）各自的分支。
- **接线断言**：每个派发点都转发了解析后的步数（3 个 base + 2 个 turbo 解析点、5 个转发点，逐个计数）。
- **tab / group 覆盖**：三页签且每个可见分组只出现在一页里；ComfyUI 页签必须指向
  `docs/comfyui-deployment.md`，且该文档必须真的在包里。
- **文案纪律**：字段 hint ≤ 40 字（带路径的 ≤ 110）、分组 hint ≤ 36 字、advisory ≤ 180 字、
  总字数上限贴着实测值设；**全块禁止任何修复承诺**；**被撤回或被证伪的数字**
  （`8 倍` / `15 倍` / `7.75` / `0.98` / `37 s` / `口径存疑` / `219 s` / `2.77×`）一旦重新出现在 advisory 里就失败。
- **advisory 不得含 markdown 标记**：该分区把字符串当纯文本节点渲染，`**` 与反引号会原样显示给用户。
- **证据必须在随包散文面**（README + 全部 `docs/*.md`）而**不得只在页面上**：12 个实测数字逐个双向断言。
- **客户端产物断言**：三个工具都进了 `tool.call.toolview`、`qwen_image_env` **已从 bundle 里消失**、
  样式注入与窄栏容器查询在 bundle 里、数字控件带单位后缀、label 绑到控件、tabs 暴露成 `role=tab`。
- **一键部署卡片已删除**：`dsh-image-forge-deploy` / `一键部署` / `127.0.0.1:8411` 都不许再出现在 bundle 里。

### `test/surface.test.mjs`（9）

`lib/index.js` 的四个导出、**三个**工具名、`backend` enum 恰好三档、`qwen_image_status` 只收 `timeoutMs`、
`wh_ratio` enum 与它在 `skill.md` 里被引用的换算表、参考文件绝对路径、以及**compose 后的技能正文**：
里面必须只剩两条后端、不许再提 `qwen_image_env` / `localReferenceBudget` / `freeComfyBeforeLocalStart` /
`minFreeVramMiB` / `local_edit_budget`，并且必须写到 `comfyModel`、`turbo`、`8 步`、`turbo_fallback`
与部署文档的路径。

### `test/api-e2e.test.mjs`（8）

本地假端点端到端（请求体、响应解析、落盘字节一致）、编号不覆盖、显式 `width`/`height` 覆盖、
**无 key / 无 ComfyUI 时的报错文本**（必须点名部署文档、且**不再**出现 `local:` 这条补救）、
`backend: "api"` 缺 key 的专属文案、环境变量 key 与 401 上游的脱敏、
`qwen_image_status` 的完整载荷形状（含 `version` / `devices` 为 `null`、`next_steps` 指向文档）与
**lossless JSON**（无 `undefined`）。

### `test/comfyui-e2e.test.mjs`（9）

假 ComfyUI 端到端（多端口探测 → `/object_info` 选权重 → `/prompt` 注入工作流 → 轮询 `/history` →
`/view` 取图 → 落盘**逐字节一致**）、缺文件点名、没在跑时报出探过的端口、
非回环端点拒绝且**一个请求都不发**、`node_errors` 与 traceback 原文回传、
`auto` 的后端选择（有 key 走云端、无 key 走 ComfyUI、两边都没有时报错并指向文档）、
以及 `qwen_image_status` 读到的 `version` / `devices`（来自 `/system_stats`，不是 `nvidia-smi`）。

### `test/edit-e2e.test.mjs`（9）

参考图编辑。参考 PNG 由测试自己生成（尺寸要真，所以不能拿假字节糊弄）：

- 假 ComfyUI 收到 `/upload/image` multipart（**上传字节与参考图逐字节一致**、`content-type` 正确、
  文件名按内容哈希），图里 `images.image_1`/`images.image_2` 接对、`resolution` 跟着画布面积、
  `/view` 的字节逐字节落盘。
- `ratio_follow`（`image1` / 直接给路径 / 不传则默认第一张）换算出的画布与偏差。
- `wh_ratio` + `ratio_follow` 同时给时**在碰后端之前**就报错。
- 11 张 / 空表 / 缺文件 / 目录 / 相对路径 / 0 字节 / 非图片 / 非 base64 data URI / 空 base64 各自点名 `images[n]`。
- `backend: "api"` 拒收参考图（报错里指向部署文档、不再提供 `local` 这条出路）；`auto` + 有 key 时
  仍走 ComfyUI 并如实回报 `api_skipped`。
- **满画布不设门**：1248×1248 的编辑照常出图，结果里**没有** `local_edit_budget` / `local_worker` 这两个键。
- `auto` 在 ComfyUI 没起来时的错误只说缺什么 + 指向部署文档，不再描述「两个本地后端」。
- **文生图不上传**：同一台假 ComfyUI 上先编辑（2 次上传、2 个 `LoadImage`），再文生图（上传数不变、
  图里没有 `LoadImage` 节点）。

### `test/studio.test.mjs`（28）与 `test/studio-canvas.test.mjs`（9）

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

### `test/boards.test.mjs`（15）

画板存储，全部打在**真实临时目录**上（契约是文件系统，mock 掉 `fs` 等于什么都没测）：
省略 `board` 时**按提示词新建**、再省略再新建；按 id / 按名字（大小写不敏感）找到同一块；
没见过的 `board` 值按新画板名字处理而不是报错；同一文件重复记录**合并不重排**（坐标与 id 不动、元数据刷新）；
未放置的图落三列网格；布局与相机往返（NaN 相机被清掉、未知 id 不连累保存）；
「移除」默认只摘记录，**删文件**必须显式要求且路径必须在 `outputDir` 里；
删画板不动图片；改名拒绝空名；素材页跨画板过滤（画板 / 自由文本 / 上限）；
**并发写同一画板不丢条目**（每目录写队列）；损坏的画板文件只隐藏那块画板，不拖垮库；
active 画板的记忆与 `state.json` 的形状。

### `test/ratio.test.mjs`（12）

7 档换算、32 对齐、确定性、显式尺寸校验。

### `test/package-contents.test.mjs`（4）

`npm pack` 的 `files` 白名单：Host 与技能按路径读取的文件（含 README 顶部的 `docs/images/repo-banner.png`）都在包里且真的存在、
`docs/*.md` 这个 glob（而不是某个一次性条目）让部署文档可被发现、`docs/plans/` **不入包**、
**`resources/` 与 6 个已删除的源文件不许再出现**、以及许可证与第三方声明随包分发。

## 真机端到端（不在 `pnpm test` 里）

- `test/live-generate-e2e.mjs`：一次 1:1 文生图，打印落盘路径与 IHDR。`FORGE_LIVE_MODEL=turbo` 切权重家族，
  所以这一条同时是「turbo 契约在真卡上成立」的检查。
- `test/live-edit-e2e.mjs`：两次参考图编辑（默认跟随 `image1`、以及 `ratio_follow`），最后跑一次
  `qwen_image_status`。需要本机 ComfyUI 在跑、三个权重就位。

两者都读插件自己的配置（`comfyEndpoint` / `comfyPorts` / `outputDir`），不额外要求环境变量。

（用 `node test/xxx.test.mjs` 逐个跑，而不是 `node --test`：后者会 spawn 子进程并通过管道取输出，
在受限沙箱里会 `EPERM`。）
