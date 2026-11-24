# dsh-image-forge Settings 2.0 设计 QA

## 结论

设置页 2.0 已实现并完成浏览器、单元测试与全量回归验收。插件「生图配置」分区现在是一个可运行的配置控制台：常用 / 高级双标签、ComfyUI 实时环境、最近日志、16 个字段统一草稿、逐项校验、顺序保存与失败回滚都已落地。

验收结论：**passed**。设置页 QA 报告 `ok = true`，没有 console error、failed request 或横向溢出；全量 `pnpm test` 通过。

## 页面结构

- **常用**：
  - ComfyUI 运行环境卡；
  - `comfyEndpoint`、`comfyPorts`、`comfyModelsDir`；
  - `comfyModel`、`defaultSteps`；
  - `outputDir`、`timeoutMs`。
- **高级**：
  - `comfyuiSteps`、`mossSampling`、`turboSteps`；
  - `executionBackend`、`comfyMcpBin`、`comfyBin`、`backendTimeoutMs`、`mcpDebug`、`backendTmpDir`。
- 16 个配置字段全部覆盖且只出现一次。
- 标签带未保存数量徽标；切换标签保留草稿。
- 宽屏双列、窄容器单列；顶部标签可横向滚动；保存栏固定在内容底部。
- 页面本身正常滚动，只有日志控制台拥有独立内部滚动。

## 运行环境与日志

- 复用 `environment-client` 的共享快照，与工作台和日志页保持同一份状态。
- 分开显示：
  - ComfyUI 进程状态；
  - 模型与生成能力；
  - 端点、PID、进程归属；
  - 日志路径、失败原因、停止阻断原因和下一步建议。
- 提供启动、停止、重新检测；插件拉起的实例即使模型未就绪仍可停止，外部实例明确禁用停止。
- 连接、模型或模型目录存在未保存修改时，环境操作禁用并提示先保存。
- 最近日志默认显示最近 80 行：
  - 日志展开、常用标签激活且页面可见时每 2 秒跟随；
  - 收起或切到高级后停止轮询；
  - 用户向上滚动时暂停，可继续跟随；
  - 支持刷新和复制；
  - 空日志、无日志路径、读取失败都有明确状态。

## 统一保存事务

- 所有修改先进入本地草稿，不再失焦即写。
- 保存前统一校验数字范围、HTTP(S) 地址和端口列表。
- 空的可选数字与“恢复默认”通过 `unset` 写入。
- 保存前比较 revision；外部配置已变化时停止写入并要求重新载入。
- 正常保存按字段顺序写入；失败时逆序回滚此前尝试的字段。
- 回滚成功保留草稿并提示“已尝试回滚”；回滚部分失败会列出未回滚字段。
- 支持 `Ctrl/Cmd+S`、放弃更改、未保存离开提示、保存进度和结果反馈。
- 因 DSH form 没有事务接口，回滚只保证恢复用户可见的有效值，不保证恢复配置文档中“显式值 / 默认回退”的内部来源。

## 最终实现证据

| 表面 | 截图 |
| --- | --- |
| 常用 · 1335 亮色 | `verify\qa-20261124\settings22-basic-1335-light.png` |
| 高级 · 1335 亮色 | `verify\qa-20261124\settings22-advanced-1335-light.png` |
| 常用 · 1200 亮色 | `verify\qa-20261124\settings22-basic-1200-light.png` |
| 常用 · 1500 亮色 | `verify\qa-20261124\settings22-basic-1500-light.png` |
| 常用 · 1600 亮色 | `verify\qa-20261124\settings22-basic-1600-light.png` |
| 高级 · 1600 暗色 | `verify\qa-20261124\settings22-advanced-1600-dark.png` |

- 浏览器报告：`verify\qa-20261124\settings-report.json`
- 全量测试日志：`verify\qa-20261124\pnpm-test-settings.log`

## 浏览器自动验收

- 顶部标签：`常用`、`高级`。
- 常用字段：7 项；高级字段：9 项。
- ComfyUI 环境卡：进程在线、生成能力已就绪。
- 最近日志：7 行，控制台高度固定并独立滚动。
- 保存栏可见，底部仍在视口内。
- 修改环境端点后：
  - 顶部显示未保存数量；
  - 停止和重新检测按钮被禁用；
  - 显示“先保存连接配置”说明。
- 保存成功后端点写入新值，未保存计数归零。
- 制造 `comfyModelsDir` 写入失败后：
  - 端点、端口和模型目录恢复原值；
  - 保存调用中出现逆序回滚；
  - 草稿和错误提示保留。
- 1200px 与 1600px 下均无横向溢出。
- 亮色与暗色主题均可读。
- `consoleErrors = []`，`failedRequests = []`。

## Accessibility

- 标签实现 `tablist / tab / tabpanel`、`aria-selected`、`aria-controls` 和方向键 / `Home` / `End` 导航。
- 每个字段有真实 `label`、提示和错误关联；错误控件设置 `aria-invalid`。
- 保存结果使用 `role="status"`，阻断错误使用 `role="alert"`。
- 日志控制台是可聚焦的 `role="log"` 滚动区域。
- 所有可操作按钮和控件具备可见焦点态；窄屏保存栏改为普通文档流，避免覆盖内容。

## Verification

- `pnpm test`：全部通过。
- `node test/dev/preview/settings-shot.mjs`：通过，`settings-report.json.ok = true`。
- `pnpm exec tsdown -c tsdown.config.ts`：通过。
- `pnpm exec tsdown -c tsdown.client.config.ts`：通过。
- `lib/client.js`：1,296,337 B raw，331,415 B gzip，仍在更新后的 bundle 预算内。
- `git diff --check`：通过。

## Real-host limitations

- 真实 DSH 桌面宿主仍需安装当前 worktree 后复验设置分区挂载、日志路由和环境操作。
- 宿主内部 SPA 导航无法被插件完全拦截；离开页面前只能通过浏览器 `beforeunload` 提示未保存草稿。
- 用户自行启动的 ComfyUI 永远不由插件停止。
- 本轮未修改已安装 profile：`D:\file\qwen生图插件\dsh-image-forge`。

## Implementation checklist

- [x] 常用 / 高级双标签与 16 字段完整覆盖。
- [x] ComfyUI 进程、生成能力、所有权与诊断统一展示。
- [x] 最近日志自动跟随、暂停、刷新、复制和空态。
- [x] 统一草稿、字段校验、revision 冲突与快捷键保存。
- [x] 顺序写入、失败逆序回滚和部分回滚反馈。
- [x] 恢复默认、未保存徽标和 `beforeunload` 门禁。
- [x] 1200 / 1335 / 1500 / 1600px、亮暗主题与日志滚动验收。
- [x] 全量测试、host/client 构建和设计 QA 记录。

## Canvas interaction follow-up

- 工具坞展开不再由 `:hover` 直接驱动宽度；`pointerenter` 打开，`pointerleave` 立即进入关闭锁存，关闭动画期间 `pointer-events: none`，`transitionend` 后才恢复命中。
- QA 验证：悬停后 `52 → 158px`；移出后命中立即变为 `none`，动画中回到原区域仍保持 `52px`；动画结束后重新进入可恢复 `158px`。
- React Flow 的节点 wrapper 与节点本体统一为 `grab`，拖动态为 `grabbing`；只有真实按钮和连接手柄切换为 `pointer / crosshair`。
- QA 验证：wrapper cursor = `grab`，inner cursor = `grab`。
- `canvas22-report.json`：`ok = true`，console error 与 failed request 均为 0。

## Preview routes

- 图像工作台：`http://127.0.0.1:8390/`
- 设置页：`http://127.0.0.1:8390/settings`
- Better Sidebar：`http://127.0.0.1:8390/sidebar`
- 对话结果卡：`http://127.0.0.1:8390/result-card`

final result: passed




