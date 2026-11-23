/**
 * Workbench tab state machine tests (U01, `docs/WORKBENCH-SHELL.md` §3, §15.1).
 *
 * There is no DOM to drive here and no panel to render: the tab rules *are*
 * decidable, so they are decided here. The module is imported straight from
 * `src/`, which is itself the "zero dependency" assertion — Node strips the
 * types and would fail on anything that reached for `document` or React.
 *
 * The cases §14.2 calls out are all present: canvas close cascading into its
 * detail tabs, the left/right/projects fallback for a closed active tab, a
 * duplicate open reusing its tab, the caps refusing without dropping anything,
 * and `rebuildOrder` keeping `projects` first while preserving relative order.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_CANVAS_TABS,
  MAX_RECENT_PROJECTS,
  LOGS_TAB,
  MAX_TABS,
  NODE_DETAIL_KINDS,
  PROJECTS_TAB,
  WORKSPACE_VERSION,
  activateTab,
  canOpenCanvas,
  canOpenTab,
  canvasTabKey,
  closeTab,
  emptyState,
  formatTabKey,
  isNodeDetailKind,
  isTabAllowed,
  listTabs,
  nodeTabKey,
  openBoardIds,
  openCanvas,
  openNodeDetail,
  openTab,
  parseTabKey,
  rebuildOrder,
  reorderAfterClose,
  selectionFor,
  setSelectionFor,
  stateFromWorkspace,
  toWorkspaceJson,
  touchRecentProjects,
} from '../src/workbench-tabs.ts'

/** Keys the way the module spells them, so the assertions read like §3.1. */
const canvas = (boardId) => `canvas:${boardId}`
const node = (boardId, itemId) => `node:${boardId}:${itemId}`

/** A fixed clock reading: nothing in this module calls `Date.now()`. */
const NOW = '2026-11-18T06:12:00.000Z'
const LATER = '2026-11-18T07:30:00.000Z'

/** Open a list of boards in order and return the resulting state. */
function withCanvases(...boardIds) {
  let state = emptyState()
  for (const boardId of boardIds) {
    const result = openCanvas(state, boardId)
    assert.equal(result.rejected, undefined, `opening ${boardId} should not be refused`)
    state = result.state
  }
  return state
}

/** A state with `count` canvas tabs, `b1`…`bN`. */
function canvases(count) {
  return withCanvases(...Array.from({ length: count }, (_, index) => `b${index + 1}`))
}

/* -------------------------------------------------------------------------- */
/* Keys (§3.1)                                                                */
/* -------------------------------------------------------------------------- */

test('parseTabKey: the four tab shapes, and nothing else', () => {
  assert.deepEqual(parseTabKey('projects'), { kind: 'projects', key: 'projects' })
  assert.deepEqual(parseTabKey('logs'), { kind: 'logs', key: 'logs' })
  assert.deepEqual(parseTabKey('canvas:b_7fk2'), { kind: 'canvas', key: 'canvas:b_7fk2', boardId: 'b_7fk2' })
  assert.deepEqual(parseTabKey('node:b_7fk2:i_a1b2'), {
    kind: 'node',
    key: 'node:b_7fk2:i_a1b2',
    boardId: 'b_7fk2',
    itemId: 'i_a1b2',
  })
  // §4.1/§4.2 read JSON and hand keys around, so a malformed key must be a value,
  // not an exception: a thrown error inside a render is a dead panel.
  for (const bad of [
    undefined,
    null,
    42,
    {},
    '',
    'canvas:',
    'canvas',
    'node:b1',
    'node:b1:',
    'node::i1',
    'node:b1:i1:extra',
    'projects:x',
    'canvas:b1:i2',
  ]) {
    assert.equal(parseTabKey(bad), null, `parseTabKey(${JSON.stringify(bad)}) should be null`)
  }
})

test('formatTabKey is the inverse of parseTabKey for every kind', () => {
  for (const key of [PROJECTS_TAB, LOGS_TAB, canvas('b_7fk2'), node('b_7fk2', 'i_a1b2')]) {
    assert.equal(formatTabKey(parseTabKey(key)), key)
  }
  // The builders agree with the parser.
  assert.equal(canvasTabKey('b_7fk2'), canvas('b_7fk2'))
  assert.equal(nodeTabKey('b_7fk2', 'i_a1b2'), node('b_7fk2', 'i_a1b2'))
  // A ref we cannot build degrades to the projects tab instead of crashing (§3.3).
  assert.equal(formatTabKey({ kind: 'elsewhere', boardId: 'b1' }), PROJECTS_TAB)
  assert.equal(formatTabKey({ kind: 'node', boardId: 'b1' }), PROJECTS_TAB)
})

/* -------------------------------------------------------------------------- */
/* Empty state and the projects invariant (§3.1, §3.2 rule 1)                  */
/* -------------------------------------------------------------------------- */

test('emptyState: exactly one projects tab, selected, with nothing else in memory', () => {
  const state = emptyState()
  assert.deepEqual(state.tabOrder, [PROJECTS_TAB])
  assert.equal(state.activeTab, PROJECTS_TAB)
  assert.deepEqual(state.nodeKinds, {})
  assert.deepEqual(state.recentProjects, [])
  assert.deepEqual(state.selections, {})
  assert.deepEqual(openBoardIds(state), [])
  const tabs = listTabs(state)
  assert.equal(tabs.length, 1)
  assert.deepEqual(tabs[0], { key: PROJECTS_TAB, kind: 'projects', orphaned: false })
  // A fresh empty state is a fresh object: callers may keep one as a constant.
  assert.notEqual(emptyState(), state)
})

/* -------------------------------------------------------------------------- */
/* Opening (§3.2 rules 2, 5)                                                  */
/* -------------------------------------------------------------------------- */

test('openCanvas appends in open order, not board order, and activates the new tab', () => {
  const state = withCanvases('b9', 'b2')
  assert.deepEqual(state.tabOrder, [PROJECTS_TAB, canvas('b9'), canvas('b2')])
  assert.deepEqual(openBoardIds(state), ['b9', 'b2'])
  assert.equal(state.activeTab, canvas('b2'))
  // The projects tab is untouched and still first.
  assert.equal(state.tabOrder[0], PROJECTS_TAB)
  // Opening is pure: the previous state keeps its own order.
  const first = openCanvas(emptyState(), 'b1').state
  const second = openCanvas(first, 'b2').state
  assert.deepEqual(first.tabOrder, [PROJECTS_TAB, canvas('b1')], 'the earlier state was not mutated')
  assert.deepEqual(second.tabOrder, [PROJECTS_TAB, canvas('b1'), canvas('b2')])
})

test('opening an already-open board reuses its tab instead of adding one (§3.2 rule 5)', () => {
  const opened = withCanvases('b1', 'b2')
  const again = openCanvas(opened, 'b1')
  assert.equal(again.reused, true)
  assert.equal(again.rejected, undefined)
  assert.deepEqual(again.state.tabOrder, opened.tabOrder, 'no tab was inserted and nothing was reordered')
  assert.equal(again.state.activeTab, canvas('b1'), 'the existing tab is what gets activated')
  // Re-opening the tab that is already active changes nothing at all.
  const same = openCanvas(again.state, 'b1')
  assert.equal(same.state, again.state, 'an idempotent open returns the same object')
})

test('openTab is the key-shaped entry point and refuses what it cannot build', () => {
  let state = emptyState()
  state = openTab(state, PROJECTS_TAB).state
  assert.equal(state.activeTab, PROJECTS_TAB)
  state = openTab(state, canvas('b1')).state
  assert.deepEqual(state.tabOrder, [PROJECTS_TAB, canvas('b1')])
  // A node key cannot carry its detail kind, so a bare one is not openable (§8.2).
  assert.equal(openTab(state, node('b1', 'i1')).rejected, 'invalid')
  const opened = openTab(state, node('b1', 'i1'), { detailKind: 'image' })
  assert.deepEqual(opened.state.tabOrder, [PROJECTS_TAB, canvas('b1'), node('b1', 'i1')])
  assert.equal(opened.state.nodeKinds[node('b1', 'i1')], 'image')
  assert.equal(openTab(state, 'canvas:').rejected, 'invalid')
  assert.equal(openTab(state, 'nonsense').rejected, 'invalid')
})

test('the logs tab is a session-only tab beside projects and canvas', () => {
  const opened = openTab(emptyState(), LOGS_TAB)
  assert.equal(opened.rejected, undefined)
  assert.deepEqual(opened.state.tabOrder, [PROJECTS_TAB, LOGS_TAB])
  assert.equal(opened.state.activeTab, LOGS_TAB)
  assert.deepEqual(listTabs(opened.state)[1], { key: LOGS_TAB, kind: 'logs', orphaned: false })
  // Reopening only activates the existing page.
  assert.equal(openTab(opened.state, LOGS_TAB).reused, true)
  // Closing it follows the same neighbour rule as any other closable tab.
  assert.equal(closeTab(opened.state, LOGS_TAB).state.activeTab, PROJECTS_TAB)
  // Diagnostics are session state: a reload must not reopen the log page.
  const stored = toWorkspaceJson(opened.state)
  assert.deepEqual(stored.tabOrder, [PROJECTS_TAB])
  assert.deepEqual(stored.activeTab, { kind: 'projects' })
})
test('openNodeDetail sits right of its source canvas and keeps the board group together (§3.2 rule 3)', () => {
  const state = withCanvases('b1', 'b2')
  const first = openNodeDetail(state, 'b1', 'i1', 'layout')
  assert.deepEqual(first.state.tabOrder.slice(0, 3), [PROJECTS_TAB, canvas('b1'), node('b1', 'i1')])
  assert.equal(first.state.tabOrder[3], canvas('b2'), 'the other board tab stays to the right')
  const second = openNodeDetail(first.state, 'b1', 'i2', 'task')
  // A second detail tab of the same board lands after the first, not before it:
  // the group keeps the order the user opened it in.
  assert.deepEqual(second.state.tabOrder, [
    PROJECTS_TAB,
    canvas('b1'),
    node('b1', 'i1'),
    node('b1', 'i2'),
    canvas('b2'),
  ])
  assert.equal(second.state.activeTab, node('b1', 'i2'))
  // A detail tab of the last board appends at the end, still right of its canvas.
  const third = openNodeDetail(second.state, 'b2', 'i9', 'layout')
  assert.deepEqual(third.state.tabOrder.slice(-1), [node('b2', 'i9')])
  assert.equal(third.state.nodeKinds[node('b2', 'i9')], 'layout')
})

test('an orphan detail tab appends at the end and reports itself as orphaned (§3.2 rule 3, §8.3)', () => {
  const state = openNodeDetail(emptyState(), 'b1', 'i1', 'layout').state
  assert.deepEqual(state.tabOrder, [PROJECTS_TAB, node('b1', 'i1')])
  const [projects, detail] = listTabs(state)
  assert.equal(projects.orphaned, false)
  assert.equal(detail.orphaned, true, 'its canvas is not open, so the breadcrumb degrades')
  // Re-opening the board later clears the orphan flag without moving the tab.
  const reopened = openCanvas(state, 'b1').state
  assert.deepEqual(reopened.tabOrder, [PROJECTS_TAB, node('b1', 'i1'), canvas('b1')])
  assert.equal(listTabs(reopened).find((tab) => tab.kind === 'node').orphaned, false)
})

test('re-opening a node detail reuses the tab and refreshes a changed kind', () => {
  const state = openNodeDetail(withCanvases('b1'), 'b1', 'i1', 'layout').state
  const again = openNodeDetail(state, 'b1', 'i1', 'layout')
  assert.equal(again.reused, true)
  assert.equal(again.state, state, 'same node, same kind: nothing changed')
  // The node's own kind changed under the tab: the key is stable (§3.1), so only
  // the stored kind is refreshed and the tab is not duplicated.
  const retyped = openNodeDetail(state, 'b1', 'i1', 'task')
  assert.equal(retyped.reused, true)
  assert.deepEqual(retyped.state.tabOrder, state.tabOrder)
  assert.equal(retyped.state.nodeKinds[node('b1', 'i1')], 'task')
  assert.equal(retyped.state.activeTab, node('b1', 'i1'))
})

test('openNodeDetail rejects empty ids and unknown kinds without throwing', () => {
  const state = withCanvases('b1')
  assert.equal(openNodeDetail(state, '', 'i1', 'layout').rejected, 'invalid')
  assert.equal(openNodeDetail(state, 'b1', '', 'layout').rejected, 'invalid')
  assert.equal(openNodeDetail(state, 'b1', 'i1', 'timeline').rejected, 'invalid')
  assert.equal(openNodeDetail(state, 'b1', 'i1', 'timeline').state, state)
  // The kind list is a value other modules can validate against (§4.2).
  assert.deepEqual([...NODE_DETAIL_KINDS], ['layout', 'task', 'image'])
  for (const kind of NODE_DETAIL_KINDS) assert.equal(isNodeDetailKind(kind), true)
  for (const bad of ['', 'layout2', undefined, null, 1]) assert.equal(isNodeDetailKind(bad), false)
})

/* -------------------------------------------------------------------------- */
/* Caps (§3.4)                                                                */
/* -------------------------------------------------------------------------- */

test('the canvas cap refuses a ninth canvas and leaves the strip untouched', () => {
  const full = canvases(MAX_CANVAS_TABS)
  assert.equal(openBoardIds(full).length, MAX_CANVAS_TABS)
  const refused = openCanvas(full, 'b99')
  assert.equal(refused.rejected, 'canvas-limit')
  assert.equal(refused.state, full, 'refused means unchanged, not truncated: nothing was discarded')
  assert.deepEqual(refused.state.tabOrder, full.tabOrder)
  assert.equal(canOpenCanvas(full), false)
  // Re-opening an existing one is still fine: it is an activation, not an insert.
  assert.equal(openCanvas(full, 'b1').reused, true)
  // A detail tab is not a canvas tab, so it still fits under 16 (§3.4).
  assert.equal(openNodeDetail(full, 'b1', 'i1', 'layout').rejected, undefined)
})

test('the total cap refuses growth at 16 tabs whatever the kind', () => {
  // 1 projects + 3 canvas + 12 node tabs = 16.
  let state = withCanvases('b1', 'b2', 'b3')
  for (const boardId of ['b1', 'b2', 'b3']) {
    for (let index = 0; index < 4; index += 1) {
      const result = openNodeDetail(state, boardId, `i${index}`, 'task')
      assert.equal(result.rejected, undefined, 'the 16th tab is the last one accepted')
      state = result.state
    }
  }
  assert.equal(state.tabOrder.length, MAX_TABS)
  assert.equal(canOpenTab(state), false)
  assert.equal(canOpenCanvas(state), true, 'the canvas cap is untouched')
  const refused = openNodeDetail(state, 'b1', 'i9', 'layout')
  assert.equal(refused.rejected, 'tab-limit')
  assert.equal(refused.state, state)
  // The canvas path hits the same ceiling: 8 canvases do not fit beside 8 nodes.
  assert.equal(openCanvas(state, 'b9').rejected, 'tab-limit')
  assert.equal(canOpenCanvas(withCanvases('b1')), true)
  assert.equal(canOpenTab(withCanvases('b1')), true)
})

test('isTabAllowed answers the same question the openers act on', () => {
  const empty = emptyState()
  assert.equal(isTabAllowed(empty, PROJECTS_TAB), true)
  assert.equal(isTabAllowed(empty, canvas('b1')), true)
  assert.equal(isTabAllowed(empty, node('b1', 'i1')), true)
  assert.equal(isTabAllowed(empty, 'nonsense'), false)
  const full = canvases(MAX_CANVAS_TABS)
  assert.equal(isTabAllowed(full, canvas('b9')), false, 'a new board has no room')
  assert.equal(isTabAllowed(full, canvas('b1')), true, 'an open one is always allowed')
  // At the total cap nothing new fits, of any kind — even where a canvas would.
  let packed = withCanvases('b1')
  for (let index = 0; index < MAX_TABS - 2; index += 1) {
    packed = openNodeDetail(packed, 'b1', `i${index}`, 'task').state
  }
  assert.equal(packed.tabOrder.length, MAX_TABS)
  assert.equal(isTabAllowed(packed, node('b1', 'inew')), false)
  assert.equal(canOpenCanvas(packed), true, 'the canvas cap still has room')
  assert.equal(isTabAllowed(packed, canvas('b2')), false, 'the total cap does not')
  assert.equal(openCanvas(packed, 'b2').rejected, 'tab-limit')
})

/* -------------------------------------------------------------------------- */
/* Activation (§3.2 rule 4)                                                   */
/* -------------------------------------------------------------------------- */

test('activateTab selects an open tab and ignores everything else', () => {
  const state = withCanvases('b1', 'b2')
  assert.equal(activateTab(state, canvas('b1')).activeTab, canvas('b1'))
  assert.equal(activateTab(state, PROJECTS_TAB).activeTab, PROJECTS_TAB)
  // Unknown or malformed keys are no-ops, not throws: §3.3 lets a tab outlive
  // the board it points at, and a click on it must not kill the panel.
  assert.equal(activateTab(state, canvas('b404')), state)
  assert.equal(activateTab(state, node('b1', 'i1')), state)
  assert.equal(activateTab(state, 'garbage'), state)
  assert.equal(activateTab(state, ''), state)
  // Activating is idempotent in value, and returns the same object once selected.
  assert.deepEqual(activateTab(state, canvas('b1')), activateTab(state, canvas('b1')))
  const active = activateTab(state, canvas('b1'))
  assert.equal(activateTab(active, canvas('b1')), active)
})

/* -------------------------------------------------------------------------- */
/* Closing (§3.3)                                                             */
/* -------------------------------------------------------------------------- */

test('closing a canvas tab closes its detail tabs and nothing else (§3.3, WD2)', () => {
  let state = withCanvases('b1', 'b2')
  state = openNodeDetail(state, 'b1', 'i1', 'layout').state
  state = openNodeDetail(state, 'b1', 'i2', 'task').state
  state = openNodeDetail(state, 'b2', 'i3', 'image').state
  const result = closeTab(state, canvas('b1'))
  assert.equal(result.rejected, undefined)
  assert.deepEqual(result.closed, [canvas('b1'), node('b1', 'i1'), node('b1', 'i2')], 'the cascade is reported')
  assert.deepEqual(result.state.tabOrder, [PROJECTS_TAB, canvas('b2'), node('b2', 'i3')])
  // The kinds of the removed tabs go with them, and the other board keeps its own.
  assert.equal(node('b1', 'i1') in result.state.nodeKinds, false)
  assert.equal(result.state.nodeKinds[node('b2', 'i3')], 'image')
  // Closing a detail tab leaves its canvas alone (§3.3).
  const nodeOnly = closeTab(result.state, node('b2', 'i3'))
  assert.deepEqual(nodeOnly.closed, [node('b2', 'i3')])
  assert.deepEqual(nodeOnly.state.tabOrder, [PROJECTS_TAB, canvas('b2')])
})

test('a closed active tab hands the selection left, then right, then to projects (§3.2 rule 4)', () => {
  // Left neighbour: the ordinary case, and the one §3.3 calls out for the last
  // canvas tab — its left neighbour is the projects tab.
  const twoBoards = withCanvases('b1', 'b2')
  assert.equal(twoBoards.activeTab, canvas('b2'))
  assert.equal(closeTab(twoBoards, canvas('b2')).state.activeTab, canvas('b1'))
  assert.equal(closeTab(twoBoards, canvas('b2')).state.activeTab, canvas('b1'))
  const lastCanvas = closeTab(withCanvases('b1'), canvas('b1')).state
  assert.deepEqual(lastCanvas.tabOrder, [PROJECTS_TAB])
  assert.equal(lastCanvas.activeTab, PROJECTS_TAB, 'closing the last canvas lands on projects')
  // A detail tab's left neighbour is its own canvas.
  const detail = openNodeDetail(withCanvases('b1'), 'b1', 'i1', 'layout').state
  assert.equal(closeTab(detail, node('b1', 'i1')).state.activeTab, canvas('b1'))
  // Closing a tab that is not the active one leaves the selection alone.
  const state = withCanvases('b1', 'b2', 'b3')
  assert.equal(state.activeTab, canvas('b3'))
  assert.equal(closeTab(state, canvas('b1')).state.activeTab, canvas('b3'))
  assert.equal(closeTab(state, canvas('b3')).state.activeTab, canvas('b2'), 'the closed active tab picks the left one')
})

test('closing refuses the projects tab and tolerates keys it does not know', () => {
  const state = withCanvases('b1')
  assert.equal(closeTab(state, PROJECTS_TAB).rejected, 'not-closable')
  assert.equal(closeTab(state, PROJECTS_TAB).state, state, 'projects is 恒 1 and cannot be closed (§3.1)')
  assert.equal(closeTab(state, canvas('b404')).rejected, 'unknown-key')
  assert.equal(closeTab(state, canvas('b404')).state, state)
  assert.equal(closeTab(state, node('b1', 'i404')).rejected, 'unknown-key')
  for (const bad of ['', 'garbage', 'canvas:', null, undefined]) {
    assert.equal(closeTab(state, bad).rejected, 'invalid')
    assert.equal(closeTab(state, bad).state, state)
  }
})

test('reorderAfterClose: removes keys, then picks the left neighbour, the right one, or projects', () => {
  const order = [PROJECTS_TAB, canvas('b1'), canvas('b2'), canvas('b3')]
  assert.deepEqual(reorderAfterClose(order, [canvas('b2')], canvas('b2')), {
    tabOrder: [PROJECTS_TAB, canvas('b1'), canvas('b3')],
    activeTab: canvas('b1'),
  })
  // No surviving left neighbour → the right one.
  assert.deepEqual(reorderAfterClose(order, [PROJECTS_TAB, canvas('b1')], canvas('b1')), {
    tabOrder: [canvas('b2'), canvas('b3')],
    activeTab: canvas('b2'),
  })
  // Nothing on either side → projects.
  assert.deepEqual(reorderAfterClose([PROJECTS_TAB, canvas('b1')], [canvas('b1'), PROJECTS_TAB], canvas('b1')), {
    tabOrder: [],
    activeTab: PROJECTS_TAB,
  })
  // The selection survives when it is not the tab being closed.
  assert.deepEqual(reorderAfterClose(order, [canvas('b1')], canvas('b3')), {
    tabOrder: [PROJECTS_TAB, canvas('b2'), canvas('b3')],
    activeTab: canvas('b3'),
  })
  // A cascade skips every key it removes: the left neighbour here is removed too.
  assert.deepEqual(
    reorderAfterClose(
      [PROJECTS_TAB, canvas('b1'), node('b1', 'i1'), canvas('b2')],
      [canvas('b1'), node('b1', 'i1')],
      canvas('b1'),
    ),
    { tabOrder: [PROJECTS_TAB, canvas('b2')], activeTab: PROJECTS_TAB },
  )
})

/* -------------------------------------------------------------------------- */
/* Order repair (§4.3, §14.2 ⑥)                                               */
/* -------------------------------------------------------------------------- */

test('rebuildOrder keeps projects first, preserves relative order, then appends what is missing', () => {
  // `projects` is forced to the front even when the stored order lost it there.
  assert.deepEqual(rebuildOrder([canvas('b1'), PROJECTS_TAB], [PROJECTS_TAB, canvas('b1')]), [
    PROJECTS_TAB,
    canvas('b1'),
  ])
  // Surviving keys keep their relative order; a missing one is appended, in the
  // order the required set lists it — not inserted in the middle.
  assert.deepEqual(
    rebuildOrder([canvas('b2'), canvas('b1')], [PROJECTS_TAB, canvas('b1'), canvas('b2'), canvas('b3')]),
    [PROJECTS_TAB, canvas('b2'), canvas('b1'), canvas('b3')],
  )
  // Keys the module cannot parse, and duplicates, are dropped (§4.3).
  assert.deepEqual(rebuildOrder([PROJECTS_TAB, 'garbage', 'canvas:', canvas('b1'), canvas('b1')], [PROJECTS_TAB, canvas('b1')]), [
    PROJECTS_TAB,
    canvas('b1'),
  ])
  // Nothing at all still yields the projects tab: the strip is never empty.
  assert.deepEqual(rebuildOrder([], []), [PROJECTS_TAB])
  // Over the cap it truncates rather than refusing (§4.3).
  const many = Array.from({ length: 20 }, (_, index) => canvas(`b${index + 1}`))
  assert.equal(rebuildOrder(many, many).length, MAX_TABS)
  assert.equal(rebuildOrder(many, many)[0], PROJECTS_TAB)
})

/* -------------------------------------------------------------------------- */
/* workspace.json (§4.2)                                                      */
/* -------------------------------------------------------------------------- */

/** A populated state: two boards, one layout detail tab, the detail tab active. */
function populated() {
  const state = openNodeDetail(withCanvases('b1', 'b2'), 'b1', 'i1', 'layout').state
  return touchRecentProjects(state, 'b2', LATER)
}

test('toWorkspaceJson writes exactly the §4.2 shape', () => {
  const json = toWorkspaceJson(populated())
  assert.deepEqual(Object.keys(json).sort(), [
    'activeTab',
    'nodeDetailTabs',
    'openProjects',
    'recentProjects',
    'tabOrder',
    'version',
  ])
  assert.equal(json.version, WORKSPACE_VERSION)
  assert.deepEqual(json.openProjects, ['b1', 'b2'], 'canvas tabs in strip order')
  assert.deepEqual(json.nodeDetailTabs, [{ boardId: 'b1', nodeId: 'i1', kind: 'layout' }])
  assert.deepEqual(json.activeTab, { kind: 'node', boardId: 'b1', nodeId: 'i1' })
  assert.deepEqual(json.tabOrder, [PROJECTS_TAB, canvas('b1'), node('b1', 'i1'), canvas('b2')])
  assert.deepEqual(json.recentProjects, [{ boardId: 'b2', openedAt: LATER }])
  // The active tab of each kind round-trips through the stored object.
  assert.deepEqual(toWorkspaceJson(emptyState()).activeTab, { kind: 'projects' })
  assert.deepEqual(toWorkspaceJson(withCanvases('b1')).activeTab, { kind: 'canvas', boardId: 'b1' })
  // §4.1: selection is session state and must never reach the file.
  const selected = setSelectionFor(withCanvases('b1'), 'b1', ['i1'])
  assert.equal('selections' in toWorkspaceJson(selected), false)
})

test('stateFromWorkspace restores what toWorkspaceJson wrote, through real JSON', () => {
  const state = populated()
  const refs = { boardIds: ['b1', 'b2'], items: { b1: ['i1'], b2: [] } }
  const restored = stateFromWorkspace(toWorkspaceJson(state), refs)
  assert.deepEqual(restored.tabOrder, state.tabOrder)
  assert.equal(restored.activeTab, state.activeTab)
  assert.deepEqual(restored.nodeKinds, state.nodeKinds)
  assert.deepEqual(restored.recentProjects, state.recentProjects)
  // And the same after a real serialisation round-trip, which is all the file is.
  const viaFile = stateFromWorkspace(JSON.parse(JSON.stringify(toWorkspaceJson(state))), refs)
  assert.deepEqual(viaFile.tabOrder, state.tabOrder)
  assert.equal(viaFile.activeTab, state.activeTab)
})

test('stateFromWorkspace drops bad references item by item (§4.3)', () => {
  const file = {
    version: WORKSPACE_VERSION,
    openProjects: ['b1', 'b_deleted', 'b2'],
    activeTab: { kind: 'canvas', boardId: 'b_deleted' },
    nodeDetailTabs: [
      { boardId: 'b1', nodeId: 'i1', kind: 'layout' },
      { boardId: 'b1', nodeId: 'i_gone', kind: 'task' }, // board alive, item deleted
      { boardId: 'b_deleted', nodeId: 'i2', kind: 'task' }, // board deleted
      { boardId: 'b2', nodeId: 'i3', kind: 'timeline' }, // unknown detail kind
      { boardId: 'b2', nodeId: 'i4' }, // no kind at all
    ],
    tabOrder: [
      PROJECTS_TAB,
      canvas('b_deleted'),
      canvas('b1'),
      node('b1', 'i1'),
      canvas('b2'),
      node('b2', 'i3'),
      'weird:key',
      'node:',
    ],
    recentProjects: [
      { boardId: 'b2', openedAt: NOW },
      { boardId: 'b_deleted', openedAt: NOW },
      { boardId: 'b1', openedAt: 'not-a-date' },
      { boardId: 'b1', openedAt: LATER },
      { boardId: 'b2', openedAt: NOW }, // duplicate: the newest one wins
    ],
  }
  const state = stateFromWorkspace(file, { boardIds: ['b1', 'b2'], items: { b1: ['i1'], b2: [] } })
  // Everything that still resolves survives; only the bad entries went away.
  assert.deepEqual(state.tabOrder, [PROJECTS_TAB, canvas('b1'), node('b1', 'i1'), canvas('b2')])
  assert.deepEqual(state.nodeKinds, { [node('b1', 'i1')]: 'layout' })
  // §4.3: an active tab whose target was dropped falls back to projects.
  assert.equal(state.activeTab, PROJECTS_TAB)
  assert.deepEqual(state.recentProjects, [
    { boardId: 'b2', openedAt: NOW },
    { boardId: 'b1', openedAt: LATER },
  ])
})

test('stateFromWorkspace keeps a valid activeTab and repairs an inconsistent tabOrder', () => {
  // `tabOrder` disagrees with the open sets: the sets win, the order is rebuilt.
  const file = {
    version: WORKSPACE_VERSION,
    openProjects: ['b2', 'b1'],
    activeTab: { kind: 'canvas', boardId: 'b1' },
    nodeDetailTabs: [{ boardId: 'b2', nodeId: 'i9', kind: 'image' }],
    tabOrder: [canvas('b2'), PROJECTS_TAB],
    recentProjects: [],
  }
  const state = stateFromWorkspace(file, { boardIds: ['b1', 'b2'] })
  const expected = [PROJECTS_TAB, canvas('b2'), node('b2', 'i9'), canvas('b1')]
  assert.deepEqual(state.tabOrder, expected, 'projects first, stored order kept, missing tabs appended')
  assert.equal(state.activeTab, canvas('b1'), 'a surviving active tab is honoured')
  // A node tab stored as active is honoured the same way.
  const nodeActive = stateFromWorkspace(
    { version: WORKSPACE_VERSION, openProjects: ['b1'], activeTab: { kind: 'node', boardId: 'b1', nodeId: 'i1' }, nodeDetailTabs: [{ boardId: 'b1', nodeId: 'i1', kind: 'task' }], tabOrder: [], recentProjects: [] },
    { boardIds: ['b1'] },
  )
  assert.equal(nodeActive.activeTab, node('b1', 'i1'))
})

test('stateFromWorkspace opens an empty workspace for anything unreadable, without throwing', () => {
  const cases = [
    undefined,
    null,
    42,
    'text',
    [],
    {}, // no version, no active → the legacy shape is not usable either
    { version: 2, openProjects: ['b1'] }, // §4.3: from a newer build
    { version: '1', openProjects: ['b1'] },
    { version: 0 },
    { version: 1, openProjects: 'b1', nodeDetailTabs: 'nope', tabOrder: 7, recentProjects: null },
  ]
  for (const bad of cases) {
    const state = stateFromWorkspace(bad, { boardIds: ['b1'] })
    assert.deepEqual(state.tabOrder, [PROJECTS_TAB], `opened empty for ${JSON.stringify(bad)}`)
    assert.equal(state.activeTab, PROJECTS_TAB)
    assert.deepEqual(state.recentProjects, [])
  }
})

test('stateFromWorkspace truncates over-limit files instead of refusing them (§4.3)', () => {
  const boards = Array.from({ length: 9 }, (_, index) => `b${index + 1}`)
  const state = stateFromWorkspace(
    {
      version: WORKSPACE_VERSION,
      openProjects: boards,
      activeTab: { kind: 'canvas', boardId: 'b9' },
      nodeDetailTabs: [],
      tabOrder: [PROJECTS_TAB, ...boards.map((boardId) => canvas(boardId))],
      recentProjects: [],
    },
    { boardIds: boards },
  )
  assert.deepEqual(openBoardIds(state), boards.slice(0, MAX_CANVAS_TABS))
  assert.equal(state.activeTab, PROJECTS_TAB, 'the board that fell outside the cap is not active')
  // 20 detail tabs are cut so that the total stays at 16.
  const nodes = Array.from({ length: 20 }, (_, index) => ({ boardId: 'b1', nodeId: `i${index}`, kind: 'task' }))
  const packed = stateFromWorkspace(
    { version: WORKSPACE_VERSION, openProjects: ['b1'], activeTab: { kind: 'projects' }, nodeDetailTabs: nodes, tabOrder: [], recentProjects: [] },
    { boardIds: ['b1'] },
  )
  assert.equal(packed.tabOrder.length, MAX_TABS)
  assert.equal(packed.tabOrder[0], PROJECTS_TAB)
})

test('stateFromWorkspace migrates an old {active} file into one open canvas (§4.4)', () => {
  const state = stateFromWorkspace({ active: 'b1' }, { boardIds: ['b1'], now: NOW })
  assert.deepEqual(state.tabOrder, [PROJECTS_TAB, canvas('b1')])
  assert.equal(state.activeTab, canvas('b1'), 'the old "open straight into the last board" behaviour is kept')
  assert.deepEqual(state.recentProjects, [{ boardId: 'b1', openedAt: NOW }])
  // No clock argument means no timestamp: this module never calls `Date.now()`.
  assert.deepEqual(stateFromWorkspace({ active: 'b1' }).recentProjects, [])
  assert.deepEqual(stateFromWorkspace({ active: 'b1' }, { now: 'nope' }).recentProjects, [])
  // A reference to a board that no longer exists opens nothing.
  assert.deepEqual(stateFromWorkspace({ active: 'b_deleted' }, { boardIds: ['b1'] }).tabOrder, [PROJECTS_TAB])
  assert.deepEqual(stateFromWorkspace({ active: 42 }).tabOrder, [PROJECTS_TAB])
})

/* -------------------------------------------------------------------------- */
/* Recent projects (§4.2)                                                     */
/* -------------------------------------------------------------------------- */

test('touchRecentProjects: newest first, deduplicated, capped, and clock-free', () => {
  let state = touchRecentProjects(emptyState(), 'b1', NOW)
  assert.deepEqual(state.recentProjects, [{ boardId: 'b1', openedAt: NOW }])
  state = touchRecentProjects(state, 'b2', LATER)
  assert.deepEqual(state.recentProjects.map((entry) => entry.boardId), ['b2', 'b1'])
  // Re-opening a board moves it to the front instead of duplicating it.
  state = touchRecentProjects(state, 'b1', '2026-11-18T08:00:00.000Z')
  assert.deepEqual(state.recentProjects.map((entry) => entry.boardId), ['b1', 'b2'])
  assert.equal(state.recentProjects[0].openedAt, '2026-11-18T08:00:00.000Z')
  assert.equal(state.recentProjects.length, 2)
  // An unparseable timestamp cannot be ordered, so it is refused outright.
  assert.equal(touchRecentProjects(state, 'b1', 'yesterday'), state)
  assert.equal(touchRecentProjects(state, '', NOW), state)
  // The cap drops the oldest, never the newest.
  let many = emptyState()
  for (let index = 0; index < MAX_RECENT_PROJECTS + 5; index += 1) many = touchRecentProjects(many, `b${index}`, NOW)
  assert.equal(many.recentProjects.length, MAX_RECENT_PROJECTS)
  assert.equal(many.recentProjects[0].boardId, `b${MAX_RECENT_PROJECTS + 4}`)
  assert.equal(many.recentProjects.some((entry) => entry.boardId === 'b0'), false)
})

/* -------------------------------------------------------------------------- */
/* Session buckets (§4.1, §10.1)                                              */
/* -------------------------------------------------------------------------- */

test('selection buckets are per board, never persisted, and die with their tab', () => {
  let state = withCanvases('b1', 'b2')
  assert.deepEqual(selectionFor(state, 'b1'), [], 'a board with nothing selected allocates nothing')
  state = setSelectionFor(state, 'b1', ['i1', 'i2'])
  state = setSelectionFor(state, 'b2', ['i9'])
  assert.deepEqual(selectionFor(state, 'b1'), ['i1', 'i2'])
  assert.deepEqual(selectionFor(state, 'b2'), ['i9'], 'each canvas tab keeps its own selection')
  assert.notEqual(selectionFor(state, 'b1'), selectionFor(state, 'b2'))
  // Duplicates and blank ids are dropped; an unchanged selection is a no-op.
  assert.deepEqual(selectionFor(setSelectionFor(state, 'b2', ['i7', 'i7', '']), 'b2'), ['i7'])
  assert.equal(setSelectionFor(state, 'b1', ['i1', 'i2']), state)
  // A board with no open canvas tab has nowhere to show a selection.
  const bare = emptyState()
  assert.equal(setSelectionFor(bare, 'b1', ['i1']), bare)
  assert.deepEqual(selectionFor(setSelectionFor(bare, 'b1', ['i1']), 'b1'), [])
  // Closing the canvas drops exactly that board's bucket (§3.3, §4.1).
  const closed = closeTab(state, canvas('b1')).state
  assert.deepEqual(selectionFor(closed, 'b1'), [])
  assert.deepEqual(selectionFor(closed, 'b2'), ['i9'], 'the other tab keeps its selection')
  // Clearing a selection removes the bucket instead of storing an empty array.
  assert.deepEqual(setSelectionFor(state, 'b1', []).selections, { b2: ['i9'] })
})

test('every operation returns a fresh state and leaves the input untouched', () => {
  const state = withCanvases('b1')
  const order = [...state.tabOrder]
  const kinds = { ...state.nodeKinds }
  const selections = { ...state.selections }
  const recent = [...state.recentProjects]
  openCanvas(state, 'b2')
  openNodeDetail(state, 'b1', 'i1', 'layout')
  openTab(state, node('b1', 'i2'), { detailKind: 'task' })
  closeTab(state, canvas('b1'))
  activateTab(state, PROJECTS_TAB)
  setSelectionFor(state, 'b1', ['i1'])
  touchRecentProjects(state, 'b1', NOW)
  rebuildOrder([canvas('b1')], [canvas('b2')])
  assert.deepEqual(state.tabOrder, order)
  assert.deepEqual(state.nodeKinds, kinds)
  assert.deepEqual(state.selections, selections)
  assert.deepEqual(state.recentProjects, recent)
})
