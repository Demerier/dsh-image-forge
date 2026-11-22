import Schema from "@deepseek-ai/schemastery";
import { closeSync, constants, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { Readable } from "node:stream";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { deflateSync, inflateSync } from "node:zlib";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __esmMin = (fn, res, err) => () => {
	if (err) throw err[0];
	try {
		return fn && (res = fn(fn = 0)), res;
	} catch (e) {
		throw err = [e], e;
	}
};
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region src/config-defaults.ts
/**
* The plugin's **default paths**, as the settings page shows them.
*
* There are only two kinds left, both about the machine the plugin runs on:
*
* - `outputDir` is a normal user-visible pictures folder.
* - `comfyModelsDir` is *probed*: it scans a candidate list with `existsSync`
*   and falls back to `''` when nothing is found, which keeps the "let the tool
*   layer phrase a generic error" path intact on an unknown box.
*
* Everything the plugin used to own itself — a venv, a weight cache, a worker
* script — is gone. Generation now runs either through a cloud key or through
* the user's own ComfyUI, and ComfyUI owns its model directory; this file only
* tries to *name* that directory so the error messages can be specific.
*
* Two deliberate limits:
*
* - **Nothing here does network I/O.** `comfyEndpoint` stays empty on purpose:
*   its documented meaning is "probe `comfyPorts` at call time", and opening a
*   socket while building a config schema would be a side effect in the wrong
*   place.
* - **Nothing here is imported by the browser half.** `settings-fields.ts` is
*   bundled for the browser and therefore cannot touch `node:fs`; the page
*   learns these values from the Host, which serves the schema defaults as the
*   form's values.
*/
/** Default output directory: a normal user-visible pictures folder. */
function defaultOutputDir() {
	return join(homedir(), "Pictures", "dsh-image-forge");
}
/**
* Where a ComfyUI install keeps its `models` directory, most likely first.
*
* Conventional per-user locations only — no machine-specific entries: a
* published plugin must not ship one author's directory layout, and a wrong
* guess is visible (and correctable) on the settings page anyway. The
* Linux/macOS clone and `/opt` spots are added where those platforms actually
* put one. Ordering only decides which one wins when several exist.
*
* @returns candidate directories, whether or not they exist.
*/
function comfyModelsCandidates() {
	const win = process.platform === "win32";
	const roaming = process.env.APPDATA ?? "";
	const local = process.env.LOCALAPPDATA ?? "";
	return [
		...roaming === "" || !win ? [] : [join(roaming, "ComfyUI", "models")],
		...local === "" || !win ? [] : [join(local, "ComfyUI", "models"), join(local, "Programs", "@comfyorgcomfyui-electron", "resources", "ComfyUI", "models")],
		join(homedir(), "ComfyUI", "models"),
		join(homedir(), "Documents", "ComfyUI", "models"),
		...win ? [] : [join(homedir(), "comfy", "ComfyUI", "models"), "/opt/ComfyUI/models"]
	];
}
/**
* Find the ComfyUI models root, for phrasing "put the file in …" errors.
*
* @returns the first candidate that exists, or `''` when none does — which keeps
*   the error messages generic rather than naming a directory that is not there.
*/
function probeComfyModelsDir() {
	for (const candidate of comfyModelsCandidates()) try {
		if (existsSync(candidate)) return candidate;
	} catch {}
	return "";
}
//#endregion
//#region src/config-resolve.ts
/**
* Whether a value is a volatile reference rather than data.
*
* Structural, because the reference crosses ESM/CJS copies and its class
* identity is not something a plugin may rely on.
*
* @param value - the candidate.
* @returns true when the value exposes `get()`.
*/
function isConfigRef(value) {
	return typeof value === "object" && value !== null && typeof value.get === "function";
}
/**
* Resolve one field, following a volatile reference.
*
* @param field - the field as it arrived.
* @returns the committed value, or undefined when absent or unreadable.
*/
function readConfigField(field) {
	if (field === void 0 || field === null) return void 0;
	if (isConfigRef(field)) try {
		return field.get();
	} catch {
		return;
	}
	return field;
}
/**
* Read a schema's own defaults, keeping **every** declared key.
*
* {@link unwrapConfigFields} drops a reference that resolves to `undefined`,
* which is right for an activation's config but wrong for the schema itself: an
* intentionally optional field — a nullable override whose "unset" is a real
* state, not a missing value — would vanish from the resolved config and its key
* would stop existing. Keeping the key with an `undefined` value preserves "this
* field is declared and currently unset", which is what downstream code needs to
* tell apart from "this field does not exist".
*
* @param parsed - a schema's output for the empty input.
* @returns every declared key, with its default (possibly `undefined`).
*/
function schemaDefaults(parsed) {
	const out = {};
	for (const key of Object.keys(parsed)) out[key] = readConfigField(parsed[key]);
	return out;
}
/**
* Merge an activation's config over the schema defaults.
*
* Keyed by the defaults, so a field the activation does not carry — an absent
* reference, or a partial config from a test — keeps its default rather than
* becoming `undefined`. A field explicitly set to an empty string is a value and
* is kept; only `undefined` falls back.
*
* @param defaults - the schema defaults, already unwrapped.
* @param config - the config as it arrived, or undefined.
* @returns the resolved config.
*/
function resolveConfigFields(defaults, config) {
	const resolved = { ...defaults };
	if (config === void 0 || config === null) return resolved;
	for (const key of Object.keys(defaults)) {
		if (!Object.hasOwn(config, key)) continue;
		const value = readConfigField(config[key]);
		if (value !== void 0) resolved[key] = value;
	}
	return resolved;
}
//#endregion
//#region src/images.ts
/** Sniff the image container from its magic bytes. */
function sniffImageMime(bytes) {
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (bytes.length >= 12 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
}
var init_images = __esmMin((() => {}));
//#endregion
//#region src/mcp-backend.ts
/**
* MCP backend: spawn the pinned `comfy-mcp` stdio server and drive it with the
* Host-supplied `@modelcontextprotocol/client`.
*
* Tool surface is filtered on the client side: comfy-mcp 0.10.0 publishes 39
* tools and has no allowlist variable of its own (docs/EXECUTION-PLAN.md §8-1),
* so this module keeps only the five it needs and refuses to call anything else.
* The 0.10.0 tool list is recorded in [mcp-tools.md](../docs/mcp-tools.md).
*
* Only five operations are used (docs/mcp-tools.md and
* [mcp-backend.md](../docs/mcp-backend.md) carry the exact call sequence):
*
* ```text
* run_workflow(workflow_path, wait=false) -> { prompt_id }
* job(action="status", prompt_id)         -> poll; timed_out is NOT failure
* fetch_outputs(prompt_id, out_dir)       -> copies files into out_dir
* validate_workflow / system_stats        -> allowed, used by verification paths
* ```
*
* @module
*/
var mcp_backend_exports = /* @__PURE__ */ __exportAll({
	MCP_TOOL_ALLOWLIST: () => MCP_TOOL_ALLOWLIST,
	McpBackend: () => McpBackend,
	classifyJob: () => classifyJob,
	createMcpBackend: () => createMcpBackend,
	killProcessTree: () => killProcessTree
});
function deepFind$1(value, key, depth = 0) {
	if (depth > 8 || value === null || typeof value !== "object") return void 0;
	if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
	for (const child of Object.values(value)) {
		const found = deepFind$1(child, key, depth + 1);
		if (found !== void 0) return found;
	}
}
function textOf(result) {
	return (result.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}
function parseEnvelopeOrThrow(result, what) {
	const text = textOf(result);
	if (result.isError === true) throw new Error(`comfy-mcp: ${what} 失败：${text.slice(0, 2e3) || "（无错误文本）"}`);
	if (text.trim() === "") return void 0;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
async function defaultSleep$1(ms, signal) {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		timer.unref?.();
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted"));
		};
		if (signal?.aborted === true) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}
/** Kill a child and its descendants; comfy-mcp itself only kills its direct child. */
function killProcessTree(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", [
			"/F",
			"/T",
			"/PID",
			String(pid)
		], {
			stdio: "ignore",
			windowsHide: true
		});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}
/** Load the Host-supplied SDK. Returns `undefined` when the Host did not supply it. */
async function loadHostSdk() {
	try {
		const clientModule = await import("@modelcontextprotocol/client");
		const stdioModule = await import("@modelcontextprotocol/client/stdio");
		return {
			Client: clientModule.Client,
			StdioClientTransport: stdioModule.StdioClientTransport,
			getDefaultEnvironment: stdioModule.getDefaultEnvironment
		};
	} catch {
		return;
	}
}
/**
* Default connection: load the Host SDK, spawn `comfy-mcp` over stdio, and
* point it at the resolved ComfyUI endpoint with `COMFY_LOCAL_URL` (never
* `COMFYUI_URL` — that has remote semantics, docs/mcp-backend.md §env).
*/
async function connectHost(options) {
	const sdk = await loadHostSdk();
	if (sdk === void 0) throw new Error("comfy-mcp 后端不可用：宿主没有提供 @modelcontextprotocol/client（应作为 peerDependency 由 DSH profile 运行时解析）。如确需降级，保持 DSH_IMAGE_FORGE_BACKEND 未设置即可回落到 HTTP。");
	const childEnv = {
		...sdk.getDefaultEnvironment(),
		COMFY_LOCAL_URL: options.endpoint
	};
	for (const [key, value] of Object.entries(options.env)) if (typeof value === "string" && key !== "COMFYUI_URL") childEnv[key] = value;
	delete childEnv.COMFYUI_URL;
	if (options.comfyBin !== void 0 && options.comfyBin !== "") childEnv.COMFY_BIN = options.comfyBin;
	const transport = new sdk.StdioClientTransport({
		command: options.command,
		args: [],
		env: childEnv,
		stderr: "pipe"
	});
	const client = new sdk.Client({
		name: "dsh-image-forge",
		version: "0.0.4"
	}, {
		capabilities: {},
		versionNegotiation: { mode: "auto" }
	});
	await client.connect(transport);
	return {
		client,
		pid: typeof transport.pid === "number" ? transport.pid : void 0,
		close: async () => {
			await client.close().catch(() => void 0);
			await transport.close?.().catch?.(() => void 0);
		}
	};
}
/** Classify a `job(action="status")` payload. `timed_out` is explicitly not failure. */
function classifyJob(status) {
	if (deepFind$1(status, "completed") === true) return "done";
	if (deepFind$1(status, "timed_out") === true) return "pending";
	const state = deepFind$1(status, "status");
	if (typeof state === "string") {
		const normalized = state.toLowerCase();
		if (normalized === "completed" || normalized === "success" || normalized === "succeeded") return "done";
		if (normalized === "error" || normalized === "failed" || normalized === "cancelled") return "failed";
	}
	const outputs = deepFind$1(status, "outputs");
	if (outputs !== void 0 && outputs !== null && typeof outputs === "object" && Object.keys(outputs).length > 0) return "done";
	if (deepFind$1(status, "error") !== void 0) return "failed";
	return "pending";
}
function readImages$1(dir) {
	const files = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (IMAGE_EXTENSIONS$1.has(extname(entry.name).toLowerCase()) && statSync(path).size > 0) files.push(path);
		}
	};
	walk(dir);
	files.sort();
	return files.map((path) => {
		const bytes = new Uint8Array(readFileSync(path));
		return {
			bytes,
			mime: sniffImageMime(bytes) ?? "image/png"
		};
	});
}
/** Create the MCP backend. */
function createMcpBackend(options) {
	return new McpBackend(options);
}
var MCP_TOOL_ALLOWLIST, REQUIRED_TOOLS, IMAGE_EXTENSIONS$1, McpBackend;
var init_mcp_backend = __esmMin((() => {
	init_images();
	MCP_TOOL_ALLOWLIST = [
		"run_workflow",
		"job",
		"fetch_outputs",
		"validate_workflow",
		"system_stats"
	];
	REQUIRED_TOOLS = [
		"run_workflow",
		"job",
		"fetch_outputs"
	];
	IMAGE_EXTENSIONS$1 = /* @__PURE__ */ new Set([
		".png",
		".jpg",
		".jpeg",
		".webp",
		".gif"
	]);
	McpBackend = class {
		name = "mcp";
		options;
		connection;
		endpoint;
		allowedTools;
		disposed = false;
		constructor(options) {
			this.options = options;
		}
		async ensureConnection(endpoint) {
			if (this.connection !== void 0 && this.endpoint === endpoint) return this.connection;
			await this.dispose();
			this.disposed = false;
			this.allowedTools = void 0;
			const connect = this.options.connect ?? connectHost;
			this.connection = await connect({
				command: this.options.command,
				endpoint,
				comfyBin: this.options.comfyBin,
				env: this.options.env ?? process.env
			});
			this.endpoint = endpoint;
			return this.connection;
		}
		/** Filter `tools/list` down to the allowlist and verify the required names exist. */
		async connectAndFilterTools(endpoint) {
			if (this.connection !== void 0 && this.endpoint === endpoint && this.allowedTools !== void 0) return this.allowedTools;
			const published = (await (await this.ensureConnection(endpoint)).client.listTools(void 0, { cacheMode: "refresh" })).tools.map((tool) => tool.name);
			const allowed = published.filter((name) => MCP_TOOL_ALLOWLIST.includes(name));
			for (const required of REQUIRED_TOOLS) if (!allowed.includes(required)) throw new Error(`comfy-mcp 缺少必需工具 ${required}（实测工具数 ${published.length}，可能是版本不是 0.10.0）`);
			this.allowedTools = allowed;
			return allowed;
		}
		/** Call one allow-listed tool and parse its JSON envelope/text. */
		async callTool(name, args) {
			if (!MCP_TOOL_ALLOWLIST.includes(name)) throw new Error(`comfy-mcp: 工具 ${name} 不在客户端白名单内`);
			if (this.allowedTools !== void 0 && !this.allowedTools.includes(name)) throw new Error(`comfy-mcp: 工具 ${name} 不在本服务实测的工具清单内`);
			const connection = this.connection;
			if (connection === void 0) throw new Error("comfy-mcp: 连接尚未建立");
			const startedAt = Date.now();
			if (this.options.debug === true) process.stderr.write(`[dsh-image-forge mcp] call ${name} ${JSON.stringify(args).slice(0, 300)}\n`);
			const result = await connection.client.callTool({
				name,
				arguments: args
			});
			if (this.options.debug === true) process.stderr.write(`[dsh-image-forge mcp] done ${name} ${Date.now() - startedAt}ms isError=${String(result.isError)}\n`);
			return parseEnvelopeOrThrow(result, name);
		}
		async killTree() {
			const pid = this.connection?.pid;
			if (pid !== void 0) (this.options.killTree ?? killProcessTree)(pid);
			await this.closeConnection();
		}
		async closeConnection() {
			const connection = this.connection;
			this.connection = void 0;
			this.endpoint = void 0;
			this.allowedTools = void 0;
			if (connection !== void 0) await connection.close?.();
		}
		async run(request) {
			const interval = Math.max(1, request.pollIntervalMs);
			const scratchRoot = this.options.scratchRoot ?? tmpdir();
			mkdirSync(scratchRoot, { recursive: true });
			const scratch = mkdtempSync(join(scratchRoot, "dsh-image-forge-mcp-"));
			let promptId;
			try {
				await this.connectAndFilterTools(request.endpoint);
				const workflowPath = join(scratch, "workflow.json");
				writeFileSync(workflowPath, JSON.stringify(request.graph), "utf8");
				const submission = await this.callTool("run_workflow", {
					workflow_path: workflowPath,
					wait: false
				});
				const found = deepFind$1(submission, "prompt_id");
				if (typeof found !== "string" && typeof found !== "number") throw new Error(`comfy-mcp: run_workflow 没有返回 prompt_id（拿到 ${JSON.stringify(submission).slice(0, 300)}）`);
				promptId = String(found);
				request.onPromptId?.(promptId);
				const deadline = Date.now() + request.timeoutMs;
				for (;;) {
					const status = await this.callTool("job", {
						action: "status",
						prompt_id: promptId
					});
					const state = classifyJob(status);
					if (state === "failed") throw new Error(`comfy-mcp: prompt ${promptId} 执行失败\n${JSON.stringify(status).slice(0, 2e3)}`);
					if (state === "done") break;
					if (Date.now() + interval >= deadline) throw new Error(`comfy-mcp: 等 prompt ${promptId} 超过 ${request.timeoutMs} ms 仍未完成。ComfyUI 可能还在跑（首次加载权重常超过 110 s），结果仍可用 GET ${request.endpoint}/history/${promptId} 查到；把 timeoutMs 调大后重试。`);
					await (this.options.sleep ?? defaultSleep$1)(interval, request.signal);
				}
				const mirrorRoot = this.options.mirrorRoot;
				const outDir = mirrorRoot === void 0 ? join(scratch, "outputs") : join(mirrorRoot, promptId);
				mkdirSync(outDir, { recursive: true });
				let lastError;
				for (let attempt = 1; attempt <= 3; attempt += 1) try {
					await this.callTool("fetch_outputs", {
						prompt_id: promptId,
						out_dir: outDir
					});
					lastError = void 0;
					break;
				} catch (error) {
					lastError = error;
					if (attempt < 3) await (this.options.sleep ?? defaultSleep$1)(1e3, request.signal);
				}
				if (lastError !== void 0) throw lastError;
				const images = readImages$1(outDir);
				if (images.length === 0) throw new Error(`comfy-mcp: prompt ${promptId} 完成但 fetch_outputs 没有复制出任何图片（out_dir=${outDir}）`);
				return images;
			} catch (error) {
				const aborted = request.signal?.aborted === true;
				const timeout = error instanceof Error && error.message.includes("超过");
				if (aborted || timeout) await this.killTree().catch(() => void 0);
				throw error;
			} finally {
				rmSync(scratch, {
					recursive: true,
					force: true
				});
			}
		}
		async dispose() {
			this.disposed = true;
			await this.closeConnection();
		}
	};
}));
//#endregion
//#region src/cli-backend.ts
/**
* comfy-CLI fallback backend: the same {@link ImageBackend} contract as
* `src/mcp-backend.ts`, but spawning `comfy` directly instead of going through
* the MCP server (no `comfy-mcp` install, no stdio layer).
*
* Only the verbs verified from `comfy --help` in comfy-cli 1.26.0 are used
* (`run --wait`, `download`, `system-stats`); the workflow handed to
* `run --workflow` is the same API-format JSON the MCP path writes, so the
* caller cannot tell the two apart. comfy-cli accepts both API and exported UI
* workflow JSON and converts the UI form client-side.
*
* The CLI path is a **fallback**: MCP is tried first, HTTP last. It is also
* untested end-to-end against a real ComfyUI in T15 (declared in the report);
* its contract is pinned by `test/mcp-backend.test.mjs` with an injected spawn
* and the verbs above are the 1.26.0 `--help` surface.
*
* @module
*/
var cli_backend_exports = /* @__PURE__ */ __exportAll({
	CliBackend: () => CliBackend,
	createCliBackend: () => createCliBackend,
	parseEnvelope: () => parseEnvelope
});
function deepFind(value, key, depth = 0) {
	if (depth > 8 || value === null || typeof value !== "object") return void 0;
	if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
	for (const child of Object.values(value)) {
		const found = deepFind(child, key, depth + 1);
		if (found !== void 0) return found;
	}
}
/** Parse the last JSON object on stdout (comfy-cli envelope mode). */
function parseEnvelope(stdout) {
	const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index].trim();
		if (!line.startsWith("{")) continue;
		try {
			return JSON.parse(line);
		} catch {}
	}
}
function readImages(dir) {
	const files = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()) && statSync(path).size > 0) files.push(path);
		}
	};
	walk(dir);
	files.sort();
	return files.map((path) => {
		const bytes = new Uint8Array(readFileSync(path));
		return {
			bytes,
			mime: sniffImageMime(bytes) ?? "image/png"
		};
	});
}
/** Create the comfy-CLI fallback backend. */
function createCliBackend(options) {
	return new CliBackend(options);
}
var IMAGE_EXTENSIONS, defaultSpawn, CliBackend;
var init_cli_backend = __esmMin((() => {
	init_images();
	init_mcp_backend();
	IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
		".png",
		".jpg",
		".jpeg",
		".webp",
		".gif"
	]);
	defaultSpawn = (args, options) => new Promise((resolve, reject) => {
		const child = spawn(args[0] ?? "", args.slice(1), {
			env: { ...options.env },
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (code) => {
			if (settled) return;
			settled = true;
			resolve({
				code,
				stdout,
				stderr
			});
		};
		const timer = setTimeout(() => {
			if (child.pid !== void 0) killProcessTree(child.pid);
			settled = true;
			reject(/* @__PURE__ */ new Error(`comfy CLI: 超过 ${options.timeoutMs} ms 未返回`));
		}, Math.max(1, options.timeoutMs));
		timer.unref?.();
		options.signal?.addEventListener("abort", () => {
			if (child.pid !== void 0) killProcessTree(child.pid);
			clearTimeout(timer);
			if (!settled) {
				settled = true;
				reject(/* @__PURE__ */ new Error("comfy CLI: 已取消"));
			}
		}, { once: true });
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish(code);
		});
	});
	CliBackend = class {
		name = "cli";
		options;
		constructor(options) {
			this.options = options;
		}
		async invoke(args, timeoutMs, signal) {
			const env = { ...this.options.env ?? process.env };
			delete env.COMFYUI_URL;
			const spawnCommand = this.options.spawnCommand;
			const run = spawnCommand === void 0 ? defaultSpawn : spawnCommand;
			const invocation = spawnCommand === void 0 ? await run([this.options.command, ...args], {
				env,
				timeoutMs,
				signal
			}) : await run([...args], {
				env,
				timeoutMs,
				signal
			});
			const envelope = parseEnvelope(invocation.stdout);
			if (envelope === void 0) throw new Error(`comfy CLI: 没有 JSON envelope（exit ${String(invocation.code)}）${invocation.stderr.trim().slice(0, 1200)}`);
			if (deepFind(envelope, "ok") === false) {
				const message = deepFind(envelope, "message");
				throw new Error(`comfy CLI: ${typeof message === "string" ? message : JSON.stringify(envelope).slice(0, 1200)}`);
			}
			return envelope;
		}
		async run(request) {
			const scratchRoot = this.options.scratchRoot ?? tmpdir();
			mkdirSync(scratchRoot, { recursive: true });
			const scratch = mkdtempSync(join(scratchRoot, "dsh-image-forge-cli-"));
			try {
				const url = new URL(request.endpoint);
				const workflowPath = join(scratch, "workflow.json");
				writeFileSync(workflowPath, JSON.stringify(request.graph), "utf8");
				const host = url.hostname;
				const port = url.port === "" ? "80" : url.port;
				const seconds = Math.max(1, Math.ceil(request.timeoutMs / 1e3));
				const base = [
					"--json",
					"--where",
					"local",
					"--skip-prompt"
				];
				const submission = await this.invoke([
					...base,
					"run",
					"--workflow",
					workflowPath,
					"--wait",
					"--host",
					host,
					"--port",
					port,
					"--timeout",
					String(seconds)
				], request.timeoutMs, request.signal);
				const promptId = deepFind(submission, "prompt_id");
				if (typeof promptId !== "string" && typeof promptId !== "number") throw new Error(`comfy CLI: run 没有返回 prompt_id（拿到 ${JSON.stringify(submission).slice(0, 300)}）`);
				request.onPromptId?.(String(promptId));
				const outDir = this.options.mirrorRoot === void 0 ? join(scratch, "outputs") : join(this.options.mirrorRoot, String(promptId));
				mkdirSync(outDir, { recursive: true });
				await this.invoke([
					...base,
					"download",
					String(promptId),
					"--out-dir",
					outDir
				], request.timeoutMs, request.signal);
				const images = readImages(outDir);
				if (images.length === 0) throw new Error(`comfy CLI: download 没有写出任何图片（out_dir=${outDir}）`);
				return images;
			} finally {
				rmSync(scratch, {
					recursive: true,
					force: true
				});
			}
		}
		async dispose() {}
	};
}));
//#endregion
//#region src/backend.ts
/**
* Execution-backend seam between the ComfyUI graph pipeline and the transports
* that can run one graph.
*
* The graph itself is built once (`src/comfyui.ts`) and is transport-agnostic.
* Three transports exist, tried in this order:
*
* 1. **MCP** — spawn the official `comfy-mcp` stdio server and drive it with the
*    Host-supplied `@modelcontextprotocol/client`. The plugin declares that
*    package as a peer dependency; the Host's profile runtime resolution
*    supplies it (see [mcp-backend.md](../docs/mcp-backend.md)).
* 2. **comfy CLI** — spawn `comfy run/download` directly, no MCP layer.
* 3. **HTTP** — the original `/prompt` → `/history` → `/view` path in
*    `src/comfyui.ts`, kept last so a missing toolchain never loses a feature.
*
* Selection is **config-driven since T22** (`executionBackend` + the four
* executable/budget fields on the settings page), with the T15 environment
* variables kept as overrides so an existing deployment — and every CI fixture —
* behaves exactly as before. Precedence: environment variable > config field >
* PATH lookup. Documented variables (all optional; an empty environment keeps
* the historical HTTP-only behaviour):
*
* - `DSH_IMAGE_FORGE_BACKEND` — `auto` (default) | `mcp` | `cli` | `http`.
*   `mcp`/`cli` are strict: that backend's failure is the call's failure, no
*   silent HTTP fallback.
* - `DSH_IMAGE_FORGE_COMFY_MCP_BIN` — absolute path of `comfy-mcp(.exe)`;
*   otherwise `comfy-mcp` on `PATH`.
* - `DSH_IMAGE_FORGE_COMFY_BIN` — absolute path of `comfy(.exe)` handed to the
*   MCP child as `COMFY_BIN`; otherwise `comfy` on `PATH`.
* - `DSH_IMAGE_FORGE_BACKEND_TIMEOUT_MS` — optional per-backend budget override.
* - `DSH_IMAGE_FORGE_MCP_DEBUG` — `1` writes one stderr line per MCP tool call.
* - `DSH_IMAGE_FORGE_BACKEND_TMPDIR` — parent of per-run scratch/mirror dirs.
*
* @module
*/
/** Environment variable selecting the backend chain. */
const ENV_BACKEND = "DSH_IMAGE_FORGE_BACKEND";
/** Locate an executable on `PATH` (with Windows `PATHEXT` support). */
function findExecutable(name, pathEnv = process.env.PATH, platform = process.platform) {
	if (name === "") return void 0;
	const separators = [delimiter, platform === "win32" ? ";" : ":"];
	const dirs = /* @__PURE__ */ new Set();
	for (const separator of separators) for (const entry of (pathEnv ?? "").split(separator)) if (entry !== "") dirs.add(entry);
	const suffixes = platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
	for (const dir of dirs) for (const suffix of suffixes) {
		const candidate = join(dir, name.endsWith(suffix.toLowerCase()) || name.endsWith(suffix.toUpperCase()) ? name : name + suffix);
		if (existsSync(candidate)) return candidate;
	}
}
let backendDefaults = {};
/** Install the config-derived defaults (called on every config resolution). */
function configureBackendDefaults(defaults) {
	backendDefaults = { ...defaults };
}
/** `<outputDir>/.dsh-image-forge/backend-mirror`: inside the board store. */
function defaultMirrorRoot(outputDir) {
	return outputDir === void 0 || outputDir.trim() === "" ? void 0 : join(outputDir.trim(), ".dsh-image-forge", "backend-mirror");
}
/** Read the backend plan from an environment + config defaults (env wins). */
function resolveBackendPlan(env = process.env, defaults = backendDefaults) {
	const rawMode = (env["DSH_IMAGE_FORGE_BACKEND"] ?? "").trim().toLowerCase();
	const configuredMode = (defaults.backend ?? "").trim().toLowerCase();
	const wanted = rawMode !== "" ? rawMode : configuredMode;
	const mode = wanted === "mcp" || wanted === "cli" || wanted === "http" ? wanted : "auto";
	if (rawMode !== "" && rawMode !== mode) throw new Error(`${ENV_BACKEND}=${rawMode} 不合法：可选 auto / mcp / cli / http。`);
	const timeout = Number((env["DSH_IMAGE_FORGE_BACKEND_TIMEOUT_MS"] ?? "").trim());
	const configuredTimeout = defaults.backendTimeoutMs;
	const configuredDebug = defaults.mcpDebug === true;
	const debugEnv = env.DSH_IMAGE_FORGE_MCP_DEBUG;
	const tmpDir = (env.DSH_IMAGE_FORGE_BACKEND_TMPDIR ?? "").trim() || (defaults.backendTmpDir ?? "").trim();
	return {
		mode,
		mcpCommand: (env["DSH_IMAGE_FORGE_COMFY_MCP_BIN"] ?? "").trim() || (defaults.comfyMcpBin ?? "").trim() || findExecutable("comfy-mcp", env.PATH),
		comfyCommand: (env["DSH_IMAGE_FORGE_COMFY_BIN"] ?? "").trim() || (defaults.comfyBin ?? "").trim() || findExecutable("comfy", env.PATH),
		timeoutMsOverride: Number.isFinite(timeout) && timeout > 0 ? timeout : Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : void 0,
		scratchRoot: tmpDir === "" ? void 0 : tmpDir,
		mirrorRoot: defaultMirrorRoot(defaults.outputDir),
		debug: debugEnv === void 0 ? configuredDebug : debugEnv === "1"
	};
}
/**
* Run one graph through the non-HTTP backends the plan allows.
*
* `auto` swallows a backend's failure and tries the next one (the caller then
* falls back to HTTP); `mcp`/`cli` re-throw that backend's error. Returns
* `undefined` when no non-HTTP backend is configured/available, which is the
* no-toolchain path every existing test exercises.
*/
async function runThroughBackends(request, plan, factories = {}) {
	if (plan.mode === "http") return void 0;
	const attempts = [];
	if (plan.mode !== "cli" && plan.mcpCommand !== void 0) attempts.push({
		name: "mcp",
		create: factories.createMcpBackend ?? (async () => {
			const { createMcpBackend } = await Promise.resolve().then(() => (init_mcp_backend(), mcp_backend_exports));
			return createMcpBackend({
				command: plan.mcpCommand,
				comfyBin: plan.comfyCommand,
				env: process.env,
				debug: plan.debug,
				...plan.scratchRoot === void 0 ? {} : { scratchRoot: plan.scratchRoot },
				...plan.mirrorRoot === void 0 ? {} : { mirrorRoot: plan.mirrorRoot }
			});
		})
	});
	if (plan.mode !== "mcp" && plan.comfyCommand !== void 0) attempts.push({
		name: "cli",
		create: factories.createCliBackend ?? (async () => {
			const { createCliBackend } = await Promise.resolve().then(() => (init_cli_backend(), cli_backend_exports));
			return createCliBackend({
				command: plan.comfyCommand,
				env: process.env,
				...plan.scratchRoot === void 0 ? {} : { scratchRoot: plan.scratchRoot },
				...plan.mirrorRoot === void 0 ? {} : { mirrorRoot: plan.mirrorRoot }
			});
		})
	});
	if (attempts.length === 0) return void 0;
	const skipped = [];
	for (const attempt of attempts) {
		let backend;
		try {
			backend = await attempt.create(plan);
			const budget = plan.timeoutMsOverride === void 0 ? request.timeoutMs : Math.min(request.timeoutMs, plan.timeoutMsOverride);
			const images = await backend.run({
				...request,
				timeoutMs: budget
			});
			return {
				via: attempt.name,
				images,
				skipped
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (plan.mode === attempt.name) throw error;
			skipped.push(`${attempt.name}: ${message}`);
		} finally {
			await backend?.dispose().catch(() => void 0);
		}
	}
}
//#endregion
//#region src/model-profiles.ts
/**
* Model profiles: everything that changes when the checkpoint family behind
* ComfyUI changes, kept in one table instead of scattered over the adapter.
*
* The plugin used to be Qwen-Image only, and that assumption was spread out:
* `/qwen/i` was the hard gate that selected weights, `'qwen_image'` was the only
* accepted `CLIPLoader.type`, the four graphs were module-level constants, and
* the step/sampler numbers were literals inside each generation function. Adding
* a second family (MOSS-Image) that way would have meant a second copy of the
* weight selection, a second set of graphs and a second set of branches at every
* call site — i.e. two adapters wearing one name.
*
* A profile is the **data** half of a family. It owns:
*
* - which weight files to look for (a matcher per loader field, with the example
*   names that appear in error text),
* - which `CLIPLoader.type` value the graph must use,
* - the latent node and its alignment granularity,
* - the sampler, scheduler, CFG, default step count and — when the checkpoint
*   needs it — the explicit sigma schedule,
* - the negative prompt the family recommends,
* - and the workflow constructors (text-to-image always; image-to-image when the
*   family has an edit graph).
*
* It deliberately does **not** own: pixel sizing (`ratio.ts` keeps that, and every
* canvas it produces is aligned to at least 32), HTTP/loopback policy, retries,
* error phrasing or the tool surface. Those stay in `comfyui.ts` / `tools.ts`, so
* one code path serves every profile.
*
* Nothing here reads the network, the disk or the environment: the module is
* pure data plus constructors, so it is directly testable offline.
*/
/** The canonical id of a model family/variant, as stored in `comfyModel`. */
const COMFY_MODEL_IDS = [
	"qwen21-base",
	"qwen21-turbo",
	"moss-sft"
];
/**
* The two ids the config carried before profiles existed.
*
* They stay **accepted** forever: a profile patch, an old `cordis.yml` or a
* saved settings document may still say `base` / `turbo`, and silently dropping
* that to the default would change what a user already chose.
*/
const LEGACY_COMFY_MODEL_IDS = ["base", "turbo"];
/** The id used when the config says nothing. */
const DEFAULT_COMFY_MODEL = "qwen21-base";
/**
* The Qwen-Image 2.1 text-to-image graph, in ComfyUI's API format.
*
* `{{name}}` placeholders are filled by `renderWorkflow` in `comfyui.ts`; the
* three model file names are placeholders on purpose — they come from
* `/object_info`.
*/
const QWEN_IMAGE_WORKFLOW = {
	"1": {
		class_type: "UNETLoader",
		inputs: {
			unet_name: "{{unet_name}}",
			weight_dtype: "{{weight_dtype}}"
		}
	},
	"9": {
		class_type: "QwenImage21Cache",
		inputs: {
			model: ["1", 0],
			device: "auto",
			dtype: "default"
		}
	},
	"2": {
		class_type: "CLIPLoader",
		inputs: {
			clip_name: "{{clip_name}}",
			type: "{{clip_type}}"
		}
	},
	"3": {
		class_type: "VAELoader",
		inputs: { vae_name: "{{vae_name}}" }
	},
	"4": {
		class_type: "TextEncodeQwenImage21",
		inputs: {
			clip: ["2", 0],
			prompt: "{{prompt}}",
			negative_prompt: "{{negative_prompt}}",
			resolution: 1024
		}
	},
	"5": {
		class_type: "EmptyLatentImage",
		inputs: {
			width: "{{width}}",
			height: "{{height}}",
			batch_size: "{{batch_size}}"
		}
	},
	"6": {
		class_type: "KSampler",
		inputs: {
			model: ["9", 0],
			positive: ["4", 0],
			negative: ["4", 1],
			latent_image: ["5", 0],
			seed: "{{seed}}",
			steps: "{{steps}}",
			cfg: "{{cfg}}",
			sampler_name: "{{sampler_name}}",
			scheduler: "{{scheduler}}",
			denoise: 1
		}
	},
	"7": {
		class_type: "VAEDecode",
		inputs: {
			samples: ["6", 0],
			vae: ["3", 0]
		}
	},
	"8": {
		class_type: "SaveImage",
		inputs: {
			images: ["7", 0],
			filename_prefix: "{{filename_prefix}}"
		}
	}
};
/**
* The Qwen edit graph, which is the text-to-image graph with a different encode
* node: `TextEncodeQwenImage21` additionally receives the VAE (it VAE-encodes
* each reference into the condition) and a `resolution` pixel budget. The
* reference slots themselves are added per call by {@link editWorkflow}.
*/
const QWEN_IMAGE_EDIT_WORKFLOW = {
	...QWEN_IMAGE_WORKFLOW,
	"4": {
		class_type: "TextEncodeQwenImage21",
		inputs: {
			clip: ["2", 0],
			vae: ["3", 0],
			prompt: "{{prompt}}",
			negative_prompt: "{{negative_prompt}}",
			resolution: "{{resolution}}"
		}
	}
};
/**
* Wire one `LoadImage` per reference into an edit graph's autogrow inputs.
*
* ComfyUI's schema DSL expands the autogrow `images` input into
* `images.image_1` … `images.image_16`, all optional, and validates by those
* dotted names — which is also how the official edit template refers to them.
*
* @param template - the edit graph to start from (Qwen base or turbo).
* @param firstNodeId - the first `LoadImage` node id for that graph.
* @param imageNames - file names inside ComfyUI's `input` folder, in prompt order.
* @returns a fresh API-format graph with one loader per reference.
* @throws When the list is empty or longer than {@link EDIT_MAX_REFERENCES}.
*/
function wireReferenceSlots(template, firstNodeId, imageNames) {
	if (imageNames.length === 0) throw new Error("comfyui backend: the edit graph needs at least one reference image");
	if (imageNames.length > 10) throw new Error(`comfyui backend: the edit graph wires 10 reference slots, got ${imageNames.length}`);
	const graph = { ...template };
	const encode = {
		class_type: "TextEncodeQwenImage21",
		inputs: { ...template["4"].inputs }
	};
	graph["4"] = encode;
	for (const [position, name] of imageNames.entries()) {
		const id = String(firstNodeId + position);
		graph[id] = {
			class_type: "LoadImage",
			inputs: { image: name }
		};
		encode.inputs[`images.image_${position + 1}`] = [id, 0];
	}
	return graph;
}
/**
* Wire one `LoadImage` per reference into the Qwen base edit graph.
*
* @param imageNames - file names inside ComfyUI's `input` folder, in prompt order.
* @returns a fresh API-format graph with one loader per reference.
*/
function editWorkflow(imageNames) {
	return wireReferenceSlots(QWEN_IMAGE_EDIT_WORKFLOW, 11, imageNames);
}
/** Wire one `LoadImage` per reference into the Qwen turbo edit graph. */
function editTurboWorkflow(imageNames) {
	return wireReferenceSlots(QWEN_IMAGE_TURBO_EDIT_WORKFLOW, 13, imageNames);
}
/**
* The sigma schedule the Turbo checkpoint was distilled for.
*
* Copied verbatim from the official `image_qwen_image_2_1_turbo_t2i.json`
* template's `ManualSigmas` node. Raising the step count **without** swapping
* this schedule in makes the result worse, not better.
*/
const TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0";
/**
* The Turbo text-to-image graph, in ComfyUI's API format.
*
* The Turbo templates do **not** use `KSampler`. They drive
* `SamplerCustomAdvanced`, which takes the noise, guider, sampler and sigmas as
* separate inputs — that separation is the only way to hand it a `ManualSigmas`
* node, and the manual schedule is the whole point of the turbo checkpoint:
*
* ```
* RandomNoise ─┐
* CFGGuider ───┼→ SamplerCustomAdvanced → VAEDecode → SaveImage
* KSamplerSelect┤
* ManualSigmas ─┤
* EmptyLatentImage ─┘
* ```
*/
const QWEN_IMAGE_TURBO_WORKFLOW = {
	"1": {
		class_type: "UNETLoader",
		inputs: {
			unet_name: "{{unet_name}}",
			weight_dtype: "{{weight_dtype}}"
		}
	},
	"23": {
		class_type: "QwenImage21Cache",
		inputs: {
			model: ["1", 0],
			device: "auto",
			dtype: "default"
		}
	},
	"2": {
		class_type: "CLIPLoader",
		inputs: {
			clip_name: "{{clip_name}}",
			type: "{{clip_type}}"
		}
	},
	"3": {
		class_type: "VAELoader",
		inputs: { vae_name: "{{vae_name}}" }
	},
	"4": {
		class_type: "TextEncodeQwenImage21",
		inputs: {
			clip: ["2", 0],
			prompt: "{{prompt}}",
			negative_prompt: "{{negative_prompt}}",
			resolution: 1024
		}
	},
	"5": {
		class_type: "EmptyLatentImage",
		inputs: {
			width: "{{width}}",
			height: "{{height}}",
			batch_size: "{{batch_size}}"
		}
	},
	"6": {
		class_type: "RandomNoise",
		inputs: { noise_seed: "{{seed}}" }
	},
	"7": {
		class_type: "CFGGuider",
		inputs: {
			model: ["23", 0],
			positive: ["4", 0],
			negative: ["4", 1],
			cfg: "{{cfg}}"
		}
	},
	"8": {
		class_type: "KSamplerSelect",
		inputs: { sampler_name: "{{sampler_name}}" }
	},
	"9": {
		class_type: "ManualSigmas",
		inputs: { sigmas: "{{sigmas}}" }
	},
	"10": {
		class_type: "SamplerCustomAdvanced",
		inputs: {
			noise: ["6", 0],
			guider: ["7", 0],
			sampler: ["8", 0],
			sigmas: ["9", 0],
			latent_image: ["5", 0]
		}
	},
	"11": {
		class_type: "VAEDecode",
		inputs: {
			samples: ["10", 0],
			vae: ["3", 0]
		}
	},
	"12": {
		class_type: "SaveImage",
		inputs: {
			images: ["11", 0],
			filename_prefix: "{{filename_prefix}}"
		}
	}
};
/**
* The Turbo edit graph: the turbo skeleton plus the edit encode node plus the
* reference slots that {@link editTurboWorkflow} wires per call.
*
* `cfg` is **1**, the same as the turbo t2i graph: at cfg 1 ComfyUI skips the
* negative conditioning pass entirely, so an elevated cfg with an empty negative
* prompt does not sharpen the edit; it degrades it.
*/
const QWEN_IMAGE_TURBO_EDIT_WORKFLOW = {
	...QWEN_IMAGE_TURBO_WORKFLOW,
	"4": {
		class_type: "TextEncodeQwenImage21",
		inputs: {
			clip: ["2", 0],
			vae: ["3", 0],
			prompt: "{{prompt}}",
			negative_prompt: "{{negative_prompt}}",
			resolution: "{{resolution}}"
		}
	}
};
/**
* Drop the `QwenImage21Cache` shim from a graph, rewiring its consumer to the
* UNETLoader directly.
*
* The shim is a runtime speedup, not a correctness requirement: an older ComfyUI
* (< 0.37.0) rejects the whole graph when a node class is unknown, so when
* `/object_info` does not list it the adapter removes it and keeps the image
* instead of failing the run. A graph without a shim is returned as a fresh copy
* unchanged, so the caller can render either result.
*
* @param graph - an API-format graph, possibly carrying one cache shim.
* @returns a graph with every cache node removed and every consumer rewired.
*/
function withoutQwenCache(graph) {
	const cacheIds = new Set(Object.entries(graph).filter(([, node]) => node.class_type === "QwenImage21Cache").map(([id]) => id));
	if (cacheIds.size === 0) return { ...graph };
	const out = {};
	for (const [id, node] of Object.entries(graph)) if (!cacheIds.has(id)) out[id] = {
		class_type: node.class_type,
		inputs: { ...node.inputs }
	};
	for (const cacheId of cacheIds) {
		const upstream = graph[cacheId]?.inputs.model;
		if (!Array.isArray(upstream)) continue;
		for (const node of Object.values(out)) for (const [name, value] of Object.entries(node.inputs)) if (Array.isArray(value) && value[0] === cacheId) node.inputs[name] = [...upstream];
	}
	return out;
}
/**
* The negative prompt MOSS-Image recommends, verbatim from the official
* template's negative widget and its USERGUIDE.
*
* Unlike Qwen-Image, MOSS runs at CFG 2.5 (not 1), so the negative conditioning
* pass is **not** skipped and this string actually steers the sample.
*/
const MOSS_NEGATIVE_PROMPT = "nsfw, worst quality, bad anatomy, watermark, jpeg artifact";
/**
* The MOSS-Image text-to-image graph, in ComfyUI's API format.
*
* Node for node this is `verify/moss_image_t2i_api.json` (the sample that
* produced this machine's verified MOSS renders), with the three weights and the
* per-call numbers turned into placeholders:
*
* ```
* UNETLoader → SkipLayerGuidanceDiTSimple(single_layers="22") ─┐
* CLIPLoader(moss_image) → CLIPTextEncode(positive/negative) ──┼→ KSampler
* EmptyFlux2LatentImage ──────────────────────────────────────┘   (er_sde/simple)
* KSampler → VAEDecode → SaveImage
* ```
*
* Cross-checked against the official UI template
* (`comfyui_workflow_templates_json/templates/image_moss_image_t2i.json`), whose
* `Text to Image (MOSS-Image)` subgraph carries exactly these nodes and widget
* values: `CLIPTextEncode` (not `TextEncodeQwenImage21`), `EmptyFlux2LatentImage`,
* `SkipLayerGuidanceDiTSimple` with `double_layers=""` / `single_layers="22"` /
* `start_percent=0` / `end_percent=0.5`, and `KSampler` at 25 steps / CFG 2.5 /
* `er_sde` / `simple` / denoise 1.
*
* What is deliberately **absent**, mirroring the Qwen path's own reductions:
*
* - the template's prompt-upsampler branch (`TextGenerate` + `ComfySwitchNode` +
*   `PreviewAny`): this plugin never rewrites the caller's prompt — that is the
*   skill's job — and the upsampler needs no weights beyond the ones we already
*   require;
* - its `ResolutionSelector`: the canvas is decided by `ratio.ts`, and every size
*   it produces is 32-aligned, i.e. also a multiple of MOSS's 16 (see
*   {@link MOSS_LATENT_MULTIPLE});
* - any `ModelSampling*` node: shift 5 is MOSS's own model default, and the
*   official template notes `ModelSamplingSD3` uses a different scale entirely.
*
* Note there is no `steps`-carrying sampler-select node here: MOSS uses a plain
* `KSampler`, and its sigma behaviour is the model's default (no manual
* schedule), which is why this profile has no `sigmas`.
*/
const MOSS_IMAGE_WORKFLOW = {
	"1": {
		class_type: "UNETLoader",
		inputs: {
			unet_name: "{{unet_name}}",
			weight_dtype: "{{weight_dtype}}"
		}
	},
	"2": {
		class_type: "CLIPLoader",
		inputs: {
			clip_name: "{{clip_name}}",
			type: "{{clip_type}}"
		}
	},
	"3": {
		class_type: "VAELoader",
		inputs: { vae_name: "{{vae_name}}" }
	},
	"4": {
		class_type: "CLIPTextEncode",
		inputs: {
			text: "{{prompt}}",
			clip: ["2", 0]
		}
	},
	"5": {
		class_type: "CLIPTextEncode",
		inputs: {
			text: "{{negative_prompt}}",
			clip: ["2", 0]
		}
	},
	"6": {
		class_type: "EmptyFlux2LatentImage",
		inputs: {
			width: "{{width}}",
			height: "{{height}}",
			batch_size: "{{batch_size}}"
		}
	},
	"7": {
		class_type: "SkipLayerGuidanceDiTSimple",
		inputs: {
			model: ["1", 0],
			double_layers: "",
			single_layers: "22",
			start_percent: 0,
			end_percent: .5
		}
	},
	"8": {
		class_type: "KSampler",
		inputs: {
			model: ["7", 0],
			seed: "{{seed}}",
			steps: "{{steps}}",
			cfg: "{{cfg}}",
			sampler_name: "{{sampler_name}}",
			scheduler: "{{scheduler}}",
			denoise: 1,
			positive: ["4", 0],
			negative: ["5", 0],
			latent_image: ["6", 0]
		}
	},
	"9": {
		class_type: "VAEDecode",
		inputs: {
			samples: ["8", 0],
			vae: ["3", 0]
		}
	},
	"10": {
		class_type: "SaveImage",
		inputs: {
			images: ["9", 0],
			filename_prefix: "{{filename_prefix}}"
		}
	}
};
/** Item labels the official compiler emits; anything else is a typo. */
const MOSS_LAYOUT_LABELS = [
	"object",
	"character",
	"text"
];
/**
* Parse and validate a compiled layout prompt.
*
* The layout is prompt text, not workflow wiring: the compiled JSON is handed to
* ComfyUI's `CreateBoundingBoxes` node as a string. Validation therefore fails
* loudly on anything the node would choke on — malformed JSON, the wrong
* coordinate space or order, an empty item list, a box that is not four finite
* numbers — instead of submitting a graph that silently ignores the layout.
*
* @param input - the compiled JSON string (the layout editor's "compiled" export).
* @returns the parsed document plus the strings the layout graph needs.
* @throws When the JSON is not a valid compiled layout prompt.
*/
function parseMossLayout(input) {
	let parsed;
	try {
		parsed = JSON.parse(input);
	} catch {
		throw new Error("moss layout: 布局不是合法 JSON。请传布局编辑器导出的 compiled 文本（abs_centralized / yxyx）。");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("moss layout: 布局必须是一个 JSON 对象（含 summary / items / bbox_coord_space / bbox_format）。");
	const document = parsed;
	if (document.bbox_coord_space !== "abs_centralized") throw new Error("moss layout: bbox_coord_space 必须是 abs_centralized，收到 " + String(document.bbox_coord_space) + "。请用布局编辑器导出的 compiled 文本，不要手改坐标空间。");
	if (document.bbox_format !== "yxyx") throw new Error("moss layout: bbox_format 必须是 yxyx，收到 " + String(document.bbox_format) + "。compiled 布局的 bbox 顺序是 [y1, x1, y2, x2]。");
	if (!Array.isArray(document.items) || document.items.length === 0) throw new Error("moss layout: items 必须是非空数组（至少一个画框）。");
	const items = document.items.map((raw, index) => {
		const position = "items[" + String(index) + "]";
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("moss layout: " + position + " 必须是对象（label / caption / bbox）。");
		const item = raw;
		if (typeof item.caption !== "string" || item.caption.trim().length === 0) throw new Error("moss layout: " + position + ".caption 必须是非空字符串。");
		if (item.label !== void 0 && !MOSS_LAYOUT_LABELS.includes(item.label)) throw new Error("moss layout: " + position + ".label 只能是 object / character / text。");
		if (!Array.isArray(item.bbox) || item.bbox.length !== 4 || !item.bbox.every((value) => Number.isFinite(value))) throw new Error("moss layout: " + position + ".bbox 必须是 [y1, x1, y2, x2] 四个有限数字。");
		return {
			label: typeof item.label === "string" ? item.label : void 0,
			caption: item.caption,
			text: typeof item.text === "string" ? item.text : void 0,
			bbox: item.bbox
		};
	});
	const caption = document.summary?.caption;
	if (typeof caption !== "string" || caption.trim().length === 0) throw new Error("moss layout: summary.caption 必须是非空字符串——它是整图描述，MOSS 的布局 prompt 把它作为整体语义；只画框不给整图描述时，布局和提示词会互相打架。");
	return {
		document: {
			summary: document.summary,
			items,
			bbox_coord_space: "abs_centralized",
			bbox_format: "yxyx"
		},
		json: input
	};
}
/**
* The layout-conditioned MOSS-Image graph.
*
* Identical to {@link MOSS_IMAGE_WORKFLOW} except that the positive encoder's
* text is the compiled layout prompt instead of the caller's prose. That is what
* the native nodes would ultimately produce: `MOSSImageLayoutPrompt.execute`
* compiles drawn boxes into exactly this JSON shape (`{summary:{caption},
* items,bbox_coord_space:'abs_centralized',bbox_format:'yxyx'}`) and the official
* template feeds that string into the positive `CLIPTextEncode`. Compiling in the
* editor and passing the compiled text keeps the graph to one extra value, with
* no element-array round trip that the API cannot express (see the comment
* inside the graph).
*
* The no-layout path keeps using {@link MOSS_IMAGE_WORKFLOW} unchanged — a
* request without a layout must stay byte-identical.
*/
const MOSS_IMAGE_LAYOUT_WORKFLOW = {
	...MOSS_IMAGE_WORKFLOW,
	"4": {
		class_type: "CLIPTextEncode",
		inputs: {
			text: "{{layout_json}}",
			clip: ["2", 0]
		}
	}
};
/**
* The community edit LoRA that turns MOSS-Image into an instructable editor.
*
* Not part of the base checkpoint: it is a separate file under `models/loras/`
* (`verify/fetch_moss_weights.py` lists it next to the three weights). The graph
* wires it through `LoraLoaderModelOnly` immediately after `UNETLoader`, which is
* how the official `image_moss_image_edit.json` template does it.
*/
const MOSS_EDIT_LORA = "moss_image_edit_lora_rank_64_bf16.safetensors";
/**
* The `edit_format` value the LoRA above was trained with.
*
* `TextEncodeMOSSImageEdit` also accepts the two ai-toolkit formats, but those are
* a different training regime (`verify/results.json` gotchas): pairing them with
* this LoRA hands the encoder a condition it was never trained against.
*/
const MOSS_EDIT_FORMAT = "Moss-Image-Edit";
/**
* The MOSS-Image edit graph, in ComfyUI's API format.
*
* Node for node this is `verify/moss_image_edit_api.json` — the sample that
* produced this machine's verified edit render — with two deliberate differences:
*
* 1. the sampler numbers are placeholders instead of the sample's literals
*    (30 steps / CFG 4 / `euler` / `normal`). A profile owns its sampler, so an
*    edit runs the same `mossSampling` register as its text-to-image graph
*    instead of a second, silently different working point;
* 2. the sample derives the canvas from `ImageScaleToTotalPixels` +
*    `GetImageSize`; here the canvas is the one `ratio.ts` already picked and each
*    reference is scaled **to that canvas** (see {@link mossEditWorkflow}). The
*    edit LoRA conditions on reference latents, so reference and target have to
*    agree on size — and taking the canvas from the plugin keeps the reported
*    size, the filename size and the pixels on disk the same numbers.
*
* Everything else is the sample's shape, kept verbatim: the LoRA after the
* `UNETLoader`, one `TextEncodeMOSSImageEdit` per polarity (the negative node
* takes the profile's negative prompt and the same references), `Moss-Image-Edit`
* as the format, `SkipLayerGuidanceDiTSimple` across the whole schedule
* (`end_percent` 1, unlike the t2i graph's 0.5) and `denoise` 1.
*
* The reference slots are added per call by {@link mossEditWorkflow}; there are
* none in this template.
*/
const MOSS_IMAGE_EDIT_WORKFLOW = {
	"1": {
		class_type: "UNETLoader",
		inputs: {
			unet_name: "{{unet_name}}",
			weight_dtype: "{{weight_dtype}}"
		}
	},
	"2": {
		class_type: "LoraLoaderModelOnly",
		inputs: {
			model: ["1", 0],
			lora_name: MOSS_EDIT_LORA,
			strength_model: 1
		}
	},
	"3": {
		class_type: "CLIPLoader",
		inputs: {
			clip_name: "{{clip_name}}",
			type: "{{clip_type}}",
			device: "default"
		}
	},
	"4": {
		class_type: "VAELoader",
		inputs: { vae_name: "{{vae_name}}" }
	},
	"5": {
		class_type: "EmptyFlux2LatentImage",
		inputs: {
			width: "{{width}}",
			height: "{{height}}",
			batch_size: "{{batch_size}}"
		}
	},
	"6": {
		class_type: "SkipLayerGuidanceDiTSimple",
		inputs: {
			model: ["2", 0],
			double_layers: "",
			single_layers: "22",
			start_percent: 0,
			end_percent: 1
		}
	},
	"7": {
		class_type: "TextEncodeMOSSImageEdit",
		inputs: {
			clip: ["3", 0],
			prompt: "{{prompt}}",
			edit_format: MOSS_EDIT_FORMAT,
			image_strength: 1,
			vae: ["4", 0]
		}
	},
	"8": {
		class_type: "TextEncodeMOSSImageEdit",
		inputs: {
			clip: ["3", 0],
			prompt: "{{negative_prompt}}",
			edit_format: MOSS_EDIT_FORMAT,
			image_strength: 1,
			vae: ["4", 0]
		}
	},
	"9": {
		class_type: "KSampler",
		inputs: {
			model: ["6", 0],
			seed: "{{seed}}",
			steps: "{{steps}}",
			cfg: "{{cfg}}",
			sampler_name: "{{sampler_name}}",
			scheduler: "{{scheduler}}",
			denoise: 1,
			positive: ["7", 0],
			negative: ["8", 0],
			latent_image: ["5", 0]
		}
	},
	"10": {
		class_type: "VAEDecode",
		inputs: {
			samples: ["9", 0],
			vae: ["4", 0]
		}
	},
	"11": {
		class_type: "SaveImage",
		inputs: {
			images: ["10", 0],
			filename_prefix: "{{filename_prefix}}"
		}
	}
};
/**
* Wire one reference into the MOSS edit graph.
*
* Each reference becomes `LoadImage` → `ImageScale` (to the canvas passed in
* `{{width}}`/`{{height}}`, aspect preserved by a centre crop) → one autogrow
* slot on **both** `TextEncodeMOSSImageEdit` nodes. That is the same per-call
* shape as the Qwen edit path (`wireReferenceSlots`), with the MOSS reference
* slots named `images.image_0` … `images.image_9` — the autogrow input is declared
* with `prefix: image_` and a 0-based index, unlike Qwen's 1-based
* `images.image_1` (verified against ComfyUI 0.45.3's `/object_info`).
*
* @param imageNames - file names inside ComfyUI's `input` folder, in prompt order.
* @returns a fresh API-format graph with one loader and one scaler per reference.
* @throws When the list is empty or longer than {@link EDIT_MAX_REFERENCES}.
*/
function mossEditWorkflow(imageNames) {
	if (imageNames.length === 0) throw new Error("comfyui backend: the MOSS edit graph needs at least one reference image");
	if (imageNames.length > 10) throw new Error(`comfyui backend: the MOSS edit graph wires 10 reference slots, got ${imageNames.length}`);
	const graph = { ...MOSS_IMAGE_EDIT_WORKFLOW };
	const positive = {
		class_type: "TextEncodeMOSSImageEdit",
		inputs: { ...MOSS_IMAGE_EDIT_WORKFLOW["7"].inputs }
	};
	const negative = {
		class_type: "TextEncodeMOSSImageEdit",
		inputs: { ...MOSS_IMAGE_EDIT_WORKFLOW["8"].inputs }
	};
	graph["7"] = positive;
	graph["8"] = negative;
	for (const [position, name] of imageNames.entries()) {
		const loadId = String(101 + position);
		const scaleId = String(121 + position);
		graph[loadId] = {
			class_type: "LoadImage",
			inputs: { image: name }
		};
		graph[scaleId] = {
			class_type: "ImageScale",
			inputs: {
				image: [loadId, 0],
				upscale_method: "lanczos",
				width: "{{width}}",
				height: "{{height}}",
				crop: "center"
			}
		};
		positive.inputs[`images.image_${position}`] = [scaleId, 0];
		negative.inputs[`images.image_${position}`] = [scaleId, 0];
	}
	return graph;
}
/**
* The two MOSS-Image sampling registers.
*
* `comfy` is what the official ComfyUI template's `image_moss_image_t2i.json`
* runs (it notes it uses kijai's faster settings from PR #17095), and it is what
* produced this machine's verified sample (`verify/moss_image_t2i_api.json`).
* `official` is OpenMOSS's own recommendation. Both keep the model's own shift
* of 5 — no `ModelSampling*` node, no manual sigma schedule.
*/
const MOSS_SAMPLING_PRESETS = ["comfy", "official"];
/** The register used when the config says nothing: the verified one. */
const DEFAULT_MOSS_SAMPLING = "comfy";
const QWEN_BASE_WEIGHTS = {
	unet: {
		loader: "UNETLoader",
		field: "unet_name",
		folder: "unet",
		what: "Qwen-Image 2.1 的 DiT（去噪主干）",
		example: "qwen_image_2.1_int8_convrot.safetensors",
		required: /qwen/i,
		bonus: [
			/image/i,
			/2[._-]?1/,
			/int8/i
		],
		avoid: [/turbo/i]
	},
	clip: {
		loader: "CLIPLoader",
		field: "clip_name",
		folder: "clip",
		what: "Qwen-Image 2.1 的文本编码器（Qwen3-VL 8B）",
		example: "qwen3vl_8b_int8_convrot.safetensors",
		required: /qwen/i,
		bonus: [
			/vl/i,
			/8b/i,
			/w4a8/i,
			/int8/i
		]
	},
	vae: {
		loader: "VAELoader",
		field: "vae_name",
		folder: "vae",
		what: "Qwen-Image 2.1 的 VAE",
		example: "qwen_image_2.1_vae_bf16.safetensors",
		required: /qwen/i,
		bonus: [
			/vae/i,
			/2[._-]?1/,
			/bf16/i
		]
	}
};
const QWEN_TURBO_WEIGHTS = {
	...QWEN_BASE_WEIGHTS,
	unet: {
		...QWEN_BASE_WEIGHTS.unet,
		example: "qwen_image_2.1_turbo_int8_convrot.safetensors",
		bonus: [
			/turbo/i,
			/image/i,
			/2[._-]?1/,
			/int8/i
		],
		avoid: []
	}
};
/**
* MOSS-Image's weights.
*
* **None of the three matchers is `/qwen/i`** — that is the whole point of the
* profile: the DiT is `moss_image_sft_*` and the VAE is `flux2-vae_small`, i.e.
* exactly the two files the old hard gate could never accept. The text encoder
* happens to be a Qwen3.5 file, so that matcher still keys on the version it
* really ships as.
*/
const MOSS_WEIGHTS = {
	unet: {
		loader: "UNETLoader",
		field: "unet_name",
		folder: "diffusion_models",
		what: "MOSS-Image 的 DiT（去噪主干；SFT 与 Base 都可跑同一张图）",
		example: "moss_image_sft_int8_convrot.safetensors",
		required: /moss/i,
		bonus: [
			/sft/i,
			/image/i,
			/int8/i
		]
	},
	clip: {
		loader: "CLIPLoader",
		field: "clip_name",
		folder: "text_encoders",
		what: "MOSS-Image 的文本编码器（Qwen3.5 9B，w4a8 GPTQ）",
		example: "qwen3.5_9b_w4a8_gptq.safetensors",
		required: /qwen3[._]?5.*(?:w4a8|gptq)/i,
		bonus: [
			/w4a8/i,
			/gptq/i,
			/9b/i
		]
	},
	vae: {
		loader: "VAELoader",
		field: "vae_name",
		folder: "vae",
		what: "MOSS-Image 的 VAE（FLUX.2 small）",
		example: "flux2-vae_small.safetensors",
		required: /flux[._-]?2/i,
		bonus: [/vae/i, /small/i]
	}
};
/**
* MOSS-Image's two sampling registers.
*
* `comfy` is the default and is the one the official ComfyUI template and this
* machine's verified sample actually run: 25 steps / CFG 2.5 / `er_sde` /
* `simple`. `official` is OpenMOSS's own card: 50 steps / CFG 3.0 / `euler` /
* `simple`. The difference is a quality dial, not a correctness one, which is
* why it is one select with two registers instead of three loose numbers.
*/
const MOSS_SAMPLING = {
	comfy: {
		label: "ComfyUI 模板（25 步 / CFG 2.5 / er_sde）",
		sampler: {
			node: "KSampler",
			name: "er_sde",
			scheduler: "simple",
			cfg: 2.5
		},
		steps: { default: 25 }
	},
	official: {
		label: "OpenMOSS 官方（50 步 / CFG 3 / euler）",
		sampler: {
			node: "KSampler",
			name: "euler",
			scheduler: "simple",
			cfg: 3
		},
		steps: { default: 50 }
	}
};
/** Every profile, keyed by its canonical id. */
const MODEL_PROFILES = {
	"qwen21-base": {
		id: "qwen21-base",
		label: "Qwen-Image 2.1（base，40 步）",
		family: "qwen-image-2.1",
		variant: "base",
		legacyIds: ["base"],
		legacyLabel: "base",
		weights: QWEN_BASE_WEIGHTS,
		clipType: {
			prefer: ["qwen_image"],
			fallback: /qwen/i
		},
		latent: {
			classType: "EmptyLatentImage",
			multiple: 32
		},
		sampler: {
			node: "KSampler",
			name: "euler",
			scheduler: "simple",
			cfg: 1
		},
		steps: { default: 40 },
		negativePrompt: "",
		filenamePrefix: "dsh-image-forge",
		textToImage: QWEN_IMAGE_WORKFLOW,
		imageToImage: {
			template: QWEN_IMAGE_EDIT_WORKFLOW,
			build: editWorkflow
		}
	},
	"qwen21-turbo": {
		id: "qwen21-turbo",
		label: "Qwen-Image 2.1（turbo，8 步蒸馏）",
		family: "qwen-image-2.1",
		variant: "turbo",
		legacyIds: ["turbo"],
		legacyLabel: "turbo",
		weights: QWEN_TURBO_WEIGHTS,
		clipType: {
			prefer: ["qwen_image"],
			fallback: /qwen/i
		},
		latent: {
			classType: "EmptyLatentImage",
			multiple: 32
		},
		sampler: {
			node: "SamplerCustomAdvanced",
			name: "euler",
			scheduler: "simple",
			cfg: 1
		},
		steps: {
			default: 8,
			sigmas: TURBO_SIGMAS
		},
		negativePrompt: "",
		filenamePrefix: "dsh-image-forge-turbo",
		textToImage: QWEN_IMAGE_TURBO_WORKFLOW,
		imageToImage: {
			template: QWEN_IMAGE_TURBO_EDIT_WORKFLOW,
			build: editTurboWorkflow
		}
	},
	"moss-sft": {
		id: "moss-sft",
		label: "MOSS-Image（SFT，25/50 步）",
		family: "moss-image",
		variant: "sft",
		legacyIds: [],
		legacyLabel: "moss",
		weights: MOSS_WEIGHTS,
		clipType: { prefer: ["moss_image"] },
		latent: {
			classType: "EmptyFlux2LatentImage",
			multiple: 16
		},
		sampler: MOSS_SAMPLING.comfy.sampler,
		steps: MOSS_SAMPLING.comfy.steps,
		samplingPresets: MOSS_SAMPLING,
		defaultPreset: "comfy",
		negativePrompt: MOSS_NEGATIVE_PROMPT,
		filenamePrefix: "dsh-image-forge-moss",
		textToImage: MOSS_IMAGE_WORKFLOW,
		imageToImage: {
			template: MOSS_IMAGE_EDIT_WORKFLOW,
			build: mossEditWorkflow
		},
		layoutTemplate: MOSS_IMAGE_LAYOUT_WORKFLOW
	}
};
/**
* Whether a value is a canonical profile id.
*
* @param value - anything, typically a config value.
* @returns true for the three ids in {@link COMFY_MODEL_IDS}.
*/
function isComfyModelId(value) {
	return typeof value === "string" && COMFY_MODEL_IDS.includes(value);
}
/**
* Resolve a configured `comfyModel` value to its profile.
*
* Legacy values keep working: `base` → `qwen21-base`, `turbo` → `qwen21-turbo`.
* Anything unrecognised (a typo, an older document) resolves to the default
* rather than failing — a config typo must not make the plugin unusable, and the
* resolved profile is reported back so the mismatch is visible.
*
* @param choice - the configured value, of any vintage.
* @returns the profile; never undefined.
*/
function resolveProfile(choice) {
	if (typeof choice === "string") {
		const id = choice.trim();
		if (isComfyModelId(id)) return MODEL_PROFILES[id];
		for (const profile of Object.values(MODEL_PROFILES)) if (profile.legacyIds.includes(id)) return profile;
	}
	return MODEL_PROFILES[DEFAULT_COMFY_MODEL];
}
/**
* The sampler settings one run really uses, honouring a sampling register.
*
* A register only exists on the families that declare `samplingPresets` (today:
* MOSS-Image), so both Qwen profiles return their own `sampler` / `steps`
* untouched no matter what the config says — that is what keeps their behaviour
* identical to before the setting existed. An unknown or absent value falls back
* to the profile's own pair, so a stale settings document can never make a graph
* unfillable.
*
* @param profile - the profile that will run.
* @param preset - the configured register name, if any.
* @returns the sampler/steps pair to fill the graph with, plus the register that
*   supplied it (`undefined` when the profile's own pair did).
*/
function resolveSampling(profile, preset) {
	const table = profile.samplingPresets;
	if (table !== void 0 && typeof preset === "string") {
		const chosen = table[preset];
		if (chosen !== void 0) return {
			sampler: chosen.sampler,
			steps: chosen.steps,
			preset
		};
	}
	return {
		sampler: profile.sampler,
		steps: profile.steps,
		preset: void 0
	};
}
/**
* The step count a published sampling register contributes.
*
* A family that publishes registers owns its working points: the selected
* register's count outranks the shared `defaultSteps` (MOSS comfy: 25, official:
* 50). That is deliberate — MOSS's counts are model properties, so raising
* `defaultSteps` for the Qwen base path must not silently move MOSS off its
* template's 25. The default register reports the profile's own `steps.default`
* (the pair the profile's `sampler` / `steps` mirror).
*
* `undefined` means "no opinion" — a Qwen profile (no table) or an unknown value.
* The shared `defaultSteps` stands for those, exactly as it did before registers
* existed.
*
* @param profile - the profile that will run.
* @param preset - the configured register name, if any.
* @returns the register's step count, or undefined when the shared default stands.
*/
function presetSteps(profile, preset) {
	if (profile.samplingPresets === void 0 || typeof preset !== "string") return void 0;
	const chosen = profile.samplingPresets[preset];
	if (chosen === void 0) return void 0;
	return preset === profile.defaultPreset ? profile.steps.default : chosen.steps.default;
}
/**
* Assert a canvas satisfies a profile's latent alignment.
*
* `ratio.ts` produces 32-aligned sizes, which every profile accepts (32 is a
* multiple of 16); this only guards an explicit size that somehow slipped past
* `validateSize`, and it names the profile so the fix is obvious.
*
* @param profile - the profile that will run.
* @param width - canvas width in pixels.
* @param height - canvas height in pixels.
* @throws When a side is not a multiple of the profile's alignment.
*/
function assertLatentAligned(profile, width, height) {
	const multiple = profile.latent.multiple;
	for (const [label, value] of [["width", width], ["height", height]]) if (!Number.isInteger(value) || value <= 0 || value % multiple !== 0) throw new Error(`comfyui backend: ${profile.label} 的 latent 要求 ${label} 是 ${multiple} 的正整数倍，收到 ${value}。（插件默认画幅是 32 对齐的，正常不会走到这里。）`);
}
//#endregion
//#region src/comfyui.ts
/**
* ComfyUI backend: reuse a ComfyUI the user already has, plus its already
* downloaded Qwen-Image weights (zero download, zero conversion).
*
* Three rules shape this module:
*
* 1. **Loopback only.** Every URL is checked against {@link isLoopbackUrl} before
*    a socket opens, and every request is sent with `redirect: 'error'`, so a
*    redirect cannot walk the connection off the loopback interface.
* 2. **The model file names come from the server, never from this file.** The
*    three loaders' option lists are read from `/object_info` and matched by
*    name; a name this module does not find is reported as a missing file with
*    the directory it belongs in. Nothing is hard-coded as a *requirement* —
*    the example names in the profile table are only used in error text.
* 3. **Upstream errors are quoted, not swallowed.** `/prompt` answers with
*    `node_errors` and `/history` carries an execution traceback; both reach the
*    caller as readable text instead of a bare 400.
*
* ## Which model family runs
*
* The weight matching, the `CLIPLoader.type`, the latent node, the sampler, the
* default step count, the negated prompt and the graphs themselves are **not**
* decided here: they belong to a {@link ModelProfile} in `model-profiles.ts`, and
* this module is the one code path that executes any of them. `comfyModel` picks
* the profile by id (`qwen21-base`, `qwen21-turbo`, `moss-sft`) — the pre-profile
* values `base` / `turbo` still resolve, see `resolveProfile`.
*
* Two rules keep that honest:
*
* - **The profile never decides the canvas.** `ratio.ts` does, at 32 alignment,
*   which every profile accepts (32 is a multiple of MOSS's 16) — so the pixel
*   policy cannot fork between families.
* - **The graph follows the weights, not only the config.** A turbo request on a
*   base-only install degrades to the base graph (and says so); see
*   {@link effectiveProfile}. Otherwise a config value could pair the turbo
*   sigma schedule with a checkpoint that was never distilled for it.
*
* The Qwen graph is the official Qwen-Image 2.1 text-to-image template that ships
* with ComfyUI (`comfyui_workflow_templates_json/templates/
* image_qwen_image_2_1_t2i.json`), reduced to the nodes needed without the
* optional prompt-enhancer branch: `UNETLoader` → `KSampler.model`,
* `CLIPLoader(type=qwen_image)` → `TextEncodeQwenImage21` → `KSampler`,
* `VAELoader` → `VAEDecode`, `EmptyLatentImage` → `KSampler.latent_image`,
* `VAEDecode` → `SaveImage`. The template's `QwenImage21Cache` is **kept** when
* the server lists the node (it caches the text/reference KV prefix, which is
* where most of the edit speedup comes from) and stripped automatically when an
* older ComfyUI (< 0.37.0) does not — see {@link withoutQwenCache}. The
* `ResolutionSelector` and prompt-enhancer nodes stay dropped: we size the canvas
* ourselves in `ratio.ts`, and the enhancer needs weights this plugin does not
* require. The MOSS graph is the
* same kind of reduction of ComfyUI's `image_moss_image_t2i.json`, documented in
* `model-profiles.ts`.
*
* The Qwen edit (image-to-image) graph is the same skeleton plus the reference
* slots, taken from the official `image_qwen_image_2_1_image_edit.json`
* template: its `TextEncodeQwenImage21` node takes a `vae`, an autogrow
* `images.image_N` input per reference (up to ten) and a `resolution` pixel
* budget, and the reference pixels enter ComfyUI through `POST /upload/image` as
* `LoadImage` inputs. The template's `ComfySwitchNode` (its "custom size" switch)
* has no counterpart here because the plugin always supplies an explicit canvas,
* exactly as the text-to-image path does; the template builds its default canvas
* from the first reference at a 32-aligned ~1.5 MP budget, which is what
* `ratio_follow` resolves to. MOSS has **no** edit graph yet — its profile
* carries a `todo` naming the nodes the follow-up needs.
*/
init_images();
/** Ports probed when `comfyEndpoint` is empty, in order. */
const DEFAULT_COMFY_PORTS = [
	8e3,
	8188,
	8189,
	8190,
	8191,
	8192
];
/**
* The `KSampler.sampler_name` values this plugin offers as an alternative.
*
* **ComfyUI-native only**: every name here ships with ComfyUI's own
* `comfy.samplers`. Third-party sampler packs (RES4LYF's `abnorsett_3m`,
* `beta_57` schedules, …) are deliberately absent — the plugin does not require
* or install third-party node packs, and an unknown name would fail only at
* `/prompt` time. `euler` remains the default; the alternatives are all
* single-source/community reports without a controlled comparison.
*/
const NATIVE_SAMPLERS = [
	"euler",
	"euler_ancestral",
	"heun",
	"dpm_2",
	"dpm_2_ancestral",
	"lms",
	"dpmpp_2s_ancestral",
	"dpmpp_2m",
	"dpmpp_2m_sde",
	"dpmpp_sde",
	"dpmpp_3m_sde",
	"res_multistep",
	"er_sde",
	"ddim"
];
/**
* The `KSampler.scheduler` values this plugin offers.
*
* Also ComfyUI-native; `simple` stays the default, and `beta` is the scheduler
* the community `er_sde + beta` experiments pair with it.
*/
const NATIVE_SCHEDULERS = [
	"simple",
	"normal",
	"karras",
	"exponential",
	"sgm_uniform",
	"beta"
];
/**
* Parse the comma-separated `comfyPorts` value into candidate ports.
*
* Anything that is not a usable port number is ignored rather than rejected: a
* typo in the config must not stop the plugin from loading, and the default list
* is the documented behaviour. Shared by the Agent tools and the Studio, so a
* typo cannot behave differently across the two front doors.
*
* @param raw - config value, e.g. `8000,8188`.
* @returns distinct valid ports, or the defaults when none survive.
*/
function parseComfyPorts(raw) {
	const ports = /* @__PURE__ */ new Set();
	for (const part of raw.split(/[,\s]+/)) {
		const port = Number(part.trim());
		if (part.trim().length > 0 && Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
	}
	return ports.size > 0 ? [...ports] : [...DEFAULT_COMFY_PORTS];
}
/**
* Derive one call's {@link ComfyOptions} from the settings both front doors share.
*
* The Agent tools' `ForgeSettings` and the Studio's `StudioSettings` both
* satisfy the structural argument, so the endpoint trimming and the timeout
* hand-off cannot drift apart between the two readers.
*
* @param settings - the resolved settings (ports already parsed).
* @param timeoutMs - per-call override; defaults to the configured budget.
* @returns the options the adapter functions take.
*/
function comfyOptionsOf$1(settings, timeoutMs = settings.timeoutMs) {
	return {
		endpoint: settings.comfyEndpoint.replace(/\/+$/, ""),
		ports: settings.comfyPorts,
		modelsDir: settings.comfyModelsDir,
		comfyModel: settings.comfyModel,
		mossSampling: settings.mossSampling,
		timeoutMs
	};
}
/**
* The loader inputs one profile's weights are read from, in error-text order.
*
* Derived from the profile rather than restated here: the folder a file belongs
* in, the wording that names it and the example it ships under are all profile
* data, so a new family cannot inherit the old family's error text.
*/
function weightKindsOf(profile) {
	return [
		{
			kind: "unet",
			rule: profile.weights.unet
		},
		{
			kind: "clip",
			rule: profile.weights.clip
		},
		{
			kind: "vae",
			rule: profile.weights.vae
		}
	];
}
/**
* True when a URL points at this machine's loopback interface.
*
* Only literal forms are accepted — `127.0.0.0/8`, `localhost`, `::1`. A host
* name is never resolved, so `localhost.evil.example.com` cannot pass.
*
* @param raw - URL to test; anything unparseable is rejected.
* @returns whether the URL is HTTP(S) on the loopback interface.
*/
function isLoopbackUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	return isLoopbackHost(url.hostname);
}
/** True when a host literal is loopback. */
function isLoopbackHost(hostname) {
	const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
	const octets = host.split(".");
	if (octets.length !== 4 || octets[0] !== "127") return false;
	return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
/**
* Refuse any endpoint that is not on this machine.
*
* @param raw - endpoint from the plugin config.
* @returns the same endpoint without a trailing slash.
* @throws When the URL is malformed or leaves the loopback interface. This is
*   the network boundary in code, so it fails before any socket is opened
*   rather than relying on configuration being right.
*/
function assertLocalEndpoint(raw) {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (!isLoopbackUrl(trimmed)) throw new Error(`comfyui backend: refusing endpoint "${raw}" — 本后端只与**本机回环地址**上的 ComfyUI 通信（127.0.0.1 / localhost / ::1），不接受域名或局域网地址。请把 comfyEndpoint 改成回环 URL，或清空它让插件自动探测。`);
	return trimmed;
}
/** Abort in `ms`, also aborting when the caller aborts. Always disposed. */
function requestSignal(signal, ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error(`timed out after ${ms} ms`)), ms);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	};
}
/** Flatten a transport error into one line, including the underlying cause. */
function transportReason(error) {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
	return `${error.message}${cause}`;
}
/**
* One JSON request against ComfyUI, with `redirect: 'error'`.
*
* @throws When the socket fails or the call times out; HTTP error statuses are
*   returned rather than thrown so the caller can quote the body.
*/
async function requestJson(url, init, timeoutMs, signal) {
	const composed = requestSignal(signal, timeoutMs);
	try {
		const response = await fetch(url, {
			method: init.method,
			headers: init.body === void 0 ? { Accept: "application/json" } : {
				Accept: "application/json",
				"Content-Type": "application/json"
			},
			body: init.body,
			redirect: "error",
			signal: composed.signal
		});
		const raw = await response.text();
		let payload;
		try {
			payload = JSON.parse(raw);
		} catch {
			payload = void 0;
		}
		return {
			status: response.status,
			ok: response.ok,
			payload,
			raw
		};
	} catch (error) {
		throw new Error(`comfyui backend: ${url} 请求失败 — ${transportReason(error)}`);
	} finally {
		composed.dispose();
	}
}
/** Read a property from an unknown JSON value without trusting its shape. */
function prop(value, key) {
	if (typeof value !== "object" || value === null) return void 0;
	return value[key];
}
/**
* Fetch image bytes.
*
* The body is taken as an `ArrayBuffer` and never through `text()`: decoding
* binary as UTF-8 destroys every non-ASCII byte, which silently corrupts the
* PNG instead of failing.
*/
async function requestBytes(url, timeoutMs, signal) {
	const composed = requestSignal(signal, timeoutMs);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: { Accept: "image/*" },
			redirect: "error",
			signal: composed.signal
		});
		if (!response.ok) {
			let note = "";
			try {
				note = (await response.text()).replace(/\s+/g, " ").slice(0, 200);
			} catch {
				note = "";
			}
			return {
				status: response.status,
				ok: false,
				bytes: /* @__PURE__ */ new Uint8Array(),
				contentType: null,
				note
			};
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		return {
			status: response.status,
			ok: true,
			bytes,
			contentType: response.headers.get("content-type")?.split(";")[0]?.trim(),
			note: ""
		};
	} catch (error) {
		throw new Error(`comfyui backend: ${url} 请求失败 — ${transportReason(error)}`);
	} finally {
		composed.dispose();
	}
}
/**
* Answer from one candidate endpoint.
*
* `/system_stats` is ComfyUI's cheapest always-present endpoint. A 2xx is not
* enough on its own: the body must look like ComfyUI's, otherwise another
* service squatting on the port would be mistaken for the renderer.
*/
async function probeEndpoint(endpoint, timeoutMs, signal) {
	try {
		const response = await requestJson(`${endpoint}/system_stats`, { method: "GET" }, timeoutMs, signal);
		if (!response.ok) return {
			endpoint,
			ok: false,
			note: `/system_stats answered HTTP ${response.status}`
		};
		if (prop(response.payload, "system") === void 0 && prop(response.payload, "devices") === void 0) return {
			endpoint,
			ok: false,
			note: "/system_stats answered 2xx but the body is not ComfyUI's"
		};
		return {
			endpoint,
			ok: true
		};
	} catch (error) {
		return {
			endpoint,
			ok: false,
			note: transportReason(error)
		};
	}
}
/**
* Find the ComfyUI to talk to.
*
* A configured endpoint is used as-is (after the loopback check) and a failure
* there is final — silently falling back to port probing would hide a typo in
* the config. Without one, every candidate port is tried in order.
*
* @param options - endpoint, candidate ports, and probe budget.
* @param signal - caller cancellation.
* @returns the endpoint that answered, with the full attempt trail.
* @throws When the configured endpoint does not answer, or no candidate port
*   does; the message lists every endpoint tried and how to start ComfyUI.
*/
async function discoverComfyUi(options, signal) {
	const timeout = options.portProbeTimeoutMs ?? 800;
	if (options.endpoint.trim().length > 0) {
		const endpoint = assertLocalEndpoint(options.endpoint);
		const port = Number(new URL(endpoint).port) || (new URL(endpoint).protocol === "https:" ? 443 : 80);
		const attempt = await probeEndpoint(endpoint, timeout, signal);
		if (attempt.ok) return {
			endpoint,
			port,
			probed: [attempt]
		};
		throw new Error(`comfyui backend: 配置的端点 ${endpoint} 不是可用的 ComfyUI — ${attempt.note ?? "no reason reported"}\n  请确认 ComfyUI 已经启动，且 comfyEndpoint 的端口与它一致（桌面版常见 8000，便携版 8188），或把 comfyEndpoint 留空让插件自动探测。`);
	}
	const probed = [];
	for (const port of options.ports) {
		const endpoint = `http://127.0.0.1:${port}`;
		const attempt = await probeEndpoint(endpoint, timeout, signal);
		probed.push(attempt);
		if (attempt.ok) return {
			endpoint,
			port,
			probed
		};
	}
	const tried = probed.map((attempt) => `  • ${attempt.endpoint} — ${attempt.note ?? "no reason reported"}`).join("\n");
	throw new Error(`comfyui backend: 没找到在跑的 ComfyUI（已探测 ${probed.length} 个端口）：\n${tried}\n  一条命令起来：node scripts/start-comfyui.mjs（仓库自带；不加参数就起+等就绪，--doctor 只体检）。
  不敢用脚本就照旧手动启动，它监听在别的端口时把该端口写进 comfyPorts 或直接写 comfyEndpoint。
  部署步骤（下载、放权重、校验）见 docs/comfyui-deployment.md；也可以先跑 qwen_image_status 看缺什么。`);
}
/**
* Read one loader's file-name option list out of `/object_info`.
*
* Classic nodes answer `{input: {required: {field: [[names…], options]}}}`;
* a missing node, field, or option list returns undefined so the caller can say
* exactly which loader it could not read.
*/
function loaderField(payload, loader, field) {
	const input = prop(prop(payload, loader), "input");
	const spec = prop(prop(input, "required"), field) ?? prop(prop(input, "optional"), field);
	const options = Array.isArray(spec) ? spec[0] : void 0;
	if (!Array.isArray(options)) return void 0;
	return options.filter((name) => typeof name === "string");
}
/**
* Pick the file whose name best matches a profile's weight rule.
*
* A candidate must match `required`; each additional pattern it matches adds
* weight (earlier patterns weigh more). A candidate matching an `avoid` pattern
* is pushed below every non-matching one, which is how `qwen21-base` refuses to
* run a turbo checkpoint that happens to be listed first. Ties keep the server's
* own order, so the choice is deterministic for a given `/object_info`. Matching
* the whole name rather than the basename means a file in a subfolder still
* matches. This is what keeps the PE (prompt-enhancer) text encoders from being
* picked as the Qwen text encoder: they carry neither `vl` nor `8b`.
*
* @param options - the file names `/object_info` reported for that loader field.
* @param rule - the profile's matcher for that weight.
* @returns the chosen name, or undefined when nothing matched.
*/
function pickModelFile(options, rule) {
	let best;
	for (const name of options) {
		if (!rule.required.test(name)) continue;
		let score = 0;
		for (const [index, pattern] of rule.bonus.entries()) if (pattern.test(name)) score += rule.bonus.length - index;
		for (const pattern of rule.avoid ?? []) if (pattern.test(name)) score -= 1e3;
		if (best === void 0 || score > best.score) best = {
			name,
			score
		};
	}
	return best?.name;
}
/**
* The separator a configured models path is joined with.
*
* Taken from the **path's own style**, not from `process.platform`: the two can
* disagree — a Windows path pasted into a POSIX host (WSL, a shared profile, a
* synced config) would otherwise be joined with `/` and read as
* `D:\Comfy-Desktop\ComfyUI-Shared\models/clip/`, i.e. a path no Windows shell
* would accept and no reader would trust. `test/comfyui-e2e.test.mjs` pins both
* styles on every host, which is what made the platform-only version fail on
* Linux CI while passing on Windows.
*
* A path that carries no separator at all gives no style to follow, so the
* platform decides there.
*
* @param modelsDir - the configured `comfyModelsDir`, already trimmed.
* @returns `\\` for a Windows-shaped path, `/` otherwise.
*/
function separatorFor(modelsDir) {
	if (modelsDir.includes("\\") || /^[A-Za-z]:/.test(modelsDir)) return "\\";
	if (modelsDir.includes("/")) return "/";
	return process.platform === "win32" ? "\\" : "/";
}
/** Where a weight belongs, phrased for the machine that is running this plugin. */
function folderHint(modelsDir, folder) {
	const trimmed = modelsDir.trim().replace(/[\\/]+$/, "");
	const separator = trimmed.length > 0 ? separatorFor(trimmed) : process.platform === "win32" ? "\\" : "/";
	if (trimmed.length > 0) return `${trimmed}${separator}${folder}${separator}`;
	return `ComfyUI 的 models${separator}${folder}${separator} 目录（桌面版/便携版的模型路径见 ComfyUI 设置或 extra_model_paths.yaml）`;
}
/**
* Read the weight file names one profile needs off the running server.
*
* The profile — not this function — decides which file names count, which
* `CLIPLoader.type` value the graph needs and what to call each weight in error
* text. That is what makes a second family possible without a second selector:
* MOSS's DiT is `moss_image_sft_*` and its VAE is `flux2-vae_small`, neither of
* which the old hard `/qwen/i` gate could ever accept.
*
* @param target - the endpoint that answered.
* @param options - used for the profile id, the model-directory hint and the timeout.
* @param signal - caller cancellation.
* @returns the names ComfyUI itself listed, plus the resolved `CLIPLoader.type`.
* @throws When a loader, its option list, a matching file, or a usable
*   `CLIPLoader.type` is missing. The message names the profile, every file it
*   needs, the field and folder each one goes in, and the candidates the server
*   currently reports — this is checked before `/prompt`, so a missing weight
*   never becomes a pile of node errors.
*/
async function loadComfyModels(target, options, signal) {
	const timeout = options.portProbeTimeoutMs ?? 800;
	const profile = resolveProfile(options.comfyModel);
	const kinds = weightKindsOf(profile);
	const loaded = /* @__PURE__ */ new Map();
	const clipInfo = requestJson(`${target.endpoint}/object_info/CLIPLoader`, { method: "GET" }, timeout, signal);
	const cacheInfo = requestJson(`${target.endpoint}/object_info/QwenImage21Cache`, { method: "GET" }, timeout, signal);
	for (const { kind, rule } of kinds.filter(({ kind }) => kind !== "clip")) loaded.set(kind, await requestJson(`${target.endpoint}/object_info/${rule.loader}`, { method: "GET" }, timeout, signal));
	loaded.set("clip", await clipInfo);
	const cacheResponse = await cacheInfo;
	const chosen = /* @__PURE__ */ new Map();
	/** One line per weight that could not be resolved, all reported together. */
	const missing = [];
	for (const { kind, rule } of kinds) {
		const response = loaded.get(kind);
		const optionsList = response === void 0 ? void 0 : loaderField(response.payload, rule.loader, rule.field);
		if (optionsList === void 0) throw new Error(`comfyui backend: 读不到 ${rule.loader}.${rule.field} — 这个 ComfyUI 没有该加载器节点，或 /object_info 的返回不是预期形状。缺的是「${rule.what}」，请在 ComfyUI 里确认 ${rule.loader} 节点可用后重试。`);
		const name = pickModelFile(optionsList, rule);
		if (name === void 0) {
			const seen = optionsList.length === 0 ? "（空）" : optionsList.join(", ");
			missing.push(`  • ${rule.loader}.${rule.field} — 没有匹配 ${rule.required} 的文件\n    需要：${rule.what}\n    例如：${rule.example}\n    放到：${folderHint(options.modelsDir, rule.folder)}\n    当前能看到 ${optionsList.length} 个：${seen}`);
			continue;
		}
		chosen.set(kind, name);
	}
	if (missing.length > 0) throw new Error(`comfyui backend: 缺模型文件 — 这个 ComfyUI 里选不出 ${profile.label}（comfyModel=${profile.id}）要的权重。\n这个 profile 需要 ${kinds.length} 个文件：\n` + kinds.map(({ rule }) => `  - ${rule.loader}.${rule.field}：${rule.what}（文件名需匹配 ${rule.required}，例如 ${rule.example}）`).join("\n") + `\n缺的这几项：\n${missing.join("\n")}\n  （本插件不下载、不转换权重；换目标模型改 comfyModel，或把上面的文件放进对应的 models 子目录。）`);
	const clipTypes = loaderField(loaded.get("clip")?.payload, profile.weights.clip.loader, "type");
	const clipType = profile.clipType.prefer.find((type) => clipTypes?.includes(type) === true) ?? (profile.clipType.fallback === void 0 ? void 0 : clipTypes?.find((type) => profile.clipType.fallback.test(type)));
	if (clipType === void 0) throw new Error(`comfyui backend: CLIPLoader.type 里没有 ${profile.label} 要的选项（${profile.clipType.prefer.join(" / ")}），无法确定文本编码器类型（${profile.weights.clip.what}）。\n  这个 profile 的 CLIPLoader 需要 type="${profile.clipType.prefer[0]}"，老版本 ComfyUI 可能还没有这个选项（升级 ComfyUI 即可）。
  当前可选：${clipTypes === void 0 ? "（读不到）" : clipTypes.join(", ")}`);
	return {
		unet: chosen.get("unet"),
		clip: chosen.get("clip"),
		vae: chosen.get("vae"),
		clipType,
		cache: prop(cacheResponse.payload, "QwenImage21Cache") !== void 0
	};
}
/** A whole-string placeholder. */
const WHOLE_PLACEHOLDER = /^\{\{([a-z_]+)\}\}$/;
/**
* Substitute placeholders into a template.
*
* A whole-string placeholder takes the value with its own type (numbers stay
* numbers), which matters because ComfyUI type-checks every input; an inline one
* is stringified. A placeholder with no value throws rather than reaching the
* GPU as a literal `{{…}}`.
*
* @param template - the API-format graph, possibly placeholders.
* @param values - one entry per placeholder name.
* @returns a fresh graph with no placeholders left.
*/
function renderWorkflow(template, values) {
	if (Array.isArray(template)) return template.map((item) => renderWorkflow(item, values));
	if (typeof template === "string") {
		const whole = WHOLE_PLACEHOLDER.exec(template);
		if (whole !== null) {
			const value = values[whole[1]];
			if (value === void 0) throw new Error(`comfyui backend: workflow placeholder {{${whole[1]}}} has no value`);
			return value;
		}
		return template.replace(/\{\{([a-z_]+)\}\}/g, (match, name) => {
			const value = values[name];
			if (value === void 0) throw new Error(`comfyui backend: workflow placeholder ${match} has no value`);
			return String(value);
		});
	}
	if (typeof template === "object" && template !== null) {
		const out = {};
		for (const [key, value] of Object.entries(template)) out[key] = renderWorkflow(value, values);
		return out;
	}
	return template;
}
/**
* Pick the turbo checkpoint out of whatever `/object_info` reported.
*
* Read as a *preference*, never a requirement: the plugin still works with only
* the base weights installed, it just cannot use the turbo path. A name is
* turbo when it contains `turbo` — that is how both official files are named
* (`qwen_image_2.1_turbo_bf16.safetensors`,
* `qwen_image_2.1_turbo_int8_convrot.safetensors`) — so a user who renamed their
* copy still matches as long as the rename kept the marker.
*
* @param models - the three file names resolved from `/object_info`.
* @returns the turbo unet name, or `undefined` when only a base checkpoint is present.
*/
function turboUnetOf(models) {
	return /turbo/i.test(models.unet) ? models.unet : void 0;
}
/**
* Hand one reference image to ComfyUI and return the name its `LoadImage` wants.
*
* ComfyUI's `LoadImage` reads from its own `input` folder, so the pixels have to
* be uploaded first; there is no server-side "load this path" input. The name is
* derived from the image's sha256, so re-sending the same reference overwrites
* its own file instead of piling up numbered copies, and the file can never
* collide with a name the user already has there (the `dsh-forge-ref-` prefix).
*
* @param target - the endpoint that answered.
* @param image - decoded reference bytes plus their sniffed mime.
* @param timeoutMs - budget for the upload.
* @param signal - caller cancellation.
* @returns the `image` value to put in a `LoadImage` node.
* @throws When the upload fails or the response carries no name.
*/
async function uploadReferenceImage(target, image, timeoutMs, signal) {
	const extension = image.mime === "image/jpeg" ? ".jpg" : image.mime === "image/webp" ? ".webp" : ".png";
	const name = `dsh-forge-ref-${createHash("sha256").update(image.bytes).digest("hex").slice(0, 16)}${extension}`;
	const form = new FormData();
	form.append("image", new Blob([image.bytes], { type: image.mime }), name);
	form.append("type", "input");
	form.append("overwrite", "true");
	const composed = requestSignal(signal, timeoutMs);
	const url = `${target.endpoint}/upload/image`;
	try {
		const response = await fetch(url, {
			method: "POST",
			body: form,
			redirect: "error",
			signal: composed.signal
		});
		const raw = await response.text();
		let payload;
		try {
			payload = JSON.parse(raw);
		} catch {
			payload = void 0;
		}
		if (!response.ok) throw new Error(`comfyui backend: ${url} answered HTTP ${response.status} — ${raw.replace(/\s+/g, " ").slice(0, 200)}`);
		const returned = prop(payload, "name");
		if (typeof returned !== "string" || returned.length === 0) throw new Error(`comfyui backend: ${url} answered without a file name (${raw.slice(0, 200)}) — the reference image "${image.label}" did not make it into ComfyUI's input folder.`);
		const subfolder = prop(payload, "subfolder");
		return typeof subfolder === "string" && subfolder.length > 0 ? `${subfolder}/${returned}` : returned;
	} catch (error) {
		throw error instanceof Error && error.message.startsWith("comfyui backend:") ? error : /* @__PURE__ */ new Error(`comfyui backend: ${url} 请求失败 — ${transportReason(error)} (参考图 "${image.label}")`);
	} finally {
		composed.dispose();
	}
}
/**
* Turn `/prompt`'s node errors and error envelope into readable text.
*
* Shape: `{error: {type, message, details}, node_errors: {"7": {class_type,
* errors: [{type, message, details, extra_info}]}}}`. The upstream strings are
* quoted as they came; only the envelope's key names are interpreted.
*
* @param payload - parsed `/prompt` body.
* @param status - HTTP status.
* @returns one line naming the HTTP status and every node error found.
*/
function describeComfyErrors(payload, status) {
	const parts = [];
	const error = prop(payload, "error");
	const message = prop(error, "message");
	const errorType = prop(error, "type");
	if (typeof message === "string") {
		parts.push(`HTTP ${status}: ${typeof errorType === "string" ? `${errorType} — ` : ""}${message}`);
		const details = prop(error, "details");
		if (typeof details === "string" && details.length > 0) parts.push(`  details: ${details}`);
	} else if (typeof error === "string") parts.push(`HTTP ${status}: ${error}`);
	else parts.push(`HTTP ${status}`);
	const nodeErrors = prop(payload, "node_errors");
	if (typeof nodeErrors === "object" && nodeErrors !== null) for (const [nodeId, entry] of Object.entries(nodeErrors)) {
		const classType = prop(entry, "class_type");
		const errors = prop(entry, "errors");
		const list = Array.isArray(errors) ? errors : [entry];
		for (const item of list) {
			const itemType = prop(item, "type");
			const itemMessage = prop(item, "message");
			const details = prop(item, "details");
			const extra = prop(item, "extra_info");
			const extraText = typeof extra === "object" && extra !== null ? ` [${Object.entries(extra).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")}]` : "";
			parts.push(`  node ${nodeId} (${typeof classType === "string" ? classType : "unknown"}): ${typeof itemType === "string" ? itemType : "error"} — ${typeof itemMessage === "string" ? itemMessage : JSON.stringify(item)}${typeof details === "string" ? ` (${details})` : ""}${extraText}`);
		}
	}
	return parts.join("\n");
}
/**
* Pull the failure out of a finished `/history` entry.
*
* ComfyUI reports a failed run as `status.status_str === 'error'` with the
* execution error inside `status.messages`, whose traceback is the only place
* the real Python exception is visible — so it is forwarded.
*
* @param entry - one `/history/<id>` entry.
* @returns the formatted failure, or undefined when the run has not failed.
*/
function describeHistoryFailure(entry) {
	const status = prop(entry, "status");
	const statusStr = prop(status, "status_str");
	const messages = prop(status, "messages");
	const failures = [];
	if (Array.isArray(messages)) for (const message of messages) {
		if (!Array.isArray(message) || message[0] !== "execution_error") continue;
		const data = message[1];
		const nodeId = prop(data, "node_id");
		const nodeType = prop(data, "node_type");
		const exceptionType = prop(data, "exception_type");
		const exceptionMessage = prop(data, "exception_message");
		failures.push(`execution_error: node ${String(nodeId)} (${String(nodeType)}) ${String(exceptionType)}: ${String(exceptionMessage)}`);
		const traceback = prop(data, "traceback");
		if (Array.isArray(traceback) && traceback.length > 0) failures.push(`  traceback:\n${traceback.map((line) => `    ${String(line).replace(/\n$/, "")}`).join("\n")}`);
	}
	if (failures.length > 0) return failures.join("\n");
	if (statusStr === "error") return "status_str=error（ComfyUI 没有给出 execution_error 明细）";
}
/**
* Collect the image references a finished run produced.
*
* Saved images live in `outputs[<node>].images[]` as `{filename, subfolder,
* type}`. Node ids are visited in numeric order so a batch keeps a stable order.
*/
function collectImageRefs(entry) {
	const outputs = prop(entry, "outputs");
	if (typeof outputs !== "object" || outputs === null) return [];
	const ids = Object.keys(outputs).sort((a, b) => Number(a) - Number(b));
	const refs = [];
	for (const id of ids) {
		const images = prop(outputs[id], "images");
		if (!Array.isArray(images)) continue;
		for (const image of images) {
			const filename = prop(image, "filename");
			if (typeof filename !== "string" || filename.length === 0) continue;
			const subfolder = prop(image, "subfolder");
			const type = prop(image, "type");
			refs.push({
				filename,
				subfolder: typeof subfolder === "string" ? subfolder : "",
				type: typeof type === "string" ? type : "output"
			});
		}
	}
	return refs;
}
/** Sleep, or reject as soon as the caller aborts. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* Which profile a run will **actually** use, given the weights that were found.
*
* A turbo request is a *preference*: it needs a distilled checkpoint to exist.
* With only the base file installed the run must degrade to the base graph, or
* the turbo sigma schedule would be paired with a checkpoint that was never
* distilled for it — the classic way to get worse pictures while believing the
* config applied. Every other family is taken at its word (a missing MOSS file is
* already an error from {@link loadComfyModels}, not a silent fallback to Qwen).
*
* @param choice - the configured `comfyModel` value.
* @param models - the file names `/object_info` yielded.
* @returns the profile whose graph and sampler settings match those weights.
*/
function effectiveProfile(choice, models) {
	const profile = resolveProfile(choice);
	if (profile.variant === "turbo" && turboUnetOf(models) === void 0) {
		const base = Object.values(MODEL_PROFILES).find((candidate) => candidate.family === profile.family && candidate.variant === "base");
		if (base !== void 0) return base;
	}
	return profile;
}
/**
* The placeholder values every profile's text-to-image graph reads.
*
* A superset on purpose: `renderWorkflow` only touches the placeholders a
* template actually declares, so one map serves the `KSampler` graphs (steps,
* CFG, sampler, scheduler), the turbo graph (sigmas, no steps) and any future one.
* Values the profile owns — CFG, sampler, scheduler, sigmas, the negative prompt,
* the filename prefix — come from the profile, never from this function.
*
* The sampler numbers come through {@link resolveSampling}, so a family that
* publishes more than one register (MOSS-Image) runs the chosen one; a profile
* without registers returns its own pair, which is why both Qwen profiles are
* byte-identical to before the setting existed.
*
* @param profile - the effective profile of this call.
* @param models - the file names the server reported.
* @param request - prompt, canvas, count, seed, any explicit step count, and the
*   optional quality-tier overrides (`cfg` / `negativePrompt`).
* @param preset - the configured sampling register, if any.
*/
function textToImageValues(profile, models, request, preset) {
	assertLatentAligned(profile, request.width, request.height);
	const sampling = resolveSampling(profile, preset);
	return {
		unet_name: models.unet,
		weight_dtype: "default",
		clip_name: models.clip,
		clip_type: models.clipType,
		vae_name: models.vae,
		prompt: request.prompt,
		negative_prompt: request.negativePrompt ?? profile.negativePrompt,
		width: request.width,
		height: request.height,
		batch_size: request.count,
		seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
		steps: request.steps ?? sampling.steps.default,
		cfg: request.cfg ?? sampling.sampler.cfg,
		sampler_name: request.samplerName ?? sampling.sampler.name,
		scheduler: request.scheduler ?? sampling.sampler.scheduler,
		sigmas: sampling.steps.sigmas,
		filename_prefix: profile.filenamePrefix
	};
}
/**
* Render one profile's text-to-image graph for this server.
*
* The only server-dependent choice is the `QwenImage21Cache` shim: it is part of
* the profile's graph, but a ComfyUI older than 0.37.0 does not know the node
* class and would reject the whole prompt, so the shim is stripped when
* `/object_info` did not list it ({@link ComfyModels.cache}). MOSS graphs carry no
* shim, so the branch is inert for them.
*
* @param profile - the effective profile of this call.
* @param models - the file names and capability flags the server reported.
* @param request - prompt, canvas, count, seed and any overrides.
* @param preset - the configured sampling register, if any.
* @returns a rendered graph, ready for `/prompt`.
*/
function renderTextToImage(profile, models, request, preset) {
	if (request.layout !== void 0) {
		if (profile.layoutTemplate === void 0) throw new Error(`comfyui backend: 布局（layout）只对 MOSS-Image 生效——只有 moss-sft 的布局通路（compiled JSON 当正向编码文本）存在，当前 profile 是 ${profile.label}。`);
		const parsed = parseMossLayout(request.layout);
		return renderWorkflow(profile.layoutTemplate, {
			...textToImageValues(profile, models, request, preset),
			layout_json: parsed.json
		});
	}
	return renderWorkflow(profile.family === "qwen-image-2.1" && !models.cache ? withoutQwenCache(profile.textToImage) : profile.textToImage, textToImageValues(profile, models, request, preset));
}
/**
* Run one text-to-image job on ComfyUI and download the resulting images.
*
* The graph, sampler and step default come from the **effective** profile, so
* this one function serves every family: Qwen base, Qwen turbo (which degrades to
* base without a turbo checkpoint) and MOSS. `/prompt` → poll `/history/<id>` →
* `/view` for each saved file; the bytes the caller receives are exactly what
* `/view` served.
*
* @param target - the endpoint that answered.
* @param models - the three file names read from `/object_info`.
* @param request - prompt plus the already-aligned canvas size.
* @param options - profile choice, timeout and poll interval.
* @param signal - caller cancellation.
* @returns one entry per produced image, in ComfyUI's order.
* @throws On submission errors (with `node_errors` quoted), an execution error
*   (with the traceback quoted), a timeout naming the prompt id, or a run that
*   completed without producing an image.
*/
async function generateViaComfyUi(target, models, request, options, signal) {
	const profile = effectiveProfile(options.comfyModel, models);
	return await runGraph(target, renderTextToImage(profile, models, request, options.mossSampling), profile.family === "moss-image" ? "出图（MOSS）" : "出图", options, signal);
}
/**
* Run one already-built API-format graph and download the images it saved.
*
* `/prompt` → poll `/history/<id>` → `/view` for each saved file. The bytes the
* caller receives are exactly what `/view` served, so what lands on disk equals
* what ComfyUI produced.
*
* @param target - the endpoint that answered.
* @param graph - a rendered graph with no placeholders left.
* @param what - the run's name, used in error text (`出图` / `改图`).
* @param options - timeout and poll interval.
* @param signal - caller cancellation.
* @returns one entry per produced image, in ComfyUI's order.
* @throws On submission errors (with `node_errors` quoted), an execution error
*   (with the traceback quoted), a timeout naming the prompt id, or a run that
*   completed without producing an image.
*/
async function runGraph(target, graph, what, options, signal) {
	const interval = options.pollIntervalMs ?? 750;
	const deadline = Date.now() + options.timeoutMs;
	const remaining = () => Math.max(1, deadline - Date.now());
	const backendRun = await runThroughBackends({
		endpoint: target.endpoint,
		graph,
		what,
		timeoutMs: options.timeoutMs,
		pollIntervalMs: interval,
		signal,
		onPromptId: options.onPromptId
	}, resolveBackendPlan(process.env));
	if (backendRun !== void 0) return backendRun.images;
	const submission = await requestJson(`${target.endpoint}/prompt`, {
		method: "POST",
		body: JSON.stringify({
			prompt: graph,
			client_id: `${process.pid}-dsh-image-forge`
		})
	}, remaining(), signal);
	if (!submission.ok) throw new Error(`comfyui backend: ${what}：/prompt 被拒绝\n${describeComfyErrors(submission.payload, submission.status)}`);
	const nodeErrors = prop(submission.payload, "node_errors");
	if (typeof nodeErrors === "object" && nodeErrors !== null && Object.keys(nodeErrors).length > 0) throw new Error(`comfyui backend: ${what}：工作流校验未通过\n${describeComfyErrors(submission.payload, submission.status)}`);
	const promptId = prop(submission.payload, "prompt_id");
	if (typeof promptId !== "string" || promptId.length === 0) throw new Error(`comfyui backend: /prompt 没有返回 prompt_id（拿到 ${submission.raw.slice(0, 200)}）— 无法跟踪这次任务。`);
	options.onPromptId?.(promptId);
	for (;;) {
		const history = await requestJson(`${target.endpoint}/history/${promptId}`, { method: "GET" }, remaining(), signal);
		if (!history.ok) throw new Error(`comfyui backend: /history/${promptId} answered HTTP ${history.status} — ${history.raw.slice(0, 200)}`);
		const entry = prop(history.payload, promptId);
		if (entry !== void 0) {
			const failure = describeHistoryFailure(entry);
			if (failure !== void 0) throw new Error(`comfyui backend: ${what}失败（prompt ${promptId}）\n${failure}`);
			const refs = collectImageRefs(entry);
			if (refs.length > 0) {
				const images = [];
				for (const ref of refs) {
					const query = new URLSearchParams({
						filename: ref.filename,
						subfolder: ref.subfolder,
						type: ref.type
					});
					const view = await requestBytes(`${target.endpoint}/view?${query}`, remaining(), signal);
					if (!view.ok) throw new Error(`comfyui backend: /view?filename=${ref.filename} answered HTTP ${view.status}${view.note === "" ? "" : ` — ${view.note}`}`);
					if (view.bytes.byteLength === 0) throw new Error(`comfyui backend: /view?filename=${ref.filename} returned 0 bytes`);
					images.push({
						bytes: view.bytes,
						mime: sniffImageMime(view.bytes) ?? view.contentType ?? "image/png"
					});
				}
				return images;
			}
			if (prop(prop(entry, "status"), "completed") === true) throw new Error(`comfyui backend: prompt ${promptId} 完成了但没有产出图片（outputs: ${JSON.stringify(prop(entry, "outputs") ?? {}).slice(0, 300)}）`);
		}
		if (Date.now() + interval >= deadline) throw new Error(`comfyui backend: 等 prompt ${promptId} 超过 ${options.timeoutMs} ms 仍未出图。\n  ComfyUI 可能还在跑（8GB 显存下 int8 权重会逐层换入换出，比发布值慢很多）：去看 ComfyUI 面板的进度，或把插件的 timeoutMs 调大（例如 900000）后重试。本次任务不会因此丢图，用 GET ${target.endpoint}/history/${promptId} 仍能查到结果。`);
		await sleep(interval, signal ?? new AbortController().signal);
	}
}
/**
* The `resolution` budget ComfyUI's edit node takes: it resizes every reference
* to about `resolution x resolution` pixels, so it mirrors the canvas' own area.
* With both at the same budget, the reference latents and the canvas the sampler
* starts from sit at the same scale — the official template warns that any other
* combination shifts the edit.
*
* @param width - canvas width in pixels.
* @param height - canvas height in pixels.
* @returns the side whose square is closest to the canvas area, 32-aligned and
*   inside the node's own 0–4096 bounds.
*/
function referenceBudget(width, height) {
	const aligned = Math.round(Math.sqrt(width * height) / 32) * 32;
	return Math.min(4096, Math.max(32, aligned));
}
/**
* The edit graph a profile offers, or a refusal naming what is missing.
*
* MOSS's edit graph is wired (T19: `MODEL_PROFILES['moss-sft'].imageToImage` in
* `model-profiles.ts`), so every shipped profile carries one and this guard is a
* latent one. It stays because a profile without `imageToImage` must **fail
* loudly** rather than fake an edit out of the text-to-image graph — that would
* submit a graph that silently ignores the references. The refusal quotes the
* profile's own `todo` so a follow-up has its entry point in the error text
* rather than only in a comment.
*
* @param profile - the effective profile of this call.
* @returns its edit template and reference-slot builder.
* @throws When the family has no edit graph.
*/
function requireEditGraph(profile) {
	if (profile.imageToImage === void 0) throw new Error(`comfyui backend: ${profile.label} 的**改图**通路还没接入——本次改动只做它的文生图，所以带参考图的请求在这里被拒绝，而不是递一张忽略参考图的图上去。
` + (profile.todo === void 0 ? "" : `  后续接入点：${profile.todo}\n`) + "  现在就要改图：把 comfyModel 换成 qwen21-base 或 qwen21-turbo（Qwen 的改图通路是通的）。");
	return profile.imageToImage;
}
/**
* Upload the references and wire them into a profile's edit graph.
*
* @param target - the endpoint that answered.
* @param profile - the effective profile of this call.
* @param models - the three weight file names.
* @param request - must carry at least one reference.
* @param options - timeout.
* @param signal - caller cancellation.
* @returns the rendered graph, ready for `/prompt`.
*/
async function renderEditGraph(target, profile, models, request, options, signal) {
	const references = request.images ?? [];
	if (references.length === 0) throw new Error("comfyui backend: the edit path needs reference images, but request.images is empty");
	const edit = requireEditGraph(profile);
	const deadline = Date.now() + options.timeoutMs;
	const names = [];
	for (const reference of references) names.push(await uploadReferenceImage(target, reference, Math.max(1, deadline - Date.now()), signal));
	const built = edit.build(names);
	return renderWorkflow(profile.family === "qwen-image-2.1" && !models.cache ? withoutQwenCache(built) : built, {
		...textToImageValues(profile, models, request, options.mossSampling),
		resolution: referenceBudget(request.width, request.height),
		filename_prefix: `${profile.filenamePrefix}-edit`
	});
}
/**
* Run one reference-image edit on ComfyUI and download the resulting images.
*
* The references are uploaded into ComfyUI's `input` folder first, because
* `LoadImage` — the only node that feeds image pixels into a graph — reads from
* there and has no "load this path" input. The graph is then the profile's edit
* graph (for Qwen: the text-to-image skeleton with the official edit template's
* encode node). A profile without one is refused, not silently degraded.
*
* @param target - the endpoint that answered.
* @param models - the three file names read from `/object_info`.
* @param request - edit prompt, canvas, and at least one reference image.
* @param options - profile choice, timeout and poll interval.
* @param signal - caller cancellation.
* @returns one entry per produced image, in ComfyUI's order.
* @throws When the profile has no edit graph, no reference is present, an upload
*   fails, or the run fails.
*/
async function generateViaComfyUiEdit(target, models, request, options, signal) {
	return await runGraph(target, await renderEditGraph(target, effectiveProfile(options.comfyModel, models), models, request, options, signal), "改图", options, signal);
}
/**
* Run one Turbo text-to-image generation.
*
* Same engine as {@link generateViaComfyUi}; this entry point additionally
* *requires* the effective profile to be the distilled one, because a caller that
* asked for turbo explicitly (the blind test asks for 4, 8 and 12 steps) must see
* a failure rather than a silently different checkpoint. The turbo graph defaults
* its step count to {@link TURBO_STEPS} and drives the manual sigma schedule
* instead of `KSampler` — both come from the profile.
*
* @param target - the endpoint that answered.
* @param models - the three file names read from `/object_info`.
* @param request - prompt, canvas, count, seed, optional step override.
* @param options - profile choice, timeout and poll interval.
* @param signal - caller cancellation.
* @returns one entry per produced image, in ComfyUI's order.
* @throws When no distilled checkpoint is installed, or with the adapter's usual
*   quoted-upstream text when the run fails.
*/
async function generateViaComfyUiTurbo(target, models, request, options, signal) {
	const profile = effectiveProfile(options.comfyModel, models);
	if (profile.variant !== "turbo") throw new Error(`comfyui backend: 要跑 turbo 但没有蒸馏版 DiT — /object_info 里只有 ${models.unet}。\n  放一份 turbo 权重进 models/unet（或 models/diffusion_models），或把 comfyModel 改回 qwen21-base。`);
	return await runGraph(target, renderWorkflow(profile.textToImage, textToImageValues(profile, models, request, options.mossSampling)), "出图（turbo）", options, signal);
}
/**
* Run one Turbo reference-image edit.
*
* As with the base edit path, references are uploaded first and wired in as
* `LoadImage` nodes; the turbo-specific values (step default, sigma schedule,
* `cfg` 1) all come from the profile.
*
* @param target - the endpoint that answered.
* @param models - the three file names read from `/object_info`.
* @param request - edit prompt, canvas, and at least one reference image.
* @param options - profile choice, timeout and poll interval.
* @param signal - caller cancellation.
* @returns one entry per produced image, in ComfyUI's order.
* @throws When no distilled checkpoint is installed, the profile has no edit
*   graph, no reference is present, an upload fails, or the run fails.
*/
async function generateViaComfyUiTurboEdit(target, models, request, options, signal) {
	const profile = effectiveProfile(options.comfyModel, models);
	if (profile.variant !== "turbo") throw new Error(`comfyui backend: 要跑 turbo 改图但没有蒸馏版 DiT — /object_info 里只有 ${models.unet}。\n  放一份 turbo 权重进 models/unet（或 models/diffusion_models），或把 comfyModel 改回 qwen21-base。`);
	return await runGraph(target, await renderEditGraph(target, profile, models, request, options, signal), "改图（turbo）", options, signal);
}
/**
* Read `/system_stats` from a ComfyUI that already answered.
*
* This exists so `qwen_image_status` can report the GPU and its remaining VRAM
* without spawning `nvidia-smi`: the card that matters is the one ComfyUI loaded
* its weights onto, and ComfyUI is the only party that knows. Every field is
* optional in practice — an older server, or a CPU-only one, simply yields fewer
* numbers rather than an error.
*
* @param endpoint - origin that already passed {@link discoverComfyUi}.
* @param timeoutMs - probe budget; a status call must not hang on this.
* @param signal - caller cancellation.
* @returns the version, devices, and a note when the endpoint refused to answer.
*/
async function comfySystemStats(endpoint, timeoutMs = 5e3, signal) {
	try {
		const response = await requestJson(`${endpoint}/system_stats`, { method: "GET" }, timeoutMs, signal);
		if (!response.ok) return {
			version: null,
			devices: [],
			note: `GET /system_stats → HTTP ${String(response.status)}`
		};
		const system = prop(response.payload, "system");
		const devices = prop(response.payload, "devices");
		return {
			version: typeof prop(system, "comfyui_version") === "string" ? prop(system, "comfyui_version") : null,
			devices: Array.isArray(devices) ? devices.map((device) => ({
				name: typeof prop(device, "name") === "string" ? prop(device, "name") : "unknown",
				type: typeof prop(device, "type") === "string" ? prop(device, "type") : null,
				vram_total_MiB: typeof prop(device, "vram_total") === "number" ? Math.round(prop(device, "vram_total") / 1024 ** 2) : null,
				vram_free_MiB: typeof prop(device, "vram_free") === "number" ? Math.round(prop(device, "vram_free") / 1024 ** 2) : null
			})) : []
		};
	} catch (error) {
		return {
			version: null,
			devices: [],
			note: error instanceof Error ? error.message : String(error)
		};
	}
}
/**
* Probe the ComfyUI backend for a status report; never throws.
*
* @param options - endpoint, candidate ports, and probe budget.
* @param signal - caller cancellation.
* @returns reachability, the endpoint that answered, the attempt trail, and —
*   when a server answered — whether the configured profile's weights are visible.
*/
async function probeComfyUi(options, signal) {
	let target;
	try {
		target = await discoverComfyUi(options, signal);
	} catch (error) {
		return {
			configuredEndpoint: options.endpoint.length > 0 ? options.endpoint : null,
			candidatePorts: [...options.ports],
			reachable: false,
			note: error instanceof Error ? error.message : String(error)
		};
	}
	try {
		const models = await loadComfyModels(target, options, signal);
		const profile = resolveProfile(options.comfyModel);
		return {
			endpoint: target.endpoint,
			port: target.port,
			reachable: true,
			probed: target.probed,
			models: {
				...models,
				ok: true
			},
			note: `ComfyUI 在跑，且 ${profile.label} 要的三个权重都能被它的加载器枚举到。`
		};
	} catch (error) {
		return {
			endpoint: target.endpoint,
			port: target.port,
			reachable: true,
			probed: target.probed,
			models: { ok: false },
			note: error instanceof Error ? error.message : String(error)
		};
	}
}
//#endregion
//#region scripts/comfyui-discovery.mjs
/**
* This machine's ComfyUI facts and process mechanics, in one implementation
* shared by the plugin's environment layer (`src/environment.ts`) and the
* human CLI (`scripts/start-comfyui.mjs`) — so the two cannot drift about
* where an install is, how it was launched, or whether it answered.
*
* Where the facts come from, in order:
*   1. an explicit install directory (`--dir` / `COMFYUI_DIR`) — explicit wins;
*   2. Comfy Desktop's own registry (`%APPDATA%/Comfy Desktop/installations.json`):
*      install path, `launchArgs`, `envVars`, port, plus `settings.json` for the
*      shared input/output dirs and `instance-model-paths/<id>.yaml` for the
*      model roots. **The flags are read, never invented or edited** — whatever
*      Comfy Desktop would pass, this passes;
*   3. a bounded scan for `<root>/**\/ComfyUI/main.py` with a sibling Python
*      (`standalone-env/python.exe`, `python_embeded/python.exe`,
*      `.venv/Scripts/python.exe`) for portable / plain installs.
*
* Plain ESM + Node stdlib only. Two reasons: the CLI must run in a fresh clone
* **before** `npm run build`, and the plugin imports this file so rolldown inlines
* it — the published `lib/index.js` stays self-contained.
*/
/** How long a launch waits for `/system_stats` unless the caller says otherwise. */
const DEFAULT_INSTALL_TIMEOUT_MS = 18e4;
/** Split a Desktop `launchArgs` string the way a shell would for the simple cases it uses. */
function splitArgs(s) {
	if (!s) return [];
	const out = [];
	let cur = "";
	let quote = null;
	for (const ch of s) if (quote) {
		if (ch === quote) quote = null;
		else cur += ch;
	} else if (ch === "\"" || ch === "'") quote = ch;
	else if (/\s/.test(ch)) {
		if (cur) {
			out.push(cur);
			cur = "";
		}
	} else cur += ch;
	if (cur) out.push(cur);
	return out;
}
/** Parse JSON, or return `null` when the file is absent / unreadable / not JSON. */
function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
/** Windows' roaming AppData root, where Comfy Desktop keeps its registry. */
function appDataRoot(env = process.env) {
	return env.APPDATA ?? join(homedir(), "AppData", "Roaming");
}
/** The directories a portable / plain install is most likely under. */
function defaultScanRoots(platform$1 = platform(), home = homedir()) {
	return platform$1 === "win32" ? [
		"D:\\",
		"E:\\",
		"C:\\",
		join(home, "Documents"),
		join(home, "Desktop")
	] : [
		home,
		"/opt",
		"/usr/local"
	];
}
/** Does this env root actually have the package that matters (`torch`) installed? */
function hasTorch(envRoot) {
	const direct = join(envRoot, "Lib", "site-packages", "torch");
	if (existsSync(direct)) return true;
	const lib = join(envRoot, "lib");
	if (!existsSync(lib)) return false;
	try {
		return readdirSync(lib).some((d) => d.startsWith("python") && existsSync(join(lib, d, "site-packages", "torch")));
	} catch {
		return false;
	}
}
/**
* The Python interpreter that belongs to an install.
*
* Comfy Desktop 0.34 puts the CUDA env in `<install>/ComfyUI/.venv` and ships a
* bare `standalone-env` next to it — that one has **no torch**, so picking it
* because it sorts first lands on `ModuleNotFoundError: No module named 'torch'`.
* Any candidate that can prove it has torch wins; the rest are fallbacks.
*/
function findPython(installPath, mainPy, platform$2 = platform()) {
	const roots = platform$2 === "win32" ? [
		join(dirname(mainPy ?? ""), ".venv"),
		join(installPath, "ComfyUI", ".venv"),
		join(installPath, ".venv"),
		join(installPath, "venv"),
		join(installPath, "python_embeded"),
		join(dirname(mainPy ?? ""), "python_embeded"),
		join(installPath, "standalone-env")
	] : [
		join(dirname(mainPy ?? ""), ".venv"),
		join(installPath, ".venv"),
		join(installPath, "venv")
	];
	const exe = platform$2 === "win32" ? join("Scripts", "python.exe") : join("bin", "python");
	const existing = roots.map((r) => r.endsWith("python_embeded") || r.endsWith("standalone-env") ? join(r, "python.exe") : join(r, exe)).filter((p) => existsSync(p));
	const best = existing.filter((p) => hasTorch(dirname(dirname(p))))[0] ?? existing[0] ?? null;
	if (best !== null && platform$2 === "win32") {
		const windowless = join(dirname(best), "pythonw.exe");
		if (existsSync(windowless)) return windowless;
	}
	return best;
}
/** `<install>/ComfyUI/main.py` for the Desktop layout, `main.py` for a plain checkout. */
function findMainPy(installPath) {
	return [join(installPath, "ComfyUI", "main.py"), join(installPath, "main.py")].find((p) => existsSync(p)) ?? null;
}
/**
* Build a plan from one Comfy Desktop installation record.
*
* @returns the plan, or `null` when this record does not point at a usable
*   install (cloud-only records have no `installPath` at all).
*/
function planFromDesktop(install, desktopRoot, platform$3 = platform()) {
	const installPath = install?.installPath;
	if (!installPath || !existsSync(installPath)) return null;
	const mainPy = findMainPy(installPath);
	const python = findPython(installPath, mainPy, platform$3);
	if (!mainPy || !python) return null;
	const settings = readJsonFile(join(desktopRoot, "settings.json")) ?? {};
	const modelPathsDir = join(desktopRoot, "instance-model-paths");
	let modelPathsConfig = null;
	if (existsSync(modelPathsDir)) {
		const own = join(modelPathsDir, `${install.id}.yaml`);
		modelPathsConfig = existsSync(own) ? own : readdirSync(modelPathsDir).filter((f) => f.endsWith(".yaml")).map((f) => join(modelPathsDir, f))[0] ?? null;
	}
	const argv = [];
	if (platform$3 === "win32") argv.push("-s");
	argv.push(mainPy);
	argv.push("--listen", "127.0.0.1", "--port", String(install.port ?? 8188));
	if (modelPathsConfig) argv.push("--extra-model-paths-config", modelPathsConfig);
	if (settings.outputDir) argv.push("--output-directory", settings.outputDir);
	if (settings.inputDir) argv.push("--input-directory", settings.inputDir);
	for (const extra of splitArgs(install.launchArgs)) argv.push(extra);
	return {
		source: `Comfy Desktop (${install.name ?? install.id}${install.version ? ` ${install.version}` : ""})`,
		installPath,
		mainPy,
		python,
		cwd: dirname(mainPy),
		port: Number(install.port ?? 8188),
		argv,
		env: {
			...install.envVars,
			PYTHONUTF8: "1"
		},
		logDir: join(installPath, "logs")
	};
}
/** Bounded scan for portable / plain installs, for machines without Comfy Desktop. */
function planFromScan(root, platform$4 = platform(), depth = 2) {
	if (!root || !existsSync(root)) return null;
	const skip = /* @__PURE__ */ new Set([
		"node_modules",
		".git",
		"Windows",
		"Program Files",
		"Program Files (x86)",
		"$Recycle.Bin",
		"System Volume Information"
	]);
	const walk = (dir, left) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return null;
		}
		for (const e of entries) {
			if (!e.isDirectory() || skip.has(e.name)) continue;
			const child = join(dir, e.name);
			if (e.name.toLowerCase() === "comfyui") {
				const mainPy = join(child, "main.py");
				const python = findPython(dir, mainPy, platform$4);
				if (existsSync(mainPy) && python) return {
					source: `scan (${child})`,
					installPath: dir,
					mainPy,
					python,
					cwd: child,
					port: 8188,
					argv: [
						...platform$4 === "win32" ? ["-s"] : [],
						mainPy,
						"--listen",
						"127.0.0.1",
						"--port",
						"8188"
					],
					env: { PYTHONUTF8: "1" },
					logDir: join(child, "user")
				};
			}
			if (left > 0) {
				const hit = walk(child, left - 1);
				if (hit) return hit;
			}
		}
		return null;
	};
	return walk(root, depth);
}
/**
* Comfy Desktop's registry, as data.
*
* `installations` is `null` when the machine has never run Desktop (no file) or
* the file is not the array the script expects — the two cases the caller has
* to phrase differently when it reports “not installed”.
*/
function desktopRegistry({ appData = appDataRoot(), env = process.env } = {}) {
	const root = join(appData ?? appDataRoot(env), "Comfy Desktop");
	const installations = readJsonFile(join(root, "installations.json"));
	return {
		root,
		installations: Array.isArray(installations) ? installations : null
	};
}
/**
* Find out how this machine would run ComfyUI — starting nothing, writing nothing.
*
* @param {object} [options]
* @param {string} [options.dir] - explicit install directory; wins over everything.
* @param {Record<string, string | undefined>} [options.env] - environment to read.
* @param {NodeJS.Platform} [options.platform] - platform to plan for.
* @param {string} [options.appData] - APPDATA root to read the Desktop registry from.
* @param {string} [options.home] - home directory for the default scan roots.
* @param {readonly string[]} [options.scanRoots] - scan roots; `[]` disables the scan.
* @returns the plan, or `null` when nothing was found.
* @throws when an explicitly named directory is not a usable install.
*/
function discoverComfyPlan({ dir, env = process.env, platform: platform$5 = platform(), appData, home = homedir(), scanRoots } = {}) {
	if (dir) {
		const installPath = resolve(dir);
		const mainPy = findMainPy(installPath);
		const python = findPython(installPath, mainPy, platform$5);
		if (!mainPy || !python) throw new Error(`--dir ${installPath}: no main.py or no Python found inside`);
		return {
			source: `--dir (${installPath})`,
			installPath,
			mainPy,
			python,
			cwd: dirname(mainPy),
			port: 8188,
			argv: [
				...platform$5 === "win32" ? ["-s"] : [],
				mainPy,
				"--listen",
				"127.0.0.1",
				"--port",
				"8188"
			],
			env: { PYTHONUTF8: "1" },
			logDir: join(installPath, "logs")
		};
	}
	if (env.COMFYUI_DIR) return discoverComfyPlan({
		env,
		platform: platform$5,
		appData,
		home,
		scanRoots,
		dir: env.COMFYUI_DIR
	});
	const registry = desktopRegistry({
		appData: appData ?? appDataRoot(env),
		env
	});
	if (registry.installations) for (const install of registry.installations) {
		if (install.status && install.status !== "installed") continue;
		const plan = planFromDesktop(install, registry.root, platform$5);
		if (plan) return plan;
	}
	const roots = scanRoots ?? defaultScanRoots(platform$5, home);
	for (const root of roots) {
		const plan = planFromScan(root, platform$5);
		if (plan) return plan;
	}
	return null;
}
/** Where a launch record written by {@link launchComfyPlan} lives. */
function launchRecordPath(plan) {
	return join(plan.logDir ?? plan.installPath, "dsh-image-forge-launch.json");
}
/** The launch record of a previous start, or `null` when there is none. */
function readLaunchRecord(plan) {
	return readJsonFile(launchRecordPath(plan));
}
/**
* The plan a launch would actually run, with the port and any extra flags applied.
*
* **One source for the port.** `--port` in argv, `plan.port`, the record and the
* endpoint the caller waits on must all name the same port; when the caller
* pinned a port (the panel's `comfyEndpoint`), that port wins over whatever the
* Desktop record said — otherwise a `comfyEndpoint` of `:8000` launches `:8188`
* and then waits on `:8188` forever while the panel probes `:8000`.
*
* `extraArgs` is the seam later stages use for user-specified launch flags. It
* defaults to nothing: with no override this function returns the plan it was
* given, argv included, byte for byte.
*
* @param {object} plan - a plan from {@link discoverComfyPlan}.
* @param {object} [options]
* @param {number|null} [options.port] - port that must win over the planned one.
* @param {readonly string[]} [options.extraArgs] - flags appended after the
*   planned argv; empty/omitted appends nothing.
* @returns the plan, or a copy with `port`/`argv` adjusted.
*/
function planForRun(plan, { port = null, extraArgs = [] } = {}) {
	if (!plan) return plan;
	const extra = Array.isArray(extraArgs) ? extraArgs.filter((arg) => typeof arg === "string" && arg.length > 0) : [];
	const wanted = Number(port);
	const override = Number.isInteger(wanted) && wanted >= 1 && wanted <= 65535 && wanted !== Number(plan.port);
	if (!override && extra.length === 0) return plan;
	const argv = Array.isArray(plan.argv) ? [...plan.argv] : [];
	if (override) {
		const at = argv.indexOf("--port");
		if (at >= 0 && at + 1 < argv.length) argv[at + 1] = String(wanted);
		else argv.push("--port", String(wanted));
	}
	for (const arg of extra) argv.push(arg);
	return {
		...plan,
		...override ? { port: wanted } : {},
		argv
	};
}
/**
* The port of a loopback endpoint, or `null` when it is not a local address.
*
* This is the rule behind “the configured endpoint wins”: only a loopback URL
* can be satisfied by a locally launched renderer, so only a loopback URL gets
* to pin the `--port` a launch uses.
*/
function loopbackPortOf(endpoint) {
	if (typeof endpoint !== "string" || endpoint.length === 0) return null;
	try {
		const url = new URL(endpoint);
		const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
		const port = Number(url.port.length > 0 ? url.port : url.protocol === "https:" ? 443 : 80);
		return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
	} catch {
		return null;
	}
}
/**
* The command line of one live process, or `null` when it cannot be read.
*
* Windows has no `/proc`, so this asks WMI (and the legacy `wmic` as a second
* try); POSIX reads `ps -o command=`. `null` is a real answer, not an error: the
* stop path treats "cannot read it" as "cannot prove ownership" and refuses
* rather than guessing, which is the only safe direction for a kill.
*
* @param {number} pid - process to inspect.
* @param {object} [options]
* @param {NodeJS.Platform} [options.platform] - platform to inspect for.
* @param {Function} [options.spawnSync] - `child_process.spawnSync`-shaped hook.
* @returns {string|null} the command line, or `null`.
*/
function processCommandLine(pid, { platform: platform$6 = platform(), spawnSync: sync = spawnSync } = {}) {
	const target = Number(pid);
	if (!Number.isInteger(target) || target <= 0) return null;
	const read = (command, args) => {
		try {
			const result = sync(command, args, {
				encoding: "utf8",
				timeout: 5e3,
				windowsHide: true
			});
			if (!result || result.status !== 0) return null;
			const text = typeof result.stdout === "string" ? result.stdout.trim() : "";
			return text.length > 0 ? text : null;
		} catch {
			return null;
		}
	};
	if (platform$6 === "win32") {
		const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${target}").CommandLine`;
		return read("powershell", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		]) ?? read("pwsh", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		]) ?? read("wmic", [
			"process",
			"where",
			`processid=${target}`,
			"get",
			"commandline",
			"/value"
		]);
	}
	return read("ps", [
		"-o",
		"command=",
		"-p",
		String(target)
	]);
}
/**
* Is this pid alive right now? Deliberately weaker than {@link processCommandLine}:
* signal 0 asks the OS whether the process exists, nothing more.
*/
function isProcessAlive(pid, { kill = process.kill } = {}) {
	const target = Number(pid);
	if (!Number.isInteger(target) || target <= 0) return false;
	try {
		kill(target, 0);
		return true;
	} catch (error) {
		return error && error.code === "EPERM";
	}
}
/** Forget the launch record of an instance that is gone. */
function removeLaunchRecord(plan) {
	try {
		rmSync(launchRecordPath(plan), { force: true });
		return true;
	} catch {
		return false;
	}
}
/** Two paths that name the same file, tolerating quoting and separators. */
function samePathInCommandLine(commandLine, mainPy) {
	if (!commandLine || !mainPy) return false;
	const normalise = (value) => String(value).replace(/["']/g, "").replace(/\\/g, "/").toLowerCase();
	return normalise(commandLine).includes(normalise(mainPy));
}
/**
* Ask one endpoint whether it is ComfyUI, via `/system_stats`.
*
* Deliberately shallow: callers that need the full contract (a 2xx whose body is
* actually ComfyUI's) use the plugin's `discoverComfyUi`; this one is for the
* launch wait and the CLI, where a JSON answer is enough to say “up”.
*
* @returns the parsed stats payload, or `null` when nothing answered.
*/
async function systemStats(endpoint, { timeoutMs = 2500, fetchImpl = fetch } = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetchImpl(`${endpoint}/system_stats`, { signal: ctrl.signal });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
/** Default sleep used by {@link waitForComfyStats}; injected by tests. */
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
* Start a planned install **detached**, with its output in a log file and the pid
* recorded next to it, and return immediately.
*
* The child is unref'd: the plugin/CLI must be able to exit without taking the
* renderer down, which is what “started in the background” means here.
*
* @returns `{ pid, logPath, recordPath, child }`.
*/
function launchComfyPlan(plan, { spawn: spawnImpl = spawn, endpoint = null } = {}) {
	if (!existsSync(plan.logDir)) mkdirSync(plan.logDir, { recursive: true });
	const logPath = join(plan.logDir, `dsh-image-forge-launch-${Date.now()}.log`);
	const fd = openSync(logPath, "a");
	let child;
	try {
		child = spawnImpl(plan.python, plan.argv, {
			cwd: plan.cwd,
			env: {
				...process.env,
				...plan.env
			},
			detached: true,
			windowsHide: true,
			stdio: [
				"ignore",
				fd,
				fd
			]
		});
	} finally {
		closeSync(fd);
	}
	child.unref();
	const recordPath = launchRecordPath(plan);
	const previous = readLaunchRecord(plan);
	const history = Array.isArray(previous?.history) ? previous.history.slice(-4) : [];
	if (previous && previous.pid && previous.pid !== child.pid) history.push(previous);
	const record = {
		pid: child.pid,
		endpoint,
		port: Number.isFinite(Number(plan.port)) ? Number(plan.port) : null,
		mainPy: plan.mainPy ?? null,
		python: plan.python ?? null,
		argv: Array.isArray(plan.argv) ? plan.argv : [],
		startedAt: (/* @__PURE__ */ new Date()).toISOString(),
		logPath,
		history
	};
	try {
		mkdirSync(dirname(recordPath), { recursive: true });
	} catch {}
	try {
		writeFileSync(recordPath, JSON.stringify(record, null, 2));
	} catch {}
	return {
		pid: child.pid,
		logPath,
		recordPath,
		child
	};
}
/**
* Poll `/system_stats` until ComfyUI answers, the child exits, or the budget runs out.
*
* @returns `{ ok: true, stats, waitedMs }` or
*   `{ ok: false, reason: 'exited' | 'timeout', waitedMs, exitCode }`.
*/
async function waitForComfyStats(endpoint, { child = null, timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS, intervalMs = 1e3, fetchImpl = fetch, now = Date.now, sleep = defaultSleep, onWait } = {}) {
	const startedAt = now();
	const deadline = startedAt + timeoutMs;
	while (now() < deadline) {
		const stats = await systemStats(endpoint, {
			timeoutMs: Math.min(2e3, Math.max(250, deadline - now())),
			fetchImpl
		});
		if (stats) return {
			ok: true,
			stats,
			waitedMs: now() - startedAt
		};
		if (child && child.exitCode !== null && child.exitCode !== void 0) return {
			ok: false,
			reason: "exited",
			exitCode: child.exitCode,
			waitedMs: now() - startedAt
		};
		onWait?.();
		await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
	}
	return {
		ok: false,
		reason: "timeout",
		waitedMs: now() - startedAt
	};
}
/**
* Stop an instance that {@link launchComfyPlan} started — and only that one.
*
* On Windows the whole process tree has to go (`taskkill /F /T`): ComfyUI is a
* Python parent plus workers, and `process.kill` leaves the children behind.
* This is the shared interface T15 reuses for its `comfy-mcp` child.
*
* Four things here are deliberate:
*
* - **Ownership is proved before anything is signalled.** The record names a
*   `mainPy`; the live process's command line is read back and must contain it.
*   No command line (WMI blocked, pid already gone) means *no kill* — the answer
*   is “无法确认该进程归属,未执行停止”, because killing an unrelated `python.exe`
*   is not a recoverable mistake.
* - **The exit code is part of the answer.** `spawnSync` used to be called with
*   `stdio: 'ignore'` and its result discarded, so `stopped: true` only meant
*   “a signal was sent”. A non-zero `taskkill` now reports `signal-failed`.
* - **The port is re-checked.** A signal is not a shutdown: after the kill, the
*   recorded endpoint is probed once more, and `verified` says whether
*   `/system_stats` really stopped answering.
* - **The record is deleted on success.** Otherwise the next click would try to
*   stop a pid that is already gone, forever.
*
* @returns `{ stopped, pid, exitCode, reason, verified, note, recordPath }` —
*   `stopped: false` when there was no record or ownership could not be proved.
*/
async function stopComfyPlan(plan, { platform: platform$7 = platform(), spawnSync: sync = spawnSync, kill = process.kill, commandLineOf = (pid) => processCommandLine(pid, {
	platform: platform$7,
	spawnSync: sync
}), fetchImpl = fetch, endpoint = null, verifyTimeoutMs = 2500 } = {}) {
	const recordPath = launchRecordPath(plan);
	const record = readLaunchRecord(plan);
	if (!record) return {
		stopped: false,
		pid: null,
		exitCode: null,
		reason: "no-record",
		verified: null,
		note: `no launch record at ${recordPath}`,
		recordPath
	};
	const pid = Number(record.pid);
	if (!Number.isInteger(pid) || pid <= 0) return {
		stopped: false,
		pid: null,
		exitCode: null,
		reason: "no-pid",
		verified: null,
		note: `${recordPath} has no pid`,
		recordPath
	};
	if (!record.mainPy) return {
		stopped: false,
		pid,
		exitCode: null,
		reason: "unverified",
		verified: null,
		note: `记录 ${recordPath} 里没有 mainPy，无法确认 pid ${pid} 是不是本插件拉起的进程，未执行停止（先手动确认，或重新用工作台的启动按钮拉起一次）。`,
		recordPath
	};
	let commandLine = null;
	try {
		commandLine = commandLineOf(pid);
	} catch {
		commandLine = null;
	}
	if (typeof commandLine !== "string" || commandLine.length === 0) return {
		stopped: false,
		pid,
		exitCode: null,
		reason: "unverified",
		verified: null,
		note: `无法确认 pid ${pid} 的进程归属（读不到命令行），未执行停止。`,
		recordPath
	};
	if (!samePathInCommandLine(commandLine, record.mainPy)) return {
		stopped: false,
		pid,
		exitCode: null,
		reason: "not-owned",
		verified: null,
		note: `pid ${pid} 的命令行里没有记录的 main.py（${record.mainPy}），不是本插件拉起的进程，未执行停止。`,
		recordPath
	};
	let exitCode = null;
	let reason = null;
	let note = "";
	if (platform$7 === "win32") {
		let result = null;
		try {
			result = sync("taskkill", [
				"/PID",
				String(pid),
				"/T",
				"/F"
			], { stdio: "ignore" });
		} catch (error) {
			note = `taskkill 执行失败：${error && error.message ? error.message : String(error)}`;
			reason = "signal-failed";
		}
		if (result) exitCode = typeof result.status === "number" ? result.status : null;
		if (exitCode !== null && exitCode !== 0) reason = "signal-failed";
	} else try {
		kill(pid, "SIGTERM");
	} catch (error) {
		const code = error && error.code ? String(error.code) : "";
		reason = code === "ESRCH" ? "no-process" : "signal-failed";
		note = code === "ESRCH" ? `pid ${pid} 已经不在（ESRCH），没有发送信号` : `发送 SIGTERM 失败：${error && error.message ? error.message : String(error)}`;
	}
	const target = typeof endpoint === "string" && endpoint.length > 0 ? endpoint : typeof record.endpoint === "string" ? record.endpoint : "";
	let verified = null;
	if (target.length > 0) verified = await systemStats(target, {
		timeoutMs: Math.min(1500, Math.max(400, verifyTimeoutMs)),
		fetchImpl
	}) === null;
	if (!(reason === null || reason === "no-process")) return {
		stopped: false,
		pid,
		exitCode,
		reason,
		verified,
		note: note.length > 0 ? note : `停止 pid ${pid} 失败（exit code ${String(exitCode)}）`,
		recordPath
	};
	if (verified === false) return {
		stopped: true,
		pid,
		exitCode,
		reason: "port-still-up",
		verified,
		note: `已向 pid ${pid} 发送停止信号（exit code ${String(exitCode)}），但 ${target} 仍在应答 /system_stats：进程可能正在退出，稍后再点一次停止。`,
		recordPath
	};
	removeLaunchRecord(plan);
	return {
		stopped: true,
		pid,
		exitCode,
		reason: null,
		verified,
		note: `已停止本插件拉起的 pid ${pid}${verified === true ? `，${target} 已不再应答` : ""}（记录已删除）。`,
		recordPath
	};
}
//#endregion
//#region src/environment.ts
/**
* P1a — the environment layer: find this machine's ComfyUI, start it in the
* background when it is not running, and probe it until `/system_stats` answers.
*
* Three boundaries are deliberate:
*
* - **Discovery is shared, not copied.** The Comfy Desktop registry reading, the
*   Python / `main.py` choice and the child-process mechanics live in
*   `scripts/comfyui-discovery.mjs`, which `scripts/start-comfyui.mjs` uses too.
*   A second copy here is how the CLI and a cold start would start disagreeing
*   about where the install is and which flags it was launched with.
* - **Probing reuses `comfyui.ts`.** `discoverComfyUi` already owns the endpoint
*   rules — a configured endpoint is final, otherwise the configured port table,
*   loopback only — and the environment layer must not invent an easier one.
* - **Everything that touches the machine is injectable.** Tests pass a fixture
*   Desktop registry directory, a spawn stub and a fetch stub; no test may start
*   a real renderer or read the real registry.
*
* P1b adds the hand-off the state alone could not carry: install guidance (never
* an unattended GUI install unless the host grants computer use), weight
* downloads into the resolved Desktop model tree, and the one success criterion
* that counts — the loader's /object_info list containing the exact file name.
*/
/** Ports a settings value names; an unusable list falls back to the default table. */
function portsOf(value) {
	if (typeof value === "string") return parseComfyPorts(value);
	const usable = value.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
	return usable.length > 0 ? [...new Set(usable)] : parseComfyPorts("");
}
/**
* Translate the plugin config into environment options.
*
* The port list goes through `comfyui.ts`'s own parser, so a typo in
* `comfyPorts` behaves here exactly as it does in `qwen_image_status`.
*/
function environmentOptionsOf(settings) {
	return {
		endpoint: settings.comfyEndpoint.replace(/\/+$/, ""),
		ports: portsOf(settings.comfyPorts),
		probeTimeoutMs: 800,
		installTimeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
		waitIntervalMs: 1e3
	};
}
/** Coerce a payload into lossless JSON (`undefined` becomes `null` at every depth). */
function jsonSafe$1(value) {
	return JSON.parse(JSON.stringify(value, (_key, inner) => inner === void 0 ? null : inner));
}
/** First line of a message, so a structured note stays one line. */
function firstLine$1(text) {
	return text.split(/\r?\n/)[0] ?? "";
}
/** The clock this call should use. */
function nowOf(deps) {
	return deps.now ?? Date.now;
}
/**
* Discover the install without ever throwing.
*
* A `COMFYUI_DIR` that points nowhere is "no install for this report", not a
* crash: the environment tool has to be able to say `not-installed` and hand
* that to the installer instead of dying with a stack trace.
*
* `cheap` keeps the bounded drive scan out of the way. Status calls use it: the
* Desktop registry (two small JSON files) is enough to find the launch record,
* while scanning `D:\`, `E:\` and `C:\` on every panel refresh is not.
*/
/**
* The log Comfy Desktop itself writes for a launch it did not start through us.
*
* Returns `null` when the install has no `logs/comfyui.log`, so a real absence
* stays a real absence (the panel hides the button instead of pointing at a
* file that does not exist).
*/
function desktopLogOf(deps) {
	const plan = discoverInstall(deps, { cheap: true });
	if (!plan || typeof plan.logDir !== "string") return null;
	const candidate = join(plan.logDir, "comfyui.log");
	return fileSizeOrNull(candidate) === null ? null : candidate;
}
function discoverInstall(deps, options = {}) {
	try {
		return discoverComfyPlan({
			env: deps.env ?? process.env,
			platform: deps.platform ?? process.platform,
			appData: deps.appData,
			scanRoots: options.cheap === true ? [] : deps.scanRoots
		});
	} catch {
		return null;
	}
}
/** No record: nothing this plugin started is reachable from here. */
const NO_OWNERSHIP = {
	owned: false,
	pid: null,
	alive: false,
	argv: null,
	recordPath: null,
	note: null
};
/**
* Read the launch record and decide, conservatively, whether it is ours.
*
* Order matters: a record whose pid is dead is *not* ownership (the OS may have
* recycled that pid for anything). Only a live pid whose command line still
* contains the recorded `main.py` counts as ours; when the command line cannot
* be read the answer is `owned: false` with a note, never a hopeful `true`.
*/
function ownershipOf(deps) {
	const plan = discoverInstall(deps, { cheap: true });
	if (!plan) return NO_OWNERSHIP;
	let record;
	try {
		record = readLaunchRecord(plan);
	} catch {
		return NO_OWNERSHIP;
	}
	if (!record || !record.pid) return NO_OWNERSHIP;
	const pid = Number(record.pid);
	const argv = Array.isArray(record.argv) && record.argv.length > 0 ? record.argv.map(String) : null;
	const recordPath = typeof record.logPath === "string" ? record.logPath : null;
	if (!isProcessAlive(pid, { kill: deps.kill ?? process.kill })) return {
		owned: false,
		pid,
		alive: false,
		argv,
		recordPath,
		note: `pid ${pid} 已经不在了（启动记录还在，下次启动会覆盖它）。`
	};
	const read = deps.commandLineOf ?? ((wanted) => processCommandLine(wanted, {
		platform: deps.platform ?? process.platform,
		spawnSync: deps.spawnSync ?? void 0
	}));
	let commandLine = null;
	try {
		commandLine = read(pid);
	} catch {
		commandLine = null;
	}
	if (typeof commandLine !== "string" || commandLine.length === 0) return {
		owned: false,
		pid,
		alive: true,
		argv,
		recordPath,
		note: `pid ${pid} 还活着，但读不到它的命令行，无法确认是不是本插件拉起的实例。`
	};
	const mainPy = typeof record.mainPy === "string" ? record.mainPy : "";
	if (mainPy.length === 0) return {
		owned: false,
		pid,
		alive: true,
		argv,
		recordPath,
		note: `启动记录里没有 main.py，无法确认 pid ${pid} 的归属（停止会被拒绝）。`
	};
	const normalise = (value) => value.replace(/["']/g, "").replace(/\\/g, "/").toLowerCase();
	if (!normalise(commandLine).includes(normalise(mainPy))) return {
		owned: false,
		pid,
		alive: true,
		argv,
		recordPath,
		note: `pid ${pid} 跑的不是记录的 main.py，本插件不认为它是自己拉起的实例。`
	};
	return {
		owned: true,
		pid,
		alive: true,
		argv,
		recordPath,
		note: null
	};
}
/**
* Is the port already being listened on? A refused connection means "free".
*
* This is the cheap pre-flight that turns "waited the full 180 s and never came
* up" into "端口被占" before a single byte of Python runs.
*/
function realPortProbe(port, timeoutMs = 700) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let socket;
		try {
			socket = new net.Socket();
		} catch {
			finish(false);
			return;
		}
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => {
			socket.destroy();
			finish(true);
		});
		socket.once("timeout", () => {
			socket.destroy();
			finish(false);
		});
		socket.once("error", () => {
			socket.destroy();
			finish(false);
		});
		try {
			socket.connect(port, "127.0.0.1");
		} catch {
			finish(false);
		}
	});
}
/** Trim a discovery plan down to the summary the report exposes. */
function installSummaryOf(plan) {
	return {
		installPath: String(plan.installPath),
		mainPy: String(plan.mainPy),
		python: String(plan.python),
		port: Number(plan.port),
		source: String(plan.source)
	};
}
/** Normalise the probe trail `comfyui.ts` returns. */
function attemptsOf(probed) {
	if (!Array.isArray(probed)) return [];
	return probed.map((attempt) => ({
		endpoint: String(attempt?.endpoint ?? ""),
		ok: attempt?.ok === true,
		note: typeof attempt?.note === "string" ? attempt.note : null
	}));
}
/** Normalise `/system_stats` into the JSON-safe shape the report stores. */
function statsOf(stats) {
	if (!stats) return null;
	return {
		version: stats.version ?? null,
		devices: stats.devices ?? [],
		note: stats.note ?? null
	};
}
/**
* Probe the configured endpoint / port table, reusing the generation path's own
* rules (`comfyui.ts:discoverComfyUi`).
*/
async function probeRunning(options, deps) {
	try {
		return {
			ok: true,
			target: await discoverComfyUi({
				endpoint: options.endpoint,
				ports: options.ports,
				modelsDir: "",
				timeoutMs: options.installTimeoutMs,
				portProbeTimeoutMs: options.probeTimeoutMs
			}),
			note: ""
		};
	} catch (error) {
		return {
			ok: false,
			target: null,
			note: error instanceof Error ? error.message : String(error)
		};
	}
}
/** A ready report, from whatever produced the ComfyUI that answered. */
async function readyStatus(target, source, extras) {
	const stats = await comfySystemStats(target.endpoint, 5e3);
	const ownership = extras.ownership ?? ownershipOf(extras.deps);
	const fallbackLog = extras.logPath === null && !ownership.owned ? desktopLogOf(extras.deps) : null;
	const logPath = extras.logPath ?? fallbackLog;
	const sourceLabel = source === "configured" ? `配置的端点 ${target.endpoint}` : source === "port-probe" ? `端口表探测到 ${target.endpoint}` : `本次后台拉起 ${target.endpoint}`;
	return {
		state: "ready",
		endpoint: target.endpoint,
		port: target.port,
		source,
		install: extras.install,
		probed: attemptsOf(target.probed),
		stats: statsOf(stats),
		note: `ComfyUI 在跑：${sourceLabel}。${ownership.owned ? `本次由插件拉起（pid ${String(ownership.pid)}）。` : ""}`,
		hint: null,
		logPath,
		waitedMs: extras.waitedMs,
		pid: extras.launchedPid ?? ownership.pid,
		owned: ownership.owned,
		...ownership.owned || ownership.note === null ? {} : { ownershipNote: ownership.note },
		argvPreview: extras.argvPreview ?? ownership.argv,
		elapsedMs: nowOf(extras.deps)() - extras.startedAt
	};
}
/**
* Report the environment **without starting anything** (the passive half).
*
* Order, and why: the configured endpoint / port table is what generation uses,
* so it is asked first; only when nothing answers is the Desktop registry read,
* to tell `not-running` (install found, startable) apart from `not-installed`
* (the state P1b turns into install guidance).
*/
async function inspectEnvironment(options, deps = {}) {
	const startedAt = nowOf(deps)();
	const probe = await probeRunning(options, deps);
	if (probe.ok && probe.target !== null) {
		const ownership = ownershipOf(deps);
		return readyStatus(probe.target, options.endpoint.length > 0 ? "configured" : "port-probe", {
			install: null,
			logPath: ownership.recordPath,
			waitedMs: null,
			startedAt,
			deps,
			ownership
		});
	}
	const plan = discoverInstall(deps);
	const elapsedMs = nowOf(deps)() - startedAt;
	if (!plan) return {
		state: "not-installed",
		endpoint: null,
		port: null,
		source: null,
		install: null,
		probed: [],
		stats: null,
		note: `没找到在跑的 ComfyUI（${firstLine$1(probe.note)}），也没有发现 ComfyUI Desktop 或便携版安装。`,
		hint: "按 docs/comfyui-deployment.md 安装 ComfyUI Desktop（安装引导与按需权重下载属后续阶段，本工具不安装、不下权重）；装好后重跑本工具，或先用 node scripts/start-comfyui.mjs --print 确认能发现安装。",
		logPath: null,
		waitedMs: null,
		pid: null,
		owned: false,
		argvPreview: null,
		elapsedMs
	};
	return {
		state: "not-running",
		endpoint: null,
		port: plan.port,
		source: null,
		install: installSummaryOf(plan),
		probed: [],
		stats: null,
		note: `ComfyUI 没在跑（${firstLine$1(probe.note)}），但找到了安装：${plan.installPath}（来源 ${plan.source}）。`,
		hint: "点工作台状态行的「启动」用本工具后台拉起（按 Comfy Desktop 记录的启动参数，不自行发明 flag），或直接跑 node scripts/start-comfyui.mjs。",
		logPath: null,
		waitedMs: null,
		pid: null,
		owned: false,
		argvPreview: Array.isArray(plan.argv) ? plan.argv.map(String) : null,
		elapsedMs
	};
}
/**
* Make the environment ready: probe first, and when nothing answers discover
* the install, start it detached, then wait for `/system_stats`.
*
* Never retries and never installs: a launch that fails or times out is
* reported with its log path, because silently retrying a `Python` crash loop
* is how a tool burns a GPU box.
*/
async function ensureEnvironment(options, deps = {}) {
	const startedAt = nowOf(deps)();
	const inspected = await inspectEnvironment(options, deps);
	if (inspected.state !== "not-running") return inspected;
	const discovered = discoverInstall(deps);
	if (!discovered) return inspected;
	const pinned = loopbackPortOf(options.endpoint);
	const port = pinned ?? Number(discovered.port);
	const endpoint = pinned !== null ? options.endpoint : `http://127.0.0.1:${String(port)}`;
	const plan = planForRun(discovered, {
		port: pinned,
		extraArgs: options.extraArgs ?? []
	});
	const argvPreview = Array.isArray(plan.argv) ? plan.argv.map(String) : null;
	const previous = ownershipOf(deps);
	if (previous.alive) return {
		state: "launch-failed",
		endpoint: null,
		port,
		source: null,
		install: installSummaryOf(plan),
		probed: [],
		stats: null,
		note: `没有重复拉起：${previous.note ?? `已有一个由本插件拉起的实例（pid ${String(previous.pid)}）`}；${endpoint} 还没应答，可能仍在加载权重。`,
		hint: "等它就绪后点「重新检测」；要重启用状态行的「停止」再「启动」。",
		logPath: previous.recordPath,
		waitedMs: null,
		pid: previous.pid,
		owned: previous.owned,
		argvPreview: previous.argv ?? argvPreview,
		elapsedMs: nowOf(deps)() - startedAt
	};
	const fetchImpl = deps.fetchImpl ?? fetch;
	if (await systemStats(endpoint, {
		timeoutMs: 1500,
		fetchImpl
	})) return {
		...await readyStatus({
			endpoint,
			port,
			probed: [{
				endpoint,
				ok: true,
				note: null
			}]
		}, options.endpoint.length > 0 ? "configured" : "port-probe", {
			install: installSummaryOf(plan),
			logPath: null,
			waitedMs: null,
			startedAt,
			deps,
			ownership: NO_OWNERSHIP,
			argvPreview
		}),
		note: `端口 ${String(port)} 上已有 ComfyUI 在应答（可能是你自己启动的），没有重复拉起。`
	};
	if (await (deps.portProbe ?? realPortProbe)(port)) return {
		state: "launch-failed",
		endpoint: null,
		port,
		source: null,
		install: installSummaryOf(plan),
		probed: [],
		stats: null,
		note: `端口被占：${String(port)} 上已有进程在监听，但不是 ComfyUI 的应答（可能是你已开的 ComfyUI 正在启动，或别的程序），没有拉起。`,
		hint: "确认占用该端口的程序，或把 comfyEndpoint 改成一个空闲端口——下次启动会按它的端口传 --port，等待与探活也用它。",
		logPath: null,
		waitedMs: null,
		pid: null,
		owned: false,
		argvPreview,
		elapsedMs: nowOf(deps)() - startedAt
	};
	let launch;
	try {
		launch = launchComfyPlan(plan, {
			spawn: deps.spawn,
			endpoint
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			state: "launch-failed",
			endpoint: null,
			port,
			source: null,
			install: installSummaryOf(plan),
			probed: [],
			stats: null,
			note: `后台拉起失败：${reason}`,
			hint: "先用 node scripts/start-comfyui.mjs --print 看完整 argv 与 Python 路径，再确认 Desktop 记录的安装还能用。",
			logPath: null,
			waitedMs: null,
			pid: null,
			owned: false,
			argvPreview,
			elapsedMs: nowOf(deps)() - startedAt
		};
	}
	const wait = await waitForComfyStats(endpoint, {
		child: launch.child,
		timeoutMs: options.installTimeoutMs,
		intervalMs: options.waitIntervalMs,
		fetchImpl,
		now: deps.now,
		sleep: deps.sleep
	});
	if (wait.ok) return {
		...await readyStatus({
			endpoint,
			port,
			probed: [{
				endpoint,
				ok: true,
				note: null
			}]
		}, "launched", {
			install: installSummaryOf(plan),
			logPath: launch.logPath,
			waitedMs: wait.waitedMs ?? null,
			startedAt,
			deps,
			launchedPid: launch.pid ?? null,
			argvPreview,
			ownership: {
				owned: true,
				pid: launch.pid ?? null,
				alive: true,
				argv: argvPreview,
				recordPath: launch.recordPath ?? null,
				note: null
			}
		}),
		note: `已后台拉起 ComfyUI：${endpoint}（pid ${String(launch.pid)}，面板关闭后它继续跑）。日志：${launch.logPath}`,
		logPath: launch.logPath,
		pid: launch.pid ?? null
	};
	const waitedMs = wait.waitedMs ?? null;
	const failed = wait.reason === "exited";
	return {
		state: failed ? "launch-failed" : "timeout",
		endpoint: null,
		port,
		source: null,
		install: installSummaryOf(plan),
		probed: [],
		stats: null,
		note: failed ? `拉起后 ComfyUI 立即退出（exit code ${wait.exitCode}），日志：${launch.logPath}` : `拉起后 /system_stats 在 ${Math.round((waitedMs ?? 0) / 1e3)} 秒内没有就绪，日志：${launch.logPath}`,
		hint: "看日志最后 25 行排障（端口被占、Python 环境损坏、首次启动很慢都可能在日志里点名）；本工具不自动重试、不下载权重。",
		logPath: launch.logPath,
		waitedMs,
		pid: launch.pid ?? null,
		owned: false,
		argvPreview,
		elapsedMs: nowOf(deps)() - startedAt
	};
}
/**
* Stop the instance this plugin/CLI started (never somebody else's).
*
* The safety property is the whole point of this function: it stops a process
* only when the launch record names a `main.py` **and** the live process's
* command line still contains it. “Cannot read the command line” is answered
* with `stopped: false, reason: 'unverified'`, not with a hopeful `taskkill` —
* a wrong kill takes down whatever Python the user was training.
*
* Discovery uses the same strategy as a start (explicit dir, Desktop registry,
* bounded scan), because the record lives inside the install tree: a stop that
* cannot find the install cannot find the record either.
*
* @param deps - machine-facing seams; tests inject every one of them.
* @returns the stop report; never throws.
*/
async function stopEnvironment(deps = {}) {
	const plan = discoverInstall(deps);
	if (!plan) return {
		stopped: false,
		pid: null,
		exitCode: null,
		reason: "no-install",
		verified: null,
		note: "没找到 ComfyUI 安装，没有可停的实例（只停由插件/脚本拉起的实例）。",
		recordPath: null
	};
	try {
		return await stopComfyPlan(plan, {
			platform: deps.platform ?? process.platform,
			spawnSync: deps.spawnSync,
			kill: deps.kill,
			commandLineOf: deps.commandLineOf,
			fetchImpl: deps.fetchImpl ?? fetch
		});
	} catch (error) {
		return {
			stopped: false,
			pid: null,
			exitCode: null,
			reason: "signal-failed",
			verified: null,
			note: `停止失败：${error instanceof Error ? error.message : String(error)}`,
			recordPath: null
		};
	}
}
/** Downloadable weights, keyed by the exact file name a profile declares. */
const WEIGHT_SOURCES = {
	"qwen_image_2.1_int8_convrot.safetensors": {
		url: "https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
		bytes: 7256783064,
		sha256: "cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d",
		repoPath: "diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
		urlVerified: true
	},
	"qwen_image_2.1_turbo_int8_convrot.safetensors": {
		url: "https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors",
		bytes: 7256787829,
		sha256: "8144a0182964aa8403ad6dbc011db837304167d235161b9aabaa8532e967314c",
		repoPath: "diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors",
		urlVerified: true
	},
	"qwen3vl_8b_int8_convrot.safetensors": {
		url: "https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors",
		bytes: 9350798360,
		sha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
		repoPath: "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
		urlVerified: true
	},
	"qwen_image_2.1_vae_bf16.safetensors": {
		url: "https://hf-mirror.com/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors",
		bytes: 675509688,
		sha256: "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9",
		repoPath: "vae/qwen_image_2.1_vae_bf16.safetensors",
		urlVerified: true
	},
	"moss_image_sft_int8_convrot.safetensors": {
		url: "https://hf-mirror.com/Comfy-Org/MOSS-Image/resolve/main/diffusion_models/moss_image_sft_int8_convrot.safetensors",
		bytes: 5413698958,
		sha256: null,
		repoPath: "diffusion_models/moss_image_sft_int8_convrot.safetensors",
		urlVerified: true
	},
	"qwen3.5_9b_w4a8_gptq.safetensors": {
		url: "https://hf-mirror.com/Comfy-Org/MOSS-Image/resolve/main/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors",
		bytes: 7343591088,
		sha256: null,
		repoPath: "text_encoders/qwen3.5_9b_w4a8_gptq.safetensors",
		urlVerified: true
	},
	"flux2-vae_small.safetensors": {
		url: "https://hf-mirror.com/Comfy-Org/MOSS-Image/resolve/main/vae/flux2-vae_small.safetensors",
		bytes: 249521340,
		sha256: "d8d52ba036475f5fb07c8b435e176d3d97ebfa82f0d1a1c317f9cc1e25bd013b",
		repoPath: "vae/flux2-vae_small.safetensors",
		urlVerified: true
	}
};
function readJsonSafe(filePath) {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}
function readTextSafe(filePath) {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}
/** Pull base_path out of a ComfyUI extra-model-paths yaml. Exported for tests. */
function parseModelsBaseYaml(text) {
	const match = /^[ \t]*base_path:[ \t]*(.+)$/m.exec(String(text ?? ""));
	if (!match) return null;
	const raw = match[1].trim().replace(/^['"]/, "").replace(/['"]$/, "");
	return raw.length > 0 ? raw : null;
}
/** Resolve base_path from one yaml; relative paths resolve against the yaml. */
function yamlBaseFrom(filePath) {
	const base = parseModelsBaseYaml(readTextSafe(filePath) ?? "");
	if (!base) return null;
	return isAbsolute(base) ? base : resolve(dirname(filePath), base);
}
/** Desktop registry -> instance-model-paths yaml -> base_path. */
function desktopModelsBase(appData) {
	const desktop = join(appData, "Comfy Desktop");
	const pathsDir = join(desktop, "instance-model-paths");
	const installations = readJsonSafe(join(desktop, "installations.json"));
	const records = Array.isArray(installations) ? installations : [];
	for (const install of records) {
		if (install?.status && install.status !== "installed") continue;
		if (!install?.id) continue;
		const own = join(pathsDir, String(install.id) + ".yaml");
		const base = yamlBaseFrom(own);
		if (base) return {
			base,
			file: own
		};
	}
	try {
		for (const name of readdirSync(pathsDir)) {
			if (!name.endsWith(".yaml")) continue;
			const file = join(pathsDir, name);
			const base = yamlBaseFrom(file);
			if (base) return {
				base,
				file
			};
		}
	} catch {}
	return null;
}
/** Resolve the models root (T04 section 4.4, in order). */
async function resolveModelsBase(options, deps = {}) {
	const endpoint = (options.endpoint ?? "").replace(/\/+$/, "");
	if (endpoint) try {
		const payload = await (await (deps.fetchImpl ?? fetch)(endpoint + "/system_stats", { signal: AbortSignal.timeout(4e3) })).json();
		const argv = Array.isArray(payload?.system?.argv) ? payload.system.argv.map(String) : [];
		const flagAt = argv.indexOf("--extra-model-paths-config");
		if (flagAt >= 0 && argv[flagAt + 1]) {
			const file = argv[flagAt + 1];
			const base = yamlBaseFrom(file);
			if (base) return {
				base,
				source: "instance-argv",
				note: "来自运行中实例的 --extra-model-paths-config：" + file
			};
		}
		const baseDirAt = argv.indexOf("--base-directory");
		if (baseDirAt >= 0 && argv[baseDirAt + 1]) {
			const base = resolve(String(argv[baseDirAt + 1]));
			return {
				base,
				source: "instance-argv",
				note: "来自运行中实例的 --base-directory：" + base
			};
		}
	} catch {}
	const appData = deps.appData ?? process.env.APPDATA;
	if (appData) {
		const desktop = desktopModelsBase(appData);
		if (desktop) return {
			base: desktop.base,
			source: "desktop-yaml",
			note: "来自 Comfy Desktop 生成的模型路径 yaml：" + desktop.file
		};
		const settings = readJsonSafe(join(appData, "Comfy Desktop", "settings.json"));
		const dirs = Array.isArray(settings?.modelsDirs) ? settings.modelsDirs.filter((dir) => typeof dir === "string" && dir.length > 0) : [];
		if (dirs.length > 0) return {
			base: String(dirs[0]),
			source: "desktop-settings",
			note: "来自 Comfy Desktop settings.json 的 modelsDirs[0]（期望值，可能与运行实例不同）"
		};
	}
	const plan = discoverInstall(deps);
	if (plan?.mainPy) {
		const base = join(dirname(String(plan.mainPy)), "models");
		if (existsSync(base)) return {
			base,
			source: "install-tree",
			note: "兜底：ComfyUI 安装树里的 models（Desktop 下通常是空目录）"
		};
	}
	return {
		base: null,
		source: null,
		note: "没解析出模型根：ComfyUI 没在跑且没有 Comfy Desktop 安装记录。"
	};
}
/** Build the three-item download plan of one profile against a models root. */
function weightPlanOf(profileId, base, sources = WEIGHT_SOURCES) {
	const profile = resolveProfile(profileId);
	return [
		"unet",
		"clip",
		"vae"
	].map((kind) => {
		const rule = profile.weights[kind];
		const filename = rule.example;
		return {
			kind,
			filename,
			loader: rule.loader,
			field: rule.field,
			folder: rule.folder,
			targetPath: base === null ? null : join(base, rule.folder, filename),
			source: sources[filename] ?? null
		};
	});
}
/** Read one loader field out of /object_info and look for the EXACT file name. */
async function checkObjectInfoFile(input) {
	const fetchImpl = input.fetchImpl ?? fetch;
	const url = input.endpoint.replace(/\/+$/, "") + "/object_info/" + encodeURIComponent(input.loader);
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			signal: AbortSignal.timeout(5e3)
		});
		const node = JSON.parse(await response.text())?.[input.loader]?.input;
		const field = node?.required?.[input.field] ?? node?.optional?.[input.field];
		const options = Array.isArray(field?.[0]) ? field[0].filter((value) => typeof value === "string") : [];
		const listed = options.includes(input.filename);
		return {
			listed,
			options,
			note: listed ? "object_info 列出了精确文件名" : "object_info 没有列出该文件（当前 " + options.length + " 个候选）"
		};
	} catch (error) {
		return {
			listed: false,
			options: [],
			note: "object_info 探测失败：" + (error instanceof Error ? error.message : String(error))
		};
	}
}
/** sha256 of one file, streamed. Exported for tests. */
async function sha256OfFile(filePath) {
	return await new Promise((done, fail) => {
		const hash = createHash("sha256");
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", fail);
		stream.on("end", () => done(hash.digest("hex")));
	});
}
function fileSizeOrNull(filePath) {
	try {
		return statSync(filePath).size;
	} catch {
		return null;
	}
}
async function streamIntoFile(response, partPath, append, onProgress) {
	const handle = await open(partPath, append ? "a" : "w");
	let written = 0;
	try {
		const body = response.body;
		if (!body) throw new Error("下载响应没有 body");
		const stream = typeof body.getReader === "function" ? Readable.fromWeb(body) : body;
		for await (const chunk of stream) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			await handle.write(buffer);
			written += buffer.length;
			onProgress?.(written);
		}
	} finally {
		await handle.close();
	}
	return written;
}
/**
* Download one weight file: .part first, then byte/sha256 check, then atomic
* rename. Resume works against Range-honouring servers (hf-mirror: 206); a 200
* answer restarts from 0 instead of corrupting the file.
*/
async function downloadOneWeight(input) {
	const fetchImpl = input.fetchImpl ?? fetch;
	const filename = basename(input.targetPath);
	const partPath = input.targetPath + ".part";
	const note = (extra) => "目标：" + input.targetPath + "。" + extra;
	const presentSize = fileSizeOrNull(input.targetPath);
	if (presentSize === input.expectedBytes) {
		const sha = input.sha256 ?? null;
		const shaOk = sha === null ? null : await sha256OfFile(input.targetPath) === sha;
		if (shaOk !== false) return {
			filename,
			targetPath: input.targetPath,
			state: "already-present",
			bytesOnDisk: presentSize,
			expectedBytes: input.expectedBytes,
			sha256Ok: shaOk,
			partBytesAtStart: 0,
			note: note("文件已在位且大小/哈希匹配，没有重复下载。")
		};
	}
	mkdirSync(dirname(input.targetPath), { recursive: true });
	let offset = fileSizeOrNull(partPath) ?? 0;
	if (offset > input.expectedBytes) {
		rmSync(partPath, { force: true });
		offset = 0;
	}
	const partBytesAtStart = offset;
	try {
		let resumed = offset > 0;
		if (offset !== input.expectedBytes) {
			const headers = {};
			if (offset > 0) headers.Range = "bytes=" + offset + "-";
			const timeout = AbortSignal.timeout(18e5);
			const signal = input.signal === void 0 ? timeout : AbortSignal.any([input.signal, timeout]);
			const response = await fetchImpl(input.url, {
				method: "GET",
				headers,
				signal
			});
			if (!response.ok && response.status !== 206) throw new Error("HTTP " + response.status + " " + response.statusText);
			if (offset > 0 && response.status === 200) {
				resumed = false;
				offset = 0;
			}
			await streamIntoFile(response, partPath, resumed, input.onProgress);
		}
		const size = fileSizeOrNull(partPath);
		if (size !== input.expectedBytes) throw new Error("字节数不对：下载后 " + String(size) + "，期望 " + String(input.expectedBytes) + "（.part 保留，可续传）");
		const sha = input.sha256 ?? null;
		const shaOk = sha === null ? null : await sha256OfFile(partPath) === sha;
		if (shaOk === false) throw new Error("sha256 不匹配（.part 保留，请删掉后重下）");
		rmSync(input.targetPath, { force: true });
		await rename(partPath, input.targetPath);
		return {
			filename,
			targetPath: input.targetPath,
			state: resumed ? "resumed" : "downloaded",
			bytesOnDisk: input.expectedBytes,
			expectedBytes: input.expectedBytes,
			sha256Ok: shaOk,
			partBytesAtStart,
			note: note(resumed ? "从 .part 续传完成并原子改名。" : "下载完成并原子改名。")
		};
	} catch (error) {
		return {
			filename,
			targetPath: input.targetPath,
			state: "failed",
			bytesOnDisk: fileSizeOrNull(partPath) ?? 0,
			expectedBytes: input.expectedBytes,
			sha256Ok: null,
			partBytesAtStart,
			note: note(error instanceof Error ? error.message : String(error))
		};
	}
}
/**
* Make a profile's three weights present inside a resolved models root.
* Success is per T04: /object_info lists the exact file name. A finished download
* with no running ComfyUI to verify is 'unverified', never 'ready'.
*/
async function ensureProfileWeights(input) {
	const profile = resolveProfile(input.profileId);
	const dryRun = input.dryRun === true;
	const fetchImpl = input.deps?.fetchImpl ?? fetch;
	const plan = weightPlanOf(profile.id, input.base, input.sources ?? WEIGHT_SOURCES);
	if (input.base === null) return {
		profile: profile.id,
		base: null,
		dryRun,
		state: "blocked",
		weights: plan.map((item) => ({
			kind: item.kind,
			filename: item.filename,
			targetPath: null,
			bytes: item.source?.bytes ?? null,
			state: "no-base",
			objectInfo: null,
			note: "没解析出模型根，先让 ComfyUI 跑起来或确认 Desktop 安装。"
		})),
		note: "没解析出模型根：下载目标无法确定，未写任何文件。"
	};
	const reports = [];
	let sawFailure = false;
	let sawUnverified = false;
	let changed = false;
	for (const item of plan) {
		const source = item.source;
		if (source === null) {
			reports.push({
				kind: item.kind,
				filename: item.filename,
				targetPath: item.targetPath,
				bytes: null,
				state: "no-source",
				objectInfo: null,
				note: "下载表里没有这个文件的来源，未下载（按部署文档手工放置）。"
			});
			sawFailure = true;
			continue;
		}
		const alreadyPresent = (item.targetPath ? fileSizeOrNull(item.targetPath) : null) === source.bytes;
		if (dryRun) {
			reports.push({
				kind: item.kind,
				filename: item.filename,
				targetPath: item.targetPath,
				bytes: source.bytes,
				state: alreadyPresent ? "already-present" : "would-download",
				objectInfo: null,
				note: alreadyPresent ? "已在位（大小匹配）。" : "将下载 " + source.url + "（" + String(source.bytes) + " 字节" + (source.urlVerified ? "" : "；URL 未实测") + "）。"
			});
			continue;
		}
		let download = null;
		if (!alreadyPresent) {
			download = await downloadOneWeight({
				url: source.url,
				targetPath: String(item.targetPath),
				expectedBytes: source.bytes,
				sha256: source.sha256,
				fetchImpl,
				...input.signal === void 0 ? {} : { signal: input.signal },
				...input.onProgress === void 0 ? {} : { onProgress: (written) => {
					input.onProgress?.({
						filename: item.filename,
						kind: item.kind,
						written,
						total: source.bytes,
						targetPath: item.targetPath
					});
				} }
			});
			if (download.state === "failed") {
				reports.push({
					kind: item.kind,
					filename: item.filename,
					targetPath: item.targetPath,
					bytes: source.bytes,
					state: "failed",
					objectInfo: null,
					note: download.note
				});
				sawFailure = true;
				continue;
			}
			changed = true;
		}
		if (!input.endpoint) {
			sawUnverified = true;
			reports.push({
				kind: item.kind,
				filename: item.filename,
				targetPath: item.targetPath,
				bytes: source.bytes,
				state: "unverified",
				objectInfo: null,
				note: (download ? download.note : "文件已在位") + "，但 ComfyUI 没在跑，无法用 /object_info 判定成功。"
			});
			continue;
		}
		const check = await checkObjectInfoFile({
			endpoint: input.endpoint,
			loader: item.loader,
			field: item.field,
			filename: item.filename,
			fetchImpl
		});
		if (check.listed) reports.push({
			kind: item.kind,
			filename: item.filename,
			targetPath: item.targetPath,
			bytes: source.bytes,
			state: changed && !alreadyPresent ? "installed" : "present",
			objectInfo: check,
			note: (download ? download.note : "文件已在位") + " /object_info 已列出。"
		});
		else {
			sawFailure = true;
			reports.push({
				kind: item.kind,
				filename: item.filename,
				targetPath: item.targetPath,
				bytes: source.bytes,
				state: "failed",
				objectInfo: check,
				note: "下载/落盘后 /object_info 仍没列出：" + check.note + "（目标 " + String(item.targetPath) + "；可见列表：" + check.options.join(", ") + "）。按部署文档排障顺序查：目录 -> 文件名 -> 扫描缓存。"
			});
		}
	}
	const ok = reports.filter((report) => report.state === "present" || report.state === "installed" || report.state === "already-present").length;
	const state = sawFailure ? "partial" : sawUnverified ? "unverified" : changed ? "downloaded" : "ready";
	return {
		profile: profile.id,
		base: input.base,
		dryRun,
		state,
		weights: reports,
		note: dryRun ? `${String(reports.filter((report) => report.state === "already-present").length)}/${String(reports.length)} 个权重已在盘；` + (sawFailure ? "有项无法计划，见 weights。" : reports.some((report) => report.state === "would-download") ? "其余待下载。" : "无需下载。") : ok + "/" + String(reports.length) + " 个权重被 /object_info 列出；" + (sawFailure ? "有失败项，见 weights。" : sawUnverified ? "有文件已落盘但当前没有运行中的 ComfyUI 可验证。" : "全部就绪。")
	};
}
/**
* Build the install guide. Automation is gated on the host granting computer
* use: this plugin never drives a GUI installer by itself, and an unauthorised
* environment must not even attempt it (T14 acceptance).
*/
function installGuidanceOf(deps = {}, installed = false) {
	const authorized = deps.computerUse?.authorized === true;
	const shared = {
		state: installed ? "installed" : "not-installed",
		authorized,
		downloadPage: "https://www.comfy.org/download",
		options: [
			"Windows 安装包（.exe，官方下载页）",
			"装到有空间的盘（本机 D 盘）",
			"计算后端选 CUDA（NVIDIA）"
		]
	};
	if (installed) return {
		...shared,
		mode: "manual",
		steps: [],
		note: "ComfyUI 已安装，不需要安装引导。"
	};
	if (authorized) return {
		...shared,
		mode: "automated",
		steps: [{
			title: "授权门槛",
			detail: "宿主已授予 computer use；自动流程由宿主的授权执行器完成，插件本身不模拟点击。"
		}, {
			title: "安装",
			detail: "下载官方 Windows 安装包 -> 选择安装盘 -> 计算后端 CUDA -> 首次启动建实例。"
		}],
		note: "已授权自动安装；若宿主没有提供安装执行器，则退回手工步骤。"
	};
	return {
		...shared,
		mode: "manual",
		steps: [
			{
				title: "1. 下载",
				detail: "打开 https://www.comfy.org/download 下载 Windows 安装包（.exe）。"
			},
			{
				title: "2. 选盘安装",
				detail: "安装时选择空间足够的盘（本机装在 D:\\Comfy-Desktop）；装完目录里有 ComfyUI-Installs 与 ComfyUI-Shared。"
			},
			{
				title: "3. 选计算后端",
				detail: "NVIDIA 卡选 CUDA；AMD / Apple Silicon 按各自分支安装。"
			},
			{
				title: "4. 首次启动",
				detail: "启动一次让它建实例（会自动拉起 ComfyUI）；实例在 8188/8000 应答即可。"
			},
			{
				title: "5. 回来自检",
				detail: "回到本工具 action=status；就绪后 action=download 按当前 comfyModel 下载三个权重（先不带 confirm 看计划）。"
			}
		],
		note: "未获 computer use 授权：只输出图文步骤，不执行任何自动安装。"
	};
}
/** Run authorised install automation, if (and only if) the host granted it. */
async function runInstallAutomation(deps = {}) {
	const gate = deps.computerUse;
	if (!gate || gate.authorized !== true) return {
		ran: false,
		note: "未获 computer use 授权：不执行任何自动安装动作（手动步骤见 install.steps）。"
	};
	if (typeof gate.run !== "function") return {
		ran: false,
		note: "已授权但宿主没有提供安装执行器：不假装能装，退回手工步骤。"
	};
	try {
		const result = await gate.run();
		return {
			ran: true,
			note: typeof result?.note === "string" ? result.note : "自动安装执行器已运行。"
		};
	} catch (error) {
		return {
			ran: false,
			note: "自动安装执行器失败：" + (error instanceof Error ? error.message : String(error))
		};
	}
}
/** The tool name the environment layer registers. Never `qwen_image_env`. */
const ENVIRONMENT_TOOL_NAME = "qwen_image_setup";
/** One-line, user-facing summary of a status report. */
function summarize$1(status) {
	if (status.state === "ready") {
		const devices = status.stats?.devices ?? [];
		const gpu = devices.length > 0 ? `，${devices[0]?.name ?? "GPU"}` : "";
		return `ComfyUI 就绪：${status.endpoint}（${status.source === "launched" ? "本次拉起" : status.source === "configured" ? "配置端点" : "端口探测"}${gpu}）。`;
	}
	if (status.state === "not-running") return `ComfyUI 没在跑，但找到了安装：${status.install?.installPath ?? "?"}。可以用 action="start" 后台拉起。`;
	if (status.state === "not-installed") return "没找到 ComfyUI 安装（未安装状态；本工具不负责安装）。";
	return status.note;
}
/**
* Register the environment tool on the tool registry.
*
* @param ctx - cordis context providing `tools`.
* @param getConfig - reads the activation's config **per call**, so a settings
*   save (a new port list, a different endpoint) is observed without a restart.
*/
function registerEnvironmentTools(ctx, getConfig) {
	ctx.tools.register(defineTool({
		name: ENVIRONMENT_TOOL_NAME,
		description: "环境层（P1a/P1b）：探测本机 ComfyUI——先按配置的端点/端口表探活，再读 Comfy Desktop 注册表判断装没装；没在跑时 action=\"start\" 按 Desktop 记录的 Python 与启动参数后台拉起并等 /system_stats 就绪，action=\"stop\" 只停本插件/脚本拉起过的实例。P1b：action=\"install\" 输出安装引导（未获 computer use 授权时绝不执行自动安装）；action=\"download\" 把当前 comfyModel 的三个权重按实测方案下载到 Desktop 模型根（.part + 字节数/sha256 + 原子改名）。下载成功的唯一判据是 /object_info/<Loader> 的候选列表包含精确文件名；本工具不重启 ComfyUI。先不带 confirm 调用可只看计划。",
		parameters: {
			action: {
				type: "string",
				enum: [
					"status",
					"start",
					"stop",
					"install",
					"download"
				],
				description: "status（默认）=看现状（含安装引导与权重在位情况）；start=没在跑就拉起；stop=停掉本插件拉起的实例；install=安装引导；download=按当前 comfyModel 下载权重（不带 confirm 只出计划）。"
			},
			timeoutMs: {
				type: "integer",
				description: "start 时等 /system_stats 就绪的预算（毫秒，5 秒–15 分钟），默认 180000。"
			},
			confirm: {
				type: "boolean",
				description: "仅 download 使用：缺省 false = dry-run 只返回计划；true 才真的下载并落盘（体积可达 16 GiB 以上，支持断点续传）。"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		timeoutMs: 9e5,
		isConcurrencySafe: () => false,
		async execute(args, _exec) {
			const action = [
				"start",
				"stop",
				"install",
				"download"
			].includes(args?.action) ? args.action : "status";
			const startedAt = Date.now();
			const config = getConfig();
			let options = environmentOptionsOf(config);
			const requested = args?.timeoutMs;
			if (action === "start" && typeof requested === "number" && Number.isFinite(requested)) options = {
				...options,
				installTimeoutMs: Math.min(9e5, Math.max(5e3, Math.round(requested)))
			};
			if (action === "stop") {
				const stop = await stopEnvironment();
				return jsonSafe$1({
					action,
					environment: null,
					stop,
					summary: stop.note,
					elapsed_ms: Date.now() - startedAt
				});
			}
			const environment = action === "start" ? await ensureEnvironment(options) : await inspectEnvironment(options);
			const endpoint = environment.state === "ready" ? environment.endpoint : null;
			if (action === "install") {
				const install = installGuidanceOf({}, environment.state !== "not-installed");
				const automation = await runInstallAutomation({});
				return jsonSafe$1({
					action,
					environment,
					install,
					automation,
					summary: automation.note,
					elapsed_ms: Date.now() - startedAt
				});
			}
			if (action === "download") {
				if (environment.state !== "ready") return jsonSafe$1({
					action,
					environment,
					install: installGuidanceOf({}, environment.state !== "not-installed"),
					models_base: {
						base: null,
						source: null,
						note: "ComfyUI 没在跑，下载与 /object_info 校验都无法进行。"
					},
					weights: null,
					summary: "ComfyUI 没就绪：先用 action=\"start\" 启动（或装好/启动 ComfyUI），再回来下载。",
					elapsed_ms: Date.now() - startedAt
				});
				const base = await resolveModelsBase({ endpoint });
				const dryRun = args?.confirm !== true;
				const weights = await ensureProfileWeights({
					profileId: config.comfyModel,
					base: base.base,
					endpoint,
					dryRun
				});
				return jsonSafe$1({
					action,
					environment,
					models_base: base,
					weights,
					dry_run: dryRun,
					summary: dryRun ? "dry-run：" + weights.note : weights.note,
					elapsed_ms: Date.now() - startedAt
				});
			}
			const base = environment.state === "ready" || environment.state === "not-running" ? await resolveModelsBase({ endpoint }) : {
				base: null,
				source: null,
				note: "未安装：没有可解析的模型根。"
			};
			return jsonSafe$1({
				action,
				environment,
				install: installGuidanceOf({}, environment.state !== "not-installed"),
				models_base: base,
				weights: environment.state === "ready" && base.base ? await ensureProfileWeights({
					profileId: config.comfyModel,
					base: base.base,
					endpoint,
					dryRun: true
				}) : null,
				summary: summarize$1(environment),
				elapsed_ms: Date.now() - startedAt
			});
		}
	}));
}
//#endregion
//#region src/skill.ts
/** Skill name shown in the catalog and used when routing. */
const SKILL_NAME = "qwen-image-forge";
/** Short catalog blurb; the routing keywords live here, not in the body. */
const SKILL_DESCRIPTION = "用本机 ComfyUI 生图/改图（底模由 `comfyModel` 选择：`qwen21-base` / `qwen21-turbo` 走 Qwen-Image 2.1，`moss-sft` 走 MOSS-Image）：把口语需求按提示词契约改写成成品 prompt，并把契约里的 wh_ratio 直接作为工具的一等参数出图（无需人工换算像素）。当用户要求生成图片、出海报/头像/封面/壁纸、按指定画幅比出图，或要给了一/多张参考图的改图、融图需求写指令时使用。Qwen-Image 2.1 与 MOSS-Image 都支持文生图与参考图编辑（MOSS 改图走社区 edit LoRA，需 ComfyUI 的 `models/loras/` 里装有该 LoRA，缺它会报错点名文件）。";
/** Reference documents the body points at, loaded from the package root. */
const REFERENCE_FILES = ["references/t2i_rules.md", "references/edit_rules.md"];
/** Resolve one package-relative file, or undefined when it is not shipped. */
function resolveFile(relative) {
	try {
		return fileURLToPath(new URL(`../${relative}`, import.meta.url));
	} catch {
		return;
	}
}
/**
* Compose the skill body.
*
* `skill.md` is the model-facing routing document; the two reference files are
* shipped beside it and are only useful if the model can open them, so their
* resolved absolute paths are appended — the body must not promise files the
* model cannot reach. A missing reference degrades to a note instead of
* breaking plugin load.
*/
function composeContent() {
	return `${readFileSync(new URL("../skill.md", import.meta.url), "utf8")}\n> 下面两处路径由插件在注册时填入，可直接用 read 工具打开：\n${REFERENCE_FILES.map((relative) => {
		const absolute = resolveFile(relative);
		return absolute === void 0 ? `- \`${relative}\` —— 未随包分发，请只用本技能正文里的规则` : `- \`${relative}\`（本机绝对路径：\`${absolute}\`，用 read 工具按此路径打开）`;
	}).join("\n")}\n`;
}
/**
* Register the runtime skill so the model discovers the routing guidance
* through the skill catalog and loads the full body on demand.
*
* @param ctx - cordis context providing `skills`.
*/
function registerImageForgeSkill(ctx) {
	const skill = {
		name: SKILL_NAME,
		description: SKILL_DESCRIPTION,
		source: "runtime",
		content: composeContent()
	};
	ctx.skills.register(skill);
}
//#endregion
//#region src/studio-shared.ts
/**
* Wire contract shared by the Studio host routes and the browser panel.
*
* The Studio is a **ComfyUI-only** workbench for Qwen-Image 2.1. That single
* backend is why this contract is much smaller than a multi-provider one: there
* is no provider matrix, no per-channel credential, and no quality tier
* negotiation — just a prompt, a canvas, a step count, an optional seed, and
* zero or more reference images.
*
* The prompt-optimisation channel is deliberately *separate* from generation:
* it borrows the conversation model (through the host's `llm` service) to
* rewrite the user's phrasing, and never touches ComfyUI. Keeping the two apart
* is what makes "optimise, edit, regenerate" a cheap loop instead of a
* generation-and-hope cycle.
*
* @module studio-shared
*/
/** Same-origin route the Studio panel reads its capability snapshot from. */
const STUDIO_CONFIG_ROUTE = "/plugins/dsh-image-forge/studio/config";
/** Same-origin route the Studio panel posts one generation request to. */
const STUDIO_GENERATE_ROUTE = "/plugins/dsh-image-forge/studio/generate";
/** Same-origin route the Studio panel asks the conversation model to rewrite a prompt. */
const STUDIO_OPTIMIZE_ROUTE = "/plugins/dsh-image-forge/studio/optimize";
/** Same-origin route the board list is read from. */
const STUDIO_BOARDS_ROUTE = "/plugins/dsh-image-forge/studio/boards";
/** Same-origin route one board is read or mutated through. */
const STUDIO_BOARD_ROUTE = "/plugins/dsh-image-forge/studio/board";
/** Same-origin route the cross-board asset list is read from. */
const STUDIO_ASSETS_ROUTE = "/plugins/dsh-image-forge/studio/assets";
/**
* Same-origin route one generated PNG/JPEG/WebP is served from, as
* `STUDIO_FILE_ROUTE?path=<encoded absolute path>`.
*
* The reason this route exists is that **a local path is not a URL**. The
* Studio panel and the tool cards both want to show images the tools wrote to
* disk (`C:\Users\…\qwen_1248x1248_1.png`), but an `<img src>` carrying a bare
* Windows path resolves as a *relative* URL against the page origin, and a
* `file://` rewrite is blocked outright inside an http-served page. Neither
* half can display the file without the host serving it, so the plugin serves
* it itself: the panel and the cards read `studioFileUrl(path)` and hit this
* route, which streams the bytes back same-origin.
*/
const STUDIO_FILE_ROUTE = "/plugins/dsh-image-forge/studio/file";
/**
* Same-origin SSE stream that carries one run's live ComfyUI progress.
*
* The page never opens ComfyUI's own WebSocket: this plugin subscribes to
* `/ws` in Node and re-publishes normalized events here (decision 4 in
* `docs/DIRECTION-ALIGNMENT.md`). Each SSE message is one
* {@link StudioProgressEvent} as JSON in its `data:` field. `state` events say
* whether the bridge is connected, so a stopped ComfyUI is visible instead of
* leaving a stale step counter on screen.
*/
const STUDIO_EVENTS_ROUTE = "/plugins/dsh-image-forge/studio/events";
/**
* Same-origin route an external image file is imported through (DD10).
*
* The design's drop-an-OS-file story needed a route that did not exist: the
* asset route is a read-only query, the file route serves bytes and never
* accepts them, and the board route's body cap (256 KB) cannot carry a picture.
* So importing is its own contract: one image per request, bounded bytes, and
* the same identity semantics as a recorded generation.
*/
const STUDIO_IMPORT_ROUTE = "/plugins/dsh-image-forge/studio/import";
/**
* Same-origin route the workbench starts, stops and inspects ComfyUI through.
*
* Deliberately one POST route with an `action` discriminator rather than three
* near-identical routes: the three verbs share the same body shape, the same
* origin check and the same single-flight lock, and a typo in the action is
* refused at the host instead of 404ing with no explanation.
*
* It is a **POST** even for `status`, because the answer depends on mutating
* state (the launch record) and must never be served from a cache or prefetched
* by a browser.
*/
const STUDIO_ENVIRONMENT_ROUTE = "/plugins/dsh-image-forge/studio/environment";
/**
* Same-origin GET route that tails a ComfyUI launch log into the panel.
* `STUDIO_LOG_ROUTE?path=<encoded absolute path>` returns the last N lines as
* plain UTF-8 text. It never opens an external terminal window: the panel reads
* it and shows it inline. Only launch logs under the Desktop `logs/` dir are
* served (see studio-routes).
*/
const STUDIO_LOG_ROUTE = "/plugins/dsh-image-forge/studio/log";
/** Actions {@link STUDIO_ENVIRONMENT_ROUTE} accepts. */
const STUDIO_ENVIRONMENT_ACTIONS = [
	"status",
	"start",
	"stop",
	"download"
];
/** Largest single imported file accepted, in bytes (32 MB, DD10). */
const STUDIO_IMPORT_MAX_ITEM_BYTES = 33554432;
/**
* Body cap for the import route, in bytes.
*
* Independent of the board route's 256 KB and deliberately above the item cap:
* base64 inflates by 4/3, so a legal 32 MB file arrives as a ~42.7 MB body.
*/
const STUDIO_IMPORT_MAX_BODY_BYTES = 50331648;
/**
* Widths the file route will downscale to (G20).
*
* A whitelist, not a free number: each entry is a cache file the route may
* create, and an unbounded `?w=` is an unbounded cache directory plus an
* unbounded per-request CPU cost. 256 is the contact-sheet cell, 512 is the
* canvas node, 1024 is a "large but not original" preview.
*/
const STUDIO_THUMB_WIDTHS = [
	256,
	512,
	1024
];
/** Directory (under `outputDir`) the generated thumbnails are cached in. */
const STUDIO_THUMB_DIR = ".dsh-image-forge";
/**
* Validate a `?w=` value against {@link STUDIO_THUMB_WIDTHS}.
*
* @param raw - the query string value, or `null` when absent.
* @returns the width, `undefined` when the parameter was not given at all, or
*   `null` when it was given but is not an allowed number. The three cases are
*   distinguishable on purpose: "no width" is the original file, "bad width" is
*   a 400, and conflating them would silently serve originals to a caller that
*   asked for something impossible.
*/
function parseStudioThumbWidth(raw) {
	if (raw === null || raw.length === 0) return void 0;
	const width = Number(raw);
	return STUDIO_THUMB_WIDTHS.includes(width) ? width : null;
}
/** File extensions the file route will serve, and the content types for them. */
const STUDIO_FILE_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp"
};
/** Canvas ratios the Studio offers; mirrors `WH_RATIOS` in `ratio.ts`. */
const STUDIO_RATIOS = [
	"1:1",
	"4:3",
	"3:4",
	"3:2",
	"2:3",
	"16:9",
	"9:16"
];
/** Longest prompt the Studio forwards, in characters. */
const STUDIO_MAX_PROMPT_CHARS = 4e3;
/** Upper bound on one request body, before base64 inflation. */
const STUDIO_MAX_BODY_BYTES = 50331648;
/** Longest compiled layout prompt the Studio forwards, in characters. */
const STUDIO_MAX_LAYOUT_CHARS = 65536;
/**
* Canonical canvas task id: `c` + 1–31 lowercase base36 characters.
*
* Mirrors `makeItemId` in `boards.ts` (a `c`-prefixed random base36 string) and
* is validated on the host because it is a single-value field: a malformed one
* is refused outright, unlike the per-entry coordinate lists the board route
* drops one by one (CANVAS-DESIGN §14.3).
*/
const STUDIO_CLIENT_ID_PATTERN = /^c[0-9a-z]{1,31}$/;
/**
* True when a value is a canonical canvas task id.
*
* @param value - untrusted wire value.
* @returns whether it can be echoed back to the panel as a task id.
*/
function isStudioClientId(value) {
	return typeof value === "string" && STUDIO_CLIENT_ID_PATTERN.test(value);
}
/**
* First line of a failure, for any payload that must stay small.
*
* Shared by the route guards, the Studio pipeline and the tool layer: adapter
* messages are deliberately multi-line (they quote upstream tracebacks), but
* the wire copies carry only the headline. `fallback` replaces an empty first
* line — a tool's board note keeps the original text, an HTTP body says
* 未知错误.
*
* @param error - the thrown value.
* @param fallback - what to return when the first line is empty.
* @returns the first line, or the fallback.
*/
function firstLine(error, fallback = "未知错误") {
	const text = error instanceof Error ? error.message : String(error);
	const line = text.split(/\r?\n/, 1)[0] ?? text;
	return line.length > 0 ? line : fallback;
}
//#endregion
//#region src/progress.ts
/**
* The Studio's live progress bridge: ComfyUI `/ws` → same-origin SSE.
*
* ## Why the bridge lives in Node
*
* The panel is served by the host, never by ComfyUI. A page that opened
* ComfyUI's own WebSocket would be cross-origin against the renderer and would
* make the UI depend on a renderer detail; decision 4 in
* `docs/DIRECTION-ALIGNMENT.md` settles it the other way: **this plugin
* subscribes to `/ws`, and the page only ever talks to this plugin**. The
* bridge keeps exactly one ComfyUI socket for the whole host process and fans
* normalized events out to every subscribed SSE response, so two panels (the
* workbench and a tool card) watch the same run without opening two sockets.
*
* ## The `client_id` coupling, and why it is load-bearing
*
* ComfyUI sends per-prompt events (`execution_start`, `executing`,
* `progress`, `execution_error`, `execution_success`) only to the socket
* whose `clientId` equals the `client_id` that `/prompt` submission carried
* — `PromptServer.client_id` is set from `extra_data["client_id"]`
* (`execution.py`, `execute_async`) and every non-broadcast message is
* addressed to that sid. The plugin submits with
* `${process.pid}-dsh-image-forge` (`src/comfyui.ts`, `runGraph`), so the
* bridge registers under that id; a random one would receive only the
* broadcast `status` frames and never a step count. {@link COMFY_CLIENT_ID}
* mirrors that literal here because `comfyui.ts` does not export it, and both
* halves run in the same process, so the pid is the same.
*
* ## Normalized events
*
* Every SSE message is one JSON object shaped as {@link StudioProgressEvent},
* in the vocabulary of `studio-shared.ts`: queue depth from `status`, the
* step count from `progress` (with `progress_state` as the fallback for a
* node that only reports the aggregate), node changes, completion and
* failures. ComfyUI's binary preview frames and unknown message types
* (`cam.monitor`, `feature_flags`, `executed`, future additions) are
* dropped: the panel renders finished files from the generation response, and
* an unrecognized frame is not a reason to tear down a stream.
*
* ## Connection lifetime
*
* The socket is opened on the first subscriber and closed when the last one
* leaves, so a plugin nobody is watching costs ComfyUI nothing. A dropped
* socket is retried with exponential backoff, and every subscriber receives
* `state` events, which is what lets the page show "reconnecting" instead of
* freezing on the last step it saw.
*
* @module progress
*/
/**
* ComfyUI socket id this plugin registers as.
*
* Must match the `client_id` the submission path sends
* (`${process.pid}-dsh-image-forge` in `src/comfyui.ts`); see the module note
* for why a mismatch silently degrades to queue-only updates.
*/
const COMFY_CLIENT_ID = `${process.pid}-dsh-image-forge`;
/** First reconnect delay, doubled after every failed attempt. */
const DEFAULT_RECONNECT_BASE_MS = 500;
/** Ceiling for the reconnect delay. */
const DEFAULT_RECONNECT_MAX_MS = 5e3;
/**
* Budget for one `/system_stats` probe when (re)connecting.
*
* Deliberately shorter than one generation's budget: the bridge is a passive
* observer, so "ComfyUI is not answering right now" should surface in under a
* second rather than blocking the retry loop for three minutes.
*/
const DEFAULT_DISCOVER_TIMEOUT_MS = 800;
/**
* The runtime's WebSocket client, when it has one.
*
* Node 22+ ships one globally; older runtimes do not. A missing client is
* reported as a disconnected state rather than a crash, so the Studio keeps
* working on the HTTP path.
*/
function socketConstructor() {
	const ctor = globalThis.WebSocket;
	return typeof ctor === "function" ? ctor : void 0;
}
/**
* Create the process-wide ComfyUI progress bridge.
*
* The returned object is inert until somebody subscribes: no socket, no retry
* timer, no discovery probe. That is what makes it safe to construct once per
* route registration even though most plugin activations never open the
* Studio panel.
*
* @param options - settings reader, socket id and timing overrides.
* @returns the bridge.
*/
function createProgressBridge(options) {
	const listeners = /* @__PURE__ */ new Set();
	const clientId = options.clientId ?? COMFY_CLIENT_ID;
	const runs = options.runs;
	const reconnectBaseMs = Math.max(1, options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS);
	const reconnectMaxMs = Math.max(reconnectBaseMs, options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS);
	const discoverTimeoutMs = Math.max(1, options.discoverTimeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS);
	let socket;
	let retryTimer;
	let discovery;
	let attempt = 0;
	/**
	* Bumped on every attempt and every teardown.
	*
	* Callbacks from a superseded socket compare their ticket against this and
	* return, which is what stops one slow `close` from scheduling a second
	* reconnect on top of the current one.
	*/
	let generation = 0;
	let stopped = false;
	let current = { state: "connecting" };
	/** Dedupe key of the last `progress` event (see `progressEvent`). */
	let lastProgress;
	/** Prompt id the last `done` event was emitted for. */
	let lastDone;
	/** The state event for the current state, with absent fields omitted. */
	function stateEvent() {
		return {
			type: "state",
			state: current.state,
			...current.endpoint === void 0 ? {} : { endpoint: current.endpoint },
			...current.reason === void 0 ? {} : { reason: current.reason }
		};
	}
	/** Fan out one event; a throwing subscriber must not starve the rest. */
	function emit(event) {
		for (const listener of [...listeners]) try {
			listener(event);
		} catch {}
	}
	const unsubscribeRuns = runs?.subscribe((record) => {
		emit({
			type: "run",
			promptId: record.promptId,
			clientId: record.clientId,
			...record.boardId === void 0 ? {} : { boardId: record.boardId }
		});
	});
	/** Publish a state change, skipping the event when nothing changed. */
	function setState(next) {
		const same = next.state === current.state && next.endpoint === current.endpoint && next.reason === current.reason;
		current = next;
		if (!same) emit(stateEvent());
	}
	/** Schedule the next attempt after a failure, at most one timer at a time. */
	function retry(reason) {
		if (stopped || listeners.size === 0) return;
		setState({
			state: "disconnected",
			...reason === void 0 ? {} : { reason }
		});
		if (retryTimer !== void 0) return;
		const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** attempt);
		attempt += 1;
		retryTimer = setTimeout(() => {
			retryTimer = void 0;
			connect();
		}, delay);
		retryTimer.unref?.();
	}
	/** Close the socket without scheduling a retry. */
	function closeSocket() {
		const open = socket;
		socket = void 0;
		if (open === void 0) return;
		try {
			open.close(1e3, "dsh-image-forge 关闭");
		} catch {}
	}
	/** Attach the handlers for one attempt, ignoring callbacks from older ones. */
	function attach(ws, ticket) {
		ws.addEventListener("message", (event) => {
			if (ticket !== generation || stopped) return;
			const data = event.data;
			if (typeof data === "string") receive(data);
		});
		ws.addEventListener("open", () => {
			if (ticket !== generation || stopped) return;
			attempt = 0;
			setState({
				state: "connected",
				...current.endpoint === void 0 ? {} : { endpoint: current.endpoint }
			});
		});
		ws.addEventListener("error", () => {
			if (ticket !== generation || stopped) return;
			retry("ComfyUI 的 /ws 连接出错");
		});
		ws.addEventListener("close", () => {
			if (ticket !== generation || stopped) return;
			if (socket === ws) socket = void 0;
			retry("ComfyUI 的 /ws 连接已断开");
		});
	}
	/** Resolve one endpoint and open the socket. */
	async function connect() {
		if (stopped || listeners.size === 0) return;
		const ticket = ++generation;
		closeSocket();
		discovery?.abort();
		discovery = void 0;
		setState({ state: "connecting" });
		let endpoint;
		try {
			const controller = new AbortController();
			discovery = controller;
			endpoint = (await discoverComfyUi({
				...comfyOptionsOf$1(options.settings(), discoverTimeoutMs),
				portProbeTimeoutMs: discoverTimeoutMs
			}, controller.signal)).endpoint;
		} catch (error) {
			if (ticket !== generation || stopped) return;
			retry(firstLine(error));
			return;
		} finally {
			if (ticket === generation) discovery = void 0;
		}
		if (ticket !== generation || stopped) return;
		const Socket = socketConstructor();
		if (Socket === void 0) {
			setState({
				state: "disconnected",
				reason: "当前 Node 运行时没有 WebSocket 客户端（需要 Node 22+）"
			});
			return;
		}
		let ws;
		try {
			ws = new Socket(comfyWebSocketUrl(endpoint, clientId));
		} catch (error) {
			retry(firstLine(error));
			return;
		}
		socket = ws;
		try {
			ws.binaryType = "arraybuffer";
		} catch {}
		setState({
			state: "connecting",
			endpoint
		});
		attach(ws, ticket);
	}
	/**
	* Attach the canvas link to one event, when its run was registered.
	*
	* `cached` is deliberately left alone: it is a renderer cache hint, not a
	* lifecycle event, and the design list (`docs/CANVAS-DESIGN.md` §4.3) names
	* only the events the task node renders. A run that was never registered (the
	* Agent tools') keeps the exact pre-DD7 shape, which is the
	* backward-compatibility half of DD7.
	*
	* @param event - one normalized event.
	* @returns the event, with `clientId`/`boardId` when its run is known.
	*/
	function linkRun(event) {
		if (runs === void 0) return event;
		if (event.type === "state" || event.type === "queue" || event.type === "cached" || event.type === "run") return event;
		const promptId = "promptId" in event ? event.promptId : void 0;
		if (promptId === void 0) return event;
		const record = runs.lookup(promptId);
		if (record === void 0) return event;
		return {
			...event,
			clientId: record.clientId,
			...record.boardId === void 0 ? {} : { boardId: record.boardId }
		};
	}
	/** Parse one text frame and emit whatever it normalizes to. */
	function receive(raw) {
		const event = normalize(raw);
		if (event !== void 0) emit(linkRun(event));
	}
	/**
	* Turn one ComfyUI `/ws` frame into at most one Studio event.
	*
	* Frames are `{"type": …, "data": …}` (ComfyUI `server.py`, `send_json`).
	* Unknown or malformed frames return `undefined` rather than throwing: a
	* stream that dies on the first unrecognized message is worse than one that
	* ignores it.
	*
	* @param raw - the text frame body.
	* @returns the normalized event, when the frame carries one.
	*/
	function normalize(raw) {
		let message;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		const envelope = record$1(message);
		if (envelope === void 0) return void 0;
		const type = text(envelope.type);
		const data = record$1(envelope.data);
		if (type === void 0 || data === void 0) return void 0;
		switch (type) {
			case "status": {
				const remaining = number(record$1(record$1(data.status)?.exec_info)?.queue_remaining);
				return remaining === void 0 ? void 0 : {
					type: "queue",
					remaining
				};
			}
			case "execution_start": {
				const promptId = text(data.prompt_id);
				return promptId === void 0 ? void 0 : {
					type: "start",
					promptId
				};
			}
			case "execution_cached": {
				const promptId = text(data.prompt_id);
				if (promptId === void 0) return void 0;
				return {
					type: "cached",
					promptId,
					nodes: Array.isArray(data.nodes) ? data.nodes.filter((node) => typeof node === "string") : []
				};
			}
			case "executing": {
				const promptId = text(data.prompt_id);
				const node = text(data.node);
				if (node === void 0) {
					if (promptId === void 0 || promptId === lastDone) return void 0;
					lastDone = promptId;
					return {
						type: "done",
						promptId
					};
				}
				if (promptId === void 0) return void 0;
				const displayNode = text(data.display_node);
				return {
					type: "node",
					promptId,
					node,
					...displayNode === void 0 ? {} : { displayNode }
				};
			}
			case "progress": {
				const promptId = text(data.prompt_id);
				const value = number(data.value);
				const max = number(data.max);
				if (promptId === void 0 || value === void 0 || max === void 0) return void 0;
				return progressEvent(promptId, text(data.node), value, max);
			}
			case "progress_state": {
				const promptId = text(data.prompt_id);
				const nodes = record$1(data.nodes);
				if (promptId === void 0 || nodes === void 0) return void 0;
				for (const [nodeId, rawNode] of Object.entries(nodes)) {
					const node = record$1(rawNode);
					if (node === void 0 || node.state !== "running") continue;
					const value = number(node.value);
					const max = number(node.max);
					if (value === void 0 || max === void 0) continue;
					return progressEvent(promptId, text(node.node_id) ?? nodeId, value, max);
				}
				return;
			}
			case "execution_success": {
				const promptId = text(data.prompt_id);
				if (promptId === void 0 || promptId === lastDone) return void 0;
				lastDone = promptId;
				return {
					type: "done",
					promptId
				};
			}
			case "execution_error": {
				const message = firstLine(text(data.exception_message) ?? "ComfyUI 执行失败");
				const promptId = text(data.prompt_id);
				const node = text(data.node_id);
				const nodeType = text(data.node_type);
				return {
					type: "error",
					...promptId === void 0 ? {} : { promptId },
					...node === void 0 ? {} : { node },
					...nodeType === void 0 ? {} : { nodeType },
					message
				};
			}
			case "execution_interrupted": {
				const promptId = text(data.prompt_id);
				return promptId === void 0 ? void 0 : {
					type: "interrupted",
					promptId
				};
			}
			default: return;
		}
	}
	/**
	* Build one `progress` event, dropping the duplicate ComfyUI sends in
	* `progress_state`.
	*
	* @param promptId - the run this step belongs to.
	* @param node - the executing node, when ComfyUI names one.
	* @param value - completed steps.
	* @param max - total steps.
	* @returns the event, or `undefined` when it duplicates the previous one.
	*/
	function progressEvent(promptId, node, value, max) {
		const key = `${promptId}|${node ?? ""}|${value}|${max}`;
		if (key === lastProgress) return void 0;
		lastProgress = key;
		return {
			type: "progress",
			promptId,
			...node === void 0 ? {} : { node },
			value,
			max,
			percent: max > 0 ? Math.min(100, Math.round(value / max * 100)) : 0,
			label: `${value}/${max}`
		};
	}
	/** Cancel timers, abort discovery and close the socket. */
	function teardown() {
		generation += 1;
		if (retryTimer !== void 0) {
			clearTimeout(retryTimer);
			retryTimer = void 0;
		}
		discovery?.abort();
		discovery = void 0;
		closeSocket();
		lastProgress = void 0;
		lastDone = void 0;
		current = { state: "connecting" };
	}
	return {
		subscribe(listener) {
			listeners.add(listener);
			try {
				listener(stateEvent());
			} catch {}
			if (listeners.size === 1) {
				attempt = 0;
				connect();
			}
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				listeners.delete(listener);
				if (listeners.size === 0) teardown();
			};
		},
		stop() {
			stopped = true;
			unsubscribeRuns?.();
			listeners.clear();
			teardown();
		},
		status() {
			return {
				connected: current.state === "connected",
				...current.endpoint === void 0 ? {} : { endpoint: current.endpoint },
				...current.reason === void 0 ? {} : { reason: current.reason }
			};
		}
	};
}
/**
* ComfyUI's WebSocket URL for one endpoint.
*
* @param endpoint - e.g. `http://127.0.0.1:8188` (already loopback-checked).
* @param clientId - the socket id to register as.
* @returns `ws://host/ws?clientId=…` (or `wss://` for an https endpoint).
*/
function comfyWebSocketUrl(endpoint, clientId) {
	const base = new URL(endpoint);
	return `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}/ws?clientId=${encodeURIComponent(clientId)}`;
}
/** A non-array object, or `undefined`. */
function record$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/** A non-empty string, or `undefined`. */
function text(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
/** A finite number, or `undefined`. */
function number(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** Copy a stored run, so no caller can mutate what the map holds. */
function snapshot(run) {
	return {
		promptId: run.promptId,
		clientId: run.clientId,
		...run.boardId === void 0 ? {} : { boardId: run.boardId },
		registeredAt: run.registeredAt,
		...run.expiresAt === void 0 ? {} : { expiresAt: run.expiresAt }
	};
}
/**
* Create one in-memory run registry.
*
* @param options - TTL and clock overrides (both exist as test seams).
* @returns the registry; empty until something registers.
*/
function createRunRegistry(options = {}) {
	const ttlMs = Math.max(0, options.ttlMs ?? 3e5);
	const now = options.now ?? Date.now;
	const records = /* @__PURE__ */ new Map();
	const listeners = /* @__PURE__ */ new Set();
	/** True when a released record has reached its TTL. */
	function expired(run, at) {
		return run.expiresAt !== void 0 && at >= run.expiresAt;
	}
	/** Drop every expired record; returns how many are gone. */
	function sweep() {
		const at = now();
		let dropped = 0;
		for (const [promptId, run] of records) {
			if (!expired(run, at)) continue;
			records.delete(promptId);
			dropped += 1;
		}
		return dropped;
	}
	return {
		register(promptId, target) {
			if (promptId.length === 0 || target.clientId.length === 0) return void 0;
			sweep();
			const stored = {
				promptId,
				clientId: target.clientId,
				...target.boardId === void 0 ? {} : { boardId: target.boardId },
				registeredAt: now()
			};
			records.set(promptId, stored);
			const record = snapshot(stored);
			for (const listener of [...listeners]) try {
				listener(record);
			} catch {}
			return record;
		},
		lookup(promptId) {
			const run = records.get(promptId);
			if (run === void 0) return void 0;
			if (expired(run, now())) {
				records.delete(promptId);
				return;
			}
			return snapshot(run);
		},
		release(promptId) {
			const run = records.get(promptId);
			if (run === void 0) return false;
			run.expiresAt = now() + ttlMs;
			return true;
		},
		forget(promptId) {
			return records.delete(promptId);
		},
		sweep,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		size() {
			sweep();
			return records.size;
		}
	};
}
//#endregion
//#region src/boards.ts
/**
* Boards: the Studio's storage and display unit.
*
* A **board** is one project — a subject, a shoot, a batch of retouches. It owns
* a set of finished images and the arrangement those images were dragged into,
* so reopening the workbench restores the work rather than an empty canvas. The
* unit exists because the two front doors (the Agent tools and the panel) write
* into one flat `outputDir`: without a grouping above the file, "which of these
* 300 PNGs belong together" has no answer.
*
* ## Where it lives
*
* Under the configured `outputDir`, in a dot-directory the image writer never
* touches:
*
* ```text
* <outputDir>/.dsh-image-forge/
*   state.json          { "active": "b…" }   last board the panel had open
*   boards/<id>.json    one board, rewritten atomically
* ```
*
* One file per board instead of one growable index: a corrupt board costs that
* board, not the library, and a write never rewrites everybody's metadata. The
* list is a directory read — a few dozen small files, which is cheaper than
* keeping an index honest across two writers.
*
* ## Who writes
*
* - `tools.ts`, after a conversation call lands its PNGs. No `board` argument
*   means **a new board** named after the prompt; the id comes back in the tool
*   payload so the model can keep using it.
* - `studio-service.ts`, after a panel generation. No board means the active
*   board, else a new one.
* - `studio-view.ts`, for layout (node positions, camera) and removals.
*
* All three go through this module, so the two halves cannot disagree about
* what a board is. Writes are serialised per output directory: read-modify-write
* on one JSON file from two concurrent generations would otherwise lose the
* first one's items.
*
* @module boards
*/
/** Directory name under `outputDir` that holds every board artifact. */
const BOARDS_DIR_NAME = ".dsh-image-forge";
/** Most items one board may hold. */
const MAX_BOARD_ITEMS = 1e3;
/**
* The one older shape this module can still read: v1, whose items are all
* images and carry no `kind`.
*/
const BOARD_VERSION_V1 = 1;
/**
* Columns, pitch and origin of the grid an unplaced item lands on.
*
* `GRID_PITCH_X` is `MAX_NODE_WIDTH (480) + 36` (DD16, CANVAS-DESIGN §3.4): the
* grid is the fallback arrangement for items with no saved position, and a node
* is now as wide as its picture's aspect ratio allows, so the pitch has to clear
* the widest node instead of the 208 default box. Density on a first drop is
* worth less than never overlapping; the user's own arrangement takes over from
* the moment they drag a node.
*
* Mirrored in `src/studio-view.ts` (`fallbackSpot`), which keeps the same grid
* for a node whose stored position is missing — change both together.
*/
const GRID_COLUMNS = 3;
const GRID_PITCH_X = 516;
const GRID_PITCH_Y = 276;
const GRID_ORIGIN = 40;
/** Absolute path of the plugin's own state directory under `outputDir`. */
function boardsRoot(outputDir) {
	return join(outputDir, BOARDS_DIR_NAME);
}
/** Directory holding one JSON file per board. */
function boardsDir(outputDir) {
	return join(boardsRoot(outputDir), "boards");
}
/** State file remembering the board the panel had open. */
function stateFile(outputDir) {
	return join(boardsRoot(outputDir), "state.json");
}
/** One board's file path. */
function boardFile(outputDir, id) {
	assertBoardId(id);
	return join(boardsDir(outputDir), `${id}.json`);
}
/**
* Refuse any id that did not come from {@link newBoardId}.
*
* Board ids are always generated (`b` + base36 clock + base36 entropy), so the
* allow-list is strict and costs nothing legitimate. It is the single choke
* point in front of `join(boardsDir, \`${id}.json\`)`: without it, a crafted
* id like `../victim` read out of a hostile board file — or handed to the
* board route's `board` parameter — would walk the path out of the boards
* directory and turn reads and deletes into a filesystem oracle.
*/
function assertBoardId(id) {
	if (!/^[a-z0-9]{1,64}$/.test(id)) throw new Error(`boards: invalid board id "${id.slice(0, 40)}" — ids are generated, never accepted from callers`);
}
/**
* Per-directory write queues.
*
* Two generations can finish within the same millisecond (a panel run and a
* conversation run), and both do read-modify-write on one board file. Chaining
* the writes per directory is enough: the work is small and single-process, and
* a rejected task must not poison the chain, hence `.catch` on the stored tail.
*
* Shared with `output.ts`, which needs the same guarantee for its
* find-free-index-then-write sequence.
*/
const queues = /* @__PURE__ */ new Map();
function serialized(key, task) {
	const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
	queues.set(key, run.catch(() => void 0));
	return run;
}
/** Two-digit, zero-padded, for the fallback name. */
function pad(value) {
	return String(value).padStart(2, "0");
}
/** `画板 10-19 21:30` — the name a board gets when nothing suggests a better one. */
function defaultBoardName(now = /* @__PURE__ */ new Date()) {
	return `画板 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
/**
* A board name derived from the prompt that produced its first image.
*
* First non-empty line, whitespace collapsed, control characters dropped, cut
* to {@link BOARD_NAME_CHARS} **by code point** — slicing a surrogate pair in
* half would put a replacement character in every subsequent list render.
*
* @param prompt - the prompt the caller sent.
* @param now - clock override for the fallback name.
* @returns a non-empty, printable name.
*/
function nameFromPrompt(prompt, now = /* @__PURE__ */ new Date()) {
	const cut = [...(prompt.split(/[\r\n]+/).map((line) => line.trim()).find((line) => line.length > 0) ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()].slice(0, 39).join("").trim();
	return cut.length > 0 ? cut : defaultBoardName(now);
}
/**
* Make an arbitrary string safe to use as a board name.
*
* @param raw - the caller's name.
* @returns the printable name, or `undefined` when nothing usable survived.
*/
function sanitizeBoardName(raw) {
	if (typeof raw !== "string") return void 0;
	const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	if (cleaned.length === 0) return void 0;
	return [...cleaned].slice(0, 40).join("").trim() || void 0;
}
/** New board id: `b` + base36 clock + four random base36 chars. */
function newBoardId(taken) {
	for (;;) {
		const id = `b${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 4)}`;
		if (!taken(id)) return id;
	}
}
/** New item id; the `i` prefix keeps it distinguishable from a board id in logs. */
function makeItemId() {
	return `i${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}
/**
* Bring any board file this plugin understands up to {@link BOARD_VERSION}.
*
* **Pure**: no IO, no clock, and `raw` is never mutated — `readBoardFile` hands
* it the parsed JSON and the caller gets a board it can render. That purity is
* also what makes the lazy migration safe: reading a v1 board (listing the
* library, opening the panel) never writes to disk, so a read-only output
* directory stays usable and merely listing boards cannot rewrite a user's
* library. The upgraded shape reaches disk with the **next** write the user
* causes (record / save-layout / remove / rename), because every writer saves
* the board it just read.
*
* v1 → v2 is additive by construction: each item keeps every field it had
* (`id`, `x`/`y`, `parents`, `batchId`, …) and gains `kind:'image'`; the board
* keeps its name/camera/timestamps and gains `version:2`. Items that were
* invalid in v1 are still dropped one by one — a single bad entry must never
* hide the rest of the board (the loose-validation rule this module has always
* had).
*
* v2 is validated **by kind**: an image needs its three file strings (as
* before), a task needs a terminal status plus its params, a layout needs its
* draft. An unknown kind (a node type from a future version) drops that item
* only — forward compatible without storing data we cannot render.
*
* @param raw - parsed JSON of unknown shape.
* @returns the board at v2, or `undefined` when the file is unusable or written
*   by a version this module does not know (0, 3, missing — ignored whole, so a
*   downgrade can never rewrite a newer file with older semantics).
*/
function migrateBoardFile(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	if (record.version !== BOARD_VERSION_V1 && record.version !== 2) return void 0;
	if (typeof record.id !== "string" || typeof record.name !== "string") return void 0;
	if (!Array.isArray(record.items)) return void 0;
	const items = record.version === BOARD_VERSION_V1 ? record.items.filter(isBoardItem).map(toImageItem) : record.items.filter(isBoardItemV2);
	return {
		version: 2,
		id: record.id,
		name: record.name,
		createdAt: typeof record.createdAt === "string" ? record.createdAt : (/* @__PURE__ */ new Date(0)).toISOString(),
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : (/* @__PURE__ */ new Date(0)).toISOString(),
		sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
		camera: isCamera(record.camera) ? record.camera : null,
		items
	};
}
/** v1 item → v2 image node: the one field v1 did not have, everything else kept. */
function toImageItem(item) {
	return {
		...item,
		kind: "image"
	};
}
/** Parse one board file, returning `undefined` for anything malformed. */
async function readBoardFile(outputDir, id) {
	let raw;
	try {
		raw = await readFile(boardFile(outputDir, id), "utf8");
	} catch {
		return;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	return migrateBoardFile(parsed);
}
function isCamera(value) {
	if (typeof value !== "object" || value === null) return false;
	const camera = value;
	return [
		"x",
		"y",
		"zoom"
	].every((key) => typeof camera[key] === "number" && Number.isFinite(camera[key]));
}
/**
* v1 item validation: loose, and only about the fields the store itself needs.
*
* Kept verbatim as the v1 rule (id + two path strings): the migration must
* accept exactly what the previous release accepted, or an upgrade would
* silently drop entries the user could still see yesterday.
*/
function isBoardItem(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	return typeof item.id === "string" && typeof item.path === "string" && typeof item.markdownPath === "string";
}
/**
* v2 item validation: branch on `kind`.
*
* Every kind needs an `id` (it is the node's identity and the layout-save key).
* `path`/`markdownPath` are required for images only — a task node has no file
* (the run failed) and a layout node has a draft instead — so the old
* "three strings" rule would reject both. An absent `kind` counts as `image`,
* which keeps a hand-edited or tool-written v2 file readable.
*/
function isBoardItemV2(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	if (typeof item.id !== "string") return false;
	const kind = item.kind ?? "image";
	if (kind === "image") return typeof item.path === "string" && typeof item.markdownPath === "string";
	if (kind === "task") return isTaskItem(item);
	if (kind === "layout") return isLayoutItem(item);
	return false;
}
/** A task node is storable only once terminal, with the request it came from. */
function isTaskItem(item) {
	const task = item.task;
	if (typeof task !== "object" || task === null) return false;
	const record = task;
	if (record.status !== "failed" && record.status !== "interrupted") return false;
	return typeof record.params === "object" && record.params !== null;
}
/** A layout node is its draft: without one there is nothing to show or edit. */
function isLayoutItem(item) {
	const draft = item.draft;
	if (typeof draft !== "object" || draft === null) return false;
	const record = draft;
	if (!Number.isFinite(record.width) || !Number.isFinite(record.height)) return false;
	return Array.isArray(record.items);
}
/** Summary projection, so a list request never carries every prompt. */
function summarize(board) {
	const newest = [...board.items].reverse().find((item) => (item.kind ?? "image") === "image" && typeof item.markdownPath === "string" && item.markdownPath.length > 0);
	let bytes = 0;
	let imageCount = 0;
	for (const item of board.items) {
		if ((item.kind ?? "image") === "image") imageCount += 1;
		if (typeof item.bytes === "number" && Number.isFinite(item.bytes) && item.bytes > 0) bytes += item.bytes;
	}
	return {
		id: board.id,
		name: board.name,
		itemCount: board.items.length,
		imageCount,
		bytes,
		cover: newest === void 0 ? null : newest.markdownPath,
		createdAt: board.createdAt,
		updatedAt: board.updatedAt,
		sessionId: board.sessionId
	};
}
/** Detail projection for one board. */
function detail(board) {
	return {
		...summarize(board),
		items: board.items,
		camera: board.camera
	};
}
/**
* Every board under `outputDir`, newest first.
*
* Unreadable or version-mismatched files are skipped silently: a board written
* by a future version must not make the whole library unopenable.
*
* @param outputDir - the configured output directory.
* @returns summaries, newest `updatedAt` first.
*/
async function listBoards(outputDir) {
	let names;
	try {
		names = await readdir(boardsDir(outputDir));
	} catch {
		return [];
	}
	const files = names.filter((name) => name.endsWith(".json"));
	return (await Promise.all(files.map((name) => readBoardFile(outputDir, name.slice(0, -5))))).filter((board) => board !== void 0).map(summarize).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 200);
}
/**
* One board in full.
*
* @param outputDir - the configured output directory.
* @param id - board id.
* @returns the board, or `undefined` when it is gone or unreadable.
*/
async function readBoard(outputDir, id) {
	const board = await readBoardFile(outputDir, id);
	return board === void 0 ? void 0 : detail(board);
}
/** The board the panel last had open, or `null` when none was recorded. */
async function activeBoardId(outputDir) {
	try {
		const parsed = JSON.parse(await readFile(stateFile(outputDir), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const active = parsed.active;
		return typeof active === "string" && active.length > 0 ? active : null;
	} catch {
		return null;
	}
}
/**
* Remember which board the panel has open.
*
* Best-effort: a read-only output directory must not stop the workbench from
* rendering, so a failed write is swallowed and reported as `false`.
*
* @param outputDir - the configured output directory.
* @param id - board id, or `null` to clear.
* @returns whether the state file was written.
*/
async function setActiveBoard(outputDir, id) {
	return serialized(boardsRoot(outputDir), async () => {
		try {
			await mkdir(boardsRoot(outputDir), { recursive: true });
			await writeAtomic(stateFile(outputDir), JSON.stringify({ active: id }));
			return true;
		} catch {
			return false;
		}
	});
}
/**
* Path of the workbench's `workspace.json` (U02, shell design §4.2).
*
* A sibling of `state.json`, not a replacement: `state.json` keeps its `active`
* meaning for the server's default-board logic (§4.4, WD4).
*/
function workspaceFile(outputDir) {
	return join(boardsRoot(outputDir), "workspace.json");
}
/**
* Read `workspace.json` verbatim, or `undefined` when there is none.
*
* Deliberately untyped and unnormalised: the codec in `workbench-tabs.ts` owns
* every degradation rule (§4.3), and a read must never write — the workspace is
* only rewritten after the user actually changes a tab (§4.3 point 1).
*
* @param outputDir - the configured output directory.
* @returns the parsed document, or `undefined` for missing/unreadable/broken.
*/
async function readWorkspaceFile(outputDir) {
	try {
		return JSON.parse(await readFile(workspaceFile(outputDir), "utf8"));
	} catch {
		return;
	}
}
/**
* Replace `workspace.json` atomically, serialised against the other writers.
*
* Best-effort like {@link setActiveBoard}: a read-only output directory must not
* break the shell, so a failed write is reported as `false` rather than thrown.
*
* @param outputDir - the configured output directory.
* @param workspace - the already-normalised document (§4.2).
* @returns whether the file was written.
*/
async function writeWorkspaceFile(outputDir, workspace) {
	return serialized(boardsRoot(outputDir), async () => {
		try {
			await mkdir(boardsRoot(outputDir), { recursive: true });
			await writeAtomic(workspaceFile(outputDir), JSON.stringify(workspace));
			return true;
		} catch {
			return false;
		}
	});
}
/** Write through a staging file so a crash never leaves half a JSON document. */
async function writeAtomic(target, body) {
	const staging = `${target}.partial-${String(process.pid)}-${randomUUID().slice(0, 4)}`;
	await writeFile(staging, body, "utf8");
	try {
		await rename(staging, target);
	} catch (error) {
		await unlink(staging).catch(() => void 0);
		throw error;
	}
}
async function saveBoard(outputDir, board) {
	await mkdir(boardsDir(outputDir), { recursive: true });
	await writeAtomic(boardFile(outputDir, board.id), JSON.stringify(board));
}
/**
* Find a board by id or name, creating it when neither matches.
*
* Resolution order matters for the conversation path: a model that was handed
* an id sends the id back; a model that was handed a name sends the name. An
* unknown value is treated as a **name for a new board** rather than an error,
* because refusing here would fail a generation the user already paid for.
*
* @param outputDir - the configured output directory.
* @param ref - board id or name; blank means "create one".
* @param meta - fields for a board that has to be created.
* @returns the board summary, whether it was created, and its full file.
*/
async function ensureBoardLocked(outputDir, ref, meta) {
	const wanted = typeof ref === "string" ? ref.trim() : "";
	const existing = await listBoardFiles(outputDir);
	if (wanted.length > 0) {
		const byId = existing.find((board) => board.id === wanted);
		if (byId !== void 0) return {
			board: byId,
			created: false
		};
		const lower = wanted.toLowerCase();
		const byName = existing.find((board) => board.name.toLowerCase() === lower);
		if (byName !== void 0) return {
			board: byName,
			created: false
		};
	}
	if (existing.length >= 200) return {
		board: [...existing].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0],
		created: false
	};
	const now = /* @__PURE__ */ new Date();
	const name = sanitizeBoardName(meta.name) ?? sanitizeBoardName(wanted) ?? (typeof meta.prompt === "string" && meta.prompt.trim().length > 0 ? nameFromPrompt(meta.prompt, now) : defaultBoardName(now));
	const board = {
		version: 2,
		id: newBoardId((candidate) => existing.some((board) => board.id === candidate)),
		name,
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		sessionId: meta.sessionId ?? null,
		camera: null,
		items: []
	};
	await saveBoard(outputDir, board);
	return {
		board,
		created: true
	};
}
/** Every board file, for id/name matching inside a locked section. */
async function listBoardFiles(outputDir) {
	let names;
	try {
		names = await readdir(boardsDir(outputDir));
	} catch {
		return [];
	}
	return (await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readBoardFile(outputDir, name.slice(0, -5))))).filter((board) => board !== void 0);
}
/**
* Record one run's images on a board, creating the board when needed.
*
* The dedupe key is the **absolute path**, which is unique by construction
* (`<prefix>_<W>x<H>_<n>.png` with a free index): re-recording the same run
* updates its metadata instead of growing a second copy, which is what makes
* the write idempotent for a retried tool call.
*
* @param outputDir - the configured output directory.
* @param ref - board id, board name, or blank to create a new board.
* @param items - images to record, in output order.
* @param meta - name/session hints used only when a board is created.
* @returns the board summary plus the recorded items.
*/
async function recordItems(outputDir, ref, items, meta = {}) {
	return serialized(boardsRoot(outputDir), async () => {
		const { board, created } = await ensureBoardLocked(outputDir, ref, meta);
		const written = [];
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const batchId = items[0]?.batchId ?? `g${Date.now().toString(36)}`;
		for (const incoming of items) {
			const existingIndex = board.items.findIndex((item) => item.path === incoming.path);
			const next = {
				id: existingIndex >= 0 ? board.items[existingIndex].id : incoming.id ?? makeItemId(),
				kind: "image",
				path: incoming.path,
				markdownPath: incoming.markdownPath,
				width: incoming.width,
				height: incoming.height,
				bytes: incoming.bytes,
				mediaType: incoming.mediaType,
				prompt: incoming.prompt,
				ratio: incoming.ratio ?? null,
				steps: incoming.steps ?? null,
				seed: incoming.seed ?? null,
				mode: incoming.mode ?? "generate",
				backend: incoming.backend ?? null,
				parents: resolveParents(board.items, incoming),
				createdAt: existingIndex >= 0 ? board.items[existingIndex].createdAt : now,
				sessionId: incoming.sessionId ?? board.sessionId,
				batchId: incoming.batchId ?? batchId,
				x: incoming.x ?? (existingIndex >= 0 ? board.items[existingIndex].x : gridSpot(board.items.length).x),
				y: incoming.y ?? (existingIndex >= 0 ? board.items[existingIndex].y : gridSpot(board.items.length).y)
			};
			if (existingIndex >= 0) board.items[existingIndex] = next;
			else board.items.push(next);
			written.push(next);
		}
		if (board.items.length > 1e3) board.items = board.items.slice(board.items.length - MAX_BOARD_ITEMS);
		board.updatedAt = now;
		if (meta.sessionId !== void 0 && board.sessionId === null) board.sessionId = meta.sessionId;
		await saveBoard(outputDir, board);
		return {
			board: summarize(board),
			created,
			items: written
		};
	});
}
/** Grid slot for the nth unplaced item. */
function gridSpot(index) {
	return {
		x: GRID_ORIGIN + index % GRID_COLUMNS * GRID_PITCH_X,
		y: GRID_ORIGIN + Math.floor(index / GRID_COLUMNS) * GRID_PITCH_Y
	};
}
/**
* Case- and separator-insensitive path key.
*
* Windows reports one file as both `C:\\x\\a.png` and `C:/x/a.png`, and the
* shared-file guard must treat a copied item's `path` as the same file as its
* source's. Parent resolution already applied the same rule.
*/
function pathKey(value) {
	return value.replace(/\\/g, "/").toLowerCase();
}
/**
* Resolve `parentPaths` into item ids of **this board**.
*
* Matching is separator- and case-insensitive (Windows reports the same file
* with either), so the caller can pass the reference path exactly as it was
* handed to the tool. Explicit `parents` ids win when given; paths that match
* nothing are dropped without ceremony — see {@link NewBoardItem.parentPaths}.
*/
function resolveParents(existing, incoming) {
	if (incoming.parents !== void 0) return [...incoming.parents];
	const paths = incoming.parentPaths ?? [];
	if (paths.length === 0) return [];
	const byPath = new Map(existing.map((item) => [pathKey(item.path), item.id]));
	const ids = [];
	for (const path of paths) {
		const id = byPath.get(pathKey(path));
		if (id !== void 0 && !ids.includes(id)) ids.push(id);
	}
	return ids;
}
/**
* Persist where the user dragged the nodes, and the camera.
*
* Unknown ids are ignored: a node can be removed in another tab between the
* drag and the save, and that must not fail the whole write.
*
* @param outputDir - the configured output directory.
* @param id - board id.
* @param layout - positions keyed by item id, plus the optional camera.
* @returns the updated summary, or `undefined` when the board is gone.
*/
async function saveLayout(outputDir, id, layout) {
	return serialized(boardsRoot(outputDir), async () => {
		const board = await readBoardFile(outputDir, id);
		if (board === void 0) return void 0;
		const positions = new Map((layout.items ?? []).map((entry) => [entry.id, entry]));
		for (const item of board.items) {
			const spot = positions.get(item.id);
			if (spot === void 0) continue;
			if (!Number.isFinite(spot.x) || !Number.isFinite(spot.y)) continue;
			item.x = spot.x;
			item.y = spot.y;
			if (spot.parents !== void 0 && spot.parents.length > 0) {
				const merged = [...item.parents];
				for (const parent of spot.parents) if (!merged.includes(parent)) merged.push(parent);
				item.parents = merged;
			}
		}
		if (layout.camera !== void 0) board.camera = isCamera(layout.camera) ? layout.camera : null;
		board.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		await saveBoard(outputDir, board);
		return summarize(board);
	});
}
/** A fresh id that no item on `board` uses. */
function unusedItemId(board) {
	const taken = new Set(board.items.map((item) => item.id));
	let id = makeItemId();
	while (taken.has(id)) id = makeItemId();
	return id;
}
/** Cap a destination board the way `recordItems` does, dropping the oldest. */
function capItems(board) {
	if (board.items.length > 1e3) board.items = board.items.slice(board.items.length - MAX_BOARD_ITEMS);
}
/**
* Copy one item onto another board (§7.2).
*
* The copy gets a **new id** (ids are board-scoped) but keeps the file path,
* metadata and `parents` verbatim: the lineage travels with the picture, and a
* parent id that does not resolve on the destination is simply not drawn — the
* same "a missing edge never fails the write" rule `resolveParents` uses. The
* PNG is **not** copied, so both boards now share one file; that is exactly why
* {@link removeItem}'s `deleteFile` grew the shared-reference guard.
*
* @param outputDir - the configured output directory.
* @param id - source board id.
* @param itemId - item to copy.
* @param toBoard - destination board id.
* @param spot - landing position; omitted means the destination grid.
* @returns the copied item and the destination summary, or `undefined` when a
*   board or the item does not exist.
*/
async function copyItem(outputDir, id, itemId, toBoard, spot) {
	return serialized(boardsRoot(outputDir), async () => {
		const source = await readBoardFile(outputDir, id);
		if (source === void 0) return void 0;
		const original = source.items.find((item) => item.id === itemId);
		if (original === void 0) return void 0;
		if (id === toBoard) {
			const clone = {
				...original,
				id: unusedItemId(source),
				x: spot?.x ?? gridSpot(source.items.length).x,
				y: spot?.y ?? gridSpot(source.items.length).y
			};
			source.items.push(clone);
			capItems(source);
			source.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
			await saveBoard(outputDir, source);
			return {
				item: clone,
				board: summarize(source)
			};
		}
		const target = await readBoardFile(outputDir, toBoard);
		if (target === void 0) return void 0;
		const clone = {
			...original,
			id: unusedItemId(target),
			x: spot?.x ?? gridSpot(target.items.length).x,
			y: spot?.y ?? gridSpot(target.items.length).y
		};
		target.items.push(clone);
		capItems(target);
		target.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		await saveBoard(outputDir, target);
		return {
			item: clone,
			board: summarize(target)
		};
	});
}
/**
* Move one item onto another board (§7.2), keeping its id.
*
* Cross-board writes cannot be atomic on two JSON files, so the order is
* chosen for the failure mode: **destination first, source second**. A crash
* between the two leaves the item on both boards (a copy), never on neither;
* that is the documented downgrade from §7.2's stop condition.
*
* @param outputDir - the configured output directory.
* @param id - source board id.
* @param itemId - item to move.
* @param toBoard - destination board id.
* @param spot - landing position; omitted means the destination grid.
* @returns the moved item and the destination summary, or `undefined`.
*/
async function moveItem(outputDir, id, itemId, toBoard, spot) {
	return serialized(boardsRoot(outputDir), async () => {
		const source = await readBoardFile(outputDir, id);
		if (source === void 0) return void 0;
		const index = source.items.findIndex((item) => item.id === itemId);
		if (index < 0) return void 0;
		if (id === toBoard) {
			const only = source.items[index];
			if (spot !== void 0) {
				only.x = spot.x;
				only.y = spot.y;
			}
			source.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
			await saveBoard(outputDir, source);
			return {
				item: only,
				board: summarize(source)
			};
		}
		const target = await readBoardFile(outputDir, toBoard);
		if (target === void 0) return void 0;
		const [moving] = source.items.splice(index, 1);
		const collision = target.items.some((item) => item.id === moving.id);
		const item = {
			...moving,
			...collision ? { id: unusedItemId(target) } : {},
			x: spot?.x ?? gridSpot(target.items.length).x,
			y: spot?.y ?? gridSpot(target.items.length).y
		};
		target.items.push(item);
		capItems(target);
		target.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		await saveBoard(outputDir, target);
		source.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		await saveBoard(outputDir, source);
		return {
			item,
			board: summarize(target)
		};
	});
}
/** Refuse anything the read side would drop anyway, with a message the panel can show. */
function assertTerminalTask(task) {
	if (task.status !== "failed" && task.status !== "interrupted") throw new Error("task.status 只能是 failed 或 interrupted——运行中的任务不落盘（DD6）");
	if (typeof task.params !== "object" || task.params === null || typeof task.params.prompt !== "string") throw new Error("task.params 必须是带 prompt 的请求快照");
	if (task.error !== void 0 && typeof task.error !== "string") throw new Error("task.error 必须是字符串");
}
/** Mirror the read side's layout check so a stored draft is always reopenable. */
function assertLayoutDraft(draft, w, h) {
	if (typeof draft !== "object" || draft === null) throw new Error("draft 必须是对象");
	if (!Number.isFinite(draft.width) || draft.width <= 0 || !Number.isFinite(draft.height) || draft.height <= 0) throw new Error("draft.width / draft.height 必须是正数");
	if (!Array.isArray(draft.items)) throw new Error("draft.items 必须是数组");
	if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) throw new Error("w / h 必须是正数");
}
/**
* Store one terminal task node (§4.6, C14).
*
* Running tasks are deliberately not storable: a reload must never show a node
* that claims to be generating a run whose result has already been recorded.
* Only a failure/interrupt is bookkeeping with value — the user can see why
* yesterday's run failed and retry it from the same canvas position.
*
* @param outputDir - the configured output directory.
* @param ref - board id/name, or blank for a new board (the canvas may not have
*   one yet when a task fails before its first picture).
* @param entry - the terminal state, position and request snapshot.
* @returns the stored item and the board, or `undefined` when the board is gone.
*/
async function saveTaskItem(outputDir, ref, entry) {
	assertTerminalTask(entry.task);
	return serialized(boardsRoot(outputDir), async () => {
		const { board } = await ensureBoardLocked(outputDir, ref, {});
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const index = entry.id === void 0 ? -1 : board.items.findIndex((item) => item.id === entry.id);
		const existing = index < 0 ? void 0 : board.items[index];
		const spot = gridSpot(board.items.length);
		const requestedId = typeof entry.id === "string" && entry.id.length > 0 && !board.items.some((item) => item.id === entry.id) ? entry.id : void 0;
		const item = {
			id: existing?.id ?? requestedId ?? makeItemId(),
			kind: "task",
			path: "",
			markdownPath: "",
			width: 0,
			height: 0,
			bytes: 0,
			mediaType: "",
			prompt: "",
			ratio: null,
			steps: null,
			seed: null,
			mode: "generate",
			backend: "studio",
			parents: [...entry.parents ?? existing?.parents ?? []],
			createdAt: existing?.createdAt ?? now,
			sessionId: entry.sessionId ?? board.sessionId,
			batchId: existing?.batchId ?? "t" + Date.now().toString(36),
			x: entry.x ?? existing?.x ?? spot.x,
			y: entry.y ?? existing?.y ?? spot.y,
			task: entry.task
		};
		if (index >= 0) board.items[index] = item;
		else board.items.push(item);
		capItems(board);
		board.updatedAt = now;
		await saveBoard(outputDir, board);
		return {
			item,
			board: summarize(board)
		};
	});
}
/**
* Store one layout node's draft and display box (§8.1, C14).
*
* The draft is stored verbatim (pixels are independent of the display size —
* that is the §8.2 invariant), so resizing a node and reopening the board never
* changes what a later generation would compile.
*
* @param outputDir - the configured output directory.
* @param ref - board id/name, or blank for a new board.
* @param entry - draft, display size, position and parents.
* @returns the stored item and the board, or `undefined` when the board is gone.
*/
async function saveLayoutItem(outputDir, ref, entry) {
	assertLayoutDraft(entry.draft, entry.w, entry.h);
	return serialized(boardsRoot(outputDir), async () => {
		const { board } = await ensureBoardLocked(outputDir, ref, {});
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const index = entry.id === void 0 ? -1 : board.items.findIndex((item) => item.id === entry.id);
		const existing = index < 0 ? void 0 : board.items[index];
		const spot = gridSpot(board.items.length);
		const requestedId = typeof entry.id === "string" && entry.id.length > 0 && !board.items.some((item) => item.id === entry.id) ? entry.id : void 0;
		const item = {
			id: existing?.id ?? requestedId ?? makeItemId(),
			kind: "layout",
			path: "",
			markdownPath: "",
			width: 0,
			height: 0,
			bytes: 0,
			mediaType: "",
			prompt: "",
			ratio: null,
			steps: null,
			seed: null,
			mode: "generate",
			backend: "studio",
			parents: [...entry.parents ?? existing?.parents ?? []],
			createdAt: existing?.createdAt ?? now,
			sessionId: entry.sessionId ?? board.sessionId,
			batchId: existing?.batchId ?? "l" + Date.now().toString(36),
			x: entry.x ?? existing?.x ?? spot.x,
			y: entry.y ?? existing?.y ?? spot.y,
			draft: entry.draft,
			w: entry.w,
			h: entry.h
		};
		if (index >= 0) board.items[index] = item;
		else board.items.push(item);
		capItems(board);
		board.updatedAt = now;
		await saveBoard(outputDir, board);
		return {
			item,
			board: summarize(board)
		};
	});
}
/** True when `target` is the root itself or lives under it. */
function isInside(root, target) {
	if (!isAbsolute(target)) return false;
	const rel = relative(resolve(root), resolve(target));
	if (rel.length === 0) return true;
	return !rel.startsWith("..") && !isAbsolute(rel);
}
/**
* Drop one item from a board's arrangement.
*
* Deleting the file is opt-in and doubly guarded: the path must be inside
* `outputDir` (so a crafted board file cannot delete anything else) and the
* caller must have asked. The default is "remove from the board", which is the
* reversible action and the one the canvas button offers.
*
* @param outputDir - the configured output directory.
* @param id - board id.
* @param itemId - item to drop.
* @param options - `deleteFile` also removes the PNG from disk, but only when
*   no other board still points at the same file (see below).
* @returns what happened, or `undefined` when the board or item is gone. When
*   `deleteFile` was asked but the file is shared, `fileDeleted` is false and
*   `sharedWith` names the boards that still use it.
*/
async function removeItem(outputDir, id, itemId, options = {}) {
	return serialized(boardsRoot(outputDir), async () => {
		const board = await readBoardFile(outputDir, id);
		if (board === void 0) return void 0;
		const index = board.items.findIndex((item) => item.id === itemId);
		if (index < 0) return void 0;
		const [removed] = board.items.splice(index, 1);
		board.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		await saveBoard(outputDir, board);
		let fileDeleted = false;
		const sharedWith = [];
		if (options.deleteFile === true && typeof removed.path === "string" && removed.path.length > 0 && isInside(outputDir, removed.path)) {
			const key = pathKey(removed.path);
			for (const other of await listBoardFiles(outputDir)) {
				if (other.id === board.id) continue;
				if (other.items.some((entry) => pathKey(entry.path) === key)) sharedWith.push(other.id);
			}
			if (sharedWith.length === 0) try {
				await unlink(removed.path);
				fileDeleted = true;
			} catch {
				fileDeleted = false;
			}
		}
		return {
			removed,
			fileDeleted,
			sharedWith
		};
	});
}
/**
* Delete a board, optionally with the pictures it owns (§5.4).
*
* Two modes, and the default is the recoverable one: without `deleteFiles` this
* is the old {@link deleteBoard} — metadata only, every PNG still on disk.
*
* With `deleteFiles`, every picture the board points at is unlinked **subject to
* the same shared-reference guard `removeItem` has**: `copy-item` and
* `duplicateBoard` make two boards share one file, and unlinking it would blank
* the picture on the surviving project. Such a file is counted in `filesKept`
* and left alone. Paths outside `outputDir` are never touched (a crafted board
* file must not turn "delete my project" into a filesystem oracle), which is the
* same rule and the same helper.
*
* Order: metadata first, then files. A crash in between leaves orphan PNGs —
* reachable from the asset page's copy-path, and harmless — whereas the reverse
* order would leave a board full of broken thumbnails.
*
* @param outputDir - the configured output directory.
* @param id - board id.
* @param options - `deleteFiles` also unlinks the pictures (guarded, above).
* @returns what happened; an unknown or unusable id reports `removed: false`
*   rather than throwing (an id from a stale panel is not an error).
*/
async function removeBoard(outputDir, id, options = {}) {
	return serialized(boardsRoot(outputDir), async () => {
		let doomed;
		try {
			doomed = await readBoardFile(outputDir, id);
		} catch {
			return {
				removed: false,
				filesDeleted: 0,
				filesKept: 0
			};
		}
		let removed = false;
		try {
			await unlink(boardFile(outputDir, id));
			removed = true;
		} catch {
			return {
				removed: false,
				filesDeleted: 0,
				filesKept: 0
			};
		}
		if (options.deleteFiles !== true || doomed === void 0) return {
			removed,
			filesDeleted: 0,
			filesKept: 0
		};
		const wanted = /* @__PURE__ */ new Map();
		for (const item of doomed.items) {
			if (typeof item.path !== "string" || item.path.length === 0) continue;
			if (!isInside(outputDir, item.path)) continue;
			const key = pathKey(item.path);
			if (!wanted.has(key)) wanted.set(key, item.path);
		}
		let filesDeleted = 0;
		let filesKept = 0;
		if (wanted.size === 0) return {
			removed,
			filesDeleted,
			filesKept
		};
		const others = await listBoardFiles(outputDir);
		for (const [key, path] of wanted) {
			if (others.some((other) => other.id !== id && other.items.some((item) => pathKey(item.path) === key))) {
				filesKept += 1;
				continue;
			}
			try {
				await unlink(path);
				filesDeleted += 1;
			} catch {
				filesKept += 1;
			}
		}
		return {
			removed,
			filesDeleted,
			filesKept
		};
	});
}
/**
* Create an empty board.
*
* @param outputDir - the configured output directory.
* @param name - the name to use; blank means the date-stamped fallback.
* @returns the new board's summary.
*/
async function createBoard(outputDir, name) {
	return serialized(boardsRoot(outputDir), async () => {
		const { board } = await ensureBoardLocked(outputDir, void 0, { name });
		return summarize(board);
	});
}
/**
* Default name of a copied board: `<原名> 副本` (§5.3).
*
* The suffix counts against {@link BOARD_NAME_CHARS}, so the prefix is cut by
* **code point** to leave room for ` 副本` — a name at the cap would otherwise be
* truncated to `… 副` and read like a typo. Pure, so the panel and the store
* agree about what a copy is called.
*
* @param name - the source board's name.
* @returns a name that fits the cap and is never empty.
*/
function duplicateBoardName(name) {
	const room = 40 - [..." 副本"].length;
	const cut = [...name].slice(0, room).join("").trim();
	return `${cut.length > 0 ? cut : "画板"} 副本`;
}
/**
* Copy a whole board: its entries, their arrangement and their lineage (§5.3).
*
* The pictures are **not** copied — every item keeps its `path`/`markdownPath`,
* so the two boards share one file on disk. That is the same semantics
* `copyItem` has (§7.2) and the reason {@link removeBoard}'s file mode refuses to
* unlink a shared file.
*
* Ids are board-scoped, so the copy mints a fresh id per item and rewrites
* `parents` through that map: a lineage edge must point at the *copy's* nodes, or
* the canvas would draw it nowhere. A parent id the map does not know is dropped
* and counted in {@link BoardDuplicate.droppedParents}.
*
* Coordinates (`x`/`y`) and every piece of provenance (prompt, seed, ratio,
* batch, `createdAt`, session) travel with the item; only the board-level clock
* is fresh. The camera is copied too — the copy opens looking the way the
* original did.
*
* @param outputDir - the configured output directory.
* @param id - source board id.
* @param name - the copy's name; blank means `<原名> 副本`.
* @returns the copy, or `undefined` when the source board is gone.
* @throws When the library is already at {@link MAX_BOARDS} — a copy is an
*   explicit user action, so it is refused by name instead of silently
*   overwriting somebody else's board the way a generation would.
*/
async function duplicateBoard(outputDir, id, name) {
	return serialized(boardsRoot(outputDir), async () => {
		const source = await readBoardFile(outputDir, id);
		if (source === void 0) return void 0;
		const existing = await listBoardFiles(outputDir);
		if (existing.length >= 200) throw new Error(`画板数量已达上限 ${String(200)}，请先删除一个项目再复制`);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const taken = /* @__PURE__ */ new Set();
		const remap = /* @__PURE__ */ new Map();
		for (const item of source.items) {
			let next = makeItemId();
			while (taken.has(next)) next = makeItemId();
			taken.add(next);
			remap.set(item.id, next);
		}
		let droppedParents = 0;
		const items = source.items.map((item) => {
			const parents = [];
			for (const parent of item.parents ?? []) {
				const mapped = remap.get(parent);
				if (mapped === void 0) {
					droppedParents += 1;
					continue;
				}
				if (!parents.includes(mapped)) parents.push(mapped);
			}
			return {
				...item,
				id: remap.get(item.id),
				parents
			};
		});
		const copy = {
			version: 2,
			id: newBoardId((candidate) => existing.some((board) => board.id === candidate)),
			name: sanitizeBoardName(name) ?? duplicateBoardName(source.name),
			createdAt: now,
			updatedAt: now,
			sessionId: source.sessionId,
			camera: source.camera === null ? null : { ...source.camera },
			items
		};
		capItems(copy);
		await saveBoard(outputDir, copy);
		return {
			board: summarize(copy),
			items: copy.items,
			droppedParents
		};
	});
}
/**
* Rename a board.
*
* @param outputDir - the configured output directory.
* @param id - board id.
* @param name - the new name; a blank one leaves the board untouched.
* @returns the updated summary, or `undefined` when the board is gone.
*/
async function renameBoard(outputDir, id, name) {
	const clean = sanitizeBoardName(name);
	if (clean === void 0) return void 0;
	return serialized(boardsRoot(outputDir), async () => {
		const board = await readBoardFile(outputDir, id);
		if (board === void 0) return void 0;
		board.name = clean;
		board.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		await saveBoard(outputDir, board);
		return summarize(board);
	});
}
/**
* Flatten every board into one asset list, newest first.
*
* The asset page asks one question — "where is that image I made" — and that
* question spans boards, so filtering happens here rather than in the panel
* making N requests.
*
* @param outputDir - the configured output directory.
* @param query - optional board filter, free text and limit.
* @returns matching assets, the board list, and the pre-limit total.
*/
async function listAssets(outputDir, query = {}) {
	const boards = await listBoardFiles(outputDir);
	const summaries = boards.map(summarize).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	const boardFilter = typeof query.board === "string" && query.board.trim().length > 0 ? query.board.trim() : void 0;
	const needle = typeof query.q === "string" ? query.q.trim().toLowerCase() : "";
	const limit = Number.isFinite(query.limit) ? Math.min(500, Math.max(1, Math.trunc(query.limit))) : 200;
	const assets = [];
	for (const board of boards) {
		if (boardFilter !== void 0 && board.id !== boardFilter) continue;
		for (const item of board.items) {
			if ((item.kind ?? "image") !== "image") continue;
			if (needle.length > 0) {
				if (!`${item.prompt}\n${item.path}\n${board.name}`.toLowerCase().includes(needle)) continue;
			}
			assets.push({
				...item,
				boardId: board.id,
				boardName: board.name
			});
		}
	}
	assets.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	return {
		assets: assets.slice(0, limit),
		boards: summaries,
		total: assets.length
	};
}
/** The single tab that is always present, always leftmost and never closable (§3.1). */
const PROJECTS_TAB = "projects";
/** The three detail kinds a `node:` tab can carry (§8.2; `§4.2` `kind`). */
const NODE_DETAIL_KINDS = [
	"layout",
	"task",
	"image"
];
/** Key of a board's canvas tab. */
function canvasTabKey(boardId) {
	return `canvas:${boardId}`;
}
/** Key of a node detail tab. */
function nodeTabKey(boardId, itemId) {
	return `node:${boardId}:${itemId}`;
}
/**
* Decompose a tab key.
*
* Tolerant on purpose: anything that is not one of the three shapes — a stale
* key from an older build, a hand-edited `workspace.json`, a `null` from JSON —
* returns `null` instead of throwing. §3.3's "invalid" tab state and §4.3's
* "drop unknown key shapes" both hinge on this not exploding.
*/
function parseTabKey(key) {
	if (typeof key !== "string") return null;
	if (key === "projects") return {
		kind: "projects",
		key
	};
	const parts = key.split(":");
	if (parts.length === 2 && parts[0] === "canvas" && parts[1].length > 0) return {
		kind: "canvas",
		key,
		boardId: parts[1]
	};
	if (parts.length === 3 && parts[0] === "node" && parts[1].length > 0 && parts[2].length > 0) return {
		kind: "node",
		key,
		boardId: parts[1],
		itemId: parts[2]
	};
	return null;
}
/** The state a fresh workspace starts in: one projects tab, nothing else (§3.1). */
function emptyState() {
	return {
		tabOrder: [PROJECTS_TAB],
		activeTab: PROJECTS_TAB,
		nodeKinds: {},
		recentProjects: [],
		selections: {}
	};
}
/** The open canvas boards, in strip order — `workspace.json`'s `openProjects` (§4.2). */
function openBoardIds(state) {
	const ids = [];
	for (const key of state.tabOrder) {
		const ref = parseTabKey(key);
		if (ref !== null && ref.kind === "canvas") ids.push(ref.boardId);
	}
	return ids;
}
/** Every strip entry in order, with the parts a renderer needs (§3.1/§8.2). */
function listTabs(state) {
	const openBoards = new Set(openBoardIds(state));
	const tabs = [];
	for (const key of state.tabOrder) {
		const ref = parseTabKey(key);
		if (ref === null) continue;
		if (ref.kind === "projects") tabs.push({
			key,
			kind: "projects",
			orphaned: false
		});
		else if (ref.kind === "canvas") tabs.push({
			key,
			kind: "canvas",
			boardId: ref.boardId,
			orphaned: false
		});
		else tabs.push({
			key,
			kind: "node",
			boardId: ref.boardId,
			itemId: ref.itemId,
			detailKind: state.nodeKinds[key] ?? "task",
			orphaned: !openBoards.has(ref.boardId)
		});
	}
	return tabs;
}
/** Whether `kind` is one of {@link NODE_DETAIL_KINDS} — used on untrusted JSON. */
function isNodeDetailKind(kind) {
	return typeof kind === "string" && NODE_DETAIL_KINDS.includes(kind);
}
/**
* Repair `tabOrder` against the set of tabs that must exist (§4.3).
*
* Used on the read path only: `workspace.json` stores the order *and* the open
* sets, and they can disagree after a crash. The rule is §4.3's — `projects`
* first, surviving keys in their original relative order, then whatever is
* missing appended — and the result is capped at {@link MAX_TABS}. Unknown key
* shapes are dropped, exactly like {@link parseTabKey} does for one key.
*/
function rebuildOrder(order, required) {
	const allowed = [PROJECTS_TAB];
	for (const key of required) {
		if (key === "projects" || parseTabKey(key) === null || allowed.includes(key)) continue;
		allowed.push(key);
	}
	const wanted = new Set(allowed);
	const result = [PROJECTS_TAB];
	for (const key of order) {
		if (key === "projects" || !wanted.has(key) || result.includes(key)) continue;
		if (result.length >= 16) break;
		result.push(key);
	}
	for (const key of allowed) {
		if (key === "projects" || result.includes(key)) continue;
		if (result.length >= 16) break;
		result.push(key);
	}
	return result;
}
/**
* Serialise the state as a `workspace.json` v1 document (§4.2).
*
* `openProjects` is the canvas keys in strip order, `nodeDetailTabs` the node
* keys — both derived from `tabOrder`, so the three views cannot disagree.
* Session state (selection) is never written (§4.1), and titles never exist in
* this module at all (§3.1/§8.2: labels are computed from data).
*/
function toWorkspaceJson(state) {
	const openProjects = [];
	const nodeDetailTabs = [];
	for (const tab of listTabs(state)) if (tab.kind === "canvas" && tab.boardId !== void 0) openProjects.push(tab.boardId);
	else if (tab.kind === "node" && tab.boardId !== void 0 && tab.itemId !== void 0) nodeDetailTabs.push({
		boardId: tab.boardId,
		nodeId: tab.itemId,
		kind: tab.detailKind ?? "task"
	});
	const active = parseTabKey(state.activeTab);
	let activeTab = { kind: "projects" };
	if (active !== null && active.kind === "canvas") activeTab = {
		kind: "canvas",
		boardId: active.boardId
	};
	else if (active !== null && active.kind === "node") activeTab = {
		kind: "node",
		boardId: active.boardId,
		nodeId: active.itemId
	};
	return {
		version: 1,
		openProjects,
		activeTab,
		nodeDetailTabs,
		tabOrder: [...state.tabOrder],
		recentProjects: state.recentProjects.map((entry) => ({
			boardId: entry.boardId,
			openedAt: entry.openedAt
		}))
	};
}
/**
* Read a `workspace.json` that may be anything at all (§4.3, WD5).
*
* Degrades **item by item**, never as a whole:
*
* - not a document at all → empty state (that is also what a missing or
*   unparseable file becomes, §4.3);
* - `version` from a newer build → empty state, the one documented whole-file
*   fallback (§4.3 point 2);
* - `version` absent → treated as the old `state.json` shape, `{active}` (§4.4);
* - a board that no longer exists, an item that is gone, an unknown detail kind,
*   an unparseable timestamp, an unknown key shape → that entry is dropped and
*   everything else survives;
* - over the caps → truncated to {@link MAX_CANVAS_TABS} / {@link MAX_TABS} /
*   {@link MAX_RECENT_PROJECTS}, never refused;
* - `tabOrder` disagreeing with the open sets → rebuilt by {@link rebuildOrder};
* - `activeTab` pointing at something that did not survive → `projects`.
*/
function stateFromWorkspace(raw, refs = {}) {
	if (typeof raw !== "object" || raw === null) return emptyState();
	const record = raw;
	const version = record.version;
	if (version === void 0) return stateFromLegacy(record, refs);
	if (typeof version !== "number" || !Number.isInteger(version) || version !== 1) return emptyState();
	const boardAllowed = (id) => typeof id === "string" && id.length > 0 && (refs.boardIds === void 0 || refs.boardIds.includes(id));
	const itemAllowed = (boardId, itemId) => {
		if (typeof itemId !== "string" || itemId.length === 0) return false;
		const known = refs.items;
		if (known === void 0) return true;
		return known[boardId]?.includes(itemId) === true;
	};
	const openProjects = [];
	for (const entry of asArray(record.openProjects)) {
		if (!boardAllowed(entry) || openProjects.includes(entry)) continue;
		if (openProjects.length >= 8) break;
		openProjects.push(entry);
	}
	const nodeKeys = [];
	const nodeKinds = {};
	for (const entry of asArray(record.nodeDetailTabs)) {
		if (typeof entry !== "object" || entry === null) continue;
		const tab = entry;
		const boardId = tab.boardId;
		const nodeId = tab.nodeId;
		const kind = tab.kind;
		if (!boardAllowed(boardId) || !itemAllowed(boardId, nodeId) || !isNodeDetailKind(kind)) continue;
		const key = nodeTabKey(boardId, nodeId);
		if (nodeKinds[key] !== void 0) continue;
		if (openProjects.length + nodeKeys.length + 2 > 16) break;
		nodeKinds[key] = kind;
		nodeKeys.push(key);
	}
	const nodeKeysByBoard = /* @__PURE__ */ new Map();
	for (const key of nodeKeys) {
		const ref = parseTabKey(key);
		if (ref === null || ref.kind !== "node") continue;
		const bucket = nodeKeysByBoard.get(ref.boardId);
		if (bucket === void 0) nodeKeysByBoard.set(ref.boardId, [key]);
		else bucket.push(key);
	}
	const required = [PROJECTS_TAB];
	for (const boardId of openProjects) {
		required.push(canvasTabKey(boardId));
		const bucket = nodeKeysByBoard.get(boardId);
		if (bucket !== void 0) required.push(...bucket);
	}
	for (const key of nodeKeys) if (!required.includes(key)) required.push(key);
	const wanted = [];
	for (const entry of asArray(record.tabOrder)) {
		if (typeof entry !== "string" || !required.includes(entry) || wanted.includes(entry)) continue;
		wanted.push(entry);
	}
	const tabOrder = rebuildOrder(wanted, required);
	for (const key of Object.keys(nodeKinds)) if (!tabOrder.includes(key)) delete nodeKinds[key];
	const candidate = activeKeyFrom(record.activeTab);
	return {
		tabOrder,
		activeTab: candidate !== void 0 && tabOrder.includes(candidate) ? candidate : PROJECTS_TAB,
		nodeKinds,
		recentProjects: normalizeRecent(record.recentProjects, boardAllowed),
		selections: {}
	};
}
/** `value` as an array, or an empty one — JSON fields are untrusted. */
function asArray(value) {
	return Array.isArray(value) ? value : [];
}
/** The key a stored `activeTab` object names, if it names one at all. */
function activeKeyFrom(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	if (record.kind === "projects") return PROJECTS_TAB;
	if (record.kind === "canvas" && typeof record.boardId === "string" && record.boardId.length > 0) return canvasTabKey(record.boardId);
	if (record.kind === "node" && typeof record.boardId === "string" && record.boardId.length > 0 && typeof record.nodeId === "string" && record.nodeId.length > 0) return nodeTabKey(record.boardId, record.nodeId);
}
/** Valid, deduplicated, unknown-board-free `recentProjects`, newest first (§4.2). */
function normalizeRecent(raw, boardAllowed) {
	const entries = [];
	for (const entry of asArray(raw)) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry;
		const boardId = record.boardId;
		const openedAt = record.openedAt;
		if (!boardAllowed(boardId)) continue;
		if (typeof openedAt !== "string" || !Number.isFinite(Date.parse(openedAt))) continue;
		if (entries.some((known) => known.boardId === boardId)) continue;
		if (entries.length >= 20) break;
		entries.push({
			boardId,
			openedAt
		});
	}
	return entries;
}
/**
* §4.4's one-shot migration: a `{active}` file without a `version` becomes "that
* board's canvas tab is the one open tab".
*
* This is the read-time, in-memory half only — writing `workspace.json` belongs
* to U02. Without a known board list the reference cannot be checked, so it is
* kept; with a list that no longer contains it, the workspace opens empty.
*/
function stateFromLegacy(raw, refs) {
	const boardId = raw.active;
	if (typeof boardId !== "string" || boardId.length === 0) return emptyState();
	if (refs.boardIds !== void 0 && !refs.boardIds.includes(boardId)) return emptyState();
	const key = canvasTabKey(boardId);
	const now = typeof refs.now === "string" && Number.isFinite(Date.parse(refs.now)) ? refs.now : void 0;
	return {
		tabOrder: [PROJECTS_TAB, key],
		activeTab: key,
		nodeKinds: {},
		recentProjects: now === void 0 ? [] : [{
			boardId,
			openedAt: now
		}],
		selections: {}
	};
}
//#endregion
//#region src/output.ts
/**
* Image persistence: `<outputDir>/<prefix>_<W>x<H>_<n>.png`.
*
* Numbering starts at 1 and skips names already on disk, so a second identical
* call adds files instead of silently overwriting the first result. The whole
* find-free-index-then-write sequence runs inside the directory's write queue
* (the same primitive the board store uses): two concurrent generations — the
* conversation tool and the Studio panel — would otherwise both probe the same
* free index and the second `rename` would silently overwrite the first image.
* Writes are staged through a per-call temporary file and renamed, so an
* interrupted call never leaves a half-written PNG under the final name.
*/
/** Extensions probed when deciding whether a name is already taken. */
const KNOWN_EXTENSIONS = [
	".png",
	".jpg",
	".jpeg",
	".webp"
];
/**
* Turn caller text into a filename-safe prefix.
*
* @param raw - caller-provided `preset`, or `undefined`.
* @returns an ASCII-safe prefix; multi-byte-only input collapses to the
*   fallback rather than producing an untypable name.
*/
function sanitizePrefix(raw, fallback = "qwen") {
	const cleaned = (raw ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 48);
	return cleaned.length > 0 ? cleaned : fallback;
}
/** True when the path exists. */
async function exists(path) {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}
/**
* Find the lowest free index for one size.
*
* @param dir - output directory, which must already exist.
* @param prefix - sanitized filename prefix.
* @param width - aligned width.
* @param height - aligned height.
* @param start - first index to consider.
* @returns the first index whose name is free under every known extension.
*/
async function nextFreeIndex(dir, prefix, width, height, start = 1) {
	let index = start;
	for (;;) {
		if (!(await Promise.all(KNOWN_EXTENSIONS.map((extension) => exists(join(dir, `${prefix}_${width}x${height}_${index}${extension}`))))).some(Boolean)) return index;
		index += 1;
	}
}
/**
* Write every generated image under the required naming scheme.
*
* The queue key is the output directory itself, so any two callers writing
* images into one directory are serialised against each other regardless of
* which tool or panel they came from.
*
* @param dir - output directory; created when missing.
* @param prefix - sanitized filename prefix.
* @param width - aligned width used in the file name.
* @param height - aligned height used in the file name.
* @param images - decoded images in backend order.
* @returns one record per written file, with Markdown-ready absolute paths.
*/
function writeImages(dir, prefix, width, height, images) {
	return serialized(dir, async () => {
		await mkdir(dir, { recursive: true });
		const first = await nextFreeIndex(dir, prefix, width, height);
		const written = [];
		let index = first;
		for (const image of images) {
			const path = join(dir, `${prefix}_${width}x${height}_${index}.png`);
			const staging = `${path}.partial-${process.pid}-${randomUUID().slice(0, 8)}`;
			await writeFile(staging, image.bytes);
			try {
				await rename(staging, path);
			} catch (error) {
				await unlink(staging).catch(() => void 0);
				throw error;
			}
			written.push({
				index,
				path,
				markdownPath: path.replace(/\\/g, "/"),
				bytes: image.bytes.byteLength,
				mime: image.mime
			});
			index += 1;
		}
		return written;
	});
}
//#endregion
//#region src/refs.ts
/**
* Reference images for the edit path.
*
* `qwen_image_edit` accepts, for each entry, either an absolute path or a
* `data:image/…;base64,…` URI. This module turns that list into bytes plus the
* pixel size, and it is the only place that decides whether a list is usable —
* a reference that cannot be read is an error that names its position, never a
* silently dropped entry, because dropping one shifts every `<imageN>` label the
* caller wrote in the prompt.
*
* The size matters as much as the bytes: `ratio_follow` means "the canvas takes
* that image's aspect ratio", which cannot be resolved without measuring it, so
* the header is parsed here (PNG / JPEG / WebP) instead of guessing.
*/
init_images();
/** Image containers whose pixel size this module can read. */
const SIZED_MIMES = [
	"image/png",
	"image/jpeg",
	"image/webp"
];
/** Read a big-endian unsigned integer of `width` bytes. */
function readUintBE(bytes, at, width) {
	let value = 0;
	for (let offset = 0; offset < width; offset += 1) value = value * 256 + (bytes[at + offset] ?? 0);
	return value;
}
/** `IHDR` immediately follows the PNG signature, so width/height sit at a fixed offset. */
function pngSize(bytes) {
	if (bytes.length < 24) return void 0;
	if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return void 0;
	return {
		width: readUintBE(bytes, 16, 4),
		height: readUintBE(bytes, 20, 4)
	};
}
/** Walk the JPEG marker chain to the first `SOFn`, then read its frame header. */
function jpegSize(bytes) {
	let offset = 2;
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 255) {
			offset += 1;
			continue;
		}
		const marker = bytes[offset + 1] ?? 0;
		if (marker === 255) {
			offset += 1;
			continue;
		}
		if (marker === 1 || marker >= 208 && marker <= 217) {
			offset += 2;
			continue;
		}
		const length = readUintBE(bytes, offset + 2, 2);
		if (length < 2) return void 0;
		if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) return {
			width: readUintBE(bytes, offset + 7, 2),
			height: readUintBE(bytes, offset + 5, 2)
		};
		offset += 2 + length;
	}
}
/** `VP8X` stores 24-bit canvas sides; lossy `VP8 ` and lossless `VP8L` store theirs inline. */
function webpSize(bytes) {
	if (bytes.length < 30) return void 0;
	const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
	if (chunk === "VP8X") return {
		width: 1 + readUintBE(bytes, 24, 3),
		height: 1 + readUintBE(bytes, 27, 3)
	};
	if (chunk === "VP8 ") {
		if (bytes[23] !== 157 || bytes[24] !== 1 || bytes[25] !== 42) return void 0;
		return {
			width: readUintBE(bytes, 26, 2) & 16383,
			height: readUintBE(bytes, 28, 2) & 16383
		};
	}
	if (chunk === "VP8L") {
		if (bytes[20] !== 47) return void 0;
		const bits = readUintBE(bytes, 21, 4);
		return {
			width: (bits & 16383) + 1,
			height: (bits >> 14 & 16383) + 1
		};
	}
}
/**
* Read an image's pixel size from its container header.
*
* Only the containers {@link SIZED_MIMES} lists are understood; everything else
* returns undefined so the caller can say which file it could not measure.
*
* @param bytes - the whole image (only the header is inspected).
* @returns the size and the sniffed mime, or undefined for an unknown container.
*/
function probeImageSize(bytes) {
	const mime = sniffImageMime(bytes);
	if (mime === void 0) return void 0;
	const size = mime === "image/png" ? pngSize(bytes) : mime === "image/jpeg" ? jpegSize(bytes) : webpSize(bytes);
	if (size === void 0 || size.width <= 0 || size.height <= 0) return void 0;
	return {
		...size,
		mime
	};
}
/** True when the string is a `data:` URI rather than a filesystem path. */
function isDataUri(source) {
	return source.startsWith("data:");
}
/** Decode one `data:` URI, or explain exactly why it is not one we accept. */
function decodeDataUri(source, position) {
	const where = `images[${position}]`;
	if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(source)) throw new Error(`${where}: only base64 image data URIs are accepted — expected "data:image/png;base64,…", got "${source.slice(0, 40)}${source.length > 40 ? "…" : ""}"`);
	const payload = source.slice(source.indexOf(",") + 1).replace(/\s+/g, "");
	if (payload.length === 0) throw new Error(`${where}: the data URI carries no base64 payload`);
	const bytes = new Uint8Array(Buffer.from(payload, "base64"));
	if (bytes.byteLength === 0) throw new Error(`${where}: the data URI decoded to 0 bytes`);
	return bytes;
}
/** Read one path, phrasing the usual filesystem failures so the caller can act. */
async function readImageFile(path, position) {
	const where = `images[${position}]`;
	if (!isAbsolute(path)) throw new Error(`${where}: "${path}" is not an absolute path. Reference images are read by this plugin's process, so a relative path would resolve against an unpredictable directory — pass an absolute path (e.g. D:\\pictures\\ref.png), or a data:image/…;base64,… URI.`);
	let info;
	try {
		info = await stat(path);
	} catch (error) {
		const reason = error.code ?? (error instanceof Error ? error.message : String(error));
		throw new Error(`${where}: cannot read "${path}" — ${reason === "ENOENT" ? "no such file" : reason}`);
	}
	if (info.isDirectory()) throw new Error(`${where}: "${path}" is a directory, not an image file`);
	if (info.size === 0) throw new Error(`${where}: "${path}" is 0 bytes — it is not an image`);
	let bytes;
	try {
		bytes = await readFile(path);
	} catch (error) {
		const reason = error.code ?? (error instanceof Error ? error.message : String(error));
		throw new Error(`${where}: cannot read "${path}" — ${reason}` + (reason === "EACCES" || reason === "EPERM" ? " (the file exists but this process is not allowed to open it)" : ""));
	}
	return new Uint8Array(bytes);
}
/**
* Validate, decode, and measure every reference image.
*
* @param sources - caller-supplied paths or `data:` URIs, in prompt order.
* @returns one entry per input, in the same order, each with bytes and pixel size.
* @throws When the list is empty or longer than {@link MAX_REFERENCES}, when an
*   entry is not a string, when a path is relative, missing, unreadable, empty or
*   a directory, when a data URI is malformed, or when the bytes are not a PNG /
*   JPEG / WebP. Every message names the failing position.
*/
async function loadReferenceImages(sources) {
	if (!Array.isArray(sources)) throw new Error("images must be an array of absolute paths or data: URIs");
	if (sources.length === 0) throw new Error("images must contain at least one reference image");
	if (sources.length > 10) throw new Error(`images carries ${sources.length} reference images, but at most 10 are supported (the prompt contract numbers them <image1>…<image10>).`);
	const out = [];
	for (const [position, source] of sources.entries()) {
		if (typeof source !== "string" || source.trim().length === 0) throw new Error(`images[${position}] must be a non-empty string (an absolute path or a data: URI), got ${JSON.stringify(source)}`);
		const trimmed = source.trim();
		const bytes = isDataUri(trimmed) ? decodeDataUri(trimmed, position) : await readImageFile(trimmed, position);
		const size = probeImageSize(bytes);
		if (size === void 0) {
			const container = sniffImageMime(bytes);
			const label = isDataUri(trimmed) ? `images[${position}] (data URI)` : `images[${position}]: "${trimmed}"`;
			const detail = container === void 0 ? "is not a recognized image container (not a PNG, JPEG or WebP)" : `is ${container}, but its pixel size could not be read from the header`;
			throw new Error(`${label} ${detail} — this plugin reads the pixel size of ${SIZED_MIMES.join(" / ")} references only, and needs it both for the backend and for ratio_follow. Convert it, or pass wh_ratio / width+height instead of ratio_follow.`);
		}
		out.push({
			position,
			index: position + 1,
			source: trimmed,
			label: isDataUri(trimmed) ? `inline image ${position + 1}` : basename(trimmed),
			bytes,
			mime: size.mime,
			width: size.width,
			height: size.height
		});
	}
	return out;
}
/**
* Resolve `ratio_follow` to one of the loaded references.
*
* Accepts the contract's `"image1"…"image10"` labels and, because the tool also
* takes paths, the same string the caller put in `images` (compared with
* normalized separators and case, as Windows reports them).
*
* @param ratioFollow - caller value: `imageN` or one of the `images` entries.
* @param references - the loaded references.
* @returns the reference whose aspect ratio the canvas must follow.
* @throws When the label is out of range or matches no entry, listing what is
*   accepted instead of guessing which image was meant.
*/
function resolveRatioFollow(ratioFollow, references) {
	const wanted = ratioFollow.trim();
	const label = /^image(\d+)$/i.exec(wanted);
	if (label !== null) {
		const index = Number(label[1]);
		if (index < 1 || index > references.length) throw new Error(`ratio_follow "${ratioFollow}" points at reference image ${index}, but this call carries ${references.length} (${references.map((reference) => `<image${reference.index}>`).join(", ")}). The contract numbers the references <image1>…<imageN> in the order they are passed.`);
		return references[index - 1];
	}
	const normalize = (value) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const byPath = references.find((reference) => normalize(reference.source) === normalize(wanted));
	if (byPath !== void 0) return byPath;
	throw new Error(`ratio_follow "${ratioFollow}" matches none of the ${references.length} reference images. Pass the contract label (${references.map((reference) => `"image${reference.index}"`).join(", ")}) or exactly the string you passed in images[] (${references.map((reference) => `"${reference.source}"`).join(", ")}).`);
}
//#endregion
//#region src/ratio.ts
/**
* `wh_ratio` → pixel dimensions.
*
* The Qwen prompt contract emits an aspect ratio (`wh_ratio`), while every
* diffusion backend wants pixel width/height. This module is the single place
* where that translation happens, so the tool layer never has to re-implement
* it and the test suite can pin the result of all seven official tiers.
*/
/** The seven `wh_ratio` tiers of the Qwen-Image prompt contract, in order. */
const WH_RATIOS = [
	"1:1",
	"4:3",
	"3:4",
	"3:2",
	"2:3",
	"16:9",
	"9:16"
];
/** Largest accepted side length. */
const MAX_SIDE = 4096;
/**
* Pixel budget the default tier table targets — **~1.5 MP**.
*
* Also the budget {@link resolveSize} searches around for shapes outside the seven
* tiers.
*
* Measured on the card class this plugin targets (RTX 4070 Laptop, 8188 MiB, nf4
* worker, 25 steps) — **text-to-image only**: 1248×1248 and 1664×928 peak at
* **5680–6016 MiB reserved / 5349–5358 MiB allocated**, so ~1.5 MP keeps at least
* 2.1 GiB of headroom and is the default for **every** backend, not only ComfyUI.
*
* The **edit** path is measured separately and has no table of its own: ComfyUI
* scales the references to the canvas' own budget, so the same 1.5 MP ceiling
* applies and the seven defaults below are what both tools ask for.
*/
const DEFAULT_MEGAPIXELS = 1.5;
/**
* The canvas each official tier ships by default, at {@link DEFAULT_MEGAPIXELS}.
*
* Pinned rather than searched: the search trades shape fidelity against the pixel
* budget, and at 1.5 MP that trade picks 1632×928 for `16:9` — a slightly lower
* score, but a shape nobody documented. Every pair here is 32-aligned (the test
* suite asserts it); `16:9` and `9:16` stay inexact on a 32 grid and report it.
*/
const DEFAULT_SIZES = {
	"1:1": [1248, 1248],
	"4:3": [1408, 1056],
	"3:4": [1056, 1408],
	"3:2": [1536, 1024],
	"2:3": [1024, 1536],
	"16:9": [1664, 928],
	"9:16": [928, 1664]
};
/** The pixel budgets the canvas tables can run at. */
const SIZE_TIERS = ["1.5mp", "2k"];
/** The tier used when the caller does not pick one: the 8 GB-friendly ~1.5 MP table. */
const DEFAULT_SIZE_TIER = "1.5mp";
/** Pixel budget each tier targets, in millions of pixels. */
const SIZE_TIER_MEGAPIXELS = {
	"1.5mp": DEFAULT_MEGAPIXELS,
	"2k": 4.2
};
/**
* The official 4.2 MP (2K) table from the Qwen-Image 2.1 model card.
*
* The card prints 1:1 2048×2048, 4:3 2400×1792, 3:2 2528×1696, 16:9 2752×1536 and
* 9:16 1536×2752; 3:4 / 2:3 are their exact transposes (transposition preserves
* both the ratio and the area, so they are not invented numbers). Every pair is
* 32-aligned; 16:9 / 9:16 cannot be exact on a 32 grid and report their residue,
* exactly like {@link DEFAULT_SIZES}.
*
* **Not the default**: 4.2 MP is the model card's native 2K tier, but it is ~2.8×
* the pixels of the shipped 1.5 MP table (the budget an 8 GB card is sized for),
* so it is opt-in per call. Above 2K the model loses prompt adherence (4K warning
* in the official docs), which is why there is no 4K tier.
*/
const OFFICIAL_2K_SIZES = {
	"1:1": [2048, 2048],
	"4:3": [2400, 1792],
	"3:4": [1792, 2400],
	"3:2": [2528, 1696],
	"2:3": [1696, 2528],
	"16:9": [2752, 1536],
	"9:16": [1536, 2752]
};
/**
* The canvas table one tier runs.
*
* @param tier - the budget tier; defaults to the shipped 1.5 MP table.
* @returns the seven-tier table for that budget.
*/
function sizesForTier(tier = DEFAULT_SIZE_TIER) {
	return tier === "2k" ? OFFICIAL_2K_SIZES : DEFAULT_SIZES;
}
/** Round down to the nearest allowed multiple. */
function alignDown(value, multiple) {
	return Math.max(multiple, Math.floor(value / multiple) * multiple);
}
/** Parse `"16:9"` into its two positive integers; throws on anything else. */
function parseRatio(whRatio) {
	const match = /^(\d+):(\d+)$/.exec(whRatio.trim());
	if (match === null) throw new Error(`wh_ratio must look like "16:9", got "${whRatio}"`);
	const a = Number(match[1]);
	const b = Number(match[2]);
	if (a <= 0 || b <= 0) throw new Error(`wh_ratio sides must be positive, got "${whRatio}"`);
	return {
		a,
		b
	};
}
/** Greatest common divisor, used to reduce `a:b` before the table lookup. */
function gcd(a, b) {
	return b === 0 ? a : gcd(b, a % b);
}
/**
* Resolve a `wh_ratio` to the canvas the plugin ships by default.
*
* The ratio is reduced first, so a reference image that measures `2048:1152` —
* exactly `16:9` — lands on the documented canvas instead of on a second,
* search-derived answer for the same shape. Any other shape (`21:9`) falls through
* to {@link resolveSize} at the tier's budget. Explicit `width`/`height` never reach
* this function; the tool layer validates and honours them first.
*
* @param whRatio - any `a:b`, tier or not.
* @param tier - which documented canvas table to use; defaults to the shipped
*   1.5 MP table, so an unset tier keeps every existing answer byte-identical.
* @returns the aligned size plus its deviation from the *requested* ratio.
*/
function resolveDefaultSize(whRatio, tier = DEFAULT_SIZE_TIER) {
	const { a, b } = parseRatio(whRatio);
	const divisor = gcd(a, b);
	const pair = sizesForTier(tier)[`${a / divisor}:${b / divisor}`];
	if (pair === void 0) return resolveSize(whRatio, SIZE_TIER_MEGAPIXELS[tier]);
	const [width, height] = pair;
	const ratioDeviationPercent = (width / height / (a / b) - 1) * 100;
	return {
		width,
		height,
		ratioDeviationPercent: Number(ratioDeviationPercent.toFixed(3)),
		exact: Math.abs(ratioDeviationPercent) < .001
	};
}
/**
* Resolve an aspect ratio to the closest backend-ready size by searching the grid.
*
* This is the fallback for shapes outside {@link DEFAULT_SIZES}; the seven official
* tiers come from that table instead.
*
* Both sides move in steps of {@link SIZE_MULTIPLE}, so most ratios cannot be
* reproduced exactly. Instead of aligning each side independently (which drifts
* badly: 1500×750 snaps to 1472×736, i.e. 2:1), every candidate pair in the
* legal window is scored on ratio fidelity plus how close the pixel budget
* stays to `megapixels`, and the best pair wins. Ties prefer the larger canvas,
* then the wider one, so the result is deterministic across platforms.
*
* @param whRatio - one of {@link WH_RATIOS} (any `a:b` is accepted).
* @param megapixels - target pixel budget in millions of pixels.
* @returns the aligned size plus how far its true ratio sits from the request.
*/
function resolveSize(whRatio, megapixels = DEFAULT_MEGAPIXELS) {
	const { a, b } = parseRatio(whRatio);
	const target = megapixels * 1e6;
	const wanted = a / b;
	const idealScale = Math.sqrt(target / (a * b));
	const low = 32;
	const high = Math.min(MAX_SIDE, Math.max(alignDown(Math.round(a * idealScale) * 2, 32), 512));
	let best;
	for (let width = low; width <= high; width += 32) for (let height = low; height <= high; height += 32) {
		const score = Math.abs(width / height - wanted) / wanted + Math.abs(width * height - target) / target * .5;
		if (best === void 0 || score < best.score - 1e-12 || Math.abs(score - best.score) <= 1e-12 && width * height > best.width * best.height || Math.abs(score - best.score) <= 1e-12 && width * height === best.width * best.height && width > best.width) best = {
			width,
			height,
			score
		};
	}
	if (best === void 0) throw new Error(`no 32-aligned size found for wh_ratio "${whRatio}"`);
	const ratioDeviationPercent = (best.width / best.height / wanted - 1) * 100;
	return {
		width: best.width,
		height: best.height,
		ratioDeviationPercent: Number(ratioDeviationPercent.toFixed(3)),
		exact: Math.abs(ratioDeviationPercent) < .001
	};
}
/**
* Validate an explicit caller-supplied size.
*
* @param width - requested width in pixels.
* @param height - requested height in pixels.
* @returns the validated size.
* @throws When a side is out of range or not a multiple of 32, naming the
*   nearest legal values so the caller can fix the call without guessing.
*/
function validateSize(width, height) {
	for (const [label, value] of [["width", width], ["height", height]]) {
		if (!Number.isInteger(value)) throw new Error(`${label} must be an integer, got ${value}`);
		if (value < 256 || value > 4096) throw new Error(`${label} must be between 256 and ${MAX_SIDE}, got ${value}`);
		if (value % 32 !== 0) {
			const down = alignDown(value, 32);
			throw new Error(`${label} must be a multiple of 32, got ${value} (nearest legal values: ${down} and ${down + 32})`);
		}
	}
	return {
		width,
		height
	};
}
/**
* Pick the ratio whose ideal shape is closest to an explicit size. Used to keep
* the reported `wh_ratio` honest when the caller overrides width/height.
*/
function nearestRatio(width, height) {
	const actual = width / height;
	let best;
	for (const candidate of WH_RATIOS) {
		const { a, b } = parseRatio(candidate);
		const deviationPercent = (actual / (a / b) - 1) * 100;
		if (best === void 0 || Math.abs(deviationPercent) < Math.abs(best.deviationPercent)) best = {
			whRatio: candidate,
			deviationPercent: Number(deviationPercent.toFixed(3))
		};
	}
	if (best === void 0) throw new Error("WH_RATIOS is empty");
	return best;
}
//#endregion
//#region src/studio-prompt.ts
/**
* Load `BlockAssembler` on demand.
*
* The import is deliberately dynamic. `llm` is an optional service on this host,
* so a profile that never mounts it also never installs `@deepseek-ai/dsh-llm`;
* a static import would then fail at module load and take the whole plugin —
* generation included — down with an optimiser nobody asked for. A rejected
* import means "no optimiser", which is exactly what `undefined` says.
*
* @returns the constructor, or `undefined` when the package is not installed.
*/
async function loadAssembler() {
	try {
		const constructor = (await import("@deepseek-ai/dsh-llm")).BlockAssembler;
		return typeof constructor === "function" ? constructor : void 0;
	} catch {
		return;
	}
}
/**
* Whether prompt optimisation can actually run: both the service and the
* assembler package must be present, because either one missing means a button
* that fails on click rather than a button that explains itself.
*
* @param ctx - host context.
* @returns true when a rewrite could be attempted.
*/
async function optimizerAvailable(ctx) {
	if (!(await resolveOptimizerFor(ctx)).ok) return false;
	return await loadAssembler() !== void 0;
}
/**
* Token ceiling for one rewrite; a prompt longer than this is not an improvement.
*
* 900 was enough for the old "one paragraph" shape. The house skeleton in
* `references/t2i_rules.md` asks for ~20 English sentences / 400–500 words,
* which is roughly 700–800 tokens on its own — counting tokens for the model
* (~800) and leaving nothing for the trailing `注：` line.
*/
const MAX_TOKENS = 1600;
/** Longest single history turn forwarded, in characters. */
const MAX_CONTEXT_TURN_CHARS = 1200;
/**
* Thrown when optimisation cannot run. Carries {@link stage} so the route can
* put it in the JSON body instead of flattening it into prose.
*/
var OptimizeUnavailableError = class extends Error {
	stage;
	constructor(failure) {
		super(`提示词优化不可用（${failure.stage}）：${failure.detail}`);
		this.name = "OptimizeUnavailableError";
		this.stage = failure.stage;
	}
};
/**
* The system prompt handed to the conversation model.
*
* **This is not Qwen's official rewriting prompt.** Qwen ships its own
* `system_prompt_t2i.txt` / `guide_t2i.md` / `guide_edit.md`, which this package
* deliberately does not redistribute (see `docs/license-and-limits.md`). What is
* below is the plugin's own house style, authored against the same output
* contract so a Studio rewrite and an Agent rewrite are interchangeable: either
* one can be pasted into the other, and either can be handed straight to
* `qwen_image_generate`. Where the two schools disagree — the house style bans
* `4K` / `masterpiece` and wants long observational prose, while Alibaba's
* published formula is a `主体+场景+风格+镜头+氛围+细节` keyword stack that
* actively invites those quality words — this file follows the house style.
*
* Exported only so the test suite can pin the rules that must survive an edit:
* the house skeleton (sentence count, the single closing sentence), the banned
* filler words, and the "no ratio in the prose" rule. The wording itself is
* free to change; those properties are not.
*
* The `formula` variant below is the other school — see {@link FORMULA_SYSTEM_PROMPT}.
*/
const PROSE_SYSTEM_PROMPT = `你是 Qwen-Image 2.1 的生图提示词改写器。你只做一件事：把用户的口语需求改写成一幅**画面上有什么**的描述性散文。

这套规则与插件自带的 skill 规则（references/t2i_rules.md、references/edit_rules.md）同源，改写结果必须能直接互换使用。

一、先分拣用户的输入
1. 画面事实：必须原样保留——要显示的文字原文（逐字符照抄，连标点空格，是中文就留中文）、指定物件、数量、颜色、位置。
2. 对任务的要求：「不要糊」「要高清」「用双引号」是给你看的指令，不是画面内容。散文里不出现「确保」「不要」「请你画」这类字眼。
3. 用户没说、由你定的：三字需求与三百字需求，最终都要写成同等篇幅的完整画面。需求越短，你要自己定的越多——不是写得更短。

二、画幅
绝不把比例、分辨率、像素数写进正文。「4K」「高清」是画质形容，不是比例线索；比例由工作台的画幅选择器负责。

三、散文骨架（文生图）
1. 一段话，不换行分节，约 20 句、400–500 词。第一句是锚定句（约 20 词）：媒介、风格、主体、背景/主色，通常连朝向一起说。媒介名词（photograph / poster / illustration / infographic / logo…）不可省。
2. 中间走一遍画面：先在心里列出空间清单，用 8–14 个方位短语，必须够到四角、边缘与中心，不要全挤在中间。约三分之一的句子直接以方位短语开头（"On the right side of the frame, …"）。
   分区型（海报、页面、多物宽景）：背景与承托面 → 顶部带 → 主体左→中→右 → 底部带。
   单主体型（肖像、特写、单个物件）：背景与景深衰减 → 主体姿态与落位 → 头脸 → 身体与每件衣料曲面 → 手里或贴着它的东西 → 边缘小物。
3. 画面里的文字：没有就跳过，别硬加招牌。有则按阅读顺序逐个交代「位置 + 字重/颜色/大小写 + 内容」，如 a bold black headline across the top reads "夏日特惠"。换行说成「第二行」，不要把真换行塞进字符串。
4. 光照必须单独成句：光源、方向、质感，以及它留下的阴影与高光。
5. 最后**只准一句**退回整幅（"The overall composition …"）：平衡、配色、风格、情绪。不要接第二句总结。

四、用词纪律
1. 观察者口吻：现在时、第三人称、陈述句。不出现 "you"、"create"、"make sure"。
2. 禁止空话：8K、masterpiece、award-winning、highly detailed、photorealistic masterpiece。
3. 颜色带修饰（deep navy、muted olive、warm terracotta）；给材质不只给名词（frosted glass、coarse linen、condensation）。
4. 枚举不概括："several items" 不算描述；小数字写英文单词（three、five）。
5. 人是可见表面：体格、姿态、视线、表情、发型、肤色、每件衣物的颜色与材质。年龄用生命阶段（a child、middle-aged、in her thirties），不写具体岁数。脸被挡住就写挡住。
6. 物件按类别写不按品牌（silver laptop、compact hatchback），用户点名品牌时才写品牌。
7. 物理自洽：影子背离光源，反射与面前的东西对应，相邻物体比例一致。
8. 不确定就留余地（appears to be、a notebook or a tablet），用户钉死的部分才用确定语气。

五、编辑模式（给了参考图）
不重新描述整张画面，写成「在保持…的前提下，把…改为…」式改动指令；用 <image1>、<image2> 指代参考图。改动之外的部分一句话带过，节省注意力。

六、语言
用户用中文提问时，散文正文也写英文——Qwen-Image 的英文描述更稳；但画面里要显示的文字保持原文语言。用户明确要求中文提示词时才写中文。

输出格式：
第一行是改写后的提示词（一整段）。
第二行以「注：」开头，用不超过 40 字的中文说明这次做的关键判断（补了什么光线、定了什么构图）。没有就省略第二行。
不要解释、不要前言、不要引号包裹、不要分点编号。`;
/**
* The `formula` school: Alibaba's published prompt formula, as a keyword stack.
*
* This is the convention the Qianwen/Wan image docs describe — `主体 + 场景 +
* 风格 + 镜头 + 氛围 + 细节修饰` — and it is deliberately the *opposite* of the
* house prose style: short, comma-separated, and it treats `4K` /
* `高分辨率` / `逆光` as legitimate detail modifiers instead of banned filler.
* It exists because which school wins is an empirical question on 2.1, not a
* settled one, and the panel should let a user try both on the same idea.
*
* Note what does *not* change: the ratio still belongs to the picker, on-image
* text is still copied verbatim, and the answer is still one line plus an
* optional `注：` note — the panel parses that shape either way.
*/
const FORMULA_SYSTEM_PROMPT = `你是 Qwen-Image 2.1 的生图提示词改写器，按「关键词公式」改写。

公式：提示词 = 主体 + 场景 + 风格 + 镜头 + 氛围 + 细节修饰

一、六个槽位各写什么
1. 主体：谁/什么，带外形、服饰、动作。人物写年龄阶段、性别、面部特征、衣着。
2. 场景：环境、季节、天气、时间、周围有什么。
3. 风格：写实摄影 / 水彩 / 皮克斯 / 羊毛毡 / 平面设计 / 油画…，可给一到两个。
4. 镜头：景别（特写、半身、全身、远景）+ 角度（平视、俯拍、仰拍）+ 镜头类型（广角、微距、35mm）。
5. 氛围：情绪词，如 梦幻、孤寂、壮阔、童趣、温暖。
6. 细节修饰：光源位置、材质、道具搭配、环境细节、画质词（4K、高分辨率、锐利边缘、逆光）。

二、硬规则
1. 输出**一行**，用中文顿号「、」或英文逗号分隔短语，不写完整句子，不写「请你画」。
2. 只保留与画面有关的短语，不解释、不编号、不加引号。
3. 画面里要显示的文字用双引号原样夹住，逐字符照抄，不翻译。
4. 不写画幅比例、不写像素尺寸——比例由工作台的画幅选择器负责。
5. 用户没说、但画面需要的槽位由你补足；宁可补齐六个槽位，也不要只交三个。
6. 编辑模式（给了参考图）：主体槽写「保持 <image1> 的…」，其余槽写要新增或改动的内容。

三、语言
跟随用户语言：中文需求给中文关键词，英文需求给英文关键词。画面内文字保持原文语言。

输出格式：
第一行是关键词串。
第二行以「注：」开头，用不超过 40 字的中文说明补了哪些槽位。没有就省略第二行。`;
/** Pick the system prompt for one rewriting convention. */
function systemPromptFor(style) {
	return style === "formula" ? FORMULA_SYSTEM_PROMPT : PROSE_SYSTEM_PROMPT;
}
/**
* Resolve a usable provider/model pair from the host.
*
* Order matters, and it is the opposite of the old one:
*
* 1. **`agentDefaultModel` first.** That service is the conversation's own
*    model selection (`currentSelection()` → `{provider, model}`), which is the
*    thing "seamless" means: no second configuration surface, and no guessing
*    which of several providers is the one the user is actually talking to.
* 2. **Enumerate only as a fallback.** `listProviders()` then each provider's
*    first named model, skipping ones that throw — a host with several
*    providers and one broken route is the normal case.
*
* Every exit names the stage that stopped it (see {@link OptimizeStage}); the
* caller turns that into an HTTP body instead of a shrug.
*
* @param ctx - host context; both services are looked up here, never injected.
* @returns a target, or the failure stage plus the upstream text.
*/
async function resolveOptimizerFor(ctx) {
	const llm = llmOf(ctx);
	if (llm === void 0) return {
		ok: false,
		stage: "llm-missing",
		detail: `宿主没有挂载可用的 llm 服务：${serviceOf(ctx, "llm") === void 0 ? "ctx.get(\"llm\") 拿不到服务" : "llm 服务缺少可驱动的形状（listProviders + prepareCall/stream）"}。这个 profile 需要在 cordis.patch.yml 里配置至少一个 provider。`
	};
	const selection = defaultSelectionOf(ctx);
	if (selection !== void 0 && selection.provider !== void 0 && selection.model !== void 0) return {
		ok: true,
		provider: selection.provider,
		model: selection.model,
		via: "agentDefaultModel"
	};
	const selectionNote = selection === void 0 ? "agentDefaultModel 未挂载" : `agentDefaultModel 的 selection 不完整（provider=${String(selection.provider)} / model=${String(selection.model)}）`;
	let providers;
	try {
		providers = llm.listProviders();
	} catch (error) {
		return {
			ok: false,
			stage: "list-providers-failed",
			detail: `${selectionNote}；llm.listProviders() 抛错：${firstLineOf(error)}`
		};
	}
	if (!Array.isArray(providers) || providers.length === 0) return {
		ok: false,
		stage: "list-providers-empty",
		detail: `${selectionNote}；llm.listProviders() 返回 ${Array.isArray(providers) ? "0 条" : String(providers)}。没有注册任何 provider。`
	};
	if (typeof llm.listModels !== "function") return {
		ok: false,
		stage: "list-models-failed",
		detail: `${selectionNote}；llm.listModels 不可用（typert 远程门面只暴露 listProviders），无法枚举模型。`
	};
	const problems = [];
	for (const entry of providers) {
		const name = entry.name ?? entry.id;
		if (typeof name !== "string" || name.length === 0) {
			problems.push(`<无名 provider>`);
			continue;
		}
		try {
			const first = (await llm.listModels(name)).find((candidate) => {
				const id = candidate.id ?? candidate.model ?? candidate.name;
				return typeof id === "string" && id.length > 0;
			});
			const id = first === void 0 ? void 0 : first.id ?? first.model ?? first.name;
			if (typeof id === "string" && id.length > 0) return {
				ok: true,
				provider: name,
				model: id,
				via: "listModels"
			};
			problems.push(`${name}: 列出 0 个模型`);
		} catch (error) {
			problems.push(`${name}: ${firstLineOf(error)}`);
		}
	}
	return {
		ok: false,
		stage: "list-models-failed",
		detail: `${selectionNote}；遍历 ${providers.length} 个 provider 都没拿到可用模型 —— ${problems.join(" | ")}`
	};
}
/** Read one host service, treating every failure — including a throwing `get` — as absent. */
function serviceOf(ctx, name) {
	try {
		return ctx.get?.(name);
	} catch {
		return;
	}
}
/** First line of an error-ish value, for messages that quote upstream text. */
function firstLineOf(error) {
	return (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]?.trim() || "（无信息）";
}
/** The conversation's own model selection, or `undefined` when the service is absent. */
function defaultSelectionOf(ctx) {
	const candidate = serviceOf(ctx, "agentDefaultModel");
	if (candidate === void 0 || typeof candidate.currentSelection !== "function") return void 0;
	try {
		return candidate.currentSelection();
	} catch {
		return;
	}
}
/** Read the `llm` service off a context, treating every failure as "absent". */
function llmOf(ctx) {
	const candidate = serviceOf(ctx, "llm");
	if (candidate === void 0 || candidate === null) return void 0;
	const face = candidate;
	if (typeof face.listProviders !== "function") return void 0;
	if (typeof face.prepareCall !== "function" && typeof face.stream !== "function") return void 0;
	return face;
}
/** Clamp history to a bounded, well-formed block. */
function contextBlock(turns) {
	if (turns === void 0 || turns.length === 0) return "";
	const lines = turns.slice(-6).map((turn) => {
		const text = turn.text.trim().slice(0, MAX_CONTEXT_TURN_CHARS);
		if (text.length === 0) return void 0;
		return `${turn.role === "user" ? "用户" : "助手"}：${text}`;
	}).filter((line) => line !== void 0);
	if (lines.length === 0) return "";
	return `\n\n最近对话（用于理解上文语境，不要复述）：\n${lines.join("\n")}`;
}
/** Assemble the user turn: the request, the canvas, the mode, and the context. */
function buildOptimizeUserText(input) {
	const mode = input.editing ? "这是一次图像编辑：用户会同时提供参考图，提示词应当描述「要改什么」，而不是重新画一张。" : "这是一次文生图：从零开始画。";
	const ratio = typeof input.ratio === "string" && input.ratio.trim().length > 0 ? `目标画幅比例：${input.ratio.trim()}。` : "";
	return `用户需求：${input.prompt.trim()}\n\n${mode}${ratio.length > 0 ? `\n${ratio}` : ""}${contextBlock(input.context)}`;
}
/**
* Split the model's answer into the prompt and the optional note.
*
* The model is told to put a `注：` line second; this parses that convention
* rather than trusting it, and falls back to "the whole answer is the prompt"
* when no note line is present.
*
* @param text - the assembled text blocks.
* @returns the prompt (never empty) and the note when one was produced.
*/
function splitOptimizerAnswer(text) {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { prompt: "" };
	const lines = trimmed.split(/\r?\n/);
	const noteIndex = lines.findIndex((line, index) => index > 0 && /^注[:：]/.test(line.trim()));
	if (noteIndex === -1) return { prompt: trimmed };
	const prompt = lines.slice(0, noteIndex).join("\n").trim();
	const note = lines.slice(noteIndex).join(" ").replace(/^注[:：]\s*/, "").trim();
	return note.length > 0 ? {
		prompt,
		note
	} : { prompt };
}
/** Strip a surrounding quote pair the model sometimes adds despite being told not to. */
function stripWrappingQuotes(text) {
	for (const [open, close] of [
		["\"", "\""],
		["“", "”"],
		["「", "」"],
		["'", "'"]
	]) if (text.length > 2 && text.startsWith(open) && text.endsWith(close)) {
		const inner = text.slice(open.length, text.length - close.length);
		if (!inner.includes(close)) return inner.trim();
	}
	return text;
}
/**
* Dispatch one bounded rewrite through whichever call shape the host exposes.
*
* The local host wants `resolveCallConfig` → `prepareCall` → `prepared.stream`,
* and the prepared stream **refuses an options object whose call-config keys
* differ from the resolved ones** (`prepared LLM call config changed before
* adapter dispatch`). Spreading the resolved config back in is what keeps that
* comparison honest — messages/system/signal are not compared, so they are the
* only things added. The typert remote façade has no `prepareCall` at all, so
* that shape (plain `stream`) stays as the fallback.
*
* @param llm - the service, already shape-checked by {@link llmOf}.
* @param target - provider/model pair.
* @param request - messages, system prompt, budgets and the caller's signal.
* @returns the chunk stream to feed the assembler.
*/
async function callOptimizer(llm, target, request) {
	const base = {
		provider: target.provider,
		model: target.model,
		maxTokens: request.maxTokens,
		temperature: request.temperature
	};
	const passThrough = {
		messages: request.messages,
		system: request.system,
		signal: request.signal
	};
	if (typeof llm.prepareCall === "function") {
		let resolved = base;
		if (typeof llm.resolveCallConfig === "function") try {
			resolved = await llm.resolveCallConfig(base, request.signal);
		} catch (error) {
			throw new OptimizeUnavailableError({
				ok: false,
				stage: "call-config-failed",
				detail: `llm.resolveCallConfig(${target.provider}/${target.model}) 抛错：${firstLineOf(error)}`
			});
		}
		try {
			return (await llm.prepareCall(resolved, request.signal)).stream({
				...resolved,
				...passThrough
			});
		} catch (error) {
			if (error instanceof OptimizeUnavailableError) throw error;
			throw new OptimizeUnavailableError({
				ok: false,
				stage: "call-prepared-failed",
				detail: `llm.prepareCall(${target.provider}/${target.model}) 抛错：${firstLineOf(error)}`
			});
		}
	}
	if (typeof llm.stream === "function") return llm.stream({
		...base,
		...passThrough
	});
	throw new OptimizeUnavailableError({
		ok: false,
		stage: "llm-missing",
		detail: "llm 服务既没有 prepareCall 也没有 stream，无法发起调用。"
	});
}
/**
* Ask the conversation model to rewrite one Studio prompt.
*
* @param ctx - host context; `llm` is looked up here, never injected statically.
* @param input - the user's text plus whatever context the panel could supply.
* @param signal - aborts the upstream call when the panel cancels.
* @returns the rewritten prompt and its provenance.
* @throws When no model is reachable, or the model produced nothing usable —
*   both phrased for the user, since this surfaces in the panel's note line.
*/
async function optimizeStudioPrompt(ctx, input, signal) {
	const resolution = await resolveOptimizerFor(ctx);
	if (!resolution.ok) throw new OptimizeUnavailableError(resolution);
	const llm = llmOf(ctx);
	if (llm === void 0) throw new OptimizeUnavailableError({
		ok: false,
		stage: "llm-missing",
		detail: "llm 服务在解析目标之后变得不可用（宿主侧卸载？）"
	});
	const Assembler = await loadAssembler();
	if (Assembler === void 0) throw new OptimizeUnavailableError({
		ok: false,
		stage: "assembler-missing",
		detail: "宿主没有安装 @deepseek-ai/dsh-llm，取不到 BlockAssembler，无法拼装流式回复。"
	});
	const assembler = new Assembler();
	const stream = await callOptimizer(llm, {
		provider: resolution.provider,
		model: resolution.model
	}, {
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: buildOptimizeUserText(input)
			}]
		}],
		system: systemPromptFor(input.style),
		maxTokens: MAX_TOKENS,
		temperature: .7,
		signal
	});
	for await (const chunk of stream) assembler.push(chunk);
	if (signal.aborted) throw new Error("提示词优化已取消");
	const finish = assembler.finish;
	const failed = finish?.kind === "error" || finish?.kind === "aborted";
	const text = assembler.blocks().filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
	const split = splitOptimizerAnswer(text);
	const prompt = stripWrappingQuotes(split.prompt);
	if (prompt.length === 0) throw new Error(failed || text.trim().length === 0 ? "对话模型没有返回可用内容，请重试或换一个模型。" : "对话模型没有返回提示词，请重试或换一个模型。");
	return {
		prompt,
		model: resolution.model,
		...split.note === void 0 ? {} : { note: split.note }
	};
}
//#endregion
//#region src/studio-service.ts
/**
* Studio host service: the **ComfyUI-only** generation pipeline behind the
* panel, plus the capability snapshot the panel renders before its first click.
*
* This module owns no HTTP and no UI. It exposes three plain async functions
* that the routes in `studio-routes.ts` adapt to `IncomingMessage`, which keeps
* the whole pipeline testable without a socket and keeps the route file to
* request parsing and response framing.
*
* ## Why ComfyUI only
*
* The Studio is deliberately not a provider matrix. Qwen-Image 2.1 on the
* user's own ComfyUI is the one target: it needs no key, it reuses weights
* already on disk, and its canvas is the one thing the panel's ratio picker can
* honestly promise. Adding a second backend here would reintroduce exactly the
* per-provider option matrix this workbench exists to avoid.
*
* ## What it reuses
*
* Everything below the pipeline already exists and is left untouched:
* `discoverComfyUi` (port probing, loopback-only), `loadComfyModels` (resolves
* the three weight file names from `/object_info`), `generateViaComfyUi`, and
* `generateViaComfyUiEdit` (multi-reference editing). The Studio therefore
* inherits the same error text and the same "quote upstream, never swallow it"
* behaviour as the Agent tools — one behaviour, two front doors.
*
* @module studio-service
*/
/** ComfyUI options derived from the settings, in the shape the adapter expects. */
function comfyOptionsOf(settings, timeoutMs = settings.timeoutMs) {
	return comfyOptionsOf$1(settings, timeoutMs);
}
/**
* Map the plugin config onto what the Studio pipeline reads.
*
* Derived from the same fields `tools.ts` uses, so a settings change reaches the
* Agent tools and the Studio in one save rather than needing its own row.
*
* @param config - the resolved plugin config.
* @returns the subset the Studio consumes.
*/
function studioSettingsOf(config) {
	return {
		comfyEndpoint: config.comfyEndpoint,
		comfyPorts: parseComfyPorts(config.comfyPorts),
		comfyModelsDir: config.comfyModelsDir,
		timeoutMs: config.timeoutMs,
		outputDir: config.outputDir,
		defaultSteps: config.defaultSteps,
		comfyuiSteps: config.comfyuiSteps,
		comfyModel: config.comfyModel,
		mossSampling: config.mossSampling,
		turboSteps: config.turboSteps
	};
}
/**
* Steps a Studio request resolves to: its own value, else the family's default.
*
* The family decides which fallback applies: turbo never borrows the base
* checkpoint's 25 (handing 25 steps to a checkpoint distilled for 8 makes the
* picture worse), so an explicit `turboSteps` — else the distilled 8 — is what
* an omitted step count means for a turbo profile. The clamp is shared.
*
* The family is read off the **profile**, via its `variant`, exactly like
* `tools.ts` (`resolveTurboSteps` vs `resolveSteps`) does. Comparing
* `settings.comfyModel` against the literal `'turbo'` used to be the only test
* here and it could never be true: `resolveConfig` stores the canonical
* `qwen21-turbo`, so the turbo branch was dead and `turboSteps` never applied.
*
* A family that publishes more than one sampling register (MOSS-Image) supplies
* its own working point when a non-default register is selected — that is what
* {@link presetSteps} answers, and it is `undefined` for the default register and
* for both Qwen profiles, so the shared `comfyuiSteps` → `defaultSteps` chain is
* untouched everywhere else. An explicit `comfyuiSteps` still wins over the
* register, in either one.
*
* @param settings - resolved Studio settings.
* @param requested - the request's own step count, when it supplied one.
* @param profile - the profile that will **actually** run. Callers that have
*   already loaded `/object_info` pass `effectiveProfile(...)` so the step
*   fallback matches the graph that runs (a turbo request with no turbo weights
*   runs the base graph at the base default, not at 8). Omitted, it is the
*   requested profile — the right answer for a snapshot taken before any probe.
* @returns the step count to send, clamped to `1..200`.
*/
function resolveStudioSteps(settings, requested, profile = resolveProfile(settings.comfyModel)) {
	const fallback = profile.variant === "turbo" ? settings.turboSteps ?? 8 : settings.comfyuiSteps ?? presetSteps(profile, settings.mossSampling) ?? settings.defaultSteps;
	if (requested === void 0) return fallback;
	if (!Number.isFinite(requested)) return fallback;
	return Math.min(200, Math.max(1, Math.round(requested)));
}
/**
* Resolve one ratio to an aligned pixel pair.
*
* `resolveDefaultSize` is imported rather than `resolveSize` for a reason that
* matters: the seven official ratios are served from the calibrated
* `DEFAULT_SIZES` table, while `resolveSize` *searches* a pixel-budget grid and
* lands somewhere slightly different — 1216² instead of 1248² for a square, for
* instance. Using the search here would make the panel's picker label and the
* actual canvas disagree on four of the seven ratios. The Agent tool resolves
* through the same table, so both surfaces agree on what "16:9" means.
*
* @param ratio - a `W:H` string the panel offered.
* @returns the aligned size, or `undefined` when the ratio is not one of ours.
*/
function studioSize(ratio) {
	const match = WH_RATIOS.find((candidate) => candidate === ratio);
	if (match === void 0) return void 0;
	const size = resolveDefaultSize(match);
	return {
		width: size.width,
		height: size.height,
		ratio: match
	};
}
/** Every ratio with its resolved size, for the panel's picker labels. */
function studioSizeTable() {
	return WH_RATIOS.map((ratio) => {
		const size = resolveDefaultSize(ratio);
		return {
			ratio,
			width: size.width,
			height: size.height
		};
	});
}
/**
* Build the capability snapshot the panel reads on mount.
*
* The probe is best-effort and bounded: an unreachable ComfyUI yields
* `ready: false` plus a reason, never a thrown error, because a panel that can
* render its controls but not generate is far more useful than one that shows a
* blank error card. `optimizeAvailable` is resolved independently for the same
* reason — a missing LLM must not imply a missing ComfyUI.
*
* @param ctx - host context (for the `llm` lookup).
* @param settings - resolved Studio settings.
* @param signal - abandons the probe when the panel navigates away.
* @returns the snapshot; every field is present.
*/
async function describeStudio(ctx, settings, signal) {
	const sizes = studioSizeTable();
	const resolution = await resolveOptimizerFor(ctx);
	const optimizeAvailable = resolution.ok && await optimizerAvailable(ctx);
	let ready = false;
	let endpoint;
	let models;
	let reason;
	try {
		const target = await discoverComfyUi(comfyOptionsOf(settings, Math.min(settings.timeoutMs, 15e3)), signal);
		const resolved = await loadComfyModels(target, comfyOptionsOf(settings, Math.min(settings.timeoutMs, 2e4)), signal);
		endpoint = target.endpoint;
		models = resolved;
		ready = true;
	} catch (error) {
		reason = error instanceof Error ? error.message : String(error);
	}
	let boards = [];
	let active = null;
	let boardsNote;
	try {
		boards = await listBoards(settings.outputDir);
		const remembered = await activeBoardId(settings.outputDir);
		active = remembered !== null && boards.some((board) => board.id === remembered) ? remembered : boards[0]?.id ?? null;
	} catch (error) {
		boardsNote = firstLine(error);
	}
	return {
		ready,
		...endpoint === void 0 ? {} : { endpoint },
		...models === void 0 ? {} : { models: {
			unet: models.unet,
			clip: models.clip,
			vae: models.vae
		} },
		...reason === void 0 ? {} : { reason },
		defaultSteps: resolveStudioSteps(settings, void 0, models === void 0 ? resolveProfile(settings.comfyModel) : effectiveProfile(settings.comfyModel, models)),
		outputDir: settings.outputDir,
		sizes,
		optimizeAvailable,
		...resolution.ok ? { optimizeModel: resolution.model } : { optimizeNote: `[${resolution.stage}] ${resolution.detail}` },
		boards,
		activeBoard: active,
		...boardsNote === void 0 ? {} : { boardsNote }
	};
}
/** Decode canonical base64, rejecting anything that does not round-trip. */
function decodeBase64(value) {
	const bytes = Buffer.from(value, "base64");
	if (bytes.byteLength === 0) throw new Error("参考图内容为空");
	return new Uint8Array(bytes);
}
/** Containers the canvas may hand back as a reference; anything else is refused. */
const REFERENCE_EXTENSIONS = /* @__PURE__ */ new Set([
	".png",
	".jpg",
	".jpeg",
	".webp"
]);
/** Largest reference file the host will read off disk. */
const REFERENCE_MAX_BYTES = 33554432;
/**
* Read one reference from disk.
*
* This exists so the canvas can reuse a finished image without the browser ever
* holding its bytes. The path comes from the client, so it is checked rather
* than trusted: an image extension is required (this host only writes images)
* and the size is capped. It is not a general file-reading primitive.
*/
function readReferenceFile(path) {
	const extension = extname(path).toLowerCase();
	if (!REFERENCE_EXTENSIONS.has(extension)) throw new Error(`参考图必须是图片文件：${basename(path)}`);
	const info = statSync(path, { throwIfNoEntry: false });
	if (info === void 0 || !info.isFile()) throw new Error(`参考图不存在：${basename(path)}`);
	if (info.size > REFERENCE_MAX_BYTES) throw new Error(`参考图过大：${basename(path)}`);
	const bytes = readFileSync(path);
	if (bytes.byteLength === 0) throw new Error(`参考图内容为空：${basename(path)}`);
	return new Uint8Array(bytes);
}
/** Turn wire references into the adapter's payload shape. */
function referencePayloads(references) {
	if (references === void 0 || references.length === 0) return [];
	if (references.length > 10) throw new Error(`最多支持 ${String(10)} 张参考图`);
	return references.map((reference, index) => ({
		bytes: typeof reference.path === "string" && reference.path.length > 0 ? readReferenceFile(reference.path) : decodeBase64(reference.data ?? ""),
		mime: typeof reference.mediaType === "string" && reference.mediaType.length > 0 ? reference.mediaType : "image/png",
		label: reference.name ?? (typeof reference.path === "string" ? basename(reference.path) : void 0) ?? `参考图 ${String(index + 1)}`
	}));
}
/** Name prefix for the files one run writes; keeps Studio output distinguishable. */
function outputPrefix(referenceCount) {
	return referenceCount > 0 ? "studio-edit" : "studio";
}
/**
* Resolve the board id a run should be associated with, before submission.
*
* Mirrors the recording step's target choice (`input.board`, then the active
* board) without creating anything: a name is accepted as-is here because only
* the record step may create or resolve boards. Failures are swallowed — the
* hint is optional wire metadata, and a read-only metadata directory must not
* turn into a failed generation.
*
* @param outputDir - resolved Studio output directory.
* @param requested - the board the request named, already trimmed.
* @returns a board id or name to echo on the `run` event, when one is known.
*/
async function boardHintOf(outputDir, requested) {
	try {
		return requested ?? await activeBoardId(outputDir) ?? void 0;
	} catch {
		return;
	}
}
/**
* The adapter request for one Studio text-to-image run (C14/T21).
*
* Exported so the "no layout regression" is testable at the seam the adapter
* actually consumes: without `layout` the returned object has exactly the
* pre-T21 keys, so the rendered graph is byte-identical; with it, the compiled
* string rides along verbatim and the renderer swaps the positive encoder text.
*
* @param input - the request fields that reach the graph.
* @param resolved - final canvas size, count, resolved step count and seed.
* @returns the adapter request, with `layout` only when one was supplied.
*/
function studioTextToImageRequestOf(input, resolved) {
	return {
		prompt: input.prompt.trim(),
		width: resolved.width,
		height: resolved.height,
		count: resolved.count,
		steps: resolved.steps,
		seed: resolved.seed,
		...input.layout === void 0 ? {} : { layout: input.layout }
	};
}
/**
* Run one Studio generation end to end.
*
* The order matters: canvas and prompt are validated **before** any socket
* opens, so a malformed request never costs a ComfyUI round trip, and the
* images are written only after every byte came back, so a partial run leaves no
* half-written file (the writer already stages through `.partial-*` + rename).
*
* @param settings - resolved Studio settings (endpoint, limits, output dir).
* @param input - the validated request body.
* @param signal - cancellation; forwarded to every ComfyUI call.
* @param runs - session run registry for the canvas task association (DD7);
*   absent means the run is not observable from the SSE stream, which is the
*   pre-DD7 behaviour.
* @returns the written images plus the exact parameters that produced them.
* @throws With the user-facing message the panel shows verbatim.
*/
async function runStudioGeneration(settings, input, signal, runs) {
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (prompt.length === 0) throw new Error("请输入提示词");
	if (prompt.length > 4e3) throw new Error(`提示词最多 ${String(STUDIO_MAX_PROMPT_CHARS)} 个字符`);
	const size = studioSize(input.ratio);
	if (size === void 0) throw new Error(`不支持的画幅比例：${String(input.ratio)}`);
	let steps = resolveStudioSteps(settings, input.steps);
	const count = input.count === void 0 ? 1 : Math.trunc(input.count);
	if (!Number.isFinite(count) || count < 1 || count > 4) throw new Error(`出图张数只能是 1 到 ${String(4)}`);
	const seed = input.seed === void 0 || !Number.isFinite(input.seed) ? Math.floor(Math.random() * 2 ** 31) : Math.trunc(input.seed);
	const references = referencePayloads(input.references);
	const mode = references.length > 0 ? "edit" : "generate";
	const layout = typeof input.layout === "string" ? input.layout : void 0;
	if (layout !== void 0) {
		if (mode === "edit") throw new Error("布局（layout）只支持 MOSS 文生图；布局 + 参考图改图的叠加行为未定义（T21 边界），请去掉参考图或 layout。");
		const requestedLayoutProfile = resolveProfile(settings.comfyModel);
		if (requestedLayoutProfile.layoutTemplate === void 0) throw new Error("布局（layout）只对 MOSS-Image 生效——当前配置的 profile 是 " + requestedLayoutProfile.label + "；把 comfyModel 换成 moss-sft，或去掉 layout。");
		parseMossLayout(layout);
	}
	const requestedBoard = typeof input.board === "string" && input.board.trim().length > 0 ? input.board.trim() : void 0;
	const boardHint = await boardHintOf(settings.outputDir, requestedBoard);
	const startedAt = Date.now();
	const options = comfyOptionsOf(settings);
	let promptId;
	const clientId = input.clientId;
	const submitOptions = clientId === void 0 || runs === void 0 ? options : {
		...options,
		onPromptId: (id) => {
			promptId = id;
			runs.register(id, {
				clientId,
				...boardHint === void 0 ? {} : { boardId: boardHint }
			});
		}
	};
	let target;
	let models;
	let images;
	let turboFallback = false;
	try {
		target = await discoverComfyUi(options, signal);
		models = await loadComfyModels(target, options, signal);
		const requestedProfile = resolveProfile(settings.comfyModel);
		const profile = effectiveProfile(settings.comfyModel, models);
		const turbo = profile.variant === "turbo";
		turboFallback = requestedProfile.variant === "turbo" && !turbo;
		steps = resolveStudioSteps(settings, input.steps, profile);
		images = mode === "edit" ? await (turbo ? generateViaComfyUiTurboEdit : generateViaComfyUiEdit)(target, models, {
			prompt,
			width: size.width,
			height: size.height,
			count,
			steps,
			seed,
			images: references
		}, submitOptions, signal) : await (turbo ? generateViaComfyUiTurbo : generateViaComfyUi)(target, models, studioTextToImageRequestOf({
			prompt,
			...layout === void 0 ? {} : { layout }
		}, {
			width: size.width,
			height: size.height,
			count,
			steps,
			seed
		}), submitOptions, signal);
	} catch (error) {
		throw new Error(firstLine(error));
	} finally {
		if (promptId !== void 0) runs?.release(promptId);
	}
	const written = await writeImages(settings.outputDir, outputPrefix(references.length), size.width, size.height, images);
	const itemIds = written.map(() => makeItemId());
	let board;
	let boardNote;
	try {
		const target = requestedBoard ?? await activeBoardId(settings.outputDir) ?? void 0;
		const recorded = await recordItems(settings.outputDir, target, written.map((image, index) => ({
			id: itemIds[index],
			path: image.path,
			markdownPath: image.markdownPath,
			width: size.width,
			height: size.height,
			bytes: image.bytes,
			mediaType: image.mime,
			prompt,
			ratio: size.ratio,
			steps,
			seed,
			mode,
			backend: "studio",
			parentPaths: (input.references ?? []).flatMap((reference) => typeof reference.path === "string" && reference.path.length > 0 ? [reference.path] : []),
			...input.parents === void 0 || input.parents.length === 0 ? {} : { parents: input.parents },
			sessionId: null
		})), { prompt });
		board = recorded.board;
		recorded.items.forEach((item, index) => {
			itemIds[index] = item.id;
		});
	} catch (error) {
		boardNote = firstLine(error);
	}
	return {
		images: written.map((image, index) => ({
			id: itemIds[index] ?? makeItemId(),
			path: image.path,
			markdownPath: image.markdownPath,
			width: size.width,
			height: size.height,
			bytes: image.bytes,
			mediaType: image.mime
		})),
		prompt,
		ratio: size.ratio,
		width: size.width,
		height: size.height,
		steps,
		seed,
		elapsedMs: Date.now() - startedAt,
		endpoint: target.endpoint,
		mode,
		turboFallback,
		...board === void 0 ? {} : { board },
		...boardNote === void 0 ? {} : { boardNote }
	};
}
//#endregion
//#region src/studio-routes.ts
/** Heartbeat cadence while a long request is in flight; tests shrink it. */
const HEARTBEAT_MS = 15e3;
/** Body cap for the environment route: three short strings, never a picture. */
const ENVIRONMENT_MAX_BODY_BYTES = 8192;
/**
* Single-flight lock for the environment actions, module level on purpose.
*
* `isConcurrencySafe: false` on the Agent tool only serialises *tool* calls; the
* panel's buttons are HTTP requests and two fast clicks would otherwise spawn two
* renderers, each convinced it owns the only record. `status` deliberately does
* not take the lock — a read must not be refused because a start is in flight.
*/
let environmentActionInFlight = null;
/** Wrap one handler so a thrown error becomes a JSON 500 instead of a dead socket. */
function guard(handler) {
	return async (req, res) => {
		try {
			await handler(req, res);
		} catch (error) {
			if (res.headersSent || res.writableEnded || res.destroyed) return;
			json(res, 500, { error: firstLine(error) });
		}
	};
}
/** Register the Studio's routes (JSON endpoints plus one SSE stream) on the host web server. */
function registerStudioRoutes(ctx, deps) {
	const server = ctx.webServer;
	if (server === void 0 || typeof server.register !== "function") return [];
	const runs = deps.runs ?? createRunRegistry();
	const progress = createProgressBridge({
		settings: deps.settings,
		runs,
		...deps.progress ?? {}
	});
	const disposers = [
		server.register({
			kind: "exact",
			path: STUDIO_CONFIG_ROUTE,
			handler: guard(async (req, res) => {
				if (req.method !== "GET") return jsonError(res, 405, "method-not-allowed");
				if (!sameOrigin(req)) return jsonError(res, 403, "origin-rejected");
				const controller = new AbortController();
				res.once("close", () => {
					if (!res.writableEnded) controller.abort();
				});
				json(res, 200, await describeStudio(deps.ctx, deps.settings(), controller.signal));
			})
		}),
		server.register({
			kind: "exact",
			path: STUDIO_LOG_ROUTE,
			handler: guard(async (req, res) => {
				if (req.method !== "GET") return jsonError(res, 405, "method-not-allowed");
				if (!sameOrigin(req)) return jsonError(res, 403, "origin-rejected");
				const requested = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("path") ?? "";
				if (requested.length === 0) return jsonError(res, 400, "缺少 path 参数");
				if (!isAbsolute(requested)) return jsonError(res, 400, "必须是绝对路径");
				const name = basename(requested);
				if (!((name.startsWith("dsh-image-forge-launch-") || name === "comfyui.log") && name.endsWith(".log"))) return jsonError(res, 400, "只允许读取 ComfyUI 启动日志");
				const target = resolve(requested);
				if (!target.includes("/logs/") && !target.includes("\\logs\\")) return jsonError(res, 400, "日志文件必须位于 logs 目录内");
				let text;
				try {
					text = (await readFile(target)).toString("utf8");
				} catch {
					return jsonError(res, 404, "日志文件不存在或不可读");
				}
				const tail = text.split(/\r?\n/).slice(-200).join("\n");
				res.writeHead(200, {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-store"
				});
				res.end(tail);
			})
		}),
		server.register({
			kind: "exact",
			path: STUDIO_ENVIRONMENT_ROUTE,
			handler: guard(async (req, res) => {
				if (!sameOrigin(req)) return jsonError(res, 403, "origin-rejected");
				if (req.method !== "POST") return jsonError(res, 405, "method-not-allowed");
				if (!isJson(req)) return jsonError(res, 415, "json-required");
				let request;
				try {
					request = parseEnvironmentAction(JSON.parse(await readBody(req, ENVIRONMENT_MAX_BODY_BYTES)));
				} catch (error) {
					return jsonError(res, 400, firstLine(error));
				}
				const action = request.action ?? "status";
				const options = deps.environment?.options?.() ?? environmentOptionsOf(deps.settings());
				const machine = deps.environment?.deps ?? {};
				if (action === "status") {
					const status = await inspectEnvironment(options, machine);
					let weights;
					try {
						const endpoint = status.state === "ready" ? status.endpoint ?? null : null;
						const base = await resolveModelsBase({ endpoint }, machine);
						weights = weightsReportOf(await ensureProfileWeights({
							profileId: deps.settings().comfyModel,
							base: base.base,
							endpoint,
							dryRun: true,
							deps: machine
						}));
					} catch {
						weights = void 0;
					}
					return json(res, 200, {
						environment: environmentSnapshotOf(status),
						...weights === void 0 ? {} : { weights }
					});
				}
				if (environmentActionInFlight !== null) return json(res, 409, { error: environmentActionInFlight === "start" ? "正在启动 ComfyUI（一次只拉起一个），请等这次请求返回。" : environmentActionInFlight === "download" ? "正在下载权重（一次只下一组），请等这次请求返回。" : "正在停止 ComfyUI，请等这次请求返回。" });
				environmentActionInFlight = action;
				if (action === "download") {
					res.writeHead(200, {
						"content-type": "application/x-ndjson; charset=utf-8",
						"cache-control": "no-store",
						"x-accel-buffering": "no"
					});
					const writeLine = (value) => {
						if (res.destroyed || res.writableEnded) return;
						try {
							res.write(JSON.stringify(value) + "\n");
						} catch {}
					};
					const heartbeat = setInterval(() => {
						if (!res.destroyed && !res.writableEnded) res.write("\n");
					}, HEARTBEAT_MS);
					try {
						const status = await inspectEnvironment(options, machine);
						const endpoint = status.state === "ready" ? status.endpoint ?? null : null;
						const base = await resolveModelsBase({ endpoint }, machine);
						const dryRun = request.confirm !== true;
						const outcome = await ensureProfileWeights({
							profileId: deps.settings().comfyModel,
							base: base.base,
							endpoint,
							dryRun,
							deps: machine,
							onProgress: (progress) => {
								writeLine({ weightProgress: progress });
							}
						});
						writeLine({
							environment: environmentSnapshotOf(status),
							weights: weightsReportOf(outcome)
						});
					} catch (error) {
						writeLine({ error: firstLine(error) });
					} finally {
						clearInterval(heartbeat);
						environmentActionInFlight = null;
						if (!res.destroyed && !res.writableEnded) res.end();
					}
					return;
				}
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
					"x-accel-buffering": "no"
				});
				const heartbeat = setInterval(() => {
					if (!res.destroyed && !res.writableEnded) res.write("\n");
				}, HEARTBEAT_MS);
				try {
					if (action === "start") {
						const status = await ensureEnvironment(options, machine);
						if (!res.destroyed && !res.writableEnded) {
							const body = { environment: environmentSnapshotOf(status) };
							res.end(JSON.stringify(body));
						}
						return;
					}
					const stop = await stopEnvironment(machine);
					const status = await inspectEnvironment(options, machine);
					if (!res.destroyed && !res.writableEnded) {
						const body = {
							environment: environmentSnapshotOf(status),
							stop: environmentStopOf(stop)
						};
						res.end(JSON.stringify(body));
					}
				} catch (error) {
					if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify({ error: firstLine(error) }));
				} finally {
					clearInterval(heartbeat);
					environmentActionInFlight = null;
				}
			})
		}),
		server.register({
			kind: "exact",
			path: STUDIO_GENERATE_ROUTE,
			handler: guard(async (req, res) => {
				if (!sameOrigin(req)) return jsonError(res, 403, "origin-rejected");
				if (req.method !== "POST") return jsonError(res, 405, "method-not-allowed");
				if (!isJson(req)) return jsonError(res, 415, "json-required");
				const controller = new AbortController();
				res.once("close", () => {
					if (!res.writableEnded) controller.abort(/* @__PURE__ */ new Error("浏览器关闭了请求"));
				});
				let input;
				try {
					input = parseGenerate(JSON.parse(await readBody(req, STUDIO_MAX_BODY_BYTES)));
				} catch (error) {
					return jsonError(res, 400, firstLine(error));
				}
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
					"x-accel-buffering": "no"
				});
				const heartbeat = setInterval(() => {
					if (!res.destroyed && !res.writableEnded) res.write("\n");
				}, HEARTBEAT_MS);
				try {
					const output = await runStudioGeneration(deps.settings(), input, controller.signal, runs);
					if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify(output));
				} catch (error) {
					if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify({ error: firstLine(error) }));
				} finally {
					clearInterval(heartbeat);
				}
			})
		}),
		server.register({
			kind: "exact",
			path: STUDIO_OPTIMIZE_ROUTE,
			handler: guard(async (req, res) => {
				if (!sameOrigin(req)) return jsonError(res, 403, "origin-rejected");
				if (req.method !== "POST") return jsonError(res, 405, "method-not-allowed");
				if (!isJson(req)) return jsonError(res, 415, "json-required");
				const controller = new AbortController();
				res.once("close", () => {
					if (!res.writableEnded) controller.abort(/* @__PURE__ */ new Error("浏览器关闭了请求"));
				});
				let input;
				try {
					input = parseOptimize(JSON.parse(await readBody(req, 262144)));
				} catch (error) {
					return jsonError(res, 400, firstLine(error));
				}
				try {
					json(res, 200, await optimizeStudioPrompt(deps.ctx, input, controller.signal));
				} catch (error) {
					const stage = error instanceof OptimizeUnavailableError ? error.stage : void 0;
					json(res, 502, {
						error: firstLine(error),
						...stage === void 0 ? {} : { stage }
					});
				}
			})
		}),
		server.register({
			kind: "exact",
			path: STUDIO_BOARDS_ROUTE,
			handler: guard(async (req, res) => {
				if (req.method !== "GET") return jsonError(res, 405, "method-not-allowed");
				if (!sameOrigin(req)) return jsonError(res, 403, "origin-rejected");
				const outputDir = deps.settings().outputDir;
				const boards = await listBoards(outputDir);
				const remembered = await activeBoardId(outputDir);
				json(res, 200, {
					boards,
					active: remembered !== null && boards.some((board) => board.id === remembered) ? remembered : boards[0]?.id ?? null
				});
			})
		}),
		server.register({
			kind: "exact",
			path: STUDIO_BOARD_ROUTE,
			handler: guard(async (req, res) => {
				if (!sameOrigin(req)) return jsonError(res, 403, "origin-rejected");
				const outputDir = deps.settings().outputDir;
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				if (req.method === "GET") {
					const id = url.searchParams.get("board") ?? "";
					if (id.length === 0) return jsonError(res, 400, "缺少 board 参数");
					const board = await readBoard(outputDir, id);
					if (board === void 0) return jsonError(res, 404, "画板不存在");
					return json(res, 200, board);
				}
				if (req.method !== "POST") return jsonError(res, 405, "method-not-allowed");
				if (!isJson(req)) return jsonError(res, 415, "json-required");
				let action;
				try {
					action = parseBoardAction(JSON.parse(await readBody(req, 262144)));
				} catch (error) {
					return jsonError(res, 400, firstLine(error));
				}
				switch (action.action) {
					case "workspace-get": {
						const raw = await readWorkspaceFile(outputDir);
						if (raw === void 0) return json(res, 200, {
							ok: true,
							workspace: null
						});
						return json(res, 200, {
							ok: true,
							workspace: toWorkspaceJson(stateFromWorkspace(raw, { boardIds: (await listBoards(outputDir)).map((board) => board.id) }))
						});
					}
					case "workspace-set": {
						if (typeof action.workspace !== "object" || action.workspace === null) return jsonError(res, 400, "缺少 workspace 参数");
						const known = await listBoards(outputDir);
						const normalized = toWorkspaceJson(stateFromWorkspace(action.workspace, { boardIds: known.map((board) => board.id) }));
						if (!await writeWorkspaceFile(outputDir, normalized)) return jsonError(res, 500, "工作区记录写入失败");
						await setActiveBoard(outputDir, normalized.activeTab.kind === "projects" ? null : normalized.activeTab.boardId ?? null);
						return json(res, 200, { ok: true });
					}
					case "create": {
						const board = await createBoard(outputDir, action.name);
						await setActiveBoard(outputDir, board.id);
						return json(res, 200, {
							ok: true,
							board
						});
					}
					case "duplicate": {
						const id = await targetBoardId(outputDir, action.board);
						if (id === void 0) return jsonError(res, 404, "画板不存在");
						let copy;
						try {
							copy = await duplicateBoard(outputDir, id, action.name);
						} catch (error) {
							return jsonError(res, 409, firstLine(error));
						}
						if (copy === void 0) return jsonError(res, 404, "画板不存在");
						return json(res, 200, {
							ok: true,
							board: copy.board,
							droppedParents: copy.droppedParents
						});
					}
					case "rename": {
						const id = await targetBoardId(outputDir, action.board);
						if (id === void 0) return jsonError(res, 404, "画板不存在");
						const board = await renameBoard(outputDir, id, action.name ?? "");
						if (board === void 0) return jsonError(res, 400, "请输入画板名称");
						return json(res, 200, {
							ok: true,
							board
						});
					}
					case "layout": {
						const id = await targetBoardId(outputDir, action.board);
						if (id === void 0) return jsonError(res, 404, "画板不存在");
						const board = await saveLayout(outputDir, id, {
							items: action.items ?? [],
							...action.camera === void 0 ? {} : { camera: action.camera }
						});
						if (board === void 0) return jsonError(res, 404, "画板不存在");
						return json(res, 200, {
							ok: true,
							board
						});
					}
					case "remove-item": {
						const id = await targetBoardId(outputDir, action.board);
						if (id === void 0) return jsonError(res, 404, "画板不存在");
						if (typeof action.item !== "string" || action.item.length === 0) return jsonError(res, 400, "缺少 item 参数");
						const result = await removeItem(outputDir, id, action.item, { deleteFile: action.deleteFile === true });
						if (result === void 0) return jsonError(res, 404, "这张图不在画板里");
						return json(res, 200, {
							ok: true,
							removed: result.removed,
							fileDeleted: result.fileDeleted
						});
					}
					case "copy-item":
					case "move-item": {
						const source = await targetBoardId(outputDir, action.board);
						if (source === void 0) return jsonError(res, 404, "画板不存在");
						const target = await targetBoardId(outputDir, action.toBoard);
						if (target === void 0) return jsonError(res, 404, "目标画板不存在");
						if (typeof action.item !== "string" || action.item.length === 0) return jsonError(res, 400, "缺少 item 参数");
						const spot = action.x === void 0 || action.y === void 0 ? void 0 : {
							x: action.x,
							y: action.y
						};
						const result = action.action === "copy-item" ? await copyItem(outputDir, source, action.item, target, spot) : await moveItem(outputDir, source, action.item, target, spot);
						if (result === void 0) return jsonError(res, 404, "这张图不在画板里");
						return json(res, 200, {
							ok: true,
							item: result.item,
							board: result.board
						});
					}
					case "save-task": {
						if (action.task === void 0) return jsonError(res, 400, "缺少 task 参数");
						const written = await saveTaskItem(outputDir, action.board, {
							...action.item === void 0 ? {} : { id: action.item },
							...action.x === void 0 ? {} : { x: action.x },
							...action.y === void 0 ? {} : { y: action.y },
							...action.parents === void 0 ? {} : { parents: action.parents },
							task: action.task
						});
						if (written === void 0) return jsonError(res, 400, "任务条目写入失败");
						return json(res, 200, {
							ok: true,
							item: written.item,
							board: written.board
						});
					}
					case "save-layout-node": {
						if (action.draft === void 0 || action.w === void 0 || action.h === void 0) return jsonError(res, 400, "缺少布局草稿或显示尺寸");
						const written = await saveLayoutItem(outputDir, action.board, {
							...action.item === void 0 ? {} : { id: action.item },
							...action.x === void 0 ? {} : { x: action.x },
							...action.y === void 0 ? {} : { y: action.y },
							...action.parents === void 0 ? {} : { parents: action.parents },
							draft: action.draft,
							w: action.w,
							h: action.h
						});
						if (written === void 0) return jsonError(res, 400, "布局条目写入失败");
						return json(res, 200, {
							ok: true,
							item: written.item,
							board: written.board
						});
					}
					case "delete": {
						const id = await targetBoardId(outputDir, action.board);
						if (id === void 0) return jsonError(res, 404, "画板不存在");
						const result = await removeBoard(outputDir, id, { deleteFiles: action.deleteFiles === true });
						if (result.removed && await activeBoardId(outputDir) === id) await setActiveBoard(outputDir, null);
						return json(res, 200, {
							ok: result.removed,
							filesDeleted: result.filesDeleted,
							filesKept: result.filesKept
						});
					}
					case "active": {
						const id = await targetBoardId(outputDir, action.board);
						if (id === void 0) return jsonError(res, 404, "画板不存在");
						await setActiveBoard(outputDir, id);
						return json(res, 200, { ok: true });
					}
				}
			})
		}),
		server.register({
			kind: "exact",
			path: STUDIO_IMPORT_ROUTE,
			handler: guard(async (req, res) => {
				if (!sameOrigin(req)) return jsonError(res, 403, "origin-rejected");
				if (req.method !== "POST") return jsonError(res, 405, "method-not-allowed");
				if (!isJson(req)) return jsonError(res, 415, "json-required");
				let input;
				try {
					input = parseImport(JSON.parse(await readBody(req, STUDIO_IMPORT_MAX_BODY_BYTES)));
				} catch (error) {
					return jsonError(res, 400, firstLine(error));
				}
				let decoded;
				try {
					const bytes = decodeImportData(input.data);
					const size = probeImageSize(bytes);
					if (size === void 0) throw new Error("只支持 PNG / JPEG / WebP 图片");
					decoded = {
						bytes,
						...size
					};
				} catch (error) {
					return jsonError(res, 400, firstLine(error));
				}
				const outputDir = deps.settings().outputDir;
				const [written] = await writeImages(outputDir, sanitizePrefix(input.name.replace(/\.[^./\\]+$/, ""), "import"), decoded.width, decoded.height, [{
					bytes: decoded.bytes,
					mime: decoded.mime
				}]);
				const position = input.x === void 0 || input.y === void 0 ? {} : {
					x: input.x,
					y: input.y
				};
				const write = await recordItems(outputDir, input.board, [{
					path: written.path,
					markdownPath: written.markdownPath,
					width: decoded.width,
					height: decoded.height,
					bytes: written.bytes,
					mediaType: decoded.mime,
					prompt: "",
					mode: "generate",
					backend: "studio",
					parents: [],
					...position
				}]);
				const item = write.items[0];
				if (item === void 0) return jsonError(res, 500, "导入失败：条目未落盘");
				json(res, 200, {
					item,
					board: write.board
				});
			})
		}),
		server.register({
			kind: "exact",
			path: STUDIO_ASSETS_ROUTE,
			handler: guard(async (req, res) => {
				if (req.method !== "GET") return jsonError(res, 405, "method-not-allowed");
				if (!sameOrigin(req)) return jsonError(res, 403, "origin-rejected");
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				const limit = Number(url.searchParams.get("limit") ?? "");
				json(res, 200, await listAssets(deps.settings().outputDir, {
					...url.searchParams.get("board") === null ? {} : { board: url.searchParams.get("board") ?? "" },
					...url.searchParams.get("q") === null ? {} : { q: url.searchParams.get("q") ?? "" },
					...Number.isFinite(limit) && limit > 0 ? { limit } : {}
				}));
			})
		}),
		server.register({
			kind: "exact",
			path: STUDIO_FILE_ROUTE,
			handler: guard(async (req, res) => {
				if (req.method !== "GET") return jsonError(res, 405, "method-not-allowed");
				if (!sameOrigin(req)) return jsonError(res, 403, "origin-rejected");
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				const requested = url.searchParams.get("path") ?? "";
				if (requested.length === 0) return jsonError(res, 400, "缺少 path 参数");
				if (!isAbsolute(requested)) return jsonError(res, 400, "必须是绝对路径");
				const thumbWidth = parseStudioThumbWidth(url.searchParams.get("w"));
				if (thumbWidth === null) return jsonError(res, 400, `w 只接受 ${STUDIO_THUMB_WIDTHS.join(" / ")} 这几档`);
				if (STUDIO_FILE_TYPES[basename(requested).toLowerCase().match(/\.[^.]+$/)?.[0] ?? ""] === void 0) return jsonError(res, 415, "只支持 PNG / JPEG / WebP");
				const target = resolve(requested);
				const resolvedType = STUDIO_FILE_TYPES[basename(target).toLowerCase().match(/\.[^.]+$/)?.[0] ?? ""];
				if (resolvedType === void 0) return jsonError(res, 415, "只支持 PNG / JPEG / WebP");
				let stats;
				try {
					stats = await stat(target);
				} catch {
					return jsonError(res, 404, "文件不存在");
				}
				if (!stats.isFile()) return jsonError(res, 404, "不是文件");
				if (thumbWidth !== void 0) {
					const thumb = await thumbFor(deps.settings().outputDir, target, stats, thumbWidth);
					if (thumb !== void 0) {
						if (thumb.kind === "cached") {
							let thumbStats;
							try {
								thumbStats = await stat(thumb.path);
							} catch {
								thumbStats = stats;
								res.writeHead(200, {
									"content-type": resolvedType,
									"content-length": String(stats.size),
									"x-dsh-thumb": "original",
									"cache-control": "private, max-age=86400, immutable"
								});
								await pipeline(createReadStream(target), res);
								return;
							}
							res.writeHead(200, {
								"content-type": "image/png",
								"content-length": String(thumbStats.size),
								"x-dsh-thumb": "cached",
								"cache-control": "private, max-age=86400, immutable"
							});
							await pipeline(createReadStream(thumb.path), res);
							return;
						}
						res.writeHead(200, {
							"content-type": "image/png",
							"content-length": String(thumb.bytes.length),
							"x-dsh-thumb": "generated",
							"cache-control": "private, max-age=86400, immutable"
						});
						res.end(thumb.bytes);
						return;
					}
				}
				res.writeHead(200, {
					"content-type": resolvedType,
					"content-length": String(stats.size),
					...thumbWidth === void 0 ? {} : { "x-dsh-thumb": "original" },
					"cache-control": "private, max-age=86400, immutable"
				});
				await pipeline(createReadStream(target), res);
			})
		}),
		server.register({
			kind: "exact",
			path: STUDIO_EVENTS_ROUTE,
			handler: guard(async (req, res) => {
				if (req.method !== "GET") return jsonError(res, 405, "method-not-allowed");
				if (!sameOrigin(req)) return jsonError(res, 403, "origin-rejected");
				res.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-store",
					"x-accel-buffering": "no",
					connection: "keep-alive"
				});
				res.write(": connected\n\n");
				res.on("error", () => {});
				const unsubscribe = progress.subscribe((event) => writeEvent(res, event));
				const heartbeat = setInterval(() => {
					if (res.destroyed || res.writableEnded) return;
					try {
						res.write(": keep-alive\n\n");
					} catch {}
				}, HEARTBEAT_MS);
				try {
					await new Promise((resolve) => {
						res.once("close", () => {
							resolve();
						});
						res.once("finish", () => {
							resolve();
						});
					});
				} finally {
					clearInterval(heartbeat);
					unsubscribe();
				}
			})
		})
	];
	disposers.push(() => progress.stop());
	return disposers;
}
/** Board a mutation targets: the explicit one, else the active board. */
async function targetBoardId(outputDir, requested) {
	const wanted = typeof requested === "string" ? requested.trim() : "";
	const candidate = wanted.length > 0 ? wanted : await activeBoardId(outputDir);
	if (candidate === null) return void 0;
	return (await readBoard(outputDir, candidate))?.id;
}
/**
* Validate the generation body; every field is narrowed before it is trusted.
*
* Reference images are checked for shape only — the adapter sniffs the real
* container from the bytes, and a wrong `mediaType` claim must not reach a
* filename that `LoadImage` then refuses.
*
* @param value - parsed JSON of unknown shape.
* @returns the validated request.
* @throws With a message meant for the panel.
*/
function parseGenerate(value) {
	const body = record(value);
	if (body === void 0) throw new Error("请求格式无效");
	const prompt = requiredText(body.prompt, "请输入提示词", STUDIO_MAX_PROMPT_CHARS);
	const ratio = requiredText(body.ratio, "请选择画幅比例", 16);
	if (!STUDIO_RATIOS.includes(ratio)) throw new Error(`不支持的画幅比例：${ratio}`);
	const steps = optionalInteger(body.steps, "步数");
	const seed = optionalInteger(body.seed, "种子");
	const count = optionalInteger(body.count, "出图张数");
	const references = body.references === void 0 ? void 0 : parseReferences(body.references);
	const board = typeof body.board === "string" && body.board.trim().length > 0 ? body.board.trim().slice(0, 80) : void 0;
	const clientId = parseClientId(body.clientId);
	const layout = body.layout === void 0 ? void 0 : parseLayoutText(body.layout);
	const parents = parseParentIds(body.parents);
	return {
		prompt,
		ratio,
		...steps === void 0 ? {} : { steps },
		...seed === void 0 ? {} : { seed },
		...count === void 0 ? {} : { count },
		...references === void 0 || references.length === 0 ? {} : { references },
		...board === void 0 ? {} : { board },
		...clientId === void 0 ? {} : { clientId },
		...layout === void 0 ? {} : { layout },
		...parents === void 0 ? {} : { parents }
	};
}
/**
* Validate one compiled MOSS layout prompt (T21's shape).
*
* The length cap comes first so an abusive string is refused before parsing;
* the shared parser then names the failing field (`bbox_coord_space`,
* `summary.caption`, …), exactly like the Agent tool does.
*/
function parseLayoutText(value) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error("layout 必须是布局编辑器导出的 compiled JSON 字符串");
	if (value.length > 65536) throw new Error("layout 最多 " + String(STUDIO_MAX_LAYOUT_CHARS) + " 个字符");
	parseMossLayout(value);
	return value;
}
/** Actions the board route accepts. */
const BOARD_ACTIONS = [
	"create",
	"rename",
	"duplicate",
	"layout",
	"remove-item",
	"delete",
	"active",
	"copy-item",
	"move-item",
	"save-task",
	"save-layout-node",
	"workspace-get",
	"workspace-set"
];
/**
* Validate one board mutation.
*
* The action is a closed set — an unknown one is refused rather than ignored,
* because a typo in the panel would otherwise look like a successful save.
* Positions are capped in count and checked for finiteness; the store ignores
* ids it does not know, so a stale panel cannot break a board.
*
* @param value - parsed JSON of unknown shape.
* @returns the validated action.
* @throws With a message meant for the panel.
*/
function parseBoardAction(value) {
	const body = record(value);
	if (body === void 0) throw new Error("请求格式无效");
	const action = body.action;
	if (typeof action !== "string" || !BOARD_ACTIONS.includes(action)) throw new Error(`未知的画板操作：${String(action)}`);
	const board = typeof body.board === "string" && body.board.trim().length > 0 ? body.board.trim().slice(0, 80) : void 0;
	const name = typeof body.name === "string" ? body.name.slice(0, 120) : void 0;
	const item = typeof body.item === "string" && body.item.trim().length > 0 ? body.item.trim().slice(0, 80) : void 0;
	const deleteFile = body.deleteFile === true;
	const deleteFiles = body.deleteFiles === true;
	const items = Array.isArray(body.items) ? body.items.slice(0, 2e3).map(parsePosition).filter(isPosition) : void 0;
	const camera = parseCamera(body.camera);
	const toBoard = typeof body.toBoard === "string" && body.toBoard.trim().length > 0 ? body.toBoard.trim().slice(0, 80) : void 0;
	if ((action === "copy-item" || action === "move-item") && toBoard === void 0) throw new Error("缺少目标画板（toBoard）");
	const x = parseCoordinate(body.x);
	const y = parseCoordinate(body.y);
	const parents = parseParentIds(body.parents);
	const task = body.task === void 0 ? void 0 : parseBoardTask(body.task);
	const draft = body.draft === void 0 ? void 0 : parseBoardDraft(body.draft);
	const workspace = body.workspace;
	const w = parseCoordinate(body.w);
	const h = parseCoordinate(body.h);
	if (action === "save-task" && task === void 0) throw new Error("缺少 task（失败/中断状态与参数快照）");
	if (action === "save-layout-node") {
		if (draft === void 0) throw new Error("缺少 draft（布局草稿）");
		if (w === void 0 || h === void 0) throw new Error("缺少布局节点的显示尺寸（w / h）");
	}
	return {
		action,
		...action === "workspace-set" && typeof workspace === "object" && workspace !== null ? { workspace } : {},
		...board === void 0 ? {} : { board },
		...name === void 0 ? {} : { name },
		...item === void 0 ? {} : { item },
		...deleteFile ? { deleteFile } : {},
		...deleteFiles ? { deleteFiles } : {},
		...items === void 0 ? {} : { items },
		...camera === void 0 ? {} : { camera },
		...toBoard === void 0 ? {} : { toBoard },
		...x === void 0 || y === void 0 ? {} : {
			x,
			y
		},
		...parents === void 0 ? {} : { parents },
		...task === void 0 ? {} : { task },
		...draft === void 0 ? {} : { draft },
		...w === void 0 ? {} : { w },
		...h === void 0 ? {} : { h }
	};
}
/**
* One layout entry: a position, and — since G26 — optionally the lineage it
* gained on the canvas.
*
* `parents` rides along because adding an edge is not a new board action: the
* canvas already writes positions through `layout`, and one write per change is
* what keeps the store from needing a second, conflicting ordering. The field is
* **optional and additive**: an entry without it produces exactly the object this
* parser produced before, so every existing caller (and every stored test) is
* byte-identical.
*
* Unlike the top-level `parents` of `save-task`/`save-layout-node`, a bad value
* here is **dropped, not refused**: a position is still worth saving even if the
* lineage payload is malformed, and refusing the whole write would lose the
* drag the user just made.
*/
function parsePosition(value) {
	const entry = record(value);
	if (entry === void 0) return void 0;
	if (typeof entry.id !== "string" || entry.id.length === 0) return void 0;
	if (typeof entry.x !== "number" || !Number.isFinite(entry.x)) return void 0;
	if (typeof entry.y !== "number" || !Number.isFinite(entry.y)) return void 0;
	const parents = parsePositionParents(entry.parents);
	return {
		id: entry.id.slice(0, 80),
		x: entry.x,
		y: entry.y,
		...parents === void 0 ? {} : { parents }
	};
}
/** Parent ids of one layout entry, with anything unrecognisable dropped. */
function parsePositionParents(value) {
	if (!Array.isArray(value)) return void 0;
	const ids = value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim().slice(0, 80)).slice(0, 32);
	return ids.length === 0 ? void 0 : ids;
}
function isPosition(value) {
	return value !== void 0;
}
/** Canvas parent ids: strings only, capped, unknown ids are harmless downstream. */
function parseParentIds(value) {
	if (value === void 0 || value === null) return void 0;
	if (!Array.isArray(value)) throw new Error("parents 必须是数组");
	const ids = value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim().slice(0, 80)).slice(0, 32);
	return ids.length === 0 ? void 0 : ids;
}
/** One terminal task node: only failure/interruption are storable (DD6, §4.6). */
function parseBoardTask(value) {
	const body = record(value);
	if (body === void 0) throw new Error("task 格式无效");
	const status = body.status;
	if (status !== "failed" && status !== "interrupted") throw new Error("task.status 只能是 failed 或 interrupted（运行中的任务不落盘）");
	const params = record(body.params);
	if (params === void 0 || typeof params.prompt !== "string" || params.prompt.trim().length === 0) throw new Error("task.params.prompt 必须是非空字符串");
	return {
		status,
		params,
		...typeof body.error === "string" ? { error: body.error.slice(0, 400) } : {}
	};
}
/** A layout draft as stored: shape only, deep validation happens at compile time. */
function parseBoardDraft(value) {
	const body = record(value);
	if (body === void 0) throw new Error("draft 格式无效");
	const { width, height } = body;
	if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) throw new Error("draft.width 必须是正数");
	if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) throw new Error("draft.height 必须是正数");
	if (!Array.isArray(body.items)) throw new Error("draft.items 必须是数组");
	return body;
}
function parseCamera(value) {
	const camera = record(value);
	if (camera === void 0) return void 0;
	const { x, y, zoom } = camera;
	if (typeof x !== "number" || !Number.isFinite(x)) return void 0;
	if (typeof y !== "number" || !Number.isFinite(y)) return void 0;
	if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom <= 0) return void 0;
	return {
		x,
		y,
		zoom
	};
}
/** A finite coordinate, or `undefined` when the field is absent or malformed. */
function parseCoordinate(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
	return value;
}
/**
* Validate one imported image (DD10).
*
* Shape only: the bytes are decoded and sniffed by the route, because the
* container claim in `mediaType` is untrusted input like any other.
*
* @param value - parsed JSON of unknown shape.
* @returns the validated import request.
* @throws With a message meant for the panel.
*/
function parseImport(value) {
	const body = record(value);
	if (body === void 0) throw new Error("请求格式无效");
	const name = typeof body.name === "string" && body.name.trim().length > 0 ? body.name.trim().slice(0, 120) : void 0;
	if (name === void 0) throw new Error("缺少文件名");
	if (typeof body.data !== "string" || body.data.length === 0) throw new Error("缺少图片内容");
	const mediaType = typeof body.mediaType === "string" ? body.mediaType.slice(0, 80) : void 0;
	const board = typeof body.board === "string" && body.board.trim().length > 0 ? body.board.trim().slice(0, 80) : void 0;
	const x = parseCoordinate(body.x);
	const y = parseCoordinate(body.y);
	return {
		name,
		data: body.data,
		...mediaType === void 0 ? {} : { mediaType },
		...board === void 0 ? {} : { board },
		...x === void 0 || y === void 0 ? {} : {
			x,
			y
		}
	};
}
/**
* Decode an import body's base64 into bytes, bounded before allocation.
*
* The length check runs on the string first: a body that could not decode to
* an allowed file is refused without allocating it. Only canonical base64 is
* accepted — `Buffer.from` tolerates a lot of junk, and "it decoded" is not
* the same as "it is what the panel sent".
*
* @param data - base64 payload from the request.
* @returns the decoded bytes.
* @throws When empty, malformed or over the per-file cap.
*/
function decodeImportData(data) {
	const payload = data.replace(/\s+/g, "");
	if (payload.length === 0) throw new Error("缺少图片内容");
	const maxBase64 = Math.ceil(STUDIO_IMPORT_MAX_ITEM_BYTES / 3) * 4;
	if (payload.length > maxBase64) throw new Error(`图片超过 ${String(Math.trunc(STUDIO_IMPORT_MAX_ITEM_BYTES / 1024 / 1024))} MB 上限`);
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error("图片内容不是合法的 base64");
	const bytes = new Uint8Array(Buffer.from(payload, "base64"));
	if (bytes.byteLength === 0) throw new Error("图片内容解出来是空文件");
	if (bytes.byteLength > 33554432) throw new Error(`图片超过 ${String(Math.trunc(STUDIO_IMPORT_MAX_ITEM_BYTES / 1024 / 1024))} MB 上限`);
	return bytes;
}
/**
* Validate the optimiser body.
*
* Context is optional and capped: the panel sends at most a handful of turns,
* and a request that claims thousands is truncated rather than rejected —
* losing history is a quality problem, not a reason to refuse the rewrite.
*
* @param value - parsed JSON of unknown shape.
* @returns the validated request.
*/
function parseOptimize(value) {
	const body = record(value);
	if (body === void 0) throw new Error("请求格式无效");
	const prompt = requiredText(body.prompt, "请输入提示词", STUDIO_MAX_PROMPT_CHARS);
	const editing = body.editing === true;
	const ratio = typeof body.ratio === "string" && body.ratio.trim().length > 0 ? body.ratio.trim().slice(0, 16) : void 0;
	const context = Array.isArray(body.context) ? body.context.map(parseTurn).filter(isTurn).slice(0, 8) : void 0;
	const style = body.style === "formula" || body.style === "prose" ? body.style : void 0;
	return {
		prompt,
		editing,
		...ratio === void 0 ? {} : { ratio },
		...style === void 0 ? {} : { style },
		...context === void 0 || context.length === 0 ? {} : { context }
	};
}
/**
* Validate the environment body.
*
* A missing action means `status` — a read, and the safe default for a body that
* only meant to ask. An *unknown* action is refused rather than coerced: a typo
* must not silently become a read the panel then reports as a successful start.
*
* @param value - parsed JSON of unknown shape.
* @returns the validated request.
* @throws With a message meant for the panel.
*/
function parseEnvironmentAction(value) {
	const body = record(value);
	if (body === void 0) throw new Error("请求格式无效");
	const action = body.action;
	if (action === void 0 || action === null) return {};
	if (typeof action !== "string" || !STUDIO_ENVIRONMENT_ACTIONS.includes(action)) throw new Error(`未知的环境操作：${String(action)}`);
	const confirm = body.confirm === true;
	return {
		action,
		...confirm ? { confirm } : {}
	};
}
/**
* The weight pass, narrowed to the fields the panel renders.
*
* Kept separate from `ProfileWeightsOutcome` for the same reason the environment
* snapshot is separate from `EnvironmentStatus`: the wire copy carries only
* printable fields, so the drawer can render it without knowing the layer below.
*/
function weightsReportOf(outcome) {
	return {
		profile: outcome.profile,
		base: outcome.base,
		dryRun: outcome.dryRun,
		state: outcome.state,
		note: outcome.note,
		weights: outcome.weights.map((weight) => ({
			kind: weight.kind,
			filename: weight.filename,
			bytes: weight.bytes,
			targetPath: weight.targetPath,
			state: weight.state,
			note: weight.note
		}))
	};
}
/** The environment report, narrowed to the fields the panel renders. */
function environmentSnapshotOf(status) {
	const snapshot = {
		state: status.state,
		owned: status.owned === true
	};
	if (status.note.length > 0) snapshot.note = status.note;
	if (status.endpoint !== null) snapshot.endpoint = status.endpoint;
	if (status.port !== null) snapshot.port = status.port;
	if (status.pid !== null) snapshot.pid = status.pid;
	if (status.logPath !== null) snapshot.logPath = status.logPath;
	if (status.waitedMs !== null) snapshot.waitedMs = status.waitedMs;
	if (status.argvPreview !== null && status.argvPreview.length > 0) snapshot.argvPreview = [...status.argvPreview];
	if (status.hint !== null) snapshot.hint = status.hint;
	if (typeof status.ownershipNote === "string" && status.ownershipNote.length > 0) snapshot.ownershipNote = status.ownershipNote;
	return snapshot;
}
/** The stop report, narrowed to the fields the panel renders. */
function environmentStopOf(stop) {
	const report = { stopped: stop.stopped === true };
	if (stop.pid !== null) report.pid = stop.pid;
	if (stop.exitCode !== null) report.exitCode = stop.exitCode;
	report.reason = stop.reason;
	if (stop.verified !== null) report.verified = stop.verified;
	if (stop.note.length > 0) report.note = stop.note;
	return report;
}
/** One history turn, or `undefined` when it carries nothing usable. */ function parseTurn(value) {
	const turn = record(value);
	if (turn === void 0) return void 0;
	if (turn.role !== "user" && turn.role !== "assistant") return void 0;
	if (typeof turn.text !== "string") return void 0;
	const text = turn.text.trim();
	if (text.length === 0) return void 0;
	return {
		role: turn.role,
		text
	};
}
function isTurn(value) {
	return value !== void 0;
}
/** References: base64 plus a container hint, capped in count. */
function parseReferences(value) {
	if (!Array.isArray(value)) throw new Error("参考图格式无效");
	return value.map((entry, index) => {
		const reference = record(entry);
		if (reference === void 0) throw new Error("参考图格式无效");
		const mediaType = typeof reference.mediaType === "string" ? reference.mediaType : "image/png";
		const name = typeof reference.name === "string" && reference.name.trim().length > 0 ? reference.name.trim().slice(0, 120) : void 0;
		if (typeof reference.path === "string" && reference.path.trim().length > 0) {
			if (typeof reference.data === "string" && reference.data.length > 0) throw new Error(`第 ${String(index + 1)} 张参考图同时给了 path 和 data`);
			return {
				path: reference.path.trim(),
				mediaType,
				...name === void 0 ? {} : { name }
			};
		}
		if (typeof reference.data !== "string" || reference.data.length === 0) throw new Error(`第 ${String(index + 1)} 张参考图内容为空`);
		return {
			data: reference.data,
			mediaType,
			...name === void 0 ? {} : { name }
		};
	});
}
/**
* Accept the optional canvas task id.
*
* Absent means "an old panel / the Agent tools": the field is not added to the
* parsed body, so the request behaves exactly as before. A malformed value is
* refused rather than dropped — unlike the board route's per-entry coordinates,
* a clientId is a single value and a typo would silently disconnect a task node
* from every event of its own run.
*/
function parseClientId(value) {
	if (value === void 0 || value === null) return void 0;
	if (!isStudioClientId(value)) throw new Error("clientId 格式无效");
	return value;
}
function requiredText(value, message, maxLength) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(message);
	const text = value.trim();
	if (text.length > maxLength) throw new Error(`${message}（最多 ${String(maxLength)} 个字符）`);
	return text;
}
function optionalInteger(value, label) {
	if (value === void 0 || value === null) return void 0;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}必须是数字`);
	return Math.trunc(value);
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function isJson(req) {
	return (req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");
}
/** Same-origin check; a missing `origin` is a same-origin navigation. */
function sameOrigin(req) {
	const origin = req.headers.origin;
	const host = req.headers.host;
	return origin === void 0 || host === void 0 || origin === `http://${host}` || origin === `https://${host}`;
}
/** Read a body with the cap enforced during the read, not after. */
async function readBody(req, maxBytes) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > maxBytes) throw new Error(`请求体过大（上限 ${String(Math.trunc(maxBytes / 1024 / 1024))} MB）`);
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
function json(res, status, value) {
	if (res.headersSent || res.writableEnded || res.destroyed) return;
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(value));
}
function jsonError(res, status, message) {
	if (res.headersSent || res.writableEnded || res.destroyed) return;
	json(res, status, { error: message });
}
/**
* Write one SSE message.
*
* A vanished client is normal (the panel navigated away), so a failed write is
* swallowed: the response's `close` handler unsubscribes the stream a tick
* later, and there is nobody left to report the error to.
*/
function writeEvent(res, event) {
	if (res.destroyed || res.writableEnded) return;
	try {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	} catch {}
}
/** A CRC-32 table, built once (`node:zlib` does not expose one). */
const CRC_TABLE = (() => {
	const table = /* @__PURE__ */ new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 3988292384 ^ value >>> 1 : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();
/** CRC-32 of `bytes`, as PNG chunks require. */
function crc32(bytes) {
	let crc = 4294967295;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
	return (crc ^ 4294967295) >>> 0;
}
/**
* Decode a PNG's pixels.
*
* @param bytes - the file's bytes.
* @returns the decoded image, or `undefined` for any PNG this module will not
*   re-encode (see the section note). A `undefined` is not an error: the caller
*   serves the original file instead.
*/
function decodePng(bytes) {
	if (bytes.length < 8 || [
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	].some((byte, index) => bytes[index] !== byte)) return void 0;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const idat = [];
	while (offset + 12 <= bytes.length) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
		const dataStart = offset + 8;
		if (dataStart + length + 4 > bytes.length) return void 0;
		if (type === "IHDR") {
			if (length < 13) return void 0;
			width = view.getUint32(dataStart);
			height = view.getUint32(dataStart + 4);
			bitDepth = bytes[dataStart + 8];
			colorType = bytes[dataStart + 9];
			const interlace = bytes[dataStart + 12];
			if (bitDepth !== 8 || interlace !== 0) return void 0;
			if (colorType !== 0 && colorType !== 2 && colorType !== 4 && colorType !== 6) return void 0;
		} else if (type === "IDAT") idat.push(bytes.subarray(dataStart, dataStart + length));
		else if (type === "IEND") break;
		offset = dataStart + length + 4;
	}
	if (width <= 0 || height <= 0 || idat.length === 0) return void 0;
	const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
	const stride = width * channels;
	let raw;
	try {
		raw = inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk))));
	} catch {
		return;
	}
	if (raw.length < (stride + 1) * height) return void 0;
	const lines = new Uint8Array(stride * height);
	for (let y = 0; y < height; y += 1) {
		const filter = raw[y * (stride + 1)];
		const from = y * (stride + 1) + 1;
		const to = y * stride;
		const up = to - stride;
		for (let x = 0; x < stride; x += 1) {
			const value = raw[from + x];
			const left = x >= channels ? lines[to + x - channels] : 0;
			const above = y > 0 ? lines[up + x] : 0;
			const upLeft = y > 0 && x >= channels ? lines[up + x - channels] : 0;
			let reconstructed;
			switch (filter) {
				case 0:
					reconstructed = value;
					break;
				case 1:
					reconstructed = value + left;
					break;
				case 2:
					reconstructed = value + above;
					break;
				case 3:
					reconstructed = value + (left + above >> 1);
					break;
				case 4: {
					const estimate = left + above - upLeft;
					const toLeft = Math.abs(estimate - left);
					const toAbove = Math.abs(estimate - above);
					const toUpLeft = Math.abs(estimate - upLeft);
					reconstructed = value + (toLeft <= toAbove && toLeft <= toUpLeft ? left : toAbove <= toUpLeft ? above : upLeft);
					break;
				}
				default: return;
			}
			lines[to + x] = reconstructed & 255;
		}
	}
	const pixels = new Uint8Array(width * height * 4);
	for (let index = 0; index < width * height; index += 1) {
		const source = index * channels;
		const target = index * 4;
		if (channels === 1) {
			pixels[target] = lines[source];
			pixels[target + 1] = lines[source];
			pixels[target + 2] = lines[source];
			pixels[target + 3] = 255;
		} else if (channels === 2) {
			pixels[target] = lines[source];
			pixels[target + 1] = lines[source];
			pixels[target + 2] = lines[source];
			pixels[target + 3] = lines[source + 1];
		} else if (channels === 3) {
			pixels[target] = lines[source];
			pixels[target + 1] = lines[source + 1];
			pixels[target + 2] = lines[source + 2];
			pixels[target + 3] = 255;
		} else {
			pixels[target] = lines[source];
			pixels[target + 1] = lines[source + 1];
			pixels[target + 2] = lines[source + 2];
			pixels[target + 3] = lines[source + 3];
		}
	}
	return {
		width,
		height,
		pixels
	};
}
/** One PNG chunk: length, type, data, CRC. */
function pngChunk(type, data) {
	const out = Buffer.alloc(data.length + 12);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	Buffer.from(data).copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}
/**
* Encode RGBA pixels as a PNG.
*
* Filter 0 on every scanline: these are already-averaged thumbnail pixels, so an
* adaptive filter would buy a few percent for a lot more code.
*/
function encodePng(image) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(image.width, 0);
	header.writeUInt32BE(image.height, 4);
	header[8] = 8;
	header[9] = 6;
	const stride = image.width * 4;
	const raw = Buffer.alloc((stride + 1) * image.height);
	for (let y = 0; y < image.height; y += 1) {
		raw[y * (stride + 1)] = 0;
		Buffer.from(image.pixels.buffer, image.pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}
	return new Uint8Array(Buffer.concat([
		Buffer.from([
			137,
			80,
			78,
			71,
			13,
			10,
			26,
			10
		]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", /* @__PURE__ */ new Uint8Array(0))
	]));
}
/**
* Area-average an RGBA image down to `targetWidth`.
*
* A box filter, not nearest-neighbour: the point of the thumbnail is that a
* 2000-px picture still *looks* like itself at 512, and sampling one pixel in
* sixteen turns thin structures (whiskers, text) into confetti.
*
* @param image - decoded RGBA source.
* @param targetWidth - the requested width; a width >= the source is refused
*   here so the caller never touches a bigger file than the original.
* @returns the resized image, or `undefined` when no downscale is needed.
*/
function downscalePng(image, targetWidth) {
	if (targetWidth <= 0 || image.width <= targetWidth) return void 0;
	const targetHeight = Math.max(1, Math.round(image.height * targetWidth / image.width));
	const scaleX = image.width / targetWidth;
	const scaleY = image.height / targetHeight;
	const pixels = new Uint8Array(targetWidth * targetHeight * 4);
	for (let y = 0; y < targetHeight; y += 1) {
		const yFrom = Math.floor(y * scaleY);
		const yTo = Math.max(yFrom + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)));
		for (let x = 0; x < targetWidth; x += 1) {
			const xFrom = Math.floor(x * scaleX);
			const xTo = Math.max(xFrom + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)));
			let red = 0;
			let green = 0;
			let blue = 0;
			let alpha = 0;
			let count = 0;
			for (let sy = yFrom; sy < yTo; sy += 1) for (let sx = xFrom; sx < xTo; sx += 1) {
				const source = (sy * image.width + sx) * 4;
				red += image.pixels[source];
				green += image.pixels[source + 1];
				blue += image.pixels[source + 2];
				alpha += image.pixels[source + 3];
				count += 1;
			}
			const target = (y * targetWidth + x) * 4;
			pixels[target] = Math.round(red / count);
			pixels[target + 1] = Math.round(green / count);
			pixels[target + 2] = Math.round(blue / count);
			pixels[target + 3] = Math.round(alpha / count);
		}
	}
	return {
		width: targetWidth,
		height: targetHeight,
		pixels
	};
}
/** Where a given source file's thumbnail of `width` lives. */
function thumbPathOf(outputDir, target, stats, width) {
	const key = createHash("sha256").update(`${target}|${String(stats.size)}|${String(stats.mtimeMs)}`).digest("hex");
	return join(outputDir, STUDIO_THUMB_DIR, "thumbs", `${key.slice(0, 32)}-w${String(width)}.png`);
}
/**
* Produce (or find) the thumbnail for one file, falling back to the original.
*
* The contract the route relies on: **this never throws**. A JPEG, a 16-bit PNG,
* an unwritable cache directory or a corrupt IDAT all resolve to `undefined`,
* and the route streams the original file instead. A missing thumbnail is a
* performance problem; a 500 on an image is a broken canvas.
*/
async function thumbFor(outputDir, target, stats, width) {
	const cachePath = thumbPathOf(outputDir, target, stats, width);
	try {
		if ((await stat(cachePath)).isFile()) return {
			kind: "cached",
			path: cachePath
		};
	} catch {}
	let source;
	try {
		source = await readFile(target);
	} catch {
		return;
	}
	const decoded = decodePng(source);
	if (decoded === void 0) return void 0;
	const resized = downscalePng(decoded, width);
	if (resized === void 0) return void 0;
	const bytes = encodePng(resized);
	try {
		await mkdir(join(outputDir, STUDIO_THUMB_DIR, "thumbs"), { recursive: true });
		const staging = `${cachePath}.${String(process.pid)}.${String(Date.now())}.part`;
		await writeFile(staging, bytes);
		await rename(staging, cachePath);
	} catch {
		return {
			kind: "bytes",
			bytes
		};
	}
	return {
		kind: "bytes",
		bytes
	};
}
//#endregion
//#region src/tools.ts
/**
* The quality-tier parameters both image tools share.
*
* Optional and default-free on purpose: an omitted pair leaves the rendered graph
* byte-identical to the pre-tier request (`cfg` 1, empty negative prompt). The
* policy (which profiles accept them, the auto negative set, the range) lives in
* {@link resolveQualityTier}.
*/
const QUALITY_PARAMETERS = {
	cfg: {
		type: "number",
		description: "质量档 CFG（**只对 Qwen base 生效**；默认 1 = 官方口径，省略时请求与改动前逐字节一致）。cfg>1 时负向条件化才真正生效、更贴提示词，代价是每步多一次前向（耗时约翻倍）；2.5–3 是暂定区间（X02 盲测后校准）。turbo（ManualSigmas 蒸馏档）与 moss-sft（CFG 由采样档位管理）会拒绝该参数。"
	},
	negative_prompt: {
		type: "string",
		description: "负向提示词（**只对 Qwen base 生效**，且只在 cfg>1 时有效——cfg=1 时 ComfyUI 跳过负向条件化）。省略而 cfg>1 时会自动补默认负向词集（含 \"overly warm color temperature\"，压黄偏移），结果里会标明来源；cfg=1 时给负向词会被拒绝（否则会被静默忽略）。默认空 = 官方口径。"
	}
};
/**
* The optional advanced-sampler knobs both image tools carry.
*
* Default-free: an omitted pair keeps the profile's own sampler/scheduler
* (`euler` / `simple` for Qwen base), so a default call is byte-identical. The
* values are ComfyUI-native only — see `NATIVE_SAMPLERS` — and the policy (which
* profiles accept them) lives in {@link resolveSamplerOverrides}.
*/
const SAMPLER_PARAMETERS = {
	sampler: {
		type: "string",
		enum: NATIVE_SAMPLERS,
		description: "采样器（**只对 Qwen base 生效**；默认 euler = 官方模板与社区共识的安全组合，省略时请求与改动前逐字节一致）。可选值全部是 ComfyUI **原生**采样器（含 res_multistep、er_sde）；RES4LYF 等第三方节点包的组合**不内置**。替代组合的收益都是社区〔孤证/轶闻〕、无严格对照，换之前先用同 seed 对比。turbo（ManualSigmas 蒸馏档）与 moss-sft（采样器由 mossSampling 档位管理）会拒绝该参数。"
	},
	scheduler: {
		type: "string",
		enum: NATIVE_SCHEDULERS,
		description: "调度器（**只对 Qwen base 生效**；默认 simple = 官方模板口径）。只收 ComfyUI **原生**调度器 （simple / normal / karras / exponential / sgm_uniform / beta）；er_sde + beta 之类是社区的替代组合〔孤证〕，没有严格对照；官方仍推荐 euler/simple。第三方节点包的调度器（RES4LYF 等）**不内置**。turbo 与 moss-sft 会拒绝该参数。"
	}
};
/** The optional canvas-budget select both image tools carry. */
const SIZE_TIER_PARAMETER = {
	type: "string",
	enum: SIZE_TIERS,
	description: "画布像素预算档：`1.5mp`（默认，8GB 卡友好；七档 32 对齐，即本插件一直用的 ~1.5MP 表）或 `2k`（官方模型卡 4.2MP 七档表，1:1 = 2048×2048，16:9 = 2752×1536）。**画面里要出现文字时建议用 2k**（小字精度随分辨率提升）；2k 的像素约为默认档 2.8 倍，8GB 卡上显存与耗时风险明显。显式 `width`/`height` 优先于本档；4K 不是一个档（官方明确 4K 丢提示词贴合度）。"
};
/** Everything `qwen_image_generate` accepts, as one schema reused by validation. */
const GENERATE_PARAMETERS = {
	prompt: {
		type: "string",
		required: true,
		description: "成品提示词（已经按 Qwen 提示词契约改写好的那一段描述性散文）。本工具不做改写——把口语需求翻译成契约提示词是 skill `qwen-image-forge` 的职责，改写结果里的 wh_ratio 直接传给本参数旁边的 wh_ratio。"
	},
	wh_ratio: {
		type: "string",
		enum: WH_RATIOS,
		description: "画幅比（一等参数，官方 7 档）：1:1 / 4:3 / 3:4 / 3:2 / 2:3 / 16:9 / 9:16。本插件按 ~1.5MP 预算换算成 32 对齐的像素尺寸（换算表见 skill `qwen-image-forge` 正文「画幅比与像素」一节），因此契约里的 wh_ratio 不需要人工换算成宽高（`size_tier: 2k` 时换成官方 4.2MP 表）。省略时用 1:1；给了 width/height 时以 width/height 为准。"
	},
	size_tier: SIZE_TIER_PARAMETER,
	width: {
		type: "integer",
		description: `显式覆盖宽度（像素）。必须与 height 成对给出，且为 32 的倍数、位于 256–${MAX_SIDE}；不合法时会报错并给出最近的合法值。`
	},
	height: {
		type: "integer",
		description: `显式覆盖高度（像素）。规则同 width，必须与 width 成对给出。`
	},
	steps: {
		type: "integer",
		description: "采样步数；省略则按配置解析：`comfyuiSteps` → 采样档位自带步数（仅 MOSS：comfy 25 / official 50）→ 默认 `defaultSteps`（默认 40，仅无档位的 Qwen）；`comfyModel` 是 turbo 变体（`qwen21-turbo` / 旧值 `turbo`）时是 `turboSteps` → 8。结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型的建议值时再传。"
	},
	layout: {
		type: "string",
		description: "编译后的 MOSS 布局（compiled JSON 字符串，布局编辑器「导出 compiled」原文）：bbox_coord_space=abs_centralized、bbox_format=yxyx，items 为画框数组（label / caption / text / bbox），summary.caption 为整图描述（必填）。传了它，MOSS 的正向编码文本就是这段布局 prompt，画框控制构图。**仅 comfyModel=\"moss-sft\" 支持**（Qwen 两个 profile 没有布局通路，传了会明确报错）；省略则与之前逐字节一致的普通文生图。布局在本地编译并校验，不需要 ComfyUI 额外装节点（原生 MOSSImageLayoutPrompt 产出的就是同一份 JSON）。"
	},
	...QUALITY_PARAMETERS,
	...SAMPLER_PARAMETERS,
	seed: {
		type: "integer",
		description: "随机种子；同一 seed + 同一 prompt + 同一尺寸可复现同一张图。省略即随机。"
	},
	count: {
		type: "integer",
		description: "出图张数，1–4，默认 1。多张按后端返回顺序编号落盘。"
	},
	preset: {
		type: "string",
		description: "落盘文件名前缀标签，例如 \"poster\"；只影响命名（<outputDir>/<前缀>_<W>x<H>_<n>.png），不影响生成参数。省略时为 \"qwen\"。"
	},
	board: {
		type: "string",
		description: "画板 id 或名字——画板是成果的存储与显示单位（一个题材/一个项目一个画板），工作台的画布和素材页都按它组织。**省略就新建一个画板**（用提示词首行命名），结果里的 board.id 就是它；同一组图继续出图时把那个 id 传回来，成果才会落在同一个画板里，而不是又开一个。"
	}
};
/** Everything `qwen_image_edit` accepts. */
const EDIT_PARAMETERS = {
	prompt: {
		type: "string",
		required: true,
		description: "成品**修改指令**（已经按 Qwen 改图契约改写好的那一段，一整段、不要换行）。本工具不做改写——把口语需求翻译成改图契约是 skill `qwen-image-forge` 的职责（见 references/edit_rules.md）：只动点名要改的属性、其余按输入锁住，N ≥ 2 张参考图时用 `<image1>`、`<image2>`… 指代。"
	},
	images: {
		type: "array",
		items: { type: "string" },
		required: true,
		description: `参考图，1–10 张，按顺序对应提示词里的 \`<image1>\`…\`<imageN>\`（第 1 张是编辑目标）。每一项要么是**绝对路径**（如 D:\\pictures\\ref.png），要么是 \`data:image/png;base64,…\`。缺文件、不可读、不是 PNG/JPEG/WebP、超过上限都会**明确报错并点名第几张**，不会静默丢图——丢一张就会让提示词里的 \`<imageN>\` 全部错位。`
	},
	ratio_follow: {
		type: "string",
		description: "画布跟随某张参考图的宽高比：写官方的 `image1`…`image10`（第 N 张参考图），或直接写 `images` 里的那一项（绝对路径 / data URI）。本插件把该图的实际长宽比量出来，再挑 32 对齐像素里最接近的一对作为画布（偏差写进返回的 ratio_deviation_percent）。**与 wh_ratio 互斥**（官方契约里这两者一个非空另一个必须为空）；两个都不给时默认跟随**第一张**参考图（改图场景最符合直觉）。给了 width/height 时以它们为准。"
	},
	wh_ratio: {
		type: "string",
		enum: WH_RATIOS,
		description: `画布固定比例（官方 7 档）：${WH_RATIOS.join(" / ")}。与 ratio_follow **互斥**；本插件按 ~1.5MP 预算换算成 32 对齐的像素尺寸。省略且没给 ratio_follow 时，默认跟随第一张参考图（不是 1:1）。七档画布在 ComfyUI 改图工作流上都能跑；参考图会先缩放到与画布同量级再进条件化（官方模板的要求）。\`size_tier: 2k\` 时用官方 4.2MP 表（显存/耗时风险随之上升）。`
	},
	size_tier: SIZE_TIER_PARAMETER,
	width: {
		type: "integer",
		description: `显式覆盖宽度（像素）。必须与 height 成对给出，且为 32 的倍数、位于 256–${MAX_SIDE}；给了就以 width/height 为准（此时 ratio_follow / wh_ratio 被覆盖）。`
	},
	height: {
		type: "integer",
		description: "显式覆盖高度（像素）。规则同 width，必须与 width 成对给出。"
	},
	steps: {
		type: "integer",
		description: "采样步数；省略则按配置解析：`comfyuiSteps` → 采样档位自带步数（仅 MOSS：comfy 25 / official 50）→ 默认 `defaultSteps`（默认 40，仅无档位的 Qwen）；`comfyModel` 是 turbo 变体（`qwen21-turbo` / 旧值 `turbo`）时是 `turboSteps` → 8。结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型的建议值时再传。"
	},
	...QUALITY_PARAMETERS,
	...SAMPLER_PARAMETERS,
	seed: {
		type: "integer",
		description: "随机种子；同一 seed + 同一 prompt + 同一参考图 + 同一尺寸可复现同一张图。省略即随机。"
	},
	count: {
		type: "integer",
		description: "出图张数，1–4，默认 1。多张共用同一组参考图，按后端返回顺序编号落盘。"
	},
	preset: {
		type: "string",
		description: "落盘文件名前缀标签，例如 \"retouch\"；只影响命名（<outputDir>/<前缀>_<W>x<H>_<n>.png）。省略时为 \"edit\"。"
	},
	board: {
		type: "string",
		description: "画板 id 或名字。**省略就新建一个画板**；改图通常应落在参考图所在的那个画板里——如果你知道上一次出图返回的 board.id，就把它传进来，新图和它的来源才会在同一块画布上连起来。"
	}
};
/** Coerce a caller value that the schema may hand over as a loose number. */
function asInteger(value, label) {
	if (value === void 0) return void 0;
	if (!Number.isInteger(value)) throw new Error(`${label} must be an integer, got ${value}`);
	return value;
}
/** Coerce a caller value the schema typed as `number` (cfg is fractional). */
function asNumber(value, label) {
	if (value === void 0) return void 0;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number, got ${String(value)}`);
	return value;
}
/** Validate the optional `size_tier` select; absent means the shipped 1.5 MP table. */
function asSizeTier(value) {
	if (value === void 0) return DEFAULT_SIZE_TIER;
	if (!SIZE_TIERS.includes(value)) throw new Error(`size_tier must be one of ${SIZE_TIERS.join(" / ")}, got ${String(value)}`);
	return value;
}
/** Coerce a caller string, treating a blank one as absent. */
function asText(value, label) {
	if (value === void 0) return void 0;
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const trimmed = value.trim();
	return trimmed.length === 0 ? void 0 : trimmed;
}
/** Validate `count`, failing loudly instead of silently clamping. */
function validateCount(count) {
	if (count === void 0) return 1;
	if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error(`count must be an integer between 1 and 4, got ${count}`);
	return count;
}
/**
* Coerce a tool payload into **lossless JSON**.
*
* The DSH tool layer rejects a result whose value does not round-trip through
* JSON, and an object that still carries `undefined` properties does not:
* `JSON.stringify` drops the key, so `parse(stringify(x))` is missing it. A
* real client run of `qwen_image_status` failed exactly that way once
* (`value is not lossless JSON`) — this helper is the mechanical guarantee
* that a tool never hands the layer such a value again. `undefined` becomes
* `null` at every depth; everything else is left alone.
*
* @param value - the payload `execute` wants to return.
* @returns the same shape with `undefined` replaced by `null`.
*/
function jsonSafe(value) {
	return JSON.parse(JSON.stringify(value, (_key, inner) => inner === void 0 ? null : inner));
}
/** Build the Markdown block the model can paste into its reply verbatim. */
function renderMarkdown(images) {
	return images.map((image) => `![generated image](${image.markdownPath})`).join("\n");
}
/** First line of a failure, so the board note stays a note. */
function reasonOf(error) {
	return firstLine(error, error instanceof Error ? error.message : String(error));
}
/** Session id the host gave this call, when it gave one. */
function sessionOf(exec) {
	const id = exec.agent?.id;
	return typeof id === "string" && id.length > 0 ? id : void 0;
}
/**
* Record one run's images on a board.
*
* Deliberately non-fatal: the PNGs are already on disk, and a metadata failure
* must not turn a successful draw into a tool error. The note travels back in
* the payload so the failure is visible rather than silent.
*
* `requested` absent means **a new board** — the conversation path never
* guesses at the panel's open board, because the model is the only one who
* knows whether this draw continues the previous subject or starts a new one.
*
* @param outputDir - where the images and the board library live.
* @param requested - board id/name from the caller, or `undefined`.
* @param written - files already on disk.
* @param meta - provenance stored on every item.
* @returns ids in output order, the board summary, and any failure note.
*/
async function recordRun(outputDir, requested, written, meta) {
	const ids = written.map(() => makeItemId());
	try {
		const recorded = await recordItems(outputDir, requested, written.map((image, index) => ({
			id: ids[index],
			path: image.path,
			markdownPath: image.markdownPath,
			width: meta.width,
			height: meta.height,
			bytes: image.bytes,
			mediaType: image.mime,
			prompt: meta.prompt,
			ratio: meta.ratio,
			steps: meta.steps,
			seed: meta.seed ?? null,
			mode: meta.mode,
			backend: "comfyui",
			parents: [],
			parentPaths: meta.parentPaths,
			sessionId: meta.sessionId ?? null
		})), {
			prompt: meta.prompt,
			sessionId: meta.sessionId ?? null
		});
		recorded.items.forEach((item, index) => {
			ids[index] = item.id;
		});
		return {
			board: {
				id: recorded.board.id,
				name: recorded.board.name,
				created: recorded.created,
				item_ids: ids
			},
			note: null,
			ids
		};
	} catch (error) {
		return {
			board: null,
			note: reasonOf(error),
			ids
		};
	}
}
/**
* Decide the output size from `wh_ratio` and/or an explicit width/height pair.
*
* @param whRatio - caller ratio; defaults to `1:1` when nothing was supplied.
* @param width - explicit width, if any.
* @param height - explicit height, if any.
* @param tier - canvas-budget tier for the `wh_ratio` path; explicit sizes win.
* @returns the aligned size and the provenance of the decision.
* @throws When only one of width/height is given, or a side is not 32-aligned.
*/
function chooseSize(whRatio, width, height, tier = DEFAULT_SIZE_TIER) {
	if (width === void 0 !== (height === void 0)) throw new Error("width and height must be given together; pass neither to use wh_ratio");
	if (width !== void 0 && height !== void 0) {
		const size = validateSize(width, height);
		const nearest = nearestRatio(size.width, size.height);
		return {
			width: size.width,
			height: size.height,
			sizeSource: "explicit-size",
			whRatio: nearest.whRatio,
			ratioDeviationPercent: nearest.deviationPercent,
			exactRatio: Math.abs(nearest.deviationPercent) < .001,
			sizeTier: tier,
			sizeTierApplied: false
		};
	}
	const ratio = whRatio ?? "1:1";
	const size = resolveDefaultSize(ratio, tier);
	return {
		width: size.width,
		height: size.height,
		sizeSource: "wh_ratio",
		whRatio: ratio,
		ratioDeviationPercent: size.ratioDeviationPercent,
		exactRatio: size.exact,
		sizeTier: tier,
		sizeTierApplied: true
	};
}
/**
* Decide an edit call's canvas: explicit size, then `wh_ratio`, then `ratio_follow`.
*
* `wh_ratio` and `ratio_follow` are mutually exclusive — the prompt contract
* itself says one must be empty whenever the other is set — so supplying both is
* an error rather than a silent winner. `width`/`height` stay the plugin-level
* override they already are for `qwen_image_generate`, which is why they beat
* both ratio forms.
*
* @param whRatio - fixed ratio, if the caller gave one.
* @param ratioFollow - reference to follow, if the caller gave one.
* @param width - explicit width, if any.
* @param height - explicit height, if any.
* @param references - the loaded reference images, in prompt order.
* @param tier - canvas-budget tier for the ratio paths; explicit sizes win.
* @returns the aligned canvas and the provenance of the decision.
* @throws When `wh_ratio` and `ratio_follow` are both set, when only one of
*   width/height is given, when an explicit side is illegal, or when
*   `ratio_follow` names something the call does not carry.
*/
function chooseEditSize(whRatio, ratioFollow, width, height, references, tier = DEFAULT_SIZE_TIER) {
	const ratio = whRatio?.trim();
	const follow = ratioFollow?.trim();
	if (ratio !== void 0 && ratio.length > 0 && follow !== void 0 && follow.length > 0) throw new Error(`wh_ratio 与 ratio_follow 不能同时给（收到 wh_ratio="${ratio}"、ratio_follow="${follow}"）。\n  官方提示词契约把这两个字段定义成互斥的一对：ratio_follow 表示「画布跟随某张参考图的长宽比」，wh_ratio 表示「画布用这个固定比例」，两者都在指定画布比例，同时给出等于给了两个互相矛盾的口令，契约明说「一个非空另一个必须是空字符串」。请只留一个：
    • 跟随参考图 → 去掉 wh_ratio，保留 ratio_follow（或两者都不给，默认跟随第一张参考图）
    • 固定比例   → 去掉 ratio_follow，保留 wh_ratio`);
	if (width !== void 0 || height !== void 0) return {
		...chooseSize(void 0, width, height, tier),
		followed: null,
		followedByDefault: false
	};
	const defaulted = (follow === void 0 || follow.length === 0) && (ratio === void 0 || ratio.length === 0);
	if (defaulted || follow !== void 0 && follow.length > 0) {
		const reference = defaulted ? references[0] : resolveRatioFollow(follow, references);
		if (reference === void 0) throw new Error("ratio_follow needs at least one reference image");
		const size = resolveDefaultSize(`${reference.width}:${reference.height}`, tier);
		return {
			width: size.width,
			height: size.height,
			sizeSource: "ratio_follow",
			whRatio: nearestRatio(size.width, size.height).whRatio,
			ratioDeviationPercent: size.ratioDeviationPercent,
			exactRatio: size.exact,
			followed: reference,
			followedByDefault: defaulted,
			sizeTier: tier,
			sizeTierApplied: true
		};
	}
	return {
		...chooseSize(ratio, void 0, void 0, tier),
		followed: null,
		followedByDefault: false
	};
}
/** Everything the ComfyUI client needs from the resolved config. */
function comfyOptions(settings, timeoutMs = settings.timeoutMs) {
	return comfyOptionsOf$1(settings, timeoutMs);
}
/**
* Resolve everything the tool bodies need from the plugin config.
*
* @param config - the resolved plugin config.
* @returns the subset the tools read.
*/
function resolveSettings(config) {
	return {
		comfyEndpoint: config.comfyEndpoint.replace(/\/+$/, ""),
		comfyPorts: parseComfyPorts(config.comfyPorts),
		comfyModelsDir: config.comfyModelsDir,
		outputDir: config.outputDir,
		timeoutMs: config.timeoutMs,
		defaultSteps: config.defaultSteps,
		comfyuiSteps: config.comfyuiSteps,
		comfyModel: config.comfyModel,
		mossSampling: config.mossSampling,
		turboSteps: config.turboSteps
	};
}
function clampSteps(value) {
	return Math.min(200, Math.max(1, Math.round(value)));
}
/**
* Resolve the sampler steps one call should use.
*
* Priority, level for level the same chain `resolveStudioSteps` runs: the
* caller's explicit `steps` > the ComfyUI override (`comfyuiSteps`) > the
* selected sampling register's own working point ({@link presetSteps}) >
* `defaultSteps`. The register level is `undefined` for both Qwen profiles (no
* register table), so the shared fallback still decides those exactly as it did
* before registers existed; a family that publishes registers (MOSS) always
* reports its own count — 25 for the default register, 50 for `official` —
* because those are model properties, not a Qwen-tuned global.
*
* The count has to be resolved **here** and not left to the adapter: every
* dispatch site overwrites `request.steps` with the resolved `usedSteps.steps`,
* so `request.steps` is always defined by the time `textToImageValues` runs, and
* its `request.steps ?? sampling.steps.default` can never supply the register's
* 50. That is exactly why the Studio resolves it in `resolveStudioSteps` too.
*
* A register-sourced count reports `source: 'default'`: it is the family's own
* working point, not a user override (`'explicit'`) and not the shared ComfyUI
* override (`'backend'`) — the three values `docs/configuration.md` documents.
*/
function resolveSteps(explicit, settings, profile = resolveProfile(settings.comfyModel)) {
	if (explicit !== void 0) return {
		steps: clampSteps(explicit),
		source: "explicit"
	};
	if (typeof settings.comfyuiSteps === "number" && Number.isFinite(settings.comfyuiSteps) && settings.comfyuiSteps >= 1) return {
		steps: clampSteps(settings.comfyuiSteps),
		source: "backend"
	};
	const register = presetSteps(profile, settings.mossSampling);
	if (register !== void 0) return {
		steps: register,
		source: "default"
	};
	return {
		steps: settings.defaultSteps,
		source: "default"
	};
}
/**
* Steps for the turbo checkpoint: its own override, else the distilled default.
*
* Deliberately does **not** fall through to `defaultSteps` or `comfyuiSteps`:
* those are tuned for the base checkpoint (25), and handing 25 steps to a
* checkpoint distilled for 8 makes the picture worse, not better. An explicit
* `steps` from the caller still wins (clamped), because that is how the turbo
* contract gets checked on a real card.
*
* @param explicit - the caller's `steps`, when it supplied one.
* @param settings - the resolved plugin settings.
* @returns the count and where it came from.
*/
function resolveTurboSteps(explicit, settings) {
	if (explicit !== void 0) return {
		steps: clampSteps(explicit),
		source: "explicit"
	};
	if (typeof settings.turboSteps === "number" && Number.isFinite(settings.turboSteps) && settings.turboSteps >= 1) return {
		steps: clampSteps(settings.turboSteps),
		source: "backend"
	};
	return {
		steps: 8,
		source: "default"
	};
}
/**
* Resolve the optional quality tier (`cfg` / `negative_prompt`) for one call.
*
* Official 2.1 contract: `cfg` stays 1 unless a negative prompt is really wanted —
* at cfg 1 ComfyUI skips the negative conditioning pass, so a negative prompt
* without `cfg > 1` would be silently inert. That is why:
* - only the Qwen **base** profile exposes the tier (turbo's schedule is a fixed
*   ManualSigmas graph, and MOSS's CFG belongs to its sampling register);
* - `cfg > 1` with no negative prompt auto-fills {@link QUALITY_NEGATIVE_PROMPT},
*   and the result says which source was used;
* - a negative prompt at cfg <= 1 is refused instead of being swallowed;
* - the caller's own `steps`/`cfg` never change the defaults: an omitted pair
*   leaves the rendered graph byte-identical.
*
* 2.5–3 is the documented provisional range (`docs/qwen21-optimization.md` §四-3);
* X02 is the blind test that will calibrate it, so the note says so.
*
* @param profile - the profile the caller **asked for** (not a degraded one).
* @param cfg - explicit `cfg`, when the caller gave one.
* @param negativePrompt - explicit negative prompt, when the caller gave one.
* @returns the tier, or null when neither parameter was used (the default path).
* @throws When the profile does not own a KSampler CFG, the range is invalid, or a
*   negative prompt was given at cfg <= 1.
*/
function resolveQualityTier(profile, cfg, negativePrompt) {
	if (cfg === void 0 && negativePrompt === void 0) return null;
	if (profile.variant !== "base" || profile.family !== "qwen-image-2.1") {
		const why = profile.variant === "turbo" ? "turbo 走 SamplerCustomAdvanced + ManualSigmas 蒸馏档，CFG 与步数都由 sigma 表固定" : "MOSS 的 CFG 由采样档位 mossSampling 管理（comfy 2.5 / official 3）";
		throw new Error(`comfyui backend: 质量档（cfg / negative_prompt）只对 Qwen base 生效，当前请求的 profile 是 ${profile.label}——${why}。\n  质量档请在 comfyModel=qwen21-base 下使用；turbo 与 moss-sft 不接受这两个参数。`);
	}
	const resolved = cfg ?? profile.sampler.cfg;
	if (!Number.isFinite(resolved) || resolved < 1 || resolved > 5) throw new Error(`cfg must be between 1 and 5, got ${String(cfg)}`);
	if (resolved <= 1) {
		if (negativePrompt !== void 0) throw new Error("negative_prompt 只在 cfg > 1 时有效：cfg=1 时 ComfyUI 跳过负向条件化（官方口径），负向词会被静默忽略。\n  想用负向词就同时给 cfg（暂定 2.5–3；换来更贴提示词，代价是耗时约翻倍），否则去掉 negative_prompt。");
		return {
			cfg: resolved,
			negativePrompt: profile.negativePrompt,
			negativeSource: "profile",
			note: "cfg=1：负向条件化被 ComfyUI 跳过，本次请求与默认路径完全一致。"
		};
	}
	return {
		cfg: resolved,
		negativePrompt: negativePrompt ?? "overly warm color temperature, yellow tint, oversharpened edges, blurry, low quality, jpeg artifacts",
		negativeSource: negativePrompt === void 0 ? "auto" : "caller",
		note: `cfg=${resolved}：每步多跑一次负向条件化前向，耗时约翻倍（官方/社区口径）。2.5–3 是暂定区间（X02 盲测后校准）；4 以上容易过锐/过曝。`
	};
}
/** Minimum ComfyUI version that ships the `QwenImage21Cache` built-in node. */
const QWEN_CACHE_MIN_VERSION = "0.37.0";
/**
* Compare a ComfyUI version string against a minimum, semver-style.
*
* `/system_stats` reports `comfyui_version` like `0.45.3`. A non-numeric string
* (a dev build, the test fake's `fake-0.0`) cannot be ordered, so the answer is
* `null` — the status tool says "unknown" rather than guessing. Only the first
* three numeric components are compared.
*
* @param version - the reported version, or null when it could not be read.
* @param minimum - the required version, e.g. `0.37.0`.
* @returns true/false when comparable, null otherwise.
*/
function comfyVersionAtLeast(version, minimum) {
	const parse = (raw) => {
		const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
		return match === null ? void 0 : [
			Number(match[1]),
			Number(match[2]),
			Number(match[3])
		];
	};
	const actual = version === null ? void 0 : parse(version);
	const wanted = parse(minimum);
	if (actual === void 0 || wanted === void 0) return null;
	for (let index = 0; index < 3; index += 1) if (actual[index] !== wanted[index]) return actual[index] > wanted[index];
	return true;
}
/**
* Resolve the optional advanced-sampler knobs for one call.
*
* ComfyUI-native names only: a third-party sampler (RES4LYF's `abnorsett_3m`, …)
* is not shipped by this plugin, and an unknown name would only be rejected by
* ComfyUI after a GPU load. The tier is Qwen **base** only — turbo's sampler and
* schedule are fixed by the distilled `ManualSigmas` graph, and MOSS's sampler
* numbers belong to its `mossSampling` register. Both halves of the pair are
* optional; an omitted half keeps the profile's own value, so the default path
* renders a byte-identical graph.
*
* Community reports for these alternatives are single-source/no controlled
* comparison, so the result note says so rather than claiming a quality win.
*
* @param profile - the profile the caller **asked for** (not a degraded one).
* @param sampler - explicit `sampler`, when the caller gave one.
* @param scheduler - explicit `scheduler`, when the caller gave one.
* @returns the override pair, or null when neither parameter was used.
* @throws When the profile does not run a free `KSampler`, or a name is not
*   ComfyUI-native.
*/
function resolveSamplerOverrides(profile, sampler, scheduler) {
	if (sampler === void 0 && scheduler === void 0) return null;
	if (profile.variant !== "base" || profile.family !== "qwen-image-2.1") {
		const why = profile.variant === "turbo" ? "turbo 走 SamplerCustomAdvanced + ManualSigmas 蒸馏档，采样器与步数都由 sigma 表固定" : "MOSS 的采样器与调度器由采样档位 mossSampling 管理（comfy: er_sde/simple，official: euler/simple）";
		throw new Error(`comfyui backend: 高级采样器（sampler / scheduler）只对 Qwen base 生效，当前请求的 profile 是 ${profile.label}——${why}。\n  高级采样器请在 comfyModel=qwen21-base 下使用；turbo 与 moss-sft 不接受这两个参数。`);
	}
	const resolvedSampler = sampler ?? profile.sampler.name;
	const resolvedScheduler = scheduler ?? profile.sampler.scheduler;
	if (!NATIVE_SAMPLERS.includes(resolvedSampler)) throw new Error(`sampler must be one of ComfyUI's native samplers (${NATIVE_SAMPLERS.join(" / ")}), got "${String(sampler)}".\n  RES4LYF 等第三方节点包的采样器不内置：本插件不引入第三方节点包；确实要用请在 ComfyUI 里自己装，本插件不保证可用。`);
	if (!NATIVE_SCHEDULERS.includes(resolvedScheduler)) throw new Error(`scheduler must be one of ComfyUI's native schedulers (${NATIVE_SCHEDULERS.join(" / ")}), got "${String(scheduler)}"`);
	return {
		samplerName: resolvedSampler,
		scheduler: resolvedScheduler
	};
}
/** The tool-output blocks shared by generate and edit: summary, markdown, JSON. */
function renderResultBlocks(value) {
	const payload = value;
	const blocks = [];
	if (typeof payload.summary === "string") blocks.push({
		type: "text",
		text: payload.summary
	});
	if (typeof payload.markdown === "string" && payload.markdown.length > 0) blocks.push({
		type: "text",
		text: `已在对话里内联显示请**逐字复制**下面这几行到你的回复正文（客户端会把本地绝对路径渲染成图片）：\n${payload.markdown}`
	});
	blocks.push({
		type: "text",
		text: JSON.stringify(value, null, 2)
	});
	return blocks;
}
/**
* Register the tools on the tool registry.
*
* @param ctx - cordis context providing `tools`.
* @param getConfig - reads the activation's config **per call**: a settings
*   save commits into the volatile references without re-running `apply`, so a
*   snapshot taken at registration time would ignore every later edit.
*/
function registerImageForgeTools(ctx, getConfig) {
	ctx.tools.register(defineTool({
		name: "qwen_image_generate",
		description: `用 Qwen-Image 2.1 或 MOSS-Image 生图（本机 ComfyUI；底模由 \`comfyModel\` 选择：\`qwen21-base\` / \`qwen21-turbo\` 走 Qwen-Image 2.1，\`moss-sft\` 走 MOSS-Image）。\`prompt\` 收**成品**提示词（本工具不改写），\`wh_ratio\` 是**一等参数**：直接接受官方契约的 7 档画幅比（${WH_RATIOS.join(" / ")}），插件自己换算成 32 对齐的像素尺寸——所以「契约输出 → 插件入参」不需要人工翻译。省略 wh_ratio 用 1:1，给了 width/height 则以它们为准。结果落盘到配置的 outputDir 并把绝对路径写进正文 Markdown，同时回传结构化字段。需要本机 ComfyUI 已启动，且装好当前 \`comfyModel\` 那个 profile 的三个权重（默认 Qwen-Image 2.1；\`moss-sft\` 走 MOSS-Image；部署见 docs/comfyui-deployment.md）。`,
		parameters: GENERATE_PARAMETERS,
		output: {
			schema: { type: "json" },
			render: (_args, value) => renderResultBlocks(value)
		},
		timeoutMs: getConfig().timeoutMs,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const settings = resolveSettings(getConfig());
			const prompt = args.prompt.trim();
			if (prompt.length === 0) throw new Error("prompt must not be blank");
			const sizeTier = asSizeTier(args.size_tier);
			const size = chooseSize(args.wh_ratio, asInteger(args.width, "width"), asInteger(args.height, "height"), sizeTier);
			const count = validateCount(args.count);
			const steps = asInteger(args.steps, "steps");
			const requestedProfile = resolveProfile(settings.comfyModel);
			const quality = resolveQualityTier(requestedProfile, asNumber(args.cfg, "cfg"), asText(args.negative_prompt, "negative_prompt"));
			const layout = asText(args.layout, "layout");
			if (layout !== void 0) {
				if (requestedProfile.layoutTemplate === void 0) throw new Error("comfyui backend: 布局（layout）只对 MOSS-Image 生效——只有 moss-sft 的布局通路（compiled JSON 作为正向编码文本）存在，当前请求的 profile 是 " + requestedProfile.label + "。把 comfyModel 换成 moss-sft 再传 layout，或去掉该参数。");
				parseMossLayout(layout);
			}
			const request = {
				prompt,
				width: size.width,
				height: size.height,
				count,
				steps,
				seed: asInteger(args.seed, "seed")
			};
			const samplerOverrides = resolveSamplerOverrides(requestedProfile, args.sampler, args.scheduler);
			const overrides = {
				...quality === null ? {} : {
					cfg: quality.cfg,
					negativePrompt: quality.negativePrompt
				},
				...samplerOverrides === null ? {} : samplerOverrides,
				...layout === void 0 ? {} : { layout }
			};
			const startedAt = Date.now();
			const options = comfyOptions(settings);
			const target = await discoverComfyUi(options, exec.signal);
			const models = await loadComfyModels(target, options, exec.signal);
			const comfyStartedAt = Date.now();
			const profile = effectiveProfile(settings.comfyModel, models);
			const turbo = profile.variant === "turbo";
			const turboSkipped = requestedProfile.variant === "turbo" && !turbo;
			const usedSteps = turbo ? resolveTurboSteps(steps, settings) : resolveSteps(steps, settings, profile);
			const images = turbo ? await generateViaComfyUiTurbo(target, models, {
				...request,
				...overrides,
				steps: usedSteps.steps
			}, options, exec.signal) : await generateViaComfyUi(target, models, {
				...request,
				...overrides,
				steps: usedSteps.steps
			}, options, exec.signal);
			const comfyRun = {
				endpoint: target.endpoint,
				port: target.port,
				probed: target.probed,
				models,
				comfyModel: profile.legacyLabel,
				profile: profile.id,
				cache: profile.family === "qwen-image-2.1" ? models.cache ? "on" : "skipped" : "n/a",
				...profile.family === "qwen-image-2.1" && !models.cache ? { cache_note: "本机 ComfyUI 的 /object_info 里没有 QwenImage21Cache 节点（需要 ≥ 0.37.0），本次跳过前缀缓存、图照常提交；升级 ComfyUI 后自动启用。" } : {},
				...turboSkipped ? { turbo_fallback: "已选 turbo，但 /object_info 里没有 turbo 权重，本次用 base 跑" } : {},
				elapsed_ms: Date.now() - comfyStartedAt
			};
			const backendLabel = `后端 comfyui / ${target.endpoint} / ${models.unet}` + (turbo ? "（turbo）" : profile.legacyLabel === "moss" ? "（MOSS）" : "");
			const prefix = sanitizePrefix(args.preset);
			const written = await writeImages(settings.outputDir, prefix, size.width, size.height, images);
			const markdown = renderMarkdown(written);
			const recording = await recordRun(settings.outputDir, args.board, written, {
				prompt,
				width: size.width,
				height: size.height,
				ratio: size.whRatio,
				steps: usedSteps.steps,
				seed: request.seed,
				mode: "generate",
				sessionId: sessionOf(exec)
			});
			return jsonSafe({
				ok: true,
				backend: "comfyui",
				model: models.unet,
				wh_ratio: size.whRatio,
				wh_ratio_requested: args.wh_ratio ?? null,
				size: {
					width: size.width,
					height: size.height
				},
				size_source: size.sizeSource,
				size_tier: size.sizeTier,
				size_tier_applied: size.sizeTierApplied,
				ratio_deviation_percent: size.ratioDeviationPercent,
				exact_ratio: size.exactRatio,
				count,
				steps: steps ?? null,
				steps_used: usedSteps.steps,
				steps_source: usedSteps.source,
				seed: request.seed ?? null,
				...quality === null ? {} : { quality: {
					cfg: quality.cfg,
					negative_prompt: quality.negativePrompt,
					negative_prompt_source: quality.negativeSource,
					note: quality.note
				} },
				...samplerOverrides === null ? {} : { sampling: {
					sampler: samplerOverrides.samplerName,
					scheduler: samplerOverrides.scheduler,
					default_pair: "euler/simple",
					note: "替代采样器/调度器组合是社区〔孤证/轶闻〕级证据、无严格对照；euler/simple 仍是官方+双源的安全默认。换组合请用同 seed 对比。"
				} },
				prompt_chars: prompt.length,
				output_dir: settings.outputDir,
				images: written.map((image) => ({
					index: image.index,
					path: image.path,
					bytes: image.bytes,
					mime: image.mime
				})),
				comfyui: comfyRun,
				board: recording.board,
				board_note: recording.note,
				markdown,
				summary: `出图完成：${written.length} 张，${size.width}×${size.height}（wh_ratio ${size.whRatio}${size.exactRatio ? "" : `，实际 ${size.ratioDeviationPercent > 0 ? "+" : ""}${size.ratioDeviationPercent}%`}），${backendLabel}，落盘 ${settings.outputDir}。` + (recording.board === null ? "画板未记录（见 board_note）。" : `画板「${recording.board.name}」${recording.board.created ? "（新建）" : ""}，id \`${recording.board.id}\`。`),
				elapsed_ms: Date.now() - startedAt
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "qwen_image_edit",
		description: `用 Qwen-Image 2.1 做**参考图编辑（图生图）**，在本机 ComfyUI 的官方改图工作流上运行：给 1 张或多张参考图 + 一段**成品修改指令**，出改好的图。\`images\` 收 1–10 张参考图（绝对路径或 data:image/…;base64,…，按顺序对应提示词里的 \`<image1>\`…\`<imageN>\`），\`ratio_follow\` 让画布**跟随某张参考图的宽高比**（写 \`image1\`…\`image10\`，或直接把 \`images\` 里的那一项再写一遍）；它与 \`wh_ratio\` **互斥**（官方契约里一个非空另一个必须为空），两个都不给时**默认跟随第一张参考图**。参考图先上传进 ComfyUI 的 input/ 目录。改图在 \`moss-sft\` 下走 MOSS-Image 自己的 edit LoRA 通路（ComfyUI 的 \`models/loras/\` 里缺该 LoRA 时会报错点名文件）；不会递一张忽略参考图的图上去。部署（ComfyUI 桌面版 + 三个权重）见 docs/comfyui-deployment.md。结果落盘到 outputDir 并把绝对路径写进正文 Markdown。`,
		parameters: EDIT_PARAMETERS,
		output: {
			schema: { type: "json" },
			render: (_args, value) => renderResultBlocks(value)
		},
		timeoutMs: getConfig().timeoutMs,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const settings = resolveSettings(getConfig());
			const prompt = args.prompt.trim();
			if (prompt.length === 0) throw new Error("prompt must not be blank");
			const references = await loadReferenceImages(args.images);
			const sizeTier = asSizeTier(args.size_tier);
			const size = chooseEditSize(args.wh_ratio, args.ratio_follow, asInteger(args.width, "width"), asInteger(args.height, "height"), references, sizeTier);
			const count = validateCount(args.count);
			const steps = asInteger(args.steps, "steps");
			const requestedProfile = resolveProfile(settings.comfyModel);
			const quality = resolveQualityTier(requestedProfile, asNumber(args.cfg, "cfg"), asText(args.negative_prompt, "negative_prompt"));
			if (quality !== null && quality.cfg > 1 && references.length > 1) throw new Error(`多参考图（${references.length} 张）+ cfg>1 会出 artifacts：真实 CFG 下多参考编辑不稳定（官方/社区孤证），已验证的只有单参考。\n  多参考保持 cfg=1（默认，与官方模板一致）；想试质量档请只保留 1 张参考图。`);
			const request = {
				prompt,
				width: size.width,
				height: size.height,
				count,
				steps,
				seed: asInteger(args.seed, "seed"),
				images: references
			};
			const samplerOverrides = resolveSamplerOverrides(requestedProfile, args.sampler, args.scheduler);
			const overrides = {
				...quality === null ? {} : {
					cfg: quality.cfg,
					negativePrompt: quality.negativePrompt
				},
				...samplerOverrides === null ? {} : samplerOverrides
			};
			const startedAt = Date.now();
			const options = comfyOptions(settings);
			const target = await discoverComfyUi(options, exec.signal);
			const models = await loadComfyModels(target, options, exec.signal);
			const comfyStartedAt = Date.now();
			const profile = effectiveProfile(settings.comfyModel, models);
			const turbo = profile.variant === "turbo";
			const turboSkipped = requestedProfile.variant === "turbo" && !turbo;
			const usedSteps = turbo ? resolveTurboSteps(steps, settings) : resolveSteps(steps, settings, profile);
			const images = turbo ? await generateViaComfyUiTurboEdit(target, models, {
				...request,
				...overrides,
				steps: usedSteps.steps
			}, options, exec.signal) : await generateViaComfyUiEdit(target, models, {
				...request,
				...overrides,
				steps: usedSteps.steps
			}, options, exec.signal);
			const comfyRun = {
				endpoint: target.endpoint,
				port: target.port,
				probed: target.probed,
				models,
				comfyModel: profile.legacyLabel,
				profile: profile.id,
				cache: profile.family === "qwen-image-2.1" ? models.cache ? "on" : "skipped" : "n/a",
				...profile.family === "qwen-image-2.1" && !models.cache ? { cache_note: "本机 ComfyUI 的 /object_info 里没有 QwenImage21Cache 节点（需要 ≥ 0.37.0），本次跳过前缀缓存、图照常提交；升级 ComfyUI 后自动启用。" } : {},
				...turboSkipped ? { turbo_fallback: "已选 turbo，但 /object_info 里没有 turbo 权重，本次用 base 跑" } : {},
				references_uploaded: references.map((reference) => reference.label),
				elapsed_ms: Date.now() - comfyStartedAt
			};
			const backendLabel = `后端 comfyui / ${target.endpoint} / ${models.unet}` + (turbo ? "（turbo）" : profile.legacyLabel === "moss" ? "（MOSS）" : "");
			const prefix = sanitizePrefix(args.preset, "edit");
			const written = await writeImages(settings.outputDir, prefix, size.width, size.height, images);
			const markdown = renderMarkdown(written);
			const recording = await recordRun(settings.outputDir, args.board, written, {
				prompt,
				width: size.width,
				height: size.height,
				ratio: size.whRatio,
				steps: usedSteps.steps,
				seed: request.seed,
				mode: "edit",
				parentPaths: references.map((reference) => reference.source),
				sessionId: sessionOf(exec)
			});
			const followed = size.followed;
			const followLabel = followed === null ? null : `image${followed.index}`;
			return jsonSafe({
				ok: true,
				backend: "comfyui",
				model: models.unet,
				wh_ratio: size.whRatio,
				wh_ratio_requested: args.wh_ratio ?? null,
				ratio_follow: followLabel,
				ratio_follow_requested: args.ratio_follow ?? null,
				ratio_follow_defaulted: size.followedByDefault,
				ratio_follow_image: followed === null ? null : {
					index: followed.index,
					source: followed.source,
					size: {
						width: followed.width,
						height: followed.height
					}
				},
				size: {
					width: size.width,
					height: size.height
				},
				size_source: size.sizeSource,
				size_tier: size.sizeTier,
				size_tier_applied: size.sizeTierApplied,
				ratio_deviation_percent: size.ratioDeviationPercent,
				exact_ratio: size.exactRatio,
				references: references.map((reference) => ({
					index: reference.index,
					source: reference.source,
					label: reference.label,
					mime: reference.mime,
					size: {
						width: reference.width,
						height: reference.height
					},
					bytes: reference.bytes.byteLength
				})),
				count,
				steps: steps ?? null,
				steps_used: usedSteps.steps,
				steps_source: usedSteps.source,
				seed: request.seed ?? null,
				...quality === null ? {} : { quality: {
					cfg: quality.cfg,
					negative_prompt: quality.negativePrompt,
					negative_prompt_source: quality.negativeSource,
					note: quality.note
				} },
				...samplerOverrides === null ? {} : { sampling: {
					sampler: samplerOverrides.samplerName,
					scheduler: samplerOverrides.scheduler,
					default_pair: "euler/simple",
					note: "替代采样器/调度器组合是社区〔孤证/轶闻〕级证据、无严格对照；euler/simple 仍是官方+双源的安全默认。换组合请用同 seed 对比。"
				} },
				prompt_chars: prompt.length,
				output_dir: settings.outputDir,
				images: written.map((image) => {
					const measured = probeImageSize(images[image.index - 1]?.bytes ?? /* @__PURE__ */ new Uint8Array());
					return {
						index: image.index,
						path: image.path,
						bytes: image.bytes,
						mime: measured?.mime ?? image.mime,
						width: measured?.width ?? null,
						height: measured?.height ?? null
					};
				}),
				comfyui: comfyRun,
				board: recording.board,
				board_note: recording.note,
				markdown,
				summary: `改图完成：${written.length} 张，${size.width}×${size.height}（` + (followLabel === null ? `wh_ratio ${size.whRatio}` : `ratio_follow ${followLabel}${size.followedByDefault ? "（默认跟随第一张参考图）" : ""} ← ${followed?.width}×${followed?.height}`) + `${size.exactRatio ? "" : `，实际 ${size.ratioDeviationPercent > 0 ? "+" : ""}${size.ratioDeviationPercent}%`}），${references.length} 张参考图，${backendLabel}，落盘 ${settings.outputDir}。` + (recording.board === null ? "画板未记录（见 board_note）。" : `画板「${recording.board.name}」${recording.board.created ? "（新建）" : ""}，id \`${recording.board.id}\`。`),
				elapsed_ms: Date.now() - startedAt
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "qwen_image_status",
		description: "后端健康探测：**本机 ComfyUI 是否在跑**（含探测过哪几个端口、当前 `comfyModel` 那个 profile 的三个权重能不能被它的加载器枚举到、显卡型号与显存余量），以及输出目录能不能写。不产生任何图片、不写盘、不改配置。排障时先跑它。",
		parameters: { timeoutMs: {
			type: "integer",
			description: "本次探测的超时预算（毫秒），默认取插件配置的 timeoutMs 与 10 秒中的较小值。"
		} },
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		timeoutMs: 3e4,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const settings = resolveSettings(getConfig());
			const budget = Math.min(args.timeoutMs ?? settings.timeoutMs, 3e4);
			const comfyui = await probeComfyUi(comfyOptions(settings, budget), exec.signal);
			const endpoint = typeof comfyui.endpoint === "string" ? comfyui.endpoint : void 0;
			const stats = endpoint === void 0 ? null : await comfySystemStats(endpoint, Math.min(budget, 5e3), exec.signal);
			const reachable = comfyui.reachable === true;
			const version = stats?.version ?? null;
			const cacheSupported = comfyVersionAtLeast(version, QWEN_CACHE_MIN_VERSION);
			const cacheNote = cacheSupported === null ? `读不到可比较的 ComfyUI 版本（${version ?? "null"}），无法判断 QwenImage21Cache（需要 ≥ ${QWEN_CACHE_MIN_VERSION}）是否支持；出图时按 /object_info 自动降级，不会失败。` : cacheSupported ? `版本满足 QwenImage21Cache（需要 ≥ ${QWEN_CACHE_MIN_VERSION}）；节点是否真的存在仍以出图时的 /object_info 为准，缺失会自动跳过。` : `本机 ComfyUI 低于 ${QWEN_CACHE_MIN_VERSION}，没有 QwenImage21Cache 节点：出图会自动跳过前缀缓存（不会失败），升级 ComfyUI 后启用。`;
			return jsonSafe({
				checked_at: (/* @__PURE__ */ new Date()).toISOString(),
				comfyui: {
					modelsDir: settings.comfyModelsDir.length > 0 ? settings.comfyModelsDir : null,
					...comfyui,
					version,
					qwen_cache: {
						min_version: QWEN_CACHE_MIN_VERSION,
						version_satisfied: cacheSupported,
						note: cacheNote
					},
					devices: stats?.devices ?? null,
					stats_note: stats?.note ?? null
				},
				output: {
					dir: settings.outputDir,
					writable: await ensureOutputDirWritable(settings.outputDir)
				},
				next_steps: reachable ? null : "ComfyUI 没在跑。按 docs/comfyui-deployment.md 装桌面版、把三个权重放进它能看到的位置，然后重跑本工具。"
			});
		}
	}));
}
/** Create the output directory if needed and report whether it accepts writes. */
async function ensureOutputDirWritable(dir) {
	const { mkdir, writeFile, unlink } = await import("node:fs/promises");
	const { join } = await import("node:path");
	try {
		await mkdir(dir, { recursive: true });
		const probe = join(dir, `.dsh-image-forge-write-probe-${process.pid}`);
		await writeFile(probe, "");
		await unlink(probe);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region src/index.ts
/** Registration name inside the cordis context. */
const name = "dsh-image-forge";
/** Services this plugin needs before `apply` runs. */
const inject = ["tools", "skills"];
/**
* Plugin config schema — and, under the DSH 0.2.0 settings model, this entry's
* settings page as well: the Host derives one form per profile entry from this
* schema and serves it only when at least one field is `volatile()`. The marker
* is also what admits a write and what keeps the edit on the live path — the
* Loader commits the new value into the field's reference and announces
* `loader/volatile-update` on this fiber instead of remounting the row, so the
* registered tools and skill survive a settings save.
*
* Every field is volatile, which is what makes the settings section able to read
* and write the whole configuration rather than a subset. A volatile field's
* parsed output is a reference while its accepted input stays the plain value,
* so the schema is left to inference rather than annotated with `Schema<Config>`
* — the two sides no longer share one shape and the annotation would reject the
* schema the Host must be given.
*
* The plain shape is recovered by {@link resolveConfig} before anything
* downstream sees it. The cloud-API fields (`backend`, `apiBaseUrl`, `apiKey`,
* `apiModel`, `apiStyle`) were removed with that backend; a profile patch that
* still carries them has the extra keys ignored, not rejected.
*/
const Config = Schema.object({
	outputDir: Schema.string().default(defaultOutputDir()).volatile(),
	timeoutMs: Schema.number().default(18e4).volatile(),
	comfyEndpoint: Schema.string().default("").volatile(),
	comfyPorts: Schema.string().default("8000,8188,8189,8190,8191,8192").volatile(),
	comfyModelsDir: Schema.string().default(probeComfyModelsDir()).volatile(),
	defaultSteps: Schema.number().default(40).volatile(),
	comfyuiSteps: Schema.number().volatile(),
	comfyModel: Schema.union([...COMFY_MODEL_IDS, ...LEGACY_COMFY_MODEL_IDS]).default(DEFAULT_COMFY_MODEL).volatile(),
	mossSampling: Schema.union([...MOSS_SAMPLING_PRESETS]).default(DEFAULT_MOSS_SAMPLING).volatile(),
	turboSteps: Schema.number().volatile(),
	executionBackend: Schema.union([
		"auto",
		"mcp",
		"cli",
		"http"
	]).default("auto").volatile(),
	comfyMcpBin: Schema.string().default("").volatile(),
	comfyBin: Schema.string().default("").volatile(),
	backendTimeoutMs: Schema.number().volatile(),
	mcpDebug: Schema.boolean().default(false).volatile(),
	backendTmpDir: Schema.string().default("").volatile()
});
/**
* The schema's own defaults, in plain form, key-complete.
*
* Read off the schema rather than restated, so a default changed in the schema
* cannot drift from the one an activation is resolved against. `schemaDefaults`
* (not `unwrapConfigFields`) is what keeps the two optional step overrides as
* declared-but-unset keys.
*/
const CONFIG_DEFAULTS = schemaDefaults(Config({}));
/**
* Resolve the effective config of one activation into plain data.
*
* Volatile references are read here, so a settings save re-entering this fiber
* is observed as the value it committed. Deliberately **not** exported: this
* entry's export list is a published surface, pinned by `test/surface.test.mjs`
* to exactly name / inject / Config / apply. The unwrapping itself lives in
* `./config-resolve.ts`, which is also its own build entry and so is directly
* testable at `lib/config-resolve.js`.
*
* @param config - the config the Host passed to the activation.
* @returns the resolved config, every field present.
*/
function resolveConfig(config) {
	const resolved = resolveConfigFields(CONFIG_DEFAULTS, config);
	return {
		...resolved,
		comfyModel: resolveProfile(resolved.comfyModel).id
	};
}
/**
* Register the image tools, the routing skill, and — when the host serves one —
* the Studio's HTTP routes.
*
* The Studio routes mount through a dedicated inner plugin ({@link
* registerStudioRoutesIfMounted}) so a host without a web server still gets the
* Agent tools, and a host whose server mounts late gets the routes at all.
*
* The tools do **not** get a resolved snapshot: they get the same
* {@link resolveConfig} closure the routes re-read per request, because a
* settings save commits into the field's volatile reference without re-running
* `apply` — a snapshot taken here would freeze `comfyEndpoint`, `comfyModel`
* and the step overrides at activation time and quietly ignore every later
* settings edit.
*
* @param ctx - cordis context; `tools` and `skills` are injected above.
* @param config - the activation's config, volatile references included.
*/
function apply(ctx, config) {
	const resolveAndConfigure = () => {
		const resolved = resolveConfig(config);
		configureBackendDefaults(backendDefaultsOf(resolved));
		return resolved;
	};
	registerImageForgeTools(ctx, resolveAndConfigure);
	registerEnvironmentTools(ctx, resolveAndConfigure);
	registerImageForgeSkill(ctx);
	registerStudioRoutesIfMounted(ctx, config, resolveAndConfigure);
}
/**
* Wire the Studio routes onto the host's web server, reading the config fresh
* per request so a settings save takes effect without a restart.
*
* The routes live in a **dedicated inner plugin** that declares `webServer` as
* its own injected service, rather than in the plugin body. The reason is
* activation order: a plugin only starts once *every* service in its `inject`
* list exists, so putting `webServer` on the outer plugin would park the tools
* and the skill on any host that never starts a web server, while reading
* `ctx.get('webServer')` once from the body loses the race the other way — on
* Desktop the server mounts after plugin activation, the getter returns
* `undefined`, and the Studio panel then reports HTTP 404 against a server
* that is in fact running. The inner plugin gets both halves right: the outer
* body starts immediately (tools work everywhere), and cordis (re)activates
* the inner one exactly when the web server appears.
*
* @param ctx - host context.
* @param config - the activation's config, or undefined for the schema defaults.
*/
/** The T22 config fields, mapped onto the backend seam's defaults. */
function backendDefaultsOf(config) {
	return {
		backend: config.executionBackend,
		comfyMcpBin: config.comfyMcpBin,
		comfyBin: config.comfyBin,
		...config.backendTimeoutMs === void 0 ? {} : { backendTimeoutMs: config.backendTimeoutMs },
		mcpDebug: config.mcpDebug,
		backendTmpDir: config.backendTmpDir,
		outputDir: config.outputDir
	};
}
/**
* Wire the Studio routes onto the host's web server, reading the config fresh
* per request so a settings save takes effect without a restart.
*/
function registerStudioRoutesIfMounted(ctx, config, resolveAndConfigure) {
	if (typeof ctx.plugin !== "function") return;
	ctx.plugin({
		name: "dsh-image-forge:studio",
		inject: ["webServer"],
		apply: (svcCtx) => {
			const disposers = registerStudioRoutes(svcCtx, {
				settings: () => studioSettingsOf(resolveAndConfigure === void 0 ? resolveConfig(config) : resolveAndConfigure()),
				ctx: svcCtx
			});
			if (!disposers.length) {
				svcCtx.logger.warn("webServer 已挂载但 register() 不可用，工作台路由未注册");
				return;
			}
			return () => disposers.forEach((dispose) => dispose());
		}
	});
}
//#endregion
export { Config, apply, inject, name };
