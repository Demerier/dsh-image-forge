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
export const CLIENT_STYLE_ID = 'dsh-image-forge-client-styles'

/**
 * Workbench rules, kept in their own constant and appended to the sheet below.
 *
 * Every surface color is a `currentColor` mix or a translucent accent, so the
 * same sheet works in both Host themes. The layout is two columns above 860 px
 * (form left, results right) and one column below it, because the settings
 * column can be narrow enough that a side-by-side split would clip the ratio
 * row's seven buttons.
 */
export const STUDIO_CSS = `
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
/* C11 §4.2: the task node. A picture node is an <img> plus a caption; a task
   node is a status card, so it needs its own rhythm: badge row, prompt, one
   line of parameters, progress, state copy, actions. Fixed 208×240 (§3.2),
   so the text is clamped instead of the box growing. */
.dsh-forge-node.is-task{display:flex;flex-direction:column;gap:0;background:rgba(127,127,127,.06);cursor:grab}
.dsh-forge-task-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 8px 4px;font-size:10.5px}
.dsh-forge-task-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:999px;border:1px solid rgba(127,127,127,.35);opacity:.85;font-weight:600;white-space:nowrap}
.dsh-forge-task-badge[data-task-status="failed"]{color:#dc2626;border-color:rgba(220,38,38,.45);background:rgba(220,38,38,.07)}
.dsh-forge-task-badge[data-task-status="interrupted"]{color:#b45309;border-color:rgba(180,83,9,.45);background:rgba(180,83,9,.07)}
.dsh-forge-task-badge[data-task-status="running"],.dsh-forge-task-badge[data-task-status="queued"]{color:#3b82f6;border-color:rgba(59,130,246,.45);background:rgba(59,130,246,.08)}
.dsh-forge-task-ratio{opacity:.55;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-forge-task-prompt{padding:0 8px;font-size:11px;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.dsh-forge-task-meta{padding:3px 8px 0;font-size:10px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.dsh-forge-task-bar{margin:6px 8px 0;height:4px;border-radius:2px;background:rgba(127,127,127,.22);overflow:hidden}
.dsh-forge-task-fill{display:block;height:100%;border-radius:2px;background:currentColor;color:#3b82f6;transition:width .18s}
.dsh-forge-task-status{padding:5px 8px 0;font-size:10.5px;line-height:1.45;opacity:.8;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.dsh-forge-task-status.is-failed{color:#dc2626;opacity:1}
.dsh-forge-task-status.is-interrupted{color:#b45309;opacity:1}
.dsh-forge-task-actions{display:flex;gap:4px;padding:6px 6px 6px;flex-wrap:wrap;margin-top:auto}
/* C13 §8.1: the layout node. The title bar is the canvas drag handle, the
   editor fills the body (it scrolls inside the node because the editor's own
   toolbar/fields are taller than the default 420), and the corner grip is the
   width-driven resize handle (§8.3). */
.dsh-forge-node.is-layout{display:flex;flex-direction:column;background:rgba(127,127,127,.06);cursor:default}
.dsh-forge-layout-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 8px;font-size:11px;cursor:grab;border-bottom:1px solid rgba(127,127,127,.22);flex:0 0 auto}
.dsh-forge-layout-title{font-weight:600;opacity:.85;white-space:nowrap}
.dsh-forge-layout-host{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 6px 4px;position:relative}
.dsh-forge-layout-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 8px 5px;font-size:10px;opacity:.6;font-variant-numeric:tabular-nums;flex:0 0 auto;white-space:nowrap;overflow:hidden}
.dsh-forge-layout-grip{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;border-right:2px solid rgba(59,130,246,.7);border-bottom:2px solid rgba(59,130,246,.7);border-bottom-right-radius:4px;z-index:1}
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
.dsh-forge-stepper{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid rgba(127,127,127,.22);border-radius:8px;background:rgba(127,127,127,.03)}
.dsh-forge-step{display:flex;align-items:flex-start;gap:8px;padding:2px 0;min-width:0}
.dsh-forge-step-dot{flex:none;width:9px;height:9px;margin-top:5px;border-radius:50%;border:1px solid rgba(127,127,127,.55);background:transparent}
.dsh-forge-step.is-done .dsh-forge-step-dot{background:#16a34a;border-color:#16a34a}
.dsh-forge-step.is-active .dsh-forge-step-dot{background:#3b82f6;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.18)}
.dsh-forge-step.is-failed .dsh-forge-step-dot{background:#dc2626;border-color:#dc2626}
.dsh-forge-step-body{display:flex;flex-direction:column;min-width:0;gap:0}
.dsh-forge-step-label{font-size:11.5px;font-weight:600;line-height:1.5}
.dsh-forge-step-detail{font-size:10.5px;line-height:1.45;opacity:.62;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.dsh-forge-step.is-failed .dsh-forge-step-detail{color:#dc2626;opacity:.95}
.dsh-forge-step-retry{align-self:flex-end;margin-top:4px}
`

/** The stylesheet text, exported so tests can pin the rules without a DOM. */
export const CLIENT_CSS = `
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
${STUDIO_CSS}
`

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
export function injectClientStyles(): boolean {
  if (typeof document === 'undefined') return false
  if (document.getElementById(CLIENT_STYLE_ID) !== null) return false
  const style = document.createElement('style')
  style.id = CLIENT_STYLE_ID
  style.textContent = CLIENT_CSS
  // `head` is present in every Host page this plugin can be seated in; fall back
  // to `documentElement` so a fragment document still gets the rules.
  const parent = document.head ?? document.documentElement
  parent.appendChild(style)
  return true
}
