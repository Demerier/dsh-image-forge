# dsh-image-forge 0.4.0

本版是**对外命名破坏性变更**：产品能力不再以 Qwen 模型命名。生成仍支持 Qwen-Image 2.1 与 MOSS-Image，模型继续由 `comfyModel` 选择；Qwen 只是可选模型，不再是工具身份。

## 工具与技能改名

| 0.3.0 | 0.4.0 |
|---|---|
| `qwen_image_generate` | `image_forge_generate` |
| `qwen_image_edit` | `image_forge_edit` |
| `qwen_image_status` | `image_forge_status` |
| `qwen_image_setup` | `image_forge_setup` |
| skill `qwen-image-forge` | skill `image-forge` |

旧工具名不再注册，也没有别名。升级后需要更新模型提示、自动化配置和手工调用。

## 默认命名

- 新生成 PNG 的默认前缀从 `qwen` 改为 `forge`。
- `image_forge_edit` 未给 `preset` 时仍默认使用 `edit`。
- 已有文件名和画板 JSON 不会被批量改名；历史成果仍可正常读取。

## 对话与环境

- `image_forge_setup` 正式进入技能工具表。它支持 `status` / `start` / `stop` / `install` / `download`。
- `download` 默认 dry-run；只有 `confirm: true` 才下载并写入缺失权重。
- 工具和技能名称与模型解耦后，后续增加新的 ComfyUI 模型家族不需要再次重命名产品入口。

## 兼容性

- 模型档位值 `qwen21-base`、`qwen21-turbo`、`moss-sft` 保持不变。
- Qwen 权重文件名、MOSS 工作流和提示词契约都没有因工具改名而改变。
- 已退役的 `qwen_image_env` 仍不提供，也不会重新引入。
