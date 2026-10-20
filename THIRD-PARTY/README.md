# 第三方代码与许可

本仓库自身以 **MIT** 发布（见根目录 `LICENSE`）。下列第三方作品以各自的许可进入本仓库，
**其中的内容不适用 MIT**，使用时须同时遵守该作品自身的许可。

---

## dsh-image-gen

- **来源**：https://github.com/shanliuling/dsh-image-gen
- **权利人**：Copyright 2026 shanliuling
- **许可**：Apache License 2.0（全文见 [`./dsh-image-gen/LICENSE`](./dsh-image-gen/LICENSE)）
- **引入方式**：**移植/改编源码**（非运行时依赖）

### 为什么在这里

本插件的 ComfyUI 后端与工作流占位符协议（`{{prompt}}` / `{{seed}}` / `{{image}}`）
在设计时参考并移植了 dsh-image-gen 的实现。Apache-2.0 §4 要求再分发时
保留许可证、标注修改、并以适当方式致谢，故将该许可全文随本仓库分发。

### 修改说明（Apache-2.0 §4(b)）

凡移植后经过修改的文件，均在其头部注释中标明：

```
Adapted from dsh-image-gen <version> (Apache-2.0), modified.
```

当前无此类文件。**若后续移植，请逐文件补上该声明**，并在本文件中登记版本号与改动摘要。

### 边界

- 上游的 README 截图与 `docs/assets/readme/*.webp` **未**引入。
- 上游的 `src/inspiration/data/*.json` 是第三方 Prompt 集合，另有内容授权问题，**未**引入。
- Apache-2.0 不授予商标许可；本插件与上游作者无隶属或背书关系。
