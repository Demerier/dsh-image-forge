import Schema from "@deepseek-ai/schemastery";
import { constants, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
/** Shape version of one board file; a mismatched file is ignored, not migrated. */
const BOARD_VERSION = 1;
/** Columns, pitch and origin of the grid an unplaced item lands on. */
const GRID_COLUMNS = 3;
const GRID_PITCH_X = 244;
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
	if (typeof parsed !== "object" || parsed === null) return void 0;
	const record = parsed;
	if (record.version !== BOARD_VERSION) return void 0;
	if (typeof record.id !== "string" || typeof record.name !== "string") return void 0;
	if (!Array.isArray(record.items)) return void 0;
	return {
		version: BOARD_VERSION,
		id: record.id,
		name: record.name,
		createdAt: typeof record.createdAt === "string" ? record.createdAt : (/* @__PURE__ */ new Date(0)).toISOString(),
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : (/* @__PURE__ */ new Date(0)).toISOString(),
		sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
		camera: isCamera(record.camera) ? record.camera : null,
		items: record.items.filter(isBoardItem)
	};
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
/** Loose validation on read: one bad item must not hide the rest of the board. */
function isBoardItem(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	return typeof item.id === "string" && typeof item.path === "string" && typeof item.markdownPath === "string";
}
/** Summary projection, so a list request never carries every prompt. */
function summarize(board) {
	const newest = board.items[board.items.length - 1];
	return {
		id: board.id,
		name: board.name,
		itemCount: board.items.length,
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
	const id = newBoardId((candidate) => existing.some((board) => board.id === candidate));
	const board = {
		version: BOARD_VERSION,
		id,
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
	const normalize = (value) => value.replace(/\\/g, "/").toLowerCase();
	const byPath = new Map(existing.map((item) => [normalize(item.path), item.id]));
	const ids = [];
	for (const path of paths) {
		const id = byPath.get(normalize(path));
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
		}
		if (layout.camera !== void 0) board.camera = isCamera(layout.camera) ? layout.camera : null;
		board.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		await saveBoard(outputDir, board);
		return summarize(board);
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
* @param options - `deleteFile` also removes the PNG from disk.
* @returns what happened, or `undefined` when the board or item is gone.
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
		if (options.deleteFile === true && isInside(outputDir, removed.path)) try {
			await unlink(removed.path);
			fileDeleted = true;
		} catch {
			fileDeleted = false;
		}
		return {
			removed,
			fileDeleted
		};
	});
}
/**
* Delete a board's metadata. The images stay on disk.
*
* @param outputDir - the configured output directory.
* @param id - board id.
* @returns whether a board file was removed.
*/
async function deleteBoard(outputDir, id) {
	return serialized(boardsRoot(outputDir), async () => {
		try {
			await unlink(boardFile(outputDir, id));
			return true;
		} catch {
			return false;
		}
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
//#endregion
//#region src/images.ts
/** Sniff the image container from its magic bytes. */
function sniffImageMime(bytes) {
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (bytes.length >= 12 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
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
		timeoutMs
	};
}
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
	throw new Error(`comfyui backend: 没找到在跑的 ComfyUI（已探测 ${probed.length} 个端口）：\n${tried}\n  启动 ComfyUI（桌面版/便携版都可以）后重试；如果它监听在别的端口，把该端口写进 comfyPorts 或直接写 comfyEndpoint。
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
	const separator = process.platform === "win32" ? "\\" : "/";
	if (modelsDir.trim().length > 0) return `${modelsDir.trim().replace(/[\\/]+$/, "")}${separator}${folder}${separator}`;
	return `ComfyUI 的 models${separator}${folder}${separator} 目录（桌面版/便携版的模型路径见 ComfyUI 设置或 extra_model_paths.yaml）`;
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
* The sigma schedule the Turbo checkpoint was distilled for.
*
* This is copied verbatim from the official `image_qwen_image_2_1_turbo_t2i.json`
* template's `ManualSigmas` node, and it is what makes 8 steps enough. Raising
* the step count **without** swapping this schedule in makes the result worse,
* not better: the template's own note says so, and that is why the turbo path
* passes the schedule rather than only a smaller `steps`.
*/
const TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0";
/**
* The Turbo text-to-image graph, in ComfyUI's API format.
*
* The Turbo templates do **not** use `KSampler`. They drive
* `SamplerCustomAdvanced`, which takes the noise, guider, sampler and sigmas as
* separate inputs — that separation is the only way to hand it a `ManualSigmas`
* node, and the manual schedule is the whole point of the turbo checkpoint. So
* this graph has a different shape from {@link QWEN_IMAGE_WORKFLOW}, not just
* different numbers:
*
* ```
* RandomNoise ─┐
* CFGGuider ───┼→ SamplerCustomAdvanced → VAEDecode → SaveImage
* KSamplerSelect┤
* ManualSigmas ─┤
* EmptyLatentImage ─┘
* ```
*
* Note also what is *absent*: the non-turbo graph's `QwenImage21Cache` is not
* used here either, matching the official template, which leaves it out for the
* turbo path.
*/
const QWEN_IMAGE_TURBO_WORKFLOW = {
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
		class_type: "RandomNoise",
		inputs: { noise_seed: "{{seed}}" }
	},
	"7": {
		class_type: "CFGGuider",
		inputs: {
			model: ["1", 0],
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
* `cfg` is **1**, the same as the turbo t2i graph. The official turbo edit
* template's JSON shows a stale `[8]` widget on `CFGGuider`, but that value is
* dead: the node's cfg is wired to the template's outer input, and the outer
* default — per docs.comfy.org, the Comfy-Org model card and the Turbo model
* card — is 1. At cfg 1 ComfyUI skips the negative conditioning pass entirely,
* so an elevated cfg with an empty negative prompt does not sharpen the edit;
* it degrades it.
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
* Wire one `LoadImage` per reference into the turbo edit graph.
*
* Same autogrow contract as {@link editWorkflow} — the encode node takes
* `images.image_1` … `images.image_16` — but against the turbo skeleton.
*
* @param imageNames - file names inside ComfyUI's `input` folder, in prompt order.
* @returns a fresh API-format graph with one loader per reference.
* @throws When the list is empty or longer than {@link EDIT_MAX_REFERENCES}.
*/
function editTurboWorkflow(imageNames) {
	if (imageNames.length === 0) throw new Error("comfyui backend: the edit graph needs at least one reference image");
	if (imageNames.length > 10) throw new Error(`comfyui backend: the edit graph wires 10 reference slots, got ${imageNames.length}`);
	const graph = { ...QWEN_IMAGE_TURBO_EDIT_WORKFLOW };
	const encode = {
		class_type: "TextEncodeQwenImage21",
		inputs: { ...QWEN_IMAGE_TURBO_EDIT_WORKFLOW["4"].inputs }
	};
	graph["4"] = encode;
	for (const [position, name] of imageNames.entries()) {
		const id = String(13 + position);
		graph[id] = {
			class_type: "LoadImage",
			inputs: { image: name }
		};
		encode.inputs[`images.image_${position + 1}`] = [id, 0];
	}
	return graph;
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
function referenceBudget(width, height) {
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
		resolution: referenceBudget(request.width, request.height),
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
* Run one Turbo text-to-image generation.
*
* Differs from {@link generateViaComfyUi} in exactly two ways, both of which the
* official turbo template prescribes: the step count defaults to
* {@link TURBO_STEPS} (not 25) and the graph is driven by the manual sigma
* schedule (not `KSampler`). A caller that passes an explicit `steps` gets it —
* the override exists so the blind test can ask for 4, 8 and 12 and see what
* actually happens, rather than trusting the "8 is enough" note.
*
* @param target - the endpoint that answered.
* @param models - the three file names read from `/object_info`.
* @param request - prompt, canvas, count, seed, optional step override.
* @param options - timeout and poll interval.
* @param signal - caller cancellation.
* @returns one entry per produced image, in ComfyUI's order.
* @throws With the adapter's usual quoted-upstream text when the run fails.
*/
async function generateViaComfyUiTurbo(target, models, request, options, signal) {
	return await runGraph(target, renderWorkflow(QWEN_IMAGE_TURBO_WORKFLOW, {
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
		steps: request.steps ?? 8,
		cfg: 1,
		sampler_name: "euler",
		scheduler: "simple",
		sigmas: TURBO_SIGMAS,
		filename_prefix: "dsh-image-forge-turbo"
	}), "出图（turbo）", options, signal);
}
/**
* Run one Turbo reference-image edit.
*
* As with the base edit path, references are uploaded first and wired in as
* `LoadImage` nodes. The turbo-specific values are the step default
* ({@link TURBO_STEPS}) and the manual sigma schedule; `cfg` stays 1, as in
* every official Qwen-Image 2.1 template.
*
* @param target - the endpoint that answered.
* @param models - the three file names read from `/object_info`.
* @param request - edit prompt, canvas, and at least one reference image.
* @param options - timeout and poll interval.
* @param signal - caller cancellation.
* @returns one entry per produced image, in ComfyUI's order.
* @throws When no reference is present, an upload fails, or the run fails.
*/
async function generateViaComfyUiTurboEdit(target, models, request, options, signal) {
	const references = request.images ?? [];
	if (references.length === 0) throw new Error("comfyui backend: the edit path needs reference images, but request.images is empty");
	const deadline = Date.now() + options.timeoutMs;
	const names = [];
	for (const reference of references) names.push(await uploadReferenceImage(target, reference, Math.max(1, deadline - Date.now()), signal));
	return await runGraph(target, renderWorkflow(editTurboWorkflow(names), {
		unet_name: models.unet,
		weight_dtype: "default",
		clip_name: models.clip,
		clip_type: models.clipType,
		vae_name: models.vae,
		prompt: request.prompt,
		negative_prompt: "",
		resolution: referenceBudget(request.width, request.height),
		width: request.width,
		height: request.height,
		batch_size: request.count,
		seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
		steps: request.steps ?? 8,
		cfg: 1,
		sampler_name: "euler",
		scheduler: "simple",
		sigmas: TURBO_SIGMAS,
		filename_prefix: "dsh-image-forge-turbo-edit"
	}), "改图（turbo）", options, signal);
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
	if (await resolveOptimizerModel(llmOf(ctx)) === void 0) return false;
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
* Resolve a usable provider/model pair from the host's LLM service.
*
* Model selection is the one genuinely ambiguous step: a host may mount several
* providers and the list endpoint is async, so this probes the first provider
* that advertises any model and takes its first entry. That is the same model
* the conversation starts on, which is what "seamless" means here — no second
* configuration surface for the user to keep in sync.
*
* @param llm - the service, or `undefined` when the host mounts none.
* @returns the pair to call, or `undefined` when nothing usable was found.
*/
async function resolveOptimizerModel(llm) {
	if (llm === void 0) return void 0;
	let providers;
	try {
		providers = llm.listProviders();
	} catch {
		return;
	}
	for (const entry of providers) {
		const name = entry.name ?? entry.id;
		if (typeof name !== "string" || name.length === 0) continue;
		try {
			const first = (await llm.listModels(name)).find((candidate) => {
				const id = candidate.id ?? candidate.model ?? candidate.name;
				return typeof id === "string" && id.length > 0;
			});
			const id = first === void 0 ? void 0 : first.id ?? first.model ?? first.name;
			if (typeof id === "string" && id.length > 0) return {
				provider: name,
				model: id
			};
		} catch {}
	}
}
/** Read the `llm` service off a context, treating every failure as "absent". */
function llmOf(ctx) {
	try {
		const candidate = ctx.get?.("llm");
		if (candidate === void 0 || candidate === null) return void 0;
		const face = candidate;
		if (typeof face.listProviders !== "function" || typeof face.stream !== "function") return void 0;
		if (typeof face.listModels !== "function") return void 0;
		return face;
	} catch {
		return;
	}
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
	const llm = llmOf(ctx);
	const target = await resolveOptimizerModel(llm);
	if (target === void 0 || llm === void 0) throw new Error("提示词优化不可用：当前会话没有可调用的对话模型。");
	const Assembler = await loadAssembler();
	if (Assembler === void 0) throw new Error("提示词优化不可用：宿主没有安装 @deepseek-ai/dsh-llm。");
	const assembler = new Assembler();
	for await (const chunk of llm.stream({
		provider: target.provider,
		model: target.model,
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
	})) assembler.push(chunk);
	if (signal.aborted) throw new Error("提示词优化已取消");
	const finish = assembler.finish;
	const failed = finish?.kind === "error" || finish?.kind === "aborted";
	const text = assembler.blocks().filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
	const split = splitOptimizerAnswer(text);
	const prompt = stripWrappingQuotes(split.prompt);
	if (prompt.length === 0) throw new Error(failed || text.trim().length === 0 ? "对话模型没有返回可用内容，请重试或换一个模型。" : "对话模型没有返回提示词，请重试或换一个模型。");
	return {
		prompt,
		model: target.model,
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
		turboSteps: config.turboSteps
	};
}
/**
* Steps a Studio request resolves to: its own value, else the family's default.
*
* The family decides which fallback applies: turbo never borrows the base
* checkpoint's 25 (handing 25 steps to a checkpoint distilled for 8 makes the
* picture worse), so an explicit `turboSteps` — else the distilled 8 — is what
* an omitted step count means when `comfyModel` is `turbo`. The clamp is shared.
*/
function resolveStudioSteps(settings, requested) {
	const fallback = settings.comfyModel === "turbo" ? settings.turboSteps ?? 8 : settings.comfyuiSteps ?? settings.defaultSteps;
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
	const optimizer = await resolveOptimizerModel(llmOf(ctx));
	const optimizeAvailable = await optimizerAvailable(ctx);
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
		defaultSteps: resolveStudioSteps(settings, void 0),
		outputDir: settings.outputDir,
		sizes,
		optimizeAvailable,
		...optimizer === void 0 ? {} : { optimizeModel: optimizer.model },
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
* @returns the written images plus the exact parameters that produced them.
* @throws With the user-facing message the panel shows verbatim.
*/
async function runStudioGeneration(settings, input, signal) {
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (prompt.length === 0) throw new Error("请输入提示词");
	if (prompt.length > 4e3) throw new Error(`提示词最多 ${String(STUDIO_MAX_PROMPT_CHARS)} 个字符`);
	const size = studioSize(input.ratio);
	if (size === void 0) throw new Error(`不支持的画幅比例：${String(input.ratio)}`);
	const steps = resolveStudioSteps(settings, input.steps);
	const count = input.count === void 0 ? 1 : Math.trunc(input.count);
	if (!Number.isFinite(count) || count < 1 || count > 4) throw new Error(`出图张数只能是 1 到 ${String(4)}`);
	const seed = input.seed === void 0 || !Number.isFinite(input.seed) ? Math.floor(Math.random() * 2 ** 31) : Math.trunc(input.seed);
	const references = referencePayloads(input.references);
	const mode = references.length > 0 ? "edit" : "generate";
	const startedAt = Date.now();
	const options = comfyOptionsOf(settings);
	let target;
	let models;
	let images;
	try {
		target = await discoverComfyUi(options, signal);
		models = await loadComfyModels(target, options, signal);
		const turbo = settings.comfyModel === "turbo" && turboUnetOf(models) !== void 0;
		images = mode === "edit" ? await (turbo ? generateViaComfyUiTurboEdit : generateViaComfyUiEdit)(target, models, {
			prompt,
			width: size.width,
			height: size.height,
			count,
			steps,
			seed,
			images: references
		}, options, signal) : await (turbo ? generateViaComfyUiTurbo : generateViaComfyUi)(target, models, {
			prompt,
			width: size.width,
			height: size.height,
			count,
			steps,
			seed
		}, options, signal);
	} catch (error) {
		throw new Error(firstLine(error));
	}
	const written = await writeImages(settings.outputDir, outputPrefix(references.length), size.width, size.height, images);
	const itemIds = written.map(() => makeItemId());
	let board;
	let boardNote;
	try {
		const target = (typeof input.board === "string" && input.board.trim().length > 0 ? input.board.trim() : void 0) ?? await activeBoardId(settings.outputDir) ?? void 0;
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
			parents: [],
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
		...board === void 0 ? {} : { board },
		...boardNote === void 0 ? {} : { boardNote }
	};
}
//#endregion
//#region src/studio-routes.ts
/** Heartbeat cadence while a long request is in flight; tests shrink it. */
const HEARTBEAT_MS = 15e3;
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
/** Register all three Studio routes on the host web server. */
function registerStudioRoutes(ctx, deps) {
	const server = ctx.webServer;
	if (server === void 0 || typeof server.register !== "function") return [];
	return [
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
					const output = await runStudioGeneration(deps.settings(), input, controller.signal);
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
					jsonError(res, 502, firstLine(error));
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
					case "create": {
						const board = await createBoard(outputDir, action.name);
						await setActiveBoard(outputDir, board.id);
						return json(res, 200, {
							ok: true,
							board
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
					case "delete": {
						const id = await targetBoardId(outputDir, action.board);
						if (id === void 0) return jsonError(res, 404, "画板不存在");
						const removed = await deleteBoard(outputDir, id);
						if (removed && await activeBoardId(outputDir) === id) await setActiveBoard(outputDir, null);
						return json(res, 200, { ok: removed });
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
				const requested = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("path") ?? "";
				if (requested.length === 0) return jsonError(res, 400, "缺少 path 参数");
				if (!isAbsolute(requested)) return jsonError(res, 400, "必须是绝对路径");
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
				res.writeHead(200, {
					"content-type": resolvedType,
					"content-length": String(stats.size),
					"cache-control": "private, max-age=86400, immutable"
				});
				await pipeline(createReadStream(target), res);
			})
		})
	];
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
	return {
		prompt,
		ratio,
		...steps === void 0 ? {} : { steps },
		...seed === void 0 ? {} : { seed },
		...count === void 0 ? {} : { count },
		...references === void 0 || references.length === 0 ? {} : { references },
		...board === void 0 ? {} : { board }
	};
}
/** Actions the board route accepts. */
const BOARD_ACTIONS = [
	"create",
	"rename",
	"layout",
	"remove-item",
	"delete",
	"active"
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
	const items = Array.isArray(body.items) ? body.items.slice(0, 2e3).map(parsePosition).filter(isPosition) : void 0;
	const camera = parseCamera(body.camera);
	return {
		action,
		...board === void 0 ? {} : { board },
		...name === void 0 ? {} : { name },
		...item === void 0 ? {} : { item },
		...deleteFile ? { deleteFile } : {},
		...items === void 0 ? {} : { items },
		...camera === void 0 ? {} : { camera }
	};
}
function parsePosition(value) {
	const entry = record(value);
	if (entry === void 0) return void 0;
	if (typeof entry.id !== "string" || entry.id.length === 0) return void 0;
	if (typeof entry.x !== "number" || !Number.isFinite(entry.x)) return void 0;
	if (typeof entry.y !== "number" || !Number.isFinite(entry.y)) return void 0;
	return {
		id: entry.id.slice(0, 80),
		x: entry.x,
		y: entry.y
	};
}
function isPosition(value) {
	return value !== void 0;
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
/** One history turn, or `undefined` when it carries nothing usable. */
function parseTurn(value) {
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
//#region src/tools.ts
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
		description: "采样步数；省略则按配置解析：`comfyuiSteps` → 默认 `defaultSteps`（默认 25）；`comfyModel: \"turbo\"` 时是 `turboSteps` → 8。结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型的建议值时再传。"
	},
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
		description: `画布固定比例（官方 7 档）：${WH_RATIOS.join(" / ")}。与 ratio_follow **互斥**；本插件按 ~1.5MP 预算换算成 32 对齐的像素尺寸。省略且没给 ratio_follow 时，默认跟随第一张参考图（不是 1:1）。七档画布在 ComfyUI 改图工作流上都能跑；参考图会先缩放到与画布同量级再进条件化（官方模板的要求）。`
	},
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
		description: "采样步数；省略则按配置解析：`comfyuiSteps` → 默认 `defaultSteps`（默认 25）；`comfyModel: \"turbo\"` 时是 `turboSteps` → 8。结果里的 `steps_used` 与 `steps_source` 会说明实际用了多少、以及它来自哪一层。仅当你明确知道该模型的建议值时再传。"
	},
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
		turboSteps: config.turboSteps
	};
}
function clampSteps(value) {
	return Math.min(200, Math.max(1, Math.round(value)));
}
/**
* Resolve the sampler steps one call should use.
*
* Priority: the caller's explicit `steps` > the ComfyUI override
* (`comfyuiSteps`) > `defaultSteps`. Every branch passes through
* {@link clampSteps}, so even an explicit 10000 arrives at the GPU as 200.
*
* @param explicit - the caller's `steps`, when it supplied one.
* @param settings - the resolved plugin settings.
* @returns the count and where it came from.
*/
function resolveSteps(explicit, settings) {
	if (explicit !== void 0) return {
		steps: clampSteps(explicit),
		source: "explicit"
	};
	if (typeof settings.comfyuiSteps === "number" && Number.isFinite(settings.comfyuiSteps) && settings.comfyuiSteps >= 1) return {
		steps: clampSteps(settings.comfyuiSteps),
		source: "backend"
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
		description: `用 Qwen-Image 出图（本机 ComfyUI）。\`prompt\` 收**成品**提示词（本工具不改写），\`wh_ratio\` 是**一等参数**：直接接受官方契约的 7 档画幅比（${WH_RATIOS.join(" / ")}），插件自己换算成 32 对齐的像素尺寸——所以「契约输出 → 插件入参」不需要人工翻译。省略 wh_ratio 用 1:1，给了 width/height 则以它们为准。结果落盘到配置的 outputDir 并把绝对路径写进正文 Markdown，同时回传结构化字段。需要本机 ComfyUI 已启动且装好三个 Qwen-Image 权重（部署见 docs/comfyui-deployment.md）。`,
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
			const size = chooseSize(args.wh_ratio, asInteger(args.width, "width"), asInteger(args.height, "height"));
			const count = validateCount(args.count);
			const steps = asInteger(args.steps, "steps");
			const request = {
				prompt,
				width: size.width,
				height: size.height,
				count,
				steps,
				seed: asInteger(args.seed, "seed")
			};
			const startedAt = Date.now();
			const options = comfyOptions(settings);
			const target = await discoverComfyUi(options, exec.signal);
			const models = await loadComfyModels(target, options, exec.signal);
			const comfyStartedAt = Date.now();
			const turbo = settings.comfyModel === "turbo" && turboUnetOf(models) !== void 0;
			const turboSkipped = settings.comfyModel === "turbo" && !turbo;
			const usedSteps = turbo ? resolveTurboSteps(steps, settings) : resolveSteps(steps, settings);
			const images = turbo ? await generateViaComfyUiTurbo(target, models, {
				...request,
				steps: usedSteps.steps
			}, options, exec.signal) : await generateViaComfyUi(target, models, {
				...request,
				steps: usedSteps.steps
			}, options, exec.signal);
			const comfyRun = {
				endpoint: target.endpoint,
				port: target.port,
				probed: target.probed,
				models,
				comfyModel: turbo ? "turbo" : "base",
				...turboSkipped ? { turbo_fallback: "已选 turbo，但 /object_info 里没有 turbo 权重，本次用 base 跑" } : {},
				elapsed_ms: Date.now() - comfyStartedAt
			};
			const backendLabel = `后端 comfyui / ${target.endpoint} / ${models.unet}${turbo ? "（turbo）" : ""}`;
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
				ratio_deviation_percent: size.ratioDeviationPercent,
				exact_ratio: size.exactRatio,
				count,
				steps: steps ?? null,
				steps_used: usedSteps.steps,
				steps_source: usedSteps.source,
				seed: request.seed ?? null,
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
		description: `用 Qwen-Image 2.1 做**参考图编辑（图生图）**，在本机 ComfyUI 的官方改图工作流上运行：给 1 张或多张参考图 + 一段**成品修改指令**，出改好的图。\`images\` 收 1–10 张参考图（绝对路径或 data:image/…;base64,…，按顺序对应提示词里的 \`<image1>\`…\`<imageN>\`），\`ratio_follow\` 让画布**跟随某张参考图的宽高比**（写 \`image1\`…\`image10\`，或直接把 \`images\` 里的那一项再写一遍）；它与 \`wh_ratio\` **互斥**（官方契约里一个非空另一个必须为空），两个都不给时**默认跟随第一张参考图**。参考图先上传进 ComfyUI 的 input/ 目录。部署（ComfyUI 桌面版 + 三个权重）见 docs/comfyui-deployment.md。结果落盘到 outputDir 并把绝对路径写进正文 Markdown。`,
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
			const size = chooseEditSize(args.wh_ratio, args.ratio_follow, asInteger(args.width, "width"), asInteger(args.height, "height"), references);
			const count = validateCount(args.count);
			const steps = asInteger(args.steps, "steps");
			const request = {
				prompt,
				width: size.width,
				height: size.height,
				count,
				steps,
				seed: asInteger(args.seed, "seed"),
				images: references
			};
			const startedAt = Date.now();
			const options = comfyOptions(settings);
			const target = await discoverComfyUi(options, exec.signal);
			const models = await loadComfyModels(target, options, exec.signal);
			const comfyStartedAt = Date.now();
			const turbo = settings.comfyModel === "turbo" && turboUnetOf(models) !== void 0;
			const turboSkipped = settings.comfyModel === "turbo" && !turbo;
			const usedSteps = turbo ? resolveTurboSteps(steps, settings) : resolveSteps(steps, settings);
			const images = turbo ? await generateViaComfyUiTurboEdit(target, models, {
				...request,
				steps: usedSteps.steps
			}, options, exec.signal) : await generateViaComfyUiEdit(target, models, {
				...request,
				steps: usedSteps.steps
			}, options, exec.signal);
			const comfyRun = {
				endpoint: target.endpoint,
				port: target.port,
				probed: target.probed,
				models,
				comfyModel: turbo ? "turbo" : "base",
				...turboSkipped ? { turbo_fallback: "已选 turbo，但 /object_info 里没有 turbo 权重，本次用 base 跑" } : {},
				references_uploaded: references.map((reference) => reference.label),
				elapsed_ms: Date.now() - comfyStartedAt
			};
			const backendLabel = `后端 comfyui / ${target.endpoint} / ${models.unet}${turbo ? "（turbo）" : ""}`;
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
		description: "后端健康探测：**本机 ComfyUI 是否在跑**（含探测过哪几个端口、三个 Qwen-Image 权重能不能被它的加载器枚举到、显卡型号与显存余量），以及输出目录能不能写。不产生任何图片、不写盘、不改配置。排障时先跑它。",
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
			return jsonSafe({
				checked_at: (/* @__PURE__ */ new Date()).toISOString(),
				comfyui: {
					modelsDir: settings.comfyModelsDir.length > 0 ? settings.comfyModelsDir : null,
					...comfyui,
					version: stats?.version ?? null,
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
	defaultSteps: Schema.number().default(25).volatile(),
	comfyuiSteps: Schema.number().volatile(),
	comfyModel: Schema.union(["base", "turbo"]).default("base").volatile(),
	turboSteps: Schema.number().volatile()
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
	registerImageForgeTools(ctx, () => resolveConfig(config));
	registerImageForgeSkill(ctx);
	registerStudioRoutesIfMounted(ctx, config);
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
function registerStudioRoutesIfMounted(ctx, config) {
	if (typeof ctx.plugin !== "function") return;
	ctx.plugin({
		name: "dsh-image-forge:studio",
		inject: ["webServer"],
		apply: (svcCtx) => {
			const disposers = registerStudioRoutes(svcCtx, {
				settings: () => studioSettingsOf(resolveConfig(config)),
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
