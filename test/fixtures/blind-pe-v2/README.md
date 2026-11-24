# PE 盲测 v2 夹具

- 6 道全新通用题，不包含 IP。
- 每题两个固定 seed：`2026112401`–`2026112412`。
- 完整来源矩阵：Qwen 为 RAW / Project / GOLD，MOSS 为 RAW / Project / Official Skill / TextGenerateV2 / GOLD。
- 预期图片：`6 × 2 × 8 = 96` 张。
- TextGenerateV2 每题只生成一次，共 6 条，并复用于该题的两个图片 seed。
- GOLD 在 Project、Official Skill 和 TextGenerateV2 输出前冻结，`main.json` 记录每条 GOLD 的时间与哈希。
- 人类评审只依据原始需求评图片，不生成提示词排名页；每个图片组都有意见描述框。
- 输出固定到 `.blindtest/pe-v2/`，不覆盖 v1。
