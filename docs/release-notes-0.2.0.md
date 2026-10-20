# dsh-image-forge 0.2.0

The release that cuts the plugin down to what actually works, then gives the
results somewhere to live. **0.2.0 is breaking** — read the first section before
upgrading.

## Breaking: the managed local runtime is gone

0.1.0 shipped a fourth tool, `qwen_image_env`, a managed Python venv, nf4 weight
downloads and a worker process. It is removed in full, along with the `local`
backend value.

Remaining backends are `api` (your own DashScope-compatible key) and `comfyui`
(your own ComfyUI). `auto` still means "key if present, otherwise ComfyUI".
**Editing is ComfyUI-only** — a cloud key cannot do reference-image edits.

If a config still says `backend: local`, or still calls `qwen_image_env`, it will
be rejected. Migrate to `comfyui` and see
[docs/comfyui-deployment.md](comfyui-deployment.md); the plugin no longer
downloads, installs or manages weights.

## New: a canvas workbench and boards

`qwen_image_generate` / `qwen_image_edit` results used to be a list of paths. They
now land on a **board** — a canvas you can pan, where every result is a node with
a lineage edge back to the prompt that produced it.

- **Boards**: several independent canvases; camera position is autosaved, so a
  board reopens where you left it.
- **Search** across every board's assets, not just the current one.
- **Prompt rewrite, two styles**: a prose style (long observational description) and
  a formula style (a keyword stack in the shape of Alibaba's published formula,
  `subject + scene + style + lens + mood + detail`). Both can be edited in the
  workbench and pasted straight back into the tools.
- **Same-origin image route** `/plugins/dsh-image-forge/studio/file?path=…` — the
  reason images render at all. A local Windows path is not a URL, and `file://` is
  blocked inside an http page, so both the tool cards and the workbench now serve
  images through this route instead of putting a raw path in `src`.

## Fixed

- **The workbench returned HTTP 404** on DSH Desktop. The routes were registered
  through a one-shot `ctx.get('webServer')`, which is `undefined` because Desktop
  mounts `webServer` *after* plugin activation. Registration now happens in a
  nested plugin that declares `inject: ['webServer']`, so it activates when the
  service appears instead of silently doing nothing. Hosts without nested-plugin
  support lose only the workbench, never the tools.
- **Images did not render**, in tool cards or in the workbench. Covered above.
- **Rebuilding only half the package**: the host build cleans `lib/`, so running it
  alone deleted `lib/client.js`. `pnpm build` runs both passes; the hazard is
  documented in [local-install.md](local-install.md).
- **Dev dependency generation mismatch** — the CI install resolved a 0.1.x
  `dsh-session` next to a 0.2.x `dsh-llm`, and the former imports a `CallId` export
  the latter renamed. All `dsh-*` dev and peer deps are now aligned on 0.2.0-rc.2.

## Install

```bash
npm install dsh-image-forge
# from source
pnpm install && pnpm build
dsh plugin --profile <profile> add <this directory>
```

Weights are **not** bundled. Point `backend` at a key or at your own ComfyUI.

## Docs

- [README](../README.md) — what it does and how to use it
- [configuration.md](configuration.md) — every settings field
- [comfyui-deployment.md](comfyui-deployment.md) — standing up the ComfyUI backend
- [local-install.md](local-install.md) — build, package, install, roll back
- [license-and-limits.md](license-and-limits.md) — what this package may and may not do
