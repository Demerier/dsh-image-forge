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
.dsh-image-forge-setting-control input[type="text"] {
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
.dsh-forge-canvas{position:relative;height:clamp(300px,50vh,540px);overflow:hidden;border:1px solid rgba(127,127,127,.28);border-radius:10px;background-color:rgba(127,127,127,.035);background-image:radial-gradient(rgba(127,127,127,.3) 1px,transparent 1px);background-size:22px 22px;cursor:crosshair;touch-action:none;user-select:none}
.dsh-forge-canvas.is-pan{cursor:grab}
.dsh-forge-canvas.is-pan:active{cursor:grabbing}
.dsh-forge-canvas:focus{outline:none}
.dsh-forge-canvas:focus-visible{box-shadow:0 0 0 2px rgba(59,130,246,.28)}
.dsh-forge-canvas-layer{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.dsh-forge-canvas-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.dsh-forge-edge{fill:none;stroke:rgba(59,130,246,.5);stroke-width:2;stroke-dasharray:6 5;stroke-linecap:round}
.dsh-forge-node{position:absolute;box-sizing:border-box;border-radius:10px;overflow:hidden;border:1px solid rgba(127,127,127,.34);background:rgba(127,127,127,.08);cursor:grab;box-shadow:0 1px 5px rgba(0,0,0,.09)}
.dsh-forge-node.is-selected{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.22),0 2px 10px rgba(0,0,0,.12);z-index:2}
.dsh-forge-node img{display:block;width:100%;height:200px;object-fit:contain;background:rgba(127,127,127,.14);pointer-events:none}
.dsh-forge-node-meta{padding:4px 8px 5px;font-size:10px;opacity:.62;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-forge-node-actions{display:flex;gap:4px;padding:0 6px 6px;flex-wrap:wrap}
.dsh-forge-node-btn{appearance:none;font:inherit;font-size:10.5px;padding:3px 7px;border-radius:5px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;text-decoration:none;line-height:1.5;white-space:nowrap}
.dsh-forge-node-btn:hover{background:rgba(127,127,127,.13);border-color:rgba(127,127,127,.5)}
.dsh-forge-node-btn.is-danger:hover{color:#dc2626;border-color:rgba(220,38,38,.5);background:rgba(220,38,38,.08)}
.dsh-forge-canvas-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;margin:0;padding:0 28px;text-align:center;font-size:12.5px;line-height:1.7;opacity:.45;pointer-events:none}
.dsh-forge-canvas-foot{position:absolute;left:0;right:0;bottom:0;padding:6px 10px;font-size:10.5px;opacity:.55;background:linear-gradient(transparent,rgba(127,127,127,.14));pointer-events:none;text-align:center}
.dsh-forge-marquee{position:absolute;z-index:3;pointer-events:none;border:1px solid rgba(59,130,246,.85);background:rgba(59,130,246,.12);border-radius:2px}
.dsh-forge-context{position:absolute;z-index:6;display:flex;flex-direction:column;gap:1px;min-width:172px;max-width:280px;padding:4px;border-radius:8px;border:1px solid rgba(127,127,127,.34);box-shadow:0 8px 24px rgba(0,0,0,.22);background:#fff;background:Canvas;color:#111;color:CanvasText}
.dsh-forge-context-item{appearance:none;font:inherit;font-size:12.5px;line-height:1.5;text-align:left;padding:6px 9px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-forge-context-item:hover:not([disabled]){background:rgba(127,127,127,.18)}
.dsh-forge-context-item[disabled]{opacity:.42;cursor:default}
.dsh-forge-context-item.is-danger{color:#dc2626}
.dsh-forge-context-item.is-danger:hover:not([disabled]){background:rgba(220,38,38,.12)}
.dsh-forge-align{display:flex;align-items:center;gap:3px;flex-wrap:wrap}
.dsh-forge-align-btn{appearance:none;font:inherit;font-size:10.5px;line-height:1.4;padding:3px 6px;border-radius:5px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
.dsh-forge-align-btn:hover{background:rgba(127,127,127,.13);border-color:rgba(127,127,127,.5)}
.dsh-forge-align-btn.is-distribute{margin-left:4px;border-style:dashed}
.dsh-forge-btn.is-active{border-color:rgba(59,130,246,.55);background:rgba(59,130,246,.12);opacity:1}
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
/**
* Smallest zoom the canvas allows.
*
* Stepping back to see the whole session *is* the point of a generation canvas:
* a 500-node board is roughly 15000×8000 world units, which the old 0.3 floor
* could not frame — `fitCamera` clamped and left the far columns off-screen.
* At 0.1 a node is still a legible colour block.
*/
const CANVAS_MIN_ZOOM = .1;
/**
* The on-canvas size of a node holding a `width`×`height` picture.
*
* The picture area is a fixed {@link IMAGE_AREA_HEIGHT} tall and as wide as the
* aspect ratio asks for, clamped to [{@link MIN_NODE_WIDTH}, {@link MAX_NODE_WIDTH}]
* so an imported panorama cannot squeeze its neighbours and a long strip cannot
* stretch the row into unusable width. Height never changes: caption and action
* rows sit below the picture and are sized by their own content.
*
* Unknown or invalid dimensions fall back to the plain node box rather than
* throwing — a board entry with a corrupt size should still render.
*/
function nodeDisplaySize(width, height) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return {
		width: 208,
		height: 240
	};
	const ideal = Math.round(200 * width / height);
	return {
		width: Math.min(480, Math.max(96, ideal)),
		height: 240
	};
}
/** Clamp a zoom factor into the supported range. */
function clampZoom(zoom) {
	if (!Number.isFinite(zoom)) return 1;
	return Math.min(4, Math.max(CANVAS_MIN_ZOOM, zoom));
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
* The four numbers `edgePath` draws with, shared with {@link edgeBounds}.
*
* One definition, two readers: the path string and the bounding box must agree
* or a long edge that visibly crosses the viewport would be culled for being
* "outside" it.
*/
function edgeAnchors(from, to) {
	const x1 = from.x + from.width;
	const y1 = from.y + from.height / 2;
	const x2 = to.x;
	return {
		x1,
		y1,
		x2,
		y2: to.y + to.height / 2,
		reach: Math.max(40, Math.abs(x2 - x1) * .45)
	};
}
/**
* `<path d>` for an edge from the right edge of `from` to the left edge of `to`.
*
* A cubic with horizontal control points reads as a wire rather than a slash
* whenever the two nodes are on the same row, which is the common case.
*/
function edgePath(from, to) {
	const { x1, y1, x2, y2, reach } = edgeAnchors(from, to);
	return `M ${round(x1)} ${round(y1)} C ${round(x1 + reach)} ${round(y1)}, ${round(x2 - reach)} ${round(y2)}, ${round(x2)} ${round(y2)}`;
}
/** Zoom as a percentage label, e.g. `120%`. */
function zoomLabel(zoom) {
	return `${String(Math.round(zoom * 100))}%`;
}
/**
* Half-thickness, in world units, of an edge's culling box.
*
* A wire drawn between two nodes at the same height has a zero-height bounding
* box, and a zero-area rectangle never intersects anything under the strict
* rule — so a long level edge crossing the viewport would be culled while
* clearly visible. This gives it a body; the stroke is 2 screen pixels, so 2
* world units is generous without reaching a neighbour's edge.
*/
const EDGE_BOUNDS_PAD = 2;
/**
* Do two rectangles overlap by a positive area?
*
* Touching edges do **not** count — the same rule a marquee uses, so the node
* set a selection would catch and the node set culling renders agree at the
* boundary. Containment counts.
*
* Lives here because it is geometry; `canvas-interactions.ts` re-exports it so
* the C08 import path keeps working (that module's header explains the handover).
*/
function rectsIntersect(a, b) {
	const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return overlapX > 0 && overlapY > 0;
}
/**
* The world rectangle the viewport shows, padded by `margin` on every side.
*
* `camera.x`/`camera.y` is the world point at the viewport's top-left corner, so
* the visible world size is the viewport in screen pixels divided by the zoom.
*
* An unmeasured viewport (width or height ≤ 0, or a zoom that is not a positive
* number) returns an effectively unbounded rectangle: until the browser has
* measured the element, "render everything" is the only safe answer — culling
* against a zero viewport would blank the canvas for the first frame, and
* culling is never allowed to change what is on screen. The sentinel is a finite
* ±2⁵³ span rather than `±Infinity`, because an infinite extent makes the
* intersection arithmetic produce `NaN` and cull everything.
*/
function visibleWorldRect(camera, viewport, margin = 256) {
	const pad = Number.isFinite(margin) ? Math.max(0, margin) : 0;
	const width = viewport.width;
	const height = viewport.height;
	if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) || !(Number.isFinite(camera.zoom) && camera.zoom > 0) || !Number.isFinite(camera.x) || !Number.isFinite(camera.y)) {
		const span = Number.MAX_SAFE_INTEGER;
		return {
			x: -span,
			y: -span,
			width: span * 2,
			height: span * 2
		};
	}
	return {
		x: camera.x - pad,
		y: camera.y - pad,
		width: width / camera.zoom + pad * 2,
		height: height / camera.zoom + pad * 2
	};
}
/**
* The subset of `rects` whose node would be on screen.
*
* Order is preserved (the caller's `nodes` order is what stacks siblings) and
* the input items come back unchanged, so the caller can pass render items —
* node plus rect plus id — and get the same objects back. O(n) rectangle tests,
* which is cheaper than the DOM diff it saves even on a small board, so this
* runs unconditionally with no switch.
*/
function visibleNodes(rects, camera, viewport, margin = 256) {
	const world = visibleWorldRect(camera, viewport, margin);
	return rects.filter((rect) => rectsIntersect(rect, world));
}
/**
* `Map<id, node>` for the whole board, built once per `nodes` change.
*
* This is what retires the old per-edge `nodes.find` (O(n) inside O(n×parents)):
* every parent lookup is now a hash hit. A duplicated id keeps its first
* occurrence, matching what `Array.prototype.find` used to return.
*/
function nodeIndex(nodes) {
	const index = /* @__PURE__ */ new Map();
	for (const node of nodes) if (!index.has(node.id)) index.set(node.id, node);
	return index;
}
/**
* Resolve every `parents` link into an edge with both endpoints' rectangles.
*
* `index` is the board's {@link nodeIndex}: the child comes from `nodes`, the
* parent from one hash lookup, so a board's edges cost O(parent links) map hits
* rather than O(n) scans. A parent that is not on the board (a cross-board
* reference, or an item the store dropped) is skipped instead of throwing —
* `boards.resolveParents` already tolerates it, and a broken lineage must not
* cost the user their canvas.
*
* A self-link is kept: it renders as the degenerate curl it always did, and
* culling later decides whether to draw it.
*/
function buildEdges(nodes, index) {
	const edges = [];
	for (const node of nodes) {
		const to = rectOf(node);
		for (const parentId of node.parents) {
			const parent = index.get(parentId);
			if (parent === void 0) continue;
			edges.push({
				child: node.id,
				parent: parentId,
				from: rectOf(parent),
				to
			});
		}
	}
	return edges;
}
/**
* World-space bounding box of the cubic {@link edgePath} draws.
*
* A cubic never leaves the convex hull of its four control points, so the hull
* of the two anchors and the two horizontal control points is a sufficient — and
* cheap — box. `EDGE_BOUNDS_PAD` gives a horizontal wire a thickness: a
* perfectly level long edge has a zero-height box, and a zero-area rectangle
* never intersects anything under the strict rule.
*/
function edgeBounds(from, to) {
	const { x1, y1, x2, y2, reach } = edgeAnchors(from, to);
	const left = Math.min(x1, x2, x1 + reach, x2 - reach) - EDGE_BOUNDS_PAD;
	const right = Math.max(x1, x2, x1 + reach, x2 - reach) + EDGE_BOUNDS_PAD;
	const top = Math.min(y1, y2) - EDGE_BOUNDS_PAD;
	const bottom = Math.max(y1, y2) + EDGE_BOUNDS_PAD;
	return {
		x: left,
		y: top,
		width: right - left,
		height: bottom - top
	};
}
/**
* The edges this frame should draw.
*
* An edge counts as visible when either endpoint is (its node intersects the
* padded viewport — exactly the membership test in {@link visibleNodes}), or
* when its own bounding box crosses the viewport. The second rule is what keeps
* a long blood-line edge passing behind the viewport while both of its nodes are
* off-screen; without it the wire would vanish in the middle of a pan.
*/
function visibleEdges(edges, worldRect) {
	return edges.filter((edge) => rectsIntersect(edge.from, worldRect) || rectsIntersect(edge.to, worldRect) || rectsIntersect(edgeBounds(edge.from, edge.to), worldRect));
}
/** Copy the four geometry fields, so an edge keeps the rects it was built from. */
function rectOf(rect) {
	return {
		x: rect.x,
		y: rect.y,
		width: rect.width,
		height: rect.height
	};
}
function round(value) {
	return Math.round(value * 100) / 100;
}
/**
* `rectsIntersect` (the marquee's positive-area rule) is re-exported above from
* `./studio-canvas.ts`: C08 wrote it, C07 moved it to the geometry module where
* viewport culling can reach it without an import cycle, and the export path here
* is unchanged so existing marquee callers keep working.
*/
/** Normalise two opposite corners into a rectangle that always has a size. */
function rectBetween(a, b) {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		width: Math.abs(b.x - a.x),
		height: Math.abs(b.y - a.y)
	};
}
/**
* The world rectangle a marquee covers, from its two screen-space corners.
*
* `start` is where the pointer went down and `current` is where it is now, both
* viewport-relative — so a bottom-right drag and a top-left drag must produce
* the same rectangle, and a drag at zoom 2 must cover half the world a zoom-1
* drag covers. Delegating to `screenToWorld` is deliberate: the marquee and the
* node positions then cannot disagree about what "the pointer is here" means.
*/
function marqueeWorldRect(camera, start, current) {
	return rectBetween(screenToWorld(camera, start), screenToWorld(camera, current));
}
/**
* The ids of every node the marquee rectangle touches.
*
* Input order is preserved, so a caller can keep its render order stable, and a
* zero-area marquee (a plain click that merely moved a pixel) selects nothing.
*/
function nodesInRect(nodes, worldRect) {
	const hits = [];
	for (const node of nodes) if (rectsIntersect(node, worldRect)) hits.push(node.id);
	return hits;
}
/**
* The union of `rects`, or `undefined` when there is nothing to bound.
*
* An empty selection has no box — returning a zero rect at the origin would let
* an align call scatter nodes to (0, 0), so absence is spelled as `undefined`
* and callers must handle it (§6.2 alignment is relative to the selection's own
* bounds, never to the board).
*/
function selectionBounds(rects) {
	if (rects.length === 0) return void 0;
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
	return {
		x: left,
		y: top,
		width: right - left,
		height: bottom - top
	};
}
/**
* Apply one click or marquee hit to the selection (§6.1).
*
* - `additive === false` — replace: a plain click selects exactly what was
*   clicked, which is the pre-multi-select behaviour and still the common case.
* - `additive === true` — toggle: a member leaves the set, a non-member joins
*   it. §6.1 spells this as Ctrl/Cmd+click; the marquee gesture spells the same
*   flag as Shift (`docs/CANVAS-DESIGN.md` §6.1 gesture union). The modifier
*   difference is the caller's to map — this function only takes the boolean.
*
* The argument set is never mutated: `studio-view.ts` keeps selection in React
* state, and an in-place `Set` edit would not re-render.
*/
function toggleSelection(current, id, additive) {
	if (!additive) return /* @__PURE__ */ new Set([id]);
	const next = new Set(current);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}
/**
* The selection after a marquee release (§6.1).
*
* A plain marquee **replaces** the selection — sweeping a box is a fresh
* statement about what is selected, and a zero-hit drag therefore clears it,
* which is what a click on blank canvas means. A `Shift` marquee unions onto the
* selection the drag started with, so a user can add a far-off node without
* losing what they already had.
*
* The hits are tested against the whole board by the caller, not against the
* culled subset, and the argument set is never mutated (it is React state).
*/
function marqueeSelection(current, hits, additive) {
	if (!additive) return new Set(hits);
	const next = new Set(current);
	for (const id of hits) next.add(id);
	return next;
}
/**
* The single selected id, or `undefined` when the set is empty or holds several.
*
* This is the compatibility shim for the rest of the canvas: the action bar and
* "locate" affordances are single-node by design (§13 C09 step 1: "单选语义 =
* 选择集大小 1"), and they read this instead of growing a multi-node branch.
*/
function singleSelection(selection) {
	if (selection.size !== 1) return void 0;
	for (const id of selection) return id;
}
/**
* Where every dragged node lands, given the pointer's screen-space delta.
*
* `origins` are the positions captured when the gesture started, not the live
* ones: accumulating per-frame deltas would drift at fractional zoom, and a
* rubber-band frame would be unrecoverable. The division by `zoom` is the same
* conversion as the single-node drag (`src/studio-view.ts:1013-1015`), so both
* gestures track the pointer identically.
*
* A non-positive or non-finite zoom falls back to 1 instead of producing
* `Infinity` — a corrupt camera should freeze the drag, not teleport the nodes.
*/
function moveSelection(origins, screenDelta, zoom) {
	const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
	const moved = /* @__PURE__ */ new Map();
	for (const [id, origin] of origins) moved.set(id, {
		x: origin.x + screenDelta.x / scale,
		y: origin.y + screenDelta.y / scale
	});
	return moved;
}
/** The six alignment modes of the §6.2 toolbar, left to right, top to bottom. */
const ALIGN_MODES = [
	"left",
	"center-h",
	"right",
	"top",
	"center-v",
	"bottom"
];
/** The two distribution axes: horizontal spacing and vertical spacing (§6.2). */
const DISTRIBUTE_AXES = ["x", "y"];
/**
* New positions for an alignment, keyed by node id.
*
* The reference is the **selection's own bounding box**, never the board: the
* canvas is infinite, so "align to board" has no meaning (§6.2). Every rect is
* returned, including the ones a mode leaves untouched, so the caller can feed
* the map straight into one batch move — one command, one save.
*
* Sizes never change, so `center-h`/`center-v` place the node's own midpoint on
* the box's midpoint rather than moving its top-left corner onto the box's
* midpoint. An unknown mode is a no-op instead of a throw: a stale UI button
* must not take the canvas down.
*/
function alignNodes(nodes, mode) {
	const positions = /* @__PURE__ */ new Map();
	for (const node of nodes) positions.set(node.id, {
		x: node.x,
		y: node.y
	});
	const bounds = selectionBounds(nodes);
	if (bounds === void 0) return positions;
	const right = bounds.x + bounds.width;
	const bottom = bounds.y + bounds.height;
	for (const node of nodes) switch (mode) {
		case "left":
			positions.set(node.id, {
				x: bounds.x,
				y: node.y
			});
			break;
		case "center-h":
			positions.set(node.id, {
				x: bounds.x + (bounds.width - node.width) / 2,
				y: node.y
			});
			break;
		case "right":
			positions.set(node.id, {
				x: right - node.width,
				y: node.y
			});
			break;
		case "top":
			positions.set(node.id, {
				x: node.x,
				y: bounds.y
			});
			break;
		case "center-v":
			positions.set(node.id, {
				x: node.x,
				y: bounds.y + (bounds.height - node.height) / 2
			});
			break;
		case "bottom": positions.set(node.id, {
			x: node.x,
			y: bottom - node.height
		});
	}
	return positions;
}
/** Centre of a node along one axis. */
function centerOf(node, axis) {
	return axis === "x" ? node.x + node.width / 2 : node.y + node.height / 2;
}
/**
* New positions with the selection's **centre points** spaced evenly (§6.2).
*
* The two extremes do not move, and the axis' other coordinate is untouched:
* distribution rearranges spacing, not rows. Order comes from the current
* centres rather than from the argument order, because a caller's array is in
* render order, not visual order; ids break ties so a run is reproducible.
*
* Fewer than three nodes have nothing to space out between them — the identity
* map comes back rather than an error.
*/
function distributeNodes(nodes, axis) {
	const positions = /* @__PURE__ */ new Map();
	for (const node of nodes) positions.set(node.id, {
		x: node.x,
		y: node.y
	});
	if (nodes.length < 3) return positions;
	const sorted = [...nodes].sort((a, b) => {
		const delta = centerOf(a, axis) - centerOf(b, axis);
		if (delta !== 0) return delta;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	const first = centerOf(sorted[0], axis);
	const step = (centerOf(sorted[sorted.length - 1], axis) - first) / (sorted.length - 1);
	for (let index = 1; index < sorted.length - 1; index += 1) {
		const node = sorted[index];
		const center = first + step * index;
		positions.set(node.id, axis === "x" ? {
			x: center - node.width / 2,
			y: node.y
		} : {
			x: node.x,
			y: center - node.height / 2
		});
	}
	return positions;
}
/**
* One undoable change, paired with the two snapshots it switches between.
*
* The stack records commands that have **already been applied** (§6.5), so this
* does not apply anything on construction: `revert()` writes `before`, `apply()`
* writes `after` — the latter only ever from `CommandStack.redo()`.
*
* The payload is opaque (`before`/`after` of any type) because every step the
* canvas pushes is a snapshot: node positions for a drag, alignment or nudge,
* the whole node list for a removal. Keeping it to one generic shape is what
* makes a bad step reviewable — if a command swaps its two sides, the drag it
* undoes lands in the wrong place, and a test with a fake writer catches it.
*/
function snapshotCommand(label, before, after, write) {
	return {
		label,
		apply() {
			write(after);
		},
		revert() {
			write(before);
		}
	};
}
/**
* The session-scoped undo stack (§6.5, DD9).
*
* Deliberately memory-only and deliberately ignorant of what a command means:
*
* - **Nothing is persisted.** Boards are written by several actors and the store
*   resolves conflicts last-write-wins (`src/boards.ts:27-39`), so a durable op
*   log would need a cross-writer total order that does not exist here. A reload
*   starts with an empty stack, and the UI must not promise otherwise.
* - **Nothing is filtered here.** Camera moves and generation runs must stay out
*   of the stack (§6.5: generation cannot be undone after the GPU ran, and
*   undoing the camera contradicts what a canvas is), but that constraint lives
*   with the caller that decides what to push.
*
* `push` records a change the caller has **already applied** — a drag has moved
* the nodes by the time the gesture ends — so it does not call `apply`.
*/
var CommandStack = class {
	#undo = [];
	#redo = [];
	#limit;
	constructor(limit = 100) {
		this.#limit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 100;
	}
	/** Maximum number of undoable steps this stack keeps. */
	get limit() {
		return this.#limit;
	}
	/** How many steps can be undone right now. */
	get undoSize() {
		return this.#undo.length;
	}
	/** How many undone steps can be redone right now. */
	get redoSize() {
		return this.#redo.length;
	}
	/** Whether `undo()` would do anything. */
	canUndo() {
		return this.#undo.length > 0;
	}
	/** Whether `redo()` would do anything. */
	canRedo() {
		return this.#redo.length > 0;
	}
	/**
	* Record an already-applied command.
	*
	* Pushing discards the redo tail: once the user does something new after
	* undoing, the abandoned branch is unreachable and keeping it would resurrect
	* a future that no longer follows from the present. Overflow past the cap drops
	* the **oldest** step.
	*/
	push(command) {
		this.#undo.push(command);
		this.#redo.length = 0;
		while (this.#undo.length > this.#limit) this.#undo.shift();
	}
	/** Revert the most recent step; `false` when there is nothing to undo. */
	undo() {
		const command = this.#undo.pop();
		if (command === void 0) return false;
		command.revert();
		this.#redo.push(command);
		return true;
	}
	/** Re-apply the most recently undone step; `false` when the tail is empty. */
	redo() {
		const command = this.#redo.pop();
		if (command === void 0) return false;
		command.apply();
		this.#undo.push(command);
		return true;
	}
	/** Drop both stacks — a board switch starts a fresh history (§6.5: session-scoped). */
	clear() {
		this.#undo.length = 0;
		this.#redo.length = 0;
	}
};
/**
* The world-space delta of one arrow-key nudge (§6.3).
*
* `fast` is Shift held: §6.3's "Shift=10". Y grows downward on the canvas (the
* camera's own convention), so `up` subtracts.
*/
function nudgeVector(axis, fast = false) {
	const step = fast ? 10 : 1;
	switch (axis) {
		case "left": return {
			x: -step,
			y: 0
		};
		case "right": return {
			x: step,
			y: 0
		};
		case "up": return {
			x: 0,
			y: -step
		};
		case "down": return {
			x: 0,
			y: step
		};
		default: return {
			x: 0,
			y: 0
		};
	}
}
/**
* Map one key press to the action it means (§6.3).
*
* Ctrl and Cmd are interchangeable here on purpose: the table writes them as
* "Ctrl/Cmd" and the panel runs in the same web client on both platforms.
*
* Shift only changes *how much* a nudge moves ({@link NUDGE_STEP_FAST}), never
* *what* it does, except for Ctrl/Cmd+Shift+Z, which is the second binding for
* redo. Ctrl/Cmd+Shift+<anything else> is therefore unbound: silently aliasing
* it onto a neighbouring shortcut would collide with bindings the host browser
* or the web client owns. Anything not in the table — including a bare modifier,
* a function key, an empty string — resolves to `none` rather than throwing,
* because key events carry whatever the layout produces.
*/
function resolveShortcut(key, mods = {}, context = "canvas") {
	if (context !== "canvas") return "none";
	const name = typeof key === "string" ? key.toLowerCase() : "";
	const mod = mods.ctrl === true || mods.meta === true;
	const shift = mods.shift === true;
	if (mod) switch (name) {
		case "z": return shift ? "redo" : "undo";
		case "y": return shift ? "none" : "redo";
		case "a": return shift ? "none" : "select-all";
		case "c": return shift ? "none" : "copy";
		case "v": return shift ? "none" : "paste";
		default: return "none";
	}
	switch (name) {
		case "delete":
		case "backspace": return "remove";
		case "escape": return "escape";
		case " ":
		case "space":
		case "spacebar": return "pan-mode";
		case "f": return "fit";
		case "+":
		case "=":
		case "add": return "zoom-in";
		case "-":
		case "_":
		case "subtract": return "zoom-out";
		case "arrowleft": return "nudge-left";
		case "arrowright": return "nudge-right";
		case "arrowup": return "nudge-up";
		case "arrowdown": return "nudge-down";
		default: return "none";
	}
}
/**
* Decide which surface owns the keyboard, from flags the caller read off the DOM.
*
* The DOM inspection itself stays in `studio-view.ts` (`closest`, `tagName`,
* `isContentEditable`) so this module remains importable in Node; this only
* classifies the answer. Both non-canvas answers yield every shortcut, so the
* order between them is cosmetic — the editor is checked first because it wraps
* text fields and its own `stopPropagation` is the stronger statement.
*/
function shortcutContext(flags) {
	if (flags.inEditor === true) return "editor";
	const tag = typeof flags.tagName === "string" ? flags.tagName.toUpperCase() : "";
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return "input";
	if (flags.contentEditable === true) return "input";
	return "canvas";
}
/**
* The items for one right-click (§6.4), as data.
*
* Everything that *decides* the menu is here — which kind was hit, whether the
* menu acts on one node or on a multi-selection, and whether a task is running —
* so the shape §6.4 asks for is asserted directly in tests, while the view only
* maps ids to handlers.
*
* Items whose implementation belongs to a later task are present and `disabled`
* with the reason attached rather than omitted: the user sees that the action
* exists and is not wired, which is more honest than a menu that silently grows
* new entries between releases. Cross-board copy/move is C12 (§7.2), the layout
* node and its export are C13, board export is C15, and the task entries are C11
* — that last group is also why `nodeKind` is a parameter now (C11 turns the
* kind on, not this function).
*
* Batch (`selectionSize >= 2`) menus act on the whole selection, so they offer no
* single-image affordances: "用作参考" for two pictures is an ambiguous command.
* Alignment is deliberately *not* in the menu — it has §6.2's dedicated toolbar,
* which appears on the same selection.
*/
function contextMenuItems(target) {
	if (target.kind === "blank") return [
		{
			id: "new-layout",
			label: "新建布局节点",
			disabled: true,
			hint: "布局节点随 C13 落地"
		},
		{
			id: "paste",
			label: "粘贴",
			disabled: true,
			hint: "跨板粘贴随 C12 落地（服务端 copy-item）"
		},
		{
			id: "select-all",
			label: "全选"
		},
		{
			id: "fit",
			label: "适应视图"
		},
		{
			id: "export-board",
			label: "导出画板…",
			disabled: true,
			hint: "导出随 C15 落地"
		}
	];
	const kind = target.nodeKind ?? "image";
	if (kind === "task") return target.taskState === "queued" || target.taskState === "running" ? [{
		id: "task-cancel",
		label: "取消",
		disabled: true,
		hint: "任务节点随 C11 落地"
	}, {
		id: "remove",
		label: "从画布移除（不删文件）"
	}] : [
		{
			id: "task-retry",
			label: "重试",
			disabled: true,
			hint: "任务节点随 C11 落地"
		},
		{
			id: "task-edit",
			label: "编辑参数重发",
			disabled: true,
			hint: "任务节点随 C11 落地"
		},
		{
			id: "remove",
			label: "从画布移除（不删文件）"
		}
	];
	if (kind === "layout") return [
		{
			id: "layout-generate",
			label: "生成",
			disabled: true,
			hint: "布局入参契约随 T21/C14"
		},
		{
			id: "layout-send-form",
			label: "发送到表单",
			disabled: true,
			hint: "布局节点随 C13 落地"
		},
		{
			id: "layout-export-draft",
			label: "导出 draft",
			disabled: true,
			hint: "布局节点随 C13 落地"
		},
		{
			id: "layout-export-compiled",
			label: "导出 compiled",
			disabled: true,
			hint: "布局节点随 C13 落地"
		},
		{
			id: "remove",
			label: "删除节点"
		}
	];
	const count = Math.max(1, Math.floor(target.selectionSize ?? 1));
	if (count >= 2) return [
		{
			id: "remove",
			label: `从画布移除所选 ${String(count)} 张（不删文件）`
		},
		{
			id: "copy-item",
			label: "复制所选到画板…",
			disabled: true,
			hint: "跨板复制随 C12 落地（服务端 copy-item）"
		},
		{
			id: "move-item",
			label: "移动所选到画板…",
			disabled: true,
			hint: "跨板移动随 C12 落地（服务端 move-item）"
		},
		{
			id: "delete-file",
			label: `删除所选 ${String(count)} 个文件…`,
			danger: true,
			hint: "逐个二次确认太吵，这里只确认一次"
		}
	];
	return [
		{
			id: "reference",
			label: "用作参考"
		},
		{
			id: "branch",
			label: "按这张图迭代（预填表单）"
		},
		{
			id: "original",
			label: "查看原图（新窗）"
		},
		{
			id: "copy-item",
			label: "复制到画板…",
			disabled: true,
			hint: "跨板复制随 C12 落地（服务端 copy-item）"
		},
		{
			id: "move-item",
			label: "移动到画板…",
			disabled: true,
			hint: "跨板移动随 C12 落地（服务端 move-item）"
		},
		{
			id: "remove",
			label: "从画布移除（不删文件）"
		},
		{
			id: "delete-file",
			label: "删除文件…",
			danger: true,
			hint: "二次确认后删除磁盘上的 PNG"
		}
	];
}
//#endregion
//#region src/studio-view.ts
/**
* The Studio panel: a ComfyUI-backed Qwen-Image workbench rendered as a
* first-class **global panel** of the web client.
*
* ## Where it is seated
*
* The layout shell's root-scoped `main` keyed slot holds the workbench, and a
* `sidebar.panellist` entry (same id, {@link StudioPanelIcon} glyph, `图像工作台`
* label) puts it in the left sidebar — both descriptors live in
* `./settings-section.ts` and are wired up by the client entry. The plugin's
* settings section is pure configuration now; it no longer carries this panel.
*
* The previous seat was the settings section (`settings.section`, a **list**
* slot), chosen because the right sidebar's pane-tab seat belongs to
* `@deepseek-ai/dsh-client-ui-sidebar-right`, which a profile does not
* necessarily install. The global-panel slots are declared by the shell itself,
* so the workbench is reachable from the sidebar without depending on an
* optional profile package.
*
* ## What the canvas is now, and what it is still not
*
* The reference Studio ships a tldraw infinite canvas and a multi-provider
* comparison grid. The canvas is not a wall of finished pictures any more: it is
* where the work happens, with images, generation tasks and layout drafts as
* first-class nodes and persisted lineage edges between them (the direction
* change is written down as D6 in `docs/CANVAS-DESIGN.md`; the earlier note here
* said a node was only ever a result, and that is no longer the contract).
*
* What is still not ported: tldraw itself. It is a ~1 MB client dependency, and
* its shape system, drawing tools and collaboration model answer questions this
* workbench does not ask — the camera arithmetic this file drives is pure,
* unit-tested and already enough for pan/zoom/fit (§12 of the design). The
* comparison grid is out too: this Studio intentionally has exactly one backend.
*
* Nor is this a Comfy-style parameter graph. Edges mean "this came from that" —
* derivation, references, layouts — never "output A feeds input B of node C";
* the generation request stays a form, not a wiring diagram, and the backend
* (HTTP/MCP) is untouched by this canvas. The loop is still prompt → optimise →
* ratio/steps/references → generate → inspect → reuse.
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
/**
* Consecutive arrow-key nudges inside this window merge into one undo step.
*
* §6.3 asks for the merge ("合并连续微移为一条命令"); without a window every
* key press would put a step on the stack and Ctrl+Z would walk back one pixel at
* a time. 700 ms is longer than a held key's repeat rate and shorter than "I
* went to look at something else".
*/
const NUDGE_MERGE_MS = 700;
/** The §6.2 toolbar's six buttons, in the order §6.2 lists them. */
const ALIGN_LABELS = {
	left: "左对齐",
	"center-h": "水平居中",
	right: "右对齐",
	top: "顶对齐",
	"center-v": "垂直居中",
	bottom: "底对齐"
};
/** The §6.2 distribute buttons, one per axis. */
const DISTRIBUTE_LABELS = {
	x: "水平等距",
	y: "垂直等距"
};
/**
* World-space rectangle a node occupies.
*
* The width follows the picture's aspect ratio ({@link nodeDisplaySize}), so an
* edge anchors on the right edge of *this* node rather than a shared constant,
* and `nextNodeSpot` clears the widest neighbour instead of the default box. The
* height stays constant: caption and actions live below the picture area.
*/
function nodeRect(node) {
	const size = nodeDisplaySize(node.image.width, node.image.height);
	return {
		x: node.x,
		y: node.y,
		width: size.width,
		height: size.height
	};
}
/**
* `nodeRect` for every node, carrying the id the interaction layer keys by.
*
* `nodeRect` alone drops the id (a node's rectangle is geometry, not identity),
* while every C08 function — marquee hit-testing, alignment, distribution —
* returns positions keyed by id. Composing the two here keeps that join in one
* place instead of at each call site.
*/
function nodeRects(nodes) {
	return nodes.map((node) => ({
		id: node.id,
		...nodeRect(node)
	}));
}
/**
* Grid a board item lands on when it was never placed. Mirrors the host store:
* `GRID_PITCH_X`/`GRID_PITCH_Y`/`GRID_ORIGIN` in `src/boards.ts`, which is the
* authority — the numbers are restated here only because the canvas computes the
* same fallback for an item whose stored position is missing. The X pitch is
* `MAX_NODE_WIDTH (480) + 36` (DD16): a node is as wide as its picture allows,
* so the pitch must clear the widest one or unplaced items overlap.
*/
function fallbackSpot(index) {
	return {
		x: 40 + index % 3 * 516,
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
				mode: first?.mode ?? "generate",
				turboFallback: false
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
* The left-sidebar glyph for the Studio panel.
*
* `sidebar.panellist` seats render one icon per global panel; the sidebar calls
* the entry with `{ size, active }`. The glyph is stroke-based and paints with
* `currentColor`, so it follows the rail's own hover/active colours instead of
* carrying a palette of its own.
*
* @param props - the sidebar's `{ size, active }` render props.
* @returns the glyph; a missing or non-finite `size` falls back to 18px.
*/
function StudioPanelIcon(props) {
	const size = typeof props?.size === "number" && Number.isFinite(props.size) ? props.size : 18;
	return (0, react.createElement)("svg", {
		width: size,
		height: size,
		viewBox: "0 0 16 16",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.2,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": true,
		focusable: "false"
	}, [
		(0, react.createElement)("rect", {
			key: "frame",
			x: 1.8,
			y: 2.4,
			width: 12.4,
			height: 11.2,
			rx: 1.6
		}),
		(0, react.createElement)("circle", {
			key: "sun",
			cx: 5.4,
			cy: 6,
			r: 1.1
		}),
		(0, react.createElement)("path", {
			key: "ridge",
			d: "M2.6 12.2l3.4-3.6 2.3 2.4 1.9-2.1 3.2 3.3"
		})
	]);
}
/** Before the first frame: waiting for the bridge, nothing running. */
const INITIAL_LIVE_PROGRESS = {
	phase: "idle",
	bridge: "connecting",
	queue: 0
};
/**
* Parse one SSE `data:` payload.
*
* The stream comes from this plugin, but a message is still untrusted input:
* a malformed frame is dropped rather than allowed to throw inside a listener.
*
* @param raw - the `MessageEvent.data` value.
* @returns the event, when the payload is a JSON object with a string `type`.
*/
function parseProgressEvent(raw) {
	if (typeof raw !== "string") return void 0;
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	return typeof value.type === "string" ? value : void 0;
}
/**
* Fold one event from {@link STUDIO_EVENTS_ROUTE} into the panel's live state.
*
* Pure on purpose: the SSE listener only calls `setLive` with the result, so
* the state machine can be read — and reasoned about — without a renderer. A
* `queue` frame is the only one that can move the phase backwards, and only
* from `queued`/`idle`: a finished run must not turn back into "waiting"
* because a later broadcast says the queue is empty.
*
* @param current - the state before the event.
* @param event - one normalized progress event.
* @returns the next state.
*/
function reduceProgressEvent(current, event) {
	switch (event.type) {
		case "state": return {
			...current,
			bridge: event.state === "connected" ? "connected" : event.state === "connecting" ? "connecting" : "disconnected",
			...event.endpoint === void 0 ? {} : { endpoint: event.endpoint },
			...event.reason === void 0 ? {} : { bridgeNote: event.reason }
		};
		case "queue": {
			const waiting = current.phase === "idle" || current.phase === "queued";
			return {
				...current,
				queue: event.remaining,
				...waiting ? { phase: event.remaining > 0 ? "queued" : "idle" } : {}
			};
		}
		case "start": return {
			...current,
			phase: "running",
			label: void 0,
			percent: 0,
			message: void 0
		};
		case "progress": return {
			...current,
			phase: "running",
			label: event.label,
			percent: event.percent,
			message: void 0
		};
		case "done": return {
			...current,
			phase: "done",
			percent: 100,
			message: void 0
		};
		case "error": return {
			...current,
			phase: "error",
			message: event.message
		};
		case "interrupted": return {
			...current,
			phase: "interrupted",
			message: "已中断"
		};
		default: return current;
	}
}
/** The run-status line: what phase and step the panel should print. */
function progressStepText(live) {
	if (live.phase === "running") return live.label === void 0 ? "生成中…（等待第一步）" : `第 ${live.label} 步`;
	if (live.phase === "queued") return live.queue > 0 ? `排队中 · 前面还有 ${String(live.queue)} 个任务` : "排队中…";
	if (live.phase === "done") return live.label === void 0 ? "本次生成完成" : `本次生成完成（${live.label}）`;
	if (live.phase === "error") return `生成失败：${live.message ?? "未知错误"}`;
	if (live.phase === "interrupted") return "生成已中断";
	return "等待生成";
}
/**
* The bridge line: connection state with a reason, never an endless spinner.
*
* A stopped ComfyUI is the case this copy is for — the panel must say what is
* down and that generating over HTTP still works, instead of showing a frozen
* step counter forever.
*/
function progressBridgeText(live) {
	if (live.bridge === "connected") return live.endpoint === void 0 ? "实时进度已连接" : `实时进度已连接 · ${live.endpoint}`;
	if (live.bridge === "reconnecting") return "实时进度连接中断，正在重连…";
	if (live.bridge === "disconnected") return `实时进度断开：${live.bridgeNote ?? "ComfyUI 未连接"}（出图仍会走 HTTP，不影响本次生成）`;
	return "实时进度连接中…";
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
	const [live, setLive] = (0, react.useState)(INITIAL_LIVE_PROGRESS);
	const [promptStyle, setPromptStyle] = (0, react.useState)("prose");
	const [view, setView] = (0, react.useState)("canvas");
	const [nodes, setNodes] = (0, react.useState)([]);
	const [camera, setCamera] = (0, react.useState)({
		x: -28,
		y: -28,
		zoom: 1
	});
	const [viewport, setViewport] = (0, react.useState)({
		width: 0,
		height: 0
	});
	const [selection, setSelection] = (0, react.useState)(/* @__PURE__ */ new Set());
	const canvasRef = (0, react.useRef)(null);
	const gestureRef = (0, react.useRef)(void 0);
	const pointerRef = (0, react.useRef)(void 0);
	const frameRef = (0, react.useRef)(void 0);
	const [marquee, setMarquee] = (0, react.useState)(void 0);
	const [menu, setMenu] = (0, react.useState)(void 0);
	const panRef = (0, react.useRef)(false);
	const [panHeld, setPanHeld] = (0, react.useState)(false);
	const [handMode, setHandMode] = (0, react.useState)(false);
	const historyRef = (0, react.useRef)(new CommandStack());
	const nudgeRef = (0, react.useRef)(void 0);
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
			setSelection(/* @__PURE__ */ new Set());
			setMenu(void 0);
			historyRef.current.clear();
			nudgeRef.current = void 0;
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
			setSelection(/* @__PURE__ */ new Set());
			setMenu(void 0);
			historyRef.current.clear();
			nudgeRef.current = void 0;
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
	(0, react.useEffect)(() => {
		if (typeof EventSource === "undefined") {
			setLive((current) => ({
				...current,
				bridge: "disconnected",
				bridgeNote: "当前环境不支持 EventSource"
			}));
			return;
		}
		const source = new EventSource(STUDIO_EVENTS_ROUTE);
		source.addEventListener("message", (event) => {
			const parsed = parseProgressEvent(event.data);
			if (parsed !== void 0) setLive((current) => reduceProgressEvent(current, parsed));
		});
		source.addEventListener("error", () => {
			setLive((current) => ({
				...current,
				bridge: "reconnecting"
			}));
		});
		return () => {
			source.close();
		};
	}, []);
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
			setNote(`${String(result.width)}×${String(result.height)} · ${String(result.steps)} 步 · seed ${String(result.seed)} · ${(result.elapsedMs / 1e3).toFixed(1)} 秒` + (result.turboFallback === true ? " · 本次按 base 权重出图，turbo 权重未安装" : ""));
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
				setSelection(/* @__PURE__ */ new Set([first.id]));
				const firstRect = nodeRect(first);
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
						return first.x < visible.right - firstRect.width * .4 && first.y < visible.bottom - firstRect.height * .4 && first.y > visible.top - firstRect.height * .6 ? current : {
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
	(0, react.useEffect)(() => {
		const element = canvasRef.current;
		if (element === null || view !== "canvas") return void 0;
		const measure = () => {
			const box = element.getBoundingClientRect();
			setViewport((current) => current.width === box.width && current.height === box.height ? current : {
				width: box.width,
				height: box.height
			});
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", measure);
			return () => {
				window.removeEventListener("resize", measure);
			};
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => {
			observer.disconnect();
		};
	}, [view]);
	/**
	* The board as rectangles, the edges between them, and what this frame shows.
	*
	* Two memos on purpose: `graph` (rects + the id index + the resolved edge
	* list) is rebuilt only when a node moves, while the visible subsets follow
	* the camera. Panning therefore never re-touches `parents` or re-looks-up a
	* parent — it only intersects rectangles.
	*/
	const graph = (0, react.useMemo)(() => {
		const views = nodes.map((node) => ({
			id: node.id,
			parents: node.parents,
			node,
			...nodeRect(node)
		}));
		return {
			views,
			edges: buildEdges(views, nodeIndex(views))
		};
	}, [nodes]);
	const cullRect = (0, react.useMemo)(() => visibleWorldRect(camera, viewport), [camera, viewport]);
	const shown = (0, react.useMemo)(() => visibleNodes(graph.views, camera, viewport), [
		graph,
		camera,
		viewport
	]);
	const shownEdges = (0, react.useMemo)(() => visibleEdges(graph.edges, cullRect), [graph, cullRect]);
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
	/** Write the node list everywhere it is read: React state *and* the refs. */
	const writeNodes = (0, react.useCallback)((next) => {
		nodesRef.current = next;
		setNodes(next);
	}, []);
	/** Set the coordinates of every node in `positions` in one write. */
	const applyPositions = (0, react.useCallback)((positions) => {
		writeNodes(nodesRef.current.map((node) => {
			const point = positions.get(node.id);
			return point === void 0 ? node : {
				...node,
				x: point.x,
				y: point.y
			};
		}));
	}, [writeNodes]);
	/** Where those ids are right now — the `before` side of an undo step. */
	const positionsOf = (0, react.useCallback)((ids) => {
		const index = new Map(nodesRef.current.map((node) => [node.id, node]));
		const positions = /* @__PURE__ */ new Map();
		for (const id of ids) {
			const node = index.get(id);
			if (node !== void 0) positions.set(id, {
				x: node.x,
				y: node.y
			});
		}
		return positions;
	}, []);
	/**
	* The selected nodes as world rectangles, from the **full** node list.
	*
	* Not `shown`: §6.1's hit rules run over every node on the board, so a marquee
	* that leaves the viewport, a select-all, and an alignment of a selection that
	* is partly culled must still see everything (the C07 note says the same).
	*/
	const selectionRects = (0, react.useCallback)((ids) => nodeRects(nodesRef.current.filter((node) => ids.has(node.id))), []);
	/**
	* Put an already-applied change on the undo stack.
	*
	* `CommandStack.push` does not apply: by the time a drag ends, the nodes have
	* moved — the command only remembers where they were.
	*/
	const pushCommand = (0, react.useCallback)((command) => {
		nudgeRef.current = void 0;
		historyRef.current.push(command);
	}, []);
	/** One undoable coordinate change, for a batch of nodes. */
	const moveCommand = (0, react.useCallback)((label, before, after) => snapshotCommand(label, before, after, (positions) => {
		applyPositions(positions);
	}), [applyPositions]);
	/** Move a batch, record one step, save once. */
	const applyPositionsCommand = (0, react.useCallback)((label, after) => {
		const before = positionsOf(after.keys());
		applyPositions(after);
		pushCommand(moveCommand(label, before, after));
		scheduleLayout();
	}, [
		applyPositions,
		moveCommand,
		positionsOf,
		pushCommand,
		scheduleLayout
	]);
	/** Align the selection to its own bounding box (§6.2); needs two nodes. */
	const alignSelection = (0, react.useCallback)((mode) => {
		const rects = selectionRects(selection);
		if (rects.length < 2) return;
		applyPositionsCommand(`align-${mode}`, alignNodes(rects, mode));
	}, [
		applyPositionsCommand,
		selection,
		selectionRects
	]);
	/** Space the selection's centres evenly (§6.2); needs three nodes. */
	const distributeSelection = (0, react.useCallback)((axis) => {
		const rects = selectionRects(selection);
		if (rects.length < 3) return;
		applyPositionsCommand(`distribute-${axis}`, distributeNodes(rects, axis));
	}, [
		applyPositionsCommand,
		selection,
		selectionRects
	]);
	/**
	* Arrow-key nudge (§6.3), coalesced into one undo step per run.
	*
	* §6.3 asks for the merge: without it every key press would be its own step and
	* Ctrl+Z would walk back one world unit at a time. The step already on the
	* stack reads its `after` map *by reference*, so extending the run is a matter
	* of rewriting that map — no second push, and the redo tail keeps pointing at
	* the same command.
	*/
	const nudge = (0, react.useCallback)((axis, fast) => {
		const ids = [...selection];
		if (ids.length === 0) return;
		const delta = nudgeVector(axis, fast);
		const from = positionsOf(ids);
		const to = /* @__PURE__ */ new Map();
		for (const [id, point] of from) to.set(id, {
			x: point.x + delta.x,
			y: point.y + delta.y
		});
		const signature = ids.join("");
		const now = Date.now();
		const open = nudgeRef.current;
		if (open !== void 0 && open.signature === signature && now - open.at <= NUDGE_MERGE_MS) {
			open.after.clear();
			for (const [id, point] of to) open.after.set(id, point);
			open.at = now;
			applyPositions(open.after);
			scheduleLayout();
			return;
		}
		const before = new Map(from);
		const after = new Map(to);
		const command = snapshotCommand("nudge", before, after, (positions) => {
			applyPositions(positions);
		});
		nudgeRef.current = {
			at: now,
			signature,
			before,
			after,
			command
		};
		historyRef.current.push(command);
		applyPositions(after);
		scheduleLayout();
	}, [
		applyPositions,
		positionsOf,
		scheduleLayout,
		selection
	]);
	const undoHistory = (0, react.useCallback)(() => {
		nudgeRef.current = void 0;
		if (!historyRef.current.undo()) return;
		scheduleLayout();
	}, [scheduleLayout]);
	const redoHistory = (0, react.useCallback)(() => {
		nudgeRef.current = void 0;
		if (!historyRef.current.redo()) return;
		scheduleLayout();
	}, [scheduleLayout]);
	/**
	* Remove nodes from the board — unplace, never delete files (§6.3).
	*
	* `deleteFile` is the explicit second action a right-click offers (§6.4), and
	* it keeps the shipped wording of the asset page's confirm.
	*
	* The host write is not part of the undo step: the stack restores the canvas,
	* because DD9 keeps history in memory and the board is written by several
	* actors (§6.5). Reloading after undoing a removal shows the item gone — the
	* honest limit of a session-scoped stack, stated rather than papered over.
	*/
	const removeNodes = (0, react.useCallback)((ids, deleteFile = false) => {
		const drop = new Set(ids);
		if (drop.size === 0) return;
		const before = nodesRef.current;
		const after = before.filter((node) => !drop.has(node.id));
		if (after.length === before.length) return;
		writeNodes(after);
		setReferences((current) => current.filter((entry) => entry.nodeId === void 0 || !drop.has(entry.nodeId)));
		setSelection((current) => {
			const next = /* @__PURE__ */ new Set();
			for (const id of current) if (!drop.has(id)) next.add(id);
			return next;
		});
		pushCommand(snapshotCommand("remove", before, after, (list) => {
			writeNodes([...list]);
		}));
		const board = boardIdRef.current;
		if (board === void 0) return;
		for (const id of drop) postBoard({
			action: "remove-item",
			board,
			item: id,
			...deleteFile ? { deleteFile: true } : {}
		}).then((error) => {
			if (error !== void 0) setBoardError(error);
		});
	}, [pushCommand, writeNodes]);
	/** The single-node form the inline node actions still use. */
	const removeNode = (0, react.useCallback)((id) => {
		removeNodes([id]);
	}, [removeNodes]);
	/** Replace the selection with exactly one node (or with none). */
	const selectOnly = (0, react.useCallback)((id) => {
		setSelection(id === void 0 ? /* @__PURE__ */ new Set() : /* @__PURE__ */ new Set([id]));
	}, []);
	/**
	* Pointer-down on blank canvas: marquee by default, pan on Space / middle.
	*
	* §6.6 changes the old default on purpose — a blank drag used to pan and now
	* boxes a selection, because that is the commoner gesture on a generation
	* canvas. All three pan entries survive: Space+drag, middle-button drag, and
	* the toolbar's hand toggle (`panRef`). The right-click menu is the other
	* blank-canvas gesture and is handled by `onCanvasContextMenu`.
	*/
	const onCanvasPointerDown = (0, react.useCallback)((event) => {
		if (event.button !== 0 && event.button !== 1) return;
		const target = event.target;
		setMenu(void 0);
		if (target.closest(".dsh-forge-node") !== null) return;
		event.currentTarget.focus();
		event.currentTarget.setPointerCapture(event.pointerId);
		pointerRef.current = void 0;
		if (event.button === 1 || panRef.current || handMode) {
			gestureRef.current = {
				kind: "pan",
				startX: event.clientX,
				startY: event.clientY,
				camera
			};
			return;
		}
		const box = event.currentTarget.getBoundingClientRect();
		gestureRef.current = {
			kind: "marquee",
			startX: event.clientX - box.left,
			startY: event.clientY - box.top,
			base: selection,
			additive: event.shiftKey,
			left: box.left,
			top: box.top
		};
		if (!event.shiftKey) setSelection(/* @__PURE__ */ new Set());
	}, [
		camera,
		handMode,
		selection
	]);
	/**
	* Pointer-down on a node: select (or toggle) it and start the batch drag.
	*
	* Clicking a node that is already part of a multi-selection keeps the whole set
	* — that is the only way to drag several nodes at once (§6.1). Ctrl/Cmd+click
	* toggles membership; toggling a node *out* starts no drag, because the pointer
	* is on something that just left the selection.
	*/
	const onNodePointerDown = (0, react.useCallback)((event, node) => {
		if (event.button !== 0) return;
		event.stopPropagation();
		setMenu(void 0);
		event.currentTarget.setPointerCapture(event.pointerId);
		const additive = event.ctrlKey || event.metaKey;
		let next;
		if (additive) next = toggleSelection(selection, node.id, true);
		else if (selection.has(node.id)) next = selection;
		else next = toggleSelection(selection, node.id, false);
		setSelection(next);
		pointerRef.current = void 0;
		if (!next.has(node.id)) {
			gestureRef.current = void 0;
			return;
		}
		gestureRef.current = {
			kind: "node",
			ids: [...next],
			origins: positionsOf(next),
			startX: event.clientX,
			startY: event.clientY
		};
	}, [positionsOf, selection]);
	/**
	* Apply the pointer position buffered by the latest move event.
	*
	* Every gesture kind is computed from the *gesture start*, never from the
	* previous frame, so applying only the last position is exact: nothing
	* accumulates and the end position is the same whether one frame ran or sixty
	* (§10.3). The pending frame is cancelled here so a manual flush (pointerup)
	* cannot be followed by a second, stale one.
	*/
	const flushPointer = (0, react.useCallback)(() => {
		if (frameRef.current !== void 0) {
			cancelAnimationFrame(frameRef.current);
			frameRef.current = void 0;
		}
		const pointer = pointerRef.current;
		pointerRef.current = void 0;
		const gesture = gestureRef.current;
		if (gesture === void 0 || pointer === void 0) return;
		if (gesture.kind === "pan") {
			setCamera(panBy(gesture.camera, {
				x: pointer.x - gesture.startX,
				y: pointer.y - gesture.startY
			}));
			return;
		}
		if (gesture.kind === "node") {
			const moved = moveSelection(gesture.origins, {
				x: pointer.x - gesture.startX,
				y: pointer.y - gesture.startY
			}, cameraRef.current.zoom);
			applyPositions(moved);
			return;
		}
		const start = {
			x: gesture.startX,
			y: gesture.startY
		};
		const current = {
			x: pointer.x - gesture.left,
			y: pointer.y - gesture.top
		};
		const world = marqueeWorldRect(cameraRef.current, start, current);
		const hits = nodesInRect(nodeRects(nodesRef.current), world);
		setSelection(marqueeSelection(gesture.base, hits, gesture.additive));
		setMarquee({
			x: Math.min(start.x, current.x),
			y: Math.min(start.y, current.y),
			width: Math.abs(current.x - start.x),
			height: Math.abs(current.y - start.y)
		});
	}, [applyPositions]);
	/**
	* Buffer the pointer and let one animation frame apply it.
	*
	* A high-refresh pointer fires several `pointermove` events per frame; each
	* one used to be a full re-render (`setCamera`/`setNodes`). Coalescing them
	* keeps the work at one render per frame while the visible result is
	* unchanged, because the geometry is derived from the gesture origin.
	*/
	const onCanvasPointerMove = (0, react.useCallback)((event) => {
		if (gestureRef.current === void 0) return;
		pointerRef.current = {
			x: event.clientX,
			y: event.clientY
		};
		if (frameRef.current !== void 0) return;
		frameRef.current = requestAnimationFrame(() => {
			flushPointer();
		});
	}, [flushPointer]);
	/**
	* End the gesture: flush the last position, record the step, save once.
	*
	* The release position is read *before* `flushPointer` clears it — the undo
	* step has to record where the nodes actually ended up. The step is built from
	* the gesture's own origins plus the final delta (never from the state that
	* `flushPointer` just wrote), which is what keeps a rubber-banded frame from
	* recording a position the user never saw.
	*/
	const endGesture = (0, react.useCallback)(() => {
		const gesture = gestureRef.current;
		if (gesture === void 0) {
			pointerRef.current = void 0;
			if (frameRef.current !== void 0) {
				cancelAnimationFrame(frameRef.current);
				frameRef.current = void 0;
			}
			return;
		}
		const pointer = pointerRef.current;
		flushPointer();
		gestureRef.current = void 0;
		setMarquee(void 0);
		if (gesture.kind === "marquee") return;
		if (gesture.kind === "node" && pointer !== void 0) {
			const after = moveSelection(gesture.origins, {
				x: pointer.x - gesture.startX,
				y: pointer.y - gesture.startY
			}, cameraRef.current.zoom);
			let moved = false;
			for (const [id, point] of after) {
				const origin = gesture.origins.get(id);
				if (origin === void 0 || origin.x !== point.x || origin.y !== point.y) {
					moved = true;
					break;
				}
			}
			if (!moved) return;
			pushCommand(moveCommand("move", new Map(gesture.origins), after));
		}
		scheduleLayout();
	}, [
		flushPointer,
		moveCommand,
		pushCommand,
		scheduleLayout
	]);
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
	/**
	* The §6.3 keyboard, dispatched through the C08 table.
	*
	* The DOM inspection stays here — `tagName`, `contentEditable`, and the layout
	* editor's container — and `shortcutContext` decides whether the canvas still
	* owns the keys. Inside the form or the editor the table answers `none`, so a
	* Delete key edits text and Ctrl+Z edits text, which is the whole point of the
	* yield rule.
	*
	* Copy/paste are in the table but land with C12: the cross-board clipboard is a
	* service-side action (§7.2), so those two actions are deliberately inert here
	* rather than aliased onto something local.
	*/
	const onCanvasKeyDown = (0, react.useCallback)((event) => {
		const target = event.target;
		const context = shortcutContext({
			tagName: target?.tagName,
			contentEditable: target?.isContentEditable === true,
			inEditor: target?.closest?.("[data-dsh-layout-editor], .dsh-forge-layout-editor") != null
		});
		const action = resolveShortcut(event.key, {
			ctrl: event.ctrlKey,
			meta: event.metaKey,
			shift: event.shiftKey
		}, context);
		if (action === "none") return;
		event.preventDefault();
		switch (action) {
			case "remove":
				removeNodes([...selection]);
				break;
			case "undo":
				undoHistory();
				break;
			case "redo":
				redoHistory();
				break;
			case "select-all":
				setSelection(new Set(nodesRef.current.map((node) => node.id)));
				break;
			case "escape":
				if (gestureRef.current?.kind === "marquee") {
					gestureRef.current = void 0;
					pointerRef.current = void 0;
					if (frameRef.current !== void 0) {
						cancelAnimationFrame(frameRef.current);
						frameRef.current = void 0;
					}
				}
				setMenu(void 0);
				setMarquee(void 0);
				setSelection(/* @__PURE__ */ new Set());
				break;
			case "pan-mode":
				panRef.current = true;
				setPanHeld(true);
				break;
			case "fit":
				fitView();
				break;
			case "zoom-in":
				zoomBy(1.25);
				break;
			case "zoom-out":
				zoomBy(1 / 1.25);
				break;
			case "nudge-left":
				nudge("left", event.shiftKey);
				break;
			case "nudge-right":
				nudge("right", event.shiftKey);
				break;
			case "nudge-up":
				nudge("up", event.shiftKey);
				break;
			case "nudge-down": nudge("down", event.shiftKey);
		}
	}, [
		fitView,
		nudge,
		redoHistory,
		removeNodes,
		selection,
		undoHistory,
		zoomBy
	]);
	/** Space is a held modifier: releasing it hands the pointer back to selection. */
	const onCanvasKeyUp = (0, react.useCallback)((event) => {
		if (event.key !== " " && event.key !== "Space" && event.key !== "Spacebar") return;
		panRef.current = false;
		setPanHeld(false);
	}, []);
	/** The nodes a context action applies to: the selection, or one node. */
	const menuIds = (0, react.useCallback)((target) => {
		if (target !== void 0 && !selection.has(target)) return [target];
		return [...selection];
	}, [selection]);
	/**
	* Open the §6.4 menu at the pointer.
	*
	* The item list is generated by the pure `contextMenuItems`, so what the menu
	* offers is unit-testable and the handler below only maps ids to actions. A
	* right-click on a node outside the selection selects it first — a menu acting
	* on something the user cannot see selected is a trap.
	*/
	const onCanvasContextMenu = (0, react.useCallback)((event) => {
		event.preventDefault();
		const box = event.currentTarget.getBoundingClientRect();
		const hit = event.target.closest(".dsh-forge-node");
		const target = hit === null ? void 0 : hit.dataset.nodeId;
		let size = selection.size;
		if (target !== void 0 && !selection.has(target)) {
			setSelection(/* @__PURE__ */ new Set([target]));
			size = 1;
		}
		const items = contextMenuItems(target === void 0 ? { kind: "blank" } : {
			kind: "node",
			nodeKind: "image",
			selectionSize: size
		});
		setMenu({
			x: event.clientX - box.left,
			y: event.clientY - box.top,
			items,
			target
		});
	}, [selection]);
	/**
	* Run one menu item (§6.4).
	*
	* Items that belong to a node kind this build does not make yet (task, layout)
	* or to a later task (cross-board copy is C12, export is C15) arrive disabled,
	* so their ids never reach this switch. The `default` arm is therefore the
	* "not wired yet" arm, not a silent bug.
	*/
	const runContextAction = (0, react.useCallback)((id) => {
		const target = menu?.target;
		setMenu(void 0);
		switch (id) {
			case "select-all":
				setSelection(new Set(nodesRef.current.map((node) => node.id)));
				break;
			case "fit":
				fitView();
				break;
			case "remove":
				removeNodes(menuIds(target));
				break;
			case "delete-file":
				if (!window.confirm("同时删除磁盘上的这个 PNG？此操作不可撤销。")) break;
				removeNodes(menuIds(target), true);
				break;
			case "reference": {
				const node = nodesRef.current.find((entry) => entry.id === target);
				if (node !== void 0) referenceNode(node);
				break;
			}
			case "branch": {
				const node = nodesRef.current.find((entry) => entry.id === target);
				if (node !== void 0) referenceNode(node);
				break;
			}
			case "original": {
				const node = nodesRef.current.find((entry) => entry.id === target);
				if (node !== void 0) window.open(studioFileUrl(node.image.markdownPath), "_blank", "noreferrer");
				break;
			}
		}
	}, [
		fitView,
		menu?.target,
		menuIds,
		referenceNode,
		removeNodes
	]);
	/** Open the board an asset lives on and select it there. */
	const showOnCanvas = (0, react.useCallback)(async (asset) => {
		if (boardIdRef.current !== asset.boardId) await selectBoard(asset.boardId);
		setView("canvas");
		selectOnly(asset.id);
	}, [selectBoard, selectOnly]);
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
		setSelection((current) => {
			if (!current.has(asset.id)) return current;
			const next = new Set(current);
			next.delete(asset.id);
			return next;
		});
		setReferences((current) => current.filter((entry) => !(entry.payload.path === asset.path)));
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
	}, "重新检测"))), (0, react.createElement)("div", {
		className: "dsh-forge-progress",
		"data-phase": live.phase,
		"data-bridge": live.bridge,
		role: "status",
		"aria-live": "polite"
	}, [
		(0, react.createElement)("span", {
			key: "step",
			className: "dsh-forge-progress-step"
		}, progressStepText(live)),
		live.percent === void 0 ? null : (0, react.createElement)("span", {
			key: "bar",
			className: "dsh-forge-progress-bar",
			style: {
				display: "block",
				height: "4px",
				borderRadius: "2px",
				background: "rgba(127,127,127,.22)",
				overflow: "hidden"
			}
		}, (0, react.createElement)("i", {
			className: "dsh-forge-progress-fill",
			style: {
				display: "block",
				height: "100%",
				width: `${String(live.percent)}%`,
				background: "currentColor",
				borderRadius: "2px",
				transition: "width .2s"
			}
		})),
		(0, react.createElement)("span", {
			key: "bridge",
			className: "dsh-forge-progress-bridge"
		}, progressBridgeText(live))
	]), (0, react.createElement)("div", { className: "dsh-forge-board-bar" }, (0, react.createElement)("span", { className: "dsh-forge-board-label" }, "画板"), renaming ? [
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
		title: config?.optimizeAvailable === true ? `用当前对话模型（${config?.optimizeModel ?? "默认模型"}）改成${promptStyle === "formula" ? "关键词公式" : "长散文"}` : config?.optimizeNote ?? "当前会话没有可用的对话模型",
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
	}, label))), view === "canvas" && selection.size >= 2 ? (0, react.createElement)("div", {
		className: "dsh-forge-align",
		role: "group",
		"aria-label": "对齐与分布"
	}, ...ALIGN_MODES.map((mode) => (0, react.createElement)("button", {
		key: mode,
		type: "button",
		className: "dsh-forge-align-btn",
		title: ALIGN_LABELS[mode],
		onClick: () => {
			alignSelection(mode);
		}
	}, ALIGN_LABELS[mode])), ...selection.size >= 3 ? DISTRIBUTE_AXES.map((axis) => (0, react.createElement)("button", {
		key: `distribute-${axis}`,
		type: "button",
		className: "dsh-forge-align-btn is-distribute",
		title: DISTRIBUTE_LABELS[axis],
		onClick: () => {
			distributeSelection(axis);
		}
	}, DISTRIBUTE_LABELS[axis])) : []) : null, view === "canvas" ? (0, react.createElement)("div", { className: "dsh-forge-zoom" }, (0, react.createElement)("button", {
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
	}, "适应"), (0, react.createElement)("button", {
		type: "button",
		className: handMode ? "dsh-forge-btn is-ghost is-active" : "dsh-forge-btn is-ghost",
		title: handMode ? "平移模式：拖空白处移动相机（点击回到框选）" : "切到平移模式：拖空白处移动相机",
		"aria-pressed": handMode,
		onClick: () => {
			setHandMode((current) => !current);
		}
	}, "平移")) : (0, react.createElement)("span", { className: "dsh-forge-batch-meta" }, view === "assets" ? `${String(assetsTotal)} 张素材` : `${String(batches.length)} 批`)), view === "canvas" ? (0, react.createElement)("div", {
		className: panHeld || handMode ? "dsh-forge-canvas is-pan" : "dsh-forge-canvas",
		tabIndex: 0,
		ref: canvasRef,
		onPointerDown: onCanvasPointerDown,
		onPointerMove: onCanvasPointerMove,
		onPointerUp: endGesture,
		onPointerCancel: endGesture,
		onPointerLeave: endGesture,
		onKeyDown: onCanvasKeyDown,
		onKeyUp: onCanvasKeyUp,
		onContextMenu: onCanvasContextMenu,
		onBlur: () => {
			panRef.current = false;
			setPanHeld(false);
		}
	}, nodes.length === 0 && view === "canvas" ? (0, react.createElement)("p", { className: "dsh-forge-canvas-hint" }, busy ? "正在生成…" : "这个画板还是空的。生成的第一张图会落在这里；拖空白处框选，Space 或中键平移，滚轮缩放，拖图可改位置。") : null, (0, react.createElement)("div", {
		className: "dsh-forge-canvas-layer",
		style: { transform: `translate(${String(-camera.x * camera.zoom)}px, ${String(-camera.y * camera.zoom)}px) scale(${String(camera.zoom)})` }
	}, (0, react.createElement)("svg", {
		className: "dsh-forge-canvas-edges",
		width: 1,
		height: 1,
		"aria-hidden": true
	}, ...shownEdges.map((edge) => (0, react.createElement)("path", {
		key: `${edge.parent}->${edge.child}`,
		d: edgePath(edge.from, edge.to),
		className: "dsh-forge-edge"
	}))), ...shown.map((item) => {
		const node = item.node;
		const selected = selection.has(node.id);
		const sole = singleSelection(selection) === node.id;
		return (0, react.createElement)("div", {
			key: node.id,
			className: selected ? "dsh-forge-node is-selected" : "dsh-forge-node",
			"data-node-id": node.id,
			style: {
				left: `${String(node.x)}px`,
				top: `${String(node.y)}px`,
				width: `${String(item.width)}px`
			},
			onPointerDown: (event) => {
				onNodePointerDown(event, node);
			}
		}, (0, react.createElement)("img", {
			src: studioFileUrl(node.image.markdownPath),
			alt: "生成结果",
			draggable: false,
			loading: "lazy"
		}), (0, react.createElement)("div", { className: "dsh-forge-node-meta" }, `${String(node.image.width)}×${String(node.image.height)} · ${String(Math.round(node.image.bytes / 1024))} KB`), sole ? (0, react.createElement)("div", { className: "dsh-forge-node-actions" }, (0, react.createElement)("button", {
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
	})), marquee === void 0 ? null : (0, react.createElement)("div", {
		className: "dsh-forge-marquee",
		style: {
			left: `${String(marquee.x)}px`,
			top: `${String(marquee.y)}px`,
			width: `${String(marquee.width)}px`,
			height: `${String(marquee.height)}px`
		}
	}), menu === void 0 ? null : (0, react.createElement)("div", {
		className: "dsh-forge-context",
		role: "menu",
		style: {
			left: `${String(menu.x)}px`,
			top: `${String(menu.y)}px`
		},
		onPointerDown: (event) => {
			event.stopPropagation();
		},
		onContextMenu: (event) => {
			event.preventDefault();
			event.stopPropagation();
		}
	}, ...menu.items.map((item) => (0, react.createElement)("button", {
		key: item.id,
		type: "button",
		role: "menuitem",
		className: item.danger === true ? "dsh-forge-context-item is-danger" : "dsh-forge-context-item",
		disabled: item.disabled === true,
		title: item.hint ?? item.label,
		onClick: () => {
			runContextAction(item.id);
		}
	}, item.label))), (0, react.createElement)("div", { className: "dsh-forge-canvas-foot" }, references.length === 0 ? "选中图片后可「用作参考」，下一轮会从它拉一条线出来。" : `已选 ${String(references.length)} 张参考图，下一轮将是改图。`)) : view === "assets" ? assetsPanel : batches.length === 0 ? (0, react.createElement)("div", { className: "dsh-forge-studio-empty" }, busy ? "正在生成…" : "还没有结果") : (0, react.createElement)("div", { className: "dsh-forge-list" }, ...batches.map((batch) => (0, react.createElement)("div", {
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
const SETTINGS_TABS = [{
	id: "generate",
	label: "出图",
	hint: "画质步数、图落到哪里。",
	groupIds: ["steps", "output"]
}, {
	id: "comfyui",
	label: "ComfyUI",
	hint: "复用你自己装好的 ComfyUI（本地推荐部署见 docs/comfyui-deployment.md）。",
	groupIds: ["comfyui"]
}];
/** The blocks the page renders, in order. */
const SETTINGS_GROUPS = [
	{
		id: "steps",
		label: "步数（画质与耗时）",
		hint: "base 40 步；turbo 蒸馏版 8 步。"
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
		key: "defaultSteps",
		group: "steps",
		label: "默认步数",
		hint: "base 的默认：40，官方推荐 40–50。",
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
		hint: "turbo 8 步 2.7×；缺权重退回 base；moss 缺报错。",
		kind: "enum",
		choices: [
			{
				value: "qwen21-base",
				label: "qwen21-base（Qwen 40 步）"
			},
			{
				value: "qwen21-turbo",
				label: "qwen21-turbo（8 步蒸馏）"
			},
			{
				value: "moss-sft",
				label: "moss-sft（MOSS-Image 文生图）"
			}
		]
	},
	{
		key: "mossSampling",
		group: "steps",
		label: "MOSS 采样",
		hint: "默认 comfy：25 步/2.5；official：50 步/3，更慢。",
		kind: "enum",
		choices: [{
			value: "comfy",
			label: "comfy（模板口径，25 步）"
		}, {
			value: "official",
			label: "official（OpenMOSS，50 步）"
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
* This module also carries the Studio's **panel seats**: the layout shell's
* root-scoped `main` keyed slot and the sidebar's `sidebar.panellist` list
* entry. They stay pure descriptors here — the client entry hands in the two
* components — so this module still imports neither React nor the Host.
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
/**
* The root-scoped **keyed** slot the layout shell renders global panels in.
*
* Host contract (verified against `@deepseek-ai/dsh-client-ui-layout`'s README
* and the shipped plugin-manager client): global panels occupy this slot,
* `conversation` is the reserved key, and `ctx.layout.selectPanel(id)` selects
* a registered key. A seat here is what makes a sidebar row switch the main
* column to the workbench.
*/
const MAIN_SLOT_NAME = "main";
/**
* The sidebar's **list** slot: one entry per global panel, addressed by `id`.
*
* The sidebar builds its panel list from this slot's entries (`options.id`,
* `options.order`, `options.label`) and renders each entry's component as the
* panel glyph, so the same id has to be used here and in {@link MAIN_SLOT_NAME}.
*/
const SIDEBAR_PANELLIST_SLOT_NAME = "sidebar.panellist";
/**
* The Studio's identity in both slots — and the id `ctx.layout.selectPanel`
* takes. Kept equal to the package name so the panel, the package and the
* profile row all spell it the same way.
*/
const STUDIO_PANEL_ID = "dsh-image-forge";
/** The sidebar label. A function, because the slot resolves labels lazily. */
const STUDIO_PANEL_LABEL = "图像工作台";
/**
* The descriptor for the Studio's `main` seat.
*
* @returns the options passed to `slots.register` for the keyed slot.
*/
function studioPanelOptions() {
	return {
		name: MAIN_SLOT_NAME,
		key: STUDIO_PANEL_ID
	};
}
/**
* The descriptor for the Studio's sidebar entry.
*
* @returns the options passed to `slots.register` for the list slot.
*/
function studioPanellistOptions() {
	return {
		name: SIDEBAR_PANELLIST_SLOT_NAME,
		id: STUDIO_PANEL_ID,
		order: 120,
		label: () => STUDIO_PANEL_LABEL
	};
}
/**
* Seat the Studio as a global panel: the `main` surface plus its sidebar row.
*
* Both registrations go through `slots.inject`, exactly like the settings
* section's own seat: the layout shell declares `main` and the sidebar declares
* `sidebar.panellist`, and on a host whose shell has neither the registrations
* simply never fire — the Agent tools and the settings page are unaffected.
* A throw from one seat is contained so it cannot cost the other one (or the
* tool cards registered in the same client entry).
*
* @param ctx - the client context.
* @param components - the workbench component and its sidebar glyph.
* @returns a disposer; today a no-op because the slot fibers own the seats,
*   matching {@link registerSettingsSection}.
*/
function registerStudioPanel(ctx, components) {
	if (typeof ctx.slots?.inject !== "function" || typeof ctx.slots?.register !== "function") return () => {};
	const seat = (name, options, component) => {
		ctx.slots.inject(name, () => {
			try {
				return ctx.slots.register(options(), component);
			} catch {
				return () => {};
			}
		});
	};
	seat(MAIN_SLOT_NAME, studioPanelOptions, components.panel);
	seat(SIDEBAR_PANELLIST_SLOT_NAME, studioPanellistOptions, components.icon);
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
* Client half: keyed tool views for every `qwen_image_*` tool, the Studio's
* global-panel seats, and the `dsh-image-forge` first-level settings section.
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
*
* ## The Studio panel
*
* The workbench is a **global panel**, not a settings tab: the layout shell's
* root-scoped `main` keyed slot renders it, and a `sidebar.panellist` entry
* puts it in the left sidebar. Both seats come from `registerStudioPanel` in
* `./settings-section.ts`; the surface and its glyph live in
* `./studio-view.ts`. The settings section below is pure configuration.
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
* Status card: a three-cell digest of the health probe.
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
		const comfy = asRecord(payload?.["comfyui"]);
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
			pills: [],
			children: [(0, react.createElement)("div", {
				key: "checks",
				className: "dsh-image-forge-checklist"
			}, [
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
	return [(0, react.createElement)("input", {
		key: "input",
		id: controlId,
		type: "text",
		value: draft ?? (typeof value === "string" ? value : ""),
		disabled,
		placeholder: field.placeholder ?? "",
		onChange: (event) => {
			setDraft(event.target.value);
		},
		onBlur: () => {
			if (draft === null) return;
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
	const [tabId, setTabId] = (0, react.useState)(SETTINGS_TABS[0]?.id ?? "");
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
	if (form === void 0) return (0, react.createElement)("div", { className: "dsh-image-forge-settings" }, [(0, react.createElement)("div", {
		key: "notice",
		className: "dsh-image-forge-settings-notice"
	}, props.unavailableReason ?? "配置表单不可用：参数请在 profile 里改。")]);
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
	}, [(0, react.createElement)("div", {
		key: "tabs",
		className: "dsh-image-forge-tabs",
		role: "tablist"
	}, [...SETTINGS_TABS.map((tab) => (0, react.createElement)("button", {
		key: tab.id,
		type: "button",
		role: "tab",
		className: tab.id === activeTab?.id ? "dsh-image-forge-tab dsh-image-forge-tab-active" : "dsh-image-forge-tab",
		"aria-selected": tab.id === activeTab?.id,
		onClick: () => setTabId(tab.id)
	}, tab.label))]), (0, react.createElement)("div", {
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
* Register the keyed tool views, the Studio's global panel, and the
* first-level settings section.
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
	registerStudioPanel(ctx, {
		panel: StudioPanel,
		icon: StudioPanelIcon
	});
}
//#endregion
exports.apply = apply;
exports.inject = inject;

		return module.exports;
	}
});
