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

.dsh-image-forge-studio{display:flex;flex-direction:column;gap:14px;min-width:0}
.dsh-forge-studio-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.dsh-forge-studio-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}
.dsh-forge-studio-status{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.75;flex-wrap:wrap}
.dsh-forge-studio-endpoint{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-forge-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:currentColor;opacity:.4}
.dsh-forge-dot.is-ok{background:#22c55e;opacity:1;box-shadow:0 0 0 3px rgba(34,197,94,.18)}
.dsh-forge-dot.is-bad{background:#ef4444;opacity:1;box-shadow:0 0 0 3px rgba(239,68,68,.16)}
.dsh-forge-studio-alert{padding:9px 11px;border-radius:7px;font-size:12.5px;line-height:1.55;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.07);color:inherit;overflow-wrap:anywhere}
.dsh-forge-studio-hint{font-size:11.5px;line-height:1.5;opacity:.6;overflow-wrap:anywhere}
.dsh-forge-studio-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;align-items:start}
@media (max-width:860px){.dsh-forge-studio-body{grid-template-columns:minmax(0,1fr)}}
.dsh-forge-studio-form{display:flex;flex-direction:column;gap:13px;min-width:0}
.dsh-forge-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-forge-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.dsh-forge-field-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.dsh-forge-mode{display:inline-flex;padding:2px;border-radius:6px;border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.05)}
.dsh-forge-mode-item{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:11.5px;line-height:1.4;padding:3px 8px;border-radius:4px;cursor:pointer;opacity:.66;transition:background .15s,opacity .15s,color .15s;white-space:nowrap}
.dsh-forge-mode-item:hover{opacity:.92}
.dsh-forge-mode-item.is-active{background:rgba(59,130,246,.14);color:#3b82f6;opacity:1;font-weight:600}
.dsh-forge-field-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dsh-forge-label{font-size:12px;font-weight:600;letter-spacing:.02em;opacity:.8}
.dsh-forge-textarea,.dsh-forge-input{width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:1.6;padding:9px 11px;border-radius:7px;border:1px solid rgba(127,127,127,.32);background:rgba(127,127,127,.05);color:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
.dsh-forge-textarea{resize:vertical;min-height:104px}
.dsh-forge-textarea:focus,.dsh-forge-input:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.16);background:transparent}
.dsh-forge-textarea::placeholder{color:inherit;opacity:.38}
.dsh-forge-ratio-row{display:flex;gap:6px;flex-wrap:wrap}
.dsh-forge-ratio{appearance:none;display:inline-flex;flex-direction:column;align-items:center;gap:1px;padding:5px 9px;border-radius:6px;border:1px solid rgba(127,127,127,.28);background:transparent;color:inherit;cursor:pointer;font:inherit;line-height:1.25;transition:border-color .15s,background .15s}
.dsh-forge-ratio:hover{border-color:rgba(127,127,127,.5);background:rgba(127,127,127,.07)}
.dsh-forge-ratio.is-active{border-color:#3b82f6;background:rgba(59,130,246,.12);color:#3b82f6}
.dsh-forge-ratio-label{font-size:12px;font-weight:600}
.dsh-forge-ratio-size{font-size:9.5px;opacity:.55;font-variant-numeric:tabular-nums}
.dsh-forge-ref-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsh-forge-ref{position:relative;width:58px;height:58px;border-radius:6px;overflow:hidden;border:1px solid rgba(127,127,127,.28)}
.dsh-forge-ref img{width:100%;height:100%;object-fit:cover;display:block}
.dsh-forge-ref-index{position:absolute;left:3px;bottom:2px;font-size:9.5px;padding:0 4px;border-radius:3px;background:rgba(0,0,0,.6);color:#fff;line-height:1.5}
.dsh-forge-ref-remove{position:absolute;top:1px;right:1px;width:16px;height:16px;line-height:14px;text-align:center;border-radius:50%;border:0;background:rgba(0,0,0,.62);color:#fff;cursor:pointer;font-size:12px;padding:0}
.dsh-forge-ref-add{display:flex;align-items:center;justify-content:center;width:58px;height:58px;border-radius:6px;border:1px dashed rgba(127,127,127,.45);cursor:pointer;font-size:20px;line-height:1;opacity:.65;transition:border-color .15s,opacity .15s}
.dsh-forge-ref-add:hover{opacity:1;border-color:#3b82f6}
.dsh-forge-studio-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}
.dsh-forge-btn{appearance:none;font:inherit;font-size:12.5px;font-weight:500;padding:6px 13px;border-radius:6px;cursor:pointer;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;transition:border-color .15s,background .15s,opacity .15s}
.dsh-forge-btn:hover{border-color:rgba(127,127,127,.55);background:rgba(127,127,127,.07)}
.dsh-forge-btn:disabled{opacity:.42;cursor:not-allowed}
.dsh-forge-btn.is-primary{border-color:#3b82f6;background:#3b82f6;color:#fff}
.dsh-forge-btn.is-primary:hover:not(:disabled){background:#2563eb;border-color:#2563eb}
.dsh-forge-btn.is-ghost{border-color:transparent;opacity:.78;padding:5px 9px}
.dsh-forge-btn.is-ghost:hover{opacity:1;background:rgba(127,127,127,.1)}
.dsh-forge-studio-results{display:flex;flex-direction:column;gap:10px;min-width:0}
.dsh-forge-results-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.dsh-forge-view-toggle{display:inline-flex;padding:2px;border-radius:6px;border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.05)}
.dsh-forge-view-item{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:11.5px;line-height:1.4;padding:3px 10px;border-radius:4px;cursor:pointer;opacity:.66;transition:background .15s,opacity .15s,color .15s}
.dsh-forge-view-item:hover{opacity:.92}
.dsh-forge-view-item.is-active{background:rgba(59,130,246,.14);color:#3b82f6;opacity:1;font-weight:600}
.dsh-forge-zoom{display:flex;align-items:center;gap:1px}
.dsh-forge-zoom-label{font-size:10.5px;opacity:.6;min-width:36px;text-align:center;font-variant-numeric:tabular-nums}
.dsh-forge-list{display:flex;flex-direction:column;gap:12px;min-width:0}
.dsh-forge-canvas{position:relative;height:clamp(300px,50vh,540px);overflow:hidden;border:1px solid rgba(127,127,127,.28);border-radius:10px;background-color:rgba(127,127,127,.035);background-image:radial-gradient(rgba(127,127,127,.3) 1px,transparent 1px);background-size:22px 22px;cursor:grab;touch-action:none;user-select:none}
.dsh-forge-canvas:active{cursor:grabbing}
.dsh-forge-canvas-layer{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.dsh-forge-canvas-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.dsh-forge-edge{fill:none;stroke:rgba(59,130,246,.5);stroke-width:2;stroke-dasharray:6 5;stroke-linecap:round}
.dsh-forge-node{position:absolute;width:208px;border-radius:10px;overflow:hidden;border:1px solid rgba(127,127,127,.34);background:rgba(127,127,127,.08);cursor:grab;box-shadow:0 1px 5px rgba(0,0,0,.09)}
.dsh-forge-node.is-selected{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.22),0 2px 10px rgba(0,0,0,.12);z-index:2}
.dsh-forge-node img{display:block;width:100%;height:200px;object-fit:cover;background:rgba(127,127,127,.14);pointer-events:none}
.dsh-forge-node-meta{padding:4px 8px 5px;font-size:10px;opacity:.62;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-forge-node-actions{display:flex;gap:4px;padding:0 6px 6px;flex-wrap:wrap}
.dsh-forge-node-btn{appearance:none;font:inherit;font-size:10.5px;padding:3px 7px;border-radius:5px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;text-decoration:none;line-height:1.5;white-space:nowrap}
.dsh-forge-node-btn:hover{background:rgba(127,127,127,.13);border-color:rgba(127,127,127,.5)}
.dsh-forge-node-btn.is-danger:hover{color:#dc2626;border-color:rgba(220,38,38,.5);background:rgba(220,38,38,.08)}
.dsh-forge-canvas-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;margin:0;padding:0 28px;text-align:center;font-size:12.5px;line-height:1.7;opacity:.45;pointer-events:none}
.dsh-forge-canvas-foot{position:absolute;left:0;right:0;bottom:0;padding:6px 10px;font-size:10.5px;opacity:.55;background:linear-gradient(transparent,rgba(127,127,127,.14));pointer-events:none;text-align:center}
.dsh-forge-studio-empty{padding:26px 12px;text-align:center;font-size:12.5px;opacity:.45;border:1px dashed rgba(127,127,127,.3);border-radius:8px}
.dsh-forge-batch{display:flex;flex-direction:column;gap:7px;padding:9px;border-radius:8px;border:1px solid rgba(127,127,127,.2);background:rgba(127,127,127,.03)}
.dsh-forge-batch.is-active{border-color:rgba(59,130,246,.45)}
.dsh-forge-batch-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-forge-batch-meta{font-size:11px;opacity:.6;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-forge-batch-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:7px}
.dsh-forge-batch-item{display:block;border-radius:6px;overflow:hidden;background:rgba(127,127,127,.08);aspect-ratio:1/1}
.dsh-forge-batch-item img{width:100%;height:100%;object-fit:cover;display:block}
.dsh-forge-batch-prompt{font-size:11.5px;line-height:1.55;opacity:.62;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dsh-forge-board-bar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:7px 9px;border-radius:8px;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.04)}
.dsh-forge-board-label{font-size:11.5px;font-weight:600;letter-spacing:.04em;opacity:.6;flex-shrink:0}
.dsh-forge-board-select{appearance:none;font:inherit;font-size:12.5px;line-height:1.5;padding:4px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;max-width:22ch;cursor:pointer}
.dsh-forge-board-select:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.16)}
.dsh-forge-board-input{font:inherit;font-size:12.5px;line-height:1.5;padding:4px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.32);background:rgba(127,127,127,.05);color:inherit;width:20ch;outline:none}
.dsh-forge-board-input:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.16)}
.dsh-forge-board-count{font-size:11px;opacity:.52;font-variant-numeric:tabular-nums;margin-left:auto;white-space:nowrap}
.dsh-forge-assets{display:flex;flex-direction:column;gap:10px;min-width:0}
.dsh-forge-assets-bar{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dsh-forge-assets-search{flex:1 1 180px;min-width:0;font:inherit;font-size:12.5px;padding:5px 9px;border-radius:6px;border:1px solid rgba(127,127,127,.32);background:rgba(127,127,127,.05);color:inherit;outline:none}
.dsh-forge-assets-search:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.16)}
.dsh-forge-assets-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:9px}
.dsh-forge-asset{display:flex;flex-direction:column;gap:5px;padding:7px;border-radius:8px;border:1px solid rgba(127,127,127,.2);background:rgba(127,127,127,.03);min-width:0}
.dsh-forge-asset-thumb{display:block;border-radius:6px;overflow:hidden;background:rgba(127,127,127,.08);aspect-ratio:4/3}
.dsh-forge-asset-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.dsh-forge-asset-meta{font-size:10.5px;line-height:1.45;opacity:.55;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-forge-asset-prompt{font-size:11px;line-height:1.5;opacity:.68;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.dsh-forge-asset-actions{display:flex;gap:4px;flex-wrap:wrap}
.dsh-forge-asset-btn{appearance:none;border:1px solid rgba(127,127,127,.28);background:transparent;color:inherit;font:inherit;font-size:10.5px;line-height:1.4;padding:2px 7px;border-radius:4px;cursor:pointer;opacity:.72;transition:opacity .15s,border-color .15s}
.dsh-forge-asset-btn:hover{opacity:1;border-color:rgba(127,127,127,.5)}
.dsh-forge-asset-btn.is-danger:hover{border-color:rgba(239,68,68,.5);color:#ef4444}

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
* Build the URL that serves one image through {@link STUDIO_FILE_ROUTE}.
*
* @param path - the absolute on-disk path a tool result or board item carries.
* @returns a same-origin URL safe to put into `<img src>` and `href`.
*/
function studioFileUrl(path) {
	return `${STUDIO_FILE_ROUTE}?path=${encodeURIComponent(path)}`;
}
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
//#endregion
//#region src/studio-canvas.ts
/** Smallest zoom the canvas allows; below this a node is unreadable anyway. */
const CANVAS_MIN_ZOOM = .3;
/** Largest zoom the canvas allows; above this the bitmap gains nothing. */
const CANVAS_MAX_ZOOM = 2.5;
/** Clamp a zoom factor into the supported range. */
function clampZoom(zoom) {
	if (!Number.isFinite(zoom)) return 1;
	return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, zoom));
}
/** Convert a viewport-relative screen point to world space. */
function screenToWorld(camera, screen) {
	return {
		x: screen.x / camera.zoom + camera.x,
		y: screen.y / camera.zoom + camera.y
	};
}
/**
* Zoom while keeping the world point under `anchor` pinned to `anchor`.
*
* Without the anchor correction a wheel zoom drifts toward the viewport corner,
* which feels like the canvas is fighting the pointer. `anchor` is in
* viewport-relative screen pixels.
*/
function zoomAt(camera, factor, anchor) {
	const zoom = clampZoom(camera.zoom * factor);
	if (zoom === camera.zoom) return camera;
	const before = screenToWorld(camera, anchor);
	return {
		zoom,
		x: before.x - anchor.x / zoom,
		y: before.y - anchor.y / zoom
	};
}
/** Pan by a screen-space delta. */
function panBy(camera, delta) {
	return {
		zoom: camera.zoom,
		x: camera.x - delta.x / camera.zoom,
		y: camera.y - delta.y / camera.zoom
	};
}
/**
* A camera that frames every node with `padding` world units of margin.
*
* Returns the unchanged camera when there is nothing to frame — an empty
* canvas should not teleport the view.
*/
function fitCamera(rects, viewport, padding = 48) {
	if (rects.length === 0 || viewport.width <= 0 || viewport.height <= 0) return {
		x: 0,
		y: 0,
		zoom: 1
	};
	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const rect of rects) {
		left = Math.min(left, rect.x);
		top = Math.min(top, rect.y);
		right = Math.max(right, rect.x + rect.width);
		bottom = Math.max(bottom, rect.y + rect.height);
	}
	const width = Math.max(1, right - left + padding * 2);
	const height = Math.max(1, bottom - top + padding * 2);
	const zoom = clampZoom(Math.min(viewport.width / width, viewport.height / height));
	return {
		zoom,
		x: (left + right) / 2 - viewport.width / (2 * zoom),
		y: (top + bottom) / 2 - viewport.height / (2 * zoom)
	};
}
/**
* Where to drop a new node: just right of the right-most node, keeping its top
* edge aligned with the top-most one.
*
* The point is that a fresh result is always visible without the user hunting
* for it, and two results never land on top of each other.
*/
function nextNodeSpot(rects) {
	if (rects.length === 0) return {
		x: 0,
		y: 0
	};
	let right = Number.NEGATIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	for (const rect of rects) {
		right = Math.max(right, rect.x + rect.width);
		top = Math.min(top, rect.y);
	}
	return {
		x: right + 40,
		y: top
	};
}
/**
* `<path d>` for an edge from the right edge of `from` to the left edge of `to`.
*
* A cubic with horizontal control points reads as a wire rather than a slash
* whenever the two nodes are on the same row, which is the common case.
*/
function edgePath(from, to) {
	const x1 = from.x + from.width;
	const y1 = from.y + from.height / 2;
	const x2 = to.x;
	const y2 = to.y + to.height / 2;
	const reach = Math.max(40, Math.abs(x2 - x1) * .45);
	return `M ${round(x1)} ${round(y1)} C ${round(x1 + reach)} ${round(y1)}, ${round(x2 - reach)} ${round(y2)}, ${round(x2)} ${round(y2)}`;
}
/** Zoom as a percentage label, e.g. `120%`. */
function zoomLabel(zoom) {
	return `${String(Math.round(zoom * 100))}%`;
}
function round(value) {
	return Math.round(value * 100) / 100;
}
//#endregion
//#region src/studio-view.ts
/**
* The Studio panel: a ComfyUI-backed Qwen-Image workbench rendered inside the
* plugin's settings section.
*
* ## Why the settings section is the surface
*
* The ideal home is the right sidebar's pane-tab seat, but that slot belongs to
* `@deepseek-ai/dsh-client-ui-sidebar-right`, which a profile does not
* necessarily install. The settings section (`settings.section`) is a **list**
* slot every 0.1.x/0.2.x host provides, so it is the one seat that is always
* there. The panel therefore renders as a full-height workbench page inside the
* plugin's own settings entry rather than pretending to be a chat-side panel.
*
* ## Deliberately not ported
*
* The reference Studio ships a tldraw infinite canvas and a multi-provider
* comparison grid. Neither is copied here. The canvas needs `tldraw` (a ~1 MB
* client dependency) and answers a question this workbench does not ask — where
* images sit on a board — while comparison needs several providers, and this
* Studio intentionally has exactly one. What *is* kept is the working loop:
* prompt → optimise → ratio/steps/references → generate → inspect → reuse.
*
* ## State discipline
*
* One `useState` per concern, no derived state stored, and the generated image
* list is the only thing that survives a re-render of the form. Every request
* carries an `AbortController` so closing the panel does not leave a GPU busy
* for a result nobody will see.
*
* @module studio-view
*/
/** World-space rectangle a node occupies. */
function nodeRect(node) {
	return {
		x: node.x,
		y: node.y,
		width: 208,
		height: 240
	};
}
/** Grid a board item lands on when it was never placed. Mirrors the host store. */
function fallbackSpot(index) {
	return {
		x: 40 + index % 3 * 244,
		y: 40 + Math.floor(index / 3) * 276
	};
}
/** Turn stored board items into canvas nodes, keeping the saved arrangement. */
function nodesFromBoard(items) {
	return items.map((item, index) => {
		const spot = fallbackSpot(index);
		return {
			id: item.id,
			image: {
				id: item.id,
				path: item.path,
				markdownPath: item.markdownPath,
				width: item.width,
				height: item.height,
				bytes: item.bytes,
				mediaType: item.mediaType
			},
			batchId: item.batchId,
			x: item.x ?? spot.x,
			y: item.y ?? spot.y,
			parents: item.parents
		};
	});
}
/**
* Rebuild the list view from stored items.
*
* A board round-trips through JSON, so the list has to be reconstructed from
* what each item kept: one batch per `batchId`, with the first item's prompt and
* canvas standing in for the whole run (they are equal by construction — one
* request writes one size, one step count, one prompt).
*/
function batchesFromBoard(items) {
	const grouped = /* @__PURE__ */ new Map();
	for (const item of items) {
		const list = grouped.get(item.batchId);
		if (list === void 0) grouped.set(item.batchId, [item]);
		else list.push(item);
	}
	return [...grouped.entries()].map(([id, list]) => {
		const first = list[0];
		return {
			id,
			response: {
				images: list.map((item) => ({
					id: item.id,
					path: item.path,
					markdownPath: item.markdownPath,
					width: item.width,
					height: item.height,
					bytes: item.bytes,
					mediaType: item.mediaType
				})),
				prompt: first?.prompt ?? "",
				ratio: first?.ratio ?? "1:1",
				width: first?.width ?? 0,
				height: first?.height ?? 0,
				steps: first?.steps ?? 0,
				seed: first?.seed ?? 0,
				elapsedMs: 0,
				endpoint: "",
				mode: first?.mode ?? "generate"
			}
		};
	}).reverse();
}
/** Read a JSON body defensively: a proxy error page is not JSON. */
async function readJson(response) {
	try {
		const value = await response.json();
		return typeof value === "object" && value !== null ? value : void 0;
	} catch {
		return;
	}
}
/** Base64 of a file's bytes, without a data-URL prefix. */
function toBase64(bytes) {
	let binary = "";
	const step = 32768;
	for (let offset = 0; offset < bytes.length; offset += step) binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
	return btoa(binary);
}
/** Container from a file's MIME type, falling back to its extension. */
function mediaTypeOf(file) {
	if (file.type.startsWith("image/")) return file.type;
	const lower = file.name.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	return "image/png";
}
/** Put a board back into the list after a write, keeping it newest-first. */
function upsertBoard(list, board) {
	return [board, ...list.filter((entry) => entry.id !== board.id)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
/** One board mutation; resolves to the host's refusal message, if any. */
async function postBoard(body) {
	try {
		const response = await fetch(STUDIO_BOARD_ROUTE, {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body)
		});
		const payload = await readJson(response);
		if (response.ok) return void 0;
		return typeof payload?.error === "string" ? payload.error : `画板操作失败（HTTP ${String(response.status)}）`;
	} catch (cause) {
		return cause instanceof Error ? cause.message : String(cause);
	}
}
/**
* Render the workbench.
*
* @returns the panel tree; every fetch is same-origin and cancellable.
*/
function StudioPanel() {
	const [config, setConfig] = (0, react.useState)(void 0);
	const [configError, setConfigError] = (0, react.useState)(void 0);
	const [prompt, setPrompt] = (0, react.useState)("");
	const [ratio, setRatio] = (0, react.useState)("1:1");
	const [steps, setSteps] = (0, react.useState)("");
	const [count, setCount] = (0, react.useState)(1);
	const [references, setReferences] = (0, react.useState)([]);
	const [batches, setBatches] = (0, react.useState)([]);
	const [selectedId, setSelectedId] = (0, react.useState)(void 0);
	const [busy, setBusy] = (0, react.useState)(false);
	const [optimizing, setOptimizing] = (0, react.useState)(false);
	const [note, setNote] = (0, react.useState)(void 0);
	const [error, setError] = (0, react.useState)(void 0);
	const [optimizeNote, setOptimizeNote] = (0, react.useState)(void 0);
	const [promptStyle, setPromptStyle] = (0, react.useState)("prose");
	const [view, setView] = (0, react.useState)("canvas");
	const [nodes, setNodes] = (0, react.useState)([]);
	const [camera, setCamera] = (0, react.useState)({
		x: -28,
		y: -28,
		zoom: 1
	});
	const [selectedNodeId, setSelectedNodeId] = (0, react.useState)(void 0);
	const canvasRef = (0, react.useRef)(null);
	const gestureRef = (0, react.useRef)(void 0);
	const [boards, setBoards] = (0, react.useState)([]);
	const [boardId, setBoardId] = (0, react.useState)(void 0);
	const [boardName, setBoardName] = (0, react.useState)("");
	const [boardBusy, setBoardBusy] = (0, react.useState)(false);
	const [boardError, setBoardError] = (0, react.useState)(void 0);
	const [renaming, setRenaming] = (0, react.useState)(false);
	const [renameValue, setRenameValue] = (0, react.useState)("");
	const [assetScope, setAssetScope] = (0, react.useState)("board");
	const [assetQuery, setAssetQuery] = (0, react.useState)("");
	const [assets, setAssets] = (0, react.useState)([]);
	const [assetsTotal, setAssetsTotal] = (0, react.useState)(0);
	const [assetsBusy, setAssetsBusy] = (0, react.useState)(false);
	const abortRef = (0, react.useRef)(void 0);
	const referencesRef = (0, react.useRef)([]);
	referencesRef.current = references;
	const nodesRef = (0, react.useRef)([]);
	nodesRef.current = nodes;
	const boardIdRef = (0, react.useRef)(void 0);
	boardIdRef.current = boardId;
	const cameraRef = (0, react.useRef)(camera);
	cameraRef.current = camera;
	const layoutTimer = (0, react.useRef)(void 0);
	/** Read one board off the host and make it the canvas. */
	const openBoard = (0, react.useCallback)(async (id, signal) => {
		if (id === void 0) {
			setBoardId(void 0);
			setBoardName("");
			setNodes([]);
			setBatches([]);
			setSelectedId(void 0);
			setSelectedNodeId(void 0);
			return;
		}
		setBoardBusy(true);
		try {
			const response = await fetch(`${STUDIO_BOARD_ROUTE}?board=${encodeURIComponent(id)}`, {
				credentials: "same-origin",
				signal
			});
			const payload = await readJson(response);
			if (!response.ok || payload === void 0 || !Array.isArray(payload.items)) {
				setBoardError(typeof payload?.error === "string" ? payload.error : "画板读取失败");
				return;
			}
			const board = payload;
			const loaded = nodesFromBoard(board.items);
			setBoardId(board.id);
			setBoardName(board.name);
			setNodes(loaded);
			nodesRef.current = loaded;
			const restored = batchesFromBoard(board.items);
			setBatches(restored);
			setSelectedId(restored[0]?.id);
			setSelectedNodeId(void 0);
			setCamera(board.camera ?? {
				x: -28,
				y: -28,
				zoom: 1
			});
			setBoardError(void 0);
		} catch (cause) {
			if (signal?.aborted !== true) setBoardError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBoardBusy(false);
		}
	}, []);
	/** Load (or reload) the capability snapshot, and the board library with it. */
	const loadConfig = (0, react.useCallback)(async (signal) => {
		try {
			const response = await fetch(STUDIO_CONFIG_ROUTE, {
				credentials: "same-origin",
				signal
			});
			const payload = await readJson(response);
			if (!response.ok || payload === void 0 || !("ready" in payload)) {
				setConfigError(typeof payload?.error === "string" ? payload.error : `工作台不可用（HTTP ${String(response.status)}）`);
				return;
			}
			const snapshot = payload;
			setConfig(snapshot);
			setConfigError(void 0);
			setBoards(snapshot.boards ?? []);
			setSteps((current) => current.length > 0 ? current : String(snapshot.defaultSteps));
			await openBoard(snapshot.activeBoard ?? void 0, signal);
		} catch (cause) {
			if (signal?.aborted === true) return;
			setConfigError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [openBoard]);
	(0, react.useEffect)(() => {
		const controller = new AbortController();
		loadConfig(controller.signal);
		return () => {
			controller.abort();
			if (layoutTimer.current !== void 0) clearTimeout(layoutTimer.current);
			for (const reference of referencesRef.current) URL.revokeObjectURL(reference.previewUrl);
		};
	}, [loadConfig]);
	const selectedBatch = (0, react.useMemo)(() => batches.find((batch) => batch.id === selectedId) ?? batches[0], [batches, selectedId]);
	const sizeFor = (0, react.useMemo)(() => {
		const table = config?.sizes ?? [];
		return (value) => table.find((entry) => entry.ratio === value);
	}, [config]);
	/** Write the current arrangement back to the board. Best-effort. */
	const persistLayout = (0, react.useCallback)(async () => {
		const id = boardIdRef.current;
		if (id === void 0) return;
		const error = await postBoard({
			action: "layout",
			board: id,
			items: nodesRef.current.map((node) => ({
				id: node.id,
				x: node.x,
				y: node.y
			})),
			camera: cameraRef.current
		});
		if (error !== void 0) setBoardError(error);
	}, []);
	/**
	* Coalesce layout saves.
	*
	* Dragging emits a pointer event per move; writing the board on every one
	* would be a JSON file per frame. 700 ms is short enough that closing the tab
	* right after a drag still lands, long enough that a whole drag is one write.
	*/
	const scheduleLayout = (0, react.useCallback)(() => {
		if (layoutTimer.current !== void 0) clearTimeout(layoutTimer.current);
		layoutTimer.current = setTimeout(() => {
			layoutTimer.current = void 0;
			persistLayout();
		}, 700);
	}, [persistLayout]);
	(0, react.useEffect)(() => () => {
		if (layoutTimer.current !== void 0) {
			clearTimeout(layoutTimer.current);
			persistLayout();
		}
	}, [persistLayout]);
	/** Switch boards: read it, then remember the choice server-side. */
	const selectBoard = (0, react.useCallback)(async (id) => {
		if (id === boardIdRef.current) return;
		await openBoard(id);
		postBoard({
			action: "active",
			board: id
		});
	}, [openBoard]);
	/** Create an empty board and open it. */
	const createBoard = (0, react.useCallback)(async () => {
		const error = await postBoard({ action: "create" });
		if (error !== void 0) {
			setBoardError(error);
			return;
		}
		const response = await fetch(STUDIO_CONFIG_ROUTE, { credentials: "same-origin" });
		const payload = await readJson(response);
		if (response.ok && payload !== void 0) {
			const snapshot = payload;
			setBoards(snapshot.boards ?? []);
			await openBoard(snapshot.activeBoard ?? void 0);
		}
	}, [openBoard]);
	/** Commit the rename editor. */
	const commitRename = (0, react.useCallback)(async () => {
		const id = boardIdRef.current;
		const name = renameValue.trim();
		if (id === void 0 || name.length === 0) {
			setRenaming(false);
			return;
		}
		const error = await postBoard({
			action: "rename",
			board: id,
			name
		});
		if (error !== void 0) {
			setBoardError(error);
			return;
		}
		setBoardName(name);
		setBoards((current) => current.map((board) => board.id === id ? {
			...board,
			name
		} : board));
		setRenaming(false);
	}, [renameValue]);
	/** Read the asset page for the current scope and filter. */
	const loadAssets = (0, react.useCallback)(async (signal) => {
		setAssetsBusy(true);
		try {
			const params = new URLSearchParams();
			if (assetScope === "board" && boardIdRef.current !== void 0) params.set("board", boardIdRef.current);
			if (assetQuery.trim().length > 0) params.set("q", assetQuery.trim());
			const response = await fetch(`${STUDIO_ASSETS_ROUTE}?${params.toString()}`, {
				credentials: "same-origin",
				signal
			});
			const payload = await readJson(response);
			if (!response.ok || payload === void 0 || !Array.isArray(payload.assets)) {
				setBoardError(typeof payload?.error === "string" ? payload.error : "素材读取失败");
				return;
			}
			const page = payload;
			setAssets(page.assets);
			setAssetsTotal(page.total);
			setBoards(page.boards);
		} catch (cause) {
			if (!signal.aborted) setBoardError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setAssetsBusy(false);
		}
	}, [assetScope, assetQuery]);
	(0, react.useEffect)(() => {
		if (view !== "assets") return void 0;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			loadAssets(controller.signal);
		}, 220);
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [
		view,
		boardId,
		assetScope,
		assetQuery,
		loadAssets
	]);
	/** Cancel whatever is in flight; safe to call when nothing is. */
	const cancel = (0, react.useCallback)(() => {
		abortRef.current?.abort();
		abortRef.current = void 0;
		setBusy(false);
		setOptimizing(false);
	}, []);
	/** Add picked files to the reference row, honouring the count cap. */
	const addReferences = (0, react.useCallback)((event) => {
		const picked = [...event.target.files ?? []];
		event.target.value = "";
		if (picked.length === 0) return;
		Promise.all(picked.map(async (file) => {
			const bytes = new Uint8Array(await file.arrayBuffer());
			return {
				id: `${file.name}-${String(file.size)}-${String(Date.now())}-${Math.random().toString(36).slice(2, 7)}`,
				name: file.name,
				previewUrl: URL.createObjectURL(file),
				payload: {
					data: toBase64(bytes),
					mediaType: mediaTypeOf(file),
					name: file.name
				}
			};
		})).then((added) => {
			setReferences((current) => {
				const room = 10 - current.length;
				if (room <= 0) {
					for (const reference of added) URL.revokeObjectURL(reference.previewUrl);
					setError(`最多 ${String(10)} 张参考图`);
					return current;
				}
				if (added.length > room) setError(`最多 ${String(10)} 张参考图，多出的已忽略`);
				for (const reference of added.slice(room)) URL.revokeObjectURL(reference.previewUrl);
				return [...current, ...added.slice(0, room)];
			});
		});
	}, []);
	/** Drop one reference and free its preview URL. */
	const removeReference = (0, react.useCallback)((id) => {
		setReferences((current) => {
			const target = current.find((entry) => entry.id === id);
			if (target !== void 0) URL.revokeObjectURL(target.previewUrl);
			return current.filter((entry) => entry.id !== id);
		});
	}, []);
	/** Ask the conversation model to rewrite the prompt in place, keeping the original recoverable. */
	const optimize = (0, react.useCallback)(async () => {
		const text = prompt.trim();
		if (text.length === 0) {
			setError("先写一句你想要什么，再点优化。");
			return;
		}
		setOptimizing(true);
		setError(void 0);
		setOptimizeNote(void 0);
		const controller = new AbortController();
		abortRef.current = controller;
		try {
			const response = await fetch(STUDIO_OPTIMIZE_ROUTE, {
				method: "POST",
				credentials: "same-origin",
				signal: controller.signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					prompt: text,
					editing: references.length > 0,
					ratio,
					style: promptStyle
				})
			});
			const payload = await readJson(response);
			if (!response.ok || payload === void 0) {
				setError(typeof payload?.error === "string" ? payload.error : "优化失败");
				return;
			}
			const result = payload;
			if (typeof result.prompt === "string" && result.prompt.length > 0) setPrompt(result.prompt);
			const parts = [result.note, result.model === void 0 ? void 0 : `由 ${result.model} 改写`].filter((part) => typeof part === "string" && part.length > 0);
			setOptimizeNote(parts.length > 0 ? parts.join(" · ") : void 0);
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setOptimizing(false);
			if (abortRef.current === controller) abortRef.current = void 0;
		}
	}, [
		prompt,
		references.length,
		ratio,
		promptStyle
	]);
	/** Run one generation with the form's current values. */
	const generate = (0, react.useCallback)(async () => {
		const text = prompt.trim();
		if (text.length === 0) {
			setError("请输入提示词");
			return;
		}
		setBusy(true);
		setError(void 0);
		setNote(void 0);
		const controller = new AbortController();
		abortRef.current = controller;
		try {
			const parsedSteps = steps.trim().length > 0 ? Number(steps) : void 0;
			const payload = await readJson(await fetch(STUDIO_GENERATE_ROUTE, {
				method: "POST",
				credentials: "same-origin",
				signal: controller.signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					prompt: text,
					ratio,
					...parsedSteps === void 0 || !Number.isFinite(parsedSteps) ? {} : { steps: parsedSteps },
					count,
					...references.length > 0 ? { references: references.map((entry) => entry.payload) } : {},
					...boardIdRef.current === void 0 ? {} : { board: boardIdRef.current }
				})
			}));
			if (payload === void 0) {
				setError("生成失败：响应不是有效的 JSON");
				return;
			}
			if (!Array.isArray(payload.images)) {
				setError(typeof payload.error === "string" ? payload.error : "生成失败");
				return;
			}
			const result = payload;
			const batch = {
				id: `${String(result.elapsedMs)}-${String(Date.now())}`,
				response: result
			};
			setBatches((current) => [batch, ...current].slice(0, 12));
			setSelectedId(batch.id);
			setNote(`${String(result.width)}×${String(result.height)} · ${String(result.steps)} 步 · seed ${String(result.seed)} · ${(result.elapsedMs / 1e3).toFixed(1)} 秒`);
			if (result.board !== void 0) {
				setBoards((current) => upsertBoard(current, result.board));
				if (boardIdRef.current !== result.board.id) {
					setBoardId(result.board.id);
					setBoardName(result.board.name);
					boardIdRef.current = result.board.id;
				}
			}
			const parents = references.map((entry) => entry.nodeId).filter((id) => typeof id === "string");
			const created = [];
			const next = [...nodesRef.current];
			result.images.forEach((image) => {
				const spot = nextNodeSpot(next.map(nodeRect));
				const node = {
					id: image.id,
					image,
					batchId: batch.id,
					x: spot.x,
					y: spot.y,
					parents
				};
				created.push(node);
				next.push(node);
			});
			setNodes(next);
			nodesRef.current = next;
			scheduleLayout();
			if (created[0] !== void 0) {
				const first = created[0];
				setSelectedNodeId(first.id);
				const element = canvasRef.current;
				if (element !== null) {
					const box = element.getBoundingClientRect();
					setCamera((current) => {
						const visible = {
							left: current.x,
							top: current.y,
							right: current.x + box.width / current.zoom,
							bottom: current.y + box.height / current.zoom
						};
						return first.x < visible.right - 83.2 && first.y < visible.bottom - 96 && first.y > visible.top - 144 ? current : {
							zoom: current.zoom,
							x: first.x - 28,
							y: first.y - 28
						};
					});
				}
			}
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
			if (abortRef.current === controller) abortRef.current = void 0;
		}
	}, [
		prompt,
		ratio,
		steps,
		count,
		references,
		scheduleLayout
	]);
	/** Put a finished image's prompt and settings back into the form. */
	const reuse = (0, react.useCallback)((batch) => {
		setPrompt(batch.response.prompt);
		setRatio(batch.response.ratio);
		setSteps(String(batch.response.steps));
		setSelectedId(batch.id);
	}, []);
	(0, react.useEffect)(() => {
		const element = canvasRef.current;
		if (element === null || view !== "canvas") return;
		const onWheel = (event) => {
			event.preventDefault();
			const box = element.getBoundingClientRect();
			const anchor = {
				x: event.clientX - box.left,
				y: event.clientY - box.top
			};
			setCamera((current) => zoomAt(current, event.deltaY < 0 ? 1.12 : 1 / 1.12, anchor));
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			element.removeEventListener("wheel", onWheel);
		};
	}, [view]);
	/** Frame every node; a no-op on an empty canvas so the view never jumps. */
	const fitView = (0, react.useCallback)(() => {
		const element = canvasRef.current;
		if (element === null) return;
		const box = element.getBoundingClientRect();
		setCamera(fitCamera(nodes.map(nodeRect), {
			width: box.width,
			height: box.height
		}));
		scheduleLayout();
	}, [nodes, scheduleLayout]);
	const onCanvasPointerDown = (0, react.useCallback)((event) => {
		if (event.button !== 0) return;
		if (event.target.closest(".dsh-forge-node") !== null) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		gestureRef.current = {
			kind: "pan",
			startX: event.clientX,
			startY: event.clientY,
			camera
		};
		setSelectedNodeId(void 0);
	}, [camera]);
	const onNodePointerDown = (0, react.useCallback)((event, node) => {
		if (event.button !== 0) return;
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		setSelectedNodeId(node.id);
		gestureRef.current = {
			kind: "node",
			id: node.id,
			startX: event.clientX,
			startY: event.clientY,
			origin: {
				x: node.x,
				y: node.y
			}
		};
	}, []);
	const onCanvasPointerMove = (0, react.useCallback)((event) => {
		const gesture = gestureRef.current;
		if (gesture === void 0) return;
		if (gesture.kind === "pan") {
			setCamera(panBy(gesture.camera, {
				x: event.clientX - gesture.startX,
				y: event.clientY - gesture.startY
			}));
			return;
		}
		const dx = (event.clientX - gesture.startX) / camera.zoom;
		const dy = (event.clientY - gesture.startY) / camera.zoom;
		setNodes((current) => current.map((node) => node.id === gesture.id ? {
			...node,
			x: gesture.origin.x + dx,
			y: gesture.origin.y + dy
		} : node));
	}, [camera.zoom]);
	const endGesture = (0, react.useCallback)(() => {
		const gesture = gestureRef.current;
		gestureRef.current = void 0;
		if (gesture !== void 0) scheduleLayout();
	}, [scheduleLayout]);
	/** Hand a canvas result back to the form as an edit reference. */
	const referenceNode = (0, react.useCallback)((node) => {
		setReferences((current) => {
			if (current.length >= 10) return current;
			if (current.some((entry) => entry.nodeId === node.id)) return current;
			const name = node.image.path.split("/").pop() ?? "参考图";
			return [...current, {
				id: `${node.id}-ref`,
				name,
				previewUrl: studioFileUrl(node.image.markdownPath),
				payload: {
					path: node.image.path,
					mediaType: node.image.mediaType,
					name
				},
				nodeId: node.id
			}];
		});
	}, []);
	/** Zoom around the viewport centre, for the toolbar buttons. */
	const zoomBy = (0, react.useCallback)((factor) => {
		const element = canvasRef.current;
		if (element === null) {
			setCamera((current) => ({
				...current,
				zoom: clampZoom(current.zoom * factor)
			}));
			scheduleLayout();
			return;
		}
		const box = element.getBoundingClientRect();
		setCamera((current) => zoomAt(current, factor, {
			x: box.width / 2,
			y: box.height / 2
		}));
		scheduleLayout();
	}, [scheduleLayout]);
	/** Put one asset from the library into the reference row. */
	const referenceAsset = (0, react.useCallback)((asset) => {
		setReferences((current) => {
			if (current.length >= 10) return current;
			if (current.some((entry) => entry.path === asset.path)) return current;
			const name = asset.path.split("/").pop() ?? "参考图";
			return [...current, {
				id: `${asset.id}-ref`,
				name,
				previewUrl: studioFileUrl(asset.markdownPath),
				payload: {
					path: asset.path,
					mediaType: asset.mediaType,
					name
				}
			}];
		});
	}, []);
	/** Open the board an asset lives on and select it there. */
	const showOnCanvas = (0, react.useCallback)(async (asset) => {
		if (boardIdRef.current !== asset.boardId) await selectBoard(asset.boardId);
		setView("canvas");
		setSelectedNodeId(asset.id);
	}, [selectBoard]);
	/**
	* Drop one asset from its board.
	*
	* The default is "unplace", not "delete": the PNG is the expensive artifact
	* and every removal here is one click away from being irreversible. Deleting
	* the file is a second, explicitly labelled action.
	*/
	const removeAsset = (0, react.useCallback)(async (asset, deleteFile) => {
		const error = await postBoard({
			action: "remove-item",
			board: asset.boardId,
			item: asset.id,
			...deleteFile ? { deleteFile: true } : {}
		});
		if (error !== void 0) {
			setBoardError(error);
			return;
		}
		setAssets((current) => current.filter((entry) => entry.id !== asset.id));
		setAssetsTotal((total) => Math.max(0, total - 1));
		const dropFromNodes = (current) => current.filter((node) => node.id !== asset.id);
		setNodes(dropFromNodes);
		nodesRef.current = dropFromNodes(nodesRef.current);
		setBatches((current) => current.map((batch) => ({
			...batch,
			response: {
				...batch.response,
				images: batch.response.images.filter((image) => image.id !== asset.id)
			}
		})).filter((batch) => batch.response.images.length > 0));
		setSelectedNodeId((current) => current === asset.id ? void 0 : current);
		setReferences((current) => current.filter((entry) => !(entry.payload.path === asset.path)));
	}, []);
	const removeNode = (0, react.useCallback)((id) => {
		setNodes((current) => current.filter((node) => node.id !== id));
		nodesRef.current = nodesRef.current.filter((node) => node.id !== id);
		setReferences((current) => current.filter((entry) => entry.nodeId !== id));
		setSelectedNodeId((current) => current === id ? void 0 : current);
		const board = boardIdRef.current;
		if (board === void 0) return;
		postBoard({
			action: "remove-item",
			board,
			item: id
		}).then((error) => {
			if (error !== void 0) setBoardError(error);
		});
	}, []);
	const ready = config?.ready === true;
	const canGenerate = ready && !busy && prompt.trim().length > 0;
	/**
	* The asset page: one grid over every image the plugin has recorded, with the
	* three actions that matter after the fact — reuse it as a reference, jump to
	* it on its canvas, or take it out of the library.
	*/
	const assetsPanel = (0, react.createElement)("div", { className: "dsh-forge-assets" }, (0, react.createElement)("div", { className: "dsh-forge-assets-bar" }, (0, react.createElement)("div", {
		className: "dsh-forge-view-toggle",
		role: "group",
		"aria-label": "素材范围"
	}, ...[["board", "本画板"], ["all", "全部画板"]].map(([value, label]) => (0, react.createElement)("button", {
		key: value,
		type: "button",
		className: assetScope === value ? "dsh-forge-view-item is-active" : "dsh-forge-view-item",
		"aria-pressed": assetScope === value,
		onClick: () => {
			setAssetScope(value);
		}
	}, label))), (0, react.createElement)("input", {
		className: "dsh-forge-assets-search",
		value: assetQuery,
		placeholder: "搜提示词、文件名或画板名",
		onChange: (event) => {
			setAssetQuery(event.target.value);
		}
	}), (0, react.createElement)("span", { className: "dsh-forge-batch-meta" }, `${String(assetsTotal)} 张`), (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-btn is-ghost",
		onClick: () => {
			const controller = new AbortController();
			loadAssets(controller.signal);
		}
	}, "刷新")), assets.length === 0 ? (0, react.createElement)("div", { className: "dsh-forge-studio-empty" }, assetsBusy ? "读取中…" : assetQuery.trim().length > 0 ? "没有匹配的素材" : assetScope === "board" ? "这个画板还没有素材。生成后会按画板自动记录。" : "还没有素材。对话或工作台出的图都会记进画板。") : (0, react.createElement)("div", { className: "dsh-forge-assets-grid" }, ...assets.map((asset) => (0, react.createElement)("div", {
		key: `${asset.boardId}:${asset.id}`,
		className: "dsh-forge-asset"
	}, (0, react.createElement)("a", {
		className: "dsh-forge-asset-thumb",
		href: studioFileUrl(asset.markdownPath),
		target: "_blank",
		rel: "noreferrer",
		title: asset.path
	}, (0, react.createElement)("img", {
		src: studioFileUrl(asset.markdownPath),
		alt: "素材",
		loading: "lazy"
	})), (0, react.createElement)("div", { className: "dsh-forge-asset-meta" }, `${String(asset.width)}×${String(asset.height)} · ${String(Math.round(asset.bytes / 1024))} KB · ${asset.mode === "edit" ? "改图" : "文生图"}`), (0, react.createElement)("div", {
		className: "dsh-forge-asset-meta",
		title: `${asset.boardName} · ${asset.createdAt}`
	}, `${asset.boardName} · ${asset.createdAt.slice(0, 16).replace("T", " ")}`), asset.prompt.length === 0 ? null : (0, react.createElement)("div", {
		className: "dsh-forge-asset-prompt",
		title: asset.prompt
	}, asset.prompt), (0, react.createElement)("div", { className: "dsh-forge-asset-actions" }, (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-asset-btn",
		title: "放进参考图，下一轮按它改",
		onClick: () => {
			referenceAsset(asset);
		}
	}, "用作参考"), (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-asset-btn",
		title: "切到它所在的画板并选中",
		onClick: () => {
			showOnCanvas(asset);
		}
	}, "定位"), (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-asset-btn",
		title: "只从画板移除，文件留在磁盘",
		onClick: () => {
			removeAsset(asset, false);
		}
	}, "移除"), (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-asset-btn is-danger",
		title: "从画板移除并删除 PNG 文件",
		onClick: () => {
			if (!window.confirm("同时删除磁盘上的这个 PNG？此操作不可撤销。")) return;
			removeAsset(asset, true);
		}
	}, "删文件"))))));
	return (0, react.createElement)("div", { className: "dsh-image-forge-studio" }, (0, react.createElement)("div", { className: "dsh-forge-studio-head" }, (0, react.createElement)("h2", { className: "dsh-forge-studio-title" }, "图像工作台"), (0, react.createElement)("div", { className: "dsh-forge-studio-status" }, (0, react.createElement)("span", { className: ready ? "dsh-forge-dot is-ok" : "dsh-forge-dot is-bad" }), (0, react.createElement)("span", { className: "dsh-forge-studio-endpoint" }, ready ? `ComfyUI ${config?.endpoint ?? ""}` : "ComfyUI 未就绪"), (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-btn is-ghost",
		onClick: () => {
			loadConfig();
		}
	}, "重新检测"))), (0, react.createElement)("div", { className: "dsh-forge-board-bar" }, (0, react.createElement)("span", { className: "dsh-forge-board-label" }, "画板"), renaming ? [
		(0, react.createElement)("input", {
			key: "name",
			className: "dsh-forge-board-input",
			value: renameValue,
			autoFocus: true,
			maxLength: 40,
			onChange: (event) => {
				setRenameValue(event.target.value);
			},
			onKeyDown: (event) => {
				if (event.key === "Enter") commitRename();
				if (event.key === "Escape") setRenaming(false);
			}
		}),
		(0, react.createElement)("button", {
			key: "save",
			type: "button",
			className: "dsh-forge-btn is-ghost",
			onClick: () => {
				commitRename();
			}
		}, "保存"),
		(0, react.createElement)("button", {
			key: "cancel",
			type: "button",
			className: "dsh-forge-btn is-ghost",
			onClick: () => {
				setRenaming(false);
			}
		}, "取消")
	] : [
		(0, react.createElement)("select", {
			key: "select",
			className: "dsh-forge-board-select",
			value: boardId ?? "",
			disabled: boardBusy,
			onChange: (event) => {
				selectBoard(event.target.value);
			}
		}, ...boards.length === 0 ? [(0, react.createElement)("option", {
			key: "none",
			value: ""
		}, "（还没有画板，出图会自动建一个）")] : boards.map((board) => (0, react.createElement)("option", {
			key: board.id,
			value: board.id
		}, `${board.name} · ${String(board.itemCount)} 张`))),
		(0, react.createElement)("button", {
			key: "rename",
			type: "button",
			className: "dsh-forge-btn is-ghost",
			disabled: boardId === void 0,
			onClick: () => {
				setRenameValue(boardName);
				setRenaming(true);
			}
		}, "重命名"),
		(0, react.createElement)("button", {
			key: "create",
			type: "button",
			className: "dsh-forge-btn is-ghost",
			onClick: () => {
				createBoard();
			}
		}, "新建")
	], (0, react.createElement)("span", { className: "dsh-forge-board-count" }, boardBusy ? "读取中…" : boardId === void 0 ? "出图会新建画板" : `${String(nodes.length)} 张 · 自动保存`)), configError === void 0 ? null : (0, react.createElement)("div", { className: "dsh-forge-studio-alert" }, configError), boardError === void 0 ? null : (0, react.createElement)("div", { className: "dsh-forge-studio-alert" }, boardError), ready || config === void 0 ? null : (0, react.createElement)("div", { className: "dsh-forge-studio-alert" }, "工作台需要本机正在运行的 ComfyUI 与 Qwen-Image 2.1 权重（unet / clip / vae）。", config.reason === void 0 ? null : (0, react.createElement)("div", { className: "dsh-forge-studio-hint" }, config.reason)), (0, react.createElement)("div", { className: "dsh-forge-studio-body" }, (0, react.createElement)("div", { className: "dsh-forge-studio-form" }, (0, react.createElement)("div", { className: "dsh-forge-field" }, (0, react.createElement)("div", { className: "dsh-forge-field-head" }, (0, react.createElement)("label", { className: "dsh-forge-label" }, references.length > 0 ? "改图描述" : "画面描述"), (0, react.createElement)("div", { className: "dsh-forge-field-actions" }, (0, react.createElement)("div", {
		className: "dsh-forge-mode",
		role: "group",
		"aria-label": "改写风格"
	}, ...[[
		"prose",
		"长散文",
		"一段约 20 句的观察性描写，禁画质空话"
	], [
		"formula",
		"关键词",
		"官方公式：主体+场景+风格+镜头+氛围+细节"
	]].map(([value, label, hint]) => (0, react.createElement)("button", {
		key: value,
		type: "button",
		className: promptStyle === value ? "dsh-forge-mode-item is-active" : "dsh-forge-mode-item",
		title: hint,
		"aria-pressed": promptStyle === value,
		onClick: () => {
			setPromptStyle(value);
		}
	}, label))), (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-btn is-ghost",
		disabled: optimizing || prompt.trim().length === 0 || config?.optimizeAvailable !== true,
		title: config?.optimizeAvailable === true ? `用当前对话模型（${config?.optimizeModel ?? "默认模型"}）改成${promptStyle === "formula" ? "关键词公式" : "长散文"}` : "当前会话没有可用的对话模型",
		onClick: () => {
			optimize();
		}
	}, optimizing ? "优化中…" : "优化提示词"))), (0, react.createElement)("textarea", {
		className: "dsh-forge-textarea",
		value: prompt,
		placeholder: "描述你想要的画面。写完可以点「优化提示词」，让对话模型按 Qwen-Image 的写法改写一遍再生成。",
		maxLength: STUDIO_MAX_PROMPT_CHARS,
		rows: 6,
		onChange: (event) => {
			setPrompt(event.target.value);
		}
	}), optimizeNote === void 0 ? null : (0, react.createElement)("div", { className: "dsh-forge-studio-hint" }, optimizeNote)), (0, react.createElement)("div", { className: "dsh-forge-field" }, (0, react.createElement)("label", { className: "dsh-forge-label" }, "画幅比例"), (0, react.createElement)("div", { className: "dsh-forge-ratio-row" }, ...STUDIO_RATIOS.map((value) => {
		const size = sizeFor(value);
		return (0, react.createElement)("button", {
			key: value,
			type: "button",
			className: value === ratio ? "dsh-forge-ratio is-active" : "dsh-forge-ratio",
			onClick: () => {
				setRatio(value);
			}
		}, (0, react.createElement)("span", { className: "dsh-forge-ratio-label" }, value), (0, react.createElement)("span", { className: "dsh-forge-ratio-size" }, size === void 0 ? "" : `${String(size.width)}×${String(size.height)}`));
	}))), (0, react.createElement)("div", { className: "dsh-forge-field-row" }, (0, react.createElement)("div", { className: "dsh-forge-field" }, (0, react.createElement)("label", { className: "dsh-forge-label" }, "采样步数"), (0, react.createElement)("input", {
		className: "dsh-forge-input",
		type: "number",
		min: 1,
		max: 200,
		value: steps,
		placeholder: config === void 0 ? "" : `默认 ${String(config.defaultSteps)}`,
		onChange: (event) => {
			setSteps(event.target.value);
		}
	})), (0, react.createElement)("div", { className: "dsh-forge-field" }, (0, react.createElement)("label", { className: "dsh-forge-label" }, "出图张数"), (0, react.createElement)("input", {
		className: "dsh-forge-input",
		type: "number",
		min: 1,
		max: 4,
		value: String(count),
		onChange: (event) => {
			const next = Number(event.target.value);
			setCount(Number.isFinite(next) ? Math.min(4, Math.max(1, Math.trunc(next))) : 1);
		}
	}))), (0, react.createElement)("div", { className: "dsh-forge-field" }, (0, react.createElement)("div", { className: "dsh-forge-field-head" }, (0, react.createElement)("label", { className: "dsh-forge-label" }, "参考图"), (0, react.createElement)("span", { className: "dsh-forge-studio-hint" }, "给图就是改图；留空就是文生图")), (0, react.createElement)("div", { className: "dsh-forge-ref-row" }, ...references.map((reference, index) => (0, react.createElement)("div", {
		key: reference.id,
		className: "dsh-forge-ref"
	}, (0, react.createElement)("img", {
		src: reference.previewUrl,
		alt: reference.name
	}), (0, react.createElement)("span", { className: "dsh-forge-ref-index" }, String(index + 1)), (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-ref-remove",
		onClick: () => {
			removeReference(reference.id);
		},
		title: "移除"
	}, "×"))), (0, react.createElement)("label", { className: "dsh-forge-ref-add" }, "+", (0, react.createElement)("input", {
		type: "file",
		accept: "image/png,image/jpeg,image/webp",
		multiple: true,
		onChange: addReferences,
		style: { display: "none" }
	})))), error === void 0 ? null : (0, react.createElement)("div", { className: "dsh-forge-studio-alert" }, error), (0, react.createElement)("div", { className: "dsh-forge-studio-actions" }, (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-btn is-primary",
		disabled: !canGenerate,
		onClick: () => {
			generate();
		}
	}, busy ? "生成中…" : references.length > 0 ? "生成改图" : "生成"), busy || optimizing ? (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-btn is-ghost",
		onClick: cancel
	}, "取消") : null, note === void 0 ? null : (0, react.createElement)("span", { className: "dsh-forge-studio-hint" }, note))), (0, react.createElement)("div", { className: "dsh-forge-studio-results" }, (0, react.createElement)("div", { className: "dsh-forge-results-head" }, (0, react.createElement)("div", {
		className: "dsh-forge-view-toggle",
		role: "group",
		"aria-label": "结果视图"
	}, ...[
		["canvas", "画布"],
		["list", "列表"],
		["assets", "素材"]
	].map(([value, label]) => (0, react.createElement)("button", {
		key: value,
		type: "button",
		className: view === value ? "dsh-forge-view-item is-active" : "dsh-forge-view-item",
		"aria-pressed": view === value,
		onClick: () => {
			setView(value);
		}
	}, label))), view === "canvas" ? (0, react.createElement)("div", { className: "dsh-forge-zoom" }, (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-btn is-ghost",
		"aria-label": "缩小",
		onClick: () => {
			zoomBy(1 / 1.25);
		}
	}, "−"), (0, react.createElement)("span", { className: "dsh-forge-zoom-label" }, zoomLabel(camera.zoom)), (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-btn is-ghost",
		"aria-label": "放大",
		onClick: () => {
			zoomBy(1.25);
		}
	}, "+"), (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-btn is-ghost",
		onClick: fitView
	}, "适应")) : (0, react.createElement)("span", { className: "dsh-forge-batch-meta" }, view === "assets" ? `${String(assetsTotal)} 张素材` : `${String(batches.length)} 批`)), view === "canvas" ? (0, react.createElement)("div", {
		className: "dsh-forge-canvas",
		ref: canvasRef,
		onPointerDown: onCanvasPointerDown,
		onPointerMove: onCanvasPointerMove,
		onPointerUp: endGesture,
		onPointerCancel: endGesture,
		onPointerLeave: endGesture
	}, nodes.length === 0 && view === "canvas" ? (0, react.createElement)("p", { className: "dsh-forge-canvas-hint" }, busy ? "正在生成…" : "这个画板还是空的。生成的第一张图会落在这里；拖动空白处平移，滚轮缩放，拖图可改位置。") : null, (0, react.createElement)("div", {
		className: "dsh-forge-canvas-layer",
		style: { transform: `translate(${String(-camera.x * camera.zoom)}px, ${String(-camera.y * camera.zoom)}px) scale(${String(camera.zoom)})` }
	}, (0, react.createElement)("svg", {
		className: "dsh-forge-canvas-edges",
		width: 1,
		height: 1,
		"aria-hidden": true
	}, ...nodes.flatMap((node) => node.parents.flatMap((parentId) => {
		const parent = nodes.find((candidate) => candidate.id === parentId);
		if (parent === void 0) return [];
		return [(0, react.createElement)("path", {
			key: `${parentId}->${node.id}`,
			d: edgePath(nodeRect(parent), nodeRect(node)),
			className: "dsh-forge-edge"
		})];
	}))), ...nodes.map((node) => {
		const selected = node.id === selectedNodeId;
		return (0, react.createElement)("div", {
			key: node.id,
			className: selected ? "dsh-forge-node is-selected" : "dsh-forge-node",
			style: {
				left: `${String(node.x)}px`,
				top: `${String(node.y)}px`
			},
			onPointerDown: (event) => {
				onNodePointerDown(event, node);
			}
		}, (0, react.createElement)("img", {
			src: studioFileUrl(node.image.markdownPath),
			alt: "生成结果",
			draggable: false,
			loading: "lazy"
		}), (0, react.createElement)("div", { className: "dsh-forge-node-meta" }, `${String(node.image.width)}×${String(node.image.height)} · ${String(Math.round(node.image.bytes / 1024))} KB`), selected ? (0, react.createElement)("div", { className: "dsh-forge-node-actions" }, (0, react.createElement)("button", {
			type: "button",
			className: "dsh-forge-node-btn",
			title: "把这张图放进参考图，下一轮按它改",
			onClick: () => {
				referenceNode(node);
			}
		}, "用作参考"), (0, react.createElement)("a", {
			className: "dsh-forge-node-btn",
			href: studioFileUrl(node.image.markdownPath),
			target: "_blank",
			rel: "noreferrer"
		}, "原图"), (0, react.createElement)("button", {
			type: "button",
			className: "dsh-forge-node-btn is-danger",
			title: "从画布移除（不会删文件）",
			onClick: () => {
				removeNode(node.id);
			}
		}, "移除")) : null);
	})), (0, react.createElement)("div", { className: "dsh-forge-canvas-foot" }, references.length === 0 ? "选中图片后可「用作参考」，下一轮会从它拉一条线出来。" : `已选 ${String(references.length)} 张参考图，下一轮将是改图。`)) : view === "assets" ? assetsPanel : batches.length === 0 ? (0, react.createElement)("div", { className: "dsh-forge-studio-empty" }, busy ? "正在生成…" : "还没有结果") : (0, react.createElement)("div", { className: "dsh-forge-list" }, ...batches.map((batch) => (0, react.createElement)("div", {
		key: batch.id,
		className: batch.id === selectedBatch?.id ? "dsh-forge-batch is-active" : "dsh-forge-batch"
	}, (0, react.createElement)("div", { className: "dsh-forge-batch-head" }, (0, react.createElement)("span", { className: "dsh-forge-batch-meta" }, `${batch.response.ratio} · ${String(batch.response.width)}×${String(batch.response.height)} · ${String(batch.response.steps)} 步`), (0, react.createElement)("button", {
		type: "button",
		className: "dsh-forge-btn is-ghost",
		onClick: () => {
			reuse(batch);
		}
	}, "复用参数")), (0, react.createElement)("div", { className: "dsh-forge-batch-grid" }, ...batch.response.images.map((image, index) => (0, react.createElement)("a", {
		key: image.path,
		className: "dsh-forge-batch-item",
		href: studioFileUrl(image.markdownPath),
		target: "_blank",
		rel: "noreferrer",
		title: image.path
	}, (0, react.createElement)("img", {
		src: studioFileUrl(image.markdownPath),
		alt: `结果 ${String(index + 1)}`,
		loading: "lazy"
	})))), (0, react.createElement)("div", { className: "dsh-forge-batch-prompt" }, batch.response.prompt)))))));
}
//#endregion
//#region src/settings-fields.ts
/**
* Tab strip for the settings page, in order.
*
* A group that is not referenced by any tab is simply not rendered.
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
		id: "comfyui",
		label: "ComfyUI",
		hint: "复用你自己装好的 ComfyUI（本地推荐部署见 docs/comfyui-deployment.md）。",
		groupIds: ["comfyui"]
	}
];
/** The blocks the page renders, in order. */
const SETTINGS_GROUPS = [
	{
		id: "backend",
		label: "后端选择",
		hint: "一次出图交给谁执行：云端的 key，还是本机的 ComfyUI。"
	},
	{
		id: "steps",
		label: "步数（画质与耗时）",
		hint: "base 25 步；turbo 蒸馏版 8 步。"
	},
	{
		id: "api",
		label: "云端 API",
		hint: "云端端点与密钥。"
	},
	{
		id: "comfyui",
		label: "ComfyUI",
		hint: "地址、端口与权重目录。"
	},
	{
		id: "output",
		label: "输出与超时",
		hint: "图片落到哪里，等多久。"
	}
];
/** Every configurable field, in page order. */
const SETTINGS_FIELDS = [
	{
		key: "backend",
		group: "backend",
		label: "后端",
		hint: "auto：有 key 走云端，否则走 ComfyUI。改图只有 ComfyUI。",
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
				value: "comfyui",
				label: "comfyui（本机 ComfyUI）"
			}
		]
	},
	{
		key: "defaultSteps",
		group: "steps",
		label: "默认步数",
		hint: "base 的默认：25，官方模板口径。",
		kind: "number",
		min: 1,
		max: 200,
		unit: "步"
	},
	{
		key: "comfyuiSteps",
		group: "steps",
		label: "ComfyUI 专用步数",
		hint: "留空 = 用默认步数。",
		kind: "number",
		min: 1,
		max: 200,
		unit: "步",
		nullable: true
	},
	{
		key: "comfyModel",
		group: "steps",
		label: "ComfyUI 权重",
		hint: "turbo：8 步，快 2.7×；没装 turbo 权重自动退回 base。",
		kind: "enum",
		choices: [{
			value: "base",
			label: "base（25 步，官方全量）"
		}, {
			value: "turbo",
			label: "turbo（8 步，蒸馏版）"
		}]
	},
	{
		key: "turboSteps",
		group: "steps",
		label: "turbo 专用步数",
		hint: "留空 = 8。蒸馏按 8 步调，加减不一定更好。",
		kind: "number",
		min: 1,
		max: 50,
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
		hint: "只写不读：已保存的密钥不会回显。本机环境变量优先。",
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
		hint: "桌面版在「设置 → 模型路径」里；用来把「放哪里」写进报错。",
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
* Hidden controls are dropped here, and a group left with no visible fields is
* dropped too, so the page never renders an empty heading.
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
	id: "turbo-vs-base",
	title: "默认跑 turbo（8 步）：快 2.7×，写实 / 中文文字 / 古典构图这三类切 base",
	paragraphs: ["盲测 5 题（同 prompt 同 seed）：base 3 : 2 turbo；单张 27–29 s → turbo 9–11 s。", "turbo 赢在高对比氛围（夜市、动物）；输在材质细节、中文小字与印章、古典构图。"],
	placedAfterGroup: "steps"
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
* Pseudo tab id for the workbench. It is not a member of `SETTINGS_TABS`
* because it renders a live surface rather than a form over config fields, so
* giving it a `groupIds` list would be a lie the tab renderer would act on.
*/
const STUDIO_TAB_ID = "studio";
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
	"qwen_image_status"
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
	if (paths.length === 0) return null;
	return (0, react.createElement)("div", {
		key: "images",
		className: "dsh-image-forge-images"
	}, paths.map((path, index) => {
		const loaded = typeof props.loadImage === "function" ? props.loadImage(path) : void 0;
		const src = typeof loaded === "string" && loaded.length > 0 ? loaded : studioFileUrl(path);
		return (0, react.createElement)("img", {
			key: `image-${index}`,
			src,
			alt: path,
			loading: "lazy"
		});
	}));
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
		return (0, react.createElement)(CardShell, {
			title: isEdit ? "参考图编辑" : "文生图",
			status,
			pills,
			children: [(0, react.createElement)(ImageGrid, {
				key: "grid",
				...props
			})]
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
		const apiOk = api?.["reachable"] === true;
		const apiAuth = api?.["authenticated"] === true;
		const apiHasKey = api?.["keyPresent"] === true;
		const apiTone = apiOk && apiAuth ? "ok" : apiOk || api?.["reachable"] === null && apiHasKey ? "warn" : "bad";
		const apiText = !apiHasKey && api?.["reachable"] !== true ? "未配置 key" : !apiOk ? api?.["reachable"] === null ? "未探测（无 key）" : "不可达" : apiAuth ? "可达，key 被接受" : "可达，但 key 被拒绝";
		const comfyOk = comfy?.["reachable"] === true;
		const models = asRecord(comfy?.["models"]);
		const comfyTone = comfyOk ? models?.["ok"] === true ? "ok" : "warn" : "bad";
		const comfyText = !comfyOk ? "没找到在跑的实例" : models?.["ok"] === true ? "在跑，三个权重齐" : "在跑，但缺 Qwen 权重";
		const device = asRecord((Array.isArray(comfy?.["devices"]) ? comfy["devices"] : [])[0]);
		const vramFree = typeof device?.["vram_free_MiB"] === "number" ? device["vram_free_MiB"] : null;
		const vramTotal = typeof device?.["vram_total_MiB"] === "number" ? device["vram_total_MiB"] : null;
		const gpuText = vramTotal === null ? "未报告" : `${String(device?.["name"] ?? "GPU")} · 空闲 ${String(vramFree ?? "?")} / ${String(vramTotal)} MiB`;
		const outputWritable = asRecord(payload?.["output"])?.["writable"] === true;
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
				checkCell("vram", "显卡", gpuText, vramTotal === null ? "warn" : "neutral"),
				checkCell("output", "输出目录", outputWritable ? "可写" : "不可写", outputWritable ? "ok" : "bad")
			])]
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
		}, field.hint),
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
	const [tabId, setTabId] = (0, react.useState)(STUDIO_TAB_ID);
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
	const studioTab = (0, react.createElement)("button", {
		key: STUDIO_TAB_ID,
		type: "button",
		role: "tab",
		className: tabId === STUDIO_TAB_ID ? "dsh-image-forge-tab dsh-image-forge-tab-active" : "dsh-image-forge-tab",
		"aria-selected": tabId === STUDIO_TAB_ID,
		onClick: () => setTabId(STUDIO_TAB_ID)
	}, "图像工作台");
	if (form === void 0) return (0, react.createElement)("div", { className: "dsh-image-forge-settings" }, [(0, react.createElement)("div", {
		key: "tabs",
		className: "dsh-image-forge-tabs",
		role: "tablist"
	}, [studioTab]), (0, react.createElement)("div", {
		key: "panel",
		className: "dsh-image-forge-settings-panel",
		role: "tabpanel"
	}, (0, react.createElement)(StudioPanel), (0, react.createElement)("div", {
		key: "notice",
		className: "dsh-image-forge-settings-notice"
	}, props.unavailableReason ?? "配置表单不可用：本页只能出图，参数请在 profile 里改。"))]);
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
	const activeTab = tabId === STUDIO_TAB_ID ? void 0 : SETTINGS_TABS.find((tab) => tab.id === tabId) ?? SETTINGS_TABS[0];
	const panels = activeTab === void 0 ? [] : tabFields(activeTab);
	const studioActive = activeTab === void 0;
	return (0, react.createElement)("div", {
		className: "dsh-image-forge-settings",
		"data-dsh-tick": tick
	}, [(0, react.createElement)("div", {
		key: "tabs",
		className: "dsh-image-forge-tabs",
		role: "tablist"
	}, [studioTab, ...SETTINGS_TABS.map((tab) => (0, react.createElement)("button", {
		key: tab.id,
		type: "button",
		role: "tab",
		className: tab.id === activeTab?.id ? "dsh-image-forge-tab dsh-image-forge-tab-active" : "dsh-image-forge-tab",
		"aria-selected": tab.id === activeTab?.id,
		onClick: () => setTabId(tab.id)
	}, tab.label))]), studioActive ? (0, react.createElement)("div", {
		key: "panel",
		className: "dsh-image-forge-settings-panel",
		role: "tabpanel"
	}, (0, react.createElement)(StudioPanel)) : (0, react.createElement)("div", {
		key: "panel",
		className: "dsh-image-forge-settings-panel",
		role: "tabpanel"
	}, [(0, react.createElement)("p", {
		key: "lead",
		className: "dsh-image-forge-settings-lead"
	}, [activeTab?.hint ?? "", disabled ? " 当前配置条目为只读。" : " 改动会立即写入。"].filter((part) => part.length > 0).join(" ")), ...panels.map(({ group, fields }) => {
		const block = (0, react.createElement)(GroupBlock, {
			key: group.id,
			group,
			fields,
			value,
			disabled,
			write,
			dense: true
		});
		const advisory = advisoryAfterGroup(group.id);
		return advisory === void 0 ? [block] : [block, (0, react.createElement)(AdvisoryBlock, {
			key: advisory.id,
			advisory
		})];
	})])]);
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
