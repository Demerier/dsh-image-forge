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

import { HANDLE_SCREEN_HIT, HANDLE_SCREEN_SIZE } from './canvas-connections.ts'
import { SETTINGS_CSS } from './settings-styles.ts'
import { XYFLOW_CSS } from './xyflow-styles.ts'

/** DOM id of the injected sheet; also the idempotence guard. */
export const CLIENT_STYLE_ID = 'dsh-image-forge-client-styles'

/**
 * A screen-pixel length as a board length inside the zoomed canvas layer.
 *
 * The layer transforms itself with `scale(zoom)` and publishes that zoom as
 * `--dsh-forge-zoom`, so dividing by the variable turns a length the user
 * measures on their monitor into a length that survives the transform. Written
 * as `calc()` rather than computed in JS because every node wears a handle: the
 * division belongs to the stylesheet, and the sizes belong to
 * `canvas-connections.ts` (one source, asserted by the tests).
 *
 * `var(…, 1)` is the fallback for a handle rendered outside the layer — the
 * first paint, or the fake renderer the panel tests mount — where the variable
 * does not exist yet; without it the whole `calc()` would be invalid and the dot
 * would inherit its default size.
 */
function screenPx(amount: number): string {
  return `calc(${String(amount)}px / var(--dsh-forge-zoom, 1))`
}

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
.dsh-image-forge-studio{display:flex;flex-direction:column;gap:14px;min-width:0;min-height:0}
/* On the canvas tab the studio is a full-height column: head, drawers, then the
   body that absorbs whatever is left. min-height:0 on the way down is what lets
   a flex child actually shrink instead of overflowing. */
.dsh-forge-studio-body{min-height:0}
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
.dsh-forge-canvas.is-pan{cursor:grab}
.dsh-forge-canvas.is-pan:active{cursor:grabbing}
.dsh-forge-canvas:focus{outline:none}
.dsh-forge-canvas:focus-visible{box-shadow:0 0 0 2px rgba(59,130,246,.28)}
/* U04 step 2: the canvas engine inside the canvas container.
   The container keeps the border and the screen-space overlays (menu, board
   picker, lightbox); the pane fills it exactly, so React Flow measures a real box
   — its height is what it projects the camera into — and the menu coordinates the
   pane reports share one origin with the overlays. The dot background moves to
   React Flow's own layer, so the container's copy is switched off here. */
.dsh-forge-canvas.is-flow{background-image:none;display:flex}
.dsh-forge-canvas.is-flow>.dsh-forge-flow{position:absolute;inset:0;min-height:0;border:0;border-radius:0}
.dsh-forge-canvas-layer{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.dsh-forge-canvas-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.dsh-forge-edge{fill:none;stroke:rgba(59,130,246,.5);stroke-width:2;stroke-dasharray:6 5;stroke-linecap:round;vector-effect:non-scaling-stroke}
/* G26: the wire during the drag. Solid and a notch brighter than a committed
   edge, because it is the one thing in flight — and dashed-free so "this is not
   saved yet" reads through the colour, not through a second dash pattern. */
.dsh-forge-edge.is-preview{stroke:rgba(59,130,246,.92);stroke-width:2.5;stroke-dasharray:4 4}
.dsh-forge-node{position:absolute;box-sizing:border-box;border-radius:10px;overflow:hidden;border:1px solid rgba(127,127,127,.34);background:rgba(127,127,127,.08);cursor:grab;box-shadow:0 1px 5px rgba(0,0,0,.09)}
.dsh-forge-node.is-selected{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.22),0 2px 10px rgba(0,0,0,.12);z-index:2}
/* G26: the output handle. Invisible until it is wanted — a dot on every node
   would compete with the picture, and the affordance belongs to hover and to the
   selection. Pointer events follow the opacity, so an invisible dot cannot be
   grabbed by accident.
   G27: and it must stay *reachable*. This whole layer is scale(zoom)'d, so a
   dot measured in board units was 1.1 px at the 10 % floor: present, painted,
   impossible to hit. Every length below is therefore a screen length divided by
   the layer's zoom (see the screenPx() helper above), which keeps the target
   ${HANDLE_SCREEN_HIT} px and the painted dot ${HANDLE_SCREEN_SIZE} px at every zoom. The element
   is the target — deliberately larger than the dot — and the dot itself is the
   ::after, anchored to the node's right edge so growing the target can never push
   the paint outside the frame's clip. During a drag the source node keeps its dot
   visible (.is-connect-source) so the wire still has a visible origin. */
.dsh-forge-handle{position:absolute;right:0;top:50%;width:${screenPx(HANDLE_SCREEN_HIT)};height:${screenPx(HANDLE_SCREEN_HIT)};margin-top:${screenPx(-HANDLE_SCREEN_HIT / 2)};cursor:crosshair;opacity:0;pointer-events:none;transition:opacity .12s ease;touch-action:none}
.dsh-forge-node:hover .dsh-forge-handle,.dsh-forge-node.is-selected .dsh-forge-handle,.dsh-forge-node.is-connect-source .dsh-forge-handle,.dsh-forge-handle:focus-visible{opacity:1;pointer-events:auto}
.dsh-forge-handle::after{content:"";position:absolute;right:0;top:50%;width:${screenPx(HANDLE_SCREEN_SIZE)};height:${screenPx(HANDLE_SCREEN_SIZE)};margin-top:${screenPx(-HANDLE_SCREEN_SIZE / 2)};box-sizing:border-box;border-radius:50%;border:${screenPx(1.5)} solid #fff;background:#3b82f6;box-shadow:0 ${screenPx(1)} ${screenPx(4)} rgba(0,0,0,.35);transform-origin:100% 50%}
.dsh-forge-handle:hover::after{transform:scale(1.18)}
/* G26: where the wire would land. Same green the run states use for "will do
   the right thing", not a warning colour. */
.dsh-forge-node.is-connect-target{border-color:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,.35)}
/* G26: the placeholder a wire creates. A dashed frame is the whole message: this
   is a promise of a node, not a node with a picture in it. */
.dsh-forge-node.is-draft{display:flex;flex-direction:column;gap:6px;padding:10px;border-style:dashed;border-color:rgba(59,130,246,.55);background:rgba(59,130,246,.05);cursor:grab}
.dsh-forge-draft-head{font-size:11.5px;font-weight:600;letter-spacing:.02em;color:#3b82f6}
.dsh-forge-draft-body{font-size:10.5px;opacity:.7;line-height:1.5;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;word-break:break-all}
.dsh-forge-draft-actions{display:flex;gap:4px;margin-top:auto;flex-wrap:wrap}
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
/* G01: the wheel hint sits at the right end of the same line, dimmer than the
   selection hint, because it is a legend and not status. */
.dsh-forge-canvas-foot-hint{float:right;opacity:.75;font-variant-numeric:tabular-nums}
.dsh-forge-marquee{position:absolute;z-index:3;pointer-events:none;border:1px solid rgba(59,130,246,.85);background:rgba(59,130,246,.12);border-radius:2px}
.dsh-forge-context,.dsh-forge-transfer{position:absolute;z-index:6;display:flex;flex-direction:column;gap:1px;min-width:172px;max-width:280px;padding:4px;border-radius:8px;border:1px solid rgba(127,127,127,.34);box-shadow:0 8px 24px rgba(0,0,0,.22);background:#fff;background:Canvas;color:#111;color:CanvasText}
.dsh-forge-context-item{appearance:none;font:inherit;font-size:12.5px;line-height:1.5;text-align:left;padding:6px 9px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-forge-context-item:hover:not([disabled]){background:rgba(127,127,127,.18)}
.dsh-forge-context-item[disabled]{opacity:.42;cursor:default}
.dsh-forge-context-item.is-danger{color:#dc2626}
.dsh-forge-context-item.is-danger:hover:not([disabled]){background:rgba(220,38,38,.12)}
/* G25: the board picker a copy/move entry opens. It is the context menu's own
   card with a header, so the two read as one gesture; the cancel row is dimmed
   because it is the escape hatch, not an action. */
.dsh-forge-context-head{padding:5px 9px 4px;font-size:10.5px;font-weight:600;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-forge-context-empty{padding:6px 9px;font-size:11px;opacity:.6;white-space:normal;line-height:1.5}
.dsh-forge-context-item.is-cancel{margin-top:2px;border-top:1px solid rgba(127,127,127,.22);border-radius:0 0 5px 5px;opacity:.72}
/* G28: the asset picker the wire menu grows, inside the same card. A filter bar,
   then the asset page's own card language (thumbnail, name, board) in a
   scrolling grid — a 200-item library must not push the card off-screen. */
.dsh-forge-picker{display:flex;flex-direction:column;gap:6px;padding:5px 2px 2px;border-top:1px solid rgba(127,127,127,.22)}
.dsh-forge-picker-bar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:0 4px}
.dsh-forge-picker-bar .dsh-forge-assets-search{flex:1 1 100%;font-size:11.5px;padding:4px 7px}
.dsh-forge-picker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px;max-height:186px;overflow:auto;padding:2px 4px}
.dsh-forge-picker-item{appearance:none;display:flex;flex-direction:column;gap:3px;padding:5px;border-radius:7px;border:1px solid rgba(127,127,127,.2);background:rgba(127,127,127,.03);color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}
.dsh-forge-picker-item:hover{border-color:rgba(59,130,246,.55);background:rgba(59,130,246,.1)}
.dsh-forge-picker-thumb{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:5px;background:rgba(127,127,127,.08)}
.dsh-forge-picker-name{font-size:11px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-forge-picker-meta{font-size:10px;line-height:1.35;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* G22: the in-canvas lightbox. Screen-space (outside the zoomed layer, like the
   menu), a dimmed backdrop, and a card whose picture is capped by the viewport
   height — a 2048-px result must fit on screen without scrolling. */
.dsh-forge-lightbox{position:absolute;inset:0;z-index:8;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(0,0,0,.62);cursor:default}
.dsh-forge-lightbox-card{display:flex;flex-direction:column;gap:8px;max-width:100%;max-height:100%;padding:10px;border-radius:12px;border:1px solid rgba(127,127,127,.4);background:#fff;background:Canvas;color:#111;color:CanvasText;box-shadow:0 18px 48px rgba(0,0,0,.4)}
.dsh-forge-lightbox-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0}
.dsh-forge-lightbox-title{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dsh-forge-lightbox-meta{flex:none;font-size:10.5px;opacity:.62;font-variant-numeric:tabular-nums}
.dsh-forge-lightbox-body{display:flex;align-items:center;gap:8px;min-height:0}
.dsh-forge-lightbox-img{display:block;max-width:min(72vw,760px);max-height:56vh;width:auto;height:auto;object-fit:contain;border-radius:6px;background:rgba(127,127,127,.12)}
.dsh-forge-lightbox-nav{appearance:none;flex:none;width:30px;height:54px;font-size:22px;line-height:1;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer}
.dsh-forge-lightbox-nav:hover{background:rgba(127,127,127,.14)}
.dsh-forge-lightbox-foot{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}
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
/* An idle progress line is out of the way but stays in the DOM: the role=status
   node must already exist when a run starts, or the first announcement is lost. */
.dsh-forge-progress[data-live="no"]{display:none}
.dsh-forge-progress[data-live="yes"]{display:flex;flex-direction:column;gap:4px}
/* U05: the node property drawer.
   The canvas tab is one column now (the is-canvas modifier), and inside it the canvas and the
   drawer are a flex row: two siblings, so the drawer shrinks the canvas instead of
   covering a node. Below 760 px there is no room for both, and the drawer becomes
   the overlay the brief allows — the same element, driven by one variable, so the
   two layouts cannot drift apart. */
.dsh-forge-studio-body.is-canvas{grid-template-columns:minmax(0,1fr)}
.dsh-forge-canvas-status{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-forge-canvas-shell{display:flex;gap:10px;align-items:stretch;min-width:0;position:relative}
.dsh-forge-canvas-shell>.dsh-forge-canvas{flex:1 1 auto;min-width:0;height:auto;min-height:0}
/* The canvas tab fills the tab: the body takes the leftover height, the shell
   takes the body, the canvas takes the shell. The clamp stays as a floor, so a
   short window still gets a usable canvas. */
.dsh-forge-studio-body.is-canvas{flex:1 1 auto;min-height:0;align-items:stretch;display:flex;flex-direction:column}
/* The body's only child on the canvas tab is the results column; it has to grow,
   or the canvas shells stop at their min and the body is taller than they are
   (which was the blank strip under the canvas). */
.dsh-forge-studio-body.is-canvas>.dsh-forge-studio-results{flex:1 1 auto;min-height:0}
.dsh-forge-canvas-shell{flex:1 1 auto;min-height:240px}
.dsh-forge-canvas-side>.dsh-forge-inspector{height:100%;min-height:0}
.dsh-forge-canvas-side{--dsh-forge-inspector-width:320px;flex:0 0 var(--dsh-forge-inspector-width);min-width:0;display:flex;flex-direction:column}
.dsh-forge-inspector{display:flex;flex-direction:column;gap:8px;min-width:0;height:clamp(300px,50vh,540px);box-sizing:border-box;padding:10px 11px;border:1px solid rgba(127,127,127,.26);border-radius:10px;background:rgba(127,127,127,.035);overflow:auto;scrollbar-width:thin}
.dsh-forge-inspector.is-empty{align-items:center;justify-content:center;text-align:center;font-size:11.5px;line-height:1.6;opacity:.55;border-style:dashed}
.dsh-forge-inspector-head{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-forge-inspector-title{font-size:12.5px;font-weight:600;letter-spacing:.02em}
.dsh-forge-inspector-badge{font-size:10px;line-height:1.5;padding:1px 6px;border-radius:4px;background:rgba(127,127,127,.16);opacity:.8;white-space:nowrap}
.dsh-forge-inspector-status{font-size:11px;line-height:1.5;opacity:.68;overflow-wrap:anywhere}
.dsh-forge-inspector-close{margin-left:auto;flex:none;width:20px;height:20px;line-height:1;padding:0;border-radius:50%;border:0;background:transparent;color:inherit;cursor:pointer;font-size:14px;opacity:.5;transition:opacity .15s,background .15s}
.dsh-forge-inspector-close:hover{opacity:1;background:rgba(127,127,127,.14)}
.dsh-forge-inspector-body{display:flex;flex-direction:column;gap:9px;min-width:0}
.dsh-forge-inspector-row{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-forge-inspector-value{font-size:11.5px;line-height:1.5;opacity:.82;overflow-wrap:anywhere;word-break:break-word;max-height:4.5em;overflow:hidden;-webkit-line-clamp:3;display:-webkit-box;-webkit-box-orient:vertical}
.dsh-forge-inspector-lineage{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0}
.dsh-forge-inspector-parent{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;line-height:1.6;padding:0 4px;border-radius:3px;background:rgba(127,127,127,.14);opacity:.8;max-width:9ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-forge-inspector-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:6px}
.dsh-forge-textarea.is-inspector{min-height:76px;font-size:12px;padding:7px 9px}
.dsh-forge-input.is-inspector{font-size:12px;padding:5px 8px}
.dsh-forge-ratio-row.is-inspector{gap:4px}
.dsh-forge-ratio-row.is-inspector .dsh-forge-ratio{padding:3px 7px}
.dsh-forge-ref-row.is-inspector{gap:6px}
.dsh-forge-inspector .dsh-forge-ref,.dsh-forge-inspector .dsh-forge-ref-add{width:46px;height:46px}
@media (max-width:760px){
  .dsh-forge-canvas-shell{display:block}
  .dsh-forge-canvas-side{--dsh-forge-inspector-width:280px;position:absolute;right:0;top:0;bottom:0;pointer-events:none;z-index:3}
  .dsh-forge-canvas-side>.dsh-forge-inspector{pointer-events:auto;height:100%;background:var(--dsh-forge-surface,rgba(24,24,27,.92));backdrop-filter:blur(2px);box-shadow:-6px 0 18px rgba(0,0,0,.22)}
}

/* ------------------------------------------------------------------------- */
/* Workspace mode: canvas first, chrome compressed into a top rail.           */
/* ------------------------------------------------------------------------- */
.dsh-image-forge-studio.is-workbench{height:100%;gap:7px;min-height:0;overflow:hidden}
.is-workbench .dsh-forge-studio-head{display:none}
.is-workbench .dsh-forge-studio-title{display:none}
.is-workbench .dsh-forge-studio-status{gap:7px;font-size:11.5px;opacity:.72}
.is-workbench .dsh-forge-stepper{position:relative;display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) auto;gap:4px;padding:5px;flex:none;border-radius:10px}
.is-workbench .dsh-forge-step{min-width:0;margin:0;padding:4px 7px;border-radius:7px;background:color-mix(in srgb,currentColor 3%,transparent)}
.is-workbench .dsh-forge-step-detail{display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.is-workbench .dsh-forge-step-retry{white-space:nowrap;align-self:stretch}
.is-workbench .dsh-forge-studio-alert{max-height:40px;overflow:auto;padding:5px 9px;font-size:11px;flex:none}
.is-workbench .dsh-forge-board-bar{display:none}
.is-workbench .dsh-forge-progress{padding:4px 7px;flex:none;border-radius:8px;background:color-mix(in srgb,currentColor 3%,transparent)}
.is-workbench .dsh-forge-studio-body.is-canvas{display:flex;flex:1 1 auto;min-height:0;gap:0}
.is-workbench .dsh-forge-studio-results{height:100%;min-height:0;gap:6px}
.is-workbench .dsh-forge-results-head{padding:3px 2px;flex:none;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}
.is-workbench .dsh-forge-canvas-shell{flex:1 1 auto;min-height:0;gap:8px}
.is-workbench .dsh-forge-canvas-side.is-empty{display:none}
.is-workbench .dsh-forge-canvas-side{--dsh-forge-inspector-width:304px;flex:0 0 min(304px,32vw)}
.is-workbench .dsh-forge-canvas{width:100%;height:auto;min-height:0;border-radius:12px;border-color:color-mix(in srgb,currentColor 16%,transparent);box-shadow:inset 0 1px 0 color-mix(in srgb,currentColor 5%,transparent)}
.is-workbench .dsh-forge-canvas.is-flow{background:color-mix(in srgb,currentColor 2%,transparent)}
.is-workbench .dsh-forge-canvas-foot{font-size:10px;opacity:.55}
.is-workbench .dsh-forge-flow-node{border-radius:12px;border-color:color-mix(in srgb,currentColor 22%,transparent);background:color-mix(in srgb,Canvas 8%,transparent);box-shadow:0 10px 30px rgba(0,0,0,.12),0 1px 3px rgba(0,0,0,.08)}
.is-workbench .dsh-forge-flow-node.is-selected{border-color:#6366f1;box-shadow:0 0 0 2px rgba(99,102,241,.25),0 12px 32px rgba(0,0,0,.14)}
.is-workbench .dsh-forge-flow-task{background:color-mix(in srgb,Canvas 7%,transparent)}
.is-workbench .dsh-forge-flow-bar{margin:4px 9px;height:5px}
.is-workbench .dsh-forge-flow-btn{font-size:10px;padding:4px 8px;border-radius:6px}
`

/**
 * The workbench shell: tab strip, projects toolbar, card grid, empty state.
 *
 * Same visual language as `.dsh-image-forge-tabs` (the settings page's strip):
 * a hairline under the row, unfilled tab bodies, and the active tab lifted by a
 * tint rather than by color. Kept in its own `dsh-forge-workbench-` namespace
 * because these rules are the shell's, not the studio's — U04 moves the canvas
 * out from under them and nothing here should have to move with it.
 */
export const WORKBENCH_CSS = `
.dsh-forge-workbench{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0;height:100%}
/* The panel holds exactly one child (the studio). On the canvas tab the studio is
   meant to *fill* it: without this chain the canvas kept its fixed
   clamp(300px,50vh,540px) and the rest of the tab stayed blank. */
.dsh-forge-workbench-panel>.dsh-image-forge-studio{height:100%;min-height:0}
.dsh-forge-workbench-strip{display:flex;align-items:flex-end;gap:6px;padding:0 2px;border-bottom:1px solid rgba(127,127,127,.26)}
.dsh-forge-workbench-tablist{display:flex;align-items:flex-end;gap:3px;flex:1 1 auto;min-width:0;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
.dsh-forge-workbench-log-open{appearance:none;flex:none;padding:5px 9px;border:1px solid rgba(127,127,127,.3);border-radius:6px;background:rgba(127,127,127,.05);color:inherit;font:inherit;font-size:11.5px;line-height:1.4;cursor:pointer;white-space:nowrap}
.dsh-forge-workbench-log-open:hover{background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.45)}
.dsh-forge-workbench-log-open.is-active{background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.6)}
.dsh-forge-workbench-tab{appearance:none;display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;background:transparent;color:inherit;font:inherit;font-size:12.5px;line-height:1.5;cursor:pointer;white-space:nowrap;max-width:26ch;opacity:.72;user-select:none}
.dsh-forge-workbench-tab:hover{opacity:1;background:color-mix(in srgb,currentColor 5%,transparent)}
.dsh-forge-workbench-tab-active{opacity:1;border-color:rgba(127,127,127,.26);background:color-mix(in srgb,currentColor 7%,transparent);position:relative;top:1px}
.dsh-forge-workbench-tab-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:20ch}
.dsh-forge-workbench-tab-close{appearance:none;flex:none;display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;opacity:.55;cursor:pointer}
.dsh-forge-workbench-tab-close:hover{opacity:1;background:rgba(220,38,38,.16)}
.dsh-forge-workbench-panel{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;min-width:0}
.dsh-forge-workbench-notice{padding:5px 9px;border-radius:6px;font-size:11.5px;line-height:1.5;border:1px solid rgba(59,130,246,.4);background:rgba(59,130,246,.1)}
.dsh-forge-workbench-error{padding:5px 9px;border-radius:6px;font-size:11.5px;line-height:1.5;border:1px solid rgba(220,38,38,.45);background:rgba(220,38,38,.1);color:#dc2626}
.dsh-forge-workbench-projects{display:flex;flex-direction:column;gap:9px;min-width:0;min-height:0}
.dsh-forge-workbench{--dsh-forge-wb-gap:10px}
.dsh-forge-workbench-toolbar{display:grid;grid-template-columns:minmax(14ch,20ch) auto minmax(12ch,1fr) auto auto;align-items:center;gap:7px;padding:7px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:12px;background:color-mix(in srgb,currentColor 2%,transparent)}
@media (max-width:760px){.dsh-forge-workbench-toolbar{display:flex;flex-wrap:wrap}.dsh-forge-workbench-toolbar .dsh-forge-workbench-search{flex:1 1 14ch}.dsh-forge-workbench-toolbar .dsh-forge-workbench-assets-entry{margin-left:0}}
.dsh-forge-workbench-input{font:inherit;font-size:12.5px;line-height:1.5;padding:5px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.32);background:rgba(127,127,127,.05);color:inherit;outline:none;min-width:0}
.dsh-forge-workbench-input:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.16)}
.dsh-forge-workbench-new-name{flex:0 1 15ch;width:15ch}
.dsh-forge-workbench-search{flex:1 1 12ch;min-width:10ch}
.dsh-forge-workbench-select{appearance:none;font:inherit;font-size:12.5px;line-height:1.5;padding:5px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;cursor:pointer;max-width:14ch}
.dsh-forge-workbench-primary{appearance:none;font:inherit;font-size:12.5px;font-weight:600;line-height:1.5;padding:6px 12px;border-radius:6px;border:1px solid rgba(59,130,246,.55);background:rgba(59,130,246,.14);color:inherit;cursor:pointer;white-space:nowrap}
.dsh-forge-workbench-primary:hover{background:rgba(59,130,246,.24)}
.dsh-forge-workbench-action{appearance:none;font:inherit;font-size:11px;line-height:1.4;padding:3px 7px;border-radius:5px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
.dsh-forge-workbench-action:hover{background:rgba(127,127,127,.13);border-color:rgba(127,127,127,.5)}
.dsh-forge-workbench-action.is-active{border-color:rgba(59,130,246,.55);background:rgba(59,130,246,.12)}
.dsh-forge-workbench-action.is-danger{color:#dc2626;border-color:rgba(220,38,38,.42)}
.dsh-forge-workbench-action.is-danger:hover{background:rgba(220,38,38,.12)}
.dsh-forge-workbench-assets-entry{margin-left:auto}
.dsh-forge-workbench-env{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 9px;border-radius:6px;font-size:11.5px;line-height:1.5;border:1px dashed rgba(127,127,127,.4);background:rgba(127,127,127,.04)}
.dsh-forge-workbench-env-text{flex:1 1 16ch;min-width:0;opacity:.82;overflow-wrap:anywhere}
.dsh-forge-env-start-group{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsh-forge-workbench-log{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;padding:2px}
.dsh-forge-workbench-log-head{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
.dsh-forge-workbench-log-title-wrap{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-forge-workbench-log-title{margin:0;font-size:15px;line-height:1.35;font-weight:650}
.dsh-forge-workbench-log-subtitle{font-size:11px;line-height:1.45;opacity:.65}
.dsh-forge-workbench-log-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsh-forge-workbench-log-status{display:flex;align-items:center;gap:7px;padding:6px 9px;border-radius:7px;border:1px solid rgba(127,127,127,.26);background:rgba(127,127,127,.04);font-size:11.5px;line-height:1.5;overflow-wrap:anywhere}
.dsh-forge-workbench-log-meta{display:flex;gap:4px 14px;flex-wrap:wrap;font-size:10.5px;line-height:1.5;opacity:.72}
.dsh-forge-workbench-log-error{padding:5px 9px;border-radius:6px;border:1px solid rgba(220,38,38,.45);background:rgba(220,38,38,.1);color:#dc2626;font-size:11px;line-height:1.5}
.dsh-forge-workbench-log-path{flex:1 1 22ch;min-width:0;font:10.5px/1.5 ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere;opacity:.9}
.dsh-forge-workbench-log-output{margin:0;padding:9px 11px;flex:1 1 auto;min-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;border:1px solid rgba(127,127,127,.26);background:rgba(0,0,0,.055);font:11px/1.55 ui-monospace,Menlo,Consolas,monospace;tab-size:2}
.dsh-forge-workbench-log-foot{font-size:10.5px;line-height:1.45;opacity:.58}
.dsh-forge-workbench-log-output{padding:0;white-space:normal;background:color-mix(in srgb,currentColor 3%,transparent);font:0/0 inherit}
.dsh-forge-log-line{display:grid;grid-template-columns:5ch 19ch minmax(0,1fr);gap:8px;align-items:start;padding:3px 9px;border-bottom:1px solid color-mix(in srgb,currentColor 7%,transparent);font:10.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsh-forge-log-line:last-child{border-bottom:0}
.dsh-forge-log-line.is-error{background:rgba(220,38,38,.055)}
.dsh-forge-log-line.is-warn{background:rgba(245,158,11,.055)}
.dsh-forge-log-line-no{text-align:right;opacity:.42;user-select:text;font-variant-numeric:tabular-nums}
.dsh-forge-log-line-time{opacity:.66;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.dsh-forge-log-line-text{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
.dsh-forge-log-line.is-error .dsh-forge-log-line-text{color:#dc2626}
.dsh-forge-workbench-log-empty{display:block;padding:14px;font-size:11.5px;line-height:1.6;white-space:pre-wrap;opacity:.64}
.dsh-forge-weights-drawer{border:1px solid rgba(127,127,127,.28);border-radius:8px;background:rgba(0,0,0,.04);margin:6px 0;overflow:hidden}
.dsh-forge-weights-head{display:flex;gap:8px;align-items:center;padding:5px 8px;font-size:11px;opacity:.9;border-bottom:1px solid rgba(127,127,127,.18)}
.dsh-forge-weights-head>span{flex:1 1 auto;overflow-wrap:anywhere}
.dsh-forge-weights-body{padding:6px 10px;display:flex;flex-direction:column;gap:3px;font-size:11px}
.dsh-forge-weights-note{opacity:.72;overflow-wrap:anywhere}
.dsh-forge-weight-row{display:flex;gap:8px;justify-content:space-between;gap:10px}
.dsh-forge-weight-name{font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere;min-width:0}
.dsh-forge-weight-state{opacity:.78;white-space:nowrap}
.dsh-forge-workbench-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,232px),1fr));gap:14px;min-width:0;align-items:start}
.dsh-forge-workbench-card{display:flex;flex-direction:column;gap:6px;padding:7px;border-radius:14px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);background:color-mix(in srgb,currentColor 3%,transparent);min-width:0;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:border-color .16s,background .16s,transform .16s}
.dsh-forge-workbench-card:hover{border-color:color-mix(in srgb,currentColor 34%,transparent);background:color-mix(in srgb,currentColor 6%,transparent);transform:translateY(-1px)}
.dsh-forge-workbench-card-open{appearance:none;display:flex;flex-direction:column;gap:7px;width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}
.dsh-forge-workbench-cover{position:relative;display:block;width:100%;aspect-ratio:16/10;border-radius:10px;overflow:hidden;background:color-mix(in srgb,currentColor 9%,transparent);min-width:0;flex:none}
.dsh-forge-workbench-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.dsh-forge-workbench-cover-empty{font-size:22px;opacity:.4}
.dsh-forge-workbench-card-title{font-size:12.5px;font-weight:600;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dsh-forge-workbench-card-meta{display:flex;align-items:baseline;gap:5px;font-size:10.5px;line-height:1.4;opacity:.6;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.dsh-forge-workbench-card-time{overflow:hidden;text-overflow:ellipsis}
.dsh-forge-workbench-card-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.dsh-forge-workbench-rename{display:flex;align-items:center;gap:4px}
.dsh-forge-workbench-rename .dsh-forge-workbench-input{flex:1 1 auto;width:auto}
.dsh-forge-workbench-confirm{display:flex;flex-direction:column;gap:5px;padding:6px;border-radius:6px;border:1px solid rgba(220,38,38,.4);background:rgba(220,38,38,.07)}
.dsh-forge-workbench-confirm-copy{margin:0;font-size:11px;line-height:1.5;overflow-wrap:anywhere}
.dsh-forge-workbench-confirm-warn{margin:0;font-size:10.5px;line-height:1.5;overflow-wrap:anywhere;color:#dc2626;font-weight:600}
.dsh-forge-workbench-card-size{font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-forge-workbench-confirm-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.dsh-forge-workbench-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 16px;border-radius:10px;border:1px dashed rgba(127,127,127,.32);text-align:center}
.dsh-forge-workbench-empty-title{margin:0;font-size:13.5px;font-weight:600;line-height:1.5}
.dsh-forge-workbench-empty-body{margin:0;font-size:12px;line-height:1.6;opacity:.66;max-width:44ch}
.dsh-forge-workbench-empty-note{margin:0;padding:18px 10px;text-align:center;font-size:12px;opacity:.5;border:1px dashed rgba(127,127,127,.3);border-radius:8px}
.dsh-forge-workbench-deleted{display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 12px}
.dsh-forge-workbench-assets{display:flex;flex-direction:column;gap:8px;padding:6px 2px}
/* U08: the global library. Same card grammar as the project grid (cover on top,
   one meta line, one action row) so the two views read as siblings, not as two
   products; the only new pieces are the thumbnail band and the two in-card
   panels (destination picker, delete confirmation). */
.dsh-forge-workbench-assets-count{font-size:10.5px;opacity:.6;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-forge-workbench-assets-back{margin-left:auto}
.dsh-forge-workbench-asset-hint{margin:0;font-size:11px;line-height:1.5;opacity:.62;overflow-wrap:anywhere}
.dsh-forge-workbench-asset-hint.is-blocked{color:#b45309}
.dsh-forge-workbench-assets-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;min-width:0}
.dsh-forge-workbench-asset{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:9px;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.03);min-width:0}
.dsh-forge-workbench-asset:hover{border-color:rgba(59,130,246,.45)}
.dsh-forge-workbench-asset-head{display:flex;flex-direction:column;gap:5px;min-width:0}
.dsh-forge-workbench-asset-cover{display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;border-radius:6px;overflow:hidden;background:rgba(127,127,127,.1);min-width:0}
.dsh-forge-workbench-asset-cover img{width:100%;height:100%;object-fit:cover;display:block}
.dsh-forge-workbench-asset-title{font-size:12px;font-weight:600;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-width:0;overflow-wrap:anywhere}
.dsh-forge-workbench-asset-meta{display:flex;align-items:baseline;gap:5px;font-size:10.5px;line-height:1.4;opacity:.62;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.dsh-forge-workbench-asset-board{overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:12ch}
.dsh-forge-workbench-asset-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.dsh-forge-workbench-action[disabled]{opacity:.45;cursor:not-allowed}
.dsh-forge-workbench-asset-transfer{display:flex;flex-direction:column;gap:5px;padding:6px;border-radius:6px;border:1px solid rgba(59,130,246,.4);background:rgba(59,130,246,.07)}
.dsh-forge-workbench-asset-transfer-copy{margin:0;font-size:10.5px;line-height:1.5;opacity:.75;overflow-wrap:anywhere}
.dsh-forge-workbench-asset-confirm{display:flex;flex-direction:column;gap:5px;padding:6px;border-radius:6px;border:1px solid rgba(220,38,38,.4);background:rgba(220,38,38,.07)}
`

/**
 * The React Flow canvas (U04 step 1b).
 *
 * React Flow ships its own sheet (`XYFLOW_CSS`, appended last-but-one by
 * `CLIENT_CSS`); everything here either gives a rule the library does not have
 * (the node painters) or overrides one it does (the handle's size). The order in
 * `CLIENT_CSS` matters: this block comes **after** `XYFLOW_CSS`, so the handle
 * rule below wins against `.react-flow__handle` without `!important`.
 *
 * Colours stay translucent-grey so both the light and the dark Host theme can
 * seat the canvas, and the accents are the ones the rest of the plugin already
 * uses (#3b82f6 selection, #dc2626 danger).
 */
export const CANVAS_FLOW_CSS = `
.dsh-forge-flow{position:relative;flex:1 1 auto;min-height:clamp(300px,50vh,540px);border:1px solid rgba(127,127,127,.28);border-radius:10px;overflow:hidden;background-color:rgba(127,127,127,.035)}
/* §6.3: the flow container owns the keyboard table, so it is focusable — and a
   focus ring around the whole canvas would read as a selected region. */
.dsh-forge-flow:focus{outline:none}
.dsh-forge-flow:focus-visible{box-shadow:0 0 0 2px rgba(59,130,246,.28)}
.dsh-forge-flow .react-flow{background:transparent}
.dsh-forge-flow-note{margin:0;padding:26px 12px;text-align:center;font-size:12px;opacity:.55}
.dsh-forge-flow-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;padding:0 28px;max-width:44ch;text-align:center;font-size:12.5px;line-height:1.7;opacity:.45;z-index:4;pointer-events:none}
.dsh-forge-flow-background{opacity:.55}
.dsh-forge-flow-node{box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;border-radius:10px;overflow:hidden;border:1px solid rgba(127,127,127,.34);background:rgba(127,127,127,.08);box-shadow:0 1px 5px rgba(0,0,0,.09);cursor:grab}
/* React Flow paints .selectable nodes with cursor:pointer; that changed the
   cursor in the one-pixel wrapper around our own frame. Give wrapper and frame
   one inherited cursor, then opt the actual controls back in. */
.dsh-forge-flow .react-flow__node,
.dsh-forge-flow .react-flow__node.selectable,
.dsh-forge-flow .react-flow__node.draggable{cursor:grab}
.dsh-forge-flow .react-flow__node.draggable.dragging{cursor:grabbing}
.dsh-forge-flow .react-flow__node .dsh-forge-flow-node{cursor:inherit}
.dsh-forge-flow .dsh-forge-flow-node button,
.dsh-forge-flow .dsh-forge-flow-node a,
.dsh-forge-flow .dsh-forge-flow-node select,
.dsh-forge-flow .dsh-forge-flow-node input,
.dsh-forge-flow .dsh-forge-flow-node textarea,
.dsh-forge-flow .dsh-forge-flow-node summary{cursor:pointer}
.dsh-forge-flow .dsh-forge-flow-node .dsh-forge-flow-handle.connectionindicator{cursor:crosshair}
.dsh-forge-flow-node.is-selected{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.22),0 2px 10px rgba(0,0,0,.12)}
.dsh-forge-flow-thumb{display:block;width:100%;flex:1 1 auto;min-height:0;object-fit:contain;background:rgba(127,127,127,.14);pointer-events:none}
.dsh-forge-flow-title{padding:4px 8px 0;font-size:11px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}
.dsh-forge-flow-meta{padding:1px 8px 5px;font-size:10px;opacity:.6;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* G27: a handle is drawn inside the zoomed viewport, so its size is a screen
   length divided by the zoom the node publishes. */
.dsh-forge-flow-handle{width:calc(10px / var(--dsh-forge-zoom,1));height:calc(10px / var(--dsh-forge-zoom,1));min-width:4px;min-height:4px;border-radius:50%;background:#3b82f6;border:1px solid rgba(255,255,255,.8);opacity:.5;transition:opacity .12s}
.dsh-forge-flow-node:hover .dsh-forge-flow-handle,.dsh-forge-flow-node.is-selected .dsh-forge-flow-handle{opacity:1}
.dsh-forge-flow-node.is-task{background:rgba(127,127,127,.06)}
.dsh-forge-flow-task-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 8px 3px}
.dsh-forge-flow-badge{font-size:10px;line-height:1.5;padding:1px 6px;border-radius:999px;background:rgba(127,127,127,.16)}
.dsh-forge-flow-badge[data-task-status="running"]{background:rgba(59,130,246,.18);color:#3b82f6}
.dsh-forge-flow-badge[data-task-status="queued"]{background:rgba(245,158,11,.2);color:#b45309}
.dsh-forge-flow-badge[data-task-status="failed"]{background:rgba(220,38,38,.16);color:#dc2626}
.dsh-forge-flow-ratio{font-size:10px;opacity:.6;font-variant-numeric:tabular-nums}
.dsh-forge-flow-task-prompt{padding:2px 8px;font-size:11px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsh-forge-flow-task-meta{padding:0 8px 4px;font-size:10px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-forge-flow-bar{position:relative;height:4px;margin:2px 8px;border-radius:999px;background:rgba(127,127,127,.22);overflow:hidden}
.dsh-forge-flow-bar-fill{display:block;height:100%;background:#3b82f6;transition:width .18s}
.dsh-forge-flow-task-status{padding:4px 8px;font-size:10.5px;line-height:1.45;opacity:.72;overflow-wrap:anywhere}
.dsh-forge-flow-task-status.is-failed,.dsh-forge-flow-task-status.is-interrupted{color:#dc2626;opacity:.9}
.dsh-forge-flow-actions{display:flex;gap:4px;padding:0 8px 6px;margin-top:auto;flex-wrap:wrap}
.dsh-forge-flow-btn{appearance:none;font:inherit;font-size:10.5px;padding:3px 7px;border-radius:5px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;line-height:1.5;white-space:nowrap;text-decoration:none}
.dsh-forge-flow-btn:hover{background:rgba(127,127,127,.13);border-color:rgba(127,127,127,.5)}
.dsh-forge-flow-btn.is-danger:hover{color:#dc2626;border-color:rgba(220,38,38,.5);background:rgba(220,38,38,.08)}
.dsh-forge-flow-node.is-layout{background:rgba(127,127,127,.06)}
.dsh-forge-flow-layout-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 8px;border-bottom:1px solid rgba(127,127,127,.2);cursor:grab}
.dsh-forge-flow-layout-title{font-size:11px;font-weight:600;opacity:.8}
.dsh-forge-flow-layout-caption{padding:3px 6px;border-bottom:1px solid rgba(127,127,127,.2);flex:0 0 auto;display:flex}
.dsh-forge-flow-layout-caption-input{width:100%;box-sizing:border-box;padding:2px 6px;border-radius:5px;border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.07);color:inherit;font:11px/1.4 system-ui,sans-serif;cursor:text}
.dsh-forge-flow-layout-caption-input:focus{outline:none;border-color:#3b82f6}
.dsh-forge-flow-layout-body{position:relative;flex:1 1 auto;min-height:0;overflow:hidden}
.dsh-forge-flow-layout-host{position:absolute;inset:0;overflow:auto;scrollbar-width:thin}
.dsh-forge-flow-layout-foot{display:flex;justify-content:space-between;gap:6px;padding:3px 8px;font-size:10px;opacity:.6;font-variant-numeric:tabular-nums;border-top:1px solid rgba(127,127,127,.2)}
.dsh-forge-flow-layout-error{padding:8px;font-size:10.5px;line-height:1.5;color:#dc2626}
.dsh-forge-flow-node.is-draft{gap:6px;padding:10px;border-style:dashed;border-color:rgba(59,130,246,.55);background:rgba(59,130,246,.05)}
.dsh-forge-flow-draft-title{font-size:11px;font-weight:600;opacity:.8}
.dsh-forge-flow-draft-body{font-size:10.5px;line-height:1.5;opacity:.6}
.dsh-forge-flow-edge{stroke:#3b82f6;stroke-width:2;fill:none;stroke-opacity:.7;vector-effect:non-scaling-stroke}
.react-flow__edge.selected .dsh-forge-flow-edge{stroke:#3b82f6;stroke-width:2}
.dsh-forge-flow-edge-label{position:absolute;padding:1px 5px;border-radius:4px;background:color-mix(in srgb,Canvas 88%,transparent);color:inherit;font-size:10px;line-height:1.4;opacity:.8;white-space:nowrap;pointer-events:none;box-shadow:0 0 0 1px rgba(127,127,127,.24)}
/* U04 step 3: the wire. Painted by the pane in container pixels (see paintWire
   in canvas-pane.ts), so the engine's own line is off: one wire, one coordinate
   space, and the preview's cubic is the committed edge's. */
.react-flow__connectionline{display:none}
.dsh-forge-flow-wire{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:5}
.dsh-forge-flow-wire-path{fill:none;stroke:rgba(59,130,246,.92);stroke-width:2.5;stroke-dasharray:4 4;stroke-linecap:round}
.dsh-forge-flow-wire[data-connect-preview="valid"] .dsh-forge-flow-wire-path{stroke:#3b82f6;stroke-width:2.8}
.dsh-forge-flow-wire[data-connect-preview="refused"] .dsh-forge-flow-wire-path{stroke:rgba(220,38,38,.85);stroke-dasharray:2 4}
.dsh-forge-flow-handle.is-out{cursor:crosshair}
.dsh-forge-flow-handle:hover{opacity:1}
.react-flow__handle.valid{background:#16a34a;opacity:1}
`

/**
 * U06: the node detail tab (§8.2) and the canvas node's read-only thumbnail
 * (§8.4).
 *
 * Two surfaces, one rule set, because they are the same decision seen from both
 * sides: the tab is the only place a layout draft is edited, and the node's
 * thumbnail is what the canvas shows instead of a second editor. So the detail
 * pane gets the full width a tab has (no 320 px drawer), and the thumbnail is
 * strictly non-interactive apart from the one button that goes back to the tab.
 */
export const NODE_DETAIL_CSS = `
.dsh-forge-detail{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-width:0;min-height:0;height:100%}
.dsh-forge-detail-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:2px 2px 6px;border-bottom:1px solid rgba(127,127,127,.24)}
.dsh-forge-detail-crumb{display:flex;align-items:center;gap:5px;min-width:0;font-size:12px;line-height:1.5;opacity:.86}
.dsh-forge-detail-crumb-link{appearance:none;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1.5;text-decoration:underline;text-underline-offset:2px;cursor:pointer;opacity:.8;max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-forge-detail-crumb-link:hover{opacity:1}
.dsh-forge-detail-crumb-text{opacity:.7;max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-forge-detail-sep{opacity:.4}
.dsh-forge-detail-kind{font-weight:600}
.dsh-forge-detail-close{appearance:none;margin-left:auto;flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:1;opacity:.55;cursor:pointer}
.dsh-forge-detail-close:hover{opacity:1;background:rgba(220,38,38,.16)}
.dsh-forge-detail-hint{flex:0 0 100%;font-size:11.5px;line-height:1.5;opacity:.7}
.dsh-forge-detail-body{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;min-width:0;overflow:auto;scrollbar-width:thin}
.dsh-forge-detail-copy{margin:0;font-size:12.5px;line-height:1.6;opacity:.78;overflow-wrap:anywhere}
.dsh-forge-detail-notice{display:flex;flex-direction:column;gap:10px;align-items:flex-start;padding:14px 15px;border:1px dashed rgba(127,127,127,.34);border-radius:10px;background:rgba(127,127,127,.035)}
.dsh-forge-detail-actions{display:flex;gap:6px;flex-wrap:wrap}
.dsh-forge-detail-facts{display:grid;grid-template-columns:minmax(84px,auto) minmax(0,1fr);gap:4px 12px;font-size:12.5px;line-height:1.55}
.dsh-forge-detail-row{display:contents}
.dsh-forge-detail-row>.dsh-forge-label{opacity:.7;white-space:nowrap;padding-top:1px}
.dsh-forge-detail-value{min-width:0;overflow-wrap:anywhere}
.dsh-forge-detail-layout{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0}
.dsh-forge-detail-editor{position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-height:clamp(320px,52vh,760px);border:1px solid rgba(127,127,127,.28);border-radius:10px;background:rgba(127,127,127,.045);overflow:hidden}
.dsh-forge-detail-editor-host{position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:auto;scrollbar-width:thin}
.dsh-forge-detail-error{padding:8px 10px;border-radius:6px;font-size:12px;line-height:1.5;border:1px solid rgba(220,38,38,.45);background:rgba(220,38,38,.1);color:#dc2626}
.dsh-forge-detail-image{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(200px,1fr);gap:12px;align-items:start}
.dsh-forge-detail-picture{display:block;width:100%;height:auto;max-height:min(72vh,900px);object-fit:contain;border-radius:10px;border:1px solid rgba(127,127,127,.24);background:rgba(127,127,127,.06)}
.dsh-forge-detail-task{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-forge-detail-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:6px;border-top:1px solid rgba(127,127,127,.24)}
/* §8.4: the canvas node while its detail tab owns the draft. The boxes are
   percentages of the draft, so the preview is right at any node size. */
.dsh-forge-flow-layout-thumb{position:relative;flex:1 1 auto;min-height:0;margin:4px;border-radius:6px;background:rgba(127,127,127,.09);border:1px dashed rgba(127,127,127,.32);overflow:hidden}
.dsh-forge-flow-layout-box{position:absolute;border:1px solid rgba(59,130,246,.85);border-radius:2px;background:rgba(59,130,246,.16);pointer-events:none}
.dsh-forge-flow-btn.is-locked{position:absolute;left:50%;bottom:4px;transform:translateX(-50%);white-space:nowrap;z-index:2}
@media (max-width: 760px){
  .dsh-forge-detail-image{grid-template-columns:minmax(0,1fr)}
  .dsh-forge-detail-facts{grid-template-columns:minmax(72px,auto) minmax(0,1fr)}
}
`

/** The stylesheet text, exported so tests can pin the rules without a DOM. */
/** Final visual layer: warm-paper surfaces, node-local editing and Better Sidebar. */
export const DESIGN_CSS = `
.dsh-image-forge-studio,
.dsh-forge-workbench,
.dsh-forge-detail,
.dsh-image-forge-result-card,
.dsh-image-forge-sidebar-editor {
  color-scheme: light dark;
  --forge-paper: #f6f2e9;
  --forge-panel: #fffdf8;
  --forge-ink: #22211d;
  --forge-muted: #6f6a60;
  --forge-line: #ded8cb;
  --forge-accent: #e66a3a;
  --forge-accent-soft: #fbe5dc;
  --forge-success: #2f8a62;
  --forge-warning: #b9772a;
  --forge-danger: #c34743;
  --forge-radius-sm: 8px;
  --forge-radius-md: 14px;
  --forge-radius-lg: 20px;
  --forge-shadow-sm: 0 1px 2px rgba(34,33,29,.06), 0 8px 20px rgba(34,33,29,.06);
  --forge-shadow-md: 0 12px 35px rgba(34,33,29,.14);
  --forge-paper: light-dark(#f6f2e9, #181716);
  --forge-panel: light-dark(#fffdf8, #24221e);
  --forge-ink: light-dark(#22211d, #f2ece1);
  --forge-muted: light-dark(#6f6a60, #aaa397);
  --forge-line: light-dark(#ded8cb, #454139);
  --forge-accent: light-dark(#e66a3a, #f18458);
  --forge-accent-soft: light-dark(#fbe5dc, #45271e);
}
.dsh-image-forge-studio,
.dsh-forge-workbench,
.dsh-forge-detail,
.dsh-image-forge-result-card,
.dsh-image-forge-sidebar-editor { color: var(--forge-ink); font-size: 13px; }
.dsh-forge-workbench { background: var(--forge-paper); border-radius: var(--forge-radius-lg); padding: 12px; box-sizing: border-box; }
.dsh-forge-workbench-strip { border-bottom: 1px solid var(--forge-line); padding: 0 4px 10px; gap: 8px; }
.dsh-forge-workbench-tab { min-height: 34px; border-radius: 999px; padding: 7px 13px; font-size: 13px; }
.dsh-forge-workbench-tab-active { background: var(--forge-panel); color: var(--forge-ink); box-shadow: var(--forge-shadow-sm); border-color: var(--forge-line); }
.dsh-forge-workbench-log-open,
.dsh-forge-workbench-action,
.dsh-forge-workbench-menu-toggle,
.dsh-forge-workbench-primary { min-height: 34px; border-radius: 10px; font-size: 13px; }
.dsh-forge-workbench-primary { background: var(--forge-accent); border-color: var(--forge-accent); color: #fff; padding: 8px 16px; font-weight: 650; }
.dsh-forge-workbench-primary:hover { filter: brightness(.96); }
.dsh-forge-workbench-action:focus-visible,
.dsh-forge-workbench-primary:focus-visible,
.dsh-forge-workbench-menu-toggle:focus-visible,
.dsh-forge-workbench-tab:focus-visible,
.dsh-forge-workbench-log-open:focus-visible,
.dsh-forge-workbench-card-open:focus-visible { outline: 2px solid color-mix(in srgb, var(--forge-accent) 70%, transparent); outline-offset: 2px; }
.dsh-forge-workbench-panel { padding: 0; background: transparent; }
.dsh-forge-workbench-projects { max-width: 1480px; margin: 0 auto; padding: 26px 28px 40px; gap: 18px; }
.dsh-forge-workbench-hero { display: flex; justify-content: space-between; gap: 24px; align-items: flex-end; padding: 12px 2px 6px; }
.dsh-forge-workbench-hero-copy { display: flex; flex-direction: column; gap: 7px; max-width: 720px; }
.dsh-forge-workbench-hero-eyebrow { color: var(--forge-accent); font-size: 12px; font-weight: 700; letter-spacing: .12em; }
.dsh-forge-workbench-hero-title { margin: 0; font-size: clamp(24px, 3vw, 34px); line-height: 1.12; letter-spacing: -.025em; font-weight: 680; }
.dsh-forge-workbench-hero-body { margin: 0; color: var(--forge-muted); font-size: 14px; line-height: 1.55; }
.dsh-forge-workbench-hero-badge { flex: 0 0 auto; border: 1px solid var(--forge-line); background: var(--forge-panel); border-radius: 999px; padding: 7px 11px; color: var(--forge-muted); font-size: 12px; }
.dsh-forge-workbench-toolbar { background: var(--forge-panel); border: 1px solid var(--forge-line); border-radius: var(--forge-radius-md); box-shadow: var(--forge-shadow-sm); padding: 10px; gap: 8px; }
.dsh-forge-workbench-input,
.dsh-forge-workbench-select { min-height: 36px; border-radius: 10px; border-color: var(--forge-line); background: color-mix(in srgb, var(--forge-panel) 92%, var(--forge-paper)); color: var(--forge-ink); font-size: 13px; }
.dsh-forge-workbench-new-name { flex: 1 1 280px; }
.dsh-forge-workbench-search { flex: 0 1 220px; }
.dsh-forge-workbench-grid { grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 22px; margin-top: 12px; }
.dsh-forge-workbench-card { position: relative; background: var(--forge-panel); border: 1px solid var(--forge-line); border-radius: var(--forge-radius-lg); box-shadow: var(--forge-shadow-sm); overflow: visible; transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
.dsh-forge-workbench-card:hover { transform: translateY(-3px); box-shadow: var(--forge-shadow-md); border-color: color-mix(in srgb, var(--forge-accent) 32%, var(--forge-line)); }
.dsh-forge-workbench-card-open { display: flex; flex-direction: column; width: 100%; border: 0; border-radius: var(--forge-radius-lg); overflow: hidden; background: transparent; color: inherit; text-align: left; padding: 0; cursor: pointer; }
.dsh-forge-workbench-cover { display: block; width: 100%; aspect-ratio: 16 / 10; overflow: hidden; background: linear-gradient(145deg, color-mix(in srgb, var(--forge-accent) 9%, var(--forge-panel)), var(--forge-panel)); }
.dsh-forge-workbench-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dsh-forge-workbench-cover-empty { display: grid; place-items: center; color: var(--forge-muted); font-size: 24px; }
.dsh-forge-workbench-card-title { padding: 13px 15px 0; font-size: 16px; line-height: 1.35; font-weight: 650; }
.dsh-forge-workbench-card-meta { padding: 5px 15px 14px; color: var(--forge-muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dsh-forge-workbench-card-actions { position: absolute; top: 10px; right: 10px; z-index: 2; }
.dsh-forge-workbench-menu-toggle { width: 34px; min-width: 34px; padding: 0; display: grid; place-items: center; border: 1px solid var(--forge-line); background: color-mix(in srgb, var(--forge-panel) 85%, transparent); backdrop-filter: blur(10px); color: var(--forge-ink); cursor: pointer; }
.dsh-forge-workbench-card-menu { position: absolute; right: 0; top: 40px; min-width: 128px; display: flex; flex-direction: column; gap: 4px; padding: 7px; background: var(--forge-panel); border: 1px solid var(--forge-line); border-radius: 12px; box-shadow: var(--forge-shadow-md); }
.dsh-forge-workbench-card-menu .dsh-forge-workbench-action { width: 100%; justify-content: flex-start; min-height: 32px; padding: 6px 9px; }
.dsh-forge-workbench-confirm { position: absolute; inset: auto 10px 10px; background: var(--forge-panel); border: 1px solid var(--forge-line); border-radius: 12px; box-shadow: var(--forge-shadow-md); padding: 12px; z-index: 4; }
.dsh-forge-workbench-confirm-copy,
.dsh-forge-workbench-confirm-warn { margin: 0 0 7px; font-size: 12px; line-height: 1.45; }
.dsh-forge-workbench-confirm-warn { color: var(--forge-danger); }
.dsh-forge-workbench-confirm-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dsh-forge-workbench-log-output.is-empty { flex: 0 0 auto; min-height: 0; padding: 0; border: 0; background: transparent; font: inherit; }
.dsh-forge-workbench-log-empty { border: 1px dashed var(--forge-line); border-radius: var(--forge-radius-md); background: color-mix(in srgb, var(--forge-panel) 90%, transparent); padding: 28px; text-align: center; color: var(--forge-muted); font-size: 13px; display: flex; flex-direction: column; align-items: center; gap: 12px; min-height: 0; }
.dsh-forge-workbench-log-empty-mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 13px; border: 1px solid color-mix(in srgb, var(--forge-accent) 30%, var(--forge-line)); background: var(--forge-accent-soft); color: var(--forge-accent); font-size: 11px; font-weight: 800; letter-spacing: .08em; }
.dsh-forge-workbench-log-empty-copy { max-width: 54ch; line-height: 1.65; }
.dsh-forge-workbench-log-empty-actions { display: flex; align-items: center; justify-content: center; gap: 7px; flex-wrap: wrap; }
.dsh-image-forge-studio { gap: 10px; }
.is-workbench .dsh-forge-studio-head { min-height: 42px; padding: 0 8px; }
.is-workbench .dsh-forge-studio-title { display: none; }
.is-workbench .dsh-forge-studio-status { min-height: 36px; gap: 7px; padding: 5px 10px; border: 1px solid var(--forge-line); border-radius: 999px; background: color-mix(in srgb, var(--forge-panel) 86%, transparent); backdrop-filter: blur(14px); }
.is-workbench .dsh-forge-studio-endpoint { max-width: 28ch; font-size: 12px; }
.is-workbench .dsh-forge-env-btn { min-height: 28px; padding: 3px 8px; }
.is-workbench .dsh-forge-board-bar { min-height: 34px; padding: 0 4px; }
.is-workbench .dsh-forge-board-label { font-size: 12px; opacity: .65; }
.is-workbench .dsh-forge-board-select { min-height: 34px; font-size: 13px; border-radius: 9px; }
.is-workbench .dsh-forge-progress:not([data-live="yes"]) { display: none; }
.dsh-forge-studio-body.is-canvas { display: block; height: 100%; min-height: 0; }
.dsh-forge-canvas-shell { position: relative; display: block; height: 100%; min-height: 560px; border-radius: var(--forge-radius-lg); overflow: hidden; background: var(--forge-paper); }
.dsh-forge-canvas-shell > .dsh-forge-canvas { width: 100%; height: 100%; min-height: 0; }\n.dsh-forge-canvas { position: relative; height: 100%; min-height: 0; border: 0; border-radius: var(--forge-radius-lg); background: var(--forge-paper); }
.dsh-forge-canvas-foot { position: absolute; left: 16px; bottom: 14px; right: 16px; z-index: 2; pointer-events: none; color: var(--forge-muted); font-size: 11.5px; background: transparent; border: 0; padding: 0; display: flex; justify-content: space-between; gap: 12px; }
.dsh-forge-studio-results { position: relative; }\n.dsh-forge-results-head { position: absolute; left: 14px; right: 14px; top: 14px; z-index: 4; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; background: color-mix(in srgb, var(--forge-panel) 88%, transparent); backdrop-filter: blur(14px); border: 1px solid color-mix(in srgb, var(--forge-line) 80%, transparent); border-radius: 999px; box-shadow: var(--forge-shadow-sm); padding: 7px; pointer-events: auto; }
.dsh-forge-results-head .dsh-forge-view-toggle { background: transparent; border: 0; padding: 0; }
.dsh-forge-view-item,
.dsh-forge-zoom .dsh-forge-btn,
.dsh-forge-align-btn { min-height: 32px; border-radius: 999px; font-size: 12px; }
.dsh-forge-view-item.is-active { background: var(--forge-accent-soft); color: var(--forge-accent); }
.dsh-forge-flow { min-height: 560px; border: 0; border-radius: 0; background: transparent; }
.dsh-forge-flow .react-flow__pane { cursor: grab; }
.dsh-forge-flow-background { opacity: .72; }
.dsh-forge-flow-node { border: 1px solid var(--forge-line); border-radius: var(--forge-radius-md); background: var(--forge-panel); box-shadow: var(--forge-shadow-sm); overflow: hidden; }
.dsh-forge-flow-node.is-selected { border-color: var(--forge-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--forge-accent) 22%, transparent), var(--forge-shadow-md); }
.dsh-forge-flow-node:hover { box-shadow: var(--forge-shadow-md); }
.dsh-forge-flow-thumb { background: color-mix(in srgb, var(--forge-ink) 6%, var(--forge-panel)); }
.dsh-forge-flow-title { padding: 7px 10px 0; font-size: 12px; font-weight: 600; opacity: 1; color: var(--forge-ink); }
.dsh-forge-flow-meta,
.dsh-forge-flow-task-meta,
.dsh-forge-flow-ratio { padding: 2px 10px 7px; font-size: 11px; color: var(--forge-muted); opacity: 1; }
.dsh-forge-flow-task-prompt { padding: 3px 10px; font-size: 12px; color: var(--forge-ink); }
.dsh-forge-flow-actions { padding: 0 8px 8px; gap: 5px; }
.dsh-forge-flow-btn { min-height: 28px; border-radius: 8px; border-color: var(--forge-line); font-size: 11px; padding: 4px 8px; }
.dsh-forge-flow-btn:hover { background: var(--forge-accent-soft); border-color: color-mix(in srgb, var(--forge-accent) 50%, var(--forge-line)); }
.dsh-forge-flow-handle { background: var(--forge-accent); border-color: rgba(255,255,255,.92); }
.dsh-forge-node-editor { position: absolute; z-index: 7; overflow: auto; background: var(--forge-panel); border: 1px solid var(--forge-line); border-radius: var(--forge-radius-md); box-shadow: var(--forge-shadow-md); animation: dsh-forge-pop .18s ease-out; }
.dsh-forge-node-editor .dsh-forge-inspector { height: auto; max-height: inherit; background: transparent; border: 0; box-shadow: none; }
.dsh-forge-node-editor .dsh-forge-inspector-head { position: sticky; top: 0; z-index: 2; background: var(--forge-panel); }
@keyframes dsh-forge-pop { from { opacity: 0; transform: translateY(5px) scale(.985); } to { opacity: 1; transform: none; } }
.dsh-forge-canvas-tool-dock { position: absolute; z-index: 6; left: 14px; top: 76px; display: flex; flex-direction: column; gap: 5px; padding: 5px; border: 1px solid color-mix(in srgb, var(--forge-line) 82%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--forge-panel) 90%, transparent); box-shadow: var(--forge-shadow-sm); backdrop-filter: blur(14px); }
.dsh-forge-canvas-tool { width: 38px; height: 38px; border: 0; border-radius: 10px; background: transparent; color: var(--forge-muted); font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
.dsh-forge-canvas-tool:hover { background: var(--forge-accent-soft); color: var(--forge-accent); }
.dsh-forge-canvas-tool.is-active { background: var(--forge-accent); color: #fff; }
.dsh-forge-canvas-tool:focus-visible { outline: 2px solid var(--forge-accent); outline-offset: 2px; }
.dsh-forge-canvas-composer { position: absolute; z-index: 6; left: 50%; bottom: 32px; transform: translateX(-50%); width: min(760px, calc(100% - 36px)); box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid color-mix(in srgb, var(--forge-line) 82%, transparent); border-radius: 18px; background: color-mix(in srgb, var(--forge-panel) 94%, transparent); box-shadow: var(--forge-shadow-md); backdrop-filter: blur(18px); }
.dsh-forge-canvas-composer textarea { width: 100%; min-height: 52px; max-height: 160px; resize: vertical; box-sizing: border-box; border: 0; outline: 0; background: transparent; color: var(--forge-ink); font: inherit; font-size: 14px; line-height: 1.5; padding: 4px 6px; }
.dsh-forge-canvas-composer-controls { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dsh-forge-canvas-composer-controls select,
.dsh-forge-canvas-composer-controls input { min-height: 32px; border: 1px solid var(--forge-line); border-radius: 9px; background: var(--forge-panel); color: var(--forge-ink); font: inherit; font-size: 12px; padding: 4px 8px; }
.dsh-forge-canvas-composer-controls input { width: 82px; }
.dsh-forge-canvas-composer-primary { margin-left: auto; min-height: 40px; min-width: 104px; border: 0; border-radius: 11px; background: var(--forge-accent); color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
.dsh-forge-canvas-composer-primary:disabled { opacity: .55; cursor: not-allowed; }
.dsh-forge-canvas-composer-primary:focus-visible { outline: 2px solid color-mix(in srgb, var(--forge-accent) 62%, transparent); outline-offset: 3px; }
.dsh-image-forge-result-card { display: flex; flex-direction: column; gap: 12px; padding: 13px; border: 1px solid var(--forge-line); border-radius: var(--forge-radius-md); background: var(--forge-panel); box-shadow: var(--forge-shadow-sm); }
.dsh-image-forge-result-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-image-forge-result-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dsh-image-forge-result-mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--forge-accent); color: #fff; font-weight: 800; font-size: 14px; flex: 0 0 auto; }
.dsh-image-forge-result-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dsh-image-forge-result-eyebrow { color: var(--forge-muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.dsh-image-forge-result-title { font-size: 14px; font-weight: 650; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.dsh-image-forge-result-status { flex: 0 0 auto; border-radius: 999px; padding: 4px 9px; color: var(--forge-success); background: color-mix(in srgb, var(--forge-success) 12%, transparent); font-size: 11.5px; font-weight: 600; }
.dsh-image-forge-result-status[data-running="true"] { color: var(--forge-warning); background: color-mix(in srgb, var(--forge-warning) 12%, transparent); }
.dsh-image-forge-result-hero { position: relative; overflow: hidden; border-radius: var(--forge-radius-md); background: color-mix(in srgb, var(--forge-ink) 9%, var(--forge-panel)); min-height: 220px; }
.dsh-image-forge-result-open { display: block; width: 100%; height: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
.dsh-image-forge-result-open img { display: block; width: 100%; height: 100%; object-fit: contain; }
.dsh-image-forge-result-open:focus-visible { outline: 2px solid var(--forge-accent); outline-offset: -3px; border-radius: var(--forge-radius-md); }
.dsh-image-forge-result-variant { position: absolute; right: 10px; bottom: 10px; background: rgba(24,23,22,.72); color: #fff; padding: 4px 8px; border-radius: 999px; font-size: 11px; backdrop-filter: blur(8px); }
.dsh-image-forge-result-annotate { position: absolute; right: 10px; top: 10px; border: 1px solid rgba(255,255,255,.5); background: rgba(24,23,22,.68); color: #fff; border-radius: 9px; min-height: 32px; padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer; backdrop-filter: blur(8px); }
.dsh-image-forge-result-annotate:hover { background: var(--forge-accent); }
.dsh-image-forge-result-shimmer { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(110deg, transparent 20%, rgba(255,255,255,.16) 42%, transparent 64%); animation: dsh-forge-shimmer 1.5s linear infinite; }
@keyframes dsh-forge-shimmer { from { transform: translateX(-80%); } to { transform: translateX(80%); } }
.dsh-image-forge-result-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-image-forge-result-chip { border: 1px solid var(--forge-line); border-radius: 999px; padding: 3px 8px; color: var(--forge-muted); font-size: 11.5px; background: color-mix(in srgb, var(--forge-paper) 48%, transparent); }
.dsh-image-forge-result-thumbs { display: flex; gap: 8px; overflow-x: auto; padding: 1px; }
.dsh-image-forge-result-thumb { flex: 0 0 76px; width: 76px; height: 58px; padding: 0; overflow: hidden; border: 1px solid var(--forge-line); border-radius: 9px; background: var(--forge-paper); cursor: pointer; }
.dsh-image-forge-result-thumb.is-active { border-color: var(--forge-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--forge-accent) 20%, transparent); }
.dsh-image-forge-result-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dsh-image-forge-result-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-image-forge-result-primary { min-height: 36px; border: 0; border-radius: 9px; background: var(--forge-accent); color: #fff; padding: 7px 12px; font: inherit; font-size: 12.5px; font-weight: 650; cursor: pointer; }
.dsh-image-forge-result-secondary { display: flex; gap: 5px; flex-wrap: wrap; }
.dsh-image-forge-result-link { min-height: 32px; border: 1px solid var(--forge-line); border-radius: 8px; background: transparent; color: var(--forge-ink); padding: 5px 9px; font: inherit; font-size: 12px; cursor: pointer; }
.dsh-image-forge-result-note { color: var(--forge-muted); font-size: 12px; }
.dsh-image-forge-sidebar-editor { display: flex; flex-direction: column; gap: 12px; padding: 13px; height: 100%; min-height: 0; box-sizing: border-box; background: var(--forge-panel); overflow: hidden; }
.dsh-image-forge-sidebar-icon { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 7px; background: var(--forge-accent); color: #fff; font-size: 12px; font-weight: 800; }
.dsh-image-forge-sidebar-tabs { display: flex; gap: 4px; padding: 3px; border: 1px solid var(--forge-line); border-radius: 999px; background: var(--forge-paper); }
.dsh-image-forge-sidebar-tab { flex: 1 1 0; min-height: 34px; border: 0; border-radius: 999px; background: transparent; color: var(--forge-muted); font: inherit; font-size: 12.5px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
.dsh-image-forge-sidebar-tab.is-active { background: var(--forge-panel); color: var(--forge-ink); box-shadow: var(--forge-shadow-sm); font-weight: 650; }
.dsh-image-forge-sidebar-count { min-width: 20px; height: 20px; border-radius: 999px; display: grid; place-items: center; background: var(--forge-accent); color: #fff; font-size: 11px; }
.dsh-image-forge-sidebar-panel { display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1 1 auto; overflow: auto; padding-right: 2px; }
.dsh-image-forge-sidebar-image-shell { position: relative; border-radius: var(--forge-radius-md); overflow: hidden; border: 1px solid var(--forge-line); background: color-mix(in srgb, var(--forge-ink) 8%, var(--forge-panel)); }
.dsh-image-forge-sidebar-image { position: relative; width: 100%; max-height: 58vh; overflow: hidden; cursor: crosshair; }
.dsh-image-forge-sidebar-image img { display: block; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
.dsh-image-forge-sidebar-pin { position: absolute; transform: translate(-50%, -50%); width: 30px; height: 30px; border: 2px solid rgba(255,255,255,.9); border-radius: 50%; background: var(--forge-accent); color: #fff; display: grid; place-items: center; padding: 0; cursor: pointer; box-shadow: 0 4px 12px rgba(34,33,29,.28); }
.dsh-image-forge-sidebar-pin.is-selected { outline: 3px solid color-mix(in srgb, var(--forge-accent) 28%, transparent); transform: translate(-50%, -50%) scale(1.08); }
.dsh-image-forge-sidebar-pin-number { font-size: 12px; font-weight: 800; }
.dsh-image-forge-sidebar-image-tools { position: absolute; left: 8px; right: 8px; bottom: 8px; display: flex; justify-content: space-between; gap: 6px; pointer-events: none; }
.dsh-image-forge-sidebar-hint,
.dsh-image-forge-sidebar-gate { margin: 0; color: var(--forge-muted); font-size: 12px; line-height: 1.5; }
.dsh-image-forge-sidebar-empty-bubbles,
.dsh-image-forge-sidebar-empty { border: 1px dashed var(--forge-line); border-radius: 12px; padding: 20px 14px; text-align: center; color: var(--forge-muted); font-size: 12.5px; }
.dsh-image-forge-sidebar-annotation-list { display: flex; flex-direction: column; gap: 7px; max-height: 30vh; overflow: auto; }
.dsh-image-forge-sidebar-annotation { display: grid; grid-template-columns: 28px minmax(0,1fr) 28px; gap: 7px; align-items: start; padding: 8px; border: 1px solid var(--forge-line); border-radius: 11px; background: color-mix(in srgb, var(--forge-paper) 55%, var(--forge-panel)); cursor: pointer; }
.dsh-image-forge-sidebar-annotation.is-selected { border-color: var(--forge-accent); background: var(--forge-accent-soft); }
.dsh-image-forge-sidebar-annotation-number { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: var(--forge-accent); color: #fff; font-size: 11px; font-weight: 800; margin-top: 2px; }
.dsh-image-forge-sidebar-annotation textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 42px; border: 1px solid var(--forge-line); border-radius: 8px; background: var(--forge-panel); color: var(--forge-ink); font: inherit; font-size: 12.5px; padding: 6px 8px; }
.dsh-image-forge-sidebar-remove { width: 28px; height: 28px; border: 1px solid var(--forge-line); border-radius: 8px; background: transparent; color: var(--forge-muted); cursor: pointer; }
.dsh-image-forge-sidebar-error { margin: 0; color: var(--forge-danger); font-size: 12px; line-height: 1.45; }
.dsh-image-forge-sidebar-status { margin: 0; color: var(--forge-success); font-size: 12px; }
.dsh-image-forge-sidebar-commit { position: sticky; bottom: 0; z-index: 4; margin-top: auto; display: flex; gap: 7px; flex-wrap: wrap; padding: 10px 0 0; border-top: 1px solid var(--forge-line); background: var(--forge-panel); }
.dsh-image-forge-sidebar-primary { flex: 1 1 180px; min-height: 40px; border: 0; border-radius: 10px; background: var(--forge-accent); color: #fff; padding: 8px 12px; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
.dsh-image-forge-sidebar-copy { min-height: 40px; border: 1px solid var(--forge-line); border-radius: 10px; background: transparent; color: var(--forge-ink); padding: 8px 11px; font: inherit; font-size: 12.5px; cursor: pointer; }
.dsh-image-forge-sidebar-primary:disabled,
.dsh-image-forge-sidebar-copy:disabled { opacity: .5; cursor: not-allowed; }
.dsh-image-forge-sidebar-layout-host { min-height: 540px; border-radius: var(--forge-radius-md); overflow: auto; }
.dsh-image-forge-sidebar-layout-host .dsh-image-forge-layout-editor { color: var(--forge-ink); font-size: 12px; }
.dsh-image-forge-layout-editor button,
.dsh-image-forge-layout-editor input,
.dsh-image-forge-layout-editor select,
.dsh-image-forge-layout-editor textarea { border: 1px solid var(--forge-line) !important; border-radius: 8px !important; background: color-mix(in srgb, var(--forge-panel) 78%, transparent) !important; color: var(--forge-ink) !important; min-height: 30px; padding: 4px 8px !important; font: inherit !important; }
.dsh-image-forge-layout-editor button { cursor: pointer; }
.dsh-image-forge-layout-editor button:hover { border-color: color-mix(in srgb, var(--forge-accent) 55%, var(--forge-line)) !important; }
.dsh-image-forge-layout-editor textarea { min-height: 42px; resize: vertical; }
.dsh-image-forge-layout-editor :is(button, input, select, textarea):focus-visible { outline: 2px solid color-mix(in srgb, var(--forge-accent) 70%, transparent) !important; outline-offset: 1px; }
.dsh-image-forge-layout-editor[data-theme="dark"] { color-scheme: dark; }
.dsh-image-forge-layout-canvas { border-color: var(--forge-line) !important; border-radius: 12px; }
.dsh-image-forge-layout-background { opacity: .36 !important; }
.dsh-forge-btn { min-height: 34px; border-radius: 9px; font-size: 13px; }
.dsh-forge-btn.is-primary { background: var(--forge-accent); border-color: var(--forge-accent); }
.dsh-forge-label { font-size: 12.5px; color: var(--forge-ink); opacity: .82; }
.dsh-forge-node-editor .dsh-forge-inspector { gap: 12px; padding: 14px; }
.dsh-forge-node-editor .dsh-forge-inspector-title { font-size: 15px; }
.dsh-forge-node-editor .dsh-forge-inspector-badge { font-size: 11.5px; padding: 3px 7px; }
.dsh-forge-node-editor .dsh-forge-inspector-status,
.dsh-forge-node-editor .dsh-forge-inspector-value { font-size: 13px; line-height: 1.5; opacity: .86; }
.dsh-forge-node-editor .dsh-forge-inspector-close { width: 32px; height: 32px; font-size: 16px; opacity: .7; }
.dsh-forge-node-editor .dsh-forge-inspector-parent { font-size: 11px; }
.dsh-forge-node-editor .dsh-forge-inspector-preview { flex: 0 0 auto; display: block; margin: 2px 0 4px; border-radius: 11px; overflow: hidden; border: 1px solid var(--forge-line); background: color-mix(in srgb, var(--forge-ink) 5%, var(--forge-panel)); cursor: zoom-in; }
.dsh-forge-node-editor .dsh-forge-inspector-preview img { display: block; width: 100%; max-height: 220px; object-fit: contain; }
.dsh-forge-node-editor .dsh-forge-inspector-details { border-top: 1px solid var(--forge-line); padding-top: 9px; }
.dsh-forge-node-editor .dsh-forge-inspector-details summary { color: var(--forge-muted); font-size: 12px; font-weight: 560; cursor: pointer; list-style: none; }
.dsh-forge-node-editor .dsh-forge-inspector-details summary::after { content: '⌄'; float: right; }
.dsh-forge-node-editor .dsh-forge-inspector-details[open] summary::after { content: '⌃'; }
.dsh-forge-node-editor .dsh-forge-inspector-details > .dsh-forge-inspector-row { margin-top: 9px; }
.dsh-forge-node-editor .dsh-forge-inspector-actions { gap: 7px; padding-top: 10px; border-top: 1px solid var(--forge-line); }
.dsh-forge-node-editor .dsh-forge-inspector-actions .dsh-forge-btn { min-height: 36px; }
/* Canvas-first chrome: no persistent health stepper on the artboard. The
   compact pill answers "can I generate?"; diagnostics belong to the log tab. */
.is-workbench.is-canvas-view .dsh-forge-studio-head,
.is-workbench.is-canvas-view .dsh-forge-progress,
.is-workbench.is-canvas-view .dsh-forge-env-error,
.is-workbench.is-canvas-view .dsh-forge-env-note { display: none !important; }
.dsh-forge-results-head.is-canvas { left: auto; right: 12px; top: 12px; width: auto; max-width: calc(100% - 24px); padding: 6px 7px; gap: 8px; border-radius: 14px; }
.dsh-forge-canvas-top-actions { display: flex; align-items: center; gap: 5px; margin-left: auto; min-width: 0; }
.dsh-forge-canvas-env-pill { appearance: none; display: inline-flex; align-items: center; gap: 6px; min-height: 30px; border: 1px solid color-mix(in srgb, var(--forge-line) 78%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--forge-panel) 76%, transparent); color: var(--forge-muted); padding: 4px 9px; font: inherit; font-size: 11.5px; font-weight: 560; white-space: nowrap; cursor: pointer; }
.dsh-forge-canvas-env-pill.is-offline { border-color: color-mix(in srgb, var(--forge-danger) 38%, var(--forge-line)); color: var(--forge-danger); background: color-mix(in srgb, var(--forge-danger) 8%, var(--forge-panel)); }
.dsh-forge-canvas-env-pill:disabled { opacity: .58; cursor: progress; }
.dsh-forge-canvas-env-pill:focus-visible { outline: 2px solid color-mix(in srgb, var(--forge-accent) 70%, transparent); outline-offset: 2px; }
.dsh-forge-canvas-top-btn { appearance: none; width: 30px; min-height: 30px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--forge-ink); font: inherit; font-size: 15px; line-height: 1; cursor: pointer; }
.dsh-forge-canvas-top-btn.is-label { width: auto; padding: 0 9px; font-size: 12px; font-weight: 600; }
.dsh-forge-canvas-top-btn:hover { background: var(--forge-accent-soft); color: var(--forge-accent); border-color: color-mix(in srgb, var(--forge-accent) 24%, transparent); }
.dsh-forge-canvas-top-btn:focus-visible { outline: 2px solid var(--forge-accent); outline-offset: 1px; }
.dsh-forge-canvas-zoom-dock { position: absolute; z-index: 6; left: 14px; bottom: 46px; display: flex; align-items: center; gap: 2px; padding: 4px; border: 1px solid color-mix(in srgb, var(--forge-line) 82%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--forge-panel) 92%, transparent); box-shadow: var(--forge-shadow-sm); backdrop-filter: blur(14px); }
.dsh-forge-canvas-zoom-dock button { appearance: none; min-width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: var(--forge-ink); font: inherit; font-size: 12px; cursor: pointer; }
.dsh-forge-canvas-zoom-dock button:hover { background: var(--forge-accent-soft); color: var(--forge-accent); }
.dsh-forge-canvas-zoom-dock button:focus-visible { outline: 2px solid var(--forge-accent); outline-offset: 1px; }
.dsh-forge-canvas-zoom-dock .dsh-forge-zoom-label { min-width: 38px; color: var(--forge-muted); font-size: 11px; }
.dsh-forge-node-editor input,
.dsh-forge-node-editor textarea,
.dsh-forge-node-editor select { min-height: 34px; border-color: var(--forge-line); border-radius: 8px; background: var(--forge-panel); color: var(--forge-ink); font: inherit; font-size: 13px; }
.dsh-forge-detail,
.dsh-forge-studio { background: transparent; }

/* Canvas 2.1: stable two-mode workspace, contextual inspector and bottom chrome. */

.dsh-forge-workspace-mode-bar { flex: none; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 3px 2px; border-bottom: 1px solid var(--forge-line); }
.dsh-forge-workspace-mode-bar .dsh-forge-view-toggle { padding: 3px; border: 1px solid var(--forge-line); border-radius: 999px; background: var(--forge-panel); box-shadow: var(--forge-shadow-sm); }
.dsh-forge-workspace-mode-env { margin-left: auto; min-width: 0; }
.dsh-forge-workspace-mode-env .dsh-forge-canvas-env-pill { position: static; min-height: 32px; }
.dsh-forge-workspace-mode-bar .dsh-forge-view-item { min-height: 32px; padding: 5px 13px; border-radius: 999px; font-size: 12.5px; }
.dsh-forge-studio-body.is-gallery { display: grid; grid-template-columns: minmax(320px, 420px) minmax(0, 1fr); gap: 18px; align-items: stretch; min-height: 0; }
.dsh-forge-studio-body.is-gallery .dsh-forge-studio-form { overflow: auto; min-height: 0; padding-right: 3px; scrollbar-width: thin; }
.dsh-forge-studio-body.is-gallery .dsh-forge-studio-results { min-height: 0; overflow: auto; padding-right: 3px; scrollbar-width: thin; }
.dsh-forge-results-head.is-gallery { position: static; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 7px; border: 1px solid var(--forge-line); border-radius: 14px; background: var(--forge-panel); box-shadow: var(--forge-shadow-sm); }
.dsh-forge-gallery-scope { display: inline-flex; align-items: center; gap: 3px; padding: 3px; border: 1px solid var(--forge-line); border-radius: 999px; background: var(--forge-paper); }
.dsh-forge-gallery-scope-item { min-height: 30px; border: 0; border-radius: 999px; background: transparent; color: var(--forge-muted); padding: 4px 9px; font: inherit; font-size: 12px; cursor: pointer; }
.dsh-forge-gallery-scope-item.is-active { background: var(--forge-panel); color: var(--forge-ink); box-shadow: var(--forge-shadow-sm); font-weight: 650; }
.dsh-forge-gallery-scope-item:focus-visible { outline: 2px solid var(--forge-accent); outline-offset: 1px; }
.dsh-forge-gallery-search { min-width: 160px; flex: 1 1 180px; min-height: 32px; border: 1px solid var(--forge-line); border-radius: 9px; background: var(--forge-panel); color: var(--forge-ink); padding: 4px 9px; font: inherit; font-size: 12px; }
.dsh-forge-gallery-search:focus-visible { outline: 2px solid var(--forge-accent); outline-offset: 1px; }
.dsh-forge-gallery-search::placeholder { color: var(--forge-muted); }
.dsh-forge-assets .dsh-forge-assets-bar { display: none; }

.dsh-forge-canvas-shell.has-context-panel { --forge-context-width: 372px; display: flex; align-items: stretch; gap: 10px; }
.dsh-forge-context-panel { flex: 0 0 360px; width: 360px; max-width: 360px; min-width: 0; min-height: 0; height: 100%; display: flex; overflow: hidden; border: 1px solid var(--forge-line); border-radius: var(--forge-radius-md); background: var(--forge-panel); box-shadow: var(--forge-shadow-sm); }
.dsh-forge-context-panel > .dsh-forge-inspector { flex: 1 1 auto; height: 100%; max-height: none; min-height: 0; padding: 14px; overflow: hidden; border: 0; border-radius: 0; background: transparent; }
.dsh-forge-context-panel .dsh-forge-inspector-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding-right: 3px; scrollbar-width: thin; }
.dsh-forge-context-panel .dsh-forge-inspector-actions { flex: none; padding-top: 10px; border-top: 1px solid var(--forge-line); background: var(--forge-panel); }
.dsh-forge-context-panel .dsh-forge-inspector-preview img { max-height: 190px; }

.dsh-forge-canvas-tool-dock { left: 14px; top: 72px; width: 144px; flex-direction: column; align-items: stretch; gap: 3px; padding: 8px; border-radius: 16px; }
.dsh-forge-canvas-tool-group-label { padding: 1px 7px 3px; color: var(--forge-muted); font-size: 10px; font-weight: 650; letter-spacing: .12em; }
.dsh-forge-canvas-tool-group-label.is-create { margin-top: 5px; padding-top: 7px; border-top: 1px solid var(--forge-line); }
.dsh-forge-canvas-tool { width: 100%; height: 34px; min-height: 34px; display: flex; align-items: center; justify-content: flex-start; gap: 8px; padding: 4px 8px; border-radius: 9px; font-size: 12px; text-align: left; }
.dsh-forge-canvas-tool.is-create-action { color: var(--forge-ink); }
.dsh-forge-canvas-tool.is-create-action:hover { background: var(--forge-accent-soft); }
.dsh-forge-canvas-tool-icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.dsh-forge-canvas-tool-label { min-width: 0; white-space: nowrap; }
.dsh-forge-canvas-tool.is-active .dsh-forge-canvas-tool-icon { stroke-width: 2; }

.dsh-forge-canvas-bottom-chrome { position: absolute; z-index: 7; left: 14px; right: calc(14px + var(--forge-context-width, 0px)); bottom: 12px; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: end; gap: 12px; pointer-events: none; }
.dsh-forge-canvas-bottom-chrome .dsh-forge-canvas-zoom-dock { position: static; justify-self: start; pointer-events: auto; }
.dsh-forge-canvas-bottom-chrome .dsh-forge-canvas-composer { position: static; transform: none; width: 100%; max-width: 760px; justify-self: center; pointer-events: auto; }
.dsh-forge-canvas-bottom-chrome .dsh-forge-canvas-composer { bottom: auto; left: auto; }
.dsh-forge-canvas-shell.has-context-panel .dsh-forge-canvas { min-width: 0; }

.dsh-forge-flow-node.is-created-focus { animation: dsh-forge-created-focus 700ms ease-out; }
@keyframes dsh-forge-created-focus {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--forge-accent) 55%, transparent), var(--forge-shadow-md); }
  45% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--forge-accent) 20%, transparent), var(--forge-shadow-md); }
  100% { box-shadow: 0 0 0 0 transparent, var(--forge-shadow-sm); }
}

@media (max-width: 1100px) {
  .dsh-forge-studio-body.is-gallery { grid-template-columns: minmax(0, 1fr); }
  .dsh-forge-context-panel { position: absolute; z-index: 12; top: 0; right: 0; bottom: 0; width: min(360px, calc(100% - 18px)); max-width: none; height: auto; box-shadow: -14px 0 36px rgba(34,33,29,.18); }
  .dsh-forge-canvas-shell.has-context-panel { --forge-context-width: 0px; }
  .dsh-forge-canvas-bottom-chrome { right: 14px; grid-template-columns: minmax(0, 1fr); }
  .dsh-forge-canvas-bottom-chrome .dsh-forge-canvas-zoom-dock { justify-self: start; grid-row: 2; }
}

/* Layout detail: canvas + in-page rail, with one box-only floating editor. */
.dsh-forge-detail-body.is-layout { overflow: hidden; flex: 1 1 auto; min-height: 0; }
.dsh-forge-layout-workspace { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 12px; height: 100%; min-height: 0; }
.dsh-forge-layout-canvas-pane { position: relative; min-width: 0; min-height: 0; height: 100%; }
.dsh-forge-layout-canvas-pane .dsh-forge-detail-editor { height: 100%; min-height: 0; }
.dsh-forge-layout-canvas-pane .dsh-forge-detail-editor-host { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.dsh-forge-layout-canvas-pane .dsh-forge-layout-editor { height: 100%; }
.dsh-forge-layout-rail { min-width: 0; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 2px 4px 4px 0; scrollbar-width: thin; }
.dsh-forge-layout-rail-section { display: flex; flex-direction: column; gap: 8px; padding: 11px; border: 1px solid var(--forge-line); border-radius: 12px; background: var(--forge-panel); }
.dsh-forge-layout-rail-title { margin: 0; font-size: 12px; font-weight: 650; color: var(--forge-ink); }
.dsh-forge-layout-rail-section > summary { list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; }
.dsh-forge-layout-rail-section > summary::-webkit-details-marker { display: none; }
.dsh-forge-layout-rail-section > summary::after { content: '⌄'; color: var(--forge-muted); font-size: 13px; }
.dsh-forge-layout-rail-section[open] > summary::after { content: '⌃'; }
.dsh-forge-layout-rail-section > summary:focus-visible { outline: 2px solid var(--forge-accent); outline-offset: 3px; border-radius: 4px; }
.dsh-forge-layout-rail-section .dsh-forge-field { min-width: 0; }
.dsh-forge-layout-rail-section input,
.dsh-forge-layout-rail-section select,
.dsh-forge-layout-rail-section textarea { width: 100%; min-height: 32px; border: 1px solid var(--forge-line); border-radius: 8px; background: var(--forge-panel); color: var(--forge-ink); padding: 5px 8px; font: inherit; font-size: 12px; }
.dsh-forge-layout-rail-section textarea { resize: vertical; }
.dsh-forge-layout-size-row { display: grid; grid-template-columns: minmax(0,1fr) auto minmax(0,1fr); gap: 7px; align-items: center; }
.dsh-forge-layout-box-list { display: flex; flex-direction: column; gap: 5px; }
.dsh-forge-layout-box-row { display: grid; grid-template-columns: minmax(0,1fr) auto auto; align-items: center; gap: 7px; padding: 7px; border: 1px solid var(--forge-line); border-radius: 9px; background: color-mix(in srgb, var(--forge-paper) 55%, var(--forge-panel)); cursor: pointer; }
.dsh-forge-layout-box-row.is-active { border-color: var(--forge-accent); background: var(--forge-accent-soft); }
.dsh-forge-layout-box-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dsh-forge-layout-box-kind { color: var(--forge-muted); font-size: 10px; }
.dsh-forge-layout-box-edit { min-height: 28px; border: 1px solid var(--forge-line); border-radius: 7px; background: var(--forge-panel); color: var(--forge-ink); padding: 3px 7px; font: inherit; font-size: 11px; cursor: pointer; }
.dsh-forge-layout-reference { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-forge-layout-reference img { width: 54px; height: 54px; object-fit: cover; border-radius: 8px; border: 1px solid var(--forge-line); }
.dsh-forge-layout-reference span { min-width: 0; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; font-size: 11px; color: var(--forge-muted); }
.dsh-forge-box-float { position: absolute; z-index: 14; width: 340px; min-width: 300px; max-width: min(480px, calc(100% - 16px)); max-height: 70%; display: flex; flex-direction: column; overflow: hidden; resize: both; border: 1px solid var(--forge-line); border-radius: 14px; background: var(--forge-panel); box-shadow: var(--forge-shadow-md); }
.dsh-forge-box-float-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-bottom: 1px solid var(--forge-line); cursor: move; user-select: none; }
.dsh-forge-box-float-head strong { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dsh-forge-box-float-close { width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: var(--forge-muted); font-size: 18px; cursor: pointer; }
.dsh-forge-box-float-close:hover { background: var(--forge-accent-soft); color: var(--forge-accent); }
.dsh-forge-box-float-body { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px; scrollbar-width: thin; }
.dsh-forge-box-float-body input,
.dsh-forge-box-float-body select,
.dsh-forge-box-float-body textarea { width: 100%; min-height: 32px; border: 1px solid var(--forge-line); border-radius: 8px; background: var(--forge-panel); color: var(--forge-ink); padding: 5px 8px; font: inherit; font-size: 12px; }
.dsh-forge-box-coordinates { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 6px; }
.dsh-forge-box-coordinates .dsh-forge-field { gap: 3px; }
.dsh-forge-box-float-actions { flex: none; padding: 9px 10px; border-top: 1px solid var(--forge-line); }
.dsh-forge-box-float-actions .dsh-forge-btn { width: 100%; }
.dsh-forge-flow-layout-head-actions { display: flex; align-items: center; gap: 4px; }
.dsh-forge-flow-layout-caption { padding: 2px 10px 5px; color: var(--forge-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 900px) {
  .dsh-forge-layout-workspace { grid-template-columns: minmax(0,1fr); grid-template-rows: minmax(320px, 1fr) minmax(180px, 42vh); }
  .dsh-forge-layout-rail { border-top: 1px solid var(--forge-line); padding-top: 8px; }
}

/* Annotation direct manipulation: no mode toggle; delete lives on the bubble. */
.dsh-image-forge-sidebar-image-tools { justify-content: flex-end; align-items: center; gap: 8px; }
.dsh-image-forge-sidebar-image-tip { pointer-events: none; border-radius: 999px; background: rgba(24,23,22,.62); color: #fff; padding: 5px 8px; font-size: 11px; backdrop-filter: blur(8px); }
.dsh-image-forge-sidebar-pin-wrap { position: absolute; transform: translate(-50%, -50%); width: 30px; height: 30px; }
.dsh-image-forge-sidebar-pin-wrap.is-selected { z-index: 3; }
.dsh-image-forge-sidebar-pin { position: relative; width: 30px; height: 30px; transform: none; border: 2px solid rgba(255,255,255,.9); border-radius: 50%; background: var(--forge-accent); color: #fff; display: grid; place-items: center; padding: 0; cursor: grab; box-shadow: 0 4px 12px rgba(34,33,29,.28); }
.dsh-image-forge-sidebar-pin:active { cursor: grabbing; }
.dsh-image-forge-sidebar-pin-wrap.is-selected .dsh-image-forge-sidebar-pin { transform: scale(1.08); outline: 3px solid color-mix(in srgb, var(--forge-accent) 28%, transparent); }
.dsh-image-forge-sidebar-pin-delete { position: absolute; right: -22px; top: -22px; width: 32px; height: 32px; display: grid; place-items: center; border: 2px solid var(--forge-panel); border-radius: 50%; background: var(--forge-danger); color: #fff; cursor: pointer; box-shadow: var(--forge-shadow-sm); }
.dsh-image-forge-sidebar-pin-delete:hover { filter: brightness(.94); }
.dsh-image-forge-sidebar-trash { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.dsh-image-forge-sidebar-annotation { grid-template-columns: 28px minmax(0,1fr) auto; }
.dsh-image-forge-sidebar-remove { width: auto; min-width: 66px; min-height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 4px 8px; font: inherit; font-size: 11px; }
.dsh-image-forge-sidebar-remove:hover { border-color: color-mix(in srgb, var(--forge-danger) 45%, var(--forge-line)); color: var(--forge-danger); }
.dsh-image-forge-sidebar-pin-delete:focus-visible,
.dsh-image-forge-sidebar-remove:focus-visible,
.dsh-image-forge-sidebar-pin:focus-visible { outline: 2px solid var(--forge-accent); outline-offset: 2px; }
@media (max-width: 760px) {
  .dsh-forge-workbench { padding: 8px; border-radius: 14px; }
  .dsh-forge-workbench-projects { padding: 16px 10px 28px; }
  .dsh-forge-workbench-hero { display: block; }
  .dsh-forge-workbench-hero-badge { display: inline-flex; margin-top: 12px; }
  .dsh-forge-canvas-composer { bottom: 14px; width: calc(100% - 20px); }
  .dsh-forge-canvas-foot { display: none; }
  .dsh-forge-node-editor { left: 10px !important; right: 10px; top: 74px !important; width: auto !important; max-height: 52vh !important; }
}
/* 200% page zoom and short desktop panes: the same tools reflow horizontally
   above the composer instead of hiding one another. */
@media (max-height: 620px) {
  .dsh-forge-canvas-tool-dock { left: 12px; right: 12px; top: 62px; width: auto; flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: flex-start; padding: 4px; }
  .dsh-forge-canvas-tool-group-label { display: none; }
  .dsh-forge-canvas-tool { width: auto; height: 34px; min-height: 34px; flex: 0 0 auto; padding: 4px 8px; }
  .dsh-forge-canvas-bottom-chrome { right: 10px; left: 10px; grid-template-columns: minmax(0,1fr); gap: 6px; }
  .dsh-forge-canvas-bottom-chrome .dsh-forge-canvas-zoom-dock { grid-row: 2; justify-self: start; }
  .dsh-forge-canvas-bottom-chrome .dsh-forge-canvas-composer { max-width: none; padding: 10px; }
  .dsh-forge-canvas-composer textarea { min-height: 42px; }
  .dsh-forge-canvas-foot { display: none; }
}
/* Canvas 2.2: compact hover tool dock, session history and shared ComfyUI control. */
.dsh-forge-canvas-tool-dock {
  width: 52px;
  align-items: stretch;
  gap: 5px;
  overflow: hidden;
  transition: width 160ms cubic-bezier(.22,1,.36,1), box-shadow 160ms ease;
}
.dsh-forge-canvas-tool {
  width: 36px;
  height: 36px;
  min-height: 36px;
  align-self: center;
  justify-content: center;
  gap: 0;
  padding: 0;
}
.dsh-forge-canvas-tool-label {
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  transition: max-width 140ms ease, opacity 120ms ease;
}
.dsh-forge-canvas-tool-group-label {
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  opacity: 0;
  overflow: hidden;
  white-space: nowrap;
  pointer-events: none;
  transition: max-height 140ms ease, opacity 100ms ease, padding 140ms ease;
}
.dsh-forge-canvas-tool-group-label.is-create {
  margin-top: 0;
  border-top-color: transparent;
}
.dsh-forge-canvas-tool-dock.is-open {
  width: 158px;
  gap: 3px;
}
.dsh-forge-canvas-tool-dock.is-open .dsh-forge-canvas-tool {
  width: 100%;
  align-self: stretch;
  justify-content: flex-start;
  gap: 8px;
  padding: 4px 8px;
}
.dsh-forge-canvas-tool-dock.is-open .dsh-forge-canvas-tool-label {
  max-width: 100px;
  opacity: 1;
}
.dsh-forge-canvas-tool-dock.is-open .dsh-forge-canvas-tool-group-label {
  max-height: 24px;
  padding: 1px 7px 3px;
  opacity: 1;
}
.dsh-forge-canvas-tool-dock.is-open .dsh-forge-canvas-tool-group-label.is-create {
  margin-top: 5px;
  padding-top: 7px;
  border-top-color: var(--forge-line);
}
.dsh-forge-canvas-tool-dock.is-closing {
  width: 52px;
  pointer-events: none;
}
@media (hover: none) {
  .dsh-forge-canvas-tool-dock { width: 158px; gap: 3px; }
  .dsh-forge-canvas-tool { width: 100%; align-self: stretch; justify-content: flex-start; gap: 8px; padding: 4px 8px; }
  .dsh-forge-canvas-tool-label { max-width: 100px; opacity: 1; }
  .dsh-forge-canvas-tool-group-label { max-height: 24px; padding: 1px 7px 3px; opacity: 1; }
  .dsh-forge-canvas-tool-group-label.is-create { margin-top: 5px; padding-top: 7px; border-top-color: var(--forge-line); }
}

.dsh-forge-results-head.is-canvas { position: absolute; }
.dsh-forge-history-trigger { display: inline-flex; align-items: center; gap: 5px; }
.dsh-forge-history-count { min-width: 18px; height: 18px; display: inline-grid; place-items: center; border-radius: 999px; background: color-mix(in srgb, var(--forge-accent) 15%, transparent); color: var(--forge-accent); font-size: 10px; font-variant-numeric: tabular-nums; }
.dsh-forge-history-popover { position: absolute; z-index: 24; top: calc(100% + 8px); right: 0; width: min(320px, calc(100vw - 32px)); max-height: min(430px, 62vh); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--forge-line); border-radius: 14px; background: var(--forge-panel); box-shadow: var(--forge-shadow-md); }
.dsh-forge-history-head { flex: none; display: flex; flex-direction: column; gap: 1px; padding: 11px 12px 9px; border-bottom: 1px solid var(--forge-line); }
.dsh-forge-history-head strong { font-size: 12.5px; }
.dsh-forge-history-head span { color: var(--forge-muted); font-size: 10.5px; }
.dsh-forge-history-list { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; padding: 5px; scrollbar-width: thin; }
.dsh-forge-history-item { display: grid; grid-template-columns: 24px minmax(0,1fr) auto; align-items: center; gap: 7px; min-height: 34px; border: 0; border-radius: 9px; background: transparent; color: var(--forge-ink); padding: 5px 7px; font: inherit; text-align: left; cursor: pointer; }
.dsh-forge-history-item:hover { background: color-mix(in srgb, var(--forge-accent) 9%, transparent); }
.dsh-forge-history-item.is-current { background: var(--forge-accent-soft); cursor: default; }
.dsh-forge-history-item.is-future { color: var(--forge-muted); }
.dsh-forge-history-marker { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--forge-ink) 6%, transparent); color: var(--forge-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.dsh-forge-history-item.is-current .dsh-forge-history-marker { background: var(--forge-accent); color: #fff; }
.dsh-forge-history-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dsh-forge-history-state { color: var(--forge-muted); font-size: 10px; white-space: nowrap; }
.dsh-forge-history-empty { padding: 18px 12px; color: var(--forge-muted); font-size: 12px; text-align: center; }
.dsh-forge-history-latest { flex: none; min-height: 34px; margin: 0 5px 5px; border: 1px solid var(--forge-line); border-radius: 9px; background: var(--forge-paper); color: var(--forge-ink); font: inherit; font-size: 12px; cursor: pointer; }

.dsh-forge-environment-control { position: relative; display: flex; align-items: center; }
.dsh-forge-environment-trigger { position: static; }
.dsh-forge-environment-popover { position: absolute; z-index: 26; top: calc(100% + 8px); right: 0; width: min(380px, calc(100vw - 28px)); max-height: min(520px, 68vh); display: flex; flex-direction: column; gap: 10px; overflow: auto; padding: 13px; border: 1px solid var(--forge-line); border-radius: 14px; background: var(--forge-panel); box-shadow: var(--forge-shadow-md); scrollbar-width: thin; }
.dsh-forge-environment-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dsh-forge-environment-head strong { font-size: 13px; }
.dsh-forge-environment-state { border-radius: 999px; background: color-mix(in srgb, var(--forge-accent) 11%, transparent); color: var(--forge-accent); padding: 3px 8px; font-size: 10.5px; font-weight: 650; }
.dsh-forge-environment-facts { display: grid; grid-template-columns: auto minmax(0,1fr); gap: 6px 10px; margin: 0; font-size: 11.5px; }
.dsh-forge-environment-facts dt { color: var(--forge-muted); }
.dsh-forge-environment-facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.dsh-forge-environment-error { margin: 0; color: var(--forge-danger); font-size: 11.5px; line-height: 1.45; }
.dsh-forge-environment-note, .dsh-forge-environment-argv { margin: 0; color: var(--forge-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.dsh-forge-environment-log { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid var(--forge-line); border-radius: 8px; background: var(--forge-paper); padding: 5px 7px; font-size: 10.5px; }
.dsh-forge-environment-details { border-top: 1px solid var(--forge-line); padding-top: 8px; }
.dsh-forge-environment-details > summary { display: flex; align-items: center; justify-content: space-between; cursor: pointer; color: var(--forge-muted); font-size: 11px; list-style: none; }
.dsh-forge-environment-details > summary::-webkit-details-marker { display: none; }
.dsh-forge-environment-details > summary::after { content: '⌄'; }
.dsh-forge-environment-details[open] > summary::after { content: '⌃'; }
.dsh-forge-environment-actions { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }
.dsh-forge-environment-actions .dsh-forge-btn.is-danger { color: var(--forge-danger); border-color: color-mix(in srgb, var(--forge-danger) 35%, var(--forge-line)); }

.dsh-image-forge-layout-stage { container-type: size; }
.dsh-image-forge-layout-frame { overflow: visible; }
.dsh-image-forge-layout-frame-badge { color: var(--forge-muted); }

.dsh-image-forge-result-hero { aspect-ratio: 16 / 9; min-height: 0; }

.dsh-image-forge-sidebar-panel { overflow: hidden; }
.dsh-image-forge-sidebar-image { max-height: 38vh; }
.dsh-image-forge-sidebar-image-tools { justify-content: flex-end; }
.dsh-image-forge-sidebar-annotation-list { flex: 1 1 auto; min-height: 0; max-height: none; overflow: auto; scrollbar-width: thin; }
.dsh-image-forge-sidebar-pin-delete { right: -13px; top: -13px; width: 24px; height: 24px; border-width: 1px; font-size: 14px; font-weight: 800; line-height: 1; padding: 0; }
.dsh-image-forge-sidebar-pin-delete::before { content: ''; position: absolute; inset: -4px; border-radius: 50%; }
.dsh-image-forge-sidebar-panel.is-layout { gap: 8px; }
.dsh-image-forge-sidebar-layout-workbench { position: relative; display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; }
.dsh-image-forge-sidebar-layout-canvas { flex: 0 0 clamp(210px, 32vh, 310px); min-height: 210px; overflow: hidden; border: 1px solid var(--forge-line); border-radius: 12px; background: var(--forge-paper); }
.dsh-image-forge-sidebar-layout-canvas .dsh-image-forge-sidebar-layout-host { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.dsh-image-forge-sidebar-layout-canvas .dsh-image-forge-layout-editor { height: 100%; min-height: 0; }
.dsh-image-forge-sidebar-layout-rail { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 7px; padding-right: 2px; scrollbar-width: thin; }
.dsh-image-forge-sidebar-layout-section { display: flex; flex-direction: column; gap: 7px; border: 1px solid var(--forge-line); border-radius: 11px; background: var(--forge-panel); padding: 9px; }
.dsh-image-forge-sidebar-layout-section > summary { list-style: none; display: flex; align-items: center; justify-content: space-between; cursor: pointer; color: var(--forge-ink); font-size: 11.5px; font-weight: 650; }
.dsh-image-forge-sidebar-layout-section > summary::-webkit-details-marker { display: none; }
.dsh-image-forge-sidebar-layout-section > summary::after { content: '⌄'; color: var(--forge-muted); }
.dsh-image-forge-sidebar-layout-section[open] > summary::after { content: '⌃'; }
.dsh-image-forge-sidebar-layout-section input,
.dsh-image-forge-sidebar-layout-section select,
.dsh-image-forge-sidebar-layout-section textarea { width: 100%; min-height: 32px; border: 1px solid var(--forge-line); border-radius: 8px; background: var(--forge-panel); color: var(--forge-ink); padding: 5px 8px; font: inherit; font-size: 12px; }
.dsh-image-forge-sidebar-layout-section textarea { resize: vertical; }
.dsh-image-forge-sidebar-layout-facts { display: flex; flex-wrap: wrap; gap: 5px; }
.dsh-image-forge-sidebar-layout-facts span { border-radius: 999px; background: var(--forge-accent-soft); color: var(--forge-ink); padding: 3px 7px; font-size: 10.5px; }
.dsh-image-forge-sidebar-layout-status { flex: none; }
.dsh-image-forge-sidebar-box-float { position: absolute; z-index: 12; width: min(340px, calc(100% - 16px)); max-height: 70%; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--forge-line); border-radius: 14px; background: var(--forge-panel); box-shadow: var(--forge-shadow-md); }
.dsh-image-forge-sidebar-box-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-bottom: 1px solid var(--forge-line); cursor: move; user-select: none; }
.dsh-image-forge-sidebar-box-head strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dsh-image-forge-sidebar-box-close { width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--forge-muted); font-size: 18px; cursor: pointer; }
.dsh-image-forge-sidebar-box-body { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px; scrollbar-width: thin; }
.dsh-image-forge-sidebar-box-body input,
.dsh-image-forge-sidebar-box-body select,
.dsh-image-forge-sidebar-box-body textarea { width: 100%; min-height: 32px; border: 1px solid var(--forge-line); border-radius: 8px; background: var(--forge-panel); color: var(--forge-ink); padding: 5px 8px; font: inherit; font-size: 12px; }
.dsh-image-forge-sidebar-box-coordinates { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 5px; }
.dsh-image-forge-sidebar-box-actions { flex: none; padding: 9px 10px; border-top: 1px solid var(--forge-line); }
.dsh-image-forge-sidebar-box-actions .dsh-image-forge-sidebar-remove { width: 100%; }
.dsh-image-forge-sidebar-remove.is-danger { color: var(--forge-danger); border-color: color-mix(in srgb, var(--forge-danger) 35%, var(--forge-line)); }
.dsh-forge-workbench-action.is-danger { color: var(--forge-danger); border-color: color-mix(in srgb, var(--forge-danger) 35%, var(--forge-line)); }
.dsh-forge-workbench-log-note { padding: 7px 10px; border-radius: 8px; background: color-mix(in srgb, var(--forge-accent) 7%, transparent); color: var(--forge-muted); font-size: 11.5px; }

@media (max-width: 760px), (max-height: 620px) {
  .dsh-forge-canvas-tool-dock { width: auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 5px; }
  .dsh-forge-canvas-tool { width: auto; min-height: 34px; flex: 0 0 auto; justify-content: flex-start; gap: 6px; padding: 4px 8px; }
  .dsh-forge-canvas-tool-label { max-width: 100px; opacity: 1; }
  .dsh-forge-canvas-tool-group-label { display: none; }
  .dsh-image-forge-sidebar-layout-canvas { flex-basis: 210px; }
  .dsh-image-forge-sidebar-box-coordinates { grid-template-columns: repeat(2, minmax(0,1fr)); }
}
`;

export const CLIENT_CSS = `
${SETTINGS_CSS}
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
${WORKBENCH_CSS}
${NODE_DETAIL_CSS}
${XYFLOW_CSS}
${CANVAS_FLOW_CSS}
${DESIGN_CSS}
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
