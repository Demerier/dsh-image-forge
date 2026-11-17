# MCP execution backend (`comfy-mcp` 0.10.0)

T15 wires the generation pipeline to the official `comfy-mcp` stdio server. The
graph itself is built by `src/comfyui.ts` as before; this document covers the
transport, the process lifecycle, the tool filter, and the fallbacks.

## Call chain and fallback order

```text
generateViaComfyUi / …Edit / …Turbo            (src/comfyui.ts, unchanged graph builders)
        │  renderTextToImage / renderEditGraph
        ▼
runGraph(graph)                                   src/comfyui.ts
        │  1. DSH_IMAGE_FORGE_BACKEND (env; default auto)
        ├── MCP: spawn comfy-mcp ──stdio──► comfy-mcp ─► comfy-cli ─► ComfyUI
        ├── CLI: spawn comfy  ────────────► comfy-cli ─► ComfyUI
        └── HTTP: POST /prompt → /history → /view   (historical path, kept last)
```

- The **HTTP path is still the last resort**, so a machine without the toolchain
  behaves exactly as it did before T15 (this is what keeps the existing
  `comfyui-e2e` / `edit-e2e` suites meaningful).
- **Failure of a backend is not fatal by default**: `auto` tries the next one.
  `DSH_IMAGE_FORGE_BACKEND=mcp` or `=cli` makes that backend strict — its error
  becomes the call's error, with no silent HTTP fallback.
- Nothing registers on the conversation tool table: the client never imports
  `ctx.mcpManager` and the plugin registers no `mcp__*` tool. The MCP
  connection is private to this backend.

## Environment variables (config-schema fields are intentionally not used)

`test/settings.test.mjs` asserts that every `Config` schema field has a control
on the settings page. Adding `backend`/`mcp*` fields would require touching
`src/settings-fields.ts` (not part of T15's write scope) and `backend` is in the
retired-field list. Selection is therefore environment-only, with explicit
names; an empty environment = auto, with no change:

| variable | values | meaning |
|---|---|---|
| `DSH_IMAGE_FORGE_BACKEND` | `auto` (default) / `mcp` / `cli` / `http` | `auto` = mcp → cli → http; `mcp`/`cli` strict; `http` skips both |
| `DSH_IMAGE_FORGE_COMFY_MCP_BIN` | absolute path | `comfy-mcp` executable; otherwise `comfy-mcp` on `PATH` |
| `DSH_IMAGE_FORGE_COMFY_BIN` | absolute path | `comfy` executable handed to the MCP child as `COMFY_BIN`; otherwise `comfy` on `PATH` |
| `DSH_IMAGE_FORGE_BACKEND_TIMEOUT_MS` | positive integer | per-backend budget override (capped by the call's own `timeoutMs`) |
| `DSH_IMAGE_FORGE_MCP_DEBUG` | `1` | one stderr line per MCP tool call with duration |
| `DSH_IMAGE_FORGE_BACKEND_TMPDIR` | directory | parent for per-run scratch dirs (workflow JSON + `fetch_outputs` target); default `os.tmpdir()` |

`COMFY_LOCAL_URL` is **derived**, never configured: the backend sets it to the
already-discovered ComfyUI origin (`ComfyTarget.endpoint`) in the child
environment. `COMFYUI_URL` is deliberately never set — it means "another
machine" in comfy-cli and would beat `COMFY_LOCAL_URL`.

## Toolchain (pinned, isolated)

```powershell
uv python install 3.12                 # skipped when a system 3.12 exists (GitHub install blocked here)
uv tool install "comfy-cli>=1.14.0"    # measured: comfy-cli 1.26.0
uv tool install "comfy-mcp==0.10.0"    # D4 lock; 39 tools
```

Measured on this machine (uv 0.13.5, isolated `UV_TOOL_DIR`):

```text
comfy-cli v1.26.0
- comfy
- comfy-cli
- comfycli
comfy-mcp v0.10.0
- comfy-mcp
```

The plugin does **not** install this toolchain itself (that is the T14/P6
onboarding direction); it only uses the binaries the environment names.

## Verified end to end

Probe artifacts live in `verify/t15/` (git-excluded, local evidence):

1. **Host SDK is resolvable at runtime** — declared as
   `peerDependencies["@modelcontextprotocol/client"]`, which the DSH profile
   runtime resolution supplies from the host installation. Measured in the real
   host binary with `app.asar`: `@modelcontextprotocol/client` →
   `app.asar/node_modules/@modelcontextprotocol/client/dist/index.mjs`
   (exports `Client`), `@modelcontextprotocol/client/stdio` exports
   `StdioClientTransport`. Without the peer declaration the same import fails
   with `ERR_MODULE_NOT_FOUND` — the declaration is load-bearing, not cosmetic.
   (SDK v2.2.0 puts `StdioClientTransport` in the `/stdio` subpath, not the root.)
2. **`COMFY_LOCAL_URL` passthrough (was unverified, plan §8-3)** — with
   `COMFY_LOCAL_URL=http://127.0.0.1:<fake-port>` the `system_stats` tool caused
   exactly one `GET /system_stats` at that fake origin and returned its body;
   with `COMFY_LOCAL_URL=http://127.0.0.1:8188` it returned the real server's
   `system_stats` (`comfyui_version 0.45.5`, `ram_total 33362391040`, read
   2026-11-18). `COMFYUI_URL` was never set.
3. **39 tools** — see [mcp-tools.md](mcp-tools.md).
4. **Real image through MCP (acceptance)** — `verify/t15/real-mcp-image.mjs` runs
   the real `src/comfyui.ts` pipeline with `DSH_IMAGE_FORGE_BACKEND=mcp` and the
   real toolchain, captures the `prompt_id` from the submission callback, and
   writes the fetched PNG. Measured 2026-11-18 on ComfyUI 0.45.5 / 8188:
   `run_workflow` 1982 ms → `prompt_id 2d75073a-59d1-4ab1-9113-9ab040bd89c5` →
   `job(status)` 1574 ms (completed) → `fetch_outputs` 1461 ms → 400 042-byte
   PNG written to `verify/t15/real-mcp-image.png`; whole call 11 197 ms. Note the
   probe needed `DSH_IMAGE_FORGE_BACKEND_TMPDIR` pointed inside the workspace:
   this session's bash sandbox denies AppData writes to workspace-child
   processes (the same reason comfy-cli's own config write is redirected); the
   Host process that spawns comfy-mcp in production has no such sandbox and uses
   `os.tmpdir()` normally.

## Process lifecycle

- One child per resolved endpoint, reused across calls; a different endpoint
  disposes the old one first.
- `comfy-mcp` only kills its direct child, so the backend keeps the transport pid
  and runs `taskkill /F /T /PID` (Windows) or `kill(-pid)` (POSIX) on
  timeout/abort. That is the only way the `comfy-cli`/ComfyUI grandchildren are
  cleaned up (plan §7.5).
- A timed-out generation is **not** reported as an empty result: the prompt id is
  in the error text and the result can still be fetched from
  `GET /history/<id>`. `run_workflow`'s 110 s default wait is never used —
  submission always runs with `wait: false`.

## Licensing note (not legal advice)

comfy-mcp is AGPL-3.0-or-later (or commercial via `licensing@comfy.org`). This
plugin spawns it as a separate stdio program and does not distribute it; whether
stdio structured-data exchange counts as FSF "intimate communication" is
**unverified** (plan §8-4). No legal conclusion is drawn here, and the plugin
does not install or bundle the toolchain.

## Known gaps (also in the T15 report)

- **No `Config` schema fields** for backend selection/timeouts (reason above);
  they must be added together with `settings-fields.ts` controls by T22 or a
  follow-up.
- The **CLI fallback** is implemented against the measured 1.26.0 help surface
  (`run --workflow --wait`, `download --out-dir`) and pinned by tests with an
  injected spawn; it has **not** been exercised against a live ComfyUI in T15.
- `fetch_outputs` was observed once timing out on a just-completed job and
  succeeds on immediate retry; the backend retries up to 3 times with a 1 s gap.
  Root cause not confirmed upstream (likely comfy-cli job-state settling).
