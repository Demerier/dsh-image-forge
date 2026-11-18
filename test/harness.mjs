/**
 * The renderer the two workbench harnesses share.
 *
 * `test/studio.test.mjs` used to describe a tree of *host* elements only: it
 * mounted the one seated component and walked the descriptor tree the component
 * returned. That was enough while the panel *was* the studio. The tabbed shell
 * puts components inside components (`WorkbenchShell` → `ProjectsPane` → cards),
 * and a descriptor tree cannot say what a card shows, so the renderer here
 * **calls function components recursively** and keeps one hook array per
 * `path|ComponentName` — stable for a tree that keeps its shape, fresh at a path
 * where the component changed, which is what React does too.
 *
 * Everything else is the same philosophy as before: no DOM, no jsdom, effects
 * queued after render and run by `settle`, so a mount effect's awaited fetches
 * finish before the assertions look at the tree.
 *
 * @module test/harness
 */
import assert from 'node:assert/strict'

/* -------------------------------------------------------------------------- */
/* Reading a rendered tree                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Flatten `createElement` children, **keeping holes** so sibling paths stay
 * stable across renders (the renderer keys hooks by index).
 */
export function collectChildren(child, out) {
  if (Array.isArray(child)) {
    for (const entry of child) collectChildren(entry, out)
    return
  }
  out.push(child === undefined ? null : child)
}

/** Text of a rendered tree (strings and numbers; holes contribute nothing). */
export function fakeText(node) {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) {
    let text = ''
    for (const child of node) text += fakeText(child)
    return text
  }
  if (typeof node !== 'object') return ''
  let text = ''
  for (const child of node.children) text += fakeText(child)
  return text
}

/** Depth-first visit of every host element (an object with a string `type`). */
export function fakeVisit(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const child of node) fakeVisit(child, visit)
    return
  }
  if (typeof node !== 'object' || typeof node.type !== 'string') return
  visit(node)
  for (const child of node.children) fakeVisit(child, visit)
}

/** Every host element matching a predicate. */
export function findAll(root, predicate) {
  const found = []
  fakeVisit(root, (entry) => {
    if (predicate(entry)) found.push(entry)
  })
  return found
}

/** The first element carrying exactly `className`, or `undefined`. */
export function fakeElementWithClass(tree, className) {
  let found
  fakeVisit(tree, (entry) => {
    if (found === undefined && entry.props.className === className) found = entry
  })
  return found
}

/** Same deps, element-wise — React's own comparison, close enough here. */
export function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

/** A fetch-shaped response; the panel only ever asks for `json()`. */
export function fakeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

/* -------------------------------------------------------------------------- */
/* The renderer                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A hook runtime plus a renderer that descends into function components.
 *
 * @returns the runtime React-callable surface plus `render`, effect plumbing
 *   (`takeEffects`/`runEffect`) and `unmount` for cleanup.
 */
export function createHost() {
  const instances = new Map()
  let current
  let cursor = 0
  let pending = []
  let dirty = false

  const instanceAt = (key) => {
    let instance = instances.get(key)
    if (instance === undefined) {
      instance = { hooks: [] }
      instances.set(key, instance)
    }
    return instance
  }

  const slotAt = () => {
    const index = cursor
    cursor += 1
    const slot = current.hooks[index]
    if (slot === undefined) {
      current.hooks[index] = {}
      return { slot: current.hooks[index], fresh: true }
    }
    return { slot, fresh: false }
  }

  const runtime = {
    useState(initial) {
      const { slot, fresh } = slotAt()
      if (fresh) {
        slot.state = typeof initial === 'function' ? initial() : initial
        slot.ready = true
      }
      return [
        slot.state,
        (next) => {
          const value = typeof next === 'function' ? next(slot.state) : next
          if (Object.is(value, slot.state)) return
          slot.state = value
          dirty = true
        },
      ]
    },
    useRef(initial) {
      const { slot, fresh } = slotAt()
      if (fresh) slot.current = initial
      return slot
    },
    useMemo(factory, deps) {
      const { slot } = slotAt()
      if (slot.deps === undefined || !sameDeps(slot.deps, deps)) {
        slot.value = factory()
        slot.deps = deps
      }
      return slot.value
    },
    useCallback(callback, deps) {
      const { slot } = slotAt()
      if (slot.deps === undefined || !sameDeps(slot.deps, deps)) {
        slot.value = callback
        slot.deps = deps
      }
      return slot.value
    },
    useEffect(effect, deps) {
      const { slot, fresh } = slotAt()
      const changed = fresh || slot.deps === undefined || !sameDeps(slot.deps, deps)
      slot.deps = deps
      if (changed) pending.push({ slot, effect })
    },
  }

  function renderNode(element, path) {
    if (element === null || element === undefined || element === true || element === false) return null
    if (typeof element === 'string' || typeof element === 'number') return element
    if (Array.isArray(element)) return element.map((child, index) => renderNode(child, `${path}.${index}`))
    if (typeof element.type === 'function') {
      const saved = current
      const savedCursor = cursor
      current = instanceAt(`${path}|${element.type.name}`)
      cursor = 0
      const output = element.type(element.props)
      current = saved
      cursor = savedCursor
      return renderNode(output, `${path}>`)
    }
    const children = element.children.map((child, index) => renderNode(child, `${path}/${index}`))
    return { type: element.type, props: element.props, children }
  }

  return {
    runtime,
    render(root) {
      pending = []
      dirty = false
      return renderNode(root, 'root')
    },
    get dirty() {
      return dirty
    },
    get pendingEffects() {
      return pending.length
    },
    takeEffects() {
      const effects = pending
      pending = []
      return effects
    },
    runEffect(entry) {
      if (typeof entry.slot.cleanup === 'function') entry.slot.cleanup()
      const cleanup = entry.effect()
      entry.slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    },
    unmount() {
      for (const instance of instances.values()) {
        for (const slot of instance.hooks) {
          if (typeof slot.cleanup === 'function') slot.cleanup()
        }
      }
    },
  }
}

/**
 * The panel API the studio tests were written against.
 *
 * `mount(component)` seats a component in the host, `render()` re-runs the whole
 * tree, and `tree` is what the assertions walk. Keeping this shape means the
 * mount-path change really is a mount-path change: no assertion had to move.
 *
 * @param active - the object the React facade reads its host from.
 * @returns the panel handle.
 */
export function createPanel(active) {
  const host = createHost()
  active.host = host
  let tree
  let Component
  return {
    render() {
      tree = host.render({ type: Component, props: {}, children: [] })
    },
    get tree() {
      return tree
    },
    get dirty() {
      return host.dirty
    },
    get pendingEffects() {
      return host.pendingEffects
    },
    mount(next) {
      Component = next
      this.render()
    },
    takeEffects() {
      return host.takeEffects()
    },
    runEffect(entry) {
      host.runEffect(entry)
    },
    unmount() {
      host.unmount()
    },
  }
}

/** Run render/effects/microtasks until the panel is quiet. */
export async function settle(panel) {
  for (let round = 0; round < 250; round += 1) {
    if (panel.dirty || panel.tree === undefined) {
      panel.render()
      continue
    }
    const effects = panel.takeEffects()
    if (effects.length > 0) {
      for (const entry of effects) panel.runEffect(entry)
      continue
    }
    if (panel.dirty) continue
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!panel.dirty && panel.pendingEffects === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!panel.dirty && panel.pendingEffects === 0) return
    }
  }
  throw new Error('the workbench panel did not settle after 250 rounds')
}

/* -------------------------------------------------------------------------- */
/* Loading the browser half                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate `lib/client.js` the way `window.__ModuleLoader__` does.
 *
 * The bundle is evaluated, not imported: `require("react")` is what the web
 * client resolves, and `react` is deliberately not a dependency of this package.
 *
 * @param source - the bundle text.
 * @param extras - extra globals the bundle expects on `window` (e.g. `confirm`).
 * @returns the module exports plus the `active` object that binds hooks to the
 *   current host — swap `active.host` before a fresh mount to start clean.
 */
export function loadClientBundle(source, extras = {}) {
  const loaded = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        loaded.push(spec)
      },
    },
    ...extras,
  }
  new Function('window', source)(fakeWindow)
  assert.equal(loaded.length, 1, 'the client bundle must register exactly one factory')
  assert.equal(loaded[0].id, 'dsh-image-forge')
  const active = { host: createHost() }
  const react = {
    createElement(type, props, ...children) {
      const flat = []
      for (const child of children) collectChildren(child, flat)
      return { type, props: props === null || props === undefined ? {} : props, children: flat }
    },
    useState(initial) {
      return active.host.runtime.useState(initial)
    },
    useRef(initial) {
      return active.host.runtime.useRef(initial)
    },
    useMemo(factory, deps) {
      return active.host.runtime.useMemo(factory, deps)
    },
    useCallback(callback, deps) {
      return active.host.runtime.useCallback(callback, deps)
    },
    useEffect(effect, deps) {
      return active.host.runtime.useEffect(effect, deps)
    },
  }
  const exports = loaded[0].factory((name) => {
    if (name === 'react') return react
    throw new Error('lib/client.js requested an unexpected module: ' + name)
  })
  return { exports, active }
}
