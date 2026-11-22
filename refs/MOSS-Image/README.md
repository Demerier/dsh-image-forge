# MOSS-Image 官方参考（vendored）

这些文件是官方仓库的**原文副本**，用来替代此前 `src/layout-editor.ts` 注释里指向但从未落盘的
`refs/MOSS-Image/skills/.../compile_prompt.py`。不改写、不翻译、不摘要——要对照就以这里为准。

| 本地路径 | 上游 |
|---|---|
| `LICENSE` | https://github.com/OpenMOSS/MOSS-Image/blob/main/LICENSE （Apache-2.0） |
| `skills/moss-image-prompt-enhancer/SKILL.md` | https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/SKILL.md |
| `skills/moss-image-prompt-enhancer/references/layout.md` | https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/references/layout.md |
| `skills/moss-image-prompt-enhancer/scripts/compile_prompt.py` | https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/scripts/compile_prompt.py |

同步方式：换版本时整份替换，不手改。上游许可证 Apache-2.0，本目录保留其 LICENSE 全文。

## 这份文档在项目里怎么用

- **`references/layout.md` 是 layout schema 的权威**：`width`/`height` 必须是 16 的倍数、
  `bbox_coord_space=abs`、`bbox_format=xyxy`、`summary` 必含 `caption`（可选 `meta`/`canvas`/`palette`）、
  `items` 非空且每项含 `label`/`caption`/`bbox`（`text` 项必须带 `text`，换行写成 `\n`）、
  禁止 `children`/`parent`/`id`/`elements` 等未识别字段。
- **`scripts/compile_prompt.py` 是坐标换算的权威**：小数边先 `round(…, 9)`，再 floor 左/上、ceil 右/下，
  然后减 `width//2` / `height//2`，输出 `abs_centralized` + `yxyx`。
- 本项目的 `src/layout-editor.ts` 的 `compileLayout` 是这段逻辑的 TypeScript 移植；
  `test/layout-editor.test.mjs` 用 `verify/` 下的 draft→compiled 成对样本逐字节回归。

## 已知差异（移植时接受的口径）

- 官方编译器用 `height // 2`（整数除）；本移植同样取整后再减，见 `toCompiledBox`。
- 官方拒绝越界与未知字段，本移植同样拒绝（`validateLayoutDraft`），不做静默裁剪。
