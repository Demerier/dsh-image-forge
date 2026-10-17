# dsh-image-forge 0.1.0

First public release.

## What it is

A DeepSeek Harness plugin for **Qwen-Image text-to-image and reference-image editing**, with the official prompt-contract `wh_ratio` as a first-class tool parameter.

- Tools: `qwen_image_generate`, `qwen_image_edit`, `qwen_image_status`, `qwen_image_env`
- Skill: `qwen-image-forge` (intent routing + T2I / Edit rewrite rules)
- Backends: `local` (managed venv + worker) / `comfyui` / `api`, default `auto`
- Settings: tabbed page, one-click local deploy, custom env fields not exposed

## Install

```bash
npm install dsh-image-forge
# from source
pnpm install && pnpm build
dsh plugin --profile <profile> add <this directory>
```

## Verify

```bash
pnpm install
pnpm build
pnpm test          # 153 cases, no GPU required
```

## Not bundled

- **Qwen-Image-2.1 weights** (Qwen RESEARCH LICENSE) — use `qwen_image_env action:"fetch-weights"` or the settings-page deploy button
- Official prompt-catalogue originals (rules in `skill.md` / `references/` are self-authored)
- ComfyUI (optional external dependency, HTTP only)

Plugin code is **MIT**. Commercial use of the weights requires a separate licence from the rights holders. See `docs/license-and-limits.md`.

## Known limits

- Cloud API has **no edit path** (references only go to `comfyui` / `local`)
- Local edit on 8 GB cards is gated (measured on an 8 GB card)
- No inpaint/mask, upscale, or gallery UI
- Real-client UI verified in DeepSeek Harness web 0.2.x
