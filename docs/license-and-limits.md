# 第三方与许可、已知边界（详细）

## 第三方与许可

本插件自身以 **MIT** 发布。与它协作的三方各自独立：

- **Qwen-Image-2.1 权重**：受 **Qwen RESEARCH LICENSE AGREEMENT** 约束，**限研究用途；商用需自行向权利方取得授权**。
  **权重归 Qwen 团队所有**，本插件仅按其许可使用、不主张任何权利。
  本插件**不随包分发任何权重**，但 `qwen_image_env action:"fetch-weights"` 会**按你的指令**从
  `hf-mirror.com` 拉取 `circulus/Qwen-Image-2.1-bnb-4bit`（10.63 GiB）到你的 `modelsDir`；
  是否下载由你决定，下载后的用途与合规由你负责。云端点不受此约束。
- **随包的 worker 脚本**（`resources/worker.py`）是本插件的一部分（MIT），它调用 diffusers /
  transformers / bitsandbytes / PyTorch（各自许可）来跑上述权重。
- **官方提示词文本**：本插件**不随包分发**任何 Qwen 官方提示词规范原文（`system_prompt_t2i.txt` /
  `guide_t2i.md` / `guide_edit.md` 等）。`skill.md` 与 `references/*.md` 是本插件**自撰**的规则文档；
  输出契约字段名（`rewritten_prompt` / `wh_ratio` / `ratio_follow`）沿用公开契约形状以便互操作。
- **ComfyUI**：**可选的外部依赖**（GPL-3.0）。本插件不包含、不修改、不分发 ComfyUI 代码，
  只通过 HTTP 与用户自行安装的实例通信；是否安装与本插件的 MIT 许可无关。
- **云 API 供应商**：由用户自带 key 并自行遵守对应服务条款；本插件只转发请求、不代理、不转存。

## 已知边界（v0.1）

- 云 API 后端**没有编辑通道**：`qwen_image_edit` 只走本机（`comfyui` / `local`）。
  云端的编辑是另一种请求形态（multipart `/images/edits`，或 DashScope 的原生异步任务接口），
  未实现；显式指定 `backend: "api"` 会明确报错，而不是把参考图丢掉。
- worker 侧的编辑路径需要给 `QwenImage21Pipeline.__call__` 补一个 `image_pad_mask`
  （它自己没有这个参数，而 `encode_prompt` 在「同时给 embeddings 与参考图」时强制要求）。
  做法是**只在这次调用期间**给该实例装一个转发包装，采样一结束立刻还原；文本编码器仍留在 CPU。
  实测「直接把 `prompt` 与 `image` 交给管线、让它自己编码」这条更漂亮的写法**不可用**
  （它在 `self._execution_device` 上编码，而文本编码器在 CPU：`Expected all tensors to be on the same device`）。
- 参考图的像素尺寸只认 PNG / JPEG / WebP 的文件头；其它容器（含 TIFF、AVIF）会被拒绝并给出原因。
- 没有局部重绘（inpaint / mask）、放大、相册 UI。
- `qwen_image_env action:"fetch-weights"` 的 `skipLmHead` 只在本机的**合成** safetensors 上验证过
  （文件重写 + 偏移量校验）；**没有**在真实 5.8 GiB 的 `text_encoder/model.safetensors` 上验证过
  「剔除 lm_head 后 transformers 仍能加载」，所以默认 `false`。
- 真实设备上只验证过 cu126 这一档（`torch 2.9.1+cu126`）；cu128 / cu118 是同一段矩阵代码里的备选路径，
  **未在真机下载验证过**。
- 冷启动实测约 10.5 s（Windows，权重已在页缓存里）；2K/8 步约 49 s（M0 spike 实测）。
  > 这条里原先还有「首次生成 992×992/8 步约 19 s」，**已被撤回**：后来的步数扫描在同样条件下测到
  > `local` 8 步 = **28.20 s**、4 步 = **18.81 s**，`19 s` 复现不出来（按受污染读数处理）。
  > 每步成本与跨后端倍率请以[设置页 → Qwen 出图](configuration.md#设置页dsh-web-gui)里的**斜率表**为准。
- **编辑路径在 8 GiB 卡上有实测的硬边界**（1312×736：ComfyUI 8 步 ≈ 19–23 s，受管 worker 6 步 ≈ 219 s）：
  根因是显存**超额认购**——编辑的联合序列 ≈ 7576 token，把 `reserved` 顶到 8666 MiB **越过 8188 MiB 物理上限**，
  驱动走 WDDM 分页，于是每步 20–40 s。**不是** bnb 逐层换入换出的锅（旧的猜测已实测排除：
  同一轮里把参考图预算减半即可把每步从 23.4 s 压到 1.7 s，全程没有 offload 参与）。
  分阶段数字、方法与"8 GB 卡上编辑优先用 `comfyui`"的结论见[后端 → 本地编辑为什么慢](backends.md#本地编辑为什么慢8-gb-卡上请优先用-comfyui)。
  把参考图预算调小能换回十几倍，但会牺牲编辑保真度，所以本包**不擅自改默认值**——取而代之的是
  [后端 → 本地编辑尺寸门](backends.md#本地编辑尺寸门只在-local-后端生效)：七档默认画布在 `local` 上预算都是 1216–1248，因此默认会被**明确拒绝**
  （而不是把一个已知必崩的请求送进 worker），要跑得显式开 `allowLocalEditOverBudget`，
  或把 `localReferenceBudget` 调到 **512**（1.5MP 画布上唯一实测跑得完的档：109.5 s / reserved 6488 MiB /
  worker 存活——**别照搬 896**：896 在同一张 1248×1248 上是 67 s/步、≈28 min，不报错但等于不可用；
  保真度：同画布 896 vs 512 目视看不出差别，n=1、1 位评判者）。
  「不擅自改默认值」仍然成立：旋钮的默认值就是 `0` = 与今天完全一致）。
- `install` 只实现到「建 venv + 装 torch + 装 worker 依赖」；CUDA toolkit、显卡驱动、Visual C++ 运行库
  由用户自己保证（装不上 torch 会在步骤里原文报出 pip 输出）。
- **判断「某个 pid 还活着」在本机不可靠**：Windows 的 libuv 没实现 signal 0（对活进程也抛 `ESRCH`），
  `tasklist` 在受限沙箱里被拒绝。所以插件的「僵死 worker」判定只用**自己能掌握的证词**——它持有的子进程句柄
  与 worker 自己写的 `worker-state.json`；`repair` **只停止本会话自己拉起的那个进程**，对历史记录里的 pid
  只报告并给出 `taskkill` 命令，不代替用户杀进程。代价：跨会话的僵死 worker 需要用户自己 `taskkill`（或直接再出图，
  插件会另选端口另起一个）。
- 客户端 4 个工具都有 `tool.call.toolview` 卡片，设置页有布局样式（含窄栏容器查询）；
  **仍未在真实 web 客户端里验证过**。图片显示的**主路径**始终是工具结果里的 Markdown 绝对路径。
