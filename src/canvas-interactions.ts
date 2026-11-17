/**
 * Canvas interaction logic, kept out of the React component.
 *
 * Pointer gestures cannot be automated in this project (`docs/CANVAS-DESIGN.md`
 * §14.5: no Playwright-class dependency), so everything a gesture *decides* is
 * extracted here as a pure function and asserted directly: which nodes a marquee
 * catches, what a multi-node drag does to coordinates, where an alignment puts
 * each node, which action a key press means, and how far the undo stack can be
 * rewound. What is left in `studio-view.ts` is the pointer capture plumbing.
 *
 * Two rules hold for every function in this module:
 *
 * - **No DOM.** Nothing here reads `document`, `window` or an event object; the
 *   caller flattens a `KeyboardEvent`/pointer event into plain numbers and
 *   strings first. That is what lets the whole module be imported in Node.
 * - **No mutation of arguments.** Positions come back as fresh maps so a drag
 *   can be replayed, and so the caller keeps its previous state for the undo
 *   stack.
 *
 * Camera arithmetic is *not* reimplemented here: {@link marqueeWorldRect}
 * composes `screenToWorld` from `./studio-canvas.ts`, which owns that maths
 * (`src/studio-canvas.ts:9-11` states the discipline). `rectsIntersect` was
 * written here first (C08 landed before C07) and C07 has now moved it into
 * `./studio-canvas.ts`, where the viewport culling needs it without a cycle; it
 * is re-exported below so every existing import path keeps working.
 *
 * @module canvas-interactions
 */

import { rectsIntersect, screenToWorld } from './studio-canvas.ts'
import type { Camera, Point, Rect } from './studio-canvas.ts'

export { rectsIntersect }

/**
 * Hard ceiling on the undo stack, in commands.
 *
 * DD9 (`docs/CANVAS-DESIGN.md` §6.5): an in-memory, session-scoped stack. The
 * cap keeps a long drag session from hoarding snapshots; the oldest command is
 * dropped, never the newest — losing "the last 100 things" is what a user can
 * still fix by hand.
 */
export const COMMAND_STACK_LIMIT = 100

/** World units a single arrow-key press nudges the selection (§6.3). */
export const NUDGE_STEP = 1
/** World units an arrow-key press nudges with Shift held (§6.3). */
export const NUDGE_STEP_FAST = 10

/** A node's id paired with the world rectangle it occupies. */
export interface NodeRect extends Rect {
  readonly id: string
}

/* -------------------------------------------------------------------------- */
/* Marquee: hit-testing and the screen → world rectangle                       */
/* -------------------------------------------------------------------------- */

/**
 * `rectsIntersect` (the marquee's positive-area rule) is re-exported above from
 * `./studio-canvas.ts`: C08 wrote it, C07 moved it to the geometry module where
 * viewport culling can reach it without an import cycle, and the export path here
 * is unchanged so existing marquee callers keep working.
 */

/** Normalise two opposite corners into a rectangle that always has a size. */
function rectBetween(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  }
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
export function marqueeWorldRect(camera: Camera, start: Point, current: Point): Rect {
  return rectBetween(screenToWorld(camera, start), screenToWorld(camera, current))
}

/**
 * The ids of every node the marquee rectangle touches.
 *
 * Input order is preserved, so a caller can keep its render order stable, and a
 * zero-area marquee (a plain click that merely moved a pixel) selects nothing.
 */
export function nodesInRect(nodes: readonly NodeRect[], worldRect: Rect): string[] {
  const hits: string[] = []
  for (const node of nodes) {
    if (rectsIntersect(node, worldRect)) hits.push(node.id)
  }
  return hits
}

/**
 * The union of `rects`, or `undefined` when there is nothing to bound.
 *
 * An empty selection has no box — returning a zero rect at the origin would let
 * an align call scatter nodes to (0, 0), so absence is spelled as `undefined`
 * and callers must handle it (§6.2 alignment is relative to the selection's own
 * bounds, never to the board).
 */
export function selectionBounds(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/* -------------------------------------------------------------------------- */
/* Selection model                                                             */
/* -------------------------------------------------------------------------- */

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
export function toggleSelection(current: ReadonlySet<string>, id: string, additive: boolean): ReadonlySet<string> {
  if (!additive) return new Set([id])
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/**
 * The single selected id, or `undefined` when the set is empty or holds several.
 *
 * This is the compatibility shim for the rest of the canvas: the action bar and
 * "locate" affordances are single-node by design (§13 C09 step 1: "单选语义 =
 * 选择集大小 1"), and they read this instead of growing a multi-node branch.
 */
export function singleSelection(selection: ReadonlySet<string>): string | undefined {
  if (selection.size !== 1) return undefined
  for (const id of selection) return id
  return undefined
}

/* -------------------------------------------------------------------------- */
/* Multi-node drag                                                             */
/* -------------------------------------------------------------------------- */

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
export function moveSelection(
  origins: ReadonlyMap<string, Point>,
  screenDelta: Point,
  zoom: number,
): Map<string, Point> {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const moved = new Map<string, Point>()
  for (const [id, origin] of origins) {
    moved.set(id, { x: origin.x + screenDelta.x / scale, y: origin.y + screenDelta.y / scale })
  }
  return moved
}

/* -------------------------------------------------------------------------- */
/* Align and distribute (§6.2)                                                 */
/* -------------------------------------------------------------------------- */

/** The six alignment modes of the §6.2 toolbar, left to right, top to bottom. */
export const ALIGN_MODES = ['left', 'center-h', 'right', 'top', 'center-v', 'bottom'] as const
/** One alignment mode as listed in the toolbar (§6.2). */
export type AlignMode = (typeof ALIGN_MODES)[number]

/** The two distribution axes: horizontal spacing and vertical spacing (§6.2). */
export const DISTRIBUTE_AXES = ['x', 'y'] as const
/** One distribution axis (§6.2). */
export type DistributeAxis = (typeof DISTRIBUTE_AXES)[number]

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
export function alignNodes(nodes: readonly NodeRect[], mode: AlignMode): Map<string, Point> {
  const positions = new Map<string, Point>()
  for (const node of nodes) positions.set(node.id, { x: node.x, y: node.y })
  const bounds = selectionBounds(nodes)
  if (bounds === undefined) return positions
  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height
  for (const node of nodes) {
    switch (mode) {
      case 'left':
        positions.set(node.id, { x: bounds.x, y: node.y })
        break
      case 'center-h':
        positions.set(node.id, { x: bounds.x + (bounds.width - node.width) / 2, y: node.y })
        break
      case 'right':
        positions.set(node.id, { x: right - node.width, y: node.y })
        break
      case 'top':
        positions.set(node.id, { x: node.x, y: bounds.y })
        break
      case 'center-v':
        positions.set(node.id, { x: node.x, y: bounds.y + (bounds.height - node.height) / 2 })
        break
      case 'bottom':
        positions.set(node.id, { x: node.x, y: bottom - node.height })
        break
      default:
        break
    }
  }
  return positions
}

/** Centre of a node along one axis. */
function centerOf(node: NodeRect, axis: DistributeAxis): number {
  return axis === 'x' ? node.x + node.width / 2 : node.y + node.height / 2
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
export function distributeNodes(nodes: readonly NodeRect[], axis: DistributeAxis): Map<string, Point> {
  const positions = new Map<string, Point>()
  for (const node of nodes) positions.set(node.id, { x: node.x, y: node.y })
  if (nodes.length < 3) return positions
  const sorted = [...nodes].sort((a, b) => {
    const delta = centerOf(a, axis) - centerOf(b, axis)
    if (delta !== 0) return delta
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const first = centerOf(sorted[0], axis)
  const last = centerOf(sorted[sorted.length - 1], axis)
  const step = (last - first) / (sorted.length - 1)
  for (let index = 1; index < sorted.length - 1; index += 1) {
    const node = sorted[index]
    const center = first + step * index
    positions.set(node.id, axis === 'x'
      ? { x: center - node.width / 2, y: node.y }
      : { x: node.x, y: center - node.height / 2 })
  }
  return positions
}

/* -------------------------------------------------------------------------- */
/* Undo / redo (§6.5, DD9)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One undoable step.
 *
 * A command pairs "do it" with "undo it" and nothing else: DD9 leaves the
 * payload opaque on purpose, so a node move, a batch alignment, an add and a
 * removal all share one stack. Commands must not throw — `undo()` pops before it
 * reverts, so a throwing `revert` would drop the step.
 */
export interface Command {
  /** Debug label; never shown to the user, never used to merge commands. */
  readonly label?: string
  /** Apply (or re-apply, on redo) the change. */
  apply(): void
  /** Undo the change. */
  revert(): void
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
export class CommandStack {
  #undo: Command[] = []
  #redo: Command[] = []
  #limit: number

  constructor(limit: number = COMMAND_STACK_LIMIT) {
    this.#limit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : COMMAND_STACK_LIMIT
  }

  /** Maximum number of undoable steps this stack keeps. */
  get limit(): number {
    return this.#limit
  }

  /** How many steps can be undone right now. */
  get undoSize(): number {
    return this.#undo.length
  }

  /** How many undone steps can be redone right now. */
  get redoSize(): number {
    return this.#redo.length
  }

  /** Whether `undo()` would do anything. */
  canUndo(): boolean {
    return this.#undo.length > 0
  }

  /** Whether `redo()` would do anything. */
  canRedo(): boolean {
    return this.#redo.length > 0
  }

  /**
   * Record an already-applied command.
   *
   * Pushing discards the redo tail: once the user does something new after
   * undoing, the abandoned branch is unreachable and keeping it would resurrect
   * a future that no longer follows from the present. Overflow past the cap drops
   * the **oldest** step.
   */
  push(command: Command): void {
    this.#undo.push(command)
    this.#redo.length = 0
    while (this.#undo.length > this.#limit) this.#undo.shift()
  }

  /** Revert the most recent step; `false` when there is nothing to undo. */
  undo(): boolean {
    const command = this.#undo.pop()
    if (command === undefined) return false
    command.revert()
    this.#redo.push(command)
    return true
  }

  /** Re-apply the most recently undone step; `false` when the tail is empty. */
  redo(): boolean {
    const command = this.#redo.pop()
    if (command === undefined) return false
    command.apply()
    this.#undo.push(command)
    return true
  }

  /** Drop both stacks — a board switch starts a fresh history (§6.5: session-scoped). */
  clear(): void {
    this.#undo.length = 0
    this.#redo.length = 0
  }
}

/* -------------------------------------------------------------------------- */
/* Keyboard (§6.3)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Which surface currently owns the keyboard.
 *
 * `canvas` is the only one that acts: §6.3 makes the canvas container
 * `tabIndex=0` and says the input field and the layout editor take **all**
 * shortcuts back ("全部让位") — inside a text field, Delete and Ctrl+Z must edit
 * text, not nodes, and Ctrl+A must select the text. The rename input's own
 * `onKeyDown` (`src/studio-view.ts:1325-1328`) keeps handling its Enter/Esc.
 */
export type ShortcutContext = 'canvas' | 'input' | 'editor'

/** The semantic action a key press means (§6.3's table, verbatim). */
export type ShortcutAction =
  /** Nothing bound, or the surface yields (§6.3). */
  | 'none'
  /** Remove the selected nodes from the board — unplace, never delete files (§6.3). */
  | 'remove'
  /** Ctrl/Cmd+Z (§6.5). */
  | 'undo'
  /** Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z. */
  | 'redo'
  /** Ctrl/Cmd+A: every visible node of the current board. */
  | 'select-all'
  /** Esc: clear the selection, close the context menu, cancel the marquee. */
  | 'escape'
  /** Space held: the pointer pans instead of acting on nodes (§6.6). */
  | 'pan-mode'
  /** F: frame every node. */
  | 'fit'
  /** `+` / `=` / numpad `+`: zoom in around the viewport centre. */
  | 'zoom-in'
  /** `-` / `_` / numpad `-`: zoom out around the viewport centre. */
  | 'zoom-out'
  /** Ctrl/Cmd+C: copy the selection to the in-memory clipboard (§7.2). */
  | 'copy'
  /** Ctrl/Cmd+V: paste onto the current board. */
  | 'paste'
  /** Arrow keys: move the selection by {@link NUDGE_STEP} or {@link NUDGE_STEP_FAST}. */
  | 'nudge-left'
  | 'nudge-right'
  | 'nudge-up'
  | 'nudge-down'

/** Modifier state of one key press, flattened out of the DOM event. */
export interface Modifiers {
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
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
export function resolveShortcut(
  key: string,
  mods: Modifiers = {},
  context: ShortcutContext = 'canvas',
): ShortcutAction {
  // §6.3: the input field and the layout editor take every shortcut back.
  if (context !== 'canvas') return 'none'
  const name = typeof key === 'string' ? key.toLowerCase() : ''
  const mod = mods.ctrl === true || mods.meta === true
  const shift = mods.shift === true
  if (mod) {
    switch (name) {
      case 'z':
        return shift ? 'redo' : 'undo'
      case 'y':
        // Ctrl/Cmd+Y is the second redo binding; Shift is not part of it.
        return shift ? 'none' : 'redo'
      case 'a':
        return shift ? 'none' : 'select-all'
      case 'c':
        return shift ? 'none' : 'copy'
      case 'v':
        return shift ? 'none' : 'paste'
      default:
        return 'none'
    }
  }
  switch (name) {
    case 'delete':
    case 'backspace':
      return 'remove'
    case 'escape':
      return 'escape'
    case ' ':
    case 'space':
    case 'spacebar':
      return 'pan-mode'
    case 'f':
      return 'fit'
    // `+` needs Shift on most layouts, `=` is the unshifted key, and the numpad
    // reports itself as `Add`/`Subtract`; all three mean the same thing.
    case '+':
    case '=':
    case 'add':
      return 'zoom-in'
    case '-':
    case '_':
    case 'subtract':
      return 'zoom-out'
    case 'arrowleft':
      return 'nudge-left'
    case 'arrowright':
      return 'nudge-right'
    case 'arrowup':
      return 'nudge-up'
    case 'arrowdown':
      return 'nudge-down'
    default:
      return 'none'
  }
}

/** What the caller manages to learn about the focused element, without passing DOM nodes in. */
export interface ShortcutTargetFlags {
  /** `event.target.tagName`, upper- or lower-case; anything non-textual is ignored. */
  readonly tagName?: string
  /** `HTMLElement.isContentEditable` for a rich-text target. */
  readonly contentEditable?: boolean
  /** Whether the target sits inside the layout editor (its own `stopPropagation`, §8.3). */
  readonly inEditor?: boolean
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
export function shortcutContext(flags: ShortcutTargetFlags): ShortcutContext {
  if (flags.inEditor === true) return 'editor'
  const tag = typeof flags.tagName === 'string' ? flags.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return 'input'
  if (flags.contentEditable === true) return 'input'
  return 'canvas'
}
