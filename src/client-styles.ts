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
.dsh-forge-canvas-shell>.dsh-forge-canvas{flex:1 1 auto;min-width:0}
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
.dsh-forge-workbench-strip{display:flex;align-items:flex-end;gap:3px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;padding:0 2px;border-bottom:1px solid rgba(127,127,127,.26);scrollbar-width:thin}
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
.dsh-forge-workbench-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsh-forge-workbench-input{font:inherit;font-size:12.5px;line-height:1.5;padding:5px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.32);background:rgba(127,127,127,.05);color:inherit;outline:none;min-width:0}
.dsh-forge-workbench-input:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.16)}
.dsh-forge-workbench-new-name{flex:0 1 15ch;width:15ch}
.dsh-forge-workbench-search{flex:1 1 12ch;min-width:10ch}
.dsh-forge-workbench-select{appearance:none;font:inherit;font-size:12.5px;line-height:1.5;padding:5px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;cursor:pointer;max-width:14ch}
.dsh-forge-workbench-primary{appearance:none;font:inherit;font-size:12.5px;font-weight:600;line-height:1.5;padding:6px 12px;border-radius:6px;border:1px solid rgba(59,130,246,.55);background:rgba(59,130,246,.14);color:inherit;cursor:pointer;white-space:nowrap}
.dsh-forge-workbench-primary:hover{background:rgba(59,130,246,.24)}
.dsh-forge-workbench-action{appearance:none;font:inherit;font-size:11px;line-height:1.4;padding:3px 7px;border-radius:5px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
.dsh-forge-workbench-action:hover{background:rgba(127,127,127,.13);border-color:rgba(127,127,127,.5)}
.dsh-forge-workbench-action.is-danger{color:#dc2626;border-color:rgba(220,38,38,.42)}
.dsh-forge-workbench-action.is-danger:hover{background:rgba(220,38,38,.12)}
.dsh-forge-workbench-assets-entry{margin-left:auto}
.dsh-forge-workbench-env{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 9px;border-radius:6px;font-size:11.5px;line-height:1.5;border:1px dashed rgba(127,127,127,.4);background:rgba(127,127,127,.04)}
.dsh-forge-workbench-env-text{flex:1 1 16ch;min-width:0;opacity:.82;overflow-wrap:anywhere}
.dsh-forge-env-start-group{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsh-forge-log-drawer{border:1px solid rgba(127,127,127,.28);border-radius:8px;background:rgba(0,0,0,.04);margin:6px 0;overflow:hidden}
.dsh-forge-log-head{display:flex;gap:8px;align-items:center;padding:5px 8px;border-bottom:1px solid rgba(127,127,127,.18);font-size:11px;opacity:.85}
.dsh-forge-log-head>span{flex:1 1 auto}
.dsh-forge-log-body{margin:0;padding:8px 10px;max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;tab-size:2}
.dsh-forge-weights-drawer{border:1px solid rgba(127,127,127,.28);border-radius:8px;background:rgba(0,0,0,.04);margin:6px 0;overflow:hidden}
.dsh-forge-weights-head{display:flex;gap:8px;align-items:center;padding:5px 8px;font-size:11px;opacity:.9;border-bottom:1px solid rgba(127,127,127,.18)}
.dsh-forge-weights-head>span{flex:1 1 auto;overflow-wrap:anywhere}
.dsh-forge-weights-body{padding:6px 10px;display:flex;flex-direction:column;gap:3px;font-size:11px}
.dsh-forge-weights-note{opacity:.72;overflow-wrap:anywhere}
.dsh-forge-weight-row{display:flex;gap:8px;justify-content:space-between;gap:10px}
.dsh-forge-weight-name{font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere;min-width:0}
.dsh-forge-weight-state{opacity:.78;white-space:nowrap}
.dsh-forge-workbench-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;min-width:0}
.dsh-forge-workbench-card{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:9px;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.03);min-width:0}
.dsh-forge-workbench-card:hover{border-color:rgba(59,130,246,.45)}
.dsh-forge-workbench-card-open{appearance:none;display:flex;flex-direction:column;gap:6px;width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}
.dsh-forge-workbench-cover{display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;border-radius:6px;overflow:hidden;background:rgba(127,127,127,.1);min-width:0}
.dsh-forge-workbench-cover img{width:100%;height:100%;object-fit:cover;display:block}
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
${WORKBENCH_CSS}
${NODE_DETAIL_CSS}
${XYFLOW_CSS}
${CANVAS_FLOW_CSS}
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
