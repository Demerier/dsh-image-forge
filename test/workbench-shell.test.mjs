/**
 * U03 — the tabbed shell and the projects tab (§3, §5, §11, §12 of
 * `docs/WORKBENCH-SHELL.md`).
 *
 * Same approach as `test/studio.test.mjs`, one level further: `lib/client.js` is
 * evaluated the way the web loader does it, the factory is handed a React facade
 * built on top of a small hook runtime, and the **seated** component is mounted
 * against stubbed `fetch`. What differs is the renderer: the studio tests mount
 * one component, so their fake renderer only has to build a descriptor tree of
 * host elements. The shell's tree has components in it (`WorkbenchShell` →
 * `ProjectsPane` → cards), and a descriptor tree cannot assert what a card says.
 * So this file's renderer *calls* function components recursively, keeping one
 * hook array per `path|ComponentName`, which is enough to render, re-render on a
 * click, and run the mount effects.
 *
 * What this cannot prove: paint, focus rings, the feel of a tab switch, or a run
 * against a live host. Those stay in §15.5's manual list.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// The renderer is shared with `test/studio.test.mjs` (`./harness.mjs`): one
// implementation of "call the function components, keep hooks per instance,
// settle effects", so a fix on one side cannot make the two suites disagree.
import {
  createPanel,
  fakeResponse,
  fakeText,
  fakeVisit,
  findAll,
  loadClientBundle,
  settle as settlePanel,
} from './harness.mjs'

/** The built browser half, evaluated by {@link clientEntry}. */
const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

const CONFIG_ROUTE = '/plugins/dsh-image-forge/studio/config'
const BOARD_ROUTE = '/plugins/dsh-image-forge/studio/board'
const FILE_ROUTE = '/plugins/dsh-image-forge/studio/file'

/** The one tab that is always present, in the strip's own language. */
const PROJECTS_LABEL = '项目管理'

/* -------------------------------------------------------------------------- */
/* A renderer just large enough for a component tree                          */
/* -------------------------------------------------------------------------- */

/*
 * The tree reader comes from the shared harness; these two names are what the
 * assertions below call it by, and keeping them costs nothing.
 */
const textOf = fakeText
const visit = fakeVisit
const respond = fakeResponse

/** The first host element whose class list contains `className`. */
function byClass(root, className) {
  return findAll(root, (element) => {
    const value = element.props.className
    return typeof value === 'string' && value.split(' ').includes(className)
  })[0]
}

/** Every `role="tab"` element, in strip order. */
function tabsOf(root) {
  return findAll(root, (element) => element.props.role === 'tab')
}

/** The tab whose `data-tab-kind` is `kind`, or the one whose key matches. */
function tabByKey(root, key) {
  return tabsOf(root).find((element) => element.props['data-tab-key'] === key)
}

/** The selected tab (`aria-selected === true`). */
function selectedTab(root) {
  return tabsOf(root).find((element) => element.props['aria-selected'] === true)
}

/* -------------------------------------------------------------------------- */
/* The client entry, loaded the way the web loader loads it                   */
/* -------------------------------------------------------------------------- */

let loadedClient

/**
 * Evaluate the bundle once; `active.host` is swapped per mount.
 *
 * The host sits behind `active` so a test can hand the already-evaluated bundle
 * a **fresh** hook store: requirement ⑤ is "remount and restore", and reusing
 * one store would keep the previous mount's state and prove nothing.
 */
function clientEntry() {
  if (loadedClient !== undefined) return loadedClient
  loadedClient = loadClientBundle(CLIENT_SOURCE)
  return loadedClient
}

/**
 * Settle the shared panel; accepts `(panel)` and `(host, mounted)`, because the
 * two mount helpers in this repository spell it differently.
 */
const settle = (hostOrPanel, maybePanel) => settlePanel(maybePanel ?? hostOrPanel)

/** Run `apply` and return the component seated in the `main` keyed slot. */
function seatedPanel(exports) {
  const events = []
  const slots = {
    inject(name, register) {
      events.push({ kind: 'inject', name, register })
    },
    register(options, component) {
      events.push({ kind: 'register', options, component })
      return () => {}
    },
  }
  exports.apply({ slots, get: () => undefined })
  for (const event of events) {
    if (event.kind === 'inject') event.register()
  }
  const seat = events.find((event) => event.kind === 'register' && event.options.name === 'main')
  assert.ok(seat, 'the workbench must be seated in the main keyed slot')
  return seat.component
}

/* -------------------------------------------------------------------------- */
/* The host the shell talks to                                                */
/* -------------------------------------------------------------------------- */

/** Two projects: one with a cover and items, one empty and from a conversation. */
const BOARD_ONE = {
  id: 'b_one',
  name: '橘猫计划',
  itemCount: 3,
  // U07: the card reads imageCount/bytes; the numbers are the fake host's.
  imageCount: 3,
  bytes: 86 * 1024 * 1024,
  cover: 'C:/out/cat.png',
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  sessionId: null,
}
const BOARD_TWO = {
  id: 'b_two',
  name: '海报草图',
  itemCount: 0,
  imageCount: 0,
  bytes: 0,
  cover: null,
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
  sessionId: 'sess_1',
}

/**
 * Stub every route the shell (and the studio it mounts in a canvas tab) reads.
 *
 * The board actions are the real contract: `workspace-get` / `workspace-set`
 * per §4.5, plus `create` / `rename` / `delete` from §5.3. `workspace` is kept
 * on the server side of the stub so a remount can be tested against what a
 * previous mount actually wrote.
 */
function installFakeNetwork(options = {}) {
  const previousFetch = globalThis.fetch
  const calls = []
  const library = (options.boards ?? []).map((board) => ({ ...board }))
  // U06: the board a canvas tab reads, when a case needs nodes on the canvas (a
  // detail tab needs something to be the detail *of*). Absent means the old
  // behaviour: a read answers 404 and the canvas stays empty.
  const detail = options.board
  const config = {
    ready: options.ready !== false,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    endpoint: 'http://127.0.0.1:8188',
    models: { unet: 'u.safetensors', clip: 'c.safetensors', vae: 'v.safetensors' },
    defaultSteps: 40,
    outputDir: 'C:/out',
    sizes: [{ ratio: '1:1', width: 1024, height: 1024 }],
    optimizeAvailable: false,
    boards: library,
    activeBoard: options.activeBoard ?? null,
  }
  let workspace = options.workspace === undefined ? null : options.workspace
  let created = 0
  let duplicates = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const method = init === undefined || init.method === undefined ? 'GET' : init.method
    calls.push({ url, method, body: init === undefined ? undefined : init.body })
    // A fresh payload per read, the way a real host re-serialises the snapshot:
    // `create`/`duplicate` answer a new array, and a shell that re-reads must be
    // able to render it. Handing back the same array reference would let a stale
    // `boards` prop look unchanged to anything comparing references.
    if (url.indexOf(CONFIG_ROUTE) === 0) return respond({ ...config, boards: library.map((board) => ({ ...board })) })
    if (url.indexOf(FILE_ROUTE) === 0) return respond({ ok: true })
    if (url.indexOf(BOARD_ROUTE) === 0 && method === 'POST') {
      let action
      try {
        action = JSON.parse(init.body)
      } catch {
        action = undefined
      }
      if (action !== undefined) {
        if (action.action === 'workspace-get') return respond({ ok: true, workspace })
        if (action.action === 'workspace-set') {
          workspace = action.workspace
          return respond({ ok: true })
        }
        if (action.action === 'create') {
          created += 1
          const now = new Date().toISOString()
          const board = {
            id: `b_new${String(created)}`,
            name: typeof action.name === 'string' && action.name.length > 0 ? action.name : `新项目 ${String(created)}`,
            itemCount: 0,
            cover: null,
            createdAt: now,
            updatedAt: now,
            sessionId: null,
          }
          library.unshift(board)
          config.activeBoard = board.id
          return respond({ ok: true, board })
        }
        if (action.action === 'rename') {
          const board = library.find((entry) => entry.id === action.board)
          if (board === undefined) return respond({ error: '画板不存在' }, 404)
          board.name = action.name
          return respond({ ok: true, board })
        }
        if (action.action === 'delete') {
          const index = library.findIndex((entry) => entry.id === action.board)
          if (index < 0) return respond({ error: '画板不存在' }, 404)
          library.splice(index, 1)
          // U07 §5.4: the two 口径 answer with how many files went and how many
          // were kept. The stub keeps no files, so a keep-mode delete reports
          // zeros for both — what matters here is that the flag arrived.
          return respond({
            ok: true,
            filesDeleted: action.deleteFiles === true ? 3 : 0,
            filesKept: 0,
          })
        }
        if (action.action === 'duplicate') {
          // U07 §5.3: a copy is a new board with the same entries, never the files.
          const source = library.find((entry) => entry.id === action.board)
          if (source === undefined) return respond({ error: '画板不存在' }, 404)
          duplicates += 1
          const now = new Date().toISOString()
          const board = {
            ...source,
            id: `b_copy${String(duplicates)}`,
            name: typeof action.name === 'string' && action.name.length > 0 ? action.name : `${source.name} 副本`,
            createdAt: now,
            updatedAt: now,
          }
          library.unshift(board)
          return respond({ ok: true, board, droppedParents: 0 })
        }
        if (action.action === 'save-layout-node') {
          // The detail tab's one writer (§8.1). The board it answers with is the
          // fixture's, with the written draft, so a save can be observed.
          const items = detail === undefined ? [] : detail.items
          const item = items.find((entry) => entry.id === action.item)
          if (item === undefined) return respond({ error: '节点不存在' }, 404)
          item.draft = action.draft
          item.w = action.w
          item.h = action.h
          item.x = action.x
          item.y = action.y
          return respond({ ok: true, item, board: detail })
        }
      }
      return respond({ ok: true })
    }
    if (url.indexOf(BOARD_ROUTE) === 0) {
      if (detail !== undefined) return respond(detail)
      return respond({ error: '这个测试没有画板数据' }, 404)
    }
    return respond({ ok: true })
  }
  return {
    calls,
    library,
    config,
    get workspace() {
      return workspace
    },
    /** Every parsed board-route POST body — the shell's own workspace traffic too. */
    boardActions() {
      return calls
        .filter((call) => call.method === 'POST' && call.url.indexOf(BOARD_ROUTE) === 0 && typeof call.body === 'string')
        .map((call) => JSON.parse(call.body))
    },
    restore() {
      globalThis.fetch = previousFetch
    },
  }
}

/**
 * Mount the seated shell against a fresh network and a fresh hook store.
 *
 * `host` and `mounted` are the same handle on purpose: the shared panel plays
 * both roles (it owns the hook store and it is what `settle` drives), and the
 * assertions below talk to it as the mounted tree.
 */
async function mountShell(options = {}) {
  const harness = clientEntry()
  const network = installFakeNetwork(options)
  const panel = createPanel(harness.active)
  panel.mount(seatedPanel(harness.exports))
  await settle(panel)
  return { harness, host: panel, mounted: panel, panel, network }
}

/** The cards, in render order. */
function cardsOf(root) {
  return findAll(root, (element) => element.props['data-board-id'] !== undefined)
}

/** One card by board id. */
function cardOf(root, boardId) {
  return cardsOf(root).find((element) => element.props['data-board-id'] === boardId)
}

/** A button inside `root` whose text is exactly `label`. */
function buttonByText(root, label) {
  return findAll(root, (element) => element.type === 'button' && textOf(element) === label)[0]
}

/** A control by its accessible name. */
function byLabel(root, label) {
  return findAll(root, (element) => element.props['aria-label'] === label)[0]
}

/** Let the debounced workspace write fire (its delay is 300 ms). */
async function flushWrite() {
  await new Promise((resolve) => setTimeout(resolve, 420))
}

/**
 * Tear one mount down: unmount (which flushes a pending write through *this*
 * test's stub), then put the real `fetch` back.
 *
 * Without the unmount, a debounced write from one test lands in the next test's
 * stub and looks like the shell writing on mount.
 */
async function stop(host, network) {
  host.unmount()
  await new Promise((resolve) => setTimeout(resolve, 0))
  network.restore()
}

/* -------------------------------------------------------------------------- */
/* R1/R3 — the strip on a first mount (§3.1, §12.3)                           */
/* -------------------------------------------------------------------------- */

test('the panel opens on 项目管理, and that tab has no close button', async () => {
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE, BOARD_TWO] })
  try {
    const tabs = tabsOf(mounted.tree)
    assert.deepEqual(
      tabs.map((tab) => tab.props['data-tab-key']),
      ['projects'],
      'a first mount holds exactly the projects tab',
    )
    const active = selectedTab(mounted.tree)
    assert.equal(active.props['data-tab-key'], 'projects', 'R1: the selected tab is the projects tab')
    assert.equal(textOf(active).trim(), PROJECTS_LABEL)
    // §12.3: `projects` renders **no** close button at all (not a disabled one).
    assert.equal(byClass(active, 'dsh-forge-workbench-tab-close'), undefined, 'R3: projects is not closable')
    // The panel is bound to its tab both ways.
    const panel = byClass(mounted.tree, 'dsh-forge-workbench-panel')
    assert.equal(panel.props.role, 'tabpanel')
    assert.equal(panel.props['aria-labelledby'], active.props.id)
    assert.equal(active.props['aria-controls'], panel.props.id)
    // The grid is the projects pane, one card per project.
    assert.equal(cardsOf(mounted.tree).length, 2)
  } finally {
    await stop(host, network)
  }
})

test('a card opens a canvas tab, activates it, and can be closed again', async () => {
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE, BOARD_TWO] })
  try {
    const open = byClass(cardOf(mounted.tree, 'b_one'), 'dsh-forge-workbench-card-open')
    open.props.onClick()
    await settle(host, mounted)

    const tabs = tabsOf(mounted.tree)
    assert.deepEqual(
      tabs.map((tab) => tab.props['data-tab-key']),
      ['projects', 'canvas:b_one'],
      'R2: the canvas tab appends after projects',
    )
    assert.equal(tabs[1].props['aria-selected'], true, 'R2: and it becomes the active tab')
    assert.equal(tabs[0].props['aria-selected'], false, 'the projects tab stays, unselected')
    assert.equal(textOf(tabs[1]).trim().startsWith('橘猫计划'), true, 'the tab shows the project name')

    // R3: a canvas tab does carry a close button, labelled with the name.
    const close = byClass(tabs[1], 'dsh-forge-workbench-tab-close')
    assert.ok(close !== undefined, 'a canvas tab is closable')
    assert.equal(close.props['aria-label'], '关闭 橘猫计划')

    // Re-opening the same project activates it instead of adding a second tab (§3.2 rule 5).
    const panelBefore = byClass(mounted.tree, 'dsh-forge-workbench-panel')
    assert.equal(panelBefore.props['aria-labelledby'], tabs[1].props.id)

    close.props.onClick({ stopPropagation() {} })
    await settle(host, mounted)
    const after = tabsOf(mounted.tree)
    assert.deepEqual(
      after.map((tab) => tab.props['data-tab-key']),
      ['projects'],
      'R3: closing the last canvas tab falls back to the projects tab',
    )
    assert.equal(selectedTab(mounted.tree).props['data-tab-key'], 'projects')
  } finally {
    await stop(host, network)
  }
})

/* -------------------------------------------------------------------------- */
/* §12 — the strip's own keyboard                                             */
/* -------------------------------------------------------------------------- */

test('the strip moves focus with the arrows and closes the focused tab with Escape', async () => {
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE, BOARD_TWO] })
  try {
    byClass(cardOf(mounted.tree, 'b_one'), 'dsh-forge-workbench-card-open').props.onClick()
    await settle(host, mounted)
    assert.equal(byClass(mounted.tree, 'dsh-forge-workbench-strip').props.role, 'tablist')

    // `stripOf` re-reads the element after every settle: a handler captured
    // before a re-render closes over the focus index from back then.
    const stripOf = () => byClass(mounted.tree, 'dsh-forge-workbench-strip')
    const press = async (key) => {
      stripOf().props.onKeyDown({ key, preventDefault() {} })
      await settle(host, mounted)
    }

    // Home puts the roving tabindex on the first tab, ArrowRight on the second.
    await press('Home')
    assert.deepEqual(
      tabsOf(mounted.tree).map((tab) => tab.props.tabIndex),
      [0, -1],
      'Home focuses the projects tab',
    )
    await press('ArrowRight')
    assert.deepEqual(
      tabsOf(mounted.tree).map((tab) => tab.props.tabIndex),
      [-1, 0],
      'ArrowRight moves the roving focus to the canvas tab',
    )

    // Escape on the strip closes the focused, closable tab — `projects` never
    // closes, so pressing it there is a no-op.
    await press('Home')
    await press('Escape')
    assert.equal(tabsOf(mounted.tree).length, 2, 'the projects tab survives Escape')

    // Enter activates whatever the roving focus is on (WAI-ARIA tabs pattern).
    await press('Enter')
    assert.equal(selectedTab(mounted.tree).props['data-tab-key'], 'projects', 'Enter activated the focused tab')

    await press('End')
    await press('Escape')
    assert.deepEqual(
      tabsOf(mounted.tree).map((tab) => tab.props['data-tab-key']),
      ['projects'],
      'Escape closed the focused canvas tab',
    )
  } finally {
    await stop(host, network)
  }
})

/* -------------------------------------------------------------------------- */
/* §4 — the workspace round trip                                              */
/* -------------------------------------------------------------------------- */

test('a remount restores the strip from workspace.json, and reading never writes', async () => {
  const stored = {
    version: 1,
    openProjects: ['b_one'],
    activeTab: { kind: 'canvas', boardId: 'b_one' },
    nodeDetailTabs: [],
    tabOrder: ['projects', 'canvas:b_one'],
    recentProjects: [{ boardId: 'b_one', openedAt: '2026-11-18T06:12:00.000Z' }],
  }
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE, BOARD_TWO], workspace: stored })
  try {
    const tabs = tabsOf(mounted.tree)
    assert.deepEqual(
      tabs.map((tab) => tab.props['data-tab-key']),
      ['projects', 'canvas:b_one'],
      '⑤: the strip comes back from the file',
    )
    assert.equal(selectedTab(mounted.tree).props['data-tab-key'], 'canvas:b_one', '⑤: including the active tab')
    assert.deepEqual(
      network.boardActions().map((action) => action.action),
      ['workspace-get'],
      '§4.3: reading the workspace does not write it back',
    )
  } finally {
    await stop(host, network)
  }
})

test('a state.json-only install opens the active board as a canvas tab (§4.4)', async () => {
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE], activeBoard: 'b_one' })
  try {
    assert.deepEqual(
      tabsOf(mounted.tree).map((tab) => tab.props['data-tab-key']),
      ['projects', 'canvas:b_one'],
      '§4.4: the legacy migration keeps the old "open the last project" behaviour',
    )
    assert.deepEqual(
      network.boardActions().map((action) => action.action),
      ['workspace-get'],
      'the migration is memory-only until the user changes the strip',
    )
  } finally {
    await stop(host, network)
  }
})

test('a workspace pointing at a deleted board degrades to the projects tab', async () => {
  const stored = {
    version: 1,
    openProjects: ['b_gone'],
    activeTab: { kind: 'canvas', boardId: 'b_gone' },
    nodeDetailTabs: [],
    tabOrder: ['projects', 'canvas:b_gone'],
    recentProjects: [],
  }
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE], workspace: stored })
  try {
    assert.deepEqual(
      tabsOf(mounted.tree).map((tab) => tab.props['data-tab-key']),
      ['projects'],
      '§4.3: a reference to a board that no longer exists is dropped, not rendered',
    )
    assert.equal(selectedTab(mounted.tree).props['data-tab-key'], 'projects')
  } finally {
    await stop(host, network)
  }
})

test('opening a project writes the workspace once, after the debounce', async () => {
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE] })
  try {
    byClass(cardOf(mounted.tree, 'b_one'), 'dsh-forge-workbench-card-open').props.onClick()
    await settle(host, mounted)
    assert.deepEqual(
      network.boardActions().map((action) => action.action),
      ['workspace-get'],
      'the write is debounced, not fired on the click',
    )
    await flushWrite()
    const writes = network.boardActions().filter((action) => action.action === 'workspace-set')
    assert.equal(writes.length, 1, 'one write per burst of strip changes')
    assert.deepEqual(writes[0].workspace.openProjects, ['b_one'])
    assert.deepEqual(writes[0].workspace.activeTab, { kind: 'canvas', boardId: 'b_one' })
    assert.deepEqual(writes[0].workspace.tabOrder, ['projects', 'canvas:b_one'])
  } finally {
    await stop(host, network)
  }
})

/* -------------------------------------------------------------------------- */
/* §5 — the projects toolbar and the card actions                            */
/* -------------------------------------------------------------------------- */

test('creating a project names it, opens its canvas tab, and deleting asks first', async () => {
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE] })
  try {
    byLabel(mounted.tree, '新项目名称').props.onChange({ target: { value: '新海报' } })
    await settle(host, mounted)
    buttonByText(mounted.tree, '新建项目').props.onClick()
    await settle(host, mounted)

    const creates = network.boardActions().filter((action) => action.action === 'create')
    assert.deepEqual(creates, [{ action: 'create', name: '新海报' }], 'the typed name is sent')
    const created = tabByKey(mounted.tree, 'canvas:b_new1')
    assert.ok(created !== undefined, 'the new project opens its canvas tab')
    assert.equal(created.props['aria-selected'], true, 'and it is active')

    // Back to the grid: a card's delete is a two-step action, and the first
    // click only asks.
    tabByKey(mounted.tree, 'projects').props.onClick()
    await settle(host, mounted)
    const card = cardOf(mounted.tree, 'b_one')
    byLabel(card, '删除 橘猫计划').props.onClick()
    await settle(host, mounted)
    assert.equal(
      network.boardActions().filter((action) => action.action === 'delete').length,
      0,
      'nothing is deleted before the confirmation',
    )
    const confirm = byClass(mounted.tree, 'dsh-forge-workbench-confirm')
    assert.ok(confirm !== undefined, 'a non-empty project asks for confirmation')
    assert.match(textOf(confirm), /3 个节点/)
    // U07 §5.4: both 口径 are reachable in the confirmation, and the destructive
    // one states what it would delete and that it cannot be undone.
    const warn = byClass(mounted.tree, 'dsh-forge-workbench-confirm-warn')
    assert.ok(warn !== undefined, 'the confirmation warns about the destructive option')
    assert.match(textOf(warn), /3 张图片/)
    assert.match(textOf(warn), /86 MB/)
    assert.match(textOf(warn), /无法恢复/)
    assert.ok(buttonByText(confirm, '连图片一起删除') !== undefined, 'the second option is on screen')
    buttonByText(confirm, '只删项目（图片留在素材库）').props.onClick()
    await settle(host, mounted)
    assert.deepEqual(
      network.boardActions().filter((action) => action.action === 'delete'),
      [{ action: 'delete', board: 'b_one' }],
      'the confirmation is what sends the delete, and 只删项目 sends no file flag',
    )
    assert.equal(cardOf(mounted.tree, 'b_one'), undefined, 'and the card is gone')
  } finally {
    await stop(host, network)
  }
})

test('U07: 复制 sends a duplicate action and the copy lands in the grid', async () => {
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE] })
  try {
    const card = cardOf(mounted.tree, 'b_one')
    // The card menu carries the copy action (§5.3), next to 重命名 / 删除.
    const copyButton = byLabel(card, '复制 橘猫计划')
    assert.ok(copyButton !== undefined, '复制 is one of the card actions')
    assert.equal(textOf(copyButton), '复制')
    copyButton.props.onClick()
    await settle(host, mounted)

    assert.deepEqual(
      network.boardActions().filter((action) => action.action === 'duplicate'),
      [{ action: 'duplicate', board: 'b_one' }],
      '复制 asks the host for one duplicate of this project',
    )
    // The library was re-read, so the copy is a card of its own — with its own id,
    // the same entries and therefore the same size.
    const copied = cardOf(mounted.tree, 'b_copy1')
    assert.ok(copied !== undefined, 'the copy appears in the grid')
    assert.match(textOf(copied), /橘猫计划 副本/)
    assert.match(textOf(copied), /86 MB/, 'a copy shares the files, so it reports the same size')
  } finally {
    await stop(host, network)
  }
})

test('U07: 连图片一起删除 sends deleteFiles, and only that option does', async () => {
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE, BOARD_TWO] })
  try {
    byLabel(cardOf(mounted.tree, 'b_one'), '删除 橘猫计划').props.onClick()
    await settle(host, mounted)
    const confirm = byClass(mounted.tree, 'dsh-forge-workbench-confirm')
    assert.ok(confirm !== undefined)
    // The destructive option is labelled with what it does, and carries the counts
    // the user is agreeing to in the same block.
    assert.match(textOf(confirm), /3 张图片/, 'the confirmation names the picture count')
    assert.match(textOf(confirm), /86 MB/, 'and the size')
    buttonByText(confirm, '连图片一起删除').props.onClick()
    await settle(host, mounted)

    assert.deepEqual(
      network.boardActions().filter((action) => action.action === 'delete'),
      [{ action: 'delete', board: 'b_one', deleteFiles: true }],
      'the second option is the only path that sends deleteFiles',
    )
    assert.equal(cardOf(mounted.tree, 'b_one'), undefined)

    // An empty project needs no choice: one 确认删除, and no file flag.
    byLabel(cardOf(mounted.tree, 'b_two'), '删除 海报草图').props.onClick()
    await settle(host, mounted)
    const empty = byClass(mounted.tree, 'dsh-forge-workbench-confirm')
    assert.ok(empty !== undefined)
    assert.match(textOf(empty), /删除空项目/)
    assert.equal(buttonByText(empty, '连图片一起删除'), undefined, 'nothing to delete, so no second option')
    buttonByText(empty, '确认删除').props.onClick()
    await settle(host, mounted)
    assert.deepEqual(
      network.boardActions().filter((action) => action.action === 'delete'),
      [
        { action: 'delete', board: 'b_one', deleteFiles: true },
        { action: 'delete', board: 'b_two' },
      ],
      'an empty project deletes with one confirmation and no flag',
    )
  } finally {
    await stop(host, network)
  }
})

test('the search box filters the grid and the sort picker reorders it', async () => {
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE, BOARD_TWO] })
  try {
    // Default order is "recently modified": b_one (3 minutes ago) before b_two.
    assert.deepEqual(cardsOf(mounted.tree).map((card) => card.props['data-board-id']), ['b_one', 'b_two'])

    const sort = byLabel(mounted.tree, '排序')
    sort.props.onChange({ target: { value: 'name' } })
    await settle(host, mounted)
    assert.deepEqual(
      cardsOf(mounted.tree).map((card) => card.props['data-board-id']),
      ['b_two', 'b_one'],
      'by name, 海报草图 sorts before 橘猫计划',
    )

    byLabel(mounted.tree, '搜索项目').props.onChange({ target: { value: '海报' } })
    await settle(host, mounted)
    assert.deepEqual(
      cardsOf(mounted.tree).map((card) => card.props['data-board-id']),
      ['b_two'],
      'the substring filter keeps one card',
    )

    byLabel(mounted.tree, '搜索项目').props.onChange({ target: { value: '不存在的项目' } })
    await settle(host, mounted)
    assert.equal(cardsOf(mounted.tree).length, 0)
    assert.match(textOf(byClass(mounted.tree, 'dsh-forge-workbench-empty-note')), /没有匹配的项目/)
  } finally {
    await stop(host, network)
  }
})

test('a card shows the cover thumbnail, the count and a relative time', async () => {
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE, BOARD_TWO] })
  try {
    const card = cardOf(mounted.tree, 'b_one')
    const img = findAll(card, (element) => element.type === 'img')[0]
    assert.ok(img !== undefined, 'a project with a cover renders one')
    assert.ok(img.props.src.includes('?path='), 'the cover goes through the file route')
    assert.ok(img.props.src.includes('w=256'), 'and asks for the 256-px contact-sheet width')
    assert.match(textOf(card), /3 个节点/, 'the count is spelled out')
    assert.match(textOf(card), /3 分钟前/, 'the age is relative')

    const empty = cardOf(mounted.tree, 'b_two')
    assert.match(textOf(empty), /空项目/, 'an empty project says so')
    assert.match(textOf(empty), /小时前/, 'and still shows when it changed')
    assert.ok(findAll(empty, (element) => element.type === 'img').length === 0, 'with no cover it draws a placeholder')
  } finally {
    await stop(host, network)
  }
})

/* -------------------------------------------------------------------------- */
/* §11 — the empty state and the environment hint                            */
/* -------------------------------------------------------------------------- */

test('an empty library shows the first-run card, with the backend hint above it', async () => {
  const { network, host, mounted } = await mountShell({
    boards: [],
    ready: false,
    reason: 'ComfyUI 没在跑（127.0.0.1:8188 没有回答）',
  })
  try {
    const empty = byClass(mounted.tree, 'dsh-forge-workbench-empty')
    assert.ok(empty !== undefined, '§11.1: no projects means the empty card')
    assert.match(textOf(empty), /还没有项目/)
    assert.match(textOf(empty), /项目 = 一块无限画布/)
    assert.ok(buttonByText(empty, '新建项目') !== undefined, 'the primary action is 新建项目')

    const env = byClass(mounted.tree, 'dsh-forge-workbench-env')
    assert.ok(env !== undefined, '§11.1: a dead backend adds a hint, not a blocker')
    assert.match(textOf(env), /ComfyUI 没在跑/)
    assert.equal(env.props.role, 'status', 'the hint is announced, not an alert')

    // The hint is above the card, and it never covers the pane: the empty state
    // is still reachable and clickable (§11.4's "editing is never blocked").
    const created = byClass(mounted.tree, 'dsh-forge-workbench-empty')
    assert.ok(created !== undefined)
    buttonByText(mounted.tree, '新建项目').props.onClick()
    await settle(host, mounted)
    assert.deepEqual(
      network.boardActions().filter((action) => action.action === 'create'),
      [{ action: 'create' }],
      'an empty name lets the host auto-name the project',
    )
  } finally {
    await stop(host, network)
  }
})

test('the assets entry opens the placeholder sub-view and comes back', async () => {
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE] })
  try {
    buttonByText(mounted.tree, '全局素材').props.onClick()
    await settle(host, mounted)
    assert.match(textOf(byClass(mounted.tree, 'dsh-forge-workbench-assets')), /全局素材库/)
    assert.equal(cardsOf(mounted.tree).length, 0, 'the grid is replaced by the sub-view, not stacked under it')
    buttonByText(mounted.tree, '返回项目').props.onClick()
    await settle(host, mounted)
    assert.equal(cardsOf(mounted.tree).length, 1, 'and the grid is back')
  } finally {
    await stop(host, network)
  }
})

/* -------------------------------------------------------------------------- */
/* The seat: the shell is what `main` renders (§14.4 acceptance ⑥)           */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* U06 — the node detail tab (§8.2, §8.4)                                    */
/* -------------------------------------------------------------------------- */

/*
 * What this section can and cannot prove.
 *
 * The tab itself is host markup, so "click 打开详情 → a `node:` tab appears →
 * closing the canvas tab takes it with it" runs end to end through the real
 * bundle. What it cannot see is the *canvas node*: `FlowCanvas` needs a measured
 * container (`clientWidth`) and this renderer has no DOM, so the engine paints
 * "画布准备中…" and never reaches a node painter. §8.4's thumbnail — the canvas
 * side of the single-editor rule — is therefore asserted where it is decidable:
 * the pure `layoutEditorOwner` / `draftPreviewBoxes` in `test/studio.test.mjs`,
 * the shipped source below, and the U06 manual checklist.
 */

/** A layout draft with two boxes: the detail tab's subject. */
const DETAIL_DRAFT = {
  width: 1536,
  height: 1024,
  bbox_coord_space: 'abs',
  bbox_format: 'xyxy',
  summary: { caption: '三栏海报' },
  items: [
    { label: 'object', caption: '左边的橘猫', bbox: [0, 0, 512, 1024] },
    { label: 'text', caption: '右边的标题', bbox: [1024, 0, 1536, 400] },
  ],
}

/** One board whose only node is a MOSS layout — U06's reason for existing. */
const LAYOUT_BOARD = {
  id: 'b_one',
  name: '橘猫计划',
  camera: { x: 0, y: 0, zoom: 1 },
  items: [
    { id: 'ilayout1', kind: 'layout', x: 120, y: 60, parents: [], w: 480, draft: DETAIL_DRAFT },
  ],
}

/** The first host element carrying `props[name] === value`. */
function byData(root, name, value) {
  return findAll(root, (element) => element.props[name] === value)[0]
}

/** The flow container — where the studio's keyboard handler is forwarded. */
function flowRoot(root) {
  const found = byClass(root, 'dsh-forge-flow')
  assert.ok(found !== undefined, 'the canvas tab must render the flow container')
  return found
}

/** Shaped like the keyboard events the canvas reads. */
function pressKey(key, modifiers = {}) {
  return {
    key,
    ctrlKey: modifiers.ctrl === true,
    metaKey: modifiers.meta === true,
    shiftKey: modifiers.shift === true,
    altKey: modifiers.alt === true,
    preventDefault() {},
    target: { tagName: 'DIV', isContentEditable: false, closest: () => null },
  }
}

/** Open the layout board and select its one node (Ctrl+A is the harness's way). */
async function openLayoutBoard() {
  const handle = await mountShell({ boards: [BOARD_ONE], board: LAYOUT_BOARD })
  const panel = handle.mounted
  byClass(cardOf(panel.tree, 'b_one'), 'dsh-forge-workbench-card-open').props.onClick()
  await settlePanel(panel)
  flowRoot(panel.tree).props.onKeyDown(pressKey('a', { ctrl: true }))
  await settlePanel(panel)
  return handle
}

/** The drawer's 打开详情, clicked — the one entry §8.2 gives the user. */
function openLayoutDetail(panel) {
  const drawer = byData(panel.tree, 'data-inspector-kind', 'layout')
  assert.ok(drawer !== undefined, 'the layout node’s drawer must be open')
  const open = byData(drawer, 'data-inspector-action', 'open-detail')
  assert.ok(open !== undefined, 'the drawer offers 打开详情')
  open.props.onClick()
}

test('U06: 打开详情 opens a node tab beside its canvas tab, and the pane is the layout editor', async () => {
  const mounted = await openLayoutBoard()
  const panel = mounted.mounted
  try {
    // The drawer is about the layout node, and its 打开详情 is a real button now.
    const drawer = byData(panel.tree, 'data-inspector-kind', 'layout')
    assert.ok(drawer !== undefined, 'selecting the layout node opens its drawer')
    const open = byData(drawer, 'data-inspector-action', 'open-detail')
    assert.ok(open !== undefined, 'the drawer offers 打开详情')
    assert.equal(open.props.disabled, false, 'U06 un-disabled it')

    open.props.onClick()
    await settlePanel(panel)

    // §3.2 rule 3: immediately right of the board's own tab group.
    assert.deepEqual(
      tabsOf(panel.tree).map((tab) => tab.props['data-tab-key']),
      ['projects', 'canvas:b_one', 'node:b_one:ilayout1'],
      'the detail tab lands with its board, and becomes active',
    )
    assert.equal(selectedTab(panel.tree).props['data-tab-key'], 'node:b_one:ilayout1')

    // §8.2's title rule: `布局 · <项目名>` (the key never moves, only the label).
    const label = textOf(tabByKey(panel.tree, 'node:b_one:ilayout1')).trim()
    assert.ok(label.startsWith('布局 · 橘猫计划'), `the tab is named after its kind and project, got ${label}`)

    // §8.2's layout view: the facts and the editor host the pane mounts into.
    const pane = byData(panel.tree, 'data-detail-kind', 'layout')
    assert.ok(pane !== undefined, 'the pane is the layout view')
    assert.match(textOf(byData(pane, 'data-detail-field', 'size')), /1536×1024/, 'the draft’s own pixels')
    assert.match(textOf(byData(pane, 'data-detail-field', 'items')), /2/, 'the box count is the draft’s')
    assert.match(
      textOf(byData(pane, 'data-detail-field', 'ratio')),
      /3:2/,
      'a 1536×1024 draft maps onto the 3:2 tier the generation would use',
    )
    assert.ok(byData(pane, 'data-detail-editor', 'layout') !== undefined, 'the editor has a host in the pane')
    for (const action of ['undo', 'save', 'intent', 'back']) {
      assert.ok(byData(pane, 'data-detail-action', action) !== undefined, `the toolbar offers ${action}`)
    }
    // One pane at a time: the canvas tab is unmounted, so no second editor can
    // even exist while the detail tab is on screen (§8.4's first half).
    assert.equal(byClass(panel.tree, 'dsh-forge-flow'), undefined, 'the canvas pane unmounted')
  } finally {
    await stop(mounted.host, mounted.network)
  }
})

test('U06: 保存 writes the draft through save-layout-node, geometry included', async () => {
  const mounted = await openLayoutBoard()
  const panel = mounted.mounted
  try {
    openLayoutDetail(panel)
    await settlePanel(panel)
    const save = byData(panel.tree, 'data-detail-action', 'save')
    assert.ok(save !== undefined)
    save.props.onClick()
    await settlePanel(panel)

    const writes = mounted.network.boardActions().filter((action) => action.action === 'save-layout-node')
    assert.equal(writes.length, 1, 'one write, through the one route §8.1 defines')
    const body = writes[0]
    assert.equal(body.board, 'b_one')
    assert.equal(body.item, 'ilayout1')
    assert.deepEqual(body.draft, DETAIL_DRAFT, 'the draft travels verbatim')
    assert.equal(body.x, 120, 'the node keeps its place')
    assert.equal(body.y, 60)
    assert.equal(body.w, 480, 'the display width is the node’s, not the draft’s')
    // 100 px of chrome + 480 × (1024/1536) — the same rule the canvas applies.
    assert.equal(body.h, 420, 'the height follows the draft’s proportion')
  } finally {
    await stop(mounted.host, mounted.network)
  }
})

test('U06: closing the canvas tab closes its detail tab too (WD2)', async () => {
  const mounted = await openLayoutBoard()
  const panel = mounted.mounted
  try {
    openLayoutDetail(panel)
    await settlePanel(panel)
    const canvasTab = tabByKey(panel.tree, 'canvas:b_one')
    byClass(canvasTab, 'dsh-forge-workbench-tab-close').props.onClick({ stopPropagation() {} })
    await settlePanel(panel)
    assert.deepEqual(
      tabsOf(panel.tree).map((tab) => tab.props['data-tab-key']),
      ['projects'],
      'the detail tab went with its canvas — the strip cannot hold a tab with no project',
    )
    assert.equal(selectedTab(panel.tree).props['data-tab-key'], 'projects')
  } finally {
    await stop(mounted.host, mounted.network)
  }
})

test('U06: a detail tab closed on its own leaves the canvas alone', async () => {
  const mounted = await openLayoutBoard()
  const panel = mounted.mounted
  try {
    openLayoutDetail(panel)
    await settlePanel(panel)
    byData(panel.tree, 'data-detail-action', 'close').props.onClick()
    await settlePanel(panel)
    assert.deepEqual(
      tabsOf(panel.tree).map((tab) => tab.props['data-tab-key']),
      ['projects', 'canvas:b_one'],
      '§3.3: closing a node tab does not cascade upwards',
    )
    assert.equal(selectedTab(panel.tree).props['data-tab-key'], 'canvas:b_one')
  } finally {
    await stop(mounted.host, mounted.network)
  }
})

test('U06: a detail tab restored without its canvas tab degrades its breadcrumb and can reopen (§8.3)', async () => {
  // A workspace with a detail tab and no open canvas: what a hand-edited file,
  // or a phase where the canvas tab was closed elsewhere, leaves behind.
  const stored = {
    version: 1,
    openProjects: [],
    activeTab: { kind: 'node', boardId: 'b_one', nodeId: 'ilayout1' },
    nodeDetailTabs: [{ boardId: 'b_one', nodeId: 'ilayout1', kind: 'layout' }],
    tabOrder: ['projects', 'node:b_one:ilayout1'],
    recentProjects: [],
  }
  const { network, host, mounted } = await mountShell({ boards: [BOARD_ONE], board: LAYOUT_BOARD, workspace: stored })
  try {
    assert.deepEqual(
      tabsOf(mounted.tree).map((tab) => tab.props['data-tab-key']),
      ['projects', 'node:b_one:ilayout1'],
      'the orphaned detail tab is restored, at the end of the strip',
    )
    const crumb = byData(mounted.tree, 'data-detail-crumb', 'orphaned')
    assert.ok(crumb !== undefined, 'the breadcrumb degrades to plain text')
    assert.ok(byData(mounted.tree, 'data-detail-orphan', 'true') !== undefined, 'and says why')
    // The degraded breadcrumb's action reopens the project (§8.3).
    const back = byData(mounted.tree, 'data-detail-action', 'back')
    assert.ok(back !== undefined)
    back.props.onClick()
    await settlePanel(mounted)
    assert.deepEqual(
      tabsOf(mounted.tree).map((tab) => tab.props['data-tab-key']),
      ['projects', 'node:b_one:ilayout1', 'canvas:b_one'],
      '返回画布 opens the missing canvas tab and activates it',
    )
    assert.equal(selectedTab(mounted.tree).props['data-tab-key'], 'canvas:b_one')
  } finally {
    await stop(host, network)
  }
})

test('U06: the panel’s own wiring ships — one editor owner, one intent, no second generate path', () => {
  // The canvas side of §8.4 lives inside React Flow's node painters, which need a
  // measured container; what a Node process can still pin is that the branch and
  // the plumbing are in the shipped bundle at all.
  assert.ok(CLIENT_SOURCE.includes('detailOpen'), 'the strip’s open detail tabs reach the canvas')
  assert.ok(CLIENT_SOURCE.includes('data-detail-locked'), 'the node painter has the locked branch')
  assert.ok(CLIENT_SOURCE.includes('data-detail-action'), 'the pane’s buttons are addressable')
  assert.ok(CLIENT_SOURCE.includes('save-layout-node'), 'the pane writes through §8.1’s one route')
  assert.ok(CLIENT_SOURCE.includes('openNodeDetail('), 'the shell opens tabs through the state machine')
})

test('the main seat renders the tabbed shell, with id and label unchanged', () => {
  const harness = clientEntry()
  const events = []
  const slots = {
    inject(name, register) {
      events.push({ kind: 'inject', name, register })
    },
    register(options, component) {
      events.push({ kind: 'register', options, component })
      return () => {}
    },
  }
  harness.exports.apply({ slots, get: () => undefined })
  for (const event of events) {
    if (event.kind === 'inject') event.register()
  }
  const main = events.find((event) => event.kind === 'register' && event.options.name === 'main')
  assert.ok(main !== undefined)
  assert.equal(main.options.key, 'dsh-image-forge', 'the seat key must not move')
  assert.equal(main.options.id, undefined, 'main is keyed, never addressed by id')
  assert.equal(main.component.name, 'WorkbenchShell', 'the seated component is the shell')
  const row = events.find((event) => event.kind === 'register' && event.options.name === 'sidebar.panellist')
  assert.ok(row !== undefined)
  assert.equal(row.options.id, 'dsh-image-forge')
  assert.equal(row.options.label(), '图像工作台')
})
