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
  cover: 'C:/out/cat.png',
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  sessionId: null,
}
const BOARD_TWO = {
  id: 'b_two',
  name: '海报草图',
  itemCount: 0,
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
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const method = init === undefined || init.method === undefined ? 'GET' : init.method
    calls.push({ url, method, body: init === undefined ? undefined : init.body })
    if (url.indexOf(CONFIG_ROUTE) === 0) return respond(config)
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
          return respond({ ok: true })
        }
      }
      return respond({ ok: true })
    }
    if (url.indexOf(BOARD_ROUTE) === 0) return respond({ error: '这个测试没有画板数据' }, 404)
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
    buttonByText(confirm, '确认删除').props.onClick()
    await settle(host, mounted)
    assert.deepEqual(
      network.boardActions().filter((action) => action.action === 'delete'),
      [{ action: 'delete', board: 'b_one' }],
      'the confirmation is what sends the delete',
    )
    assert.equal(cardOf(mounted.tree, 'b_one'), undefined, 'and the card is gone')
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
