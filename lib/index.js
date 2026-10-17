import Schema from "@deepseek-ai/schemastery";
import { closeSync, constants, cpSync, createReadStream, createWriteStream, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { arch, cpus, freemem, homedir, platform, release, tmpdir, totalmem } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { access, mkdir, open, readFile, rename, rm, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
//#region src/procx.ts
/**
* Process execution helpers.
*
* Every child process this plugin starts gets its stdout/stderr on a **file
* descriptor**, never a pipe. Two reasons, both learned on this host:
*
* 1. The file sandbox denies pipe-backed spawns (`spawn ... EPERM`), so
*    `execFile`/`spawn` with the default `stdio: 'pipe'` fails where the fd form
*    works.
* 2. A pipe dies with its reader: the worker's log would be lost exactly when it
*    is needed, i.e. when the process crashes.
*
* The cost is that stdout and stderr arrive interleaved in one file, which is why
* the result exposes `output` rather than separate streams — pip and torch both
* write progress and errors there anyway.
*/
/** Read at most the last `maxBytes` of a file, as text. */
function readTail(path, maxBytes) {
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - maxBytes);
		const raw = readFileSync(path).subarray(start).toString("utf8");
		const truncated = start > 0;
		const text = raw.replace(/\r\n/g, "\n").trimEnd();
		return truncated ? `…(truncated)\n${text}` : text;
	} catch {
		return "";
	}
}
/**
* Open a log file for a child process's stdout/stderr.
*
* The configured directory is tried first, then the OS temp directory: a runtime
* directory that cannot be written (a locked-down sandbox, a read-only profile)
* must degrade to "logs land elsewhere", not to "the probe silently failed" or
* "an unhandled exception while starting the worker".
*
* @param preferredDir - directory the caller would like the log in.
* @param name - file name inside that directory.
* @returns the open descriptor, its path, and a note when the fallback was used.
*/
async function openLogFile(preferredDir, name) {
	const candidates = [preferredDir, tmpdir()].filter((dir, index, all) => dir.length > 0 && all.indexOf(dir) === index);
	const problems = [];
	for (const dir of candidates) {
		const path = join(dir, name);
		try {
			await mkdir(dir, { recursive: true });
			const fd = openSync(path, "a");
			return dir === preferredDir ? {
				fd,
				path
			} : {
				fd,
				path,
				note: `${preferredDir} is not writable, so logs go to ${dir}`
			};
		} catch (error) {
			problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`cannot open a log file (${problems.join("; ")})`);
}
/**
* Run one command to completion, capturing its output through a log file.
*
* @param file - executable path (never resolved through a shell).
* @param args - argument vector.
* @param options - time budget, environment, and where to write the log.
* @returns the exit code and combined output; spawn failures are reported, not thrown.
*/
async function runCaptured(file, args, options = {}) {
	const timeoutMs = options.timeoutMs ?? 12e4;
	const scratchDir = options.scratchDir ?? tmpdir();
	const label = options.label ?? "cmd";
	const command = `${file} ${args.join(" ")}`;
	let log;
	try {
		log = await openLogFile(scratchDir, `${label}-${randomBytes(4).toString("hex")}.log`);
	} catch (error) {
		return {
			ok: false,
			code: null,
			signal: null,
			output: "",
			timedOut: false,
			command,
			note: error instanceof Error ? error.message : String(error)
		};
	}
	const { fd, path: logPath } = log;
	try {
		return await new Promise((resolve) => {
			let settled = false;
			let child = null;
			let timer = null;
			let timedOut = false;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				if (timer !== null) clearTimeout(timer);
				const output = readTail(logPath, options.maxOutputBytes ?? 262144);
				if (options.keepLog !== true) try {
					rmSync(logPath, { force: true });
				} catch {}
				resolve({
					...result,
					output,
					command,
					logPath: options.keepLog === true ? logPath : void 0
				});
			};
			try {
				child = spawn(file, [...args], {
					stdio: [
						"ignore",
						fd,
						fd
					],
					windowsHide: true,
					cwd: options.cwd,
					env: options.env === void 0 ? process.env : {
						...process.env,
						...options.env
					}
				});
			} catch (error) {
				finish({
					ok: false,
					code: null,
					signal: null,
					timedOut: false,
					note: `${file} could not be started: ${error instanceof Error ? error.message : String(error)}`
				});
				return;
			}
			timer = setTimeout(() => {
				timedOut = true;
				try {
					child?.kill();
				} catch {}
				setTimeout(() => {
					try {
						child?.kill("SIGKILL");
					} catch {}
					setTimeout(() => finish({
						ok: false,
						code: null,
						signal: null,
						timedOut: true,
						note: "killed after timeout"
					}), 2e3).unref?.();
				}, 3e3).unref?.();
			}, timeoutMs);
			child.once("error", (error) => {
				finish({
					ok: false,
					code: null,
					signal: null,
					timedOut,
					note: `${error.code ?? ""} ${error.message}`.trim()
				});
			});
			child.once("exit", (code, signal) => {
				finish({
					ok: code === 0,
					code,
					signal: signal ?? null,
					timedOut
				});
			});
		});
	} finally {
		closeSync(fd);
	}
}
/** Does this path exist? */
function pathExists(path) {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}
/**
* Would starting this program fail for a reason we can see up front?
*
* A bare command name (`python`, `py`) is left to the OS path lookup — reporting
* it as missing would be a guess, not a fact.
*
* @param executable - absolute path, or a bare command name.
* @returns true only when an explicit path is absent.
*/
function executableMissing(executable) {
	return (/[\\/]/.test(executable) || /^[A-Za-z]:/.test(executable)) && !pathExists(executable);
}
/**
* Parse a port list like `8399-8410`, `8399,8400`, or a mix.
*
* Unparsable fragments are dropped rather than rejected: a typo in the config
* must not stop the plugin from loading, and the defaults are documented.
*
* @param spec - config value.
* @param fallback - ports to use when nothing survives parsing.
* @returns distinct valid ports, in the order written.
*/
function parsePorts(spec, fallback) {
	const ports = [];
	const push = (port) => {
		if (Number.isInteger(port) && port >= 1 && port <= 65535 && !ports.includes(port)) ports.push(port);
	};
	for (const rawPart of spec.split(/[,\s]+/)) {
		const part = rawPart.trim();
		if (part.length === 0) continue;
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
		if (range !== null) {
			const from = Number(range[1]);
			const to = Number(range[2]);
			if (to >= from && to - from <= 64) for (let port = from; port <= to; port += 1) push(port);
			continue;
		}
		const single = /^(\d+)$/.exec(part);
		if (single !== null) push(Number(single[1]));
	}
	return ports.length > 0 ? ports : [...fallback];
}
//#endregion
//#region src/venv.ts
/**
* The plugin-owned Python environment: venv creation, the torch wheel matrix, and
* package installs.
*
* Three host facts shape this module:
*
* 1. `python -m venv` can fail at `ensurepip` because the sandbox makes
*    mode-0o700 directories unwritable; the documented fallback is
*    `--without-pip` plus copying pip in from the base interpreter.
* 2. Every pip call goes through `resources/pipwrap.py` **with the venv's own
*    interpreter**, because plain pip dies with `PermissionError [Errno 13]` on
*    this host and `pip --python <other>` would bypass the patch.
* 3. A CUDA torch already on the machine must not be downloaded again: the venv
*    is asked first, then the base interpreter (reused through
*    `--system-site-packages`).
*/
/** Packages the worker imports, in the versions the spike proved out. */
const RUNTIME_PACKAGES = [
	"diffusers==0.41.0",
	"transformers==5.14.1",
	"accelerate",
	"safetensors",
	"sentencepiece",
	"bitsandbytes",
	"psutil",
	"einops",
	"protobuf"
];
/** Torch build the CV check orders by: newest CUDA first, then the proven one. */
const TORCH_WHEEL_MATRIX = [
	"cu128",
	"cu126",
	"cu118"
];
/** Pinned torch, so a rerun reproduces the environment the spike measured. */
const TORCH_PIN = ["torch==2.9.1", "torchvision"];
/** Python the worker needs; 3.12 is what the spike used, 3.10 is the floor for the deps. */
const MINIMUM_PYTHON = [3, 10];
/**
* Resolve the venv layout for a runtime directory.
*
* @param runtimeDir - plugin-owned data directory.
* @returns the venv directory and the interpreter inside it.
*/
function venvPaths(runtimeDir) {
	const venvDir = join(runtimeDir, "venv");
	return {
		runtimeDir,
		venvDir,
		python: process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python")
	};
}
/**
* Run one python snippet and parse the JSON it prints as its last line.
*
* Scope, on purpose: only a line starting with `{` is accepted, so the snippet must print
* an **object**. `json.dumps(["…"])` (a list) is silently ignored and the caller sees
* `null` — that is how `copyPip` used to lose the base interpreter's site-packages while
* reporting only "could not locate", with nothing in the output to point at the parse.
* A snippet that must return several values should wrap them in an object.
*/
async function pythonJson(python, code, options) {
	const result = await runCaptured(python, ["-c", code], {
		timeoutMs: options.timeoutMs ?? 3e4,
		scratchDir: options.scratchDir,
		label: options.label ?? "python",
		env: { PYTHONIOENCODING: "utf-8" }
	});
	const last = result.output.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{")).at(-1);
	if (last === void 0) return {
		value: null,
		result
	};
	try {
		return {
			value: JSON.parse(last),
			result
		};
	} catch {
		return {
			value: null,
			result
		};
	}
}
/** Ask an interpreter for its version. */
async function probeInterpreter(python, options = {}) {
	if (executableMissing(python)) return {
		path: python,
		ok: false,
		note: `not found: ${python}`
	};
	const { value, result } = await pythonJson(python, "import json,sys;print(json.dumps({\"executable\":sys.executable,\"version\":\"%d.%d.%d\"%sys.version_info[:3]}))", options);
	if (value === null) return {
		path: python,
		ok: false,
		note: `version query failed: ${result.output.slice(-400) || result.note || "no output"}`
	};
	const parts = value.version.split(".").map((part) => Number(part));
	return {
		path: python,
		ok: true,
		executable: value.executable,
		version: value.version,
		majorMinor: [parts[0] ?? 0, parts[1] ?? 0]
	};
}
/**
* Find a usable base interpreter.
*
* @param candidates - absolute paths or bare command names to try in order.
* @returns the first interpreter at or above the version floor, else null.
*/
async function findBasePython(candidates, options = {}) {
	let lastFailure = null;
	for (const candidate of candidates) {
		const info = await probeInterpreter(candidate, options);
		if (!info.ok) {
			lastFailure ??= info;
			continue;
		}
		const [major, minor] = info.majorMinor ?? [0, 0];
		if (major > MINIMUM_PYTHON[0] || major === MINIMUM_PYTHON[0] && minor >= MINIMUM_PYTHON[1]) return info;
		lastFailure = {
			...info,
			ok: false,
			note: `python ${info.version} is older than the required 3.10`
		};
	}
	return lastFailure;
}
/** Probe torch inside one interpreter. */
async function probeTorch(python, options = {}) {
	const { value } = await pythonJson(python, "import json,torch;print(json.dumps({\"version\":torch.__version__,\"cuda\":torch.version.cuda,\"cudaAvailable\":bool(torch.cuda.is_available())}))", {
		...options,
		timeoutMs: options.timeoutMs ?? 12e4,
		label: "torch-probe"
	});
	return value;
}
/**
* Probe every package the worker imports.
*
* A missing package is reported rather than thrown: `status` and `repair` both
* need the partial picture.
*/
async function probePackages(python, options = {}) {
	if (executableMissing(python)) return {
		ok: false,
		versions: {},
		torch: null,
		note: `interpreter not found: ${python}`
	};
	const names = ["torch", ...RUNTIME_PACKAGES.map((spec) => spec.split("==")[0])];
	const { value, result } = await pythonJson(python, [
		"import json, importlib.metadata as md",
		`out = {}`,
		`for name in ${JSON.stringify(names)}:`,
		"    try:",
		"        out[name] = md.version(name)",
		"    except Exception:",
		"        out[name] = None",
		"try:",
		"    import torch",
		"    torch_info = {\"version\": torch.__version__, \"cuda\": torch.version.cuda, \"cudaAvailable\": bool(torch.cuda.is_available())}",
		"except Exception:",
		"    torch_info = None",
		"print(json.dumps({\"versions\": out, \"torch\": torch_info}))"
	].join("\n"), {
		...options,
		timeoutMs: options.timeoutMs ?? 3e5,
		label: "packages"
	});
	if (value === null) return {
		ok: false,
		versions: {},
		torch: null,
		note: `package probe produced no JSON: ${result.output.slice(-400) || result.note || "no output"}`
	};
	const missing = Object.entries(value.versions).filter(([, version]) => version === null).map(([name]) => name);
	return {
		ok: missing.length === 0,
		versions: value.versions,
		torch: value.torch,
		note: missing.length === 0 ? void 0 : `missing: ${missing.join(", ")}`
	};
}
/** Does this interpreter have pip importable? (A `--without-pip` venv does not.) */
async function venvHasPip(python, options) {
	return (await runCaptured(python, ["-c", "import pip"], {
		timeoutMs: 3e4,
		scratchDir: options.scratchDir,
		label: "pip-probe"
	})).ok;
}
/** Copy pip from the base interpreter into a `--without-pip` venv. */
async function copyPip(basePython, venvDir, options) {
	const started = Date.now();
	const { value } = await pythonJson(basePython, "import json,sysconfig;print(json.dumps({\"purelib\":sysconfig.get_paths()[\"purelib\"]}))", {
		timeoutMs: 3e4,
		scratchDir: options.scratchDir,
		label: "site"
	});
	const sitePackages = value?.purelib;
	if (sitePackages === void 0) return {
		name: "venv:copy pip",
		status: "failed",
		detail: "could not locate the base interpreter site-packages"
	};
	const libDir = process.platform === "win32" ? join(venvDir, "Lib", "site-packages") : join(venvDir, "lib", "site-packages");
	const { readdirSync, mkdirSync } = await import("node:fs");
	mkdirSync(libDir, { recursive: true });
	const copied = [];
	for (const entry of readdirSync(sitePackages)) if (entry === "pip" || entry.startsWith("pip-")) {
		cpSync(join(sitePackages, entry), join(libDir, entry), {
			recursive: true,
			force: true
		});
		copied.push(entry);
	}
	return {
		name: "venv:copy pip",
		status: copied.length > 0 ? "ok" : "failed",
		detail: copied.length > 0 ? `copied ${copied.join(", ")} from ${sitePackages}` : `no pip found in ${sitePackages}`,
		duration_ms: Date.now() - started
	};
}
/** Create the venv, falling back to the sandbox workaround when ensurepip fails. */
async function createVenv(basePython, venvDir, options, systemSite) {
	const steps = [];
	const flags = systemSite ? ["--system-site-packages"] : [];
	const started = Date.now();
	const first = await runCaptured(basePython, [
		"-m",
		"venv",
		...flags,
		venvDir
	], {
		timeoutMs: options.commandTimeoutMs,
		scratchDir: options.scratchDir,
		label: "venv"
	});
	steps.push({
		name: "venv:create",
		status: first.ok ? "ok" : "failed",
		command: first.command,
		detail: first.ok ? `created ${venvDir}${systemSite ? " (--system-site-packages: reusing the base interpreter packages)" : ""}` : `exit ${first.code ?? "null"}: ${first.output.slice(-600)}`,
		duration_ms: Date.now() - started
	});
	if (first.ok) return steps;
	const second = await runCaptured(basePython, [
		"-m",
		"venv",
		...flags,
		"--without-pip",
		venvDir
	], {
		timeoutMs: options.commandTimeoutMs,
		scratchDir: options.scratchDir,
		label: "venv-nopip"
	});
	steps.push({
		name: "venv:create (--without-pip)",
		status: second.ok ? "ok" : "failed",
		command: second.command,
		detail: second.ok ? "ensurepip failed, so the venv was created without pip" : `exit ${second.code ?? "null"}: ${second.output.slice(-600)}`
	});
	if (!second.ok) return steps;
	steps.push(await copyPip(basePython, venvDir, options));
	return steps;
}
/** Run pip for one package set, through the sandbox patch. */
async function pipInstall(paths, options, args, extra) {
	await mkdir(join(options.runtimeDir, "tmp"), { recursive: true }).catch(() => void 0);
	return runCaptured(paths.python, [
		options.pipwrap,
		"install",
		...args,
		...extra
	], {
		timeoutMs: options.commandTimeoutMs,
		scratchDir: options.scratchDir,
		label: "pip",
		env: {
			TMP: join(options.runtimeDir, "tmp"),
			TEMP: join(options.runtimeDir, "tmp"),
			PIP_DISABLE_PIP_VERSION_CHECK: "1"
		}
	});
}
/**
* Install the environment: venv, CUDA torch, then the worker's packages.
*
* @param options - resolved config values and the dry-run switch.
* @returns a step-by-step report; a failed step is reported, never thrown.
*/
async function runInstall(options) {
	const paths = venvPaths(options.runtimeDir);
	const steps = [];
	const base = await findBasePython(options.basePythonCandidates, { scratchDir: options.scratchDir });
	const report = (ok, next, extra = {}) => ({
		action: "install",
		dry_run: options.dryRun,
		ok,
		base_python: base,
		venv_python: paths.python,
		venv_dir: paths.venvDir,
		steps,
		packages: null,
		next,
		...extra
	});
	if (base === null || !base.ok) {
		steps.push({
			name: "base python",
			status: "failed",
			detail: base?.note ?? `no usable interpreter (>= 3.10) among: ${options.basePythonCandidates.join(", ")}`
		});
		return report(false, "Install Python 3.10+ (python.org), or point the plugin config `basePython` at it.");
	}
	const baseExe = base.executable ?? base.path;
	if (options.dryRun) {
		const baseTorch = options.reuseBaseTorch ? await probeTorch(baseExe, { scratchDir: options.scratchDir }) : null;
		steps.push({
			name: "base python",
			status: "ok",
			detail: `${base.version} at ${baseExe}`
		});
		steps.push({
			name: "venv",
			status: "planned",
			detail: pathExists(paths.python) ? `${paths.venvDir} already exists` : `would run: ${baseExe} -m venv ${paths.venvDir}${baseTorch === null ? "" : " --system-site-packages (base python has CUDA torch)"}`
		});
		steps.push({
			name: "torch",
			status: "planned",
			detail: baseTorch === null ? `would try ${options.torchWheels.join(" → ")} with ${TORCH_PIN.join(" ")}` : `would reuse the base interpreter's torch ${baseTorch.version} (cuda ${baseTorch.cuda}) and install nothing`
		});
		steps.push({
			name: "packages",
			status: "planned",
			detail: `would install ${RUNTIME_PACKAGES.join(" ")}${options.pipIndexUrl === "" ? "" : ` from ${options.pipIndexUrl}`}`
		});
		return report(true, "Re-run with `dryRun:false` to execute this plan.", { dry_run_skipped: "nothing was created or installed; this is a plan" });
	}
	const baseTorch = options.reuseBaseTorch ? await probeTorch(base.executable ?? base.path, { scratchDir: options.scratchDir }) : null;
	steps.push({
		name: "base python",
		status: "ok",
		detail: `${base.version} at ${base.executable ?? base.path}`
	});
	const venvExists = pathExists(paths.python);
	let venvTorch = venvExists ? await probeTorch(paths.python, { scratchDir: options.scratchDir }) : null;
	if (!venvExists) {
		steps.push(...await createVenv(base.executable ?? base.path, paths.venvDir, options, baseTorch !== null));
		if (!pathExists(paths.python)) return report(false, "The venv could not be created; see the step output above.");
		venvTorch = null;
	} else {
		steps.push({
			name: "venv",
			status: "skipped",
			detail: `${paths.venvDir} already exists — reusing it`
		});
		if (!await venvHasPip(paths.python, options)) steps.push(await copyPip(base.executable ?? base.path, paths.venvDir, options));
	}
	if (venvTorch !== null && venvTorch.cuda !== null) steps.push({
		name: "torch",
		status: "skipped",
		detail: `already installed: ${venvTorch.version} (cuda ${venvTorch.cuda})`
	});
	else if (baseTorch !== null && baseTorch.cuda !== null) {
		steps.push({
			name: "torch",
			status: "skipped",
			detail: `reusing the base interpreter's CUDA torch ${baseTorch.version} via --system-site-packages`
		});
		if (await probeTorch(paths.python, { scratchDir: options.scratchDir }) === null) return report(false, `The venv cannot see the base interpreter's torch. Recreate it with --system-site-packages, or run install with \`reuseBaseTorch:false\`.`);
	} else {
		let installed = null;
		for (const tag of options.torchWheels) {
			const index = `https://download.pytorch.org/whl/${tag}`;
			const started = Date.now();
			const result = await pipInstall(paths, options, [
				"--no-cache-dir",
				"--timeout",
				"180",
				"--retries",
				"15",
				"--index-url",
				index
			], [...TORCH_PIN]);
			const ok = result.ok && pathExists(paths.python);
			installed = {
				name: `torch (${tag})`,
				status: ok ? "ok" : "failed",
				command: result.command,
				detail: ok ? `installed from ${index}` : `exit ${result.code ?? "null"}: ${result.output.slice(-800)}`,
				duration_ms: Date.now() - started
			};
			steps.push(installed);
			if (ok) break;
		}
		if (installed === null || installed.status !== "ok") return report(false, "Every CUDA wheel index in the matrix failed. Check the machine's network/proxy, or set `pipIndexUrl` to an internal mirror and retry.");
	}
	const before = await probePackages(paths.python, { scratchDir: options.scratchDir });
	const missing = RUNTIME_PACKAGES.filter((spec) => {
		const name = spec.split("==")[0];
		return before.versions[name] === null || before.versions[name] === void 0;
	});
	if (missing.length === 0) steps.push({
		name: "packages",
		status: "skipped",
		detail: `all present: ${JSON.stringify(before.versions)}`
	});
	else {
		const started = Date.now();
		const result = await pipInstall(paths, options, [
			"--no-cache-dir",
			"--timeout",
			"180",
			"--retries",
			"15",
			...options.pipIndexUrl === "" ? [] : ["--index-url", options.pipIndexUrl]
		], missing);
		steps.push({
			name: "packages",
			status: result.ok ? "ok" : "failed",
			command: result.command,
			detail: result.ok ? `installed ${missing.join(" ")}` : `exit ${result.code ?? "null"}: ${result.output.slice(-800)}`,
			duration_ms: Date.now() - started
		});
	}
	const after = await probePackages(paths.python, { scratchDir: options.scratchDir });
	const ok = after.ok && after.torch !== null;
	return {
		action: "install",
		dry_run: false,
		ok,
		base_python: base,
		venv_python: paths.python,
		venv_dir: paths.venvDir,
		steps,
		packages: after,
		next: ok ? "Environment ready. Run `qwen_image_env` with `action:\"fetch-weights\"` if the weights are not on disk yet." : `Install is incomplete (${after.note ?? "see steps"}). Re-run \`action:"repair"\` for a targeted fix.`
	};
}
//#endregion
//#region src/backend.ts
/** Environment variables consulted for a key, in priority order. */
const API_KEY_ENV_VARS = [
	"QWEN_IMAGE_API_KEY",
	"DASHSCOPE_API_KEY",
	"OPENAI_API_KEY"
];
/**
* Resolve the effective API key without ever returning it to a log.
*
* @param configKey - value from the plugin config, which wins when non-blank.
* @param env - environment lookup, injectable for tests.
* @returns the key and which source supplied it; `key` is undefined when none.
*/
function resolveApiKey(configKey, env = process.env) {
	const trimmed = configKey?.trim();
	if (trimmed !== void 0 && trimmed.length > 0) return {
		envVars: API_KEY_ENV_VARS,
		key: trimmed,
		source: "config"
	};
	for (const name of API_KEY_ENV_VARS) {
		const value = env[name]?.trim();
		if (value !== void 0 && value.length > 0) return {
			envVars: API_KEY_ENV_VARS,
			key: value,
			source: name
		};
	}
	return { envVars: API_KEY_ENV_VARS };
}
/** Replace every occurrence of the key (and obvious key shapes) with a marker. */
function redact(text, apiKey) {
	let out = text;
	if (apiKey.length > 0) out = out.split(apiKey).join("<redacted-key>");
	return out.replace(/(sk-|Bearer\s+)[A-Za-z0-9_\-.]{6,}/g, "$1<redacted-key>").replace(/"(api_?key|apiKey|authorization)"\s*:\s*"[^"]*"/gi, "\"$1\":\"<redacted-key>\"");
}
/** One-line, bounded, key-scrubbed rendering of a response body. */
function summarizeBody(text, apiKey) {
	const flat = redact(text, apiKey).replace(/\s+/g, " ").trim();
	return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
}
/** Sniff the image container from its magic bytes. */
function sniffImageMime(bytes) {
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (bytes.length >= 12 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
}
/** Decode a base64 or `data:` payload into raw bytes. */
function decodeImagePayload(payload) {
	const comma = payload.startsWith("data:") ? payload.indexOf(",") : -1;
	const base64 = comma === -1 ? payload : payload.slice(comma + 1);
	const buffer = Buffer.from(base64, "base64");
	if (buffer.length === 0) throw new Error("backend returned an empty image payload");
	return new Uint8Array(buffer);
}
/**
* Normalize one entry of a backend's image array.
*
* Accepts, in order of preference: an object with `b64_json`/`b64`/`data`, or a
* bare string that is either base64 or a `data:` URI. A remote URL entry is
* fetched with the caller's abort signal.
*/
async function readImageEntry(entry, addressee, signal) {
	if (typeof entry === "string") return {
		bytes: decodeImagePayload(entry),
		mime: "image/png"
	};
	if (typeof entry !== "object" || entry === null) throw new Error(`${addressee}: image entry is neither base64 nor an object (got ${typeof entry})`);
	const record = entry;
	for (const field of [
		"b64_json",
		"b64",
		"data",
		"image"
	]) {
		const value = record[field];
		if (typeof value === "string" && value.length > 0) return {
			bytes: decodeImagePayload(value),
			mime: typeof record.mime_type === "string" ? record.mime_type : "image/png"
		};
	}
	const url = record.url;
	if (typeof url === "string" && url.length > 0) {
		const response = await fetch(url, { signal });
		if (!response.ok) throw new Error(`${addressee}: fetching returned image failed with HTTP ${response.status}`);
		return {
			bytes: new Uint8Array(await response.arrayBuffer()),
			mime: response.headers.get("content-type") ?? "image/png"
		};
	}
	throw new Error(`${addressee}: image entry carries none of b64_json/b64/data/url`);
}
/** Pull the image array out of any of the envelope shapes seen in the wild. */
function readImageArray(payload) {
	if (typeof payload !== "object" || payload === null) return void 0;
	const record = payload;
	if (Array.isArray(record.data)) return record.data;
	if (Array.isArray(record.images)) return record.images;
	if (Array.isArray(record.output)) return record.output.map((item) => typeof item === "object" && item !== null ? item.image ?? item : item);
}
/**
* Render a backend's error envelope as a readable message.
*
* @param payload - parsed response body, when it parsed.
* @param status - HTTP status code.
* @returns a one-line explanation that mentions the status and the upstream
*   message, which is what makes a 400 actionable instead of mysterious.
*/
function describeApiError(payload, status) {
	if (typeof payload === "object" && payload !== null) {
		const record = payload;
		const error = record.error;
		if (typeof error === "string") return `HTTP ${status}: ${error}`;
		if (typeof error === "object" && error !== null) {
			const message = error.message;
			if (typeof message === "string") return `HTTP ${status}: ${message}`;
		}
		const message = record.message;
		if (typeof message === "string") return `HTTP ${status}: ${message}`;
	}
	return `HTTP ${status}`;
}
/**
* Decode every image in any supported envelope shape.
*
* Shared with the local worker client so both backends accept the same
* `data[]` / `images[]` / `output[].image` layouts and the same
* base64-or-`data:`-URI-or-`url` entries.
*
* @param payload - parsed backend body.
* @param addressee - label used in error messages, e.g. `qwen-image api`.
* @param signal - caller cancellation, used when an entry is a remote URL.
* @returns the decoded images in upstream order.
* @throws When the envelope carries no recognized image array.
*/
async function extractImages(payload, addressee, signal) {
	const entries = readImageArray(payload);
	if (entries === void 0) {
		const keys = typeof payload === "object" && payload !== null ? Object.keys(payload).join(", ") : typeof payload;
		throw new Error(`${addressee}: response carries no data[] or images[] array — got keys [${keys}]`);
	}
	if (entries.length === 0) throw new Error(`${addressee}: response image array is empty`);
	const images = [];
	for (const entry of entries) images.push(await readImageEntry(entry, addressee, signal));
	return images;
}
/**
* Generate images through the configured cloud endpoint.
*
* @param settings - resolved endpoint, key, model, and wire style.
* @param request - prompt plus the already-aligned canvas size.
* @param signal - aborts the in-flight request on tool cancellation.
* @returns one entry per returned image, in upstream order.
* @throws When the style is unimplemented, the endpoint rejects the call, the
*   body is not JSON, or no image is present. Messages never contain the key.
*/
async function generateViaApi(settings, request, signal) {
	if (settings.style === "dashscope") throw new Error("apiStyle 'dashscope' (native async task API) is declared but not implemented in v0.1; use apiStyle 'openai' with the DashScope OpenAI-compatible base URL (https://dashscope.aliyuncs.com/compatible-mode/v1) instead");
	if (request.images !== void 0 && request.images.length > 0) throw new Error(`qwen-image api: this backend has no edit path, so it cannot carry ${request.images.length} reference image(s). Editing over the OpenAI-compatible wire format is a different request shape (multipart POST /images/edits with the images as file parts, which this client does not implement), and the reference images are never dropped silently. Use backend 'comfyui' (the local ComfyUI with the official Qwen-Image 2.1 edit graph) or 'local' (the managed worker, whose /generate accepts an images[] field).`);
	const body = {
		model: settings.model,
		prompt: request.prompt,
		n: request.count,
		size: `${request.width}x${request.height}`,
		response_format: "b64_json"
	};
	if (request.steps !== void 0) body.steps = request.steps;
	if (request.seed !== void 0) body.seed = request.seed;
	if (request.transparent) body.transparent = true;
	const response = await fetch(`${settings.baseUrl}/images/generations`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			Authorization: `Bearer ${settings.apiKey}`
		},
		body: JSON.stringify(body),
		signal
	});
	if (!response.ok) {
		let raw = "";
		try {
			raw = await response.text();
		} catch {
			raw = "";
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = void 0;
		}
		const reason = parsed === void 0 ? `HTTP ${response.status}` : describeApiError(parsed, response.status);
		const safe = summarizeBody(raw, settings.apiKey);
		throw new Error(redact(`qwen-image api: ${reason}${safe === "" ? "" : ` — ${safe}`}`, settings.apiKey));
	}
	let payload;
	const text = await response.text();
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`qwen-image api: response was not JSON: ${redact(text, settings.apiKey).slice(0, 200)}`);
	}
	return await extractImages(payload, "qwen-image api", signal);
}
/**
* Probe the configured endpoint for reachability and key validity.
*
* A `GET {baseUrl}/models` is the cheapest authenticated endpoint shared by both
* supported providers. No key means no probe: the report says the key is missing
* rather than pretending the endpoint is down.
*
* @param settings - resolved endpoint settings; `apiKey` may be empty.
* @param timeoutMs - per-request budget.
* @param signal - caller cancellation, composed with the timeout.
* @returns a structured probe result for `qwen_image_status`.
*/
async function probeApi(settings, timeoutMs, signal) {
	const url = `${settings.baseUrl}/images/generations`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		if (settings.apiKey.length === 0) return {
			endpoint: url,
			keyPresent: false,
			reachable: null,
			note: "no API key configured — set apiKey or a key environment variable to probe the endpoint"
		};
		const response = await fetch(`${settings.baseUrl}/models`, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${settings.apiKey}`
			},
			signal: controller.signal
		});
		const authenticated = response.status !== 401 && response.status !== 403;
		return {
			endpoint: url,
			keyPresent: true,
			reachable: true,
			modelsProbeStatus: response.status,
			authenticated,
			note: authenticated ? "endpoint answered" : "endpoint answered 401/403 — the key is missing, expired, or wrong"
		};
	} catch (error) {
		const reason = error instanceof Error ? error.cause instanceof Error ? error.cause.message : error.message : String(error);
		return {
			endpoint: url,
			keyPresent: settings.apiKey.length > 0,
			reachable: false,
			note: `unreachable: ${reason}`
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
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
*    the names in {@link MODEL_KINDS} are only examples used in error text.
* 3. **Upstream errors are quoted, not swallowed.** `/prompt` answers with
*    `node_errors` and `/history` carries an execution traceback; both reach the
*    caller as readable text instead of a bare 400.
*
* The graph is the official Qwen-Image 2.1 text-to-image template that ships
* with ComfyUI (`comfyui_workflow_templates_json/templates/
* image_qwen_image_2_1_t2i.json`), reduced to the nodes needed without the
* optional prompt-enhancer branch: `UNETLoader` → `KSampler.model`,
* `CLIPLoader(type=qwen_image)` → `TextEncodeQwenImage21` → `KSampler`,
* `VAELoader` → `VAEDecode`, `EmptyLatentImage` → `KSampler.latent_image`,
* `VAEDecode` → `SaveImage`. The template's `QwenImage21Cache`,
* `ResolutionSelector` and prompt-enhancer nodes are dropped: the first two only
* trade speed for VRAM (we size the canvas ourselves in `ratio.ts`), and the
* enhancer needs weights this plugin does not require.
*
* The edit (image-to-image) graph is the same skeleton plus the reference slots,
* taken from the official `image_qwen_image_2_1_image_edit.json` template: its
* `TextEncodeQwenImage21` node takes a `vae`, an autogrow `images.image_N` input
* per reference (up to ten) and a `resolution` pixel budget, and the reference
* pixels enter ComfyUI through `POST /upload/image` as `LoadImage` inputs. The
* template's `ComfySwitchNode` (its "custom size" switch) has no counterpart
* here because the plugin always supplies an explicit canvas, exactly as the
* text-to-image path does; the template builds its default canvas from the first
* reference at a 32-aligned ~1.5 MP budget, which is what `ratio_follow` resolves to.
*/
/** Ports probed when `comfyEndpoint` is empty, in order. */
const DEFAULT_COMFY_PORTS = [
	8e3,
	8188,
	8189,
	8190,
	8191,
	8192
];
/** Loader field, folder, and (error-text only) example file for one weight. */
const MODEL_KINDS = {
	unet: {
		loader: "UNETLoader",
		field: "unet_name",
		folder: "unet",
		what: "Qwen-Image 2.1 的 DiT（去噪主干）",
		example: "qwen_image_2.1_int8_convrot.safetensors",
		bonus: [
			/image/i,
			/2[._-]?1/,
			/int8/i
		]
	},
	clip: {
		loader: "CLIPLoader",
		field: "clip_name",
		folder: "clip",
		what: "Qwen-Image 2.1 的文本编码器（Qwen3-VL 8B）",
		example: "qwen3vl_8b_int8_convrot.safetensors",
		bonus: [
			/vl/i,
			/8b/i,
			/int8/i
		]
	},
	vae: {
		loader: "VAELoader",
		field: "vae_name",
		folder: "vae",
		what: "Qwen-Image 2.1 的 VAE",
		example: "qwen_image_2.1_vae_bf16.safetensors",
		bonus: [
			/vae/i,
			/2[._-]?1/,
			/bf16/i
		]
	}
};
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
	throw new Error(`comfyui backend: 没找到在跑的 ComfyUI（已探测 ${probed.length} 个端口）：\n${tried}\n  启动 ComfyUI（桌面版/便携版都可以）后重试；如果它监听在别的端口，把该端口写进 comfyPorts 或直接写 comfyEndpoint。`);
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
* Pick the file whose name best matches an ordered pattern list.
*
* A candidate must match `required`; each additional pattern it matches adds
* weight (earlier patterns weigh more). Ties keep the server's own order, so the
* choice is deterministic for a given `/object_info`. Matching the whole name
* rather than the basename means a file in a subfolder still matches.
* This is what keeps the PE (prompt-enhancer) text encoders from being picked as
* the text encoder: they carry neither `vl` nor `8b`.
*/
function pickModelFile(options, required, bonuses) {
	let best;
	for (const name of options) {
		if (!required.test(name)) continue;
		let score = 0;
		for (const [index, pattern] of bonuses.entries()) if (pattern.test(name)) score += bonuses.length - index;
		if (best === void 0 || score > best.score) best = {
			name,
			score
		};
	}
	return best?.name;
}
/** Where a weight belongs, phrased for the machine that is running this plugin. */
function folderHint(modelsDir, folder) {
	return modelsDir.trim().length > 0 ? `${modelsDir.trim().replace(/[\\/]+$/, "")}\\${folder}\\` : `ComfyUI 的 models\\${folder}\\ 目录（桌面版/便携版的模型路径见 ComfyUI 设置或 extra_model_paths.yaml）`;
}
/**
* Read the three Qwen-Image weight file names off the running server.
*
* @param target - the endpoint that answered.
* @param options - used for the model-directory hint and the timeout.
* @param signal - caller cancellation.
* @returns the names ComfyUI itself listed, plus the resolved `CLIPLoader.type`.
* @throws When a loader, its option list, a Qwen-named file, or a usable
*   `CLIPLoader.type` is missing. The message names the loader, the field, the
*   file it wants, and the directory to put it in — this is checked before
*   `/prompt`, so a missing weight never becomes a pile of node errors.
*/
async function loadComfyModels(target, options, signal) {
	const timeout = options.portProbeTimeoutMs ?? 800;
	const kinds = Object.keys(MODEL_KINDS);
	const loaded = /* @__PURE__ */ new Map();
	const clipInfo = requestJson(`${target.endpoint}/object_info/CLIPLoader`, { method: "GET" }, timeout, signal);
	for (const kind of kinds.filter((kind) => kind !== "clip")) {
		const node = MODEL_KINDS[kind].loader;
		loaded.set(kind, await requestJson(`${target.endpoint}/object_info/${node}`, { method: "GET" }, timeout, signal));
	}
	loaded.set("clip", await clipInfo);
	const chosen = /* @__PURE__ */ new Map();
	for (const kind of kinds) {
		const spec = MODEL_KINDS[kind];
		const response = loaded.get(kind);
		const optionsList = response === void 0 ? void 0 : loaderField(response.payload, spec.loader, spec.field);
		if (optionsList === void 0) throw new Error(`comfyui backend: 读不到 ${spec.loader}.${spec.field} — 这个 ComfyUI 没有该加载器节点，或 /object_info 的返回不是预期形状。缺的是「${spec.what}」，请在 ComfyUI 里确认 ${spec.loader} 节点可用后重试。`);
		const name = pickModelFile(optionsList, /qwen/i, spec.bonus);
		if (name === void 0) {
			const seen = optionsList.length === 0 ? "（空）" : optionsList.join(", ");
			throw new Error(`comfyui backend: 缺模型文件 — ${spec.loader}.${spec.field} 里没有任何带 "qwen" 的文件。\n  需要：${spec.what}\n  例如：${spec.example}\n  放到：${folderHint(options.modelsDir, spec.folder)}\n  ${spec.loader} 当前能看到 ${optionsList.length} 个文件：${seen}\n  （文件名里带 qwen 的才会被识别；本插件不下载、不转换权重。）`);
		}
		chosen.set(kind, name);
	}
	const clipTypes = loaderField(loaded.get("clip")?.payload, MODEL_KINDS.clip.loader, "type");
	const clipType = clipTypes?.includes("qwen_image") === true ? "qwen_image" : clipTypes?.find((type) => /qwen/i.test(type));
	if (clipType === void 0) throw new Error(`comfyui backend: CLIPLoader.type 里没有 qwen 相关选项，无法确定文本编码器类型（${MODEL_KINDS.clip.what}）。当前可选：${clipTypes === void 0 ? "（读不到）" : clipTypes.join(", ")}`);
	return {
		unet: chosen.get("unet"),
		clip: chosen.get("clip"),
		vae: chosen.get("vae"),
		clipType
	};
}
/**
* The Qwen-Image 2.1 text-to-image graph, in ComfyUI's API format.
*
* `{{name}}` placeholders are filled by {@link renderWorkflow}; the three model
* file names are placeholders on purpose — they come from `/object_info`.
*/
const QWEN_IMAGE_WORKFLOW = {
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
			model: ["1", 0],
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
* The edit graph, which is the text-to-image graph with a different encode node:
* `TextEncodeQwenImage21` additionally receives the VAE (it VAE-encodes each
* reference into the condition) and a `resolution` pixel budget. The reference
* slots themselves are added per call by {@link editWorkflow}.
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
* Wire one `LoadImage` per reference into the edit graph's autogrow inputs.
*
* ComfyUI's schema DSL expands the autogrow `images` input into
* `images.image_1` … `images.image_16`, all optional, and validates by those
* dotted names — which is also how the official edit template refers to them.
*
* @param imageNames - file names inside ComfyUI's `input` folder, in prompt
*   order, as `/upload/image` reported them.
* @returns a fresh API-format graph with one loader per reference.
* @throws When the list is empty or longer than {@link EDIT_MAX_REFERENCES}.
*/
function editWorkflow(imageNames) {
	if (imageNames.length === 0) throw new Error("comfyui backend: the edit graph needs at least one reference image");
	if (imageNames.length > 10) throw new Error(`comfyui backend: the edit graph wires 10 reference slots, got ${imageNames.length}`);
	const graph = { ...QWEN_IMAGE_EDIT_WORKFLOW };
	const encode = {
		class_type: "TextEncodeQwenImage21",
		inputs: { ...QWEN_IMAGE_EDIT_WORKFLOW["4"].inputs }
	};
	graph["4"] = encode;
	for (const [position, name] of imageNames.entries()) {
		const id = String(11 + position);
		graph[id] = {
			class_type: "LoadImage",
			inputs: { image: name }
		};
		encode.inputs[`images.image_${position + 1}`] = [id, 0];
	}
	return graph;
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
* Run one text-to-image job on ComfyUI and download the resulting images.
*
* `/prompt` → poll `/history/<id>` → `/view` for each saved file. The bytes the
* caller receives are exactly what `/view` served, so what lands on disk equals
* what ComfyUI produced.
*
* @param target - the endpoint that answered.
* @param models - the three file names read from `/object_info`.
* @param request - prompt plus the already-aligned canvas size.
* @param options - timeout and poll interval.
* @param signal - caller cancellation.
* @returns one entry per produced image, in ComfyUI's order.
* @throws On submission errors (with `node_errors` quoted), an execution error
*   (with the traceback quoted), a timeout naming the prompt id, or a run that
*   completed without producing an image.
*/
async function generateViaComfyUi(target, models, request, options, signal) {
	return await runGraph(target, renderWorkflow(QWEN_IMAGE_WORKFLOW, {
		unet_name: models.unet,
		weight_dtype: "default",
		clip_name: models.clip,
		clip_type: models.clipType,
		vae_name: models.vae,
		prompt: request.prompt,
		negative_prompt: "",
		width: request.width,
		height: request.height,
		batch_size: request.count,
		seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
		steps: request.steps ?? 25,
		cfg: 1,
		sampler_name: "euler",
		scheduler: "simple",
		filename_prefix: "dsh-image-forge"
	}), "出图", options, signal);
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
function referenceBudget$1(width, height) {
	const aligned = Math.round(Math.sqrt(width * height) / 32) * 32;
	return Math.min(4096, Math.max(32, aligned));
}
/**
* Run one reference-image edit on ComfyUI and download the resulting images.
*
* The references are uploaded into ComfyUI's `input` folder first, because
* `LoadImage` — the only node that feeds image pixels into a graph — reads from
* there and has no "load this path" input. The graph is then the text-to-image
* graph with the official edit template's encode node.
*
* @param target - the endpoint that answered.
* @param models - the three file names read from `/object_info`.
* @param request - edit prompt, canvas, and at least one reference image.
* @param options - timeout and poll interval.
* @param signal - caller cancellation.
* @returns one entry per produced image, in ComfyUI's order.
* @throws When no reference is present, an upload fails, or the run fails.
*/
async function generateViaComfyUiEdit(target, models, request, options, signal) {
	const references = request.images ?? [];
	if (references.length === 0) throw new Error("comfyui backend: the edit path needs reference images, but request.images is empty");
	const deadline = Date.now() + options.timeoutMs;
	const names = [];
	for (const reference of references) names.push(await uploadReferenceImage(target, reference, Math.max(1, deadline - Date.now()), signal));
	return await runGraph(target, renderWorkflow(editWorkflow(names), {
		unet_name: models.unet,
		weight_dtype: "default",
		clip_name: models.clip,
		clip_type: models.clipType,
		vae_name: models.vae,
		prompt: request.prompt,
		negative_prompt: "",
		resolution: referenceBudget$1(request.width, request.height),
		width: request.width,
		height: request.height,
		batch_size: request.count,
		seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
		steps: request.steps ?? 25,
		cfg: 1,
		sampler_name: "euler",
		scheduler: "simple",
		filename_prefix: "dsh-image-forge-edit"
	}), "改图", options, signal);
}
/**
* Probe the ComfyUI backend for a status report; never throws.
*
* @param options - endpoint, candidate ports, and probe budget.
* @param signal - caller cancellation.
* @returns reachability, the endpoint that answered, the attempt trail, and —
*   when a server answered — whether the three Qwen-Image weights are visible.
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
		return {
			endpoint: target.endpoint,
			port: target.port,
			reachable: true,
			probed: target.probed,
			models: {
				...models,
				ok: true
			},
			note: "ComfyUI 在跑，且三个 Qwen-Image 权重都能被它的加载器枚举到。"
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
//#region src/env.ts
/**
* Machine and backend probes for `qwen_image_env status`.
*
* Everything here is read-only and reports facts it actually obtained: a probe
* that cannot run says why (`note`) instead of guessing a number. The local
* inference worker is this plugin's own component now, so beyond "does the
* endpoint answer" this module also explains *why* the GPU may not have room —
* most often a resident ComfyUI, which must be told to let go.
*/
/**
* Run one command with a hard timeout, never through a shell.
*
* Output is captured through a file descriptor rather than a pipe: this host's
* sandbox denies pipe-backed spawns, which would silently degrade every GPU
* probe to "unavailable".
*/
async function run(file, args, timeoutMs, scratchDir) {
	const result = await runCaptured(file, args, {
		timeoutMs,
		scratchDir,
		label: "probe",
		maxOutputBytes: 262144
	});
	if (!result.ok) {
		const note = result.code === null && result.note !== void 0 ? result.note.includes("ENOENT") ? `${file} not found on PATH` : result.note : result.output.trim().length > 0 ? result.output.slice(-300) : `${file} exited ${result.code ?? "null"}`;
		return {
			ok: false,
			stdout: result.output,
			note
		};
	}
	return {
		ok: true,
		stdout: result.output
	};
}
/**
* Probe the GPU through `nvidia-smi`.
*
* @param timeoutMs - command budget; the tool call should not stall on a hung
*   driver query.
* @param scratchDir - where the command's throwaway log goes.
* @returns per-GPU name, total and used VRAM, or the reason there is none.
*/
async function probeGpu(timeoutMs = 5e3, scratchDir) {
	const result = await run("nvidia-smi", ["--query-gpu=index,name,memory.total,memory.used,driver_version", "--format=csv,noheader,nounits"], timeoutMs, scratchDir);
	if (!result.ok) return {
		ok: false,
		note: result.note
	};
	const gpus = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).map((line) => {
		const [index, name, totalMiB, usedMiB, driver] = line.split(",").map((part) => part.trim());
		return {
			index: Number(index),
			name,
			vramTotalMiB: Number(totalMiB),
			vramUsedMiB: Number(usedMiB),
			vramFreeMiB: Number(totalMiB) - Number(usedMiB),
			driver
		};
	});
	if (gpus.length === 0) return {
		ok: false,
		note: "nvidia-smi reported no GPU"
	};
	return {
		ok: true,
		data: {
			count: gpus.length,
			gpus
		}
	};
}
/**
* List the processes holding VRAM.
*
* @param timeoutMs - command budget.
* @param scratchDir - where the command's throwaway log goes.
* @returns pid, used MiB and executable name per compute process.
*/
async function probeGpuProcesses(timeoutMs = 5e3, scratchDir) {
	const result = await run("nvidia-smi", ["--query-compute-apps=pid,used_memory,process_name", "--format=csv,noheader,nounits"], timeoutMs, scratchDir);
	if (!result.ok) return {
		ok: false,
		note: result.note
	};
	const processes = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).map((line) => {
		const [pid, used, ...rest] = line.split(",").map((part) => part.trim());
		const usedMiB = Number(used);
		return {
			pid: Number(pid),
			usedMiB: Number.isFinite(usedMiB) ? usedMiB : null,
			name: rest.join(",")
		};
	}).filter((entry) => Number.isFinite(entry.pid));
	return {
		ok: true,
		data: {
			count: processes.length,
			processes
		}
	};
}
/**
* Resolve which process is listening on a loopback port.
*
* Windows' `netstat -ano` is the only local way to link a port back to a pid,
* and that link is what turns "some python holds 2.9 GiB" into "ComfyUI holds
* 2.9 GiB, tell it to free memory".
*
* @param port - port to look up.
* @param timeoutMs - command budget.
* @param scratchDir - where the command's throwaway log goes.
* @returns the pid, or undefined when it cannot be determined.
*/
async function resolveListenerPid(port, timeoutMs = 5e3, scratchDir) {
	const result = await run("netstat", [
		"-ano",
		"-p",
		"tcp"
	], timeoutMs, scratchDir);
	if (!result.ok) return void 0;
	for (const line of result.stdout.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 5 || fields[0].toUpperCase() !== "TCP") continue;
		if (!fields[1].endsWith(`:${port}`) || !/LISTEN/i.test(fields[3])) continue;
		const pid = Number(fields[4]);
		if (Number.isInteger(pid) && pid > 0) return pid;
	}
}
/**
* The one command that makes ComfyUI hand its VRAM back.
*
* ComfyUI ships this endpoint and it is the only supported way to unload its
* models from outside. It lives in one place so the `status` advisory, the
* pre-start gate and the crash diagnosis cannot drift apart.
*
* @param port - the port ComfyUI answers on.
* @returns a copy-pasteable `curl` invocation.
*/
function comfyFreeCommand(port) {
	return `curl -X POST http://127.0.0.1:${port}/free -H "Content-Type: application/json" -d "{\\"unload_models\\":true,\\"free_memory\\":true}"`;
}
/**
* Ask ComfyUI to unload its models and free memory (`POST /free`).
*
* This unloads *another program's* models, so it is only ever called after the
* user opted in (`freeComfyBeforeLocalStart`); the default path reports the
* command instead of running it.
*
* @param port - the port ComfyUI answers on.
* @param timeoutMs - request budget.
* @returns what ComfyUI said, or why it could not be asked.
*/
async function freeComfyMemory(port, timeoutMs = 15e3) {
	const url = `http://127.0.0.1:${port}/free`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), timeoutMs);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				unload_models: true,
				free_memory: true
			}),
			signal: controller.signal
		});
		let body = "";
		try {
			body = (await response.text()).trim().slice(0, 300);
		} catch {
			body = "";
		}
		return {
			ok: response.ok,
			url,
			httpStatus: response.status,
			body
		};
	} catch (error) {
		return {
			ok: false,
			url,
			httpStatus: 0,
			body: "",
			note: error instanceof Error ? error.message : String(error)
		};
	} finally {
		clearTimeout(timer);
	}
}
/**
* Turn the GPU facts into a verdict plus one executable suggestion.
*
* @param gpu - `probeGpu` result.
* @param processes - `probeGpuProcesses` result.
* @param comfyui - ComfyUI probe result (its `port` links the residency to it).
* @param requiredMiB - free VRAM below which generation is expected to fail.
* @param comfyPid - pid found listening on the ComfyUI port, when known.
* @returns the advisory embedded in the status report.
*/
function analyseVram(gpu, processes, comfyui, requiredMiB, comfyPid) {
	const gpuList = gpu.data?.gpus ?? [];
	const freeMiB = typeof gpuList[0]?.vramFreeMiB === "number" ? gpuList[0].vramFreeMiB : null;
	const totalMiB = typeof gpuList[0]?.vramTotalMiB === "number" ? gpuList[0].vramTotalMiB : null;
	const raw = processes.data?.processes ?? [];
	const comfyPort = typeof comfyui.port === "number" ? comfyui.port : void 0;
	const holders = raw.map((process) => ({
		...process,
		comfyui: comfyPid !== void 0 && process.pid === comfyPid || /comfy/i.test(process.name)
	}));
	const warn = freeMiB !== null && freeMiB < requiredMiB;
	const shortfallMiB = warn ? requiredMiB - (freeMiB ?? 0) : null;
	const comfyPortNumber = comfyPort ?? 8188;
	const comfyLooksInvolved = holders.some((holder) => holder.comfyui) || comfyui.reachable === true;
	const start_gate = {
		allowed: shortfallMiB === null,
		shortfallMiB,
		remedy: shortfallMiB === null || !comfyLooksInvolved ? null : comfyFreeCommand(comfyPortNumber),
		no_visible_holder: shortfallMiB !== null && holders.length === 0
	};
	const suggestions = [];
	if (warn) {
		const comfyHolder = holders.find((holder) => holder.comfyui);
		if (comfyHolder !== void 0) {
			const port = comfyPort ?? 8188;
			suggestions.push(`显存被 ComfyUI（pid ${comfyHolder.pid}${comfyHolder.usedMiB === null ? "" : `，约 ${comfyHolder.usedMiB} MiB`}）占着；先让它放手：${comfyFreeCommand(port)}`);
		}
		const others = holders.filter((holder) => !holder.comfyui);
		if (others.length > 0) suggestions.push(`另有进程占着显存：${others.map((holder) => `pid ${holder.pid} (${holder.name || "unknown"})`).join("、")}。其中可能就有本插件的 worker（它常驻约 4.5 GiB）：若是，用 \`qwen_image_env action:"unload"\` 回收；若是 ComfyUI，用它自己的 \`POST /free\`。`);
		if (others.length === 0 && comfyHolder === void 0 && comfyui.reachable === true) {
			const port = comfyPort ?? 8188;
			suggestions.push(`ComfyUI 在 127.0.0.1:${port} 上跑着（它加载了模型会常驻约 2.9 GiB 显存），但这次没能把占用归到它头上；先试它的 POST /free：${comfyFreeCommand(port)}`);
		}
		if (holders.length === 0) suggestions.push(`nvidia-smi 一个计算进程都没报，但显存就是不够——别把这读成「没人占着」：ComfyUI 跑完会在它自己的进程里留下约 3.6 GiB 的 \`cudaMallocAsync\` 分配器缓存，而 \`nvidia-smi --query-compute-apps\` 列不出占用进程（见 \`docs/configuration.md\`「一个会让人卡住的显存陷阱（8 GB 卡必读）」一节）。先试 ${comfyFreeCommand(comfyPortNumber)}（ComfyUI 还在就有效）；它已经不在了就只剩等那些分配被释放。另外隔十几秒再重跑：背靠背启动 python 会撞 Windows \`OSError 1455 页面文件太小\`（host commit 压力），那与 worker 无关。8 GB 卡上 \`freeComfyBeforeLocalStart: true\` 一般是必需项，不是可选优化。`);
		suggestions.push(`本次生成需要约 4.5 GiB 空闲显存（2K 峰值实测 17041 MiB 是关掉 VAE tiling 的数字，本 worker 强制开 tiling）；当前空闲 ${freeMiB} MiB，低于阈值 ${requiredMiB} MiB。`);
	}
	return {
		freeMiB,
		totalMiB,
		warn,
		requiredMiB,
		holders,
		suggestions,
		start_gate
	};
}
/**
* What to say when the pre-start gate **allowed** a start anyway.
*
* "Allowed" is not "the card was empty": the floor only covers the ~4.5 GiB the
* transformer allocates at load, so a ComfyUI holding ~2.9 GiB of models — plus the
* ~3.6 GiB allocator cache it keeps after a job — can leave the gate satisfied and
* still take the worker down mid-load. The gate therefore reports who was there
* instead of staying silent, and names the two remedies that actually work.
*
* @param advisory - the verdict the gate made.
* @param comfyPort - the port ComfyUI answers on, for the `/free` command.
* @returns the warning, or null when the start was refused (the refusal says it) or
*   when nothing was reported holding VRAM.
*/
function vramSuspicionWarning(advisory, comfyPort) {
	if (!advisory.start_gate.allowed || advisory.holders.length === 0) return null;
	const list = advisory.holders.map((holder) => `pid ${holder.pid} ${holder.name || "unknown"}${holder.usedMiB === null ? "" : `，约 ${holder.usedMiB} MiB`}${holder.comfyui ? `（ComfyUI，监听 127.0.0.1:${comfyPort}）` : ""}`);
	return `本地 worker 启动门禁**放行**了（空闲 ${advisory.freeMiB ?? "?"} MiB ≥ 阈值 ${advisory.requiredMiB} MiB），但当时有 ${advisory.holders.length} 个进程占着显存：\n  • ${list.join("\n  • ")}\n  放行不等于安全：worker 加载要一次性拿约 4.5 GiB，上面这些占用会在那一刻吃掉余量；ComfyUI 跑完还会在自己进程里留下约 3.6 GiB 的 \`cudaMallocAsync\` 分配器缓存，而它列不出来。
  建议先让出地方：` + (advisory.holders.some((holder) => holder.comfyui) ? `${comfyFreeCommand(comfyPort)}；` : "") + "或把 `freeComfyBeforeLocalStart` 设为 true，让插件每次启动前自己发那条请求。\n  刚跑完一次生成/试玩也不要立刻重试：隔十几秒再跑（背靠背启动 python 会撞 Windows `OSError 1455 页面文件太小`，那是 host commit 压力）。";
}
/** Report host CPU, RAM, and OS facts. */
function probeHost() {
	const cpuList = cpus();
	return {
		ok: true,
		data: {
			platform: platform(),
			arch,
			osRelease: release(),
			node: process.version,
			cpuModel: cpuList[0]?.model ?? "unknown",
			cpuCount: cpuList.length,
			memoryTotalMiB: Math.round(totalmem() / 1024 / 1024),
			memoryFreeMiB: Math.round(freemem() / 1024 / 1024)
		}
	};
}
/**
* Report free space on the volume holding a directory.
*
* @param dir - directory that must exist; the tool passes the configured
*   `outputDir`, which it creates first if needed.
* @returns free/total bytes of the containing volume.
*/
async function probeDisk(dir) {
	try {
		const stats = await statfs(dir);
		const free = Number(stats.bavail) * Number(stats.bsize);
		const total = Number(stats.blocks) * Number(stats.bsize);
		return {
			ok: true,
			data: {
				path: dir,
				freeMiB: Math.round(free / 1024 / 1024),
				totalMiB: Math.round(total / 1024 / 1024),
				freePercent: total === 0 ? null : Number((free / total * 100).toFixed(1))
			}
		};
	} catch (error) {
		return {
			ok: false,
			note: `cannot stat "${dir}": ${error instanceof Error ? error.message : String(error)}`
		};
	}
}
/**
* Ask whether an HTTP endpoint answers.
*
* @param url - endpoint to GET.
* @param timeoutMs - request budget.
* @param signal - caller cancellation.
* @returns reachability, status code, or the transport error.
*/
async function probeHttp(url, timeoutMs, signal) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return {
			ok: true,
			data: {
				url,
				reachable: true,
				status: (await fetch(url, {
					method: "GET",
					signal: controller.signal
				})).status
			}
		};
	} catch (error) {
		return {
			ok: false,
			note: `${url} unreachable: ${error instanceof Error ? error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message : String(error)}`,
			data: {
				url,
				reachable: false
			}
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
/**
* Collect the full status report: GPU, host, disk, and both backend endpoints.
*
* Probes run concurrently; a failing probe degrades its own field only.
*
* @param input - resolved configuration facts plus the key-presence flag.
* @param signal - caller cancellation.
* @returns the report body returned by `qwen_image_env status`.
*/
async function collectEnvStatus(input, signal) {
	const minFreeVramMiB = input.minFreeVramMiB ?? 5500;
	const [gpu, processes, disk, api, local] = await Promise.all([
		probeGpu(input.probeTimeoutMs, input.scratchDir),
		probeGpuProcesses(input.probeTimeoutMs, input.scratchDir),
		probeDisk(input.outputDir),
		probeHttp(`${input.apiBaseUrl}/models`, input.probeTimeoutMs, signal),
		probeHttp(`${input.localEndpoint}/health`, 1500, signal)
	]);
	const comfyPort = typeof input.comfyui.port === "number" ? input.comfyui.port : void 0;
	const comfyPid = input.comfyui.reachable === true && comfyPort !== void 0 ? await resolveListenerPid(comfyPort, input.probeTimeoutMs, input.scratchDir) : void 0;
	const advisory = analyseVram(gpu, processes, input.comfyui, minFreeVramMiB, comfyPid);
	return {
		host: probeHost(),
		gpu: gpu.ok ? {
			...gpu,
			data: {
				...gpu.data,
				advisory
			}
		} : gpu,
		gpu_processes: processes,
		vram_advisory: advisory,
		disk,
		backends: {
			api: {
				baseUrl: input.apiBaseUrl,
				keyPresent: input.apiKeyPresent,
				keySource: input.apiKeySource ?? null,
				...api
			},
			local: {
				endpoint: input.localEndpoint,
				...local
			},
			comfyui: input.comfyui
		},
		local_runtime: input.localRuntime ?? null,
		output: {
			dir: input.outputDir,
			writable: input.outputDirWritable
		},
		notes: [
			"gpu.vramFreeMiB is the driver-reported free VRAM at probe time; it is not a promise that a given model fits.",
			"vram_advisory 把「显存不够」翻译成一条可执行的下一步：本机实测 ComfyUI 会驻留约 2.9 GiB，它的 POST /free 能立刻放手。",
			"local.* 只探测本地 worker 的 HTTP 端点是否应答；local_runtime.* 才是本插件自己管理的 venv / 权重 / worker 生命周期。",
			"comfyui.* 只探测本机回环地址上的 ComfyUI（先 /system_stats，再 /object_info 枚举权重文件名）；本插件不下载、不转换任何权重。",
			"API keys are never included in this report — only whether one was found and from where."
		]
	};
}
//#endregion
//#region src/weights.ts
/**
* Weight management: does the local model exist, and how to get it.
*
* The mirror is `hf-mirror.com`, deliberately: on this machine `huggingface.co`
* answers at its root but times out on `/api/` paths, so a download driven
* through the canonical host stalls. Downloads are resumable (`Range`), hashed
* against the repo's LFS `sha256` while streaming, and preceded by a disk-space
* check — 10.6 GiB of weights must not fail at 95% because nobody counted.
*
* Nothing here deletes user data it did not create.
*/
/**
* The pipeline's files, used as the fallback list when the mirror's tree API
* cannot be reached (HEAD per file still works).
*/
const KNOWN_FILES = [
	"model_index.json",
	"scheduler/scheduler_config.json",
	"transformer/config.json",
	"transformer/diffusion_pytorch_model.safetensors",
	"text_encoder/config.json",
	"text_encoder/generation_config.json",
	"text_encoder/model.safetensors",
	"vae/config.json",
	"vae/diffusion_pytorch_model.safetensors",
	"processor/tokenizer.json",
	"processor/tokenizer_config.json",
	"processor/chat_template.jinja",
	"processor/processor_config.json"
];
/**
* The policy for a weight file that is already on disk: **size is the gate, sha256 is not
* re-run**.
*
* `hf-mirror` reports each LFS file's size *and* its sha256, and the plugin verifies the
* hash of every byte **it transfers itself** (a fresh download, or the tail of a resumed
* one — `seedHash` re-reads the existing prefix so the digest still covers the whole
* file). A file that was already complete is matched on size alone: re-hashing 10.63 GiB
* on every `fetch-weights` call would make a no-op call read the entire checkpoint off
* disk. That is a deliberate trade, so the receipt says so out loud (`sha256_verified:
* null` plus this note) instead of looking verified — a same-size corrupted file is
* accepted as complete, and deleting it is the way to force a re-download.
*/
const REUSED_SIZE_ONLY = "size matches the mirror; sha256 not re-verified in this run — delete the file to force a re-download";
/** The tensor this pipeline never reads, and the file that carries it. */
const UNUSED_TENSOR = {
	file: "text_encoder/model.safetensors",
	tensor: "lm_head.weight"
};
/**
* Is this file on disk already complete?
*
* Tensor files must be byte-exact. JSON config files are exempt from the size
* check on purpose: this plugin patches `quantization_config` inside two of them
* for the bnb CPU/GPU split, so their size legitimately differs from the repo's
* copy — and "re-download because the size differs" would silently undo that
* patch on every run.
*
* @param relative - repo-relative path.
* @param expected - size the listing reported (0 when unknown).
* @param actual - size on disk.
* @returns true when the file may be left alone.
*/
function fileIsComplete(relative, expected, actual) {
	if (actual <= 0) return false;
	if (!relative.endsWith(".safetensors")) return true;
	return expected <= 0 || actual === expected;
}
/** Read `quantization_config.llm_int8_enable_fp32_cpu_offload` from a config file. */
async function readQuantFlag(path) {
	try {
		const quantization = JSON.parse(await readFile(path, "utf8")).quantization_config;
		if (typeof quantization !== "object" || quantization === null) return null;
		return quantization.llm_int8_enable_fp32_cpu_offload === true;
	} catch {
		return null;
	}
}
/**
* Inspect a weights directory without touching it.
*
* @param dir - candidate model directory.
* @returns what is there, what is missing, and whether the bnb flag is set.
*/
async function inspectWeights(dir) {
	const present = [];
	const missing = [];
	let totalBytes = 0;
	for (const relative of KNOWN_FILES) try {
		const info = await stat(join(dir, relative));
		if (info.isFile() && info.size > 0) {
			present.push(relative);
			totalBytes += info.size;
		} else missing.push(relative);
	} catch {
		missing.push(relative);
	}
	const transformerFlag = await readQuantFlag(join(dir, "transformer", "config.json"));
	const textEncoderFlag = await readQuantFlag(join(dir, "text_encoder", "config.json"));
	return {
		dir,
		exists: await stat(dir).then(() => true, () => false),
		ready: missing.length === 0,
		present_files: present,
		missing_files: missing,
		total_MiB: Math.round(totalBytes / 1024 / 1024),
		quantization_flag: transformerFlag === null || textEncoderFlag === null ? null : transformerFlag && textEncoderFlag,
		note: transformerFlag === true && textEncoderFlag === true ? void 0 : "both transformer/config.json and text_encoder/config.json need quantization_config.llm_int8_enable_fp32_cpu_offload = true for the bnb CPU/GPU split"
	};
}
/** Free space in MiB on the volume holding a directory (creating it first). */
async function freeSpaceMiB(dir) {
	try {
		await mkdir(dir, { recursive: true });
		const stats = await statfs(dir);
		return { freeMiB: Math.round(Number(stats.bavail) * Number(stats.bsize) / 1024 / 1024) };
	} catch (error) {
		return {
			freeMiB: -1,
			note: `cannot stat ${dir}: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}
/** Type-guard-ish read of the mirror's tree API payload. */
function parseTreePayload(payload) {
	if (!Array.isArray(payload)) return [];
	const files = [];
	for (const entry of payload) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry;
		if (record.type !== "file" || typeof record.path !== "string") continue;
		if (record.path.split("/").some((segment) => segment.startsWith("."))) continue;
		const lfs = typeof record.lfs === "object" && record.lfs !== null ? record.lfs : null;
		const size = typeof lfs?.size === "number" ? lfs.size : typeof record.size === "number" ? record.size : 0;
		const oid = typeof lfs?.oid === "string" && /^[0-9a-f]{64}$/.test(lfs.oid) ? lfs.oid : null;
		files.push({
			path: record.path,
			size,
			sha256: oid
		});
	}
	return files;
}
/** HEAD one resolve URL for its Content-Length. */
async function headSize(url, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), timeoutMs);
	try {
		const response = await fetch(url, {
			method: "HEAD",
			signal: controller.signal
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return Number(response.headers.get("content-length") ?? 0);
	} finally {
		clearTimeout(timer);
	}
}
/**
* List the repo's files from the mirror.
*
* @param options - repo, revision, mirror, and the HEAD fallback's budget.
* @returns the file list and which mechanism produced it.
*/
async function listRepoFiles(options) {
	const apiUrl = `${options.mirror}/api/models/${options.repo}/tree/${options.revision}?recursive=true`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), 3e4);
	let apiNote;
	try {
		const response = await fetch(apiUrl, { signal: controller.signal });
		if (response.ok) {
			const files = parseTreePayload(await response.json());
			if (files.length > 0) return {
				files,
				source: "api"
			};
			apiNote = `${apiUrl} answered but listed no files`;
		} else apiNote = `${apiUrl} answered HTTP ${response.status}`;
	} catch (error) {
		apiNote = `${apiUrl}: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		clearTimeout(timer);
	}
	const files = [];
	let headFailures = 0;
	for (const relative of KNOWN_FILES) try {
		const size = await headSize(`${options.mirror}/${options.repo}/resolve/${options.revision}/${relative}`, options.headTimeoutMs ?? 6e4);
		files.push({
			path: relative,
			size,
			sha256: null
		});
	} catch {
		headFailures += 1;
		files.push({
			path: relative,
			size: 0,
			sha256: null
		});
	}
	if (headFailures === KNOWN_FILES.length) return {
		files,
		source: "known",
		apiNote
	};
	return {
		files,
		source: "head",
		apiNote
	};
}
/** Hash the bytes already on disk, so a resumed download can keep verifying. */
async function seedHash(path) {
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		if ((await stat(path)).size === 0) return {
			hash,
			bytes: 0
		};
		const stream = createReadStream(path);
		for await (const chunk of stream) {
			hash.update(chunk);
			bytes += chunk.length;
		}
	} catch {}
	return {
		hash,
		bytes
	};
}
/** One file's transfer, resumable and hash-checked. */
async function downloadFile(options, file) {
	const destination = join(options.dir, file.path.replace(/\//g, process.platform === "win32" ? "\\" : "/"));
	await mkdir(dirname(destination), { recursive: true });
	const existing = await stat(destination).then((info) => info.size, () => 0);
	if (file.size > 0 && existing === file.size) return {
		path: file.path,
		status: "reused",
		bytes: existing,
		MiB: existing / 1024 / 1024,
		seconds: 0,
		sha256_verified: null,
		note: REUSED_SIZE_ONLY
	};
	const url = `${options.mirror}/${options.repo}/resolve/${options.revision}/${file.path}`;
	const { hash, bytes: have } = existing > 0 ? await seedHash(destination) : {
		hash: createHash("sha256"),
		bytes: 0
	};
	const started = Date.now();
	const controller = new AbortController();
	let stall = null;
	const armStall = () => {
		if (stall !== null) clearTimeout(stall);
		stall = setTimeout(() => controller.abort(/* @__PURE__ */ new Error(`no data for ${options.stallTimeoutMs} ms`)), options.stallTimeoutMs);
	};
	const onCallerAbort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onCallerAbort, { once: true });
	let written = 0;
	try {
		armStall();
		const headers = { "User-Agent": "dsh-image-forge/0.2" };
		if (have > 0) headers.Range = `bytes=${have}-`;
		const response = await fetch(url, {
			headers,
			signal: controller.signal
		});
		if (!response.ok) return {
			path: file.path,
			status: "failed",
			bytes: have,
			MiB: have / 1024 / 1024,
			seconds: (Date.now() - started) / 1e3,
			sha256_verified: null,
			note: `HTTP ${response.status} from ${url}`
		};
		const resuming = response.status === 206 && have > 0;
		const sink = createWriteStream(destination, { flags: resuming ? "a" : "w" });
		const body = Readable.fromWeb(response.body);
		body.on("data", (chunk) => {
			hash.update(chunk);
			written += chunk.length;
			armStall();
		});
		await pipeline(body, sink);
		const total = (resuming ? have : 0) + written;
		if (file.size > 0 && total !== file.size) return {
			path: file.path,
			status: "failed",
			bytes: total,
			MiB: total / 1024 / 1024,
			seconds: (Date.now() - started) / 1e3,
			sha256_verified: null,
			note: `size mismatch: got ${total} B, expected ${file.size} B (re-run to resume)`
		};
		const digest = hash.digest("hex");
		if (file.sha256 !== null && digest !== file.sha256) {
			await rm(destination, { force: true });
			return {
				path: file.path,
				status: "failed",
				bytes: 0,
				MiB: 0,
				seconds: (Date.now() - started) / 1e3,
				sha256_verified: false,
				note: `sha256 mismatch (expected ${file.sha256}, got ${digest}); the partial file was deleted, re-run to download it again`
			};
		}
		return {
			path: file.path,
			status: resuming ? "resumed" : "downloaded",
			bytes: total,
			MiB: total / 1024 / 1024,
			seconds: (Date.now() - started) / 1e3,
			sha256_verified: file.sha256 === null ? null : true
		};
	} catch (error) {
		return {
			path: file.path,
			status: "failed",
			bytes: have + written,
			MiB: (have + written) / 1024 / 1024,
			seconds: (Date.now() - started) / 1e3,
			sha256_verified: null,
			note: error instanceof Error ? error.message : String(error)
		};
	} finally {
		if (stall !== null) clearTimeout(stall);
		options.signal?.removeEventListener("abort", onCallerAbort);
	}
}
/**
* Set the bnb split flag in both configs, which the CPU/GPU placement requires.
*
* @param dir - model directory.
* @returns per-file outcome; a file whose flag was already set is left alone.
*/
async function applyQuantizationFlag(dir) {
	const outcome = {};
	for (const relative of ["transformer/config.json", "text_encoder/config.json"]) {
		const path = join(dir, relative);
		try {
			const original = await readFile(path, "utf8");
			const parsed = JSON.parse(original);
			const quantization = typeof parsed.quantization_config === "object" && parsed.quantization_config !== null ? parsed.quantization_config : {};
			const alreadySet = quantization.llm_int8_enable_fp32_cpu_offload === true;
			quantization.llm_int8_enable_fp32_cpu_offload = true;
			parsed.quantization_config = quantization;
			const text = `${JSON.stringify(parsed, null, 2).replace(/("llm_int8_threshold"\s*:\s*)(-?\d+)(?=[\s,}])/g, "$1$2.0")}\n`;
			if (alreadySet && original === text) {
				outcome[relative] = "already set";
				continue;
			}
			await writeFile(path, text, "utf8");
			outcome[relative] = alreadySet ? "patched (threshold dtype)" : "patched";
		} catch (error) {
			outcome[relative] = `failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	return outcome;
}
/**
* Rewrite a `.safetensors` file without one tensor.
*
* The tensor map is the file's own JSON header; the data section is copied
* verbatim (only the dropped tensor's byte range is left out, and the surviving
* offsets are shifted), so no tensor content is ever re-encoded. The result is
* written beside the original and replaces it only after the new header reads
* back without the tensor and the file length matches.
*
* @param file - absolute `.safetensors` path.
* @param tensor - tensor name to drop.
* @returns bytes saved, or a note explaining why nothing was done.
*/
async function stripTensor(file, tensor) {
	const handle = await open(file, "r");
	let headerLength = 0;
	let removedBytes = 0;
	let expectedSize = 0;
	let strippedPath = `${file}.stripped`;
	try {
		const lengthBuffer = Buffer.alloc(8);
		await handle.read(lengthBuffer, 0, 8, 0);
		headerLength = Number(lengthBuffer.readBigUInt64LE(0));
		const headerBuffer = Buffer.alloc(headerLength);
		await handle.read(headerBuffer, 0, headerLength, 8);
		const header = JSON.parse(headerBuffer.toString("utf8"));
		const entry = header[tensor];
		if (typeof entry !== "object" || entry === null) return {
			removed: false,
			savedBytes: 0,
			note: `${tensor} is not in ${file}`
		};
		const [from, to] = entry.data_offsets;
		removedBytes = to - from;
		if (removedBytes <= 0) return {
			removed: false,
			savedBytes: 0,
			note: `${tensor} occupies no bytes in ${file}`
		};
		const kept = {};
		for (const [name, value] of Object.entries(header)) {
			if (name === tensor) continue;
			if (name === "__metadata__") {
				kept.__metadata__ = value;
				continue;
			}
			const cast = value;
			const [start, end] = cast.data_offsets;
			cast.data_offsets = [start > from ? start - removedBytes : start, end > from ? end - removedBytes : end];
			kept[name] = cast;
		}
		const rawHeader = Buffer.from(JSON.stringify(kept), "utf8");
		const paddedHeader = Buffer.alloc(Math.ceil(rawHeader.length / 8) * 8, 32);
		rawHeader.copy(paddedHeader);
		const totalBytes = (await handle.stat()).size;
		const dataStart = 8 + headerLength;
		const dataLength = totalBytes - dataStart;
		const keptRanges = [[0, from], [to, dataLength]].filter(([start, end]) => end > start);
		const sink = createWriteStream(strippedPath);
		const prefix = Buffer.alloc(8);
		prefix.writeBigUInt64LE(BigInt(paddedHeader.length));
		sink.write(prefix);
		sink.write(paddedHeader);
		const chunkSize = 8388608;
		for (const [start, end] of keptRanges) for (let position = start; position < end; position += chunkSize) {
			const size = Math.min(chunkSize, end - position);
			const buffer = Buffer.alloc(size);
			await handle.read(buffer, 0, size, dataStart + position);
			sink.write(buffer);
		}
		await new Promise((resolve, reject) => {
			sink.end((error) => error ? reject(error) : resolve());
		});
		expectedSize = 8 + paddedHeader.length + (dataLength - removedBytes);
	} finally {
		await handle.close();
	}
	try {
		const verify = await open(strippedPath, "r");
		try {
			const verifyLength = Buffer.alloc(8);
			await verify.read(verifyLength, 0, 8, 0);
			const verifyHeader = Buffer.alloc(Number(verifyLength.readBigUInt64LE(0)));
			await verify.read(verifyHeader, 0, verifyHeader.length, 8);
			const parsed = JSON.parse(verifyHeader.toString("utf8"));
			const rewritten = (await verify.stat()).size;
			if (tensor in parsed || rewritten !== expectedSize) return {
				removed: false,
				savedBytes: 0,
				note: `verification failed (tensor present: ${tensor in parsed}, size ${rewritten} B vs expected ${expectedSize} B); the original file is untouched`
			};
		} finally {
			await verify.close();
		}
		await rename(strippedPath, file);
		return {
			removed: true,
			savedBytes: removedBytes
		};
	} catch (error) {
		return {
			removed: false,
			savedBytes: 0,
			note: `${error instanceof Error ? error.message : String(error)}; the original file is untouched (the rewritten copy is at ${strippedPath})`
		};
	}
}
/**
* Fetch the weights from the mirror.
*
* @param options - resolved config plus the dry-run switch.
* @returns a per-file report; a failed file is reported, never thrown.
*/
async function runFetchWeights(options) {
	const listing = await listRepoFiles({
		repo: options.repo,
		mirror: options.mirror,
		revision: options.revision,
		headTimeoutMs: 6e4
	});
	const files = listing.files;
	const present = /* @__PURE__ */ new Set();
	let missingBytes = 0;
	for (const file of files) {
		const info = await stat(join(options.dir, file.path)).catch(() => null);
		if (info !== null && fileIsComplete(file.path, file.size, info.size)) {
			present.add(file.path);
			continue;
		}
		missingBytes += file.size;
	}
	const space = await freeSpaceMiB(options.dir);
	const neededMiB = Math.ceil(missingBytes / 1024 / 1024 * 1.02);
	const enough = space.freeMiB < 0 || space.freeMiB >= neededMiB;
	const disk = {
		freeMiB: space.freeMiB,
		neededMiB,
		enough,
		note: space.note
	};
	const build = (fileReports, ok, inspection, quantization, lmHead) => ({
		action: "fetch-weights",
		dry_run: options.dryRun,
		ok,
		repo: options.repo,
		mirror: options.mirror,
		dir: options.dir,
		listing_source: listing.source,
		api_note: listing.apiNote,
		files: fileReports,
		planned_MiB: neededMiB,
		disk,
		quantization,
		lm_head: lmHead,
		inspection,
		next: ok ? "Weights ready. `qwen_image_generate` can start the worker now." : "Re-run `action:\"fetch-weights\"` to resume; completed files are skipped, partial files continue from where they stopped."
	});
	if (options.dryRun) {
		const reports = files.map((file) => ({
			path: file.path,
			status: present.has(file.path) ? "reused" : "would-download",
			bytes: file.size,
			MiB: file.size / 1024 / 1024,
			seconds: 0,
			sha256_verified: null
		}));
		const ready = files.length > 0 && present.size === files.length;
		return {
			...build(reports, true, await inspectWeights(options.dir), null, null),
			dry_run_skipped: "nothing was downloaded; this is a plan",
			next: ready ? "Every file is already on disk and complete — nothing to download." : `Plan only: ${files.length - present.size} of ${files.length} file(s) are missing and would need ${neededMiB} MiB; nothing was downloaded. Re-run without \`dryRun\` to fetch them.`
		};
	}
	if (!enough && !options.force) return {
		...build([], false, await inspectWeights(options.dir), null, null),
		next: `Only ${space.freeMiB} MiB free on the volume holding ${options.dir}, but ${neededMiB} MiB is needed. Free space, point \`modelsDir\` at another volume, or pass \`force:true\` to try anyway.`
	};
	const reports = [];
	for (const file of files) {
		if (present.has(file.path)) {
			reports.push({
				path: file.path,
				status: "reused",
				bytes: file.size,
				MiB: file.size / 1024 / 1024,
				seconds: 0,
				sha256_verified: null,
				note: REUSED_SIZE_ONLY
			});
			continue;
		}
		reports.push(await downloadFile(options, file));
		if (options.signal?.aborted) break;
	}
	const failed = reports.filter((report) => report.status === "failed");
	const quantization = failed.length === 0 ? await applyQuantizationFlag(options.dir) : null;
	let lmHead = null;
	if (failed.length === 0 && options.skipLmHead) {
		const outcome = await stripTensor(join(options.dir, UNUSED_TENSOR.file), UNUSED_TENSOR.tensor).catch((error) => ({
			removed: false,
			savedBytes: 0,
			note: error instanceof Error ? error.message : String(error)
		}));
		lmHead = {
			...outcome,
			savedMiB: Math.round(outcome.savedBytes / 1024 / 1024),
			file: UNUSED_TENSOR.file,
			verified_on_this_machine: false
		};
	}
	return build(reports, failed.length === 0, await inspectWeights(options.dir), quantization, lmHead);
}
//#endregion
//#region src/maintenance.ts
/**
* Local-runtime status and repair: venv, weights, worker, and what to do next.
*
* The guiding rule for `repair` is that it must never claim a fix it did not
* make. Every check lands in exactly one of four states — `ok`, `fixed`,
* `unfixable` (with the reason *and* the remedy), or `skipped` — and nothing
* that requires a 10.6 GiB download is ever performed behind the user's back.
*/
/** Read the breadcrumb the worker writes, if one exists. */
async function readWorkerStateFile(dataDir) {
	try {
		return JSON.parse(await readFile(join(dataDir, "worker-state.json"), "utf8"));
	} catch {
		return null;
	}
}
/**
* Describe the plugin's own local stack.
*
* @param input - runtime handle plus the resolved paths.
* @returns worker / venv / weights facts and the advisories they imply.
*/
async function collectLocalRuntime(input) {
	const paths = venvPaths(input.runtimeDir);
	const [probe, weights] = await Promise.all([input.runtime.inspect(input.runtime.endpoint, 1500, input.signal), inspectWeights(input.modelsDir)]);
	const interpreterExists = pathExists(input.python);
	const interpreter = interpreterExists ? await probeInterpreter(input.python, {
		timeoutMs: 3e4,
		scratchDir: input.scratchDir
	}) : {
		path: input.python,
		ok: false,
		note: `not found: ${input.python} — run action "install"`
	};
	let packages = null;
	if (interpreterExists && input.skipPackages !== true) packages = await probePackages(input.python, {
		timeoutMs: 3e5,
		scratchDir: input.scratchDir
	});
	const breadcrumb = await readWorkerStateFile(input.dataDir);
	const advisories = [];
	if (!weights.ready) advisories.push(`权重未就绪（缺 ${weights.missing_files.length} 个文件，目录 ${input.modelsDir}）：跑 \`qwen_image_env action:"fetch-weights"\`（先加 \`dryRun:true\` 看清单与磁盘需求）。`);
	if (!interpreterExists) advisories.push(`venv 解释器不存在：${input.python} —— 跑 \`qwen_image_env action:"install"\`。`);
	else if (packages !== null && !packages.ok) advisories.push(`venv 里缺包（${packages.note ?? "未知名"}）：跑 \`qwen_image_env action:"repair"\` 补装。`);
	const workerReport = describeWorker(probe, input.runtime, breadcrumb);
	const lifecycle = workerReport.state;
	advisories.unshift(workerReport.explanation);
	if (lifecycle === "not-responding" || lifecycle === "load-failed") {
		if (input.runtime.lastStartFailureAt !== null) advisories.push(`上一次启动失败的原因：${input.runtime.lastStartFailureAt.message}`);
	}
	if (lifecycle === "never-started" && weights.ready && interpreterExists && (packages === null || packages.ok)) advisories.push("环境齐备：直接调 `qwen_image_generate` 即可，插件会自己拉起 worker（冷启动约 15 s，2K 首图约 50 s）。");
	return {
		worker: workerReport,
		venv: {
			dir: paths.venvDir,
			python: input.python,
			exists: interpreterExists,
			version: interpreter.ok ? interpreter.version : null,
			note: interpreter.ok ? null : interpreter.note,
			packages: packages?.versions ?? null,
			packages_ok: packages?.ok ?? null,
			packages_note: packages?.note ?? null,
			torch: packages?.torch ?? null
		},
		weights,
		advisories,
		ready_to_generate: weights.ready && interpreterExists && (packages === null || packages.ok) && lifecycle !== "load-failed" && lifecycle !== "not-responding"
	};
}
/**
* Decide which of the six states the worker is in.
*
* The states a user confuses, and why they must be separated: "never started"
* (nothing to fix — the first generation starts it), "not responding" (the
* plugin watched it die, or a breadcrumb pid is alive but the port refuses —
* typically an external kill, *not* a misconfiguration), and "load failed"
* (a real environment problem that retrying will not fix).
*
* @param probe - the passive probe result.
* @param runtime - the lifecycle owner.
* @param breadcrumb - the worker's last written `worker-state.json`.
* @returns the state plus one sentence explaining it.
*/
function classifyWorker(probe, runtime, breadcrumb) {
	if (probe.reachable) {
		if (probe.state?.load_error !== null && probe.state?.load_error !== void 0) return {
			state: "load-failed",
			explanation: `worker 在跑，但模型加载失败：${probe.state.load_error}（重试不会修好，先看日志与环境）。`
		};
		if (probe.ready) return {
			state: "ready",
			explanation: `worker 在 ${probe.endpoint} 上就绪（pid ${probe.state?.pid ?? "?"}）。`
		};
		if (probe.state?.loading === true) return {
			state: "starting",
			explanation: "worker 在跑，模型正在加载（/health 还是 503）。"
		};
		return {
			state: "unloaded",
			explanation: "worker 进程在跑但模型已卸载（空闲回收或 POST /unload）；下一张图会自动重新加载。"
		};
	}
	const pid = runtime.pid ?? breadcrumb?.pid;
	if (runtime.sawWorkerExit) return {
		state: "not-responding",
		explanation: `worker 已经被结束（插件看到了子进程的 exit 事件${pid === void 0 ? "" : `，上次 pid ${pid}`}），${probe.endpoint} 现在拒绝连接。**这不是配置问题**：下一次 \`qwen_image_generate\` 会自动重拉一个。`
	};
	if (breadcrumb !== null) return {
		state: "not-responding",
		explanation: `worker-state.json 记的 pid ${breadcrumb.pid} 还活着，但 ${probe.endpoint} 不应答——多半是卡死；跑 \`qwen_image_env action:"repair"\` 会把它杀掉。`
	};
	return {
		state: "never-started",
		explanation: `worker 从未启动（${probe.endpoint} 无人应答）；第一次出图时插件会自己拉起它。`
	};
}
/** Shape one worker probe plus the runtime's own bookkeeping. */
function describeWorker(probe, runtime, breadcrumb) {
	const state = probe.state;
	const lifecycle = classifyWorker(probe, runtime, breadcrumb);
	const lastFailure = runtime.lastStartFailureAt;
	return {
		state: lifecycle.state,
		explanation: lifecycle.explanation,
		last_start_failure: lastFailure === null ? null : {
			seconds_ago: Math.round((Date.now() - lastFailure.at) / 1e3),
			message: lastFailure.message
		},
		endpoint: probe.endpoint,
		port: runtime.port,
		reachable: probe.reachable,
		ready: probe.ready,
		ours: probe.ours,
		managed_by_this_session: runtime.ownsProcess,
		pid: typeof state?.pid === "number" ? state.pid : runtime.pid ?? breadcrumb?.pid ?? null,
		rss_MiB: state?.rss_MiB ?? null,
		vram_allocated_MiB: state?.vram_allocated_MiB ?? null,
		vram_reserved_MiB: state?.vram_reserved_MiB ?? null,
		generations: state?.generations ?? null,
		load_seconds: state?.load_seconds ?? null,
		uptime_s: state?.uptime_s ?? null,
		load_error: state?.load_error ?? null,
		version: state?.version ?? null,
		log_file: runtime.logFile,
		health_status: probe.healthStatus ?? null,
		note: probe.note,
		lifecycle_events: runtime.events.slice(0, 10)
	};
}
/**
* Fix what can be fixed locally, and name what cannot.
*
* @param options - resolved config paths plus the runtime handle.
* @returns per-check outcomes, the install report when one ran, and the next step.
*/
async function runRepair(options) {
	const checks = [];
	const weights = await inspectWeights(options.modelsDir);
	if (weights.ready) {
		if (weights.quantization_flag === true) checks.push({
			name: "weights:quantization flag",
			status: "ok",
			detail: "llm_int8_enable_fp32_cpu_offload is set in both configs"
		});
		else if (options.dryRun) checks.push({
			name: "weights:quantization flag",
			status: "skipped",
			detail: "would set quantization_config.llm_int8_enable_fp32_cpu_offload = true in transformer/config.json and text_encoder/config.json"
		});
		else {
			const outcome = await applyQuantizationFlag(options.modelsDir);
			const failed = Object.entries(outcome).filter(([, value]) => typeof value === "string" && value.startsWith("failed"));
			checks.push({
				name: "weights:quantization flag",
				status: failed.length === 0 ? "fixed" : "unfixable",
				detail: JSON.stringify(outcome),
				remedy: failed.length === 0 ? null : "Check the model directory permissions."
			});
		}
	} else checks.push({
		name: "weights",
		status: "unfixable",
		detail: `${weights.missing_files.length} of ${weights.missing_files.length + weights.present_files.length} files are missing in ${options.modelsDir}`,
		remedy: "Run `qwen_image_env action:\"fetch-weights\"` — repair never downloads 10.6 GiB on its own."
	});
	let install = null;
	if (executableMissing(options.python)) {
		if (options.dryRun) checks.push({
			name: "venv",
			status: "skipped",
			detail: `would create ${options.python}`
		});
		install = await runInstall({
			runtimeDir: options.runtimeDir,
			pipwrap: options.pipwrap,
			basePythonCandidates: options.basePythonCandidates,
			torchWheels: options.torchWheels,
			pipIndexUrl: options.pipIndexUrl,
			reuseBaseTorch: options.reuseBaseTorch,
			dryRun: options.dryRun,
			commandTimeoutMs: options.commandTimeoutMs,
			scratchDir: options.scratchDir
		});
		checks.push({
			name: "venv:install",
			status: options.dryRun ? "skipped" : install.ok ? "fixed" : "unfixable",
			detail: options.dryRun ? "dry run: nothing was executed" : install.steps.map((step) => `${step.name}=${step.status}`).join(", "),
			remedy: install.ok ? null : install.next
		});
	} else {
		const packages = await probePackages(options.python, {
			timeoutMs: 3e5,
			scratchDir: options.scratchDir
		});
		if (packages.ok) checks.push({
			name: "venv:packages",
			status: "ok",
			detail: `torch ${packages.torch?.version ?? "?"} (cuda ${packages.torch?.cuda ?? "none"})`
		});
		else if (options.dryRun) checks.push({
			name: "venv:packages",
			status: "skipped",
			detail: `would install: ${packages.note ?? "unknown"}`
		});
		else {
			install = await runInstall({
				runtimeDir: options.runtimeDir,
				pipwrap: options.pipwrap,
				basePythonCandidates: options.basePythonCandidates,
				torchWheels: options.torchWheels,
				pipIndexUrl: options.pipIndexUrl,
				reuseBaseTorch: options.reuseBaseTorch,
				dryRun: false,
				commandTimeoutMs: options.commandTimeoutMs,
				scratchDir: options.scratchDir
			});
			checks.push({
				name: "venv:packages",
				status: install.ok ? "fixed" : "unfixable",
				detail: install.steps.map((step) => `${step.name}=${step.status}`).join(", "),
				remedy: install.ok ? null : install.next
			});
		}
	}
	const probe = await options.runtime.inspect(options.runtime.endpoint, 1500, options.signal);
	const breadcrumb = await readWorkerStateFile(options.dataDir);
	if (probe.reachable) {
		if (probe.state?.load_error) checks.push({
			name: "worker",
			status: "unfixable",
			detail: `the worker is up but its model failed to load: ${probe.state.load_error}`,
			remedy: `Read the log tail (${options.runtime.logFile ?? "worker log"}) — a load failure is a weights/environment problem, not a stuck process.`
		});
		else checks.push({
			name: "worker",
			status: "ok",
			detail: `answering on ${probe.endpoint} (ready=${probe.ready})`
		});
	} else if (options.runtime.pid !== null && options.dryRun) checks.push({
		name: "worker",
		status: "skipped",
		detail: `would stop the unresponsive worker pid ${options.runtime.pid} owned by this session`
	});
	else if (options.runtime.pid !== null) {
		const pid = options.runtime.pid;
		const stopped = await options.runtime.stop();
		const fixed = stopped.stopped === true;
		checks.push({
			name: "worker",
			status: fixed ? "fixed" : "unfixable",
			detail: fixed ? `stopped the unresponsive worker pid ${pid}; the next generation starts a fresh one` : `the worker pid ${pid} does not answer HTTP and could not be stopped: ${String(stopped.reason ?? "unknown")}`,
			remedy: fixed ? null : `Stop pid ${pid} manually, then call \`qwen_image_generate\` again.`
		});
	} else if (breadcrumb?.pid !== void 0) checks.push({
		name: "worker",
		status: "unfixable",
		detail: `worker-state.json records pid ${breadcrumb.pid} from an earlier session, and ${options.runtime.endpoint} does not answer. The plugin will not kill a pid it does not own.`,
		remedy: `If pid ${breadcrumb.pid} is really still there, stop it yourself (\`taskkill /PID ${breadcrumb.pid} /F\` on Windows). Otherwise nothing is blocked: a worker that does not answer is simply started again on demand.`
	});
	else checks.push({
		name: "worker",
		status: "ok",
		detail: `no worker on ${options.runtime.endpoint} — it is started on demand`
	});
	const portBusy = await options.runtime.preflight();
	checks.push({
		name: "worker:port",
		status: "ok",
		detail: portBusy.portBusy ? `port ${options.runtime.port} is taken; the plugin will pick the next free port in \`workerPorts\`` : `port ${options.runtime.port} is free`
	});
	const unfixable = checks.filter((check) => check.status === "unfixable");
	const fixed = checks.filter((check) => check.status === "fixed");
	return {
		action: "repair",
		dry_run: options.dryRun,
		ok: unfixable.length === 0,
		checks,
		install,
		weights,
		next: unfixable.length > 0 ? unfixable.map((check) => `${check.name}: ${check.remedy ?? check.detail}`).join("\n") : fixed.length > 0 ? `${fixed.length} problem(s) fixed: ${fixed.map((check) => check.name).join(", ")}.` : "Nothing needed fixing."
	};
}
//#endregion
//#region src/local.ts
/**
* Local inference backend client.
*
* This plugin does **not** implement inference. It speaks HTTP to a local worker
* that another component owns, so the two sides stay replaceable. The contract
* below is frozen on this side in v0.1 and is the handoff surface the worker
* must match:
*
* - `GET  {endpoint}/health`   → any 2xx means the worker is up.
* - `POST {endpoint}/generate` → body `{ prompt, width, height, count, steps?, seed?, transparent?, images?, reference_budget? }`
*   answering `{ images: [ <base64 | data:URI | {b64_json}> … ] }`, or the same
*   array under `data[]` / `output[].image`.
*
* `images` is the edit extension: an optional array of at most ten base64 (or
* `data:` URI) reference images, in prompt order. Omitting it is exactly the old
* text-to-image request, so the field is additive on both sides.
*
* `reference_budget` is the edit extension's own optional field: the side length
* the worker resizes references to, sent only when `localReferenceBudget` is set.
* Omitted — the default — the worker derives it from the canvas with its own
* `_reference_budget`, which is the behaviour every earlier release had, and it
* never changes the output size.
*
* Every failure names the endpoint and the transport reason, so a missing worker
* reads as a missing worker rather than as a broken plugin.
*/
/**
* Pull a numeric stage map out of a worker response, ignoring anything else.
*
* The worker reports one breakdown per generated image, so a batch response is an
* array; the first entry describes the job that a single-image call would have run
* and is what this returns.
*
* @param payload - the parsed `/generate` body.
* @returns stage name → seconds; empty when the worker reports none.
*/
function readStages(payload) {
	const body = typeof payload === "object" && payload !== null ? payload : {};
	const reported = body.stages_s ?? body.stage_timings;
	const source = Array.isArray(reported) ? reported[0] : reported;
	if (typeof source !== "object" || source === null || Array.isArray(source)) return {};
	const stages = {};
	for (const [key, value] of Object.entries(source)) if (typeof value === "number" && Number.isFinite(value)) stages[key] = value;
	return stages;
}
/**
* The worker could not be reached at all (as opposed to answering with an error).
*
* The lifecycle manager keys its "the worker died on us, rebuild it" decision on
* exactly this distinction, so it is a type rather than a string match.
*/
var LocalUnreachableError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "LocalUnreachableError";
	}
};
/**
* Generate images through the local worker.
*
* @param endpoint - worker origin without a trailing slash, e.g. `http://127.0.0.1:8399`.
* @param request - prompt plus the already-aligned canvas size.
* @param signal - aborts the in-flight request on tool cancellation.
* @returns the images plus the worker's stage timings, in worker order.
* @throws {LocalUnreachableError} When the worker cannot be reached at all.
* @throws When the worker answers without images.
*/
async function generateViaLocal(endpoint, request, signal) {
	const url = `${endpoint}/generate`;
	const body = {
		prompt: request.prompt,
		width: request.width,
		height: request.height,
		count: request.count
	};
	if (request.steps !== void 0) body.steps = request.steps;
	if (request.seed !== void 0) body.seed = request.seed;
	if (request.transparent) body.transparent = true;
	if (request.images !== void 0 && request.images.length > 0) {
		body.images = request.images.map((image) => Buffer.from(image.bytes).toString("base64"));
		if (request.referenceBudget !== void 0) body.reference_budget = request.referenceBudget;
	}
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json"
			},
			body: JSON.stringify(body),
			signal
		});
	} catch (error) {
		throw new LocalUnreachableError(`local backend: cannot reach ${url} (${error instanceof Error ? error.message : String(error)}). Start the local worker, or use backend "api" with an API key.`);
	}
	if (!response.ok) {
		let raw = "";
		try {
			raw = (await response.text()).replace(/\s+/g, " ").slice(0, 300);
		} catch {
			raw = "";
		}
		throw new Error(`local backend: ${url} answered HTTP ${response.status}${raw === "" ? "" : ` — ${raw}`}`);
	}
	let payload;
	const text = await response.text();
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`local backend: ${url} did not answer JSON: ${text.slice(0, 200)}`);
	}
	return {
		images: await extractImages(payload, "local backend", signal),
		stages: readStages(payload)
	};
}
//#endregion
//#region src/output.ts
/**
* Image persistence: `<outputDir>/<prefix>_<W>x<H>_<n>.png`.
*
* Numbering starts at 1 and skips names already on disk, so a second identical
* call adds files instead of silently overwriting the first result. Writes are
* staged through a temporary file and renamed, so an interrupted call never
* leaves a half-written PNG under the final name.
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
* @param dir - output directory; created when missing.
* @param prefix - sanitized filename prefix.
* @param width - aligned width used in the file name.
* @param height - aligned height used in the file name.
* @param images - decoded images in backend order.
* @returns one record per written file, with Markdown-ready absolute paths.
*/
async function writeImages(dir, prefix, width, height, images) {
	await mkdir(dir, { recursive: true });
	const first = await nextFreeIndex(dir, prefix, width, height);
	const written = [];
	let index = first;
	for (const image of images) {
		const path = join(dir, `${prefix}_${width}x${height}_${index}.png`);
		const staging = `${path}.partial-${process.pid}`;
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
}
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
* Those two numbers say nothing about the **local edit** path, which conditions on
* reference images and is measured separately: on the same card a 1248×1248 edit
* canvas (this table's `1:1`) does not survive at all, and **every one of the seven
* default canvases lands above the reliable edit budget**. The i2i numbers — and
* the gate the tool layer now derives from them — are
* {@link LOCAL_EDIT_BUDGET_RELIABLE}, {@link LOCAL_EDIT_BUDGET_EDGE} and
* `docs/evidence/r4b-local-edit-failures.md` §(a)/§(b).
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
/**
* The reference-conditioning budget a canvas implies for the **local** backend.
*
* A side length whose square is the pixel budget the worker resizes every
* reference image (and the condition latents) to; the worker uses it at
* `resources/worker.py:244 / :246 / :289`. This mirror exists so the tool layer can
* predict the load a local edit is about to ask for *before* spawning anything.
*
* Kept value-for-value equivalent to the worker's own
* `min(4096, max(32, int(round(math.sqrt(width * height) / 32) * 32)))`:
* `test/local-edit-budget.test.mjs` reads that Python source, evaluates the
* extracted expression, and fails if the two sides ever disagree.
*
* This is the **derived** budget, i.e. the default. A user who sets the
* `localReferenceBudget` config sends an explicit budget instead, and everything
* that bands "how heavy is this edit" must then use
* {@link resolveReferenceBudget} rather than this function.
*
* Python's `round` is half-to-even while `Math.round` is half-up, so the two can
* only diverge on an exact `.5` — unreachable for 32-aligned sides, because
* `w * h` is then a multiple of 1024 while `(32k + 16)² = 1024(k² + k) + 256` is
* not. The test asserts that no tie exists on the grid rather than assuming it.
*
* @param width - canvas width in pixels.
* @param height - canvas height in pixels.
* @returns the 32-aligned conditioning side length, in [32, 4096].
*/
function referenceBudget(width, height) {
	return Math.min(4096, Math.max(32, Math.round(Math.sqrt(width * height) / 32) * 32));
}
/** Largest conditioning budget `localReferenceBudget` may be set to (the worker's own clamp). */
const REFERENCE_BUDGET_MAX = 4096;
/**
* Resolve the conditioning budget a local edit will actually condition at.
*
* Explicit beats derived, and the whole size gate keys off the result: a user who
* sets `localReferenceBudget` to 512 is asking for *that* load, so a 1248×1248
* canvas must be judged as a 512 edit rather than by the 1248 its area implies —
* otherwise the knob could not make a 1.5 MP canvas runnable, which is what it is
* for.
*
* `0`/`undefined` means "no override": the worker derives the budget from the
* canvas itself (`resources/worker.py`'s `_reference_budget`), which is the
* behaviour every release before this knob had.
*
* @param width - canvas width in pixels.
* @param height - canvas height in pixels.
* @param override - the configured budget; `0` or undefined for "derive".
* @returns the effective budget, its source, and the canvas-derived one beside it.
* @throws When the override is not `0` and not a 32-aligned value in
*   [{@link REFERENCE_BUDGET_MIN}, {@link REFERENCE_BUDGET_MAX}], naming the
*   accepted shape — a typo here would otherwise be silently honoured.
*/
function resolveReferenceBudget(width, height, override) {
	const canvasBudget = referenceBudget(width, height);
	if (override === void 0 || override === 0) return {
		budget: canvasBudget,
		source: "canvas",
		canvasBudget
	};
	if (!Number.isInteger(override) || override < 32 || override > 4096 || override % 32 !== 0) throw new Error(`localReferenceBudget must be 0 (= derive from the canvas) or a multiple of 32 within [32, ${REFERENCE_BUDGET_MAX}], got ${override}`);
	return {
		budget: override,
		source: "config",
		canvasBudget
	};
}
/**
* Band a conditioning budget falls into, using the two measured lines.
*
* @param budget - {@link referenceBudget} of the requested canvas.
* @returns `reliable` at or below {@link LOCAL_EDIT_BUDGET_RELIABLE}, `edge` up to
*   {@link LOCAL_EDIT_BUDGET_EDGE}, `over` above it.
*/
function localEditBudgetTier(budget) {
	if (budget <= 896) return "reliable";
	if (budget <= 960) return "edge";
	return "over";
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
* to {@link resolveSize} at the default budget. Explicit `width`/`height` never
* reach this function; the tool layer validates and honours them first.
*
* @param whRatio - any `a:b`, tier or not.
* @returns the aligned size plus its deviation from the *requested* ratio.
*/
function resolveDefaultSize(whRatio) {
	const { a, b } = parseRatio(whRatio);
	const divisor = gcd(a, b);
	const pair = DEFAULT_SIZES[`${a / divisor}:${b / divisor}`];
	if (pair === void 0) return resolveSize(whRatio, DEFAULT_MEGAPIXELS);
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
//#region src/deploy-server.ts
/**
* Loopback HTTP bridge for the settings page's one-click local deploy.
*
* The web client's cordis context only injects `slots` and `configForms` — there
* is no client-side tool runner. A settings button that has to run
* `install` + `fetch-weights` therefore needs a side channel that lives in the
* **host** half, which is where those two operations already run. This module
* starts a `127.0.0.1`-only server next to the plugin activation:
*
* - `GET  /status`  — venv / weights readiness, whether a deploy is running
* - `POST /deploy`  — run venv install, then fetch the nf4 weights
* - `OPTIONS`       — CORS preflight for the Host's own web origin
*
* It is deliberately tiny, binds loopback only, and never exposes config
* writes: the only verbs are "how ready are we" and "please deploy".
*/
/** Default loopback port; `8411` sits next to the worker range `8399-8410`. */
const DEFAULT_DEPLOY_PORT = 8411;
function json(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type"
	});
	res.end(text);
}
async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
async function collectStatus(settings, state) {
	const paths = venvPaths(settings.runtimeDir);
	const python = settings.pythonPath.length > 0 ? settings.pythonPath : paths.python;
	const venvExists = await stat(python).then(() => true, () => false);
	const weights = await inspectWeights(settings.modelsDir);
	return {
		ok: true,
		deploying: state.deploying,
		phase: state.phase,
		venv: {
			exists: venvExists,
			python
		},
		weights: {
			ready: weights.ready,
			dir: settings.modelsDir,
			present: weights.present_files.length,
			missing: weights.missing_files.length,
			total_MiB: weights.total_MiB
		},
		last: state.last
	};
}
/** Process-wide singleton: tests register the tools many times per process. */
let shared = null;
/**
* Start the deploy bridge. Idempotent: a second call in the same process returns
* the server that is already listening, so a test that re-registers the tools
* does not hit `EADDRINUSE`.
*
* @param settings - resolved plugin settings (runtime / weights paths).
* @param port - loopback port to bind.
* @returns the server, already listening, plus a disposer.
*/
function startDeployServer(settings, port = DEFAULT_DEPLOY_PORT) {
	if (shared !== null) return shared;
	const state = {
		deploying: false,
		phase: null,
		last: null
	};
	const server = createServer((req, res) => {
		(async () => {
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
			if (req.method === "OPTIONS") {
				res.writeHead(204, {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type"
				});
				res.end();
				return;
			}
			if (req.method === "GET" && url.pathname === "/status") {
				json(res, 200, await collectStatus(settings, state));
				return;
			}
			if (req.method === "POST" && url.pathname === "/deploy") {
				if (state.deploying) {
					json(res, 409, {
						ok: false,
						error: "a deploy is already running",
						phase: state.phase
					});
					return;
				}
				const body = await readBody(req);
				const dryRun = body.dryRun === true;
				const withWeights = body.weights !== false;
				state.deploying = true;
				state.phase = "install";
				const startedAt = (/* @__PURE__ */ new Date()).toISOString();
				try {
					const scratchDir = settings.scratchDir;
					const install = await runInstall({
						runtimeDir: settings.runtimeDir,
						pipwrap: settings.pipwrapPath,
						basePythonCandidates: settings.basePythonCandidates,
						torchWheels: settings.torchWheels,
						pipIndexUrl: settings.pipIndexUrl,
						reuseBaseTorch: settings.reuseBaseTorch,
						dryRun,
						commandTimeoutMs: 36e5,
						scratchDir
					});
					let fetchReport = null;
					if (withWeights) {
						state.phase = "fetch-weights";
						fetchReport = await runFetchWeights({
							repo: settings.modelRepo,
							mirror: settings.hfMirror,
							revision: "main",
							dir: settings.modelsDir,
							skipLmHead: settings.skipLmHead,
							dryRun,
							force: false,
							scratchDir,
							stallTimeoutMs: 12e4
						});
					}
					const ok = install.ok && fetchReport?.ok !== false;
					state.last = {
						ok,
						message: ok ? dryRun ? "dry-run 完成，未改动机器" : withWeights ? "本地环境部署完成：venv + 权重" : "venv 安装完成" : install.next || "部署未完成，见步骤明细",
						at: startedAt
					};
					state.deploying = false;
					state.phase = null;
					json(res, 200, {
						ok,
						dry_run: dryRun,
						install,
						weights: fetchReport,
						status: await collectStatus(settings, state)
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					state.last = {
						ok: false,
						message,
						at: startedAt
					};
					state.deploying = false;
					state.phase = null;
					json(res, 500, {
						ok: false,
						error: message
					});
				}
				return;
			}
			json(res, 404, {
				ok: false,
				error: "not found"
			});
		})().catch(() => {
			if (!res.headersSent) json(res, 500, {
				ok: false,
				error: "internal error"
			});
		});
	});
	server.on("error", () => {});
	server.listen(port, "127.0.0.1");
	server.unref();
	shared = {
		server,
		port,
		dispose: () => {
			try {
				server.close();
			} catch {}
			shared = null;
		}
	};
	return shared;
}
//#endregion
//#region src/worker.ts
/**
* Worker lifecycle: the plugin starts, watches, restarts and reaps its own
* inference worker.
*
* The plugin previously assumed somebody else kept a worker alive. That is not
* a safe assumption on this host: a worker started as a child job of a session
* is taken away with that session, and the next call sees a refused connection.
* So the plugin owns the process — it picks a port, spawns the shipped
* `resources/worker.py` with the venv's interpreter, waits for readiness,
* adopts a worker that is already up, and rebuilds one that died.
*
* Deliberate transport choice: the child's stdout/stderr are handed to a log
* file descriptor, never a pipe. This host's sandbox denies pipe-backed spawns
* (`EPERM`) and a pipe would in any case lose the log the moment the parent
* dies. The log file is the error channel: when the worker fails to come up,
* its last lines are read back and put into the error the user sees.
*/
/** Window NTSTATUS values that reach Node as a process exit code. */
const WINDOWS_EXIT_STATUS = {
	3221225477: {
		hex: "0xC0000005",
		cause: "ACCESS_VIOLATION（访问违例）"
	},
	3221225725: {
		hex: "0xC00000FD",
		cause: "STACK_OVERFLOW（栈溢出）"
	},
	3221226505: {
		hex: "0xC0000409",
		cause: "STACK_BUFFER_OVERRUN（fail-fast）"
	},
	3221225620: {
		hex: "0xC0000094",
		cause: "INTEGER_DIVIDE_BY_ZERO（整数除零）"
	},
	3221226356: {
		hex: "0xC0000374",
		cause: "HEAP_CORRUPTION（堆损坏）"
	}
};
/**
* Turn a worker's exit status plus its log tail into a cause and a next step.
*
* This exists because `0xC0000005` is what the user actually sees when the card
* is full: CUDA and the driver abort the process instead of raising a Python
* `OutOfMemoryError`, so the exit code is the only evidence and it explains
* nothing on its own. The caller appends the live VRAM numbers, which this
* function deliberately cannot read.
*
* @param code - exit code Node reported, or null when the process was signalled.
* @param signal - signal that ended it, when there was one.
* @param tail - last lines of the worker log.
* @returns the headline plus ordered hints.
*/
function explainWorkerExit(code, signal, tail) {
	let resolvedCode = code;
	let status = resolvedCode === null ? void 0 : WINDOWS_EXIT_STATUS[resolvedCode];
	if (status === void 0) {
		const hexInTail = /0xC0[0-9A-Fa-f]{6}/i.exec(tail)?.[0]?.toLowerCase();
		if (hexInTail !== void 0) {
			const entry = Object.entries(WINDOWS_EXIT_STATUS).find(([, value]) => value.hex.toLowerCase() === hexInTail);
			if (entry !== void 0) {
				resolvedCode = Number(entry[0]);
				status = WINDOWS_EXIT_STATUS[resolvedCode];
			}
		}
	}
	const headline = status === void 0 ? `exit code ${code ?? "null"}${signal === null ? "" : ` signal ${signal}`}` : code !== null && code !== resolvedCode ? `exit code ${resolvedCode} = ${status.hex} ${status.cause}（本机进程状态只保留了低 8 位，原码 ${code}）` : `exit code ${resolvedCode} = ${status.hex} ${status.cause}`;
	const cudaInLog = /CUDA out of memory|OutOfMemoryError|CUDA error|no CUDA-capable device|out of memory/i.test(tail);
	const crashLike = status !== void 0 && (status.hex === "0xC0000005" || status.hex === "0xC0000374");
	const hints = [];
	if (crashLike || cudaInLog) {
		hints.push("最可能的原因：加载阶段的显存不够。模型加载要一次性分配约 4.5 GiB 给 transformer；显存被别人占着时，CUDA/驱动常常直接让进程以访问违例结束，而不是抛一条可读的 Python OOM —— 所以这个退出码要当成「显存不足」来读。");
		hints.push("按下面这段实时显存数据判断是谁占着；ComfyUI 的模型卸载命令就在里面。");
	} else if (/CUDA/i.test(tail)) hints.push("日志里提到了 CUDA —— 上面 Last output 里那一行就是根因；显存不足也常以 CUDA 报错的形式出现。");
	else if (/Traceback \(most recent call last\)/.test(tail)) hints.push("worker 自己报的 Python 异常就在上面的 Last output 里 —— 那一行才是根因。");
	else if (code === 0) hints.push("worker 以 0 退出：它是被要求结束的（`POST /shutdown`），不是崩溃。");
	else hints.push("日志里没有 CUDA 或 Python 异常的痕迹；先按上面的退出码查，再看 Log 里最后几行。");
	return {
		headline,
		hints
	};
}
/** Signature the shipped worker reports on `/state`, used to recognise our own. */
const SERVICE = "dsh-image-forge-worker";
/**
* How long a failed start is remembered before another spawn is allowed.
*
* Short enough that a user who fixes the problem (frees VRAM, finishes an
* install) is not blocked, long enough that a caller looping on the tool does
* not spawn a process per call.
*/
const RESTART_COOLDOWN_MS = 5e3;
/** Read the tail of a log file without loading the whole thing. */
function readLogTail(path, maxBytes = 65536, maxLines = 25) {
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - maxBytes);
		return readFileSync(path).subarray(start).toString("utf8").split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-maxLines).join("\n");
	} catch {
		return "";
	}
}
/** Sleep, honouring caller cancellation. */
function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/** Does something accept TCP connections on this loopback port? */
function isPortBusy(port, timeoutMs = 400) {
	return new Promise((resolve) => {
		const socket = createConnection({
			host: "127.0.0.1",
			port
		});
		let settled = false;
		const done = (busy) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(busy);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}
/** Narrow an unknown JSON value into a record. */
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
/** GET a JSON endpoint with a budget, reporting rather than throwing. */
async function getJson(url, timeoutMs, signal) {
	const controller = new AbortController();
	const signals = signal === void 0 ? [controller.signal] : [controller.signal, signal];
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), timeoutMs);
	try {
		const response = await fetch(url, {
			method: "GET",
			signal: AbortSignal.any(signals)
		});
		let body = null;
		try {
			body = asRecord(await response.json());
		} catch {
			body = null;
		}
		return {
			ok: response.ok,
			status: response.status,
			body
		};
	} catch (error) {
		return {
			ok: false,
			status: 0,
			body: null,
			note: error instanceof Error ? error.message : String(error)
		};
	} finally {
		clearTimeout(timer);
	}
}
/** Parse `http://host:port` into a port number, or undefined. */
function portOf(endpoint) {
	try {
		const url = new URL(endpoint);
		const port = Number(url.port);
		return Number.isInteger(port) && port > 0 ? port : void 0;
	} catch {
		return;
	}
}
/** Read the GPU the way the real host requires: `nvidia-smi`, never a shell. */
async function defaultVramProbe(gate) {
	const timeoutMs = gate.probeTimeoutMs ?? 5e3;
	const candidates = gate.comfyPorts !== void 0 && gate.comfyPorts.length > 0 ? [...gate.comfyPorts] : [gate.comfyPort];
	const [gpu, processes, listeners] = await Promise.all([
		probeGpu(timeoutMs, gate.scratchDir),
		probeGpuProcesses(timeoutMs, gate.scratchDir),
		Promise.all(candidates.map((port) => resolveListenerPid(port, timeoutMs, gate.scratchDir)))
	]);
	const live = listeners.findIndex((pid) => pid !== void 0);
	const gpus = gpu.data?.gpus ?? [];
	return {
		freeMiB: typeof gpus[0]?.vramFreeMiB === "number" ? gpus[0].vramFreeMiB : null,
		totalMiB: typeof gpus[0]?.vramTotalMiB === "number" ? gpus[0].vramTotalMiB : null,
		processes: processes.data?.processes ?? [],
		comfyReachable: live >= 0,
		comfyPid: live >= 0 ? listeners[live] : null,
		comfyPort: live >= 0 ? candidates[live] : null
	};
}
/** Fold observed GPU facts into the shared verdict (`env.ts` owns the wording). */
function adviseFrom(facts, gate) {
	return analyseVram({
		ok: facts.freeMiB !== null,
		data: { gpus: [{
			vramFreeMiB: facts.freeMiB,
			vramTotalMiB: facts.totalMiB
		}] }
	}, {
		ok: true,
		data: { processes: [...facts.processes] }
	}, {
		reachable: facts.comfyReachable,
		port: facts.comfyPort ?? gate.comfyPort
	}, gate.requiredMiB, facts.comfyPid);
}
/**
* The gate's refusal, written so it can be acted on without reading any code:
* who holds the memory, exactly how much is missing, and the command that fixes it.
*
* The two shapes get different wording on purpose, because they need different
* actions: a **named holder** (ComfyUI, or this plugin's own worker) is freed with
* one request, while **no visible holder** is the `cudaMallocAsync` allocator-cache
* form (§34) — where "nobody is holding it" reads as a dead end and the user never
* learns that `POST /free` is still the fix and that a second attempt a few seconds
* later clears the Windows `OSError 1455` spawn failure.
*
* @param report - what the gate just observed.
* @returns the multi-line error text.
*/
function vramGateMessage(report) {
	const port = report.comfyPort ?? 8188;
	const lines = ["local backend: 显存余量不足，拒绝拉起 worker（启动前门禁）。硬起会以 0xC0000005 崩在加载阶段，这道检查就是为了不让你看到那个退出码。", `  空闲 ${report.freeMiB ?? "?"} MiB / ${report.totalMiB ?? "?"} MiB，需要至少 ${report.requiredMiB} MiB；还差 ${report.shortfallMiB ?? "?"} MiB。`];
	const comfyHolds = report.holders.some((holder) => holder.comfyui);
	if (report.holders.length > 0) {
		lines.push("  占着显存的进程（nvidia-smi 报出来的）：");
		for (const holder of report.holders) lines.push(`    • pid ${holder.pid} ${holder.name || "unknown"}${holder.usedMiB === null ? "" : `，约 ${holder.usedMiB} MiB`}${holder.comfyui ? `（ComfyUI，监听 127.0.0.1:${port}）` : ""}`);
		lines.push(comfyHolds ? `  占用者里有 ComfyUI：先执行下面那条 /free 命令让它把模型交出来，这是本次最直接的补救。` : "  这些占用者不是 ComfyUI：先看它们是谁（本插件自己的 worker 常驻约 4.5 GiB，用 `qwen_image_env` 的 action:\"unload\" 回收）。");
	} else {
		lines.push("  nvidia-smi 没有报出任何占用者（`--query-compute-apps` 一个计算进程都没有）——**这不等于没人占着**：ComfyUI 跑完会把约 3.6 GiB 的 `cudaMallocAsync` 分配器缓存留在自己的进程里，而这一列看不到它，于是出现「看起来没有占用者，但显存就是不够」，本地 worker 加载即死。");
		lines.push("  这种情况下的补救顺序：");
		lines.push(`    ① 仍然先发 POST /free（ComfyUI 还在的话它就是把缓存交出来的那条路）：${comfyFreeCommand(port)}`);
		lines.push("    ② 然后**隔十几秒再重试**：背靠背启动 python 会撞 Windows `OSError 1455 页面文件太小`（host commit 压力），那是进程创建失败，与你的配置和权重都无关。");
		lines.push("    ③ 8 GB 卡上把 `freeComfyBeforeLocalStart` 设为 true 一般是**必需项**而不是可选优化——它就是替你走第①步。");
	}
	if (report.freedComfy !== null) lines.push(report.freedComfy.ok ? `  已按 freeComfyBeforeLocalStart 请求 ComfyUI 释放：POST ${report.freedComfy.url} → HTTP ${report.freedComfy.httpStatus}；释放后仍不足，所以这次没有启动。` : `  已按 freeComfyBeforeLocalStart 尝试请求 ComfyUI 释放，但没成功：${report.freedComfy.note ?? `HTTP ${report.freedComfy.httpStatus}`}。`);
	if (report.holders.length > 0) {
		lines.push("  补救（ComfyUI 官方卸载端点，执行后立刻生效）：");
		lines.push(`    ${comfyFreeCommand(port)}`);
	}
	lines.push("  执行完重试本次调用。若占用者其实是本插件自己的 worker（常驻约 4.5 GiB），改用 `qwen_image_env` 的 action:\"unload\" 回收。");
	lines.push("  想让插件每次启动 worker 前自己执行上面那条命令：配置 `freeComfyBeforeLocalStart: true`（默认 false，插件默认不动别人的模型）。关掉这道门禁：`minFreeVramMiB: 0`。");
	lines.push("  为什么拦：worker 加载先要一次性拿约 4.5 GiB 给 transformer；拿不到时 CUDA 会让进程以访问违例退出，而不是给一条 OOM。");
	return lines.join("\n");
}
/** The lifecycle owner for one plugin instance. */
var WorkerRuntime = class {
	settings;
	child = null;
	childPid = null;
	exit = null;
	activePort;
	activeEndpoint;
	activeOurs = false;
	activeManaged = false;
	logPath = null;
	idleTimer = null;
	lastActivity = Date.now();
	unloaded = false;
	starting = null;
	/** Last failed start, so a retry storm (two calls in a row) does not spawn twice. */
	lastStartFailure = null;
	/** Newest first; `status` reports it and tests assert on it. */
	events = [];
	/** What the last pre-start gate saw, so the tool result can report it truthfully. */
	lastVramGate = null;
	constructor(settings) {
		this.settings = settings;
		this.activePort = portOf(settings.endpoint) ?? settings.ports[0] ?? 8399;
		this.activeEndpoint = `http://127.0.0.1:${this.activePort}`;
	}
	/** Endpoint callers must use right now. */
	get endpoint() {
		return this.activeEndpoint;
	}
	/** Port the runtime believes the worker is on. */
	get port() {
		return this.activePort;
	}
	/** Pid of the process this instance spawned, when it still runs. */
	get pid() {
		return this.child !== null && this.exit === null ? this.childPid : null;
	}
	/** True when this instance owns (and may kill) the worker process. */
	get ownsProcess() {
		return this.activeManaged;
	}
	/** Last failed start attempt, for `status` to explain "why is it not up". */
	get lastStartFailureAt() {
		return this.lastStartFailure;
	}
	/** The last pre-start VRAM gate outcome, or null when the gate never ran. */
	get vramGate() {
		return this.lastVramGate;
	}
	/** True when this runtime watched a worker exit (external kill or crash). */
	get sawWorkerExit() {
		return this.events.some((event) => event.event === "exit" || event.event === "died" || event.event === "invalidate");
	}
	record(event, detail) {
		this.events.unshift({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			event,
			detail
		});
		if (this.events.length > 30) this.events.pop();
	}
	/**
	* Probe an endpoint without changing anything.
	*
	* `/state` is tried first because it answers while the model is still loading;
	* `/health` is the frozen contract and is used both as a fallback for workers
	* that predate `/state` and to learn whether the model is actually ready.
	*/
	async inspect(endpoint = this.activeEndpoint, timeoutMs = 1500, signal) {
		const state = await getJson(`${endpoint}/state`, timeoutMs, signal);
		const stateBody = state.body ?? {};
		if (state.ok && (typeof stateBody.pid === "number" || stateBody.service !== void 0)) {
			const health = await getJson(`${endpoint}/health`, timeoutMs, signal);
			return {
				endpoint,
				reachable: true,
				ready: health.ok || stateBody.ready === true,
				ours: stateBody.service === SERVICE,
				state: stateBody,
				healthStatus: health.status
			};
		}
		const health = await getJson(`${endpoint}/health`, timeoutMs, signal);
		if (health.ok) return {
			endpoint,
			reachable: true,
			ready: true,
			ours: false,
			healthStatus: health.status,
			note: "endpoint answers the frozen /health contract but reports no service signature; adopting it as a foreign worker"
		};
		return {
			endpoint,
			reachable: false,
			ready: false,
			ours: false,
			healthStatus: health.status,
			note: health.status > 0 ? `${endpoint} answers HTTP ${health.status} on /health, which is not a worker (the contract wants 2xx); treating the port as taken` : state.note ?? health.note ?? "connection refused"
		};
	}
	/** Last lines of the worker log, for error messages and `status`. */
	logTail(maxLines = 25) {
		return this.logPath === null ? "" : readLogTail(this.logPath, 65536, maxLines);
	}
	/** Where the worker's stdout/stderr go. */
	get logFile() {
		return this.logPath;
	}
	/** Note that the worker just did real work, so idle unload restarts its clock. */
	noteActivity() {
		this.lastActivity = Date.now();
		this.unloaded = false;
	}
	/**
	* Arm the idle-unload timer.
	*
	* The timer is unref'd: a plugin that is otherwise done must not be kept alive
	* by a housekeeping timer.
	*/
	armIdleUnload() {
		if (this.settings.idleUnloadMs <= 0) return;
		if (this.idleTimer !== null) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			this.unloadIfIdle();
		}, this.settings.idleUnloadMs);
		this.idleTimer.unref?.();
	}
	/** Unload only if nothing has happened for the whole idle window. */
	async unloadIfIdle() {
		if (Date.now() - this.lastActivity < this.settings.idleUnloadMs) {
			this.armIdleUnload();
			return false;
		}
		return (await this.unload()).ok === true;
	}
	/**
	* Refuse to start the worker when the card has no room for it.
	*
	* A worker that cannot allocate its transformer does not raise a clean OOM on
	* this host: it exits as `0xC0000005`, which tells the user nothing. Reading the
	* GPU *before* the spawn is what turns that into "ComfyUI holds 7.4 GiB, run
	* this command".
	*
	* @param signal - caller cancellation.
	* @returns what the gate saw; throws with the remedy when it refuses.
	*/
	async gateVram(signal) {
		const gate = this.settings.vramGate;
		if (gate === void 0 || gate.requiredMiB <= 0) {
			this.lastVramGate = {
				allowed: true,
				ran: false,
				freeMiB: null,
				totalMiB: null,
				requiredMiB: gate?.requiredMiB ?? 0,
				shortfallMiB: null,
				holders: [],
				comfyPort: null,
				freedComfy: null,
				warning: null
			};
			return this.lastVramGate;
		}
		const probe = this.settings.probeVram ?? defaultVramProbe;
		let facts = await probe(gate);
		let advisory = adviseFrom(facts, gate);
		let freedComfy = null;
		if (!advisory.start_gate.allowed && gate.freeComfyFirst) {
			freedComfy = await freeComfyMemory(facts.comfyPort ?? gate.comfyPort);
			this.record("comfy-free", `${freedComfy.url} HTTP ${freedComfy.httpStatus}`);
			await delay(2e3, signal).catch(() => void 0);
			facts = await probe(gate);
			advisory = adviseFrom(facts, gate);
		}
		const report = {
			allowed: advisory.start_gate.allowed,
			ran: true,
			freeMiB: advisory.freeMiB,
			totalMiB: advisory.totalMiB,
			requiredMiB: advisory.requiredMiB,
			shortfallMiB: advisory.start_gate.shortfallMiB,
			holders: advisory.holders,
			comfyPort: facts.comfyPort ?? gate.comfyPort,
			freedComfy,
			warning: vramSuspicionWarning(advisory, facts.comfyPort ?? gate.comfyPort)
		};
		this.lastVramGate = report;
		this.record("vram-gate", `free=${report.freeMiB ?? "?"} need=${report.requiredMiB} allowed=${report.allowed}`);
		if (!report.allowed) throw new Error(vramGateMessage(report));
		return report;
	}
	/**
	* The live VRAM facts as error-message lines, never throwing.
	*
	* The crash path needs numbers *now*, and a probe that cannot run has to degrade
	* to a one-line note instead of replacing the real error with its own.
	*
	* @returns lines to append to the error, or an empty array when the gate is off
	*   and there is nothing useful to say.
	*/
	async describeVram() {
		const gate = this.settings.vramGate;
		const probe = this.settings.probeVram ?? defaultVramProbe;
		const settings = gate ?? {
			requiredMiB: 0,
			comfyPort: 8188,
			freeComfyFirst: false,
			scratchDir: join(this.settings.dataDir, "logs")
		};
		try {
			const facts = await probe(settings);
			const lines = [`当前显存：空闲 ${facts.freeMiB ?? "?"} MiB / ${facts.totalMiB ?? "?"} MiB` + (gate !== void 0 && gate.requiredMiB > 0 ? `（启动前门禁的阈值是 ${gate.requiredMiB} MiB）` : "")];
			lines.push(facts.processes.length > 0 ? `占用者：${facts.processes.map((holder) => `pid ${holder.pid} ${holder.name || "unknown"}${holder.usedMiB === null ? "" : ` ${holder.usedMiB} MiB`}`).join("、")}` : "占用者：nvidia-smi 没有报出计算进程（这不等于没人占着：ComfyUI 留下的约 3.6 GiB `cudaMallocAsync` 分配器缓存就不在这一列里）。");
			lines.push(`补救（若占用者是 ComfyUI）：${comfyFreeCommand(facts.comfyPort ?? settings.comfyPort)}`);
			if (this.lastVramGate?.ran === true) lines.push(`启动前门禁当时看到空闲 ${this.lastVramGate.freeMiB ?? "?"} MiB 并放行；加载期间显存又被别人拿走，或峰值超出了当时的余量。`);
			return lines;
		} catch (error) {
			return [`显存探测失败（${error instanceof Error ? error.message : String(error)}），无法点名占用者；先手工跑一次 \`nvidia-smi\` 看是谁占着。`];
		}
	}
	/**
	* Make sure a worker is up and ready, starting one if needed.
	*
	* @param signal - caller cancellation; also bounds the readiness wait.
	* @returns the handle the generate path must use.
	*/
	async ensure(signal) {
		if (this.starting !== null) return this.starting;
		this.lastVramGate = null;
		this.starting = this.ensureInner(signal);
		try {
			return await this.starting;
		} finally {
			this.starting = null;
		}
	}
	async ensureInner(signal) {
		if (this.child !== null && this.exit === null) {
			const probe = await this.inspect(this.activeEndpoint, 1500, signal);
			if (probe.reachable) return this.handle(probe, {
				started: false,
				adopted: false
			});
		}
		const existing = await this.inspect(this.activeEndpoint, 1500, signal);
		if (existing.reachable) {
			this.activeManaged = this.child !== null && this.exit === null;
			this.activeOurs = existing.ours;
			this.record("adopted", `${existing.endpoint} ready=${existing.ready}`);
			return this.handle(existing, {
				started: false,
				adopted: true
			});
		}
		if (!this.settings.manage) throw new Error(`local backend: no worker at ${this.activeEndpoint} and worker management is off (config \`manageWorker: false\`). Start the worker yourself, or set \`manageWorker: true\` to let the plugin own it.`);
		if (this.lastStartFailure !== null && Date.now() - this.lastStartFailure.at < RESTART_COOLDOWN_MS) {
			const waitMs = RESTART_COOLDOWN_MS - (Date.now() - this.lastStartFailure.at);
			throw new Error(`local backend: the worker is not running, and its last start attempt failed ${Math.round((Date.now() - this.lastStartFailure.at) / 1e3)}s ago:\n  ${this.lastStartFailure.message}\n  Not retrying for another ${(waitMs / 1e3).toFixed(1)}s; the details above are from the attempt that just happened.`);
		}
		if (executableMissing(this.settings.interpreter)) throw new Error(`local backend: no worker at ${this.activeEndpoint}, and the plugin cannot start one — the interpreter does not exist:\n  ${this.settings.interpreter}\n  Run \`qwen_image_env\` with \`action:"install"\` (add \`dryRun:true\` to see the plan first) to create the venv and install torch.`);
		if (executableMissing(this.settings.script)) throw new Error(`local backend: the shipped worker script is missing: ${this.settings.script}`);
		await this.gateVram(signal);
		const port = await this.pickPort(signal);
		return this.startOnPort(port, signal);
	}
	/**
	* Start the worker, walking the candidate ports when one cannot be bound.
	*
	* A port that answers a probe can still refuse the bind a moment later (the
	* OS may hand it to somebody else, or exclude it), and the child then dies
	* immediately with `EADDRINUSE`/`EACCES`. That is a port problem, not a worker
	* problem: move to the next candidate instead of failing the tool call.
	*/
	async startOnPort(preferred, signal) {
		const candidates = [preferred, ...this.settings.ports].filter((port, index, all) => all.indexOf(port) === index);
		const failures = [];
		for (const port of candidates) {
			if (port !== preferred && await isPortBusy(port)) continue;
			this.activePort = port;
			this.activeEndpoint = `http://127.0.0.1:${port}`;
			try {
				return await this.spawnWorker(port, signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!/EADDRINUSE|EACCES|address already in use|only one usage of each socket address/i.test(message)) throw error;
				failures.push(`${port}: could not be bound`);
				this.record("bind-failed", `port ${port}`);
				await this.invalidate(`port ${port} could not be bound`);
			}
		}
		throw new Error(`local backend: no candidate port could be bound (${failures.join("; ") || candidates.join(", ")}). Free one of them, or widen \`workerPorts\` in the plugin config.`);
	}
	/** Choose a port: the preferred one when free, else the first free candidate. */
	async pickPort(signal) {
		const candidates = [this.activePort, ...this.settings.ports].filter((port, index, all) => all.indexOf(port) === index);
		for (const port of candidates) {
			if (!await isPortBusy(port)) return port;
			if ((await this.inspect(`http://127.0.0.1:${port}`, 800, signal)).reachable) return port;
		}
		throw new Error(`local backend: every candidate worker port is taken (${candidates.join(", ")}). Free one of them, or widen \`workerPorts\` in the plugin config.`);
	}
	/** Spawn the worker and wait for it to report ready. */
	async spawnWorker(port, signal) {
		const startedAt = Date.now();
		const logsDir = join(this.settings.dataDir, "logs");
		let log;
		try {
			log = await openLogFile(logsDir, `worker-${port}.log`);
		} catch (error) {
			throw new Error(`local backend: cannot write the worker log (${error instanceof Error ? error.message : String(error)}). Point \`runtimeDir\` at a writable directory.`);
		}
		this.logPath = log.path;
		const args = [
			this.settings.script,
			"--port",
			String(port),
			"--models-dir",
			this.settings.modelsDir,
			"--data-dir",
			this.settings.dataDir
		];
		let child;
		const fd = log.fd;
		try {
			child = spawn(this.settings.interpreter, args, {
				stdio: [
					"ignore",
					fd,
					fd
				],
				windowsHide: true,
				env: {
					...process.env,
					PYTHONUNBUFFERED: "1",
					PYTHONIOENCODING: "utf-8",
					HF_HUB_OFFLINE: "1",
					TRANSFORMERS_OFFLINE: "1"
				}
			});
		} catch (error) {
			closeSync(fd);
			throw new Error(`local backend: could not start the worker process (${error instanceof Error ? error.message : String(error)}). Interpreter: ${this.settings.interpreter}`);
		}
		closeSync(fd);
		if (log.note !== void 0) this.record("log-fallback", log.note);
		this.child = child;
		this.childPid = child.pid ?? null;
		this.exit = null;
		this.activeManaged = true;
		this.activeOurs = true;
		this.record("spawn", `pid=${child.pid ?? "?"} port=${port} log=${this.logPath}`);
		let exited = null;
		let spawnFailure = null;
		child.once("error", (error) => {
			spawnFailure = /* @__PURE__ */ new Error(`local backend: the worker process could not be started (${error.code ?? ""} ${error.message}).\n  Interpreter: ${this.settings.interpreter}\n  Script: ${this.settings.script}`);
		});
		child.once("exit", (code, signalName) => {
			exited = {
				code,
				signal: signalName
			};
			if (this.child !== child) return;
			this.exit = {
				code,
				signal: signalName
			};
			this.record("exit", `code=${code ?? "null"} signal=${signalName ?? "null"}`);
		});
		const deadline = Date.now() + this.settings.startTimeoutMs;
		let lastProbe = null;
		while (Date.now() < deadline) {
			if (spawnFailure !== null) throw spawnFailure;
			if (exited !== null) break;
			const probe = await this.inspect(this.activeEndpoint, 1e4, signal);
			lastProbe = probe;
			if (probe.reachable && probe.ready) {
				this.noteActivity();
				this.lastStartFailure = null;
				const handle = this.handle(probe, {
					started: true,
					adopted: false
				});
				this.record("ready", `pid=${handle.pid ?? "?"} in ${Date.now() - startedAt} ms`);
				this.armIdleUnload();
				return {
					...handle,
					startMs: Date.now() - startedAt
				};
			}
			await delay(400, signal);
		}
		const tail = this.logTail();
		if (exited !== null) {
			const explanation = explainWorkerExit(exited.code, exited.signal, tail);
			const detail = `exit code ${exited.code ?? "null"}${exited.signal === null ? "" : ` signal ${exited.signal}`}`;
			this.record("died", detail);
			const bindFailure = /EADDRINUSE|EACCES|address already in use|only one usage of each socket address/i.test(tail);
			const vram = await this.describeVram();
			this.rememberStartFailure(`${this.activeEndpoint}: ${explanation.headline}`);
			throw new Error(`local backend: the worker process died while starting (${explanation.headline}${bindFailure ? ", port not bindable" : ""}).\n` + explanation.hints.map((hint) => `  ${hint}`).join("\n") + (vram.length === 0 ? "" : `\n${vram.map((line) => `  ${line}`).join("\n")}`) + `\n  Log: ${this.logPath}\n` + (tail.length > 0 ? `  Last output:\n${tail.split("\n").map((line) => `    ${line}`).join("\n")}` : "  (no output)"));
		}
		if (lastProbe !== null && lastProbe.reachable && lastProbe.state?.load_error) {
			const error = lastProbe.state.load_error;
			this.record("load-failed", error);
			this.rememberStartFailure(`model load failed: ${error}`);
			throw new Error(`local backend: the worker is up but the model failed to load: ${error}\n  Log: ${this.logPath}\n` + (tail.length > 0 ? `  Last output:\n${tail.split("\n").map((line) => `    ${line}`).join("\n")}` : "  (no output)"));
		}
		this.record("timeout", `${this.settings.startTimeoutMs} ms`);
		this.rememberStartFailure(`not ready within ${this.settings.startTimeoutMs} ms`);
		throw new Error(`local backend: the worker did not become ready within ${Math.round(this.settings.startTimeoutMs / 1e3)}s.\n  Endpoint: ${this.activeEndpoint}\n  Log: ${this.logPath}\n` + (tail.length > 0 ? `  Last output:\n${tail.split("\n").map((line) => `    ${line}`).join("\n")}` : "  (no output)"));
	}
	/** Remember that a start attempt failed, so `ensure()` can back off. */
	rememberStartFailure(message) {
		this.lastStartFailure = {
			at: Date.now(),
			message
		};
	}
	/** Shape one probe into a handle. */
	handle(probe, extra) {
		return {
			endpoint: probe.endpoint,
			port: portOf(probe.endpoint) ?? this.activePort,
			pid: typeof probe.state?.pid === "number" ? probe.state.pid : this.pid,
			started: extra.started,
			adopted: extra.adopted,
			managed: this.activeManaged,
			ours: probe.ours,
			startMs: 0,
			state: probe.state ?? null
		};
	}
	/**
	* Forget a worker that stopped answering, killing it when we own it.
	*
	* This is the "it died on us" path: the next `ensure()` starts a fresh one.
	*/
	async invalidate(reason) {
		this.record("invalidate", reason);
		if (this.child !== null && this.exit === null) await this.kill();
		this.child = null;
		this.childPid = null;
		this.exit = null;
		this.activeManaged = false;
		this.activeOurs = false;
	}
	/**
	* Ask the worker to exit by itself (`POST /shutdown`).
	*
	* This is the primary stop path, not a nicety: on Windows the venv's
	* `python.exe` is a *redirector*, so the pid the plugin spawned is not the
	* interpreter that holds the model. Killing the redirector would orphan the
	* real process with its ~4.5 GiB of VRAM. Asking the worker to leave removes
	* the guesswork.
	*
	* @returns true when the worker answered the request.
	*/
	async requestShutdown(timeoutMs = 1e4) {
		const probe = await this.inspect(this.activeEndpoint, 1500);
		if (!probe.reachable || !probe.ours) return false;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), timeoutMs);
		try {
			const response = await fetch(`${this.activeEndpoint}/shutdown`, {
				method: "POST",
				signal: controller.signal
			});
			this.record("shutdown", `HTTP ${response.status}`);
			return response.ok;
		} catch (error) {
			this.record("shutdown-failed", error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			clearTimeout(timer);
		}
	}
	/** Stop the process this runtime started. */
	async stop(timeoutMs = 5e3) {
		if (this.child === null || this.exit !== null) {
			this.child = null;
			return {
				stopped: false,
				reason: "no running worker owned by this plugin instance"
			};
		}
		const pid = this.childPid;
		const graceful = await this.requestShutdown();
		const observedExit = await this.kill(graceful ? timeoutMs : timeoutMs);
		this.child = null;
		this.childPid = null;
		this.activeManaged = false;
		this.record("stopped", `pid=${pid ?? "?"} graceful=${graceful} exit_observed=${observedExit}`);
		return {
			stopped: observedExit,
			pid,
			graceful,
			reason: observedExit ? null : "the process did not exit within the grace period"
		};
	}
	/**
	* Send SIGTERM, then SIGKILL if the process is still there.
	*
	* @returns true only when the child's `exit` event was actually observed, so a
	*   caller never reports a kill that did not happen.
	*/
	async kill(timeoutMs = 5e3) {
		const child = this.child;
		if (child === null) return true;
		if (this.exit !== null) return true;
		const exited = new Promise((resolve) => child.once("exit", () => resolve()));
		try {
			child.kill();
		} catch {
			return false;
		}
		if (!await Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false).catch(() => true)])) {
			try {
				child.kill("SIGKILL");
			} catch {}
			return await Promise.race([exited.then(() => true), delay(2e3).then(() => false)]).catch(() => false);
		}
		return true;
	}
	/**
	* Ask the worker to release VRAM (`POST /unload`).
	*
	* A worker that is already gone is not an error — the caller asked for the
	* memory back, and it is back.
	*/
	async unload(timeoutMs = 6e4) {
		if (this.idleTimer !== null) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		const endpoint = this.activeEndpoint;
		const pid = this.child !== null && this.exit === null ? this.childPid : null;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), timeoutMs);
		try {
			const response = await fetch(`${endpoint}/unload`, {
				method: "POST",
				signal: controller.signal
			});
			const text = await response.text();
			let body = text;
			try {
				body = JSON.parse(text);
			} catch {}
			this.unloaded = true;
			this.record("unload", `HTTP ${response.status}`);
			return {
				ok: response.ok,
				endpoint,
				http_status: response.status,
				pid,
				body
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.record("unload-failed", reason);
			return {
				ok: false,
				endpoint,
				note: this.child !== null && this.exit !== null ? `the worker process had already exited (${reason}); its VRAM is already released` : `could not reach ${endpoint}/unload: ${reason}`
			};
		} finally {
			clearTimeout(timer);
		}
	}
	/** Resolve whether the interpreter and weights look usable, without starting anything. */
	async preflight() {
		const [interpreter, script, models] = await Promise.all([
			stat(this.settings.interpreter).then(() => true, () => false),
			stat(this.settings.script).then(() => true, () => false),
			stat(join(this.settings.modelsDir, "model_index.json")).then(() => true, () => false)
		]);
		return {
			interpreter,
			script,
			modelsDir: models,
			portBusy: await isPortBusy(this.activePort)
		};
	}
};
//#endregion
//#region src/tools.ts
/**
* Resolve a file shipped beside the built entry (`lib/index.js` → `<pkg>/…`).
*
* @param relative - package-relative path, e.g. `resources/worker.py`.
* @returns the absolute path, whether or not the file exists.
*/
function resourcePath(relative) {
	return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}
/** Ports tried when the config does not say otherwise. */
const DEFAULT_WORKER_PORTS = ["8399-8410"];
/** Actions `qwen_image_env` understands. */
const ENV_ACTIONS = [
	"status",
	"install",
	"fetch-weights",
	"repair",
	"unload"
];
/** Backends a caller may force; `auto` picks by key availability. */
const BACKENDS = [
	"auto",
	"api",
	"local",
	"comfyui"
];
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
		description: "画幅比（一等参数，官方 7 档）：1:1 / 4:3 / 3:4 / 3:2 / 2:3 / 16:9 / 9:16。本插件按 ~1.5MP 预算换算成 32 对齐的像素尺寸（换算表见 skill `qwen-image-forge` 正文「画幅比与像素」一节），因此契约里的 wh_ratio 不需要人工换算成宽高。省略时用 1:1；给了 width/height 时以 width/height 为准。"
	},
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
		description: "采样步数；省略则按配置解析：后端专属（`comfyuiSteps` / `localSteps`）→ 默认 `defaultSteps`（默认 25）。结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型/后端的建议值时再传。"
	},
	seed: {
		type: "integer",
		description: "随机种子；同一 seed + 同一 prompt + 同一尺寸可复现同一张图（后端支持时）。省略即随机。"
	},
	count: {
		type: "integer",
		description: "出图张数，1–4，默认 1。多张按后端返回顺序编号落盘。"
	},
	transparent: {
		type: "boolean",
		description: "要求带透明通道的输出（后端与模型支持时生效；不支持时后端可能忽略）。"
	},
	backend: {
		type: "string",
		enum: BACKENDS,
		description: "强制后端：auto（默认，有 API key 走 api，否则先试本机 ComfyUI，再退到本地 worker）/ api（云 API，需要 key）/ comfyui（复用本机已装好的 ComfyUI + Qwen-Image 权重，零下载、零转换）/ local（本机 worker 的 HTTP 契约）。"
	},
	preset: {
		type: "string",
		description: "落盘文件名前缀标签，例如 \"poster\"；只影响命名（<outputDir>/<前缀>_<W>x<H>_<n>.png），不影响生成参数。省略时为 \"qwen\"。"
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
		description: `画布固定比例（官方 7 档）：${WH_RATIOS.join(" / ")}。与 ratio_follow **互斥**；本插件按 ~1.5MP 预算换算成 32 对齐的像素尺寸。省略且没给 ratio_follow 时，默认跟随第一张参考图（不是 1:1）。注意：这七档换算出来的画布在 **local** 后端上全部超过编辑尺寸门（见 width 与工具说明）——本机实测 4:3 / 3:4 档就已经崩，要用 local 就得显式给更小的 width/height，或把配置 \`localReferenceBudget\` 调低（画布不动，降的是参考图条件化分辨率；1.5MP 画布上只有 512 实测跑得完）。`
	},
	width: {
		type: "integer",
		description: `显式覆盖宽度（像素）。必须与 height 成对给出，且为 32 的倍数、位于 256–${MAX_SIDE}；给了就以 width/height 为准（此时 ratio_follow / wh_ratio 被覆盖）。**local 后端有硬尺寸门**：插件按本机实测的 _reference_budget 分档——≤ 896 可靠放行、896–960 放行但返回警告、> 960 默认直接拒绝（要跑得显式开配置 allowLocalEditOverBudget）。档位判的是**生效的**预算：配置了 \`localReferenceBudget\` 就按它判（所以 512 + 1248×1248 画布是放行的），没配置才按画布推导——它只降参考图条件化分辨率（换速度与可跑性；保真度：同画布 896 vs 512 目视看不出差别，n=1、1 位评判者），不改出图尺寸。⚠️ 生效预算 > 512 **且**画布面积 > 1.0 MP 时另有一条**画布侧警告**（放行、只给建议）：1.5MP 画布上 896 实测 67 s/步（≈28 min / 25 步，不报错但等于不可用），只有 512 跑得完。所以「编辑在 local 上跑不动」时先看是不是画布太大，而不是先怀疑显存。`
	},
	height: {
		type: "integer",
		description: "显式覆盖高度（像素）。规则同 width，必须与 width 成对给出。"
	},
	steps: {
		type: "integer",
		description: "采样步数；省略则按配置解析：后端专属（`comfyuiSteps` / `localSteps`）→ 默认 `defaultSteps`（默认 25）。结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型/后端的建议值时再传。"
	},
	seed: {
		type: "integer",
		description: "随机种子；同一 seed + 同一 prompt + 同一参考图 + 同一尺寸可复现同一张图（后端支持时）。省略即随机。"
	},
	count: {
		type: "integer",
		description: "出图张数，1–4，默认 1。多张共用同一组参考图，按后端返回顺序编号落盘。"
	},
	transparent: {
		type: "boolean",
		description: "要求带透明通道的输出（后端与模型支持时生效；ComfyUI 的改图工作流不带 alpha 处理，会忽略它）。"
	},
	backend: {
		type: "string",
		enum: BACKENDS,
		description: "强制后端：auto（默认。**编辑场景跳过 api**——云后端没有编辑通道，先试本机 ComfyUI，再退到本地 worker）/ api（编辑不支持，会明确报错而不是丢掉参考图）/ comfyui（复用本机 ComfyUI + 官方 Qwen-Image 2.1 改图工作流）/ local（本机 worker 的 HTTP 契约，请求体多一个 images 字段）。**comfyui 不受编辑尺寸门约束**，所以它是超出尺寸门时最省事的出路；尺寸门只在请求真要落到 local 时才生效。"
	},
	preset: {
		type: "string",
		description: "落盘文件名前缀标签，例如 \"retouch\"；只影响命名（<outputDir>/<前缀>_<W>x<H>_<n>.png）。省略时为 \"edit\"。"
	}
};
/** Coerce a caller value that the schema may hand over as a loose number. */
function asInteger(value, label) {
	if (value === void 0) return void 0;
	if (!Number.isInteger(value)) throw new Error(`${label} must be an integer, got ${value}`);
	return value;
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
/**
* Decide the output size from `wh_ratio` and/or an explicit width/height pair.
*
* @param whRatio - caller ratio; defaults to `1:1` when nothing was supplied.
* @param width - explicit width, if any.
* @param height - explicit height, if any.
* @returns the aligned size and the provenance of the decision.
* @throws When only one of width/height is given, or a side is not 32-aligned.
*/
function chooseSize(whRatio, width, height) {
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
			exactRatio: Math.abs(nearest.deviationPercent) < .001
		};
	}
	const ratio = whRatio ?? "1:1";
	const size = resolveDefaultSize(ratio);
	return {
		width: size.width,
		height: size.height,
		sizeSource: "wh_ratio",
		whRatio: ratio,
		ratioDeviationPercent: size.ratioDeviationPercent,
		exactRatio: size.exact
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
* @returns the aligned canvas and the provenance of the decision.
* @throws When `wh_ratio` and `ratio_follow` are both set, when only one of
*   width/height is given, when an explicit side is illegal, or when
*   `ratio_follow` names something the call does not carry.
*/
function chooseEditSize(whRatio, ratioFollow, width, height, references) {
	const ratio = whRatio?.trim();
	const follow = ratioFollow?.trim();
	if (ratio !== void 0 && ratio.length > 0 && follow !== void 0 && follow.length > 0) throw new Error(`wh_ratio 与 ratio_follow 不能同时给（收到 wh_ratio="${ratio}"、ratio_follow="${follow}"）。\n  官方提示词契约把这两个字段定义成互斥的一对：ratio_follow 表示「画布跟随某张参考图的长宽比」，wh_ratio 表示「画布用这个固定比例」，两者都在指定画布比例，同时给出等于给了两个互相矛盾的口令，契约明说「一个非空另一个必须是空字符串」。请只留一个：
    • 跟随参考图 → 去掉 wh_ratio，保留 ratio_follow（或两者都不给，默认跟随第一张参考图）
    • 固定比例   → 去掉 ratio_follow，保留 wh_ratio`);
	if (width !== void 0 || height !== void 0) return {
		...chooseSize(void 0, width, height),
		followed: null,
		followedByDefault: false
	};
	const defaulted = (follow === void 0 || follow.length === 0) && (ratio === void 0 || ratio.length === 0);
	if (defaulted || follow !== void 0 && follow.length > 0) {
		const reference = defaulted ? references[0] : resolveRatioFollow(follow, references);
		if (reference === void 0) throw new Error("ratio_follow needs at least one reference image");
		const size = resolveDefaultSize(`${reference.width}:${reference.height}`);
		return {
			width: size.width,
			height: size.height,
			sizeSource: "ratio_follow",
			whRatio: nearestRatio(size.width, size.height).whRatio,
			ratioDeviationPercent: size.ratioDeviationPercent,
			exactRatio: size.exact,
			followed: reference,
			followedByDefault: defaulted
		};
	}
	return {
		...chooseSize(ratio, void 0, void 0),
		followed: null,
		followedByDefault: false
	};
}
/**
* Parse the comma-separated `comfyPorts` value into candidate ports.
*
* Anything that is not a usable port number is ignored rather than rejected: a
* typo in the config must not stop the plugin from loading, and the default list
* is the documented behaviour.
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
/** Everything the ComfyUI client needs from the resolved config. */
function comfyOptions(settings, timeoutMs = settings.timeoutMs) {
	return {
		endpoint: settings.comfyEndpoint,
		ports: settings.comfyPorts,
		modelsDir: settings.comfyModelsDir,
		timeoutMs
	};
}
/** Resolve everything the tool bodies need from the plugin config. */
function resolveSettings(config) {
	const key = resolveApiKey(config.apiKey);
	const runtimeDir = config.runtimeDir;
	const venv = venvPaths(runtimeDir);
	const basePythonCandidates = config.basePython.trim().length > 0 ? [config.basePython.trim()] : process.platform === "win32" ? [
		"python",
		"python3",
		"py"
	] : ["python3", "python"];
	const torchWheels = config.torchWheels.split(/[,\s]+/).map((part) => part.trim()).filter((part) => part.length > 0);
	return {
		backend: config.backend,
		apiBaseUrl: config.apiBaseUrl.replace(/\/+$/, ""),
		apiKey: key.key ?? "",
		apiKeySource: key.source,
		apiModel: config.apiModel,
		apiStyle: config.apiStyle,
		localEndpoint: config.localEndpoint.replace(/\/+$/, ""),
		comfyEndpoint: config.comfyEndpoint.replace(/\/+$/, ""),
		comfyPorts: parseComfyPorts(config.comfyPorts),
		comfyModelsDir: config.comfyModelsDir,
		outputDir: config.outputDir,
		timeoutMs: config.timeoutMs,
		runtimeDir,
		modelsDir: config.modelsDir.trim().length > 0 ? config.modelsDir : join(runtimeDir, "models", "qwen-image-2.1-bnb4bit"),
		modelRepo: config.modelRepo,
		hfMirror: config.hfMirror.replace(/\/+$/, ""),
		workerPorts: parsePorts(config.workerPorts.length > 0 ? config.workerPorts : DEFAULT_WORKER_PORTS.join(","), [
			8399,
			8400,
			8401,
			8402
		]),
		workerStartTimeoutMs: config.workerStartTimeoutMs,
		idleUnloadMs: config.idleUnloadMs,
		manageWorker: config.manageWorker,
		pythonPath: config.pythonPath.trim().length > 0 ? config.pythonPath : venv.python,
		basePythonCandidates,
		torchWheels: torchWheels.length > 0 ? torchWheels : [...TORCH_WHEEL_MATRIX],
		pipIndexUrl: config.pipIndexUrl.trim(),
		reuseBaseTorch: config.reuseBaseTorch,
		minFreeVramMiB: config.minFreeVramMiB,
		freeComfyBeforeLocalStart: config.freeComfyBeforeLocalStart,
		allowLocalEditOverBudget: config.allowLocalEditOverBudget,
		localReferenceBudget: config.localReferenceBudget,
		skipLmHead: config.skipLmHead,
		defaultSteps: config.defaultSteps,
		comfyuiSteps: config.comfyuiSteps,
		localSteps: config.localSteps,
		pipwrapPath: resourcePath("resources/pipwrap.py"),
		workerScript: config.workerScript.trim().length > 0 ? config.workerScript : resourcePath("resources/worker.py"),
		scratchDir: join(runtimeDir, "logs")
	};
}
/**
* Resolve the sampler steps one call should use against one backend.
*
* Priority: the caller's explicit `steps` > the backend's own override
* (`comfyuiSteps` / `localSteps`) > `defaultSteps`. The two backends historically
* disagreed — ComfyUI ran the official template's 25 while the worker fell back
* to 8 — so under `backend:"auto"` a fallback silently changed the picture.
*
* Resolving **per backend, at the point of dispatch** is the load-bearing part:
* when ComfyUI is not running and the call falls through to the worker, the
* worker's own override applies, rather than ComfyUI's count being carried over.
*
* @param explicit - the caller's `steps`, when it supplied one.
* @param backend - the backend about to run.
* @param settings - the resolved plugin settings.
* @returns the count and where it came from.
*/
function resolveSteps(explicit, backend, settings) {
	if (explicit !== void 0) return {
		steps: explicit,
		source: "explicit"
	};
	const override = backend === "comfyui" ? settings.comfyuiSteps : backend === "local" ? settings.localSteps : void 0;
	if (typeof override === "number" && Number.isFinite(override) && override >= 1) return {
		steps: Math.round(override),
		source: "backend"
	};
	return {
		steps: settings.defaultSteps,
		source: "default"
	};
}
/** Build the worker-lifecycle manager for one plugin instance. */
function createRuntime(settings) {
	return new WorkerRuntime({
		endpoint: settings.localEndpoint,
		interpreter: settings.pythonPath,
		script: settings.workerScript,
		modelsDir: settings.modelsDir,
		dataDir: settings.runtimeDir,
		ports: settings.workerPorts,
		startTimeoutMs: settings.workerStartTimeoutMs,
		idleUnloadMs: settings.idleUnloadMs,
		manage: settings.manageWorker,
		vramGate: {
			requiredMiB: settings.minFreeVramMiB,
			comfyPort: settings.comfyPorts[0] ?? 8188,
			comfyPorts: settings.comfyPorts,
			freeComfyFirst: settings.freeComfyBeforeLocalStart,
			scratchDir: settings.scratchDir
		}
	});
}
/**
* Worker facts as they belong in a generation result.
*
* @param handle - how the worker was obtained.
* @param restarted - the request was retried against a rebuilt worker.
* @param stages - the worker's own stage timings, when it reported any.
* @returns the report embedded as `local_worker`.
*/
function describeWorkerRun(handle, restarted, stages = {}) {
	return {
		endpoint: handle.endpoint,
		port: handle.port,
		pid: handle.pid,
		started_by_plugin: handle.started,
		adopted: handle.adopted,
		managed: handle.managed,
		ours: handle.ours,
		start_ms: handle.startMs,
		restarted_after_disconnect: restarted,
		ready: handle.state?.ready ?? null,
		load_seconds: handle.state?.load_seconds ?? null,
		stages_s: Object.keys(stages).length === 0 ? null : stages
	};
}
/**
* The pre-start VRAM gate's own account of what it saw and did.
*
* Reported rather than logged because one branch of it has a side effect: with
* `freeComfyBeforeLocalStart` on, the plugin asks ComfyUI to unload, and the user
* is entitled to see that it happened and what came back.
*
* @param runtime - the lifecycle manager the call went through.
* @returns the gate report, or null when the gate never ran.
*/
function describeVramGate(runtime) {
	const report = runtime.vramGate;
	if (report === null || !report.ran) return null;
	return {
		free_MiB: report.freeMiB,
		total_MiB: report.totalMiB,
		required_MiB: report.requiredMiB,
		shortfall_MiB: report.shortfallMiB,
		allowed: report.allowed,
		holders: report.holders.map((holder) => ({
			pid: holder.pid,
			name: holder.name,
			used_MiB: holder.usedMiB,
			comfyui: holder.comfyui
		})),
		freed_comfy: report.freedComfy === null ? null : {
			requested: true,
			url: report.freedComfy.url,
			http_status: report.freedComfy.httpStatus,
			ok: report.freedComfy.ok,
			body: report.freedComfy.body,
			note: report.freedComfy.note ?? null
		},
		warning: report.warning,
		note: report.freedComfy === null ? "插件没有动任何别的程序；`freeComfyBeforeLocalStart` 为 false（默认）时它只会报错并给出命令。" : `已按 freeComfyBeforeLocalStart 请求 ComfyUI 释放显存（POST ${report.freedComfy.url} → HTTP ${report.freedComfy.httpStatus}）。`
	};
}
/**
* Generate through the plugin-owned worker.
*
* A transport failure means the worker vanished (it was a child job of a session
* that ended, or it crashed): the runtime rebuilds it and the request is retried
* once. Anything else — a load failure, an HTTP error body — is surfaced as is,
* because retrying would only repeat it.
*
* @param runtime - the lifecycle manager.
* @param request - prompt plus the aligned canvas.
* @param signal - caller cancellation.
* @returns the images, the worker's stage timings, and how the worker was obtained.
*/
async function generateWithWorker(runtime, request, signal) {
	const handle = await runtime.ensure(signal);
	const finish = (generation, used, restarted) => {
		runtime.noteActivity();
		runtime.armIdleUnload();
		return {
			images: generation.images,
			stages: generation.stages,
			handle: used,
			restarted
		};
	};
	try {
		return finish(await generateViaLocal(handle.endpoint, request, signal), handle, false);
	} catch (error) {
		if (!(error instanceof LocalUnreachableError) || signal.aborted) throw error;
		await runtime.invalidate(`unreachable during /generate: ${error.message.slice(0, 160)}`);
		const retry = await runtime.ensure(signal);
		return finish(await generateViaLocal(retry.endpoint, request, signal), retry, true);
	}
}
/** The "no key, no ComfyUI, no worker" error, naming every remedy in order. */
function noBackendError(localReason, comfyReason) {
	return /* @__PURE__ */ new Error(`qwen_image_generate: no backend is available.
  • cloud: no API key found — set \`apiKey\` in the plugin config, or one of ${API_KEY_ENV_VARS.join(" / ")}. The key is read at call time and never written to disk.\n` + (comfyReason === void 0 ? "" : `  • comfyui: ${comfyReason}\n`) + `  • local: ${localReason}`);
}
/**
* The edit path's "neither local backend is available" error.
*
* Editing has no cloud fallback, so this must not tell the caller to go set an
* API key: with a key configured the message says outright that the key is not
* the problem.
*
* @param comfyReason - why ComfyUI could not serve the edit.
* @param localReason - why the managed worker could not serve the edit.
* @param keyPresent - whether a cloud key is configured (to rule it out).
* @returns the error to throw.
*/
function noEditBackendError(comfyReason, localReason, keyPresent) {
	return /* @__PURE__ */ new Error(`qwen_image_edit: neither local backend could run the edit.
  • comfyui: ${comfyReason}\n  • local: ${localReason}\n` + (keyPresent ? "  • cloud: an API key is configured, but the cloud backend has no edit path — it cannot take reference images at all.\n" : "") + "  改图是本机功能：起好本机 ComfyUI（带 Qwen-Image 权重）或让插件的本地 worker 能跑起来（`qwen_image_env` 的 status 看缺什么）。");
}
/**
* The **canvas-side** half of the gate's advice: a warning, never a refusal.
*
* The bands band the conditioning budget alone, because that is what the failure
* boundary tracks. The *speed* boundary does not: `docs/evidence/r5-budget-canvas-matrix.md` measured budget
* 896 at 1.9 s/step on a 0.82 MP canvas and at **67 s/step** on a 1.55 MP one —
* the same budget, ≈28 min for 25 steps instead of ≈1. All of it without an
* error, so nothing else in the stack would have told the caller.
*
* So a canvas over {@link LOCAL_EDIT_CANVAS_WARN_AREA} whose *effective* budget is
* over the one budget ever measured to finish there
* ({@link LOCAL_EDIT_CANVAS_SAFE_BUDGET}) gets a warning naming both endpoints.
*
* Only the bands that **let the request through** compose this text: its last
* move is "this is advice, not a refusal", which cannot be said inside a refusal.
*
* @param width - requested canvas width, in pixels.
* @param height - requested canvas height, in pixels.
* @param budget - the effective (post-override) conditioning budget.
* @returns the warning text, or `null` when either threshold is not crossed.
*/
function canvasSideWarning(width, height, budget) {
	const area = width * height;
	if (budget <= 512 || area <= 1e6) return null;
	return `本地编辑尺寸门·画布侧警告：这张画布 ${width}×${height}（${(area / 1e6).toFixed(2)} MP）大于 1.0 MP，而生效预算 ${budget} 大于 512——两者同时成立时实测**慢到不可用**（不是拒绝，本档仍然放行）。\n  本机实测：0.82 MP（1216×672）+ 预算 896 → 1.9 s/步；1.55 MP（1248×1248）+ 同一条 896 → **67 s/步**、25 步外推 ≈28 min（不报错，被运行器墙钟杀掉）；1.55 MP + 512 → wall 109.5 s、峰值 reserved 6488 MiB、worker 存活。\n  1.0 MP 这条线落在两个实测端点之间，是**插值**（未测）；1.5MP 画布上量过的只有 512（跑完）与 896（跑不完）两点，513–895 这段没量过。\n  建议：把配置 \`localReferenceBudget\` 设成 512（出图尺寸不变，只是参考图条件化分辨率变低），或改用 backend:"comfyui"。出处：docs/evidence/r5-budget-canvas-matrix.md。`;
}
/**
* Decide whether a **local** edit may run at the canvas it asked for.
*
* The three bands come from the conditioning budget, not from the canvas area: the
* failure boundary tracks `_reference_budget` (§(b) shows two differently shaped
* canvases with the same budget failing the same way). Every number below is this
* card class's own measurement, and the refusal is worded so it cannot be mistaken
* for the pre-start VRAM gate's advice.
*
* The budget banded here is the one the worker will really use: an explicit
* `localReferenceBudget` overrides the canvas derivation on both sides, so a
* `512` config lets a 1248×1248 canvas through as a 512 edit. Banding the canvas
* value instead would make the knob unable to do the one thing it exists for.
*
* @param width - requested canvas width, in pixels.
* @param height - requested canvas height, in pixels.
* @param allowOverBudget - the explicit opt-in (`allowLocalEditOverBudget`).
* @param configuredBudget - `localReferenceBudget`; `0` means "derive from the canvas".
* @returns the verdict, plus the text the caller must see whenever it is not the
*   clean reliable band.
* @throws When `configuredBudget` is neither `0` nor a 32-aligned budget in range.
*/
function localEditBudgetGate(width, height, allowOverBudget, configuredBudget = 0) {
	const { budget, source, canvasBudget } = resolveReferenceBudget(width, height, configuredBudget);
	const tier = localEditBudgetTier(budget);
	const canvasWarning = canvasSideWarning(width, height, budget);
	const withCanvas = (text) => canvasWarning === null ? text : `${text}\n${canvasWarning}`;
	const where = `画布 ${width}×${height} → 参考图条件化预算 _reference_budget = ${budget}` + (source === "config" ? `（来自配置 localReferenceBudget；这张画布本身会推出 ${canvasBudget}）` : "（按画布推导；可用配置 localReferenceBudget 覆盖）");
	if (tier === "reliable") return {
		budget,
		budgetSource: source,
		canvasBudget,
		tier,
		allowed: true,
		overridden: false,
		warning: canvasWarning
	};
	if (tier === "edge") return {
		budget,
		budgetSource: source,
		canvasBudget,
		tier,
		allowed: true,
		overridden: false,
		warning: withCanvas(`本地编辑尺寸门警告：${where}，落在「贴边通过」档（> 可靠线 896，≤ 960）。\n  本机实测（RTX 4070 Laptop 8188 MiB）这一档确实通过了，但峰值 reserved 8492 MiB 已经超过显卡总量 8188 MiB，靠 WDDM 共享内存撑住，去噪 21.19 s ≈ 928 档的 2 倍——能过，但可能显著变慢，也可能失败。\n  要可靠就把 _reference_budget 降到 ≤ 896（例如 1216×672——896 那条线正是在这张 0.82 MP 画布上量的），或改用 backend:"comfyui"。出处：docs/evidence/r4b-local-edit-failures.md §(b)。`)
	};
	const over = `本地编辑尺寸门：拒绝这次 local 编辑（${where} > 上限 960）。\n  为什么拦：本机实测这条路径上的失败**不是**一条干净的「显存不足」——budget 992–1024 在 **GPU 去噪段** CUDA OOM（申请 180/182 MiB，而仍有 910–1030 MiB reserved-but-unallocated 的碎片签名）；budget ≥ 1216 更发生在 GPU 还没开始干活的 **CPU 文本编码段**，形态是**访问违例 / access violation**，有时直接带走 worker 进程（连接被重置，日志停在 \`ready:\`）。
  所以别照着「空闲显存不足 → 先给 ComfyUI 发 POST /free」那条补救提示折腾：这条线由参考图条件化 token 数决定，与空闲显存无关。
  四条出路：① 改用 comfyui 后端（\`backend:"comfyui"\`，或 \`auto\` 且本机 ComfyUI 可用——8 GB 卡上编辑本来就优先走它）；② 显式给更小的 width/height（可靠档 _reference_budget ≤ 896，例如 1216×672）；③ 把配置 \`localReferenceBudget\` 调到 512——但要知道 **896 这条「可靠线」只按预算分档、不含画布本身的代价**：它的实测出处是 1216×672（0.82 MP：峰值 reserved 7458 MiB、1.9 s/步），同一预算搬到 1.5MP 画布（1248×1248）上是 **67 s/步**、25 步外推 ≈28 min（不报错，但等于不可用）——那张画布上唯一实测跑得完的是 512（wall 109.5 s、峰值 reserved 6488 MiB、worker 存活），513–895 这段没量过；降的是参考图条件化分辨率，换速度与可跑性——保真度：同画布（1216×672）896 vs 512 目视看不出差别（n=1、1 位评判者），1.5MP 画布上只测了 512；④ 接受风险、显式放行：配置 \`allowLocalEditOverBudget: true\`（默认 false）。
  出处：docs/evidence/r4b-local-edit-failures.md §(a)/§(b)、docs/evidence/r5-budget-canvas-matrix.md。`;
	if (!allowOverBudget) return {
		budget,
		budgetSource: source,
		canvasBudget,
		tier,
		allowed: false,
		overridden: false,
		warning: over
	};
	return {
		budget,
		budgetSource: source,
		canvasBudget,
		tier,
		allowed: true,
		overridden: true,
		warning: withCanvas(`本地编辑尺寸门：allowLocalEditOverBudget 为 true，按用户显式授权放行（${where}）。\n  预期风险（本机实测）：992–1024 在 GPU 去噪段 CUDA OOM；≥1216 在 CPU 文本编码段访问违例，worker 进程可能直接消失。出处：docs/evidence/r4b-local-edit-failures.md §(a)。`)
	};
}
/**
* Run one **local** edit, after the size gate has had its say.
*
* The gate lives here rather than at the top of the tool body because `comfyui` is
* one of the three ways out the refusal names: a request that ComfyUI is going to
* serve must never be refused by this gate. Only the two paths that really reach the
* worker pass through here, and they do so **before** `runtime.ensure`, so a refused
* call never spawns a process.
*
* The gate's verdict is also what the request body carries: an explicit
* `localReferenceBudget` is forwarded as `reference_budget` so the worker
* conditions at the budget the gate just banded. With no override the field is
* **absent**, and the worker derives the budget exactly as it always has.
*
* @param runtime - the one lifecycle owner.
* @param body - the resolved local `/generate` body (references included, steps
*   already decided — the gate never re-derives it).
* @param size - the canvas the gate budgets against.
* @param settings - resolved config, for the opt-in flag and the budget override.
* @param signal - aborts the request on tool cancellation.
* @returns the worker run plus the gate verdict, for the result payload.
* @throws When the budget is over the line and the override is off.
*/
async function editWithWorker(runtime, body, size, settings, signal) {
	const configured = settings.localReferenceBudget;
	const gate = localEditBudgetGate(size.width, size.height, settings.allowLocalEditOverBudget, configured);
	if (!gate.allowed) throw new Error(gate.warning ?? `local edit refused: budget ${gate.budget}`);
	return {
		run: await generateWithWorker(runtime, gate.budgetSource === "config" ? {
			...body,
			referenceBudget: gate.budget
		} : body, signal),
		gate
	};
}
/**
* Register the tools on the tool registry.
*
* @param ctx - cordis context providing `tools`.
* @param config - resolved plugin config.
*/
function registerImageForgeTools(ctx, config) {
	const settings = resolveSettings(config);
	const runtime = createRuntime(settings);
	const deploy = startDeployServer(settings);
	ctx.on?.("dispose", () => {
		runtime.stop();
		deploy.dispose();
	});
	ctx.tools.register(defineTool({
		name: "qwen_image_generate",
		description: `用 Qwen-Image 出图。\`prompt\` 收**成品**提示词（本工具不改写），\`wh_ratio\` 是**一等参数**：直接接受官方契约的 7 档画幅比（${WH_RATIOS.join(" / ")}），插件自己换算成 32 对齐的像素尺寸——所以「契约输出 → 插件入参」不需要人工翻译。省略 wh_ratio 用 1:1，给了 width/height 则以它们为准。结果落盘到配置的 outputDir 并把绝对路径写进正文 Markdown，同时回传结构化字段。`,
		parameters: GENERATE_PARAMETERS,
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
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
		},
		timeoutMs: Math.max(settings.timeoutMs, settings.workerStartTimeoutMs + 6e4),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const prompt = args.prompt.trim();
			if (prompt.length === 0) throw new Error("prompt must not be blank");
			const size = chooseSize(args.wh_ratio, asInteger(args.width, "width"), asInteger(args.height, "height"));
			const count = validateCount(args.count);
			const steps = asInteger(args.steps, "steps");
			if (steps !== void 0 && steps < 1) throw new Error(`steps must be >= 1, got ${steps}`);
			const requestedBackend = args.backend ?? settings.backend;
			const request = {
				prompt,
				width: size.width,
				height: size.height,
				count,
				steps,
				seed: asInteger(args.seed, "seed"),
				transparent: args.transparent === true
			};
			const startedAt = Date.now();
			let usedBackend;
			let backendLabel;
			let comfyUnet = null;
			let comfyRun = null;
			let workerRun = null;
			let images;
			let usedSteps;
			if (requestedBackend === "api" || requestedBackend === "auto" && settings.apiKey.length > 0) {
				if (settings.apiKey.length === 0) throw new Error(`qwen_image_generate: backend "api" needs a key. Set \`apiKey\` in the plugin config or one of ${API_KEY_ENV_VARS.join(" / ")}; it is read at call time and never written to disk.`);
				const apiSettings = {
					baseUrl: settings.apiBaseUrl,
					apiKey: settings.apiKey,
					model: settings.apiModel,
					style: settings.apiStyle
				};
				usedSteps = resolveSteps(steps, "api", settings);
				images = await generateViaApi(apiSettings, {
					...request,
					steps: usedSteps.steps
				}, exec.signal);
				usedBackend = "api";
				backendLabel = `后端 api / ${settings.apiModel}`;
			} else if (requestedBackend === "local") {
				usedSteps = resolveSteps(steps, "local", settings);
				const run = await generateWithWorker(runtime, {
					...request,
					steps: usedSteps.steps
				}, exec.signal);
				images = run.images;
				workerRun = describeWorkerRun(run.handle, run.restarted, run.stages);
				usedBackend = "local";
				backendLabel = run.handle.started ? `后端 local（插件自启 worker pid ${run.handle.pid ?? "?"}，启动 ${run.handle.startMs} ms）` : "后端 local";
			} else {
				const options = comfyOptions(settings);
				try {
					const target = await discoverComfyUi(options, exec.signal);
					const models = await loadComfyModels(target, options, exec.signal);
					const comfyStartedAt = Date.now();
					usedSteps = resolveSteps(steps, "comfyui", settings);
					images = await generateViaComfyUi(target, models, {
						...request,
						steps: usedSteps.steps
					}, options, exec.signal);
					usedBackend = "comfyui";
					comfyUnet = models.unet;
					backendLabel = `后端 comfyui / ${target.endpoint} / ${models.unet}`;
					comfyRun = {
						endpoint: target.endpoint,
						port: target.port,
						probed: target.probed,
						models,
						transparent_requested: request.transparent,
						elapsed_ms: Date.now() - comfyStartedAt
					};
				} catch (error) {
					const comfyReason = error instanceof Error ? error.message : String(error);
					if (requestedBackend === "comfyui") throw error;
					try {
						usedSteps = resolveSteps(steps, "local", settings);
						const run = await generateWithWorker(runtime, {
							...request,
							steps: usedSteps.steps
						}, exec.signal);
						images = run.images;
						workerRun = describeWorkerRun(run.handle, run.restarted, run.stages);
						usedBackend = "local";
						backendLabel = "后端 local";
					} catch (localError) {
						throw noBackendError(localError instanceof Error ? localError.message : String(localError), comfyReason);
					}
				}
			}
			const prefix = sanitizePrefix(args.preset);
			const written = await writeImages(settings.outputDir, prefix, size.width, size.height, images);
			const markdown = renderMarkdown(written);
			return jsonSafe({
				ok: true,
				backend: usedBackend,
				model: usedBackend === "api" ? settings.apiModel : comfyUnet,
				wh_ratio: size.whRatio,
				wh_ratio_requested: args.wh_ratio ?? null,
				size: {
					width: size.width,
					height: size.height
				},
				size_source: size.sizeSource,
				ratio_deviation_percent: size.ratioDeviationPercent,
				exact_ratio: size.exactRatio,
				count,
				steps: steps ?? null,
				steps_used: usedSteps?.steps ?? null,
				steps_source: usedSteps?.source ?? null,
				seed: request.seed ?? null,
				transparent: request.transparent,
				prompt_chars: prompt.length,
				output_dir: settings.outputDir,
				images: written.map((image) => ({
					index: image.index,
					path: image.path,
					bytes: image.bytes,
					mime: sniffImageMime(images[image.index - 1]?.bytes ?? /* @__PURE__ */ new Uint8Array()) ?? image.mime
				})),
				comfyui: comfyRun,
				local_worker: workerRun,
				vram_gate: describeVramGate(runtime),
				markdown,
				summary: `出图完成：${written.length} 张，${size.width}×${size.height}（wh_ratio ${size.whRatio}${size.exactRatio ? "" : `，实际 ${size.ratioDeviationPercent > 0 ? "+" : ""}${size.ratioDeviationPercent}%`}），${backendLabel}，落盘 ${settings.outputDir}。`,
				elapsed_ms: Date.now() - startedAt
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "qwen_image_edit",
		description: `用 Qwen-Image 2.1 做**参考图编辑（图生图）**：给 1 张或多张参考图 + 一段**成品修改指令**，出改好的图。\`images\` 收 1–10 张参考图（绝对路径或 data:image/…;base64,…，按顺序对应提示词里的 \`<image1>\`…\`<imageN>\`），\`ratio_follow\` 让画布**跟随某张参考图的宽高比**（写 \`image1\`…\`image10\`，或直接把 \`images\` 里的那一项再写一遍）；它与 \`wh_ratio\` **互斥**（官方契约里一个非空另一个必须为空），两个都不给时**默认跟随第一张参考图**。编辑只在本机后端跑：\`comfyui\`（官方 Qwen-Image 2.1 改图工作流，参考图先上传进 ComfyUI）或 \`local\`（受管 worker，/generate 多一个 images 字段）；云 API 没有编辑通道，强行指定时会明确报错，绝不静默丢掉参考图。**local 有硬尺寸门**：按**生效的**参考图条件化预算 _reference_budget 分档（配置了 \`localReferenceBudget\` 就用它，否则按画布推导）——≤ 896 放行、896–960 放行并在结果里带警告、> 960 默认拒绝（失败形态是访问违例/进程消失，不是「显存不足」；出路是 comfyui、更小的 width/height、把 \`localReferenceBudget\` 调到 512（**1.5MP 画布上唯一实测跑得完的档**：wall 109.5 s、峰值 reserved 6488 MiB、worker 存活；896 在同一张 1248×1248 上是 67 s/步、25 步外推 ≈28 min——不报错，但等于不可用；896 那条可靠线的实测出处是 1216×672 画布，一档只看预算、不含画布代价。保真度：同画布 896 vs 512 目视看不出差别，n=1、1 位评判者）；或配置 \`allowLocalEditOverBudget: true\`）。\`comfyui\` 不受这道门约束。结果落盘到 outputDir 并把绝对路径写进正文 Markdown。`,
		parameters: EDIT_PARAMETERS,
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
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
		},
		timeoutMs: Math.max(settings.timeoutMs, settings.workerStartTimeoutMs + 6e4),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const prompt = args.prompt.trim();
			if (prompt.length === 0) throw new Error("prompt must not be blank");
			const references = await loadReferenceImages(args.images);
			const size = chooseEditSize(args.wh_ratio, args.ratio_follow, asInteger(args.width, "width"), asInteger(args.height, "height"), references);
			const count = validateCount(args.count);
			const steps = asInteger(args.steps, "steps");
			if (steps !== void 0 && steps < 1) throw new Error(`steps must be >= 1, got ${steps}`);
			const requestedBackend = args.backend ?? settings.backend;
			const request = {
				prompt,
				width: size.width,
				height: size.height,
				count,
				steps,
				seed: asInteger(args.seed, "seed"),
				transparent: args.transparent === true,
				images: references
			};
			const startedAt = Date.now();
			let usedBackend;
			let backendLabel;
			let comfyUnet = null;
			let comfyRun = null;
			let workerRun = null;
			let images;
			let usedSteps;
			let budgetGate = null;
			if (requestedBackend === "api") throw new Error("qwen_image_edit: backend \"api\" 没有编辑通道，参考图不会被丢给一个用不了它们的后端。云 API 的编辑是另一种请求形态（multipart POST /images/edits，或 DashScope 的原生异步任务接口），本插件没有实现它。\n  能编辑的两个后端都是本机的，不需要 key：backend \"comfyui\"（复用本机已装好的 ComfyUI + Qwen-Image 权重）或 \"local\"（插件自己拉起 worker）。");
			else if (requestedBackend === "local") {
				usedSteps = resolveSteps(steps, "local", settings);
				const gated = await editWithWorker(runtime, {
					...request,
					steps: usedSteps.steps
				}, size, settings, exec.signal);
				budgetGate = gated.gate;
				images = gated.run.images;
				workerRun = describeWorkerRun(gated.run.handle, gated.run.restarted, gated.run.stages);
				usedBackend = "local";
				backendLabel = gated.run.handle.started ? `后端 local（插件自启 worker pid ${gated.run.handle.pid ?? "?"}，启动 ${gated.run.handle.startMs} ms）` : "后端 local";
			} else {
				const options = comfyOptions(settings);
				try {
					const target = await discoverComfyUi(options, exec.signal);
					const models = await loadComfyModels(target, options, exec.signal);
					const comfyStartedAt = Date.now();
					usedSteps = resolveSteps(steps, "comfyui", settings);
					images = await generateViaComfyUiEdit(target, models, {
						...request,
						steps: usedSteps.steps
					}, options, exec.signal);
					usedBackend = "comfyui";
					comfyUnet = models.unet;
					backendLabel = `后端 comfyui / ${target.endpoint} / ${models.unet}`;
					comfyRun = {
						endpoint: target.endpoint,
						port: target.port,
						probed: target.probed,
						models,
						references_uploaded: references.map((reference) => reference.label),
						transparent_requested: request.transparent,
						elapsed_ms: Date.now() - comfyStartedAt
					};
				} catch (error) {
					const comfyReason = error instanceof Error ? error.message : String(error);
					if (requestedBackend === "comfyui") throw error;
					try {
						usedSteps = resolveSteps(steps, "local", settings);
						const gated = await editWithWorker(runtime, {
							...request,
							steps: usedSteps.steps
						}, size, settings, exec.signal);
						budgetGate = gated.gate;
						images = gated.run.images;
						workerRun = describeWorkerRun(gated.run.handle, gated.run.restarted, gated.run.stages);
						usedBackend = "local";
						backendLabel = "后端 local";
					} catch (localError) {
						throw noEditBackendError(comfyReason, localError instanceof Error ? localError.message : String(localError), settings.apiKey.length > 0);
					}
				}
			}
			const prefix = sanitizePrefix(args.preset, "edit");
			const written = await writeImages(settings.outputDir, prefix, size.width, size.height, images);
			const markdown = renderMarkdown(written);
			const followed = size.followed;
			const followLabel = followed === null ? null : `image${followed.index}`;
			return jsonSafe({
				ok: true,
				backend: usedBackend,
				model: comfyUnet,
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
				steps_used: usedSteps?.steps ?? null,
				steps_source: usedSteps?.source ?? null,
				seed: request.seed ?? null,
				transparent: request.transparent,
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
				api_skipped: requestedBackend === "auto" && settings.apiKey.length > 0 ? "no edit path on the cloud backend" : null,
				comfyui: comfyRun,
				local_worker: workerRun,
				local_edit_budget: budgetGate === null ? null : {
					budget: budgetGate.budget,
					budget_source: budgetGate.budgetSource,
					canvas_budget: budgetGate.canvasBudget,
					configured_budget: settings.localReferenceBudget,
					tier: budgetGate.tier,
					reliable_max: 896,
					edge_max: 960,
					allowed: budgetGate.allowed,
					overridden: budgetGate.overridden,
					warning: budgetGate.warning
				},
				vram_gate: describeVramGate(runtime),
				markdown,
				summary: `改图完成：${written.length} 张，${size.width}×${size.height}（` + (followLabel === null ? `wh_ratio ${size.whRatio}` : `ratio_follow ${followLabel}${size.followedByDefault ? "（默认跟随第一张参考图）" : ""} ← ${followed?.width}×${followed?.height}`) + `${size.exactRatio ? "" : `，实际 ${size.ratioDeviationPercent > 0 ? "+" : ""}${size.ratioDeviationPercent}%`}），${references.length} 张参考图，${backendLabel}，落盘 ${settings.outputDir}。` + (budgetGate?.warning == null ? "" : `\n${budgetGate.warning}`),
				elapsed_ms: Date.now() - startedAt
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "qwen_image_env",
		description: "本机环境体检与**本地运行时管理**（这个插件自己拥有 venv / 权重 / worker 的生命周期）。\n`status`（默认）：GPU 名与驱动、**显存余量（低于阈值就预警，并指名是谁占着——本机实测 ComfyUI 常驻约 2.9 GiB，给出它的 POST /free 命令；一个占用者都报不出来时也会说明那多半是分配器缓存、而不是「没人占着」）**、宿主内存、磁盘、输出目录、云 API 与 worker 端点，以及 venv/权重/worker 是否就绪。\n`install`：建 venv + 装 CUDA 版 torch（cu128 → cu126 → cu118 逐级降级；**已经装了 CUDA torch 就复用，不重装**）；先跑 `dryRun:true` 可以只看计划。\n`fetch-weights`：从 hf-mirror.com 下载 10.63 GiB 的 nf4 权重（**不用 huggingface.co，它的 /api/ 会超时**）：下载前查磁盘、断点续传、逐文件 sha256 校验、可选剔除不被管线读取的 lm_head.weight。\n`unload`：调 worker 的 POST /unload 把显存还回去（进程留着，下一张图会重新加载）。\n`repair`：能修就修（缺包补装、量化开关没开就补写、worker 卡死就杀掉），不能修就**明确报因 + 给下一步**，绝不假装成功。",
		parameters: {
			action: {
				type: "string",
				enum: ENV_ACTIONS,
				description: "要执行的动作；默认 status。"
			},
			dryRun: {
				type: "boolean",
				description: "只报告计划、不改机器（install / fetch-weights / repair 都支持）。"
			},
			force: {
				type: "boolean",
				description: "fetch-weights：磁盘空间检查不通过时仍然尝试下载。"
			},
			skipLmHead: {
				type: "boolean",
				description: "fetch-weights：下完后从 text_encoder/model.safetensors 里剔除 lm_head.weight（约 1187 MiB，管线取 hidden_states[-1]，从不使用它）。默认取插件配置；**未在本机验证过**，剔除前会校验重写结果，校验不过就保留原文件。"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		timeoutMs: 36e5,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const action = args.action ?? "status";
			const dryRun = args.dryRun === true;
			if (action === "status") {
				const comfyui = await probeComfyUi(comfyOptions(settings, Math.min(settings.timeoutMs, 1e4)), exec.signal);
				const localRuntime = await collectLocalRuntime({
					runtime,
					runtimeDir: settings.runtimeDir,
					python: settings.pythonPath,
					modelsDir: settings.modelsDir,
					dataDir: settings.runtimeDir,
					probeTimeoutMs: Math.min(settings.timeoutMs, 15e3),
					scratchDir: settings.scratchDir,
					signal: exec.signal
				});
				const status = await collectEnvStatus({
					apiBaseUrl: settings.apiBaseUrl,
					apiKeyPresent: settings.apiKey.length > 0,
					apiKeySource: settings.apiKeySource,
					localEndpoint: settings.localEndpoint,
					comfyui,
					outputDir: settings.outputDir,
					outputDirWritable: await ensureOutputDirWritable(settings.outputDir),
					probeTimeoutMs: Math.min(settings.timeoutMs, 1e4),
					minFreeVramMiB: settings.minFreeVramMiB,
					scratchDir: settings.scratchDir,
					localRuntime
				}, exec.signal);
				const advisory = status.vram_advisory;
				const advisories = advisory?.suggestions ?? [];
				return jsonSafe({
					action,
					generated_at: (/* @__PURE__ */ new Date()).toISOString(),
					config: {
						backend: settings.backend,
						apiModel: settings.apiModel,
						apiStyle: settings.apiStyle,
						outputDir: settings.outputDir,
						localEndpoint: settings.localEndpoint,
						comfyEndpoint: settings.comfyEndpoint,
						comfyPorts: settings.comfyPorts,
						timeoutMs: settings.timeoutMs,
						runtimeDir: settings.runtimeDir,
						modelsDir: settings.modelsDir,
						hfMirror: settings.hfMirror,
						workerPorts: settings.workerPorts,
						idleUnloadMs: settings.idleUnloadMs,
						manageWorker: settings.manageWorker,
						minFreeVramMiB: settings.minFreeVramMiB,
						freeComfyBeforeLocalStart: settings.freeComfyBeforeLocalStart,
						allowLocalEditOverBudget: settings.allowLocalEditOverBudget,
						localReferenceBudget: settings.localReferenceBudget
					},
					worker_start_gate: advisory === void 0 ? null : {
						would_refuse_start: !advisory.start_gate.allowed,
						free_MiB: advisory.freeMiB,
						required_MiB: advisory.requiredMiB,
						shortfall_MiB: advisory.start_gate.shortfallMiB,
						holders: advisory.holders,
						remedy: advisory.start_gate.remedy,
						auto_free_enabled: settings.freeComfyBeforeLocalStart,
						no_visible_holder: advisory.start_gate.no_visible_holder,
						suspicion: vramSuspicionWarning(advisory, settings.comfyPorts[0] ?? 8188),
						note: advisory.start_gate.allowed ? `空闲 ${advisory.freeMiB ?? "?"} MiB ≥ 阈值 ${advisory.requiredMiB} MiB：本地 worker 允许启动。` + (advisory.holders.length > 0 ? `但当时有 ${advisory.holders.length} 个进程占着显存，见 suspicion（8 GB 卡上这部分余量会在加载时被吃掉）。` : "") : `空闲 ${advisory.freeMiB ?? "?"} MiB < 阈值 ${advisory.requiredMiB} MiB：本地 worker 会被拒绝启动（还差 ${advisory.start_gate.shortfallMiB ?? "?"} MiB）。` + (advisory.start_gate.no_visible_holder ? "nvidia-smi 没报占用者也**不能读成没人占着**：ComfyUI 跑完会把约 3.6 GiB 的 `cudaMallocAsync` 分配器缓存留在自己进程里、而它列不出来（见 `docs/configuration.md`「一个会让人卡住的显存陷阱（8 GB 卡必读）」）。补救是 `POST /free` + 隔十几秒重跑。" : "") + (settings.freeComfyBeforeLocalStart ? "`freeComfyBeforeLocalStart` 已开启，插件会先请求 ComfyUI 释放再启动。" : "默认不会替你去动 ComfyUI；执行 remedy 里那条命令，或把 `freeComfyBeforeLocalStart` 设为 true。")
					},
					advisories,
					...status
				});
			}
			if (action === "install") return jsonSafe({
				...await runInstall({
					runtimeDir: settings.runtimeDir,
					pipwrap: settings.pipwrapPath,
					basePythonCandidates: settings.basePythonCandidates,
					torchWheels: settings.torchWheels,
					pipIndexUrl: settings.pipIndexUrl,
					reuseBaseTorch: settings.reuseBaseTorch,
					dryRun,
					commandTimeoutMs: 36e5,
					scratchDir: settings.scratchDir
				}),
				packages_expected: RUNTIME_PACKAGES
			});
			if (action === "fetch-weights") return jsonSafe(await runFetchWeights({
				repo: settings.modelRepo,
				mirror: settings.hfMirror,
				revision: "main",
				dir: settings.modelsDir,
				skipLmHead: args.skipLmHead ?? settings.skipLmHead,
				dryRun,
				force: args.force === true,
				scratchDir: settings.scratchDir,
				stallTimeoutMs: 12e4,
				signal: exec.signal
			}));
			if (action === "unload") {
				const before = await runtime.inspect(runtime.endpoint, 1500, exec.signal);
				const outcome = await runtime.unload();
				const after = await runtime.inspect(runtime.endpoint, 1500, exec.signal);
				const status = typeof outcome.http_status === "number" ? outcome.http_status : null;
				return jsonSafe({
					action,
					...outcome,
					vram_before_MiB: before.state?.vram_allocated_MiB ?? null,
					vram_after_MiB: after.state?.vram_allocated_MiB ?? null,
					note: outcome.ok === true ? "显存已交回；worker 进程仍在，下一张图会触发重新加载（约 10 s 起）。" : status === 404 ? "这个 worker 实现了冻结契约但没有 /unload 端点（多半是别人起的旧 worker）：本插件只能放弃回收，或者用 `manageWorker:true` 让它换成随包 worker。" : status !== null ? `worker 的 /unload 应答了 HTTP ${status}；显存没有交回，原文见 body。` : "没有可回收的 worker（它本来就没在跑，显存已经是空着的）。"
				});
			}
			return jsonSafe(await runRepair({
				runtime,
				runtimeDir: settings.runtimeDir,
				python: settings.pythonPath,
				modelsDir: settings.modelsDir,
				dataDir: settings.runtimeDir,
				pipwrap: settings.pipwrapPath,
				basePythonCandidates: settings.basePythonCandidates,
				torchWheels: settings.torchWheels,
				pipIndexUrl: settings.pipIndexUrl,
				reuseBaseTorch: settings.reuseBaseTorch,
				dryRun,
				commandTimeoutMs: 36e5,
				scratchDir: settings.scratchDir,
				signal: exec.signal
			}));
		}
	}));
	ctx.tools.register(defineTool({
		name: "qwen_image_status",
		description: "后端健康探测：云 API 端点是否可达、key 是否被接受（401/403 会点名）、**本机 ComfyUI 是否在跑**（含探测过哪几个端口、三个 Qwen-Image 权重能不能被它的加载器枚举到），以及本地 worker 是否在跑。不产生任何图片、不写盘、不改配置；**不会回显 key**。排障时先跑它。",
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
			const budget = Math.min(args.timeoutMs ?? settings.timeoutMs, 3e4);
			const [api, localWritable, comfyui] = await Promise.all([
				probeApi({
					baseUrl: settings.apiBaseUrl,
					apiKey: settings.apiKey,
					model: settings.apiModel,
					style: settings.apiStyle
				}, budget, exec.signal),
				generateViaLocalProbe(settings.localEndpoint, exec.signal),
				probeComfyUi(comfyOptions(settings, budget), exec.signal)
			]);
			const [worker, weights] = await Promise.all([runtime.inspect(runtime.endpoint, Math.min(budget, 3e3), exec.signal), inspectWeights(settings.modelsDir)]);
			const { stat } = await import("node:fs/promises");
			const venvPresent = await stat(settings.pythonPath).then(() => true, () => false);
			return jsonSafe({
				checked_at: (/* @__PURE__ */ new Date()).toISOString(),
				configured_backend: settings.backend,
				api: {
					baseUrl: settings.apiBaseUrl,
					model: settings.apiModel,
					style: settings.apiStyle,
					keySource: settings.apiKeySource ?? null,
					...api
				},
				comfyui: {
					modelsDir: settings.comfyModelsDir.length > 0 ? settings.comfyModelsDir : null,
					...comfyui
				},
				local: localWritable,
				worker: {
					endpoint: worker.endpoint,
					port: runtime.port,
					reachable: worker.reachable,
					ready: worker.ready,
					ours: worker.ours,
					pid: worker.state?.pid ?? null,
					load_error: worker.state?.load_error ?? null,
					log_file: runtime.logFile,
					lifecycle_events: runtime.events.slice(0, 5),
					note: worker.reachable ? null : `${worker.note ?? "unreachable"} — worker 不在跑；下一次 \`qwen_image_generate\` 会自己把它拉起来`
				},
				venv: {
					python: settings.pythonPath,
					exists: venvPresent
				},
				weights: {
					dir: settings.modelsDir,
					ready: weights.ready,
					missing_files: weights.missing_files,
					total_MiB: weights.total_MiB
				},
				output: {
					dir: settings.outputDir,
					writable: await ensureOutputDirWritable(settings.outputDir)
				}
			});
		}
	}));
}
/** Probe the local worker's health endpoint, reporting rather than throwing. */
async function generateViaLocalProbe(endpoint, signal) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), 1500);
	const onAbort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(`${endpoint}/health`, { signal: controller.signal });
		return {
			endpoint,
			reachable: true,
			status: response.status,
			running: response.ok
		};
	} catch (error) {
		return {
			endpoint,
			reachable: false,
			running: false,
			note: `${error instanceof Error ? error.message : String(error)} — 本地 worker 不在跑，或 localEndpoint 配错了`
		};
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
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
//#region src/config-defaults.ts
/**
* The plugin's **default paths**, as the settings page shows them.
*
* These exist because an empty text box is not an answer. Eight config fields
* used to default to `''` and resolve to something concrete only deep inside the
* tool layer, so the settings page showed a blank where the plugin was in fact
* using a specific interpreter, a specific weight directory and a specific
* ComfyUI models root. A user reading the page could not tell what would happen.
*
* So the defaults here are the *resolved* values:
*
* - **Derived** ones (`pythonPath`, `modelsDir`, `workerScript`) are pure string
*   arithmetic over the runtime directory and the package location — no I/O, and
*   identical to what the tool layer derives from an empty field, so baking them
*   as defaults cannot change behaviour.
* - **Probed** ones (`basePython`, `comfyModelsDir`) scan a candidate list with
*   `existsSync` and fall back to `''` when nothing is found, which keeps the
*   original "let the tool layer figure it out" path intact on an unknown box.
*
* Two deliberate limits:
*
* - **Nothing here does network I/O.** `comfyEndpoint` stays empty on purpose:
*   its documented meaning is "probe `comfyPorts` at call time", and opening a
*   socket while building a config schema would be a side effect in the wrong
*   place. Its hint states the ports instead.
* - **Nothing here is imported by the browser half.** `settings-fields.ts` is
*   bundled for the browser and therefore cannot touch `node:fs`; the page learns
*   these values from the Host, which serves the schema defaults as the form's
*   values.
*/
/** Default output directory: a normal user-visible pictures folder. */
function defaultOutputDir() {
	return join(homedir(), "Pictures", "dsh-image-forge");
}
/** Default home for the plugin-owned runtime (venv, weights, logs). */
function defaultRuntimeDir() {
	return join(homedir(), ".dsh-image-forge");
}
/**
* The worker script shipped beside this package.
*
* @returns the absolute path to `resources/worker.py`.
*/
function defaultWorkerScript() {
	return resourcePath("resources/worker.py");
}
/**
* Look for one of several executable names across `PATH`, in order.
*
* @param names - file names to try, all of them in each directory before moving on.
* @returns the first existing absolute path, or `''`.
*/
function searchPath(names) {
	const raw = process.env.PATH;
	if (raw === void 0 || raw === "") return "";
	for (const dir of raw.split(delimiter)) {
		if (dir.length === 0) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			try {
				if (existsSync(candidate)) return candidate;
			} catch {}
		}
	}
	return "";
}
/**
* Look for a CPython install in the platform's usual locations.
*
* The installer's default `Python3xx` layout is what this scans for; anything
* else would need a real registry or launcher query, which is out of proportion
* for a default value the user can overwrite.
*
* @returns the first existing interpreter path, or `''`.
*/
function searchPythonRoots() {
	const roots = process.platform === "win32" ? [join(process.env.LOCALAPPDATA ?? "", "Programs", "Python"), join(process.env.ProgramFiles ?? "", "Python")] : ["/usr/local/bin", "/usr/bin"];
	for (const root of roots) {
		if (root.length === 0) continue;
		let entries;
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries.filter((name) => /^Python3/i.test(name)).sort()) {
			const candidate = join(root, entry, "python.exe");
			try {
				if (existsSync(candidate)) return candidate;
			} catch {}
		}
	}
	return "";
}
/**
* Find a base interpreter for `action:"install"` to build the venv from.
*
* A real interpreter is preferred over the `py` launcher, and a `PATH` hit over
* a scanned install root, so the value is the most directly usable one.
*
* @returns an absolute interpreter path, or `''` when none is found — which
*   leaves the tool layer's own `python` / `python3` / `py` fallback in charge.
*/
function probeBasePython() {
	const win = process.platform === "win32";
	const interpreters = win ? ["python.exe", "python3.exe"] : ["python3", "python"];
	const launcher = win ? ["py.exe"] : [];
	return searchPath(interpreters) || (launcher.length > 0 ? searchPath(launcher) : "") || searchPythonRoots();
}
/**
* Where a ComfyUI install keeps its `models` directory, most likely first.
*
* The two `D:\Comfy-Desktop\…` entries are the layout the ComfyUI Desktop
* installer produces on this machine and were confirmed present — Windows only;
* the rest are the conventional per-user locations, with the Linux/macOS clone
* and `/opt` spots added where those platforms actually put one. Ordering only decides which one wins when
* several exist, and the value is shown on the settings page so a wrong pick is
* visible and correctable.
*
* @returns candidate directories, whether or not they exist.
*/
function comfyModelsCandidates() {
	const win = process.platform === "win32";
	const roaming = process.env.APPDATA ?? "";
	const local = process.env.LOCALAPPDATA ?? "";
	return [
		...win ? ["D:\\Comfy-Desktop\\ComfyUI-Shared\\models", "D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\models"] : [],
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
//#region src/skill.ts
/** Skill name shown in the catalog and used when routing. */
const SKILL_NAME = "qwen-image-forge";
/** Short catalog blurb; the routing keywords live here, not in the body. */
const SKILL_DESCRIPTION = "用 Qwen-Image（千问生图）出图：把口语需求按提示词契约改写成成品 prompt，并把契约里的 wh_ratio 直接作为工具的一等参数出图（无需人工换算像素）。当用户要求生成图片、出海报/头像/封面/壁纸、按指定画幅比出图，或要给了一/多张参考图的改图、融图需求写指令时使用。仅面向 Qwen-Image 模型。";
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
* downstream sees it.
*/
const Config = Schema.object({
	backend: Schema.union([
		"auto",
		"api",
		"local",
		"comfyui"
	]).default("auto").volatile(),
	apiBaseUrl: Schema.string().default("https://dashscope.aliyuncs.com/compatible-mode/v1").volatile(),
	apiKey: Schema.string().default("").volatile(),
	apiModel: Schema.string().default("qwen-image").volatile(),
	apiStyle: Schema.union(["openai", "dashscope"]).default("openai").volatile(),
	outputDir: Schema.string().default(defaultOutputDir()).volatile(),
	timeoutMs: Schema.number().default(18e4).volatile(),
	localEndpoint: Schema.string().default("http://127.0.0.1:8399").volatile(),
	comfyEndpoint: Schema.string().default("").volatile(),
	comfyPorts: Schema.string().default("8000,8188,8189,8190,8191,8192").volatile(),
	comfyModelsDir: Schema.string().default(probeComfyModelsDir()).volatile(),
	runtimeDir: Schema.string().default(defaultRuntimeDir()).volatile(),
	modelsDir: Schema.string().default("").volatile(),
	modelRepo: Schema.string().default("circulus/Qwen-Image-2.1-bnb-4bit").volatile(),
	hfMirror: Schema.string().default("https://hf-mirror.com").volatile(),
	workerPorts: Schema.string().default("8399-8410").volatile(),
	workerStartTimeoutMs: Schema.number().default(3e5).volatile(),
	idleUnloadMs: Schema.number().default(6e5).volatile(),
	manageWorker: Schema.boolean().default(true).volatile(),
	pythonPath: Schema.string().default("").volatile(),
	workerScript: Schema.string().default(defaultWorkerScript()).volatile(),
	basePython: Schema.string().default(probeBasePython()).volatile(),
	torchWheels: Schema.string().default("").volatile(),
	pipIndexUrl: Schema.string().default("").volatile(),
	reuseBaseTorch: Schema.boolean().default(true).volatile(),
	minFreeVramMiB: Schema.number().default(5500).volatile(),
	freeComfyBeforeLocalStart: Schema.boolean().default(false).volatile(),
	allowLocalEditOverBudget: Schema.boolean().default(false).volatile(),
	localReferenceBudget: Schema.number().default(0).volatile(),
	skipLmHead: Schema.boolean().default(false).volatile(),
	defaultSteps: Schema.number().default(25).volatile(),
	comfyuiSteps: Schema.number().volatile(),
	localSteps: Schema.number().volatile()
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
	return resolveConfigFields(CONFIG_DEFAULTS, config);
}
/**
* Register the image tools and the routing skill.
*
* @param ctx - cordis context; `tools` and `skills` are injected above.
* @param config - the activation's config, volatile references included.
*/
function apply(ctx, config) {
	registerImageForgeTools(ctx, resolveConfig(config));
	registerImageForgeSkill(ctx);
}
//#endregion
export { Config, apply, inject, name };
