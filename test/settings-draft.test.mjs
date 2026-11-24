import assert from 'node:assert/strict'
import test from 'node:test'
import { SETTINGS_FIELDS } from '../testlib/settings-fields.js'
import {
  commitSettingsDraft,
  dirtySettingsKeys,
  draftFromValues,
  normalizeSettingsDraft,
} from '../testlib/settings-draft.js'

const BASE = {
  comfyEndpoint: 'http://127.0.0.1:8188',
  comfyPorts: '8188,8189',
  comfyModelsDir: 'D:/ComfyUI/models',
  comfyModel: 'qwen21-base',
  defaultSteps: 40,
  comfyuiSteps: undefined,
  turboSteps: undefined,
  mossSampling: 'comfy',
  executionBackend: 'auto',
  comfyMcpBin: '',
  comfyBin: '',
  backendTimeoutMs: undefined,
  mcpDebug: false,
  backendTmpDir: '',
  outputDir: 'D:/pictures',
  timeoutMs: 180000,
}

function fakeForm(initial = BASE, options = {}) {
  let value = { ...initial }
  let revision = options.revision ?? 1
  let failedOnce = false
  const calls = []
  const listeners = new Set()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    calls,
    set(key, next) {
      calls.push({ op: 'set', key, value: next })
      if (options.failKey === key && !failedOnce) { failedOnce = true; return Promise.resolve(false) }
      if (options.failRollbackKey === key && next === initial[key]) return Promise.resolve(false)
      value = { ...value, [key]: next }
      revision += 1
      notify()
      return Promise.resolve(true)
    },
    unset(key) {
      calls.push({ op: 'unset', key })
      if (options.failKey === key && !failedOnce) { failedOnce = true; return Promise.resolve(false) }
      value = { ...value, [key]: undefined }
      revision += 1
      notify()
      return Promise.resolve(true)
    },
    getSnapshot() {
      return { status: 'ready', value, revision, writable: true, mode: 'host' }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

test('the draft mirrors a snapshot and reports only real differences', () => {
  const draft = draftFromValues(SETTINGS_FIELDS, BASE)
  assert.deepEqual(dirtySettingsKeys(SETTINGS_FIELDS, draft, BASE), [])
  draft.comfyEndpoint = { kind: 'value', value: 'http://127.0.0.1:9000' }
  assert.deepEqual(dirtySettingsKeys(SETTINGS_FIELDS, draft, BASE), ['comfyEndpoint'])
  const normalized = normalizeSettingsDraft(SETTINGS_FIELDS, draft, BASE)
  assert.deepEqual(normalized.errors, [])
  assert.deepEqual(normalized.changes.map((change) => change.key), ['comfyEndpoint'])
})

test('validation catches URL, port and enum errors before any write', () => {
  const draft = draftFromValues(SETTINGS_FIELDS, BASE)
  draft.comfyEndpoint = { kind: 'value', value: '127.0.0.1:8188' }
  draft.comfyPorts = { kind: 'value', value: '70000' }
  draft.comfyModel = { kind: 'value', value: 'nope' }
  const normalized = normalizeSettingsDraft(SETTINGS_FIELDS, draft, BASE)
  assert.deepEqual(normalized.errors.map((error) => error.key), ['comfyModel', 'comfyEndpoint', 'comfyPorts'])
  assert.equal(normalized.changes.length, 0)
})

test('blank nullable numbers and explicit reset entries become unset', () => {
  const draft = draftFromValues(SETTINGS_FIELDS, { ...BASE, comfyuiSteps: 20 })
  draft.comfyuiSteps = { kind: 'value', value: '' }
  const normalized = normalizeSettingsDraft(SETTINGS_FIELDS, draft, { ...BASE, comfyuiSteps: 20 })
  assert.equal(normalized.changes.length, 1)
  assert.equal(normalized.changes[0].unset, true)

  const reset = draftFromValues(SETTINGS_FIELDS, BASE)
  reset.defaultSteps = { kind: 'unset' }
  assert.equal(normalizeSettingsDraft(SETTINGS_FIELDS, reset, BASE).changes[0].unset, true)
})

test('a successful batch writes every changed field and reports the new revision', async () => {
  const form = fakeForm()
  const draft = draftFromValues(SETTINGS_FIELDS, BASE)
  draft.comfyEndpoint = { kind: 'value', value: 'http://127.0.0.1:9000' }
  draft.defaultSteps = { kind: 'value', value: '32' }
  const result = await commitSettingsDraft(form, SETTINGS_FIELDS, draft, BASE, 1)
  assert.equal(result.status, 'saved')
  assert.deepEqual(result.changed, ['defaultSteps', 'comfyEndpoint'])
  assert.deepEqual(form.calls.map((call) => call.key), ['defaultSteps', 'comfyEndpoint'])
  assert.equal(result.revision, 3)
})

test('a failed write rolls attempted fields back in reverse order', async () => {
  const form = fakeForm(BASE, { failKey: 'comfyPorts' })
  const draft = draftFromValues(SETTINGS_FIELDS, BASE)
  draft.comfyEndpoint = { kind: 'value', value: 'http://127.0.0.1:9000' }
  draft.comfyPorts = { kind: 'value', value: '9000' }
  const result = await commitSettingsDraft(form, SETTINGS_FIELDS, draft, BASE, 1)
  assert.equal(result.status, 'rolled-back')
  assert.equal(result.failedKey, 'comfyPorts')
  assert.deepEqual(form.calls.map((call) => `${call.op}:${call.key}`), [
    'set:comfyEndpoint',
    'set:comfyPorts',
    'set:comfyPorts',
    'set:comfyEndpoint',
  ])
  assert.equal(form.calls.at(-1).value, BASE.comfyEndpoint)
})

test('a failed rollback is surfaced with the exact fields', async () => {
  const form = fakeForm(BASE, { failKey: 'comfyPorts', failRollbackKey: 'comfyEndpoint' })
  const draft = draftFromValues(SETTINGS_FIELDS, BASE)
  draft.comfyEndpoint = { kind: 'value', value: 'http://127.0.0.1:9000' }
  draft.comfyPorts = { kind: 'value', value: '9000' }
  const result = await commitSettingsDraft(form, SETTINGS_FIELDS, draft, BASE, 1)
  assert.equal(result.status, 'rollback-partial')
  assert.deepEqual(result.rollbackFailed, ['comfyEndpoint'])
})

test('an external revision change blocks the batch before writing', async () => {
  const form = fakeForm(BASE, { revision: 2 })
  const draft = draftFromValues(SETTINGS_FIELDS, BASE)
  draft.outputDir = { kind: 'value', value: 'D:/new' }
  const result = await commitSettingsDraft(form, SETTINGS_FIELDS, draft, BASE, 1)
  assert.equal(result.status, 'conflict')
  assert.equal(form.calls.length, 0)
})
