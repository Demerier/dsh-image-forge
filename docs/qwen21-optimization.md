# Qwen-Image 2.1 使用优化方案

> 本文档是插件转为**仅本机 ComfyUI** 后的画质与性能优化总纲：先核对插件当前发出的每一张工作流
> 与官方权威口径的差异，再汇总全网可查的实测经验，最后落成按优先级排序的改造清单。
> 每一条结论都带来源；官方一手材料优先，社区实测必须带来源与数字，孤证单独标注。
>
> 状态标记：✅ 已落实进代码 · 📋 待实施（有明确改法）· 🔬 需先做对照实验。
> 「插件现状」以 0.2.x 裁剪后的代码为准（`src/comfyui.ts`）。
> 置信度：〔官方〕= 官方文档/模板/模型卡原话；〔多源〕= ≥3 个独立实测同向；
> 〔双源〕= 2 个独立来源；〔孤证〕= 单一来源，采纳前需自测。

---

## 一、现状基线：插件发给 ComfyUI 的每一项

| 项 | 插件现状 | 官方口径 | 判定 |
|---|---|---|---|
| base t2i 采样 | KSampler，steps 25、cfg 1、euler、simple、denoise 1 | 同左（官方模板内层 KSampler；模板注释：官方 pipeline 用 40–50 步，模板从 25 起步） | ✅ 一致 |
| base edit 采样 | 同上 | 同左 | ✅ 一致 |
| negative_prompt | `''` | `''`（官方 PE 契约：*"always ''*; neither model emits one"*；cfg 1 时 ComfyUI 跳过负向条件化） | ✅ 一致 |
| turbo 结构 | RandomNoise + CFGGuider + KSamplerSelect(euler) + ManualSigmas + SamplerCustomAdvanced | 同左 | ✅ 一致 |
| turbo sigmas | `1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0`（8 步） | 官方模板逐字一致 | ✅ 一致 |
| turbo t2i cfg | 1 | 1 | ✅ 一致 |
| turbo edit cfg | ~~8~~ → **1** | 1（模板 JSON 里的 `[8]` 是 widget 转输入后的死值；docs.comfy.org、Comfy-Org 模型卡、Turbo 模型卡三处均为 1） | ✅ 已修（原实现把模板残留值当成了官方意图） |
| 权重选择 | `/object_info` 枚举 + 名字打分，不硬编码文件名 | — | ✅ 合理 |
| 参考图上限 | 10 张（`images.image_1..10`） | 官方模板接 10（节点支持 16 槽） | ✅ 一致 |
| `<imageN>` 契约 | 提示词里 `<image1>`… 与 Qwen3-VL 编码器自动插入的 vision 锚点对齐 | 同左 | ✅ 一致（但单参考图场景官方要求自然指代，见 §三-④-4） |
| t2i 画布 | 32 对齐 ~1.5MP（七档表） | 模板默认 1.0MP（1024²）；官方模型卡默认 2048²（2K，≈4.2MP 七档表） | 📋 见 §四-1 |
| edit 的 `resolution` | 与画布面积等效边长（`sqrt(w*h)` 取整 32） | 官方 edit 模板喂 **0**（参考图保持原尺寸仅 32 取整）；节点默认 1024；语义=「等效边长像素预算，按原宽高比缩放」 | 📋 见 §四-2 |
| edit 采样画布 | 独立 EmptyLatentImage（插件算好的画布） | **官方 edit 模板的采样 latent 来自编码节点的 `latent` 输出**（= image_1 按预算缩放后的尺寸）；节点 tooltip 明示「any other size shifts the edit」 | 🔬 见 §四-3（与 count 批量语义有冲突，需实验定方案） |
| QwenImage21Cache | 无 | 官方 t2i 模板在 UNETLoader 后串 `QwenImage21Cache(device=auto, dtype=default)` | 📋 见 §四-4 |

官方一手来源（逐字段核对过模板 JSON 与节点源码）：

- 官方模板（Comfy-Org/workflow_templates）：`image_qwen_image_2_1_t2i.json`、
  `image_qwen_image_2_1_image_edit.json`、`image_qwen_image_2_1_turbo_t2i.json`、
  `image_qwen_image_2_1_turbo_image_edit.json`
  （https://github.com/Comfy-Org/workflow_templates/blob/main/templates/ ）
- 节点语义：comfyanonymous/ComfyUI `comfy_extras/nodes_qwen.py`
  （https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_qwen.py ）——
  `resolution` 定义：*"Reference images are resized to about resolution x resolution pixels, at multiples of
  32, preserving aspect ratio. 0 keeps each reference at its own size, rounded to a multiple of 32."*
  `latent` 输出 tooltip：*"Empty latent on the first reference image's size, to match with sampling as any
  other size shifts the edit."*
- 官方教程（参数与负向词解释）：https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1
- 模型卡：https://github.com/QwenLM/Qwen-Image-2.1 、https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo 、
  https://huggingface.co/Comfy-Org/Qwen-Image-2.1
- 文本编码器接线：comfyanonymous/ComfyUI `comfy/text_encoders/qwen_image21.py`
  （系统提示 `"Comprehend and analyze the provided prompt."`；有参考图时自动在用户文本前拼
  `<imageN> <|vision_start|><|image_pad|><|vision_end|>`，接了 vae 时 vision token 交给 DiT 侧 reference_latents）

---

## 二、官方口径要点（改动决策的依据）

1. **cfg 恒为 1**。官方全系列模板（base t2i / base edit / turbo t2i / turbo edit）cfg 都是 1；
   docs.comfy.org 明说 cfg 1 时负向条件化被跳过，负向提示词**不起作用**。模板注释原话：
   「cfg: keep 1 for the Qwen Image 2.1 official path. Raise it only if you use a negative prompt.」
   ——即「想要 cfg>1 必须同时给负向词」，与 §三-① 的社区实验互相印证。
2. **官方 pipeline 步数是 40–50**（euler），模板默认 25 是「起步值」。官方教程对 25→40 的收益有定量描述：
   *"going from 25 to 40 steps reduces fizzle in detailed areas"*、
   *"Stubborn fine detail such as hands and fingers settles by about 30 steps"*、
   *"Adjust `steps` only when something specific fails to resolve."*
3. **edit 的画布与参考图缩放是一体的**：`resolution` 是「等效边长」预算（总面积 ≈ resolution²），
   逐张 lanczos 缩放并保持各图宽高比；默认路径下采样画布就是编码节点输出的 latent（image_1 的缩放结果）。
   「自定义画布」是模板的 switch 可选项，官方提醒：自定义尺寸要**贴近缩放后的 image_1 尺寸**，否则编辑会漂移。
4. **2K 是官方默认档**：模型卡默认 2048²，并给出 4.2MP 档的官方七档表
   （1:1 → 2048×2048、4:3 → 2400×1792、3:2 → 2528×1696、16:9 → 2752×1536、9:16 → 1536×2752 等）。
   1.5MP 是本插件为 8 GB 卡自定的档位，在支持范围内但不是官方默认。
5. **RGBA 透明输出是官方能力**：模型卡给出 RGBA 提示词模板
   （*"This is an RGBA image with transparency. … The image has alpha channel and the background is transparent."*），
   VAE 是 64 通道 RGBA。插件 0.2.x 已删掉 `transparent` 参数（原实现里 ComfyUI 路径本来就不处理），
   §四-6 给出恢复它的正确做法。
6. **上限警告**：*"Targets well above the model's 2K trained size, such as 4K, lose prompt adherence."*
   （docs.comfy.org）——2K 是质量甜点，4K 会丢提示词贴合度。

---

## 三、社区实测经验（全网汇总）

### ① CFG 与负向提示词

**机制前提〔官方〕**：cfg 1 时 ComfyUI 跳过负向条件化，负向词无效；官方对提升 CFG 的定量描述
（https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1 ）：
- *"`cfg` 2 follows dense prompts more closely, including small text and numbers, at the cost of over-sharpened edges."*
- *"Higher values shift exposure toward over-bright or over-dim, `cfg` 5 degrades quality badly, and `cfg` 0.5 breaks the image."*
- *"Change one value at a time, and compare at a fixed seed."*

**锁种子对照实测〔多源〕**（r/StableDiffusion《Qwen 2.1 CFG Testing》
https://www.reddit.com/r/StableDiffusion/comments/1wncdot/qwen_21_cfg_testing ）：
- 计时：CFG 1.0 @ 25 步 ≈ 10 s；CFG>1 同步数 ≈ 20 s（两次前向，时间翻倍）。
- 楼主结论：*"20 steps at CFG 2.0-3.0 being the nice balance between time and quality"*。
- u/Calm_Mix_3776〔孤证〕：*"much better image quality with CFG at around 3.0-4.0… Its editing capabilities also improve with higher CFG."*
- u/Valuable_Issue_〔孤证〕：CFG 4 修 artifacts / 糊细节，*"CFG 1 35 steps VS CFG 4.0 25 steps, CFG 4.0 doesn't mush details"*（主脸反而怪）。

**CFG ≈ 3.5 + 负向词是当前社区最响亮的主张〔多源〕**：
- 《Qwen Image 2.1 Not Bad》（https://www.reddit.com/r/StableDiffusion/comments/1wnr5u8/qwen_image_21_not_bad ）：*"The key is CFG > 1*（配 res_multistep / RES4LYF abnorsett_3m + beta_57 调度器 + AuraFlow shift≈16）*… Don't forget to use negative prompt, helps immensely."* 负向词用法示例：*"tired of yellow piss filter? Just put 'overly warm color temperature' into negatives."*
- 《Qwen2.1, I am sorry man…》（https://www.reddit.com/r/StableDiffusion/comments/1wp52r7/qwen21_i_am_sorry_man_i_take_my_statement_back ）：*"with short prompts CFG=3.5 is much better… even with prompt-enhancer-generated prompts [it] benefits from CFG>1, though the sweet spot seems a bit lower than 3.5"*（**PE 扩写过的长提示词最优点 < 3.5**——本插件的提示词正是 PE 契约风格）。
- 《After initial tests…》（https://www.reddit.com/r/StableDiffusion/comments/1wlhh8v/after_initial_tests_qwen_image_21_quality_is ）：*"massively benefits from positive CFG, somewhere around 4"*；50 步 + CFG 4.5 更好但仍偏黄。
- HF 官方仓库讨论区（https://huggingface.co/Comfy-Org/Qwen-Image-2.1/discussions/14 ）：畸形/昏暗泛黄 → 提高 CFG + 负向词。
- 反面：CFG 7 + 40 步的激进组合被普遍认为过头（搜索摘要级）。

**黄偏移是 cfg>1 的主要副作用〔多源〕**：三个独立帖同向（"The higher the CFG, the more yellow they get"、
"yellow/orange tint"、负向词 "overly warm color temperature" 抵消）。

**改图 + 真实 CFG 的风险〔孤证〕**：HF 论坛 3 参考图编辑帖——真实 CFG 下出 artifacts、
Lightning LoRA 下正常，且依赖参考图内容。
（https://discuss.huggingface.co/t/multi-image-edit-3-refs-artifacts-at-true-cfg-fine-on-lightning-reference-content-dependent/ ）

### ② 采样器 / 调度器

- **euler/simple 是无争议默认**〔官方+双源〕：官方模板即此组合；*"Euler simple is the safest combination
  for flow models."*（CFG 测试帖）；Qwen 官方推理引擎（vllm/sglang/diffusers）默认也是 euler 类。
  **没有出现「必须换采样器」的共识。**
- **画质向升级方向（全部〔孤证/轶闻〕，无严格对照）**：res_multistep（CFG 测试帖楼主全部对照用它）；
  RES4LYF 的 abnorsett_3m + beta_57 调度器 + ModelSamplingAuraFlow shift≈16（Not Bad 帖主配方，
  *"Sigmas curve is the only thing which matters"*）；er_sde + beta；DPMPP_SDE_GPU + Beta；
  Huen（*"nice sigma churn during steps that can really increase details"*）。
- **官方对 turbo 的警告适用于一切调度实验**：*"so raise the step count only together with a different schedule."*

### ③ 步数：25 vs 40 vs 50

- 官方 GitHub 推荐 `num_inference_steps: 40`（https://github.com/QwenLM/Qwen-Image-2.1 ）；社区交叉印证：
  *"the only thing the default Comfy workflow changes from the Qwen Image 2.1 github's recommendations is
  dropping steps to 25 from 40."*（sorry-man 帖）
- 官方教程收益描述见 §二-2。社区〔多源〕：*"The default 25 steps isn't enough either for top quality, try 40-50."*、
  *"That model clearly needs his 40 steps and cfg should be between 2 and 3."*、HF 讨论区 "Use 40 steps"。
- **优先级排序〔多源，重要〕**：步数的收益**小于** underprompting / CFG / 分辨率三条，但*"it certainly
  doesn't hurt to add some steps"*（sorry-man 帖主）。
- 成本：时间 ≈ 线性，40 步 ≈ 1.6 × 25 步（CFG 测试帖计时外推）。

### ④ 改图实践

1. **identity 的载体就是 VL 编码器**〔实测帖〕：*"Cropped image goes into image_1 on TextEncodeQwenImage21.
   There's no ReferenceLatent here; the VL encoder reading the source image IS the reference mechanism.
   Skip this wire and the model fills your mask blind, from prompt alone."*
   （r/StableDiffusion mask inpainting 帖 https://www.reddit.com/r/StableDiffusion/comments/1woo79h/ ）
   —— 插件的 edit 图正确接了 vae 进编码节点，机制与社区最佳实践一致。
2. **整图编辑的漂移是真实痛点〔双源〕**：*"faces, hands, and textures drift a little on every pass"*（mask 帖）；
   *"the character never was at the exact position it was before the edit (same input/output res & ratio)"*
   （sorry-man 帖）。中文社区应对〔孤证〕：编辑 denoise 锁 ≈0.55（0.45–0.60）+ 负向词
   "face distortion、character drift、deformed face"
   （https://github.com/feixiao/ai/blob/main/ComfyUI/qwen_image_2.1/README.md ）。
   ⚠️ 本插件改图 denoise 恒为 1（整图重生成），这是插件与社区实践差距最大的点，但 denoise<1 需要额外
   latent 注入接线，列入 §四-5 实验。
3. **mask 局部重绘是像素级护栏**〔实测帖〕：*"The mask is a pixel guarantee: outside it, nothing can change,
   period."*——插件不做局部重绘（产品边界明确），但值得在文档里指路。
4. **单参考图时官方契约要求自然指代、禁用 `<image1>` 标签**〔官方契约〕：guide_edit
   （镜像 https://raw.githubusercontent.com/klfzqxs/qwen-image-2.1-prompt-optimizer/main/core/guide_edit.md ）：
   标签格式 *"mandatory and non-negotiable"* **仅针对多图**；单图禁用标签、自然指代。
   ⚠️ 插件目前对单参考也统一加 `<image1>`，与官方契约有张力（skill/reference 文档需微调）。
5. **保留性描述要抽象**〔官方契约〕：*"Preservation locks content, never edit strength"*；
   未触碰元素按 *"by type, position and role"* + 一句总括保留条款——*"concrete descriptions of preserved
   content can cause drift."*（描述得越具体越容易漂移）
6. **输出比例 ≠ image_1 时**：官方路径是 custom_size 并让画布贴近缩放后的 image_1 尺寸
   （*"or the edit can shift"*）；Qwen 官方提示词契约用 `wh_ratio`（与 `ratio_follow` 互斥）表达，
   *"Ignoring them and rendering at the source image's ratio discards a real part of the rewrite."*
   —— 插件的 wh_ratio/width+height 路径即官方 custom_size 语义，文档已带警告。
7. **2.1 外画布扩图免 Pad 节点**〔轶闻但实用〕：*"just plug in the resolution you want and use the prompt
   exactly as how you would use with pad node."*（sorry-man 帖）

### ⑤ 画面文字渲染

- **分辨率是决定变量〔多源〕**：*"images generated at 2MP or 4MP look significantly better than those
  generated at 1MP"*（sorry-man 帖）；小字精度 *"at up to 2752 pixels, with precision that scales with
  resolution"*（HF 声明转述，2752 = 官方 16:9 档宽）；*"the ability to do complex elegant typography at 2k"*
  （After-initial-tests 帖）。
- **cfg 2 对小字有官方背书**：*"cfg 2 follows dense prompts more closely, including small text and numbers."*
- **提示词写法〔官方契约〕**：图内文字逐字符照抄、放直双引号内、描述字重/颜色/大小写/字号；
  不可读处写 *"blurred, indistinct, or too small to read"* 而不是编造；*"A third of images have no text, and
  inventing signage for them 'is a mistake.'"*——插件 skill 的规则与之一致。
- 已知失败模式〔轶闻〕：黄偏移；编辑场景文字/物件尺寸失真；VAE 网格纹与超分链路互相打架。

### ⑥ 权重量化与显存（8 GB 卡）

**官方仓库变体表（HF API blob 逐字节核实）**
（https://huggingface.co/Comfy-Org/Qwen-Image-2.1 ）：〔官方〕

| 文件 | 体积 | 说明 |
|---|---|---|
| `diffusion_models/qwen_image_2.1_bf16.safetensors` | ≈ 13.25 GiB | base 全量，16 GB+ 卡用 |
| `diffusion_models/qwen_image_2.1_int8_convrot.safetensors` | ≈ **6.76 GiB** | 8 GB 首选 DiT |
| `diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors` | ≈ 6.76 GiB | 8 GB + turbo 首选 |
| `text_encoders/qwen3vl_8b_bf16.safetensors` | ≈ 16.33 GiB | 8 GB 不可驻留 |
| `text_encoders/qwen3vl_8b_int8_convrot.safetensors` | ≈ 8.71 GiB | 需 offload |
| `text_encoders/qwen3vl_8b_w4a8.safetensors` | ≈ **5.88 GiB** | 8 GB 首选 TE（比 int8 省 ~2.8 GiB） |
| `vae/qwen_image_2.1_vae_bf16.safetensors` | ≈ 0.63 GiB | 仅此一档 |
| `loras/qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors` | ≈ 0.85 GiB | base 模型 + turbo LoRA 的替代方案 |

- **官方 2.1 仓库没有 fp8 DiT**（fp8 是上一代 2509 的做法）——按名匹配 `fp8` 永远落空，
  应匹配 `int8_convrot`。插件现有打分逻辑（`/int8/i` 加权）方向正确：同屏有 bf16 与 int8 时 int8 胜出。
- **convrot**：QuaRot 一类 Hadamard 旋转式离群值抑制量化，ComfyUI 团队适配为原生 INT8；
  作者说明见 ComfyUI issue #14735（https://github.com/Comfy-Org/ComfyUI/issues/14735 ）。
  质量反例〔孤证〕：同 seed 下 int8_convrot 比 Q8_0 GGUF 更易肢体扭曲，且在 5060 Ti 16GB 上
  慢 ~1.7×（≈13.4 vs 7.9 s/步，issue #16470 https://github.com/Comfy-Org/ComfyUI/issues/16470 ）。
- **8 GB 适配结论**：int8_convrot DiT（6.76）+ w4a8 TE（5.88，驻 RAM/offload）+ VAE（0.63）是唯一
  勉强闭环的组合，编辑图还要叠加参考 latent。4060 Ti 16GB 不做 offload 峰值已 ~15 GB
  （HF Discussion #35 https://huggingface.co/Qwen/Qwen-Image-2.1/discussions/35 ）——8 GB 必然走 offload。
- **ComfyUI 显存策略（dynamic VRAM 时代）**〔官方〕：
  - NVIDIA Win/Linux **默认已开 dynamic VRAM**：按需逐层 fault-in 权重而不是 OOM
    （https://blog.comfy.org/p/dynamic-vram-in-comfyui-saving-local ）。
  - `--lowvram` 在 dynamic VRAM 开启时**无效**；`--novram` / `--highvram` / `--gpu-only` / `--cpu`
    会**关掉**它（反而更糟）。新调节项：`--dynamic-vram`、`--vram-headroom N`、`--fast-disk`
    （https://docs.comfy.org/development/comfyui-server/startup-flags ）。
  - 文本编码器跟随 dynamic VRAM（changelog 明载 TE 驻留策略）；8 GB 上让它 offload 是正解。
  - **`/free` 不要在轮次之间调**：`free_memory=true` 清 VRAM、`unload_models=true` 连 RAM 一起清，
    都会迫使下一轮重载模型；交给 ComfyUI 默认调度更优（源码语义已核实，
    https://docs.comfy.org/development/comfyui-server/comms_routes ）。
    configuration.md 里那条「3.6 GiB 分配器缓存 + POST /free」的旧结论**只适用于
    「卡被别的程序挤占、本轮必须立刻回收」的场景**，不是常规轮询手段。
  - ROCm 专属坑：`--enable-dynamic-vram` 有静默损坏输出的 bug（issue #16437），NVIDIA/Windows 不受影响。
- 8 GB 级 1MP–2MP 的每步秒数**未找到公开数据**（本机口径维持 configuration.md 的 0.727 s/步 @992²）。

### ⑦ QwenImage21Cache 与运行时提速

- **机制**〔官方〕：KV prefix cache——文本 token 与参考图 token 只算一次、全步复用；
  官方明说 **edit 工作流的大部分加速来自这里**。节点实验性，需 ComfyUI ≥ 0.37.0。
  https://docs.comfy.org/built-in-nodes/QwenImage21Cache 、https://comfy.org/qwen-image-2.1
- **四档 device**：`auto`（默认：先用空闲 VRAM，不够落 RAM 并预取）/ `gpu`（全驻）/ `cpu`（RAM+预取，
  速度损失很小）/ `off`（禁用）。**三档 dtype**：`default` 无损 / `int8` 体积减半约 bf16 级 / `int4` 体积 1/4。
- **优雅降级**〔官方〕：放不下就重算前缀而不是挤崩 run——设大了只会变慢不会失败。
- **已知 bug 集中在 `gpu` 档**：#16879（macOS MPS，edit 冷启动产出错误图 + 档位切换后缓存不一致）、
  #16900（gpu 档流式权重损坏）。⇒ **用 `auto`，避开 `gpu`**（https://github.com/Comfy-Org/ComfyUI/issues/16879 、
  https://github.com/Comfy-Org/ComfyUI/issues/16900 ）。
- **带硬件对照的加速数字：未找到公开数据**。社区侧写〔轶闻，机制不同需区分〕：SageAttention + EasyCache
  在 2 参考图时 ~11 s 出图；第三方 Spectrum 节点 3060 12GB 上 >2×。QwenImage21Cache 本身的 A/B
  要靠 §五-4 的实验补。
- turbo 图同样受益（前缀复用与步数无关）；文档未载明对 SamplerCustomAdvanced 的限制，也未检索到不兼容报告。

---

## 四、改造清单（按优先级）

| # | 优先级 | 改动 | 依据 | 状态 |
|---|---|---|---|---|
| 1 | **P0** | turbo edit cfg 8 → 1 | 官方三处口径；cfg 8 + 空负向词在 CFGGuider 路径上实质劣化改图 | ✅ 已修 |
| 2 | **P1** | base 默认步数 25 → **40**（t2i 与 edit 同步；turbo 不动） | 〔官方+多源〕官方 GitHub 推荐 40；"reduces fizzle"、"hands settle by ~30 steps"；社区优先级排序确认收益真实。代价 ≈1.6×时间 | 📋 改 `defaultSteps` 默认值 + 文档 |
| 3 | **P1** | 新增「质量档」：cfg 2.5–3 + 默认负向词集（base 路径，t2i 优先；edit 单参考可用 cfg 2，**多参考保持 cfg 1**） | 〔官方+多源〕官方 cfg2 定性 + 锁种子实测 + 三个社区帖；PE 长提示词最优点 < 3.5；黄偏移用负向词 "overly warm color temperature" 抵消；多参考+真实 CFG 出 artifacts〔孤证〕需回避 | 📋 工具加 `cfg` / `negative_prompt` 参数；时间翻倍要写进返回值 |
| 4 | **P1** | 2K/4MP 画幅档（画面含文字时在文档/skill 层强制建议） | 〔官方+多源〕官方 4.2MP 七档表；2MP/4MP 显著好于 1MP；小字精度随分辨率提升；上限 2K（4K 丢贴合度） | 📋 `DEFAULT_SIZES` 增补官方 4.2MP 档或 `pixel_budget` 参数 |
| 5 | **P2** | edit 画布对齐官方语义：默认路径（ratio_follow）改从编码节点 `latent` 输出取采样画布，`resolution` 对齐画布预算 | 〔官方〕"any other size shifts the edit"；需先解决 count>1 的批量语义（encode latent 无 batch），故标实验 | 🔬 对照实验：同 seed 下 latent 接线 vs EmptyLatentImage 的编辑漂移 |
| 6 | **P2** | base 与 turbo 两条链都接入 `QwenImage21Cache(device="auto", dtype="default")`（插在 UNETLoader 之后），**避开 `gpu` 档** | 〔官方〕t2i 模板既定结构、edit 加速大头、优雅降级不崩 run；已知 bug 集中在 gpu 档（#16879/#16900）；需 ComfyUI ≥ 0.37.0（在 `qwen_image_status` 里提示版本）；A/B 数字待 §五-4 | 📋 改 4 张工作流图 + 版本兼容检查 |
| 7 | **P2** | 单参考图编辑改自然指代（去 `<image1>`），多参考保留标签；保留描述抽象化写进 edit_rules | 〔官方契约〕guide_edit 明文 | 📋 改 `references/edit_rules.md` + skill |
| 8 | **P2** | VAE 网格纹：文档指路 Nyquist Notch degrid 节点（不内置依赖） | 〔多源现象+双源方案〕halftone/diamond/crosshatch 纹；"extremely effective with pretty much no sharpness loss"；与超分链路有兼容性问题需注明 | 📋 docs 一段 |
| 9 | **P3** | 文本编码器优先档增补 `w4a8`（比 int8_convrot TE 省 ~2.8 GiB，8GB offload 场景更稳） | 〔官方文件表〕TE 三档体积；插件现打分 `/int8/i` 会压过 w4a8，需给 8GB 用户更优默认 | 📋 调整 `MODEL_KINDS.clip.bonus` + 文档 |
| 10 | **P3** | t2i 的 TextEncodeQwenImage21 `resolution` 1024 → 传画布面积等效值（与 edit 路径一致） | 影响不明（无参考图时该参数语义官方未说明），但对齐官方模板 ResolutionSelector 行为，成本低 | 📋 一行改动 + 盲测确认无回退 |
| 11 | **P3** | RGBA 透明输出恢复：按官方 RGBA 提示词模板 + 检查 VAE alpha 通道输出 | 〔官方〕模型卡有原生路径；0.2.x 删掉的 `transparent` 是因为旧实现不处理而非模型不支持 | 🔬 需实验：VAE 解码 alpha 后 PNG 落盘链路 |
| 12 | **P3** | 采样器高级档暴露（res_multistep / RES4LYF+beta_57+shift16 / er_sde+beta），默认保持 euler/simple | 替代组合全部〔孤证〕，无严格对照；默认合理性〔官方+双源〕 | 📋 可选参数，不做默认 |
| 13 | **P3** | 改图 denoise<1 档（锁 ≈0.55）做「轻改」模式 | 〔孤证〕中文社区实测；需加 latent 注入接线 | 🔬 实验后定 |
| 14 | **P3（文档）** | 显存指引更新：`--lowvram` 已失效、dynamic VRAM 默认开、`/free` 不做常规轮询（只限「卡被挤占、必须立即回收」场景）、turbo LoRA（913 MB）是低配卡替代路径 | 〔官方 flag 文档 + 源码语义〕configuration.md 的 /free 条目需限定场景 | 📋 改 configuration.md + deployment 文档 |

---

## 五、实验计划（把 🔬 变 📋 的最小路径）

全部沿用仓库现有的盲测基建（`test/blind-*.mjs`，同 prompt 同 seed 出甲乙对照）：

1. **edit 画布接线**：同一组参考图 + 同 seed，甲 = 现行 EmptyLatentImage + resolution=面积等效值，
   乙 = 官方 latent 接线 + resolution=0；比「未点名区域漂移」。
2. **cfg 质量档**：cfg 1 / 2.5 / 3.5 × 40 步，带默认负向词集，锁定种子出九宫格盲测——验证黄偏移与细节收益。
3. **步数 25 vs 40**：客观数据已有（lapvar/hf_frac 方法沿用 configuration.md 的口径），补用户盲测。
4. **QwenImage21Cache**：cache 开/关 × t2i/edit × turbo，记时长与显存（沿用 configuration.md 的 A/B/A/B 方法）。
