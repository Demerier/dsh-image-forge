# 测试（详细）

## 测试

```powershell
pnpm build
pnpm test
```

10 个文件 / **151 个用例**，全部不需要 GPU、venv 或 10.6 GiB 权重
（ratio 12 / local-edit-budget 16 / surface 9 / api-e2e 8 / comfyui-e2e 9 / worker-lifecycle 21 / edit-e2e 9 / vram-gate 14 / settings 50 / package-contents 3）。

> 这 151 个用例目前在**本机全绿**（`worker-lifecycle` 21/21）。此前它曾有 2 个用例在
> `cleanup()` 的 `rmSync` 上报 `EPERM`，根因是 `python -m venv` 在 `TMP` 指向不存在的目录时
> 会在 venv 里留下 ACL 为 `0o700` 的临时目录 —— 那是插件自身的一个真缺陷，已修掉，
> 与本 README 描述的设置页改动无关。

- `test/settings.test.mjs`：设置分区的完整契约——注册形状（槽名 `settings.section`、`id`、
  `order`、`label`、组件、**不带 `key`**，以及 `inject` 返回的释放函数真的会解绑）、
  入口 id 解析与镜像回绑、`describe → 读 → 写` 往返、**revision 冲突被识别并重新读取而不是覆盖**、
  拒绝 / 不可写 / 同步抛错 / 传输失败四条失败路径、`mutateFields` 的 revision 透传、
  **`apiKey` 的展示值与失败文案都不含明文**、以及**「schema 里每个字段都有对应控件」的防漏测试**
  （新增配置字段却忘了补 UI 会在这里失败）、**步数解析优先级**（显式 > 后端专属 > 默认）、
  「每个派发点都转发了解析后的步数」的接线断言、以及**性能说明块的文案纪律**：
  斜率表/端到端表的每个数字逐格断言、结论性 finding 必须带实测数字、
  **全块禁止任何修复承诺**、且**被撤回或被证伪的数字（`8 倍` / `15 倍` / `7.75` / `0.98` / `37 s` /
  `口径存疑`）一旦重新出现就测试失败**（这条存在就是为了「别再犯那个错」）。
  另有「**advisory 不得含 markdown 标记**」的断言 —— 该分区把字符串当纯文本节点渲染，
  `**` 与反引号会原样显示给用户。

`pnpm build` 会产出两个目录：`lib/`（`index.js` + `client.js`，**自包含**，Web 客户端只加载 `./client` 这一个入口）
和 `testlib/`（设置逻辑的独立 bundle，只给 `test/settings.test.mjs` 用，**不随包发布**——
为什么不把设置逻辑直接做成 `lib/` 的额外入口，见 `tsdown.config.ts` 的注释）。

- `test/ratio.test.mjs`：7 档换算、32 对齐、确定性、显式尺寸校验
- `test/surface.test.mjs`：`lib/index.js` 的四个导出、**四个**工具名、`wh_ratio` enum、`qwen_image_edit` 的必填项与参数形状、技能正文与参考文件路径
- `test/api-e2e.test.mjs`：本地假端点端到端（请求体、响应解析、落盘字节一致）、编号不覆盖、
  无 key / 无 worker / 上游 401 的报错文本、key 脱敏、`qwen_image_env status`
- `test/comfyui-e2e.test.mjs`：假 ComfyUI 端到端（多端口探测 → `/object_info` 选权重 → `/prompt` 注入工作流 →
  轮询 `/history` → `/view` 取图 → 落盘**逐字节一致**）、缺文件点名、没在跑时报出探过的端口、
  非回环端点拒绝且**一个请求都不发**、`node_errors` 与 traceback 原文回传、`auto` 的后端选择
- `test/worker-lifecycle.test.mjs`：**worker 生命周期 + 本地运行时管理**。全部跑在
  `test/fixtures/fake-worker.mjs` 上（同命令行、同 HTTP 面的 node 假 worker，所以不需要 GPU/venv/10.6 GiB 权重）：
  插件自启并出图、被外部杀掉后下次调用重建、启动即崩时回报退出码 + stderr、永不就绪时按预算超时并回日志尾部、
  端口被不相干的 HTTP 服务占着时顺延、`POST /unload` 与空闲回收、没有 `/unload` 的旧 worker 被如实报告、
  `manageWorker:false` 拒绝拉起、`/generate` 错误原文回传、请求中途死掉只重建重试一次、
  `status` 的六态区分、失败启动的冷却、`repair` 只杀本会话自己持有的僵死 worker（**不碰别人的 pid**，
  记录在案的第三方 pid 只报告 + 给 `taskkill` 命令）。
  权重侧用**假镜像**（本地 http）：URL 清单、只规划不下载的 dry run、**断点续传 + sha256 + bnb 分离开关**、
  `lm_head.weight` 剔除后文件仍合法（偏移量下移、字节原样）、`install` dry run 不落盘、
  `repair` 把缺权重报成 `unfixable` 而不是假装成功
- `test/local-edit-budget.test.mjs`：**本地编辑尺寸门**。一层是**同源**：测试读 `resources/worker.py`、
  把 `_reference_budget` 的表达式取出来翻译成 JS 再求值，与 `src/ratio.ts` 的 `referenceBudget` 在
  整个合法窗口的 32 对齐网格（256–4096，**14641 个尺寸**）上逐点比对（任一侧单独改动都会红；翻译不了的新写法会**报错**而不是静默放过）；
  另一层是三条路径，全部走**真工具 + node 假 worker**：≤896 放行且回执 `local_edit_budget.budget` 与画布一致、
  897–960 放行且警告同时出现在 JSON 与 `summary`、>960 **在 spawn 之前拒绝**（假 worker 的事件文件都不存在）、
  开 `allowLocalEditOverBudget` 后同一请求放行且标注 `overridden`、以及同一张被拒画布在**文生图**上不受影响；
  另外钉住 7 档默认画布的 budget（1248/1216）**全部落在拒绝档**——这正是这道门存在的理由；
  `localReferenceBudget` 的四条语义也在这里钉住：**没配置时请求体里连 `reference_budget` 这个键都没有**（默认路径
  逐字节不变）、配了 `512` 时那张 1248×1248 画布**被放行**且 worker 真的收到 `reference_budget: 512`（画布不变）、
  配一个**本身超线**的值（1248）仍然被拒（旋钮两个方向都生效）、`500` 这种非 32 对齐值**点名报错**而不是被悄悄接受。
  `docs/evidence/r5-budget-canvas-matrix.md` 之后又加了**画布侧警告**这条（放行）：1248×1248 + 896 有警告、同一笔预算在 0.82 MP 画布上**没有**、
  1.5MP 画布 + 512 也**没有**、插值区的画布（1216×1024 = 1.25 MP）照样触发并如实报出面积，
  以及覆盖开关放行时同一条 warning 里同时含覆盖与画布两侧；最后一条**防回潮**断言钉住
  「`≤896` 与『画布停在 1.5MP』并列」这条被 `docs/evidence/r5-budget-canvas-matrix.md` 证伪的说法不再出现在 README、
  **compose 后的 skill 正文**与 `lib/index.js` 里的工具文案三处
- `test/edit-e2e.test.mjs`：**参考图编辑**。参考 PNG 由测试自己生成（尺寸要真，所以不能拿假字节糊弄）：
  假 ComfyUI 收到 `/upload/image` multipart（**上传字节与参考图逐字节一致**、文件名按内容哈希）、
  图里 `images.image_1`/`images.image_2` 接对、`resolution` 跟着画布面积、`/view` 的字节逐字节落盘；
  `ratio_follow`（`image1` / 直接给路径 / 不传则默认第一张）换算出的画布与偏差；
  `wh_ratio` + `ratio_follow` 同时给时**在碰后端之前**就报错；11 张 / 空表 / 缺文件 / 目录 / 相对路径 /
  0 字节 / 非图片 / 非 base64 data URI / 空 base64 各自点名 `images[n]`；
  `backend: "api"` 拒收参考图（`auto` + 有 key 时跳过云后端并如实回报）；以及走**真 worker 契约**的那半：
  `images[]` 以 base64 逐字节到达本地 worker，而文生图请求连 `images` 这个键都没有；尺寸门**只在本地生效**：
  超预算画布走假 ComfyUI 照常出图（回执 `local_edit_budget: null`），而 `auto` 回退到 worker 时，
  尺寸门的文本完整地嵌在「两个后端都跑不了」的错误里（否则用户会以为只剩「腾显存」一条路）
- `test/vram-gate.test.mjs`：**启动前显存门禁 + opt-in `/free` + 崩溃兜底**（假 worker + 假 ComfyUI；
  阈值抬到卡上限之上，所以**不需要占用显存**，`nvidia-smi` 不存在时按 SKIP 处理而不是失败）：
  余量不足时拒绝拉起（不 spawn、日志文件都不创建）、错误里带空闲/阈值/缺口、点名的占用者、可粘贴的 `POST /free` 命令；
  `status.worker_start_gate` 给出同一份判决（`would_refuse_start` / `shortfall_MiB` / `remedy` / `auto_free_enabled`）；
  **默认 `freeComfyBeforeLocalStart: false` 时假 ComfyUI 收到 0 个请求**（副作用为 0）、
  开启后恰好 1 次 `POST /free` 且 body 为 `{"unload_models":true,"free_memory":true}`、释放后仍不足就如实拒绝；
  门禁已满足时**任何请求都不发**；`minFreeVramMiB:0` 时门禁完全不参与（`vram_gate: null`）；
  worker 以 `3221225477`（`0xC0000005`）死在加载阶段的错误里含原因、实时显存、占用者与补救命令；
  worker 回报的 `stages_s` 逐字段出现在 `local_worker.stages_s` 里；
  另外用**注入的假 GPU 读数**（`probeVram`，不碰真卡）钉住门禁的措辞分档：**点名了占用者**时给针对它的
  `/free` 命令、**一个占用者都没报出来**时明说那是分配器缓存（`cudaMallocAsync` / 3.6 GiB）并给出
  `/free` + 「隔十几秒重试（`OSError 1455`）」、**放行但有占用者**时 `vram_gate.warning` 点名它们、
  空卡放行则完全没有警告（`status` 侧的 `no_visible_holder` / `suspicion` 同一套判断）
- `test/live-worker-e2e.mjs`：**真机端到端**（不在 `npm test` 里，需要 GPU + 10.63 GiB 权重）。  设 `FORGE_LIVE_WORKER=1`、`FORGE_LIVE_PYTHON=<venv python>`、`FORGE_LIVE_MODELS=<权重目录>` 后运行：
  真 `status` → 冷启动出图（打印 PNG 绝对路径与 IHDR）→ 外部杀掉 → 自动重拉再出图 →
  `nvidia-smi` 前后对照的 `/unload` → 卸载后重新加载再出图
- `test/live-edit-e2e.mjs`：**编辑的真机端到端**（不在 `npm test` 里）。`node test/live-edit-e2e.mjs [comfyui|local|both]`：
  真 ComfyUI（上传参考图 → 官方改图工作流 → 出图，并从 ComfyUI 自己的 `/history` 里取回**它记录的节点清单**）与
  真受管 worker（冷启动 → 编辑出图 → `unload` 交回显存 → dispose 停进程），两条都打印 PNG 绝对路径 + IHDR
  （宽高/bitDepth/colorType）。路径默认取本机（`_m0\venv`、`_m0\models`、`_comfyui_ref`、`_integration`），可用
  `FORGE_LIVE_*` 覆盖。

（用 `node test/xxx.test.mjs` 逐个跑，而不是 `node --test`：后者会 spawn 子进程并通过管道取输出，
在受限沙箱里会 `EPERM`。）

