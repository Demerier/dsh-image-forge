window.__ModuleLoader__.load({
	id: "dsh-image-forge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
//#region src/client-styles.ts
/**
* Presentation CSS for the browser half.
*
* The web client has no stylesheet hook for plugins: the only injection point is
* a `<style>` tag created from inside the lazy factory, which is exactly what
* {@link injectClientStyles} does. The sheet is scoped under the plugin's own
* class prefix so it cannot restyle the Host's chrome, and every color is either
* `currentColor` or a semi-transparent accent so the block survives both the
* light and dark Host themes without a theme probe.
*
* Layout is the point, not decoration. The settings page previously shipped
* unstyled native controls: in a narrow settings column the long path hints
* clipped, the number units never appeared, and the secret/status lines stacked
* into noise. The rules below wrap those on purpose and keep one vertical rhythm
* so the page stays readable at 320 px and at full width.
*/
/** DOM id of the injected sheet; also the idempotence guard. */
const CLIENT_STYLE_ID = "dsh-image-forge-client-styles";
/** The stylesheet text, exported so tests can pin the rules without a DOM. */
const CLIENT_CSS = `
.dsh-image-forge-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 920px;
  color: inherit;
  font: inherit;
  line-height: 1.5;
  /* Size the label/control split off the *column* the Host seats us in, not the
     viewport: a wide window with a narrow settings pane must still stack. */
  container-type: inline-size;
  container-name: forge-settings;
}
.dsh-image-forge-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 2px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
.dsh-image-forge-tab {
  padding: 7px 14px;
  border: 1px solid transparent;
  border-radius: 8px 8px 0 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  opacity: 0.72;
}
.dsh-image-forge-tab:hover {
  opacity: 1;
  background: color-mix(in srgb, currentColor 5%, transparent);
}
.dsh-image-forge-tab-active {
  opacity: 1;
  border-color: color-mix(in srgb, currentColor 12%, transparent);
  border-bottom-color: transparent;
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.dsh-image-forge-settings-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dsh-image-forge-settings-lead {
  margin: 0;
  font-size: 12px;
  opacity: 0.72;
}
.dsh-image-forge-settings-notice {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, currentColor 4%, transparent);
  font-size: 13px;
}
.dsh-image-forge-settings-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 14px 6px;
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, currentColor 2.5%, transparent);
}
.dsh-image-forge-settings-group[data-advanced="true"] {
  opacity: 0.92;
}
.dsh-image-forge-settings-group-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.dsh-image-forge-settings-group-hint {
  margin: -4px 0 4px;
  font-size: 12px;
  opacity: 0.68;
}
.dsh-image-forge-settings-fields {
  display: flex;
  flex-direction: column;
}
.dsh-image-forge-settings-fields-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  column-gap: 16px;
  row-gap: 0;
}
/* Each grid cell is a compact vertical field (label → control → hint). */
.dsh-image-forge-settings-fields-grid > .dsh-image-forge-setting {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas:
    "label"
    "control"
    "hint"
    "status";
  padding-right: 4px;
}
.dsh-image-forge-settings-fields-grid > .dsh-image-forge-setting .dsh-image-forge-setting-label {
  padding-top: 0;
  font-size: 12px;
  opacity: 0.85;
}
.dsh-image-forge-settings-group-dense {
  gap: 6px;
  padding: 12px 12px 4px;
}
.dsh-image-forge-settings-group-dense .dsh-image-forge-settings-group-title {
  font-size: 13px;
}
.dsh-image-forge-settings-group-dense .dsh-image-forge-settings-group-hint {
  margin: -2px 0 2px;
}
.dsh-image-forge-settings-group-dense .dsh-image-forge-setting {
  padding: 10px 0;
}
.dsh-image-forge-settings-group-dense .dsh-image-forge-settings-fields > .dsh-image-forge-setting:first-child {
  padding-top: 2px;
}
.dsh-image-forge-setting {
  display: grid;
  grid-template-columns: minmax(112px, 168px) minmax(0, 1fr);
  grid-template-areas:
    "label control"
    "label hint"
    "label status";
  column-gap: 14px;
  row-gap: 4px;
  padding: 12px 0;
  border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.dsh-image-forge-settings-fields > .dsh-image-forge-setting:first-child {
  border-top: none;
  padding-top: 2px;
}
.dsh-image-forge-setting-label {
  grid-area: label;
  padding-top: 4px;
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.dsh-image-forge-setting-control {
  grid-area: control;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dsh-image-forge-setting-hint {
  grid-area: hint;
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  opacity: 0.7;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.dsh-image-forge-setting-status {
  grid-area: status;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-height: 0;
  font-size: 12px;
}
.dsh-image-forge-setting-status:empty {
  display: none;
}
.dsh-image-forge-setting-control input[type="text"],
.dsh-image-forge-setting-control input[type="password"],
.dsh-image-forge-setting-control input[type="number"],
.dsh-image-forge-setting-control select {
  box-sizing: border-box;
  flex: 1 1 180px;
  min-width: 0;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, canvas 88%, transparent);
  color: inherit;
  font: inherit;
  font-size: 13px;
}
.dsh-image-forge-setting-control input[type="text"],
.dsh-image-forge-setting-control input[type="password"] {
  /* Path and URL boxes need more than a stub: prefer filling the row. */
  flex: 1 1 220px;
}
.dsh-image-forge-setting-control input[type="number"] {
  flex: 1 1 110px;
  max-width: 160px;
}
.dsh-image-forge-setting-control input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: color-mix(in srgb, currentColor 70%, #3b82f6);
}
.dsh-image-forge-setting-control input:focus-visible,
.dsh-image-forge-setting-control select:focus-visible {
  outline: 2px solid color-mix(in srgb, #3b82f6 55%, transparent);
  outline-offset: 1px;
}
.dsh-image-forge-setting-control input:disabled,
.dsh-image-forge-setting-control select:disabled {
  opacity: 0.55;
}
.dsh-image-forge-setting-unit {
  flex: 0 0 auto;
  font-size: 12px;
  opacity: 0.7;
}
.dsh-image-forge-setting-saved {
  color: color-mix(in srgb, #2f9e44 88%, currentColor);
}
.dsh-image-forge-setting-failure {
  color: color-mix(in srgb, #e03131 88%, currentColor);
}
.dsh-image-forge-setting-stored {
  opacity: 0.72;
}
.dsh-image-forge-advisory {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, #f08c00 35%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, #f08c00 10%, transparent);
}
.dsh-image-forge-advisory-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.dsh-image-forge-advisory-p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.88;
}
.dsh-image-forge-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, currentColor 2.5%, transparent);
  color: inherit;
  font: inherit;
}
.dsh-image-forge-row-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
}
.dsh-image-forge-row-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.dsh-image-forge-row-status {
  font-size: 12px;
  opacity: 0.78;
  overflow-wrap: anywhere;
}
.dsh-image-forge-row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-image-forge-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  background: color-mix(in srgb, currentColor 5%, transparent);
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
}
.dsh-image-forge-pill-ok {
  border-color: color-mix(in srgb, #2f9e44 40%, transparent);
  background: color-mix(in srgb, #2f9e44 14%, transparent);
  color: color-mix(in srgb, #2f9e44 82%, currentColor);
}
.dsh-image-forge-pill-warn {
  border-color: color-mix(in srgb, #f08c00 40%, transparent);
  background: color-mix(in srgb, #f08c00 14%, transparent);
  color: color-mix(in srgb, #f08c00 82%, currentColor);
}
.dsh-image-forge-pill-bad {
  border-color: color-mix(in srgb, #e03131 40%, transparent);
  background: color-mix(in srgb, #e03131 14%, transparent);
  color: color-mix(in srgb, #e03131 82%, currentColor);
}
.dsh-image-forge-images {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}
.dsh-image-forge-images img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.dsh-image-forge-checklist {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}
.dsh-image-forge-check {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  border-radius: 10px;
  min-width: 0;
}
.dsh-image-forge-check-label {
  font-size: 11px;
  opacity: 0.7;
}
.dsh-image-forge-check-value {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.dsh-image-forge-deploy {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 4px 0 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, #3b82f6 35%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, #3b82f6 8%, transparent);
}
.dsh-image-forge-deploy-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.dsh-image-forge-deploy-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  opacity: 0.8;
  overflow-wrap: anywhere;
}
.dsh-image-forge-deploy-go {
  align-self: flex-start;
  padding: 8px 16px;
  border: none;
  border-radius: 8px;
  background: color-mix(in srgb, #3b82f6 82%, #1d4ed8);
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.dsh-image-forge-deploy-go:disabled {
  opacity: 0.55;
  cursor: default;
}
.dsh-image-forge-row-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  opacity: 0.78;
  overflow-wrap: anywhere;
}
/* Container query (not a viewport one): the break follows the width of the
   settings column itself. A fallback media query covers hosts that predate
   container queries — they lose the side-by-side split on a narrow pane but
   keep the wrapping hints and the unit suffix. */
@container forge-settings (max-width: 560px) {
  .dsh-image-forge-setting {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "label"
      "control"
      "hint"
      "status";
  }
  .dsh-image-forge-setting-label {
    padding-top: 0;
  }
}
@media (max-width: 560px) {
  .dsh-image-forge-setting {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "label"
      "control"
      "hint"
      "status";
  }
  .dsh-image-forge-setting-label {
    padding-top: 0;
  }
  .dsh-image-forge-settings {
    gap: 14px;
  }
}
`;
/**
* Inject the stylesheet once per document.
*
* Idempotent by {@link CLIENT_STYLE_ID}: the factory can be re-evaluated by a
* Host hot-swap without stacking duplicate rules. On a Host without `document`
* (the Node tests) this is a no-op, so the module can still be imported for its
* exported CSS text.
*
* @returns true when a sheet was inserted, false when one was already there or
*   no DOM is available.
*/
function injectClientStyles() {
	if (typeof document === "undefined") return false;
	if (document.getElementById("dsh-image-forge-client-styles") !== null) return false;
	const style = document.createElement("style");
	style.id = CLIENT_STYLE_ID;
	style.textContent = CLIENT_CSS;
	(document.head ?? document.documentElement).appendChild(style);
	return true;
}
//#endregion
//#region src/settings-fields.ts
/**
* Tab strip for the settings page, in order.
*
* Hidden groups (`python`) are simply not referenced: a tab only lists what it
* actually shows.
*/
const SETTINGS_TABS = [
	{
		id: "generate",
		label: "出图",
		hint: "后端怎么选、画质步数、图落到哪里。",
		groupIds: [
			"backend",
			"steps",
			"output"
		]
	},
	{
		id: "api",
		label: "云端 API",
		hint: "自带 key 的云端端点。",
		groupIds: ["api"]
	},
	{
		id: "local",
		label: "本地环境",
		hint: "一键部署 venv / 权重，以及显存与本地编辑门闩。",
		groupIds: ["local"]
	},
	{
		id: "comfyui",
		label: "ComfyUI",
		hint: "复用你已经装好的 ComfyUI。",
		groupIds: ["comfyui"]
	}
];
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
* Placeholders for the part of a derived path that follows the runtime directory.
*
* Same reason as {@link RUNTIME_DIR_TOKEN} for the token, plus one more: the
* separator and the venv layout differ per platform (`venv\Scripts\python.exe`
* on Windows, `venv/bin/python` elsewhere), and this module cannot ask the host
* which one it is running on. Each token resolves to a sub-path **including its
* leading separator**, so a hint authored as
* `<运行时目录><默认权重子路径>` still renders as a single readable path.
*
* The two platforms' answers are pinned against the canonical derivation
* (`defaultModelsDir` / `venvPaths`) by `settings.test.mjs`, so this duplication
* cannot drift unnoticed.
*/
const DERIVED_SUBPATH_TOKENS = {
	"<默认权重子路径>": {
		win: "\\models\\qwen-image-2.1-bnb4bit",
		posix: "/models/qwen-image-2.1-bnb4bit"
	},
	"<默认解释器子路径>": {
		win: "\\venv\\Scripts\\python.exe",
		posix: "/venv/bin/python"
	}
};
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
	const runtimeDir = value?.["runtimeDir"];
	if (typeof runtimeDir !== "string" || runtimeDir.length === 0) return hint;
	const win = runtimeDir.includes("\\");
	let resolved = hint.split(RUNTIME_DIR_TOKEN).join(runtimeDir);
	for (const [token, paths] of Object.entries(DERIVED_SUBPATH_TOKENS)) resolved = resolved.split(token).join(win ? paths.win : paths.posix);
	return resolved;
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
		hint: "一般不用改；留空 = 自动。",
		advanced: true
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
		kind: "path",
		hidden: true
	},
	{
		key: "modelsDir",
		group: "local",
		label: "权重目录",
		hint: "留空 = 跟随运行时目录：<运行时目录><默认权重子路径>。",
		kind: "path",
		hidden: true
	},
	{
		key: "modelRepo",
		group: "local",
		label: "权重仓库",
		hint: "nf4 权重来自哪个 Hugging Face 仓库。",
		kind: "string",
		hidden: true,
		placeholder: "circulus/Qwen-Image-2.1-bnb-4bit"
	},
	{
		key: "hfMirror",
		group: "local",
		label: "下载镜像",
		hint: "别填 huggingface.co：它的 /api/ 在本机会超时。",
		kind: "string",
		hidden: true,
		placeholder: "https://hf-mirror.com"
	},
	{
		key: "localEndpoint",
		group: "local",
		label: "worker 地址",
		hint: "本地推理 worker 的根地址。",
		kind: "string",
		hidden: true,
		placeholder: "http://127.0.0.1:8399"
	},
	{
		key: "workerPorts",
		group: "local",
		label: "worker 候选端口",
		hint: "形如 8399-8410 或端口列表；localEndpoint 的端口优先。",
		kind: "string",
		hidden: true,
		placeholder: "8399-8410"
	},
	{
		key: "workerStartTimeoutMs",
		group: "local",
		label: "冷启动超时",
		hint: "worker 冷启动要加载约 10.6 GiB 权重，给足时间。",
		kind: "number",
		hidden: true,
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
		hidden: true,
		min: 0,
		max: 864e5,
		unit: "毫秒"
	},
	{
		key: "manageWorker",
		group: "local",
		label: "由插件管理 worker 进程",
		hint: "关闭后插件只连不管，需要你自己把 worker 起起来。",
		kind: "boolean",
		hidden: true
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
		kind: "path",
		hidden: true
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
		hint: "留空 = 跟随运行时目录：<运行时目录><默认解释器子路径>。",
		kind: "path",
		hidden: true
	},
	{
		key: "workerScript",
		group: "python",
		label: "worker 脚本",
		hint: "留空使用插件自带的 resources/worker.py。",
		kind: "path",
		hidden: true
	},
	{
		key: "basePython",
		group: "python",
		label: "基础解释器",
		hint: "建 venv 用它；留空 = 试 python/python3/py。",
		kind: "path",
		hidden: true
	},
	{
		key: "torchWheels",
		group: "python",
		label: "CUDA wheel 标签",
		hint: "留空 = 依次试 cu128、cu126、cu118。",
		kind: "string",
		hidden: true,
		placeholder: "cu128,cu126,cu118"
	},
	{
		key: "pipIndexUrl",
		group: "python",
		label: "pip 索引地址",
		hint: "留空 = https://pypi.org/simple。",
		kind: "string",
		hidden: true,
		placeholder: "https://pypi.org/simple"
	},
	{
		key: "reuseBaseTorch",
		group: "python",
		label: "复用基础解释器里的 CUDA torch",
		hint: "开启后不再下载一份 torch。",
		kind: "boolean",
		hidden: true
	},
	{
		key: "skipLmHead",
		group: "python",
		label: "fetch-weights 跳过 lm_head.weight",
		hint: "默认值：丢掉用不到的那个张量，省下载量。",
		kind: "boolean",
		hidden: true
	}
];
SETTINGS_FIELDS.map((field) => field.key);
SETTINGS_FIELDS.filter((field) => field.hidden === true).map((field) => field.key);
SETTINGS_FIELDS.filter((field) => field.hidden !== true).map((field) => field.key);
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
* Bucket the **visible** fields under their groups, keeping page order.
*
* Hidden controls (custom environment plumbing) are dropped here, and a group
* left with no visible fields — the whole `python` block — is dropped too, so
* the page never renders an empty heading.
*
* @returns one entry per group that still has visible fields.
*/
function groupedFields() {
	return SETTINGS_GROUPS.map((group) => ({
		group,
		fields: SETTINGS_FIELDS.filter((field) => field.group === group.id && field.hidden !== true)
	})).filter((entry) => entry.fields.length > 0);
}
/**
* Visible groups and fields for one tab, in tab order.
*
* @param tab - the tab definition.
* @returns the same shape as {@link groupedFields}, restricted to the tab.
*/
function tabFields(tab) {
	const wanted = new Set(tab.groupIds);
	return groupedFields().filter(({ group }) => wanted.has(group.id));
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
* slopes, the kernel profile and the exclusions are in `docs/configuration.md`
* (the 设置页 section), and test/settings.test.mjs pins both sides: that the page
* stays within budget, and that the shipped prose (the README plus `docs/*.md`)
* still carries the evidence.
*/
const BACKEND_PERF_ADVISORY = {
	id: "backend-perf",
	title: "8 GB 显存上做参考图编辑，请优先用 comfyui 后端",
	paragraphs: ["实测 1312×736 / 6 步：comfyui ≈ 19–23 s，本机 worker ≈ 219 s（纯管线）。", "文生图每步约 2.77×，但两侧量化档不同，不是纯后端差异；依据见 README 与 docs/configuration.md。"],
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
* Client half: keyed tool views for every `qwen_image_*` tool **and** the
* `dsh-image-forge` first-level settings section.
*
* ## Tool views
*
* `tool.call.toolview` is a **keyed** slot, and the key must be the tool's wire
* name for the card to own that call's row — a mismatched key silently
* registers a view nothing ever dispatches to. All four tools are seated:
* generate/edit show the landed images, status/env show a compact digest of the
* JSON the tool already returned in full.
*
* Scope note: these cards are supplementary. The primary display path stays the
* Markdown `![](absolute path)` lines the Host returns in the tool result — if
* a card cannot render for any reason it renders nothing and the conversation
* still shows the images. Everything here is defensive for exactly that reason.
*
* ## The settings section
*
* `settings.section` is a **list** slot (seated by `id`), and a seat there is a
* first-level entry in the DSH settings page. The page the section renders is
* bound to the Host's own shared config form for this plugin's profile entry —
* see `./settings-section.ts` for the binding and save semantics. Field tables
* live in `./settings-fields.ts`; layout CSS in `./client-styles.ts`. This file
* is the React layer on top of those.
*
* Nothing here reaches for a service at activation time: `configForms` is looked
* up optionally, and a page that serves none gets a notice in the section rather
* than losing the plugin's client half (and with it the tool cards).
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
/** Every tool this plugin registers, in the order the cards are seated. */
const TOOL_KEYS = [
	"qwen_image_generate",
	"qwen_image_edit",
	"qwen_image_status",
	"qwen_image_env"
];
/** Tolerant read of one nested object field from a tool payload. */
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
/**
* The tool payload, from the Host's tool-result block (or a `result.value`
* fallback).
*
* @param props - the row props.
* @returns the parsed JSON object `execute()` returned, if any.
*/
function payloadOf(props) {
	const content = props.block?.content;
	if (Array.isArray(content)) for (const item of content) {
		const text = item?.text;
		if (typeof text !== "string" || text.length === 0) continue;
		try {
			const record = asRecord(JSON.parse(text));
			if (record !== void 0) return record;
		} catch {}
	}
	return asRecord(props.result?.value);
}
/** Wire name of the tool this row is rendering. */
function toolNameOf(props) {
	return props.toolName ?? props.block?.name ?? "";
}
/** Pull `images[].path` out of the tool's canonical payload, tolerantly. */
function imagePaths(props) {
	const images = payloadOf(props)?.["images"];
	if (!Array.isArray(images)) return [];
	return images.map((entry) => asRecord(entry)?.["path"]).filter((path) => typeof path === "string" && path.length > 0);
}
/** One meta chip; `tone` maps onto the pill modifiers in the stylesheet. */
function pill(key, text, tone = "neutral") {
	const className = tone === "neutral" ? "dsh-image-forge-pill" : `dsh-image-forge-pill dsh-image-forge-pill-${tone}`;
	return (0, react.createElement)("span", {
		key,
		className
	}, text);
}
/** Compact `1664×928` from a result `size` object, or null. */
function sizeChip(value) {
	const size = asRecord(value?.["size"]);
	const width = size?.["width"];
	const height = size?.["height"];
	if (typeof width !== "number" || typeof height !== "number") return null;
	return pill("size", `${width}×${height}`);
}
/** Status / running / done line for the current lifecycle phase. */
function phaseLabel(props, done, running) {
	const phase = props.phase ?? "start";
	if (phase === "preparing") return "准备参数…";
	if (phase === "result") return done;
	return running;
}
/** Shared card shell: title, status line, optional pills, then children. */
function CardShell(props) {
	return (0, react.createElement)("div", { className: "dsh-image-forge-row" }, [
		(0, react.createElement)("div", {
			key: "head",
			className: "dsh-image-forge-row-head"
		}, [(0, react.createElement)("h4", {
			key: "title",
			className: "dsh-image-forge-row-title"
		}, props.title), (0, react.createElement)("span", {
			key: "status",
			className: "dsh-image-forge-row-status"
		}, props.status)]),
		props.pills.length > 0 ? (0, react.createElement)("div", {
			key: "meta",
			className: "dsh-image-forge-row-meta"
		}, props.pills) : null,
		...props.children
	]);
}
/** The image grid both generate and edit render once paths exist. */
function ImageGrid(props) {
	const paths = imagePaths(props);
	if (paths.length === 0 || typeof props.loadImage !== "function") return null;
	return (0, react.createElement)("div", {
		key: "images",
		className: "dsh-image-forge-images"
	}, paths.map((path, index) => (0, react.createElement)("img", {
		key: `image-${index}`,
		src: props.loadImage?.(path),
		alt: path,
		loading: "lazy"
	})));
}
/**
* Generate / edit card: the landed images plus the facts that explain them.
*
* @param props - owner props supplied by ui-tool's dispatch.
* @returns the card, or nothing on a presentation failure.
*/
function ImageResultRow(props) {
	try {
		const payload = payloadOf(props);
		const isEdit = toolNameOf(props) === "qwen_image_edit";
		const count = imagePaths(props).length;
		const status = phaseLabel(props, count > 0 ? `完成：${count} 张` : isEdit ? "改图结束（未落盘，请看工具结果）" : "出图结束（未落盘，请看工具结果）", isEdit ? "正在改图…" : "正在出图…");
		const pills = [];
		const size = sizeChip(payload);
		if (size !== null) pills.push(size);
		const backend = payload?.["backend"];
		if (typeof backend === "string" && backend.length > 0) pills.push(pill("backend", backend));
		const ratio = payload?.["wh_ratio"];
		if (typeof ratio === "string" && ratio.length > 0) pills.push(pill("ratio", `wh_ratio ${ratio}`));
		const follow = payload?.["ratio_follow"];
		if (typeof follow === "string" && follow.length > 0) pills.push(pill("follow", `← ${follow}`));
		const stepsUsed = payload?.["steps_used"];
		if (typeof stepsUsed === "number") pills.push(pill("steps", `${stepsUsed} 步`));
		const refs = payload?.["references"];
		if (Array.isArray(refs) && refs.length > 0) pills.push(pill("refs", `${refs.length} 张参考`));
		const notes = [];
		const gateWarning = asRecord(payload?.["local_edit_budget"])?.["warning"];
		if (typeof gateWarning === "string" && gateWarning.length > 0) notes.push((0, react.createElement)("p", {
			key: "gate",
			className: "dsh-image-forge-row-note"
		}, gateWarning.split("\n")[0] ?? ""));
		return (0, react.createElement)(CardShell, {
			title: isEdit ? "参考图编辑" : "文生图",
			status,
			pills,
			children: [(0, react.createElement)(ImageGrid, {
				key: "grid",
				...props
			}), ...notes]
		});
	} catch {
		return null;
	}
}
/** One checklist cell: a short label over a one-line verdict. */
function checkCell(key, label, text, tone) {
	return (0, react.createElement)("div", {
		key,
		className: "dsh-image-forge-check"
	}, [
		(0, react.createElement)("span", {
			key: "label",
			className: "dsh-image-forge-check-label"
		}, label),
		(0, react.createElement)("span", {
			key: "value",
			className: "dsh-image-forge-check-value"
		}, text),
		pill("tone", tone === "neutral" ? "—" : tone === "ok" ? "OK" : tone === "warn" ? "注意" : "不可用", tone)
	]);
}
/**
* Status card: a four-cell digest of the health probe.
*
* The full JSON stays in the tool result; this is the glanceable half.
*
* @param props - owner props supplied by ui-tool's dispatch.
* @returns the card, or nothing on a presentation failure.
*/
function StatusRow(props) {
	try {
		const payload = payloadOf(props);
		const status = phaseLabel(props, "探测完成", "正在探测后端…");
		const api = asRecord(payload?.["api"]);
		const comfy = asRecord(payload?.["comfyui"]);
		const worker = asRecord(payload?.["worker"]);
		const venv = asRecord(payload?.["venv"]);
		const weights = asRecord(payload?.["weights"]);
		const apiOk = api?.["reachable"] === true;
		const apiAuth = api?.["authenticated"] === true;
		const apiHasKey = api?.["keyPresent"] === true;
		const apiTone = apiOk && apiAuth ? "ok" : apiOk || api?.["reachable"] === null && apiHasKey ? "warn" : "bad";
		const apiText = !apiHasKey && api?.["reachable"] !== true ? "未配置 key" : !apiOk ? api?.["reachable"] === null ? "未探测（无 key）" : "不可达" : apiAuth ? "可达，key 被接受" : "可达，但 key 被拒绝";
		const comfyOk = comfy?.["reachable"] === true;
		const models = asRecord(comfy?.["models"]);
		const comfyTone = comfyOk ? models?.["ok"] === true ? "ok" : "warn" : "bad";
		const comfyText = !comfyOk ? "没找到在跑的实例" : models?.["ok"] === true ? "在跑，三个权重齐" : "在跑，但缺 Qwen 权重";
		const workerOk = worker?.["ready"] === true || worker?.["reachable"] === true;
		const workerTone = worker?.["ready"] === true ? "ok" : workerOk ? "warn" : "bad";
		const workerText = worker?.["ready"] === true ? `ready${typeof worker["pid"] === "number" ? ` · pid ${worker["pid"]}` : ""}` : workerOk ? "进程在，未就绪" : "不在跑（按需拉起）";
		const localReady = venv?.["exists"] === true && weights?.["ready"] === true;
		const localTone = localReady ? "ok" : venv?.["exists"] === true ? "warn" : "bad";
		const localText = localReady ? "venv + 权重就绪" : venv?.["exists"] === true ? "权重未就绪" : "本地运行时未安装";
		return (0, react.createElement)(CardShell, {
			title: "后端健康",
			status,
			pills: [pill("backend", `配置后端 ${typeof payload?.["configured_backend"] === "string" ? payload["configured_backend"] : "?"}`)],
			children: [(0, react.createElement)("div", {
				key: "checks",
				className: "dsh-image-forge-checklist"
			}, [
				checkCell("api", "云端 API", apiText, apiTone),
				checkCell("comfy", "ComfyUI", comfyText, comfyTone),
				checkCell("worker", "本地 worker", workerText, workerTone),
				checkCell("local", "本地运行时", localText, localTone)
			])]
		});
	} catch {
		return null;
	}
}
/**
* Env card: which action ran and the one number that matters for it.
*
* @param props - owner props supplied by ui-tool's dispatch.
* @returns the card, or nothing on a presentation failure.
*/
function EnvRow(props) {
	try {
		const payload = payloadOf(props);
		const action = typeof payload?.["action"] === "string" ? payload["action"] : "status";
		const dryRun = payload?.["dry_run"] === true;
		const ok = payload?.["ok"] !== false;
		const status = phaseLabel(props, ok ? dryRun ? `完成（dry-run）：${action}` : `完成：${action}` : `未完成：${action}`, `正在执行 ${action}…`);
		const pills = [pill("action", action), pill("ok", ok ? "ok" : "failed", ok ? "ok" : "bad")];
		if (dryRun) pills.push(pill("dry", "dry-run", "warn"));
		if (action === "unload") {
			const before = payload?.["vram_before_MiB"];
			const after = payload?.["vram_after_MiB"];
			if (typeof before === "number" && typeof after === "number") pills.push(pill("vram", `显存 ${before} → ${after} MiB`, after < before ? "ok" : "neutral"));
		}
		if (action === "status") {
			const gate = asRecord(payload?.["worker_start_gate"]);
			if (gate?.["would_refuse_start"] === true) pills.push(pill("gate", "worker 将被拒绝启动", "warn"));
			else if (gate?.["would_refuse_start"] === false) pills.push(pill("gate", "worker 可启动", "ok"));
		}
		const files = payload?.["files"];
		if (Array.isArray(files) && files.length > 0 && action === "fetch-weights") pills.push(pill("files", `${files.length} 个文件`));
		const steps = payload?.["steps"];
		if (Array.isArray(steps) && action === "install") {
			const planned = steps.filter((step) => asRecord(step)?.["status"] === "planned").length;
			if (planned > 0) pills.push(pill("steps", `${planned} 步待执行`, "warn"));
		}
		const note = payload?.["note"];
		const children = [];
		if (typeof note === "string" && note.length > 0) children.push((0, react.createElement)("p", {
			key: "note",
			className: "dsh-image-forge-row-note"
		}, note));
		return (0, react.createElement)(CardShell, {
			title: "环境与运行时",
			status,
			pills,
			children
		});
	} catch {
		return null;
	}
}
/**
* Build the tool row bound to one wire name.
*
* The Host does not guarantee `toolName` on the props, so the key is closed over
* at registration time instead of being read back from the call.
*
* @param toolName - the tool's wire name.
* @returns a component that renders that tool's card.
*/
function createToolRow(toolName) {
	return function QwenImageToolRow(props) {
		const bound = {
			...props,
			toolName: toolNameOf(props) || toolName
		};
		if (toolName === "qwen_image_status") return StatusRow(bound);
		if (toolName === "qwen_image_env") return EnvRow(bound);
		return ImageResultRow(bound);
	};
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
	const controlId = `dsh-image-forge-field-${field.key}`;
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
	const control = buildControl(field, value, disabled, draft, setDraft, commit, controlId);
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
			className: "dsh-image-forge-setting-label",
			htmlFor: controlId
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
* @param controlId - the input id the label points at.
* @returns the control element (and the unit suffix, for numbers).
*/
function buildControl(field, value, disabled, draft, setDraft, commit, controlId) {
	field.key;
	const unit = field.unit === void 0 ? [] : [(0, react.createElement)("span", {
		key: "unit",
		className: "dsh-image-forge-setting-unit"
	}, field.unit)];
	if (field.kind === "boolean") return [(0, react.createElement)("input", {
		key: "input",
		id: controlId,
		type: "checkbox",
		checked: value === true,
		disabled,
		onChange: (event) => {
			commit(event.target.checked);
		}
	}), ...unit];
	if (field.kind === "enum") {
		const choices = field.choices ?? [];
		return [(0, react.createElement)("select", {
			key: "input",
			id: controlId,
			value: typeof value === "string" ? value : "",
			disabled,
			onChange: (event) => {
				commit(event.target.value);
			}
		}, choices.map((choice) => (0, react.createElement)("option", {
			key: choice.value,
			value: choice.value
		}, choice.label))), ...unit];
	}
	if (field.kind === "number") return [(0, react.createElement)("input", {
		key: "input",
		id: controlId,
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
	}), ...unit];
	const secret = field.kind === "secret";
	const storedPresent = secret && typeof value === "string" && value.length > 0;
	return [(0, react.createElement)("input", {
		key: "input",
		id: controlId,
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
	}), ...unit];
}
/** Loopback bridge the host half serves; see `src/deploy-server.ts`. */
const DEPLOY_BASE = "http://127.0.0.1:8411";
/**
* One-click deploy card: readiness chips + the button that runs venv install
* and the 10.63 GiB weight fetch through the host-side bridge.
*
* @returns the block, or a notice when the bridge is unreachable.
*/
function DeployBlock() {
	const [status, setStatus] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)(void 0);
	const [busy, setBusy] = (0, react.useState)(false);
	(0, react.useEffect)(() => {
		let stopped = false;
		const pull = () => {
			fetch(`${DEPLOY_BASE}/status`).then((response) => response.json()).then((payload) => {
				if (stopped) return;
				setStatus(payload);
				setError(void 0);
			}).catch(() => {
				if (stopped) return;
				setStatus(null);
				setError("一键部署服务未响应（宿主插件未运行，或端口 8411 被占用）。");
			});
		};
		pull();
		const timer = setInterval(pull, 4e3);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, []);
	const deploy = () => {
		setBusy(true);
		setError(void 0);
		fetch(`${DEPLOY_BASE}/deploy`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				dryRun: false,
				weights: true
			})
		}).then(async (response) => {
			const payload = await response.json();
			if (!response.ok || payload.ok === false) setError(payload.error ?? `部署失败（HTTP ${response.status}）`);
			return fetch(`${DEPLOY_BASE}/status`);
		}).then((response) => response.json()).then((payload) => {
			setStatus(payload);
			setBusy(false);
		}).catch((cause) => {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		});
	};
	const venvOk = status?.venv?.exists === true;
	const weightsOk = status?.weights?.ready === true;
	const ready = venvOk && weightsOk;
	const deploying = status?.deploying === true || busy;
	return (0, react.createElement)("section", {
		className: "dsh-image-forge-deploy",
		"data-dsh-part": "local-deploy"
	}, [
		(0, react.createElement)("h4", {
			key: "title",
			className: "dsh-image-forge-deploy-title"
		}, "本地运行时一键部署"),
		(0, react.createElement)("p", {
			key: "hint",
			className: "dsh-image-forge-deploy-hint"
		}, "自动创建 venv、安装 CUDA torch，并下载 Qwen-Image nf4 权重（约 10.63 GiB）。自定义路径与镜像使用默认值，不在设置页暴露。"),
		(0, react.createElement)("div", {
			key: "chips",
			className: "dsh-image-forge-row-meta"
		}, [
			pill("venv", venvOk ? "venv 就绪" : "venv 未安装", venvOk ? "ok" : "warn"),
			pill("weights", weightsOk ? `权重就绪 · ${status?.weights?.total_MiB ?? 0} MiB` : `权重缺 ${status?.weights?.missing ?? "?"} 个文件`, weightsOk ? "ok" : "warn"),
			...status?.deploying === true && status.phase ? [pill("phase", `部署中：${status.phase}`, "warn")] : [],
			...status?.last ? [pill("last", status.last.ok ? `上次成功${status.last.at ? "" : ""}` : "上次未完成", status.last.ok ? "ok" : "bad")] : []
		]),
		(0, react.createElement)("button", {
			key: "go",
			type: "button",
			className: "dsh-image-forge-deploy-go",
			disabled: deploying,
			onClick: deploy
		}, deploying ? "部署中…" : ready ? "重新部署" : "一键部署本地环境"),
		...error !== void 0 ? [(0, react.createElement)("p", {
			key: "error",
			className: "dsh-image-forge-setting-failure"
		}, error)] : []
	]);
}
/**
* One titled block of fields.
*
* @param props - the group and its fields.
* @returns the block.
*/
function GroupBlock(props) {
	const { group, fields, value, disabled, write, beforeFields, dense } = props;
	return (0, react.createElement)("section", {
		className: dense ? "dsh-image-forge-settings-group dsh-image-forge-settings-group-dense" : "dsh-image-forge-settings-group",
		key: group.id,
		"data-group": group.id,
		...group.advanced === true ? { "data-advanced": "true" } : {}
	}, [
		(0, react.createElement)("h3", {
			key: "title",
			className: "dsh-image-forge-settings-group-title"
		}, group.label),
		(0, react.createElement)("p", {
			key: "hint",
			className: "dsh-image-forge-settings-group-hint"
		}, group.hint),
		beforeFields ?? null,
		(0, react.createElement)("div", {
			key: "fields",
			className: dense ? "dsh-image-forge-settings-fields dsh-image-forge-settings-fields-grid" : "dsh-image-forge-settings-fields"
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
* caveat, and the evidence behind them lives in the shipped prose
* (`docs/configuration.md`, `docs/backends.md`). The strings render as
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
	const [tabId, setTabId] = (0, react.useState)(SETTINGS_TABS[0]?.id ?? "generate");
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
	const activeTab = SETTINGS_TABS.find((tab) => tab.id === tabId) ?? SETTINGS_TABS[0];
	const panels = activeTab === void 0 ? [] : tabFields(activeTab);
	return (0, react.createElement)("div", {
		className: "dsh-image-forge-settings",
		"data-dsh-tick": tick
	}, [
		(0, react.createElement)("div", {
			key: "tabs",
			className: "dsh-image-forge-tabs",
			role: "tablist"
		}, SETTINGS_TABS.map((tab) => (0, react.createElement)("button", {
			key: tab.id,
			type: "button",
			role: "tab",
			className: tab.id === activeTab?.id ? "dsh-image-forge-tab dsh-image-forge-tab-active" : "dsh-image-forge-tab",
			"aria-selected": tab.id === activeTab?.id,
			onClick: () => setTabId(tab.id)
		}, tab.label))),
		(0, react.createElement)("p", {
			key: "lead",
			className: "dsh-image-forge-settings-lead"
		}, [activeTab?.hint ?? "", disabled ? " 当前配置条目为只读。" : " 改动会立即写入。"].filter((part) => part.length > 0).join(" ")),
		(0, react.createElement)("div", {
			key: "panel",
			className: "dsh-image-forge-settings-panel",
			role: "tabpanel"
		}, panels.map(({ group, fields }) => {
			const block = (0, react.createElement)(GroupBlock, {
				key: group.id,
				group,
				fields,
				value,
				disabled,
				write,
				dense: true,
				...group.id === "local" ? { beforeFields: (0, react.createElement)(DeployBlock, { key: "deploy" }) } : {}
			});
			const advisory = advisoryAfterGroup(group.id);
			return advisory === void 0 ? [block] : [block, (0, react.createElement)(AdvisoryBlock, {
				key: advisory.id,
				advisory
			})];
		}))
	]);
}
/**
* Register the keyed tool views and the first-level settings section.
*
* @param ctx - cordis client context providing `slots`, and optionally `get`.
*/
function apply(ctx) {
	injectClientStyles();
	ctx.slots.inject("tool.call.toolview", () => {
		const seats = TOOL_KEYS.map((toolName) => ctx.slots.register({
			name: "tool.call.toolview",
			key: toolName
		}, createToolRow(toolName)));
		return () => {
			for (const seat of seats) try {
				if (typeof seat === "function") seat();
			} catch {}
		};
	});
	registerSettingsSection(ctx, QwenImageSettingsSection);
}
//#endregion
exports.apply = apply;
exports.inject = inject;

		return module.exports;
	}
});
