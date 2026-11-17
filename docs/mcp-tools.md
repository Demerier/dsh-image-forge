# comfy-mcp 0.10.0 tool list (measured, not copied from documentation)

**This is the 0.10.0 surface**: the PyPI release pins `comfy-mcp==0.10.0` (D4,
docs/EXECUTION-PLAN.md §8) and the client filters against the list below. The
announced 0.11.0 `main` branch (41 tools, Desktop chapter) is deliberately
**not** used: no list, doc or test in this repository names a tool outside this
table.

- Measured: 2026-11-18, `tools/list` over stdio, server reported
  `{name: "comfy-mcp", version: ""}`.
- Method: the Host runtime (`DSH NEXT.exe` in `ELECTRON_RUN_AS_NODE` mode,
  `--expose-internals`, `app.asar` install anchor) mounted the same profile
  package-resolution service the Host mounts at boot, then the probe connected
  with the Host-supplied `@modelcontextprotocol/client` and called
  `tools/list`. Raw capture: `verify/t15/tools-list.json` (local, git-excluded;
  reproducible with `verify/t15/probe-comfy-mcp.mjs`).
- **39 tools**, matching D4's expected count. No tool allowlist exists in
  comfy-mcp 0.10.0 (§8-1), so filtering happens client-side in
  `src/mcp-backend.ts`: only the ✅ rows below are callable, and
  `run_workflow` / `job` / `fetch_outputs` are required at connect time.
- `discover`'s real parameters are `{schemas_only: boolean = true, command:
  string = ""}` — this settles the README-vs-CHANGELOG contradiction (§8-2).

| # | tool | 0.10.0 description (first line) | input keys | required |
|---|---|---|---|---|
| 1 | `server_info` | Report the local ComfyUI/comfy-cli environment and verify compatibility. |  | — |
| 2 | `auth_status` | Comfy Cloud credential status for partner-API nodes (read-only; never returns secrets). |  | — |
| 3 | `auth_login` | Start Comfy Cloud sign-in; returns an OAuth URL for the USER to open. |  | — |
| 4 | `run_workflow` ✅ | Run a ComfyUI workflow JSON on the ComfyUI this server targets. | workflow_path, wait, timeout_seconds, confirm_spend | workflow_path |
| 5 | `generate_image` | Generate an image from a text prompt — the fast on-ramp. | prompt, checkpoint, wait, timeout_seconds | prompt |
| 6 | `list_partner_models` | List the hosted PARTNER models ``partner_generate`` can run. | style, partner, query, limit, offset | — |
| 7 | `partner_model_schema` | Show one partner model's callable parameters — the input to ``partner_generate``. | model | model |
| 8 | `partner_generate` | Run a hosted PARTNER model (Flux / Ideogram / DALL·E / Recraft / …) — SPENDS CREDITS. | model, params, confirm_spend, out_path, timeout_seconds | model |
| 9 | `emit_partner_workflow` | Write a runnable workflow that drives a partner model's NODE on LOCAL ComfyUI. | model, out_path, params | model, out_path |
| 10 | `run_template` | Run a gallery template — fetch, fill params, execute. | name, params, confirm_spend, wait, timeout_seconds | name |
| 11 | `job` ✅ | Inspect, wait on, watch, or cancel a submitted job — one action per call. | action, prompt_id, timeout_seconds | — |
| 12 | `system_stats` ✅ | Read the live local ComfyUI's VRAM per device and system RAM. |  | — |
| 13 | `free_memory` | Ask the local ComfyUI to unload models / reset its executor cache. | unload_models, free_memory | — |
| 14 | `fetch_outputs` ✅ | Download a completed job's output files into ``out_dir``. | prompt_id, out_dir, url_only, inline_images | prompt_id, out_dir |
| 15 | `launch_comfyui` | Start the LOCAL ComfyUI server, detached, and return once it is up. | extra_args, confirm_network_exposure | — |
| 16 | `stop_comfyui` | Stop the LOCAL ComfyUI server that comfy-cli launched. |  | — |
| 17 | `restart_comfyui` | Restart the LOCAL ComfyUI server: stop the running one, then launch a fresh one. | extra_args, confirm_network_exposure, confirm_kill_untracked | — |
| 18 | `update_comfyui` | Update the LOCAL install — ComfyUI core, the custom node packs (asks | target, confirm_update_all | — |
| 19 | `switch_comfyui_version` | Move the LOCAL ComfyUI install to a specific version — DESTRUCTIVE, asks first. | version, confirm_switch | version |
| 20 | `install_node` | Install custom node packs into the LOCAL ComfyUI — runs third-party code, asks first. | names, confirm_install | names |
| 21 | `get_logs` | Return the tail of the LOCAL background ComfyUI's captured log file. | tail, port | — |
| 22 | `discover` | Return comfy-cli's self-describing command surface (its own contract). | schemas_only, command | — |
| 23 | `which` | Report which ComfyUI install/workspace comfy-cli currently targets. |  | — |
| 24 | `project` | Report or create the operator-anchored comfy-cli project (`project/1`). | action | — |
| 25 | `search_templates` | Search the built-in ComfyUI workflow-template gallery. | query, limit, offset, tag, type, model, provider, exclude_api | — |
| 26 | `get_template` | Show one template's details/schema, and whether your install can run it. | name, check_local | name |
| 27 | `fetch_template` | Write a template's runnable workflow JSON to ``out_path``; report if it can run here. | name, out_path, check_local | name, out_path |
| 28 | `nodes` | Search, inspect, filter, or graph-walk node classes in the LOCAL live catalog. | action, query, name, produces, accepts, category, pack, label, limit, from_type, to_type, max_depth, max_paths | — |
| 29 | `node_dependencies` | Report a custom node pack's Python dependency requirements vs the installed venv (read-only). | pack, registry_id | — |
| 30 | `workflow_deps` | Map a workflow's node classes to the node PACKS that provide them (read-only). | workflow_path | workflow_path |
| 31 | `search_models` | Search / list model files available to the LOCAL ComfyUI install. | query, folder | — |
| 32 | `download_model` | Download a model file into the LOCAL ComfyUI models dir, by URL. | url, relative_path, filename, wait, timeout_seconds | url |
| 33 | `download` | Track a transfer already started by download_model; does NOT start one. | action, download_id, timeout_seconds | — |
| 34 | `upload_file` | Upload files from this machine into the target ComfyUI's ``input`` directory. | paths, overwrite | paths |
| 35 | `validate_workflow` ✅ | Pre-flight a workflow against the live local ComfyUI before running it. | workflow_path | workflow_path |
| 36 | `list_workflow_slots` | List the agent-tweakable slots a frontend-format workflow exposes. | workflow_path | workflow_path |
| 37 | `list_workflow_notes` | List the documentation notes a frontend-format workflow carries. | workflow_path | workflow_path |
| 38 | `set_workflow_slot` | Set one or more slot values on a frontend-format workflow. | workflow_path, overrides, stdout | workflow_path, overrides |
| 39 | `vary_workflow` | Fan a frontend-format workflow out into variants over slot value lists. | workflow_path, slots, out_dir | workflow_path, slots |

## What the plugin actually calls

```text
run_workflow({ workflow_path, wait: false })        # submit, never wait
job({ action: "status", prompt_id })                # poll; timed_out is not failure
fetch_outputs({ prompt_id, out_dir })               # copies files; out_dir is required
validate_workflow / system_stats                    # allowed, used by verification
```

Everything else in the table is refused before it reaches the subprocess (see
`test/mcp-backend.test.mjs`). `fetch_outputs` is a **copy** operation: files
under ComfyUI's own output directory are never moved or deleted.
