window.__ModuleLoader__.load({
	id: "dsh-image-forge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
//#region src/settings-fields.ts
/**
* Placeholder for the runtime directory inside a hint.
*
* Two fields (`modelsDir`, `pythonPath`) resolve *relative to* `runtimeDir`, and
* their values are deliberately left empty so they keep following it. The page
* still has to show the user where things will land, and it must show the
* **current** runtime directory rather than a baked one — so the hint carries
* this token and {@link resolveHint} substitutes the live value at render time.
*
* The indirection exists because this module is bundled for the browser: it
* cannot call `node:os` / `node:path` to compute a home directory, and a frozen
* absolute path written into the source would go stale the moment the user moves
* `runtimeDir`.
*/
const RUNTIME_DIR_TOKEN = "<运行时目录>";
/**
* Fill a hint's runtime-directory token from the live config.
*
* @param hint - the hint as authored, possibly containing {@link RUNTIME_DIR_TOKEN}.
* @param value - the config values currently shown, read for `runtimeDir`.
* @returns the hint with the token replaced, or the hint unchanged when the
*   snapshot carries no usable `runtimeDir` yet — an unresolved token is better
*   than a wrong path.
*/
function resolveHint(hint, value) {
	if (!hint.includes("<运行时目录>")) return hint;
	const runtimeDir = value?.["runtimeDir"];
	if (typeof runtimeDir !== "string" || runtimeDir.length === 0) return hint;
	return hint.split(RUNTIME_DIR_TOKEN).join(runtimeDir);
}
/** The blocks the page renders, in order. */
const SETTINGS_GROUPS = [
	{
		id: "backend",
		label: "后端选择",
		hint: "一次出图交给谁执行。"
	},
	{
		id: "steps",
		label: "步数（画质与耗时）",
		hint: "两个后端的步数口径不同。"
	},
	{
		id: "api",
		label: "云端 API",
		hint: "云端端点与密钥。"
	},
	{
		id: "local",
		label: "本地运行时",
		hint: "本机 worker：目录、端口、显存。"
	},
	{
		id: "comfyui",
		label: "ComfyUI",
		hint: "已装好的 ComfyUI 也能当后端。"
	},
	{
		id: "output",
		label: "输出与超时",
		hint: "图片落到哪里，等多久。"
	},
	{
		id: "python",
		label: "Python、依赖与权重（高级）",
		hint: "一般不用改；留空 = 自动。"
	}
];
/** Every configurable field, in page order. */
const SETTINGS_FIELDS = [
	{
		key: "backend",
		group: "backend",
		label: "后端",
		hint: "auto：有 key 就云端，否则 ComfyUI、worker。",
		kind: "enum",
		choices: [
			{
				value: "auto",
				label: "auto（自动选择）"
			},
			{
				value: "api",
				label: "api（云端 API）"
			},
			{
				value: "local",
				label: "local（本机 worker）"
			},
			{
				value: "comfyui",
				label: "comfyui（本机 ComfyUI）"
			}
		]
	},
	{
		key: "defaultSteps",
		group: "steps",
		label: "默认步数",
		hint: "两边都没指定时用它。25 = 官方 ComfyUI 模板口径。",
		kind: "number",
		min: 1,
		max: 200,
		unit: "步"
	},
	{
		key: "comfyuiSteps",
		group: "steps",
		label: "ComfyUI 专用步数",
		hint: "留空 = 用默认步数。官方模板就是 25，一般不用改。",
		kind: "number",
		min: 1,
		max: 200,
		unit: "步",
		nullable: true
	},
	{
		key: "localSteps",
		group: "steps",
		label: "本机 worker 专用步数",
		hint: "留空 = 用默认步数。8 = 快但不是官方口径；25 约慢 2.7 倍。",
		kind: "number",
		min: 1,
		max: 200,
		unit: "步",
		nullable: true
	},
	{
		key: "apiBaseUrl",
		group: "api",
		label: "API 地址",
		hint: "兼容 OpenAI 协议的端点根地址。",
		kind: "string",
		placeholder: "https://dashscope.aliyuncs.com/compatible-mode/v1"
	},
	{
		key: "apiKey",
		group: "api",
		label: "API Key",
		hint: "只写不读：已保存的密钥不会回显。本机环境变量优先于这里。",
		kind: "secret",
		placeholder: "留空表示不修改已保存的密钥"
	},
	{
		key: "apiModel",
		group: "api",
		label: "模型 ID",
		hint: "请求体里的 model 字段。",
		kind: "string",
		placeholder: "qwen-image"
	},
	{
		key: "apiStyle",
		group: "api",
		label: "协议风格",
		hint: "openai 已实现；dashscope 仅声明、v0.1 未实现。",
		kind: "enum",
		choices: [{
			value: "openai",
			label: "openai（已实现）"
		}, {
			value: "dashscope",
			label: "dashscope（未实现）"
		}]
	},
	{
		key: "runtimeDir",
		group: "local",
		label: "运行时目录",
		hint: "插件自有数据目录：venv、权重、worker 日志与断点。",
		kind: "path"
	},
	{
		key: "modelsDir",
		group: "local",
		label: "权重目录",
		hint: "留空 = 跟随运行时目录：<运行时目录>\\models\\qwen-image-2.1-bnb4bit。",
		kind: "path"
	},
	{
		key: "modelRepo",
		group: "local",
		label: "权重仓库",
		hint: "nf4 权重来自哪个 Hugging Face 仓库。",
		kind: "string",
		placeholder: "circulus/Qwen-Image-2.1-bnb-4bit"
	},
	{
		key: "hfMirror",
		group: "local",
		label: "下载镜像",
		hint: "别填 huggingface.co：它的 /api/ 在本机会超时。",
		kind: "string",
		placeholder: "https://hf-mirror.com"
	},
	{
		key: "localEndpoint",
		group: "local",
		label: "worker 地址",
		hint: "本地推理 worker 的根地址。",
		kind: "string",
		placeholder: "http://127.0.0.1:8399"
	},
	{
		key: "workerPorts",
		group: "local",
		label: "worker 候选端口",
		hint: "形如 8399-8410 或端口列表；localEndpoint 的端口优先。",
		kind: "string",
		placeholder: "8399-8410"
	},
	{
		key: "workerStartTimeoutMs",
		group: "local",
		label: "冷启动超时",
		hint: "worker 冷启动要加载约 10.6 GiB 权重，给足时间。",
		kind: "number",
		min: 1e3,
		max: 36e5,
		unit: "毫秒"
	},
	{
		key: "idleUnloadMs",
		group: "local",
		label: "空闲卸载",
		hint: "空闲超过这么久就把显存还给系统；0 表示不卸载。",
		kind: "number",
		min: 0,
		max: 864e5,
		unit: "毫秒"
	},
	{
		key: "manageWorker",
		group: "local",
		label: "由插件管理 worker 进程",
		hint: "关闭后插件只连不管，需要你自己把 worker 起起来。",
		kind: "boolean"
	},
	{
		key: "minFreeVramMiB",
		group: "local",
		label: "显存下限",
		hint: "低于它不再拉起 worker（加载期门禁，不是编辑尺寸门）。",
		kind: "number",
		min: 0,
		max: 262144,
		unit: "MiB"
	},
	{
		key: "freeComfyBeforeLocalStart",
		group: "local",
		label: "起本地 worker 前先卸载 ComfyUI 模型",
		hint: "8GB 卡上通常是必需项；开启后先卸载 ComfyUI 模型。",
		kind: "boolean"
	},
	{
		key: "allowLocalEditOverBudget",
		group: "local",
		label: "允许超预算本地编辑",
		hint: "默认拒绝超尺寸门的本地编辑；开启=放行并自负风险。",
		kind: "boolean"
	},
	{
		key: "localReferenceBudget",
		group: "local",
		label: "参考图条件化预算",
		hint: "0=按画布推导；调低=降参考图分辨率；896/512 同画布目视无差（n=1）。",
		kind: "number",
		min: 0,
		max: 4096,
		unit: "像素/边"
	},
	{
		key: "comfyEndpoint",
		group: "comfyui",
		label: "ComfyUI 地址",
		hint: "留空 = 依次探 8000/8188/8189/8190/8191/8192。",
		kind: "string",
		placeholder: "http://127.0.0.1:8188"
	},
	{
		key: "comfyPorts",
		group: "comfyui",
		label: "ComfyUI 候选端口",
		hint: "comfyEndpoint 留空时按顺序探测这些端口。",
		kind: "string",
		placeholder: "8000,8188,8189,8190,8191,8192"
	},
	{
		key: "comfyModelsDir",
		group: "comfyui",
		label: "ComfyUI 模型目录",
		hint: "只用来把「把文件放到 …」这类报错写具体；留空则报错保持通用。",
		kind: "path"
	},
	{
		key: "outputDir",
		group: "output",
		label: "出图目录",
		hint: "生成的 PNG 写到哪个目录。",
		kind: "path"
	},
	{
		key: "timeoutMs",
		group: "output",
		label: "单次调用超时",
		hint: "一次出图的协作式预算，超时后放弃等待。",
		kind: "number",
		min: 1e3,
		max: 36e5,
		unit: "毫秒"
	},
	{
		key: "pythonPath",
		group: "python",
		label: "解释器路径",
		hint: "留空 = 跟随运行时目录：<运行时目录>\\venv\\Scripts\\python.exe。",
		kind: "path"
	},
	{
		key: "workerScript",
		group: "python",
		label: "worker 脚本",
		hint: "留空使用插件自带的 resources/worker.py。",
		kind: "path"
	},
	{
		key: "basePython",
		group: "python",
		label: "基础解释器",
		hint: "建 venv 用它；留空 = 试 python/python3/py。",
		kind: "path"
	},
	{
		key: "torchWheels",
		group: "python",
		label: "CUDA wheel 标签",
		hint: "留空 = 依次试 cu128、cu126、cu118。",
		kind: "string",
		placeholder: "cu128,cu126,cu118"
	},
	{
		key: "pipIndexUrl",
		group: "python",
		label: "pip 索引地址",
		hint: "留空 = https://pypi.org/simple。",
		kind: "string",
		placeholder: "https://pypi.org/simple"
	},
	{
		key: "reuseBaseTorch",
		group: "python",
		label: "复用基础解释器里的 CUDA torch",
		hint: "开启后不再下载一份 torch。",
		kind: "boolean"
	},
	{
		key: "skipLmHead",
		group: "python",
		label: "fetch-weights 跳过 lm_head.weight",
		hint: "默认值：丢掉用不到的那个张量，省下载量。",
		kind: "boolean"
	}
];
SETTINGS_FIELDS.map((field) => field.key);
/** The replacement shown wherever a secret's plaintext would otherwise go. */
const SECRET_MASK = "••••••••";
/**
* Look one field up.
*
* @param key - the config key.
* @returns the field, or undefined when the page has no control for it.
*/
function fieldByKey(key) {
	return SETTINGS_FIELDS.find((field) => field.key === key);
}
/**
* Bucket the fields under their groups, keeping page order.
*
* @returns one entry per {@link SETTINGS_GROUPS} entry, in order.
*/
function groupedFields() {
	return SETTINGS_GROUPS.map((group) => ({
		group,
		fields: SETTINGS_FIELDS.filter((field) => field.group === group.id)
	}));
}
/**
* Whether one config key is a secret that must never be rendered verbatim.
*
* @param key - the config key.
* @returns true when the field is `kind: 'secret'`.
*/
function isSecretField(key) {
	return fieldByKey(key)?.kind === "secret";
}
/**
* The text a control may show for a stored value.
*
* A secret is masked unconditionally: the page never renders plaintext, even
* when the value reaching it happens to be unredacted.
*
* @param key - the config key.
* @param value - the value read from the settings snapshot.
* @returns the display string, safe to put in the DOM.
*/
function displayValue(key, value) {
	if (isSecretField(key)) return value === void 0 || value === null || value === "" ? "" : SECRET_MASK;
	if (typeof value === "boolean") return value ? "开" : "关";
	if (value === void 0 || value === null) return "";
	return String(value);
}
/**
* The backend performance conclusion, as the page states it.
*
* Every number is measured on this machine. The tables behind them, the per-step
* slopes, the kernel profile and the exclusions are in README.md (the 设置页
* section), and test/settings.test.mjs pins both sides: that the page stays
* within budget, and that the README still carries the evidence.
*/
const BACKEND_PERF_ADVISORY = {
	id: "backend-perf",
	title: "8 GB 显存上做参考图编辑，请优先用 comfyui 后端",
	paragraphs: ["实测 1312×736 / 6 步：comfyui ≈ 19–23 s，本机 worker ≈ 219 s（纯管线）。", "文生图每步约 2.77×，但两侧量化档不同，不是纯后端差异；依据见 README。"],
	placedAfterGroup: "backend"
};
/**
* The advisory rendered directly after one group, if any.
*
* @param group - the group id.
* @returns the advisory placed after it, or undefined.
*/
function advisoryAfterGroup(group) {
	return BACKEND_PERF_ADVISORY.placedAfterGroup === group ? BACKEND_PERF_ADVISORY : void 0;
}
//#endregion
//#region src/settings-section.ts
/**
* The `dsh-image-forge` first-level settings section: registration shape and
* save semantics, as pure logic.
*
* Kept free of React and of any DSH client import so the whole contract can be
* asserted against fakes. The DSH client packages
* (`@deepseek-ai/dsh-client-ui-settings/client`) are provided by the Host and
* are not dependencies of this package, so the shapes this module consumes are
* restated structurally rather than imported — the same choice the reference
* implementation makes for the binder input shape it cannot import either.
*
* ## Why a settings section at all
*
* Under the DSH 0.2.0 settings model the Host derives one settings page per
* profile entry from the plugin's own `Config` schema, and serves it only when
* at least one field is `volatile()`. That page is addressed by **profile entry
* id**. The browser half addresses it through the shared configuration-forms
* service (`ctx.configForms`): `describe()` mirrors the served namespaces and
* `get(entryId)` hands back that entry's form.
*
* The entry id is the one thing the plugin cannot know for certain — this row's
* id comes from the profile patch — so {@link createResolvedEntryForm} starts on
* the most likely id and rebinds the moment the describe mirror names one of
* ours, which is the reference implementation's own robust path.
*/
/** The list slot a first-level settings menu item registers into. */
const SETTINGS_SECTION_NAME = "settings.section";
/** This section's id inside that slot. A list slot addresses its seats by `id`. */
const SETTINGS_SECTION_ID = "dsh-image-forge";
/**
* Profile entry ids this package's row may carry, most likely first.
*
* `dsh-image-forge` is both the package name and the row id in this package's
* own `cordis.yml`, which is the id a standalone `dsh plugin add <dir>` install
* registers.
*/
const SETTINGS_ENTRY_IDS = ["dsh-image-forge"];
/** The menu label. A function, because the slot contract renders it lazily. */
const SETTINGS_SECTION_LABEL = "Qwen 出图";
/**
* The seat descriptor for this section.
*
* @param props - the props factory the slot calls when it mounts the component.
* @returns the descriptor passed to `slots.register`.
*/
function settingsSectionOptions(props) {
	return {
		name: SETTINGS_SECTION_NAME,
		id: SETTINGS_SECTION_ID,
		order: 160,
		label: () => SETTINGS_SECTION_LABEL,
		inject: props
	};
}
/**
* Reach the shared configuration-forms service, if this page serves one.
*
* @param ctx - the client context.
* @returns the service, or undefined when the page serves no such service.
*/
function reachConfigForms(ctx) {
	if (typeof ctx.get !== "function") return void 0;
	let candidate;
	try {
		candidate = ctx.get("configForms");
	} catch {
		return;
	}
	if (typeof candidate !== "object" || candidate === null) return void 0;
	const forms = candidate;
	return typeof forms.describe === "function" && typeof forms.get === "function" ? candidate : void 0;
}
/**
* Register the first-level settings section.
*
* A failure here is contained: the tool card is the plugin's older, load-bearing
* half, and a settings seat that cannot be created must not cost the user that
* card. The registration is therefore attempted inside the `inject` body and a
* throw becomes a no-op disposer.
*
* @param ctx - the client context.
* @param component - the section component.
* @returns a disposer that unregisters the seat, when one was created.
*/
function registerSettingsSection(ctx, component) {
	if (typeof ctx.slots?.inject !== "function" || typeof ctx.slots?.register !== "function") return () => {};
	const form = createResolvedEntryForm({
		forms: reachConfigForms(ctx),
		entryIds: SETTINGS_ENTRY_IDS
	});
	const props = () => {
		if (form === void 0) return {
			form: void 0,
			unavailableReason: "当前页面没有提供配置表单服务（ctx.configForms），本分区无法读写配置。"
		};
		return { form };
	};
	ctx.slots.inject(SETTINGS_SECTION_NAME, () => {
		try {
			const unregister = ctx.slots.register(settingsSectionOptions(props), component);
			return () => {
				try {
					if (typeof unregister === "function") unregister();
				} catch {}
			};
		} catch {
			return () => {};
		}
	});
	return () => {};
}
/** The snapshot a form reports before the Host has answered for this entry. */
function pendingSnapshot() {
	return {
		status: "loading",
		value: void 0,
		revision: void 0,
		writable: false,
		mode: "host"
	};
}
/**
* Bind a form to the profile entry id this Host actually serves.
*
* The describe mirror is the only local evidence of which row id is served, and
* it answers asynchronously — at activation it usually holds nothing yet. So the
* binding starts on the most likely candidate and is redone the moment the
* mirror names one of ours; an unanswered mirror is not evidence of absence and
* keeps the current binding.
*
* @param options - the forms service (or undefined) and this package's candidate row ids.
* @returns the bound form, or undefined when no forms service is reachable.
*/
function createResolvedEntryForm(options) {
	const { forms, entryIds } = options;
	if (forms === void 0 || entryIds.length === 0) return void 0;
	const fallbackId = entryIds[0];
	const namespaceId = entryIds[entryIds.length - 1];
	const listeners = /* @__PURE__ */ new Set();
	let boundId;
	let bound;
	let offBound;
	let snapshot = pendingSnapshot();
	/** Republish: the delegated snapshot when one is bound, the pending one otherwise. */
	const publish = () => {
		if (bound !== void 0) try {
			snapshot = bound.getSnapshot();
		} catch {}
		for (const listener of [...listeners]) listener();
	};
	/** The entry id the mirror currently justifies. */
	const resolve = () => {
		let served;
		try {
			served = forms.describe().getSnapshot().view?.namespaces?.map((row) => String(row.ns));
		} catch {
			served = void 0;
		}
		if (served === void 0 || served.length === 0) return fallbackId;
		return entryIds.find((id) => served.includes(id)) ?? namespaceId;
	};
	/** Bind (or rebind) the resolved entry's form; a no-op while it is unchanged. */
	const bind = () => {
		const target = resolve();
		if (target === boundId && bound !== void 0) return boundId;
		if (offBound !== void 0) {
			try {
				offBound();
			} catch {}
			offBound = void 0;
		}
		let form;
		try {
			form = forms.get(target);
		} catch {
			boundId = void 0;
			bound = void 0;
			return;
		}
		boundId = target;
		bound = form;
		try {
			offBound = form.subscribe(() => {
				publish();
			});
		} catch {
			offBound = void 0;
		}
		publish();
		return boundId;
	};
	try {
		forms.describe().subscribe?.(() => {
			bind();
		});
	} catch {}
	bind();
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set: (field, value) => bound?.set(field, value) ?? Promise.resolve(false),
		unset: (field) => bound?.unset(field) ?? Promise.resolve(false),
		...bound?.mutate === void 0 ? {} : { mutate: (ops, revision) => bound?.mutate?.(ops, revision) ?? Promise.resolve(false) },
		boundEntryId: () => boundId,
		rebind: () => bind()
	};
}
/** A human label for a config key, for messages that must not carry values. */
function keyLabel(key) {
	return key;
}
/** Read a form's snapshot without letting a throwing form take the caller down. */
function readSnapshot(form) {
	try {
		return form.getSnapshot();
	} catch {
		return;
	}
}
/** Normalize a thrown value into a message that carries no field value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Write one field, revision-aware.
*
* `set`/`unset` is the write primitive because it is the shape the Host's
* shared-form contract actually exposes and the shape the reference
* implementation uses; the Host owns the revision fence on the far side. The
* revision is still read **before** the write and compared against the snapshot
* that follows, because that is what tells a genuine refusal apart from the far
* more common "somebody else wrote first": on a conflict the caller re-reads
* (the form's subscription has already pushed the fresh snapshot) instead of
* re-issuing its stale value over the other edit.
*
* Nothing here is swallowed: every path returns an outcome, and a refusal is
* reported rather than rendered as applied.
*
* @param form - the bound form.
* @param key - the config key.
* @param value - the new value; `undefined` clears the field back to its default.
* @returns the outcome, with the revisions involved when it failed.
*/
async function saveField(form, key, value) {
	const before = readSnapshot(form);
	const expectedRevision = before?.revision;
	if (before?.writable === false) return {
		ok: false,
		reason: "unwritable",
		message: `配置项 ${keyLabel(key)} 当前不可写（该配置条目为只读）。`,
		expectedRevision
	};
	let answer;
	try {
		answer = value === void 0 ? form.unset(key) : form.set(key, value);
	} catch (error) {
		return {
			ok: false,
			reason: "error",
			message: messageOf(error),
			expectedRevision
		};
	}
	let accepted;
	try {
		accepted = await answer;
	} catch (error) {
		return {
			ok: false,
			reason: "error",
			message: messageOf(error),
			expectedRevision
		};
	}
	const observedRevision = readSnapshot(form)?.revision;
	if (accepted === false) {
		if (expectedRevision !== void 0 && observedRevision !== void 0 && observedRevision !== expectedRevision) return {
			ok: false,
			reason: "conflict",
			message: `配置项 ${keyLabel(key)} 未能保存：该配置在别处已被修改（revision ${expectedRevision} → ${observedRevision}），已重新读取，请核对后重试。`,
			expectedRevision,
			observedRevision
		};
		return {
			ok: false,
			reason: "refused",
			message: `配置项 ${keyLabel(key)} 未能保存：宿主拒绝了这次写入。`,
			expectedRevision,
			observedRevision
		};
	}
	return observedRevision === void 0 ? { ok: true } : {
		ok: true,
		revision: observedRevision
	};
}
//#endregion
//#region src/client.ts
/**
* Client half: the `qwen_image_generate` keyed tool view **and** the
* `dsh-image-forge` first-level settings section.
*
* ## The tool view
*
* `tool.call.toolview` is a **keyed** slot, and the key must be the tool's wire
* name (`qwen_image_generate`) for the card to own that call's row — a
* mismatched key silently registers a view nothing ever dispatches to.
*
* Scope note: this entry only adds a row that shows progress and, once the
* result carries absolute paths, renders the images inline through the
* session-authorized `loadImage` loader the row receives. The primary display
* path stays the Markdown `![](absolute path)` lines the Host returns in the
* tool result — if this card cannot render for any reason it renders nothing
* and the conversation still shows the images. Everything here is defensive for
* exactly that reason.
*
* ## The settings section
*
* `settings.section` is a **list** slot (seated by `id`), and a seat there is a
* first-level entry in the DSH settings page. The page the section renders is
* bound to the Host's own shared config form for this plugin's profile entry —
* see `./settings-section.ts` for the binding and save semantics. All the logic
* lives there, react-free and service-free, so it can be tested; this file is
* the React layer on top of it.
*
* Nothing here reaches for a service at activation time: `configForms` is looked
* up optionally, and a page that serves none gets a notice in the section rather
* than losing the plugin's client half (and with it the tool card).
*/
/**
* Client services required before `apply` runs.
*
* These are **cordis service names**, a different layer from `package.json`'s
* `dsh.client.inject` (which takes client **module package names**). The two must
* not be conflated: `slots` is correct here and would be a load failure there.
*
* `configForms` is declared because the settings section binds the Host's native
* form for this entry through it, and every reference plugin that seats a
* settings section declares it too. It is still read through `ctx.get`, so a page
* that serves no such service gets the section's "unavailable" notice rather than
* a crash.
*/
const inject = ["slots", "configForms"];
/** Pull `images[].path` out of the tool's canonical payload, tolerantly. */
function imagePaths(props) {
	const value = props.result?.value;
	if (typeof value !== "object" || value === null) return [];
	const images = value.images;
	if (!Array.isArray(images)) return [];
	return images.map((entry) => typeof entry === "object" && entry !== null ? entry.path : void 0).filter((path) => typeof path === "string" && path.length > 0);
}
/** One-line status text for the current lifecycle phase. */
function statusText(props) {
	const phase = props.phase ?? "start";
	if (phase === "preparing") return "准备出图参数…";
	if (phase === "result") {
		const count = imagePaths(props).length;
		return count > 0 ? `出图完成：${count} 张` : "出图结束（未落盘，请看工具结果）";
	}
	return "正在出图（云端 API 或本地 worker）…";
}
/**
* The tool row itself.
*
* @param props - owner props supplied by ui-tool's dispatch.
* @returns a small card: a status line plus any images the loader accepts.
*/
function QwenImageGenerateRow(props) {
	try {
		const children = [(0, react.createElement)("span", { key: "status" }, statusText(props))];
		const paths = imagePaths(props);
		if (paths.length > 0 && typeof props.loadImage === "function") paths.forEach((path, index) => {
			children.push((0, react.createElement)("img", {
				key: `image-${index}`,
				src: props.loadImage?.(path),
				alt: path
			}));
		});
		return (0, react.createElement)("div", { className: "dsh-image-forge-row" }, children);
	} catch {
		return null;
	}
}
/**
* Track one control's draft, its save state, and commit through `write`.
*
* @param props - the field, its stored value, and the write callback.
* @returns the control's markup.
*/
function FieldRow(props) {
	const { field, value, disabled, write } = props;
	const [draft, setDraft] = (0, react.useState)(null);
	const [failure, setFailure] = (0, react.useState)(void 0);
	const [saved, setSaved] = (0, react.useState)(false);
	const commit = (next) => {
		setFailure(void 0);
		let answer;
		try {
			answer = write(field.key, next);
		} catch (error) {
			setFailure(error instanceof Error ? error.message : String(error));
			return;
		}
		Promise.resolve(answer).then((result) => {
			if (result.ok) {
				setSaved(true);
				setFailure(void 0);
				return;
			}
			setSaved(false);
			setFailure(result.message ?? "保存失败");
		}, (error) => {
			setSaved(false);
			setFailure(error instanceof Error ? error.message : String(error));
		});
	};
	const control = buildControl(field, value, disabled, draft, setDraft, commit);
	const status = [];
	if (failure !== void 0) status.push((0, react.createElement)("span", {
		key: "failure",
		className: "dsh-image-forge-setting-failure",
		role: "status"
	}, `保存失败：${failure}`));
	else if (saved) status.push((0, react.createElement)("span", {
		key: "saved",
		className: "dsh-image-forge-setting-saved",
		role: "status"
	}, "已保存"));
	if (isSecretField(field.key)) status.push((0, react.createElement)("span", {
		key: "stored",
		className: "dsh-image-forge-setting-stored"
	}, displayValue(field.key, value) === "" ? "未设置" : `已设置 ${SECRET_MASK}`));
	return (0, react.createElement)("div", { className: "dsh-image-forge-setting" }, [
		(0, react.createElement)("label", {
			key: "label",
			className: "dsh-image-forge-setting-label"
		}, field.label),
		(0, react.createElement)("div", {
			key: "control",
			className: "dsh-image-forge-setting-control"
		}, control),
		(0, react.createElement)("p", {
			key: "hint",
			className: "dsh-image-forge-setting-hint"
		}, resolveHint(field.hint, value)),
		(0, react.createElement)("div", {
			key: "status",
			className: "dsh-image-forge-setting-status"
		}, status)
	]);
}
/**
* Render the control a field's kind calls for.
*
* @param field - the field.
* @param value - the stored value.
* @param disabled - whether the entry is writable.
* @param draft - the local text draft, when the user has typed.
* @param setDraft - draft setter.
* @param commit - write callback.
* @returns the control element.
*/
function buildControl(field, value, disabled, draft, setDraft, commit) {
	field.key;
	if (field.kind === "boolean") return (0, react.createElement)("input", {
		type: "checkbox",
		checked: value === true,
		disabled,
		onChange: (event) => {
			commit(event.target.checked);
		}
	});
	if (field.kind === "enum") {
		const choices = field.choices ?? [];
		return (0, react.createElement)("select", {
			value: typeof value === "string" ? value : "",
			disabled,
			onChange: (event) => {
				commit(event.target.value);
			}
		}, choices.map((choice) => (0, react.createElement)("option", {
			key: choice.value,
			value: choice.value
		}, choice.label)));
	}
	if (field.kind === "number") return (0, react.createElement)("input", {
		type: "number",
		...field.min === void 0 ? {} : { min: field.min },
		...field.max === void 0 ? {} : { max: field.max },
		value: draft ?? (value === void 0 || value === null ? "" : String(value)),
		disabled,
		placeholder: field.nullable === true ? "留空 = 用默认步数" : void 0,
		onChange: (event) => {
			setDraft(event.target.value);
		},
		onBlur: () => {
			if (draft === null) return;
			if (draft.trim() === "") {
				if (field.nullable === true) commit(void 0);
				setDraft(null);
				return;
			}
			const parsed = Number(draft);
			if (!Number.isFinite(parsed)) {
				setDraft(null);
				return;
			}
			if (field.min !== void 0 && parsed < field.min || field.max !== void 0 && parsed > field.max) return;
			commit(parsed);
			setDraft(null);
		}
	});
	const secret = field.kind === "secret";
	const storedPresent = secret && typeof value === "string" && value.length > 0;
	return (0, react.createElement)("input", {
		type: secret ? "password" : "text",
		value: draft ?? (secret ? "" : typeof value === "string" ? value : ""),
		disabled,
		placeholder: storedPresent ? "已保存（留空表示不修改）" : field.placeholder ?? "",
		autoComplete: secret ? "off" : void 0,
		onChange: (event) => {
			setDraft(event.target.value);
		},
		onBlur: () => {
			if (draft === null) return;
			if (secret && draft === "") {
				setDraft(null);
				return;
			}
			commit(draft);
			setDraft(null);
		}
	});
}
/**
* One titled block of fields.
*
* @param props - the group and its fields.
* @returns the block.
*/
function GroupBlock(props) {
	const { group, fields, value, disabled, write } = props;
	return (0, react.createElement)("section", {
		className: "dsh-image-forge-settings-group",
		key: group.id
	}, [
		(0, react.createElement)("h3", {
			key: "title",
			className: "dsh-image-forge-settings-group-title"
		}, group.label),
		(0, react.createElement)("p", {
			key: "hint",
			className: "dsh-image-forge-settings-group-hint"
		}, group.hint),
		(0, react.createElement)("div", {
			key: "fields",
			className: "dsh-image-forge-settings-fields"
		}, fields.map((field) => (0, react.createElement)(FieldRow, {
			key: field.key,
			field,
			value: value[field.key],
			disabled,
			write
		})))
	]);
}
/**
* The backend performance advisory block.
*
* Two lines, on purpose: the page states the actionable conclusion and the one
* caveat, and the evidence behind them lives in the README. The strings render as
* text nodes, so none of them may carry markdown markers (asserted in the tests),
* and the block's size is held by a text-budget test.
*
* @param props - the advisory.
* @returns the block.
*/
function AdvisoryBlock(props) {
	const { advisory } = props;
	return (0, react.createElement)("section", {
		className: "dsh-image-forge-advisory",
		"data-dsh-part": advisory.id
	}, [(0, react.createElement)("h3", {
		key: "title",
		className: "dsh-image-forge-advisory-title"
	}, advisory.title), ...advisory.paragraphs.map((text, index) => (0, react.createElement)("p", {
		key: `p-${index}`,
		className: "dsh-image-forge-advisory-p"
	}, text))]);
}
/**
* The settings section component.
*
* @param props - supplied by the slot's `inject`: the bound form, or the reason
*   there is none.
* @returns the section, or a notice explaining why it cannot render.
*/
function QwenImageSettingsSection(props) {
	const form = props.form;
	const [tick, setTick] = (0, react.useState)(0);
	(0, react.useEffect)(() => {
		if (form === void 0) return void 0;
		let off;
		try {
			off = form.subscribe(() => {
				setTick((count) => count + 1);
			});
		} catch {
			off = void 0;
		}
		return () => {
			try {
				off?.();
			} catch {}
		};
	}, [form]);
	if (form === void 0) return (0, react.createElement)("div", { className: "dsh-image-forge-settings-notice" }, props.unavailableReason ?? "配置表单不可用。");
	let snapshot;
	try {
		snapshot = form.getSnapshot();
	} catch {
		snapshot = void 0;
	}
	if (snapshot === void 0 || snapshot.status !== "ready" || typeof snapshot.value !== "object" || snapshot.value === null) return (0, react.createElement)("div", {
		className: "dsh-image-forge-settings-notice",
		"data-dsh-tick": tick
	}, `正在读取本插件配置…（状态：${snapshot?.status ?? "unknown"}）`);
	const value = snapshot.value;
	const disabled = snapshot.writable === false;
	const write = (key, next) => saveField(form, key, next).then((outcome) => outcome.ok ? { ok: true } : {
		ok: false,
		message: outcome.message
	}, (error) => ({
		ok: false,
		message: error instanceof Error ? error.message : String(error)
	}));
	return (0, react.createElement)("div", { className: "dsh-image-forge-settings" }, [(0, react.createElement)("p", {
		key: "lead",
		className: "dsh-image-forge-settings-lead"
	}, disabled ? "当前配置条目为只读，无法保存修改。" : "改动会立即写入本插件的配置。"), ...groupedFields().flatMap(({ group, fields }) => {
		const block = (0, react.createElement)(GroupBlock, {
			key: group.id,
			group,
			fields,
			value,
			disabled,
			write
		});
		const advisory = advisoryAfterGroup(group.id);
		return advisory === void 0 ? [block] : [block, (0, react.createElement)(AdvisoryBlock, {
			key: advisory.id,
			advisory
		})];
	})]);
}
/**
* Register the keyed tool view and the first-level settings section.
*
* @param ctx - cordis client context providing `slots`, and optionally `get`.
*/
function apply(ctx) {
	ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
		name: "tool.call.toolview",
		key: "qwen_image_generate"
	}, QwenImageGenerateRow));
	registerSettingsSection(ctx, QwenImageSettingsSection);
}
//#endregion
exports.apply = apply;
exports.inject = inject;

		return module.exports;
	}
});
