# PE 盲测 v1 夹具

这组夹具服务 `test/blind-pe.mjs`，不进入 npm 包。

- `config.json`：固定模型、采样、尺寸、来源矩阵、官方 Skill 版本、TextGenerateV2 参数与系统提示。
- `main.json`：三个原创题材、固定 seed、RAW / 项目 Skill / 官方 Skill / 人工 GOLD。
- `ip.json`：四个《原神》角色夹具。前三个出图，最后一个只做文本审计；每个角色都有官方证据、默认形态、属性卡和禁止误加项。

## 冻结点

- 项目 Skill、人工 GOLD、官方 Skill 文案在 `2026-11-24` 冻结；GOLD 不得在看到任何优化器输出或生成图后修改。
- `text-generate-v2` 在运行时由 ComfyUI 的 `CLIPLoader → TextGenerateV2 → PreviewAny` 最小分支生成一次，写入 `.blindtest/pe-v1/text-generate-v2.json` 后才开始出图。
- 评分图只接收冻结后的最终 prompt；MOSS 评分图工作流不包含 TextGenerateV2。
- IP 夹具没有 GOLD 图。官方属性卡只用于判断提示词是带入正确知识、通用补全还是编造设定。

## 证据边界

沃雅妮莎没有找到可稳定读取的独立官方角色介绍页，因此以 7.1 官方更新作为首曝和版本证据，并在记录中明确这一限制。瓦列里的名称在 7.2 前瞻中更早出现；IP-D 的新鲜度按完整角色介绍与公开可玩资料形成日计算，同时保留更早的名称日期。
