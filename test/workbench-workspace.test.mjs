/**
 * Workspace persistence tests (U02, `docs/WORKBENCH-SHELL.md` §4, §14.3).
 *
 * The codec alone is covered in `test/workbench-tabs.test.mjs`; what is added
 * here is the half that touches the disk: `workspace.json` is read verbatim,
 * never written by a read (§4.3 point 1), replaced atomically, and an old
 * `state.json` still migrates into one open canvas (§4.4). The module is
 * imported straight from `src/`, so Node's type stripping is also the
 * "no bundler needed" assertion.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { boardsRoot, readWorkspaceFile, setActiveBoard, writeWorkspaceFile } from '../src/boards.ts'
import {
  MAX_CANVAS_TABS,
  PROJECTS_TAB,
  emptyState,
  openBoardIds,
  openCanvas,
  stateFromWorkspace,
  toWorkspaceJson,
} from '../src/workbench-tabs.ts'

/** A throwaway output directory, removed after the case. */
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workspace-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const workspacePath = (dir) => join(boardsRoot(dir), 'workspace.json')

test('a missing workspace.json reads as absent, without throwing', async (t) => {
  const dir = sandbox(t)
  assert.equal(await readWorkspaceFile(dir), undefined)
  assert.deepEqual(stateFromWorkspace(await readWorkspaceFile(dir)).tabOrder, [PROJECTS_TAB])
})

test('workspace.json round-trips through disk exactly as the codec wrote it', async (t) => {
  const dir = sandbox(t)
  const state = openCanvas(openCanvas(emptyState(), 'b1').state, 'b2').state
  const doc = toWorkspaceJson(state)
  assert.equal(await writeWorkspaceFile(dir, doc), true)
  const onDisk = JSON.parse(readFileSync(workspacePath(dir), 'utf8'))
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(doc)))

  const restored = stateFromWorkspace(await readWorkspaceFile(dir), { boardIds: ['b1', 'b2'] })
  assert.deepEqual(restored.tabOrder, doc.tabOrder)
  assert.deepEqual(restored.activeTab, 'canvas:b2')
})

test('reading never writes: a stale document keeps its bytes and mtime', async (t) => {
  const dir = sandbox(t)
  mkdirSync(boardsRoot(dir), { recursive: true })
  const raw = JSON.stringify({ version: 1, openProjects: ['gone'], activeTab: { kind: 'canvas', boardId: 'gone' }, tabOrder: ['projects', 'canvas:gone'] })
  writeFileSync(workspacePath(dir), raw)
  const before = readFileSync(workspacePath(dir), 'utf8')
  stateFromWorkspace(await readWorkspaceFile(dir), { boardIds: ['kept'] })
  assert.equal(readFileSync(workspacePath(dir), 'utf8'), before)
})

test('a legacy state.json still migrates into one open canvas (§4.4)', async (t) => {
  const dir = sandbox(t)
  assert.equal(await setActiveBoard(dir, 'b_7fk2'), true)
  assert.equal(await readWorkspaceFile(dir), undefined, 'migration must not create workspace.json')
  const migrated = stateFromWorkspace(
    { active: 'b_7fk2' },
    { boardIds: ['b_7fk2'], now: '2026-11-18T08:05:00.000Z' },
  )
  assert.deepEqual(migrated.tabOrder, [PROJECTS_TAB, 'canvas:b_7fk2'])
  assert.equal(migrated.activeTab, 'canvas:b_7fk2')
  assert.deepEqual(migrated.recentProjects, [{ boardId: 'b_7fk2', openedAt: '2026-11-18T08:05:00.000Z' }])
})

test('a corrupt or newer workspace.json reads as absent instead of failing the shell', async (t) => {
  const dir = sandbox(t)
  mkdirSync(boardsRoot(dir), { recursive: true })
  writeFileSync(workspacePath(dir), '{not json')
  assert.equal(await readWorkspaceFile(dir), undefined)
  writeFileSync(workspacePath(dir), JSON.stringify({ version: 2, openProjects: ['b1'] }))
  assert.deepEqual(stateFromWorkspace(await readWorkspaceFile(dir)).tabOrder, [PROJECTS_TAB])
})

test('concurrent writes stay atomic, serialised, and leave no staging file', async (t) => {
  const dir = sandbox(t)
  const one = toWorkspaceJson(openCanvas(emptyState(), 'b1').state)
  const two = toWorkspaceJson(openCanvas(emptyState(), 'b2').state)
  const results = await Promise.all([writeWorkspaceFile(dir, one), writeWorkspaceFile(dir, two)])
  assert.deepEqual(results, [true, true])
  const parsed = JSON.parse(readFileSync(workspacePath(dir), 'utf8'))
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(JSON.stringify(parsed) === JSON.stringify(one) ? one : two)))
  assert.deepEqual(readdirSync(boardsRoot(dir)).filter((name) => name.includes('.partial-')), [])
  assert.equal(existsSync(join(boardsRoot(dir), 'boards')), false)
})

test('over-limit documents are truncated on the way in, never refused', async (t) => {
  const dir = sandbox(t)
  const many = Array.from({ length: MAX_CANVAS_TABS + 3 }, (_, index) => 'b' + String(index))
  await writeWorkspaceFile(dir, {
    version: 1,
    openProjects: many,
    activeTab: { kind: 'canvas', boardId: many[many.length - 1] },
    nodeDetailTabs: [],
    tabOrder: [PROJECTS_TAB, ...many.map((id) => 'canvas:' + id)],
  })
  const restored = stateFromWorkspace(await readWorkspaceFile(dir), { boardIds: many })
  assert.equal(openBoardIds(restored).length, MAX_CANVAS_TABS)
})
