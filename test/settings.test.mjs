/**
 * The settings section's contract: registration shape, the describe → read →
 * write round trip with its revision fence, secret redaction, and the guard that
 * keeps the page's field table in step with the plugin's own config schema.
 *
 * This file deliberately imports the **logic** bundles under `testlib/` rather
 * than `lib/client.js`: the client entry imports `react`, which is a bare
 * specifier the web client resolves and which is not a dependency of this
 * package, so it cannot be loaded here. The parts of the client entry that
 * cannot be executed are asserted against its built source text instead, and
 * that limitation is stated where it is used rather than papered over.
 *
 * `testlib/` and `lib/` are produced by the same `pnpm build`; see
 * `tsdown.config.ts` for why the logic modules are a separate build rather than
 * extra entries of the production one (a production client bundle must stay
 * self-contained).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../lib/index.js'
import {
  createResolvedEntryForm,
  mutateFields,
  reachConfigForms,
  registerSettingsSection,
  saveField,
  SETTINGS_ENTRY_IDS,
  SETTINGS_SECTION_ID,
  SETTINGS_SECTION_LABEL,
  SETTINGS_SECTION_NAME,
  SETTINGS_SECTION_ORDER,
  settingsSectionOptions,
} from '../testlib/settings-section.js'
import {
  isConfigRef,
  readConfigField,
  resolveConfigFields,
  schemaDefaults,
  unwrapConfigFields,
} from '../testlib/config-resolve.js'
import {
  BACKEND_PERF_ADVISORY,
  SECRET_MASK,
  SETTINGS_FIELDS,
  SETTINGS_FIELD_KEYS,
  SETTINGS_GROUPS,
  advisoryText,
  displayValue,
  fieldByKey,
  groupedFields,
  hintHasPath,
  isSecretField,
  missingFieldKeys,
  redactForLog,
  resolveHint,
  RUNTIME_DIR_TOKEN,
  staleFieldKeys,
} from '../testlib/settings-fields.js'

/** The built client bundle, as text — the only view of it this sandbox can get. */
const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/** A plaintext that must never surface in any display string or message. */
const PLAINTEXT_KEY = 'sk-live-DO-NOT-LEAK-0123456789abcdef'

// ---------------------------------------------------------------------------
// Fakes for the Host-provided services.
// ---------------------------------------------------------------------------

/** A fake `ctx.slots` that records the registration instead of seating it. */
function fakeSlots() {
  const events = []
  return {
    events,
    slots: {
      inject(name, register) {
        events.push({ kind: 'inject', name, register })
      },
      register(options, component) {
        events.push({ kind: 'register', options, component })
        return () => {
          events.push({ kind: 'dispose' })
        }
      },
    },
  }
}

/** A fake shared config form for one profile entry. */
function fakeForm(options = {}) {
  const calls = []
  const listeners = new Set()
  let snapshot = {
    status: 'ready',
    value: options.value ?? {},
    revision: options.revision ?? 1,
    writable: options.writable ?? true,
    mode: 'host',
  }
  const form = {
    calls,
    /** Publish a new snapshot to subscribers, as the Host would. */
    publish(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of [...listeners]) listener()
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async set(field, value) {
      calls.push({ op: 'set', field, value })
      if (options.onSet !== undefined) return options.onSet(field, value, form)
      form.publish({ value: { ...snapshot.value, [field]: value } })
      return true
    },
    async unset(field) {
      calls.push({ op: 'unset', field })
      return true
    },
  }
  if (options.withMutate === true) {
    form.mutate = async (ops, revision) => {
      calls.push({ op: 'mutate', ops, revision })
      if (options.onMutate !== undefined) return options.onMutate(ops, revision, form)
      return true
    }
  }
  return form
}

/** A fake `ctx.configForms`: a describe mirror plus a per-entry form table. */
function fakeForms(entryIds = []) {
  const gets = []
  const table = new Map()
  let mirror = { view: { namespaces: entryIds.map((ns) => ({ ns })) } }
  const listeners = new Set()
  const forms = {
    gets,
    table,
    /** Republish the describe mirror, as the Host would once it answers. */
    publishMirror(namespaces) {
      mirror = { view: { namespaces: namespaces.map((ns) => ({ ns })) } }
      for (const listener of [...listeners]) listener()
    },
    describe: () => ({
      getSnapshot: () => mirror,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }),
    get(entryId) {
      gets.push(entryId)
      if (!table.has(entryId)) throw new Error(`No configurable plugin entry "${entryId}"`)
      return table.get(entryId)
    },
  }
  return forms
}

// ---------------------------------------------------------------------------
// Registration shape.
// ---------------------------------------------------------------------------

test('the section registers into the settings.section LIST slot under this plugin id', () => {
  const { slots, events } = fakeSlots()
  const Component = function FakeSection() {
    return null
  }
  registerSettingsSection({ slots }, Component)

  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'inject')
  assert.equal(events[0].name, 'settings.section')
  assert.equal(typeof events[0].register, 'function')

  const dispose = events[0].register()
  assert.equal(events.length, 2)
  const { options, component } = events[1]
  console.log('seated settings section descriptor:', JSON.stringify({
    name: options.name,
    id: options.id,
    order: options.order,
    label: options.label(),
    hasInject: typeof options.inject,
    key: options.key,
  }))

  assert.equal(options.name, SETTINGS_SECTION_NAME)
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, SETTINGS_SECTION_ID)
  assert.equal(options.id, 'dsh-image-forge')
  assert.equal(options.order, SETTINGS_SECTION_ORDER)
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), SETTINGS_SECTION_LABEL)
  assert.equal(component, Component, 'the component must be seated as given')
  assert.equal(typeof options.inject, 'function')
  // `settings.section` is a LIST slot: it is addressed by `id`, and adding a
  // `key` would make the loader treat it as a keyed seat.
  assert.equal(options.key, undefined)

  // The disposer the slot's `inject` body returns must release the seat.
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(events.at(-1).kind, 'dispose')
})

test('with no configForms service the section props explain why, and never throw', () => {
  const { slots, events } = fakeSlots()
  registerSettingsSection({ slots }, function FakeSection() {
    return null
  })
  events[0].register()
  const props = events[1].options.inject()
  console.log('props without a forms service:', JSON.stringify(props))
  assert.equal(props.form, undefined)
  assert.match(props.unavailableReason, /configForms/)

  // A context whose `get` throws must degrade the same way, not propagate.
  const throwing = { slots, get() { throw new Error('no such service') } }
  const second = fakeSlots()
  registerSettingsSection({ slots: second.slots, get: throwing.get }, function FakeSection() {
    return null
  })
  second.events[0].register()
  assert.equal(second.events[1].options.inject().form, undefined)
})

test('with a configForms service the section props carry the bound form', () => {
  const forms = fakeForms(['dsh-image-forge'])
  forms.table.set('dsh-image-forge', fakeForm({ value: { backend: 'auto' }, revision: 3 }))
  const { slots, events } = fakeSlots()
  registerSettingsSection({ slots, get: (name) => (name === 'configForms' ? forms : undefined) }, function FakeSection() {
    return null
  })
  events[0].register()
  const props = events[1].options.inject()
  assert.ok(props.form !== undefined, 'the form must be bound')
  assert.equal(props.unavailableReason, undefined)
  assert.equal(props.form.getSnapshot().revision, 3)
  assert.deepEqual(forms.gets, ['dsh-image-forge'])
})

test('reachConfigForms accepts only an object that really serves the two calls', () => {
  assert.equal(reachConfigForms({ slots: {}, get: () => undefined }), undefined)
  assert.equal(reachConfigForms({ slots: {}, get: () => ({ describe: () => {} }) }), undefined)
  assert.equal(reachConfigForms({ slots: {} }), undefined)
  const good = { describe: () => ({}), get: () => ({}) }
  assert.equal(reachConfigForms({ slots: {}, get: () => good }), good)
})

test('settingsSectionOptions is the descriptor the client entry seats', () => {
  const props = () => ({ form: undefined })
  const options = settingsSectionOptions(props)
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'dsh-image-forge')
  assert.equal(options.inject, props)
  assert.equal(options.label(), SETTINGS_SECTION_LABEL)
})

// ---------------------------------------------------------------------------
// Entry-id resolution.
// ---------------------------------------------------------------------------

test('the form binds the entry id the describe mirror justifies, and rebinds when it changes', () => {
  const forms = fakeForms([])
  const fallback = fakeForm({ revision: 1 })
  const aggregate = fakeForm({ revision: 2 })
  forms.table.set('dsh-image-forge', fallback)
  forms.table.set('web-ui-image-forge', aggregate)

  const form = createResolvedEntryForm({ forms, entryIds: ['dsh-image-forge', 'web-ui-image-forge'] })
  // An unanswered mirror is not evidence of absence: the first candidate wins.
  assert.equal(form.boundEntryId(), 'dsh-image-forge')
  assert.equal(form.getSnapshot().revision, 1)

  forms.publishMirror(['web-ui-image-forge'])
  console.log('bound entry id after the mirror answered:', form.boundEntryId())
  assert.equal(form.boundEntryId(), 'web-ui-image-forge')
  assert.equal(form.getSnapshot().revision, 2)

  // A mirror that names none of ours leaves the namespace id.
  forms.publishMirror(['something-else'])
  assert.equal(form.boundEntryId(), 'web-ui-image-forge')
})

test('an unbound form still answers every call instead of throwing', async () => {
  const forms = fakeForms([])
  const form = createResolvedEntryForm({ forms, entryIds: ['nope'] })
  assert.equal(form.boundEntryId(), undefined)
  assert.equal(form.getSnapshot().status, 'loading')
  assert.equal(await form.set('backend', 'api'), false)
  assert.equal(await form.unset('backend'), false)
  assert.equal(await saveField(form, 'backend', 'api').then((outcome) => outcome.ok), false)
})

test('createResolvedEntryForm needs both a service and at least one candidate id', () => {
  assert.equal(createResolvedEntryForm({ forms: undefined, entryIds: ['x'] }), undefined)
  assert.equal(createResolvedEntryForm({ forms: fakeForms([]), entryIds: [] }), undefined)
  assert.deepEqual(SETTINGS_ENTRY_IDS, ['dsh-image-forge'])
})

// ---------------------------------------------------------------------------
// The write round trip.
// ---------------------------------------------------------------------------

test('a successful write goes through the bound form with the field and value', async () => {
  const inner = fakeForm({ value: { timeoutMs: 180000 }, revision: 7 })
  const forms = fakeForms(['dsh-image-forge'])
  forms.table.set('dsh-image-forge', inner)
  const form = createResolvedEntryForm({ forms, entryIds: SETTINGS_ENTRY_IDS })

  const outcome = await saveField(form, 'timeoutMs', 240000)
  console.log('write calls:', JSON.stringify(inner.calls), 'outcome:', JSON.stringify(outcome))
  assert.deepEqual(inner.calls, [{ op: 'set', field: 'timeoutMs', value: 240000 }])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.revision, 7)
  assert.equal(inner.getSnapshot().value.timeoutMs, 240000)
})

test('clearing a field goes through unset', async () => {
  const inner = fakeForm({ value: { modelsDir: '/x' } })
  const form = createResolvedEntryForm({ forms: fakeForms(['dsh-image-forge']), entryIds: SETTINGS_ENTRY_IDS })
  form.rebind()
  const outcome = await saveField(form, 'modelsDir', undefined)
  assert.deepEqual(inner.calls, [], 'the unbound form is the only one this fake served')
  assert.equal(outcome.ok, false)
})

test('clearing a bound field goes through the bound form\'s unset', async () => {
  const inner = fakeForm({ value: { modelsDir: '/x' } })
  const forms = fakeForms(['dsh-image-forge'])
  forms.table.set('dsh-image-forge', inner)
  const form = createResolvedEntryForm({ forms, entryIds: SETTINGS_ENTRY_IDS })
  const outcome = await saveField(form, 'modelsDir', undefined)
  console.log('unset calls:', JSON.stringify(inner.calls))
  assert.deepEqual(inner.calls, [{ op: 'unset', field: 'modelsDir' }])
  assert.equal(outcome.ok, true)
})

test('a write against an unwritable entry is refused before anything is sent', async () => {
  const inner = fakeForm({ writable: false })
  const outcome = await saveField(inner, 'backend', 'api')
  console.log('unwritable outcome:', JSON.stringify(outcome))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'unwritable')
  assert.deepEqual(inner.calls, [], 'an unwritable entry must not be written to at all')
})

test('a revision that moved under us is reported as a conflict, and re-read rather than overwritten', async () => {
  // Somebody else committed between our read and our write: the Host refuses and
  // the revision it now serves has moved on.
  const inner = fakeForm({
    revision: 7,
    onSet: (_field, _value, form) => {
      form.publish({ revision: 9 })
      return false
    },
  })
  const outcome = await saveField(inner, 'backend', 'local')
  console.log('conflict outcome:', JSON.stringify(outcome))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'conflict')
  assert.equal(outcome.expectedRevision, 7)
  assert.equal(outcome.observedRevision, 9)
  assert.match(outcome.message, /别处已被修改/)
  assert.match(outcome.message, /7/)
  assert.match(outcome.message, /9/)
  // The stale value must not be re-issued over the other edit.
  assert.equal(inner.calls.filter((call) => call.op === 'set').length, 1)
})

test('a refusal that did not move the revision is reported as a plain refusal', async () => {
  const inner = fakeForm({ revision: 4, onSet: () => false })
  const outcome = await saveField(inner, 'backend', 'local')
  console.log('refusal outcome:', JSON.stringify(outcome))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'refused')
  assert.equal(outcome.expectedRevision, 4)
  assert.match(outcome.message, /宿主拒绝了这次写入/)
})

test('a rejecting transport is surfaced, never swallowed', async () => {
  const inner = fakeForm({
    onSet: () => {
      throw new Error('transport down')
    },
  })
  const outcome = await saveField(inner, 'backend', 'local')
  console.log('transport failure outcome:', JSON.stringify(outcome))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'error')
  assert.match(outcome.message, /transport down/)
})

test('a form whose set throws synchronously is reported too', async () => {
  const inner = fakeForm()
  inner.set = () => {
    throw new Error('sync boom')
  }
  const outcome = await saveField(inner, 'backend', 'local')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'error')
  assert.match(outcome.message, /sync boom/)
})

test('mutateFields passes the caller-read revision straight through', async () => {
  const inner = fakeForm({ revision: 11, withMutate: true })
  const ops = [{ some: 'adapter-owned-op' }]
  const outcome = await mutateFields(inner, ops, 11)
  console.log('mutate calls:', JSON.stringify(inner.calls))
  assert.deepEqual(inner.calls, [{ op: 'mutate', ops, revision: 11 }])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.revision, 11)
})

test('mutateFields reports a rejected fenced write with both revisions', async () => {
  const inner = fakeForm({
    revision: 3,
    withMutate: true,
    onMutate: (_ops, _revision, form) => {
      form.publish({ revision: 8 })
      return false
    },
  })
  const outcome = await mutateFields(inner, [], 3)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'conflict')
  assert.equal(outcome.expectedRevision, 3)
  assert.equal(outcome.observedRevision, 8)
})

test('mutateFields says so when the adapter has no fenced write', async () => {
  const outcome = await mutateFields(fakeForm(), [], 1)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'error')
  assert.match(outcome.message, /mutate/)
})

// ---------------------------------------------------------------------------
// Secret handling.
// ---------------------------------------------------------------------------

test('apiKey is a secret field and never renders its plaintext', () => {
  assert.equal(isSecretField('apiKey'), true)
  assert.equal(fieldByKey('apiKey').kind, 'secret')
  // A non-secret must still render verbatim, or the masking is meaningless.
  assert.equal(isSecretField('apiModel'), false)
  assert.equal(displayValue('apiModel', 'qwen-image'), 'qwen-image')

  const shown = displayValue('apiKey', PLAINTEXT_KEY)
  console.log('apiKey display value:', JSON.stringify(shown))
  assert.equal(shown, SECRET_MASK)
  assert.ok(!shown.includes(PLAINTEXT_KEY), 'the display value must not contain the key')
  assert.ok(!shown.includes('sk-live'), 'the display value must not even leak the prefix')
  assert.equal(displayValue('apiKey', ''), '', 'an unset secret shows as unset, not as a mask')
})

test('no save failure for apiKey can carry the key it failed to write', async () => {
  const cases = [
    fakeForm({ writable: false }),
    fakeForm({ onSet: () => false }),
    fakeForm({
      onSet: () => {
        throw new Error('write rejected')
      },
    }),
  ]
  for (const inner of cases) {
    const outcome = await saveField(inner, 'apiKey', PLAINTEXT_KEY)
    assert.equal(outcome.ok, false)
    const text = JSON.stringify(outcome)
    console.log('apiKey failure text:', text)
    assert.ok(!text.includes(PLAINTEXT_KEY), `the failure text leaked the key: ${text}`)
  }
})

test('redactForLog masks a secret and keeps ordinary values readable', () => {
  assert.equal(redactForLog('apiKey', PLAINTEXT_KEY), SECRET_MASK)
  assert.equal(redactForLog('apiKey', ''), '（空）')
  assert.ok(!redactForLog('apiKey', PLAINTEXT_KEY).includes(PLAINTEXT_KEY))
  assert.equal(redactForLog('apiModel', 'qwen-image'), 'qwen-image')
  assert.equal(redactForLog('manageWorker', true), '开')
  assert.equal(redactForLog('manageWorker', false), '关')
  assert.equal(redactForLog('timeoutMs', 180000), '180000')
})

// ---------------------------------------------------------------------------
// Reading config back out of the volatile shape.
// ---------------------------------------------------------------------------

test('a volatile reference and a plain value are told apart, and both resolve', () => {
  assert.equal(isConfigRef({ get: () => 1 }), true)
  assert.equal(isConfigRef({ get: 'not a function' }), false)
  assert.equal(isConfigRef({ value: 1 }), false)
  assert.equal(isConfigRef(null), false)
  assert.equal(isConfigRef('plain'), false)
  assert.equal(isConfigRef(0), false)

  assert.equal(readConfigField({ get: () => 'ref-value' }), 'ref-value')
  assert.equal(readConfigField('plain-value'), 'plain-value')
  assert.equal(readConfigField(false), false)
  assert.equal(readConfigField(''), '')
  assert.equal(readConfigField(undefined), undefined)
  // A reference whose owner is torn down reads as absent rather than throwing.
  assert.equal(
    readConfigField({
      get() {
        throw new Error('owner gone')
      },
    }),
    undefined,
  )
})

test('unwrapConfigFields turns a mixed object into plain data', () => {
  const unwrapped = unwrapConfigFields({
    fromRef: { get: () => 7 },
    plain: 'text',
    falsy: false,
    empty: '',
    absent: { get: () => undefined },
  })
  console.log('unwrapped:', JSON.stringify(unwrapped))
  assert.deepEqual(unwrapped, { fromRef: 7, plain: 'text', falsy: false, empty: '' })
  assert.equal('absent' in unwrapped, false)
  assert.deepEqual(unwrapConfigFields(undefined), {})
})

test('resolving over the defaults keeps falsy values instead of falling back', () => {
  const defaults = { manageWorker: true, timeoutMs: 180000, apiKey: 'default-key', backend: 'auto' }
  const resolved = resolveConfigFields(defaults, {
    manageWorker: { get: () => false },
    timeoutMs: { get: () => 1000 },
    apiKey: { get: () => '' },
    // `backend` is left out entirely and must keep its default.
  })
  console.log('resolved over defaults:', JSON.stringify(resolved))
  assert.equal(resolved.manageWorker, false, 'an explicit false must not fall back to the default')
  assert.equal(resolved.timeoutMs, 1000)
  assert.equal(resolved.apiKey, '', 'an explicit empty string must not fall back to the default')
  assert.equal(resolved.backend, 'auto', 'a missing field keeps its default')

  // A reference carrying undefined is an absent field, not an override.
  assert.equal(resolveConfigFields({ timeoutMs: 5 }, { timeoutMs: { get: () => undefined } }).timeoutMs, 5)
  // No config at all resolves to the defaults.
  assert.deepEqual(resolveConfigFields(defaults, undefined), defaults)
})

test('the real schema defaults survive a resolve round trip as plain data', () => {
  const resolved = resolveConfigFields(schemaDefaults(plugin.Config({})), plugin.Config({}))
  const kinds = new Set(Object.values(resolved).filter((value) => value !== undefined).map((value) => typeof value))
  console.log('resolved value types:', JSON.stringify([...kinds]))
  assert.deepEqual([...kinds].sort(), ['boolean', 'number', 'string'])
  assert.equal(resolved.backend, 'auto')
  assert.equal(resolved.manageWorker, true)
  assert.equal(resolved.apiStyle, 'openai')
  assert.equal(resolved.timeoutMs, 180000)
  assert.equal(resolved.defaultSteps, 25)
  // The two overrides are declared-but-unset, which is a real state: the key
  // exists and its value is undefined, so the resolver falls through.
  assert.equal(Object.keys(resolved).length, 33)
  assert.ok('comfyuiSteps' in resolved, 'a nullable field must keep its key')
  assert.equal(resolved.comfyuiSteps, undefined)
  assert.equal(resolved.localSteps, undefined)
  // The local-edit size gate's opt-in is off unless a user turns it on.
  assert.equal(resolved.allowLocalEditOverBudget, false)
})

// ---------------------------------------------------------------------------
// Field coverage: the guard against a schema field shipping without a control.
// ---------------------------------------------------------------------------

/** The config keys the plugin's own schema declares. */
function schemaKeys() {
  return Object.keys(plugin.Config({}))
}

test('every field in the config schema has a control on the settings page', () => {
  const declared = schemaKeys()
  const missing = missingFieldKeys(declared)
  const stale = staleFieldKeys(declared)
  console.log('schema fields:', declared.length, JSON.stringify(declared))
  console.log('page controls:', SETTINGS_FIELD_KEYS.length)
  console.log('missing from the page:', JSON.stringify(missing))
  console.log('stale on the page:', JSON.stringify(stale))
  assert.deepEqual(missing, [], 'these config fields have no control on the settings page')
  assert.deepEqual(stale, [], 'the settings page renders controls for fields the schema does not declare')
  assert.equal(SETTINGS_FIELD_KEYS.length, declared.length)
  assert.equal(declared.length, 33, 'the documented field count')
  // The newest additions are named so a regression that drops one is diagnosable
  // rather than just a count mismatch.
  for (const key of ['defaultSteps', 'comfyuiSteps', 'localSteps', 'allowLocalEditOverBudget', 'localReferenceBudget']) {
    assert.ok(declared.includes(key), `${key} must be a schema field`)
    assert.ok(SETTINGS_FIELD_KEYS.includes(key), `${key} must have a control`)
  }
})

test('the local-edit size gate has a control that says what it overrides', () => {
  const byKey = Object.fromEntries(SETTINGS_FIELDS.map((field) => [field.key, field]))
  const field = byKey.allowLocalEditOverBudget
  console.log('allowLocalEditOverBudget control:', JSON.stringify(field))
  assert.equal(field.group, 'local')
  assert.equal(field.kind, 'boolean')
  // The control is only honest if the page says the default is a refusal, because
  // the failure it opts out of is not the VRAM-gate one the neighbouring control
  // explains.
  assert.match(field.hint, /拒绝/)
  assert.match(field.hint, /风险/)
  assert.equal(byKey.minFreeVramMiB.kind, 'number')
  assert.match(byKey.minFreeVramMiB.hint, /加载期门禁/)
  assert.match(byKey.minFreeVramMiB.hint, /不是编辑尺寸门/)
})

test('the reference-budget control states its default, its effect and its unmeasured cost', () => {
  const byKey = Object.fromEntries(SETTINGS_FIELDS.map((field) => [field.key, field]))
  const field = byKey.localReferenceBudget
  console.log('localReferenceBudget control:', JSON.stringify(field))
  assert.equal(field.group, 'local')
  assert.equal(field.kind, 'number')
  // 0 has to read as "derive from the canvas", not as a zero-pixel budget.
  assert.equal(field.min, 0)
  assert.match(field.hint, /0=按画布推导/)
  assert.match(field.hint, /降参考图分辨率/)
  // The fidelity side is a 1-image, 1-judge comparison (`docs/evidence/r5-budget-canvas-matrix.md`): the page states
  // that shape, and must not present it as a measurement or as blanket "unmeasured".
  assert.match(field.hint, /目视无差/)
  assert.match(field.hint, /n=1/)
  assert.ok(!field.hint.includes('未测'), 'the withdrawn blanket fidelity claim is back')
  // The schema agrees with the control about what "unset" is.
  assert.equal(plugin.Config({}).localReferenceBudget.get(), 0)
})

test('the step controls state the tradeoff and mark the two overrides nullable', () => {
  const byKey = Object.fromEntries(SETTINGS_FIELDS.map((field) => [field.key, field]))
  console.log('step hints:', JSON.stringify({
    defaultSteps: byKey.defaultSteps.hint,
    comfyuiSteps: byKey.comfyuiSteps.hint,
    localSteps: byKey.localSteps.hint,
  }, null, 2))
  assert.equal(byKey.defaultSteps.group, 'steps')
  assert.equal(byKey.defaultSteps.kind, 'number')
  assert.equal(byKey.defaultSteps.nullable, undefined, 'the shared default is not nullable')
  for (const key of ['comfyuiSteps', 'localSteps']) {
    assert.equal(byKey[key].group, 'steps')
    assert.equal(byKey[key].kind, 'number')
    assert.equal(byKey[key].nullable, true, `${key} must be clearable back to unset`)
    assert.equal(byKey[key].min, 1)
  }
  // The tradeoff has to be on the page, not only in the shipped prose: the slow-but-
  // official option and the fast-but-unofficial one must both be spelled out.
  assert.match(byKey.localSteps.hint, /2\.7/)
  assert.match(byKey.localSteps.hint, /25/)
  assert.match(byKey.localSteps.hint, /8/)
})

test('the config keys really are volatile references, and resolve back to plain data', () => {
  const resolved = plugin.Config({})
  const refs = Object.entries(resolved).filter(([, value]) => typeof value?.get === 'function')
  console.log('volatile reference count:', refs.length, 'of', Object.keys(resolved).length)
  assert.equal(refs.length, Object.keys(resolved).length, 'every field must be volatile for the Host to serve a form')
  assert.equal(resolved.backend.get(), 'auto')
  assert.equal(resolved.timeoutMs.get(), 180000)
})

test('the section groups every field exactly once and every group is non-empty', () => {
  const buckets = groupedFields()
  const seen = buckets.flatMap(({ fields }) => fields.map((field) => field.key))
  assert.deepEqual([...seen].sort(), [...SETTINGS_FIELD_KEYS].sort())
  assert.equal(new Set(seen).size, seen.length, 'a field must not appear in two groups')
  const groupIds = SETTINGS_GROUPS.map((group) => group.id)
  for (const { group, fields } of buckets) {
    assert.ok(groupIds.includes(group.id))
    assert.ok(fields.length > 0, `group ${group.id} is empty`)
    assert.ok(group.label.length > 0 && group.hint.length > 0)
  }
  console.log('groups:', JSON.stringify(buckets.map(({ group, fields }) => `${group.label}=${fields.length}`)))
})

test('every control carries a usable label, hint and kind-appropriate limits', () => {
  for (const field of SETTINGS_FIELDS) {
    assert.ok(field.label.length > 0, `${field.key} has no label`)
    assert.ok(field.hint.length > 0, `${field.key} has no hint`)
    assert.ok(
      ['enum', 'string', 'secret', 'path', 'number', 'boolean'].includes(field.kind),
      `${field.key} has an unknown kind ${field.kind}`,
    )
    if (field.kind === 'enum') {
      assert.ok((field.choices ?? []).length > 0, `${field.key} is an enum with no choices`)
    }
    if (field.kind === 'number') {
      assert.equal(typeof field.min, 'number', `${field.key} has no lower bound`)
      assert.equal(typeof field.max, 'number', `${field.key} has no upper bound`)
      assert.ok(field.min < field.max, `${field.key} has an inverted range`)
    }
  }
})

test('every enum control offers the value its schema field defaults to', () => {
  const resolved = plugin.Config({})
  for (const field of SETTINGS_FIELDS.filter((candidate) => candidate.kind === 'enum')) {
    const node = resolved[field.key]
    // A union schema's accepted set is what the page must offer; read it off the
    // schema rather than trusting the copy in the table.
    const accepted = node?.get !== undefined ? node.get() : node
    const offered = field.choices.map((choice) => choice.value)
    console.log(`${field.key}: schema=${JSON.stringify(accepted)} page=${JSON.stringify(offered)}`)
    assert.ok(offered.includes(accepted), `${field.key} must offer its own default`)
  }
})

// ---------------------------------------------------------------------------
// The sampler-step policy.
// ---------------------------------------------------------------------------

test('resolveSteps follows explicit > backend override > default', async () => {
  const { resolveSteps } = await import('../testlib/tools.js')
  /** A settings stub carrying only the three fields the resolver reads. */
  const withSteps = (defaultSteps, comfyuiSteps, localSteps) => ({ defaultSteps, comfyuiSteps, localSteps })

  const cases = [
    // label, explicit, backend, settings, expected
    ['explicit beats everything (comfyui)', 12, 'comfyui', withSteps(25, 30, 8), { steps: 12, source: 'explicit' }],
    ['explicit beats everything (local)', 6, 'local', withSteps(25, 30, 8), { steps: 6, source: 'explicit' }],
    ['explicit beats everything (api)', 20, 'api', withSteps(25, 30, 8), { steps: 20, source: 'explicit' }],
    ['comfyui takes its own override', undefined, 'comfyui', withSteps(25, 30, 8), { steps: 30, source: 'backend' }],
    ['local takes its own override', undefined, 'local', withSteps(25, 30, 8), { steps: 8, source: 'backend' }],
    ['api has no override, so it falls through', undefined, 'api', withSteps(25, 30, 8), { steps: 25, source: 'default' }],
    ['an unset comfyui override falls through', undefined, 'comfyui', withSteps(25, undefined, 8), { steps: 25, source: 'default' }],
    ['an unset local override falls through', undefined, 'local', withSteps(25, 30, undefined), { steps: 25, source: 'default' }],
    ['the shipped defaults resolve to 25', undefined, 'local', withSteps(25, undefined, undefined), { steps: 25, source: 'default' }],
    ['a non-positive override is ignored', undefined, 'local', withSteps(25, undefined, 0), { steps: 25, source: 'default' }],
  ]
  for (const [label, explicit, backend, settings, expected] of cases) {
    const actual = resolveSteps(explicit, backend, settings)
    console.log(`${label}: ${JSON.stringify(actual)}`)
    assert.deepEqual(actual, expected, label)
  }
})

test('the resolved step count is what reaches each backend, and the result says so', () => {
  // `resolveSteps` is unit-tested above; this asserts the *wiring* is present in
  // the bundle the Host loads. Whether "no explicit steps" really puts 25 on the
  // wire is not covered by a test here — the e2e harnesses that could observe it
  // (api-e2e / comfyui-e2e / worker-lifecycle) exercise the explicit path, and
  // they do assert those explicit values (20 / 12 / 8) arrive unchanged.
  const source = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  for (const needle of ['steps_used', 'steps_source', 'resolveSteps', 'comfyuiSteps', 'localSteps', 'defaultSteps']) {
    assert.match(source, new RegExp(needle), `${needle} must be present in the host bundle`)
  }
  // Every dispatch site must pass a resolved count rather than the raw request.
  // Anchored on `await` so the callee's own definition — whose first parameter
  // is also named `request` — cannot produce a false positive.
  const rawSites = [
    /await generateWithWorker\(runtime, request,/,
    /await generateViaComfyUi\(target, models, request,/,
    /await generateViaComfyUiEdit\(target, models, request,/,
    /await generateViaApi\(apiSettings, request,/,
  ]
  for (const pattern of rawSites) {
    assert.ok(!pattern.test(source), `a dispatch site still passes the unresolved request: ${pattern}`)
  }
  // And the positive half: every dispatch site carries a resolved count. The
  // bundle wraps these object literals across lines, so this counts the markers
  // rather than trying to match one line.
  const resolved = source.match(/resolveSteps\(steps, "/g) ?? []
  const forwarded = source.match(/steps: usedSteps\.steps/g) ?? []
  console.log('resolveSteps call sites:', resolved.length, '/ resolved-count forwards:', forwarded.length)
  assert.equal(resolved.length, 7, 'all seven dispatch sites (api/local/comfyui + fallbacks, generate + edit) must resolve')
  assert.equal(forwarded.length, 7, 'each dispatch site must forward the resolved count, not the raw request')
})

// ---------------------------------------------------------------------------
// The backend performance advisory: two lines on the page, the evidence in the
// shipped prose (README + `docs/`). Both halves are asserted, so neither can
// quietly become the other.
// ---------------------------------------------------------------------------

/** Every string the advisory renders. */
const ADVISORY_TEXT = advisoryText(BACKEND_PERF_ADVISORY)

/**
 * The shipped prose surface, which is where the advisory's evidence now lives.
 *
 * That surface used to be the README alone, which is why the binding below keeps
 * its old name. The 734-line README was split into a quick-reference page plus
 * `docs/*.md`, and the argument moved into those documents — so reading the
 * README by itself would assert against a surface that no longer carries the
 * evidence. `docs/` is *listed* rather than enumerated here: a new document is
 * picked up without editing this test.
 */
const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url))
const README_SOURCE = [
  readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8'),
  ...readdirSync(DOCS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => readFileSync(join(DOCS_DIR, name), 'utf8')),
].join('\n')

test('the advisory states the conclusion and the numbers, in two lines', () => {
  console.log('--- advisory as rendered ---\n' + ADVISORY_TEXT + '\n--- end ---')
  assert.equal(BACKEND_PERF_ADVISORY.id, 'backend-perf')
  assert.equal(BACKEND_PERF_ADVISORY.placedAfterGroup, 'backend')
  // The recommendation the user asked to keep on the page.
  assert.match(BACKEND_PERF_ADVISORY.title, /8 GB/)
  assert.match(BACKEND_PERF_ADVISORY.title, /参考图编辑/)
  assert.match(BACKEND_PERF_ADVISORY.title, /comfyui/)
  assert.equal(BACKEND_PERF_ADVISORY.paragraphs.length, 2, 'two lines, not a page of evidence')
  // The headline numbers, and the one caveat that stops 2.77x being misread.
  assert.match(ADVISORY_TEXT, /19–23 s/)
  assert.match(ADVISORY_TEXT, /219 s/)
  assert.match(ADVISORY_TEXT, /2\.77×/)
  assert.match(ADVISORY_TEXT, /量化档不同/)
  assert.match(ADVISORY_TEXT, /不是纯后端差异/)
  // And it must tell the reader where the reasoning went.
  assert.match(ADVISORY_TEXT, /README/)
})

test('the advisory and every hint stay inside their text budget', () => {
  // The budget exists because the first live review of the page was that it
  // "exposes a great deal of explanatory text that does not belong in front of a
  // user". These numbers are the contract: the page gives the conclusion, the
  // shipped prose (README + `docs/`) gives the argument, and growing past these
  // limits fails here.
  const MAX_FIELD_HINT = 40
  // Paths are *information*, not prose: a hint that names where a file will
  // actually land cannot be squeezed into 40 characters without dropping the path,
  // which is the one thing that makes those two fields legible. Hints containing a
  // path separator therefore get their own, larger ceiling.
  const MAX_FIELD_HINT_PATHED = 110
  const MAX_GROUP_HINT = 20
  const MAX_ADVISORY = 400
  // Raised twice, each time by exactly what the new control costs, so the slack the
  // earlier fields left is untouched: `allowLocalEditOverBudget` (the opt-out from a
  // measured hard failure) cost 34 characters, and `localReferenceBudget` (the knob
  // that is what makes a 1.5 MP canvas runnable at all) cost 34 more. `docs/evidence/r5-budget-canvas-matrix.md` then
  // replaced that hint's blanket "unmeasured fidelity cost" with the shape of the
  // measurement it has (512 vs 896 on one canvas, n=1): +14 characters, and the
  // phrase does not fit in the 40-character hint budget in full — the argument lives
  // in the shipped prose and the tool text.
  const MAX_FIELD_TOTAL = 1264
  const MAX_GROUP_TOTAL = 150

  const longestField = SETTINGS_FIELDS.reduce(
    (worst, field) => (field.hint.length > worst.hint.length ? field : worst),
    SETTINGS_FIELDS[0],
  )
  const longestGroup = SETTINGS_GROUPS.reduce(
    (worst, group) => (group.hint.length > worst.hint.length ? group : worst),
    SETTINGS_GROUPS[0],
  )
  const fieldTotal = SETTINGS_FIELDS.reduce((sum, field) => sum + field.label.length + field.hint.length, 0)
  const groupTotal = SETTINGS_GROUPS.reduce((sum, group) => sum + group.label.length + group.hint.length, 0)
  console.log('longest field hint:', longestField.key, longestField.hint.length)
  console.log('longest group hint:', longestGroup.id, longestGroup.hint.length)
  console.log('field label+hint total:', fieldTotal)
  console.log('group label+hint total:', groupTotal)
  console.log('advisoryText length:', ADVISORY_TEXT.length)

  for (const field of SETTINGS_FIELDS) {
    const limit = hintHasPath(field.hint) ? MAX_FIELD_HINT_PATHED : MAX_FIELD_HINT
    assert.ok(
      field.hint.length <= limit,
      `${field.key} hint is ${field.hint.length} chars, over its ${limit} budget: ${field.hint}`,
    )
  }
  for (const group of SETTINGS_GROUPS) {
    assert.ok(
      group.hint.length <= MAX_GROUP_HINT,
      `group ${group.id} hint is ${group.hint.length} chars, over the ${MAX_GROUP_HINT} budget`,
    )
  }
  assert.ok(ADVISORY_TEXT.length <= MAX_ADVISORY, `the advisory is ${ADVISORY_TEXT.length} chars`)
  assert.ok(fieldTotal <= MAX_FIELD_TOTAL, `field text totals ${fieldTotal} chars`)
  assert.ok(groupTotal <= MAX_GROUP_TOTAL, `group text totals ${groupTotal} chars`)

  // The static budget is not the whole story for the two derived-path hints:
  // they carry a token that is replaced by the *live* runtime directory, so what
  // the user sees is longer than what is authored. Measure that too, using the
  // shipped default — this is the number that has to stay readable.
  const liveRuntimeDir = plugin.Config({}).runtimeDir.get()
  const hinted = SETTINGS_FIELDS.filter((field) => field.hint.includes(RUNTIME_DIR_TOKEN))
  console.log('path hints rendered with the live runtimeDir:', JSON.stringify(
    hinted.map((field) => [field.key, resolveHint(field.hint, { runtimeDir: liveRuntimeDir })]),
    null,
    2,
  ))
  assert.ok(hinted.length >= 2, 'modelsDir and pythonPath should show their derived path')
  for (const field of hinted) {
    const rendered = resolveHint(field.hint, { runtimeDir: liveRuntimeDir })
    assert.ok(!rendered.includes(RUNTIME_DIR_TOKEN), `${field.key} left the token unresolved`)
    assert.ok(rendered.includes(liveRuntimeDir), `${field.key} must show the live runtime directory`)
    assert.ok(
      rendered.length <= MAX_FIELD_HINT_PATHED,
      `${field.key} renders to ${rendered.length} chars, over the ${MAX_FIELD_HINT_PATHED} budget`,
    )
  }
  // An unresolved token must survive rather than render a wrong path.
  assert.match(resolveHint('留空 = 跟随：<运行时目录>\\x', undefined), /<运行时目录>/)
  assert.match(resolveHint('留空 = 跟随：<运行时目录>\\x', {}), /<运行时目录>/)
})

test('the withdrawn and falsified figures never come back', () => {
  // `8 倍` / `15 倍` / the derived per-step figures were products of total time
  // divided by steps and are withdrawn. `37 s` is the contaminated historical
  // reading the sweep could not reproduce (4 steps measures 18.81 s). Keeping
  // this list is the point: it pins "do not reintroduce that mistake".
  const withdrawn = ['8 倍', '15 倍', '7.75', '0.98', '36–43', '2.4–2.9', '37 s', '口径存疑']
  for (const needle of withdrawn) {
    assert.ok(!ADVISORY_TEXT.includes(needle), `a withdrawn or falsified figure is back: ${needle}`)
  }
})

test('the advisory promises no fix, and the shipped prose keeps the honest verdict', () => {
  const noPromise = [/正在优化/, /即将修复/, /预计/, /会修好/, /保证/, /计划修复/, /将在[^，。]*修复/, /下一步优化/]
  for (const pattern of noPromise) {
    assert.ok(!pattern.test(ADVISORY_TEXT), `the advisory must not promise a fix: ${pattern}`)
  }
  // The structural verdict has to survive in the shipped prose, since that is now
  // the only place the reasoning is written down.
  assert.match(README_SOURCE, /结构性差距/)
  assert.match(README_SOURCE, /换推理栈/)
  assert.match(README_SOURCE, /超出本插件的范围/)
  assert.match(README_SOURCE, /不给出改善承诺/)
})

test('the moved evidence is in the shipped prose and no longer on the page', () => {
  // Everything the page used to carry. It must be findable in the prose surface
  // (the README plus `docs/*.md`)...
  const evidence = [
    '0.727',
    '2.014',
    '60.3%',
    'kDequantizeBlockwise',
    'convrot_w4a4_linear',
    '3.6 GiB',
    'cudaMallocAsync',
    '24.06',
    '8666',
    'WDDM',
    '18.81',
    '28.20',
  ]
  for (const needle of evidence) {
    assert.ok(README_SOURCE.includes(needle), `the shipped prose lost the evidence: ${needle}`)
    assert.ok(!ADVISORY_TEXT.includes(needle), `the evidence is still on the page: ${needle}`)
  }
  // ...and the page must not be carrying the mechanism in a hint either.
  const pageText = [
    ...SETTINGS_FIELDS.map((field) => `${field.label} ${field.hint}`),
    ...SETTINGS_GROUPS.map((group) => `${group.label} ${group.hint}`),
  ].join('\n')
  for (const needle of ['cudaMallocAsync', 'convrot_w4a4_linear', 'kDequantizeBlockwise']) {
    assert.ok(!pageText.includes(needle), `the page still explains the mechanism: ${needle}`)
  }
})

test('the advisory ships no markdown markers, because the section renders plain text', () => {
  // The section renders these strings as text nodes, so `**bold**` and
  // `` `code` `` would reach the user as literal asterisks and backticks. Assert
  // on the advisory's own strings — not on the bundle, whose preserved source
  // comments legitimately contain both.
  assert.ok(!ADVISORY_TEXT.includes('**'), 'the advisory must not use markdown bold')
  assert.ok(!ADVISORY_TEXT.includes('`'), 'the advisory must not use markdown code spans')
  console.log('advisory carries no markdown markers; length', ADVISORY_TEXT.length)
})

// ---------------------------------------------------------------------------
// Detected defaults: a text box showing a blank is not an answer.
// ---------------------------------------------------------------------------

test('the path fields default to real, resolved values rather than blanks', () => {
  const resolved = plugin.Config({})
  const value = (key) => (typeof resolved[key]?.get === 'function' ? resolved[key].get() : resolved[key])
  console.log('detected defaults:', JSON.stringify({
    runtimeDir: value('runtimeDir'),
    modelsDir: value('modelsDir'),
    pythonPath: value('pythonPath'),
    workerScript: value('workerScript'),
    basePython: value('basePython'),
    comfyModelsDir: value('comfyModelsDir'),
  }))

  // Constant and probed values: real, and they cannot go stale.
  assert.match(value('workerScript'), /resources[\\/]worker\.py$/)
  assert.ok(isAbsolute(value('workerScript')))
  for (const key of ['basePython', 'comfyModelsDir']) {
    const detected = value(key)
    assert.equal(typeof detected, 'string')
    if (detected !== '') assert.ok(existsSync(detected), `${key} default must exist on disk: ${detected}`)
  }

  // Derived-from-runtimeDir values: deliberately **blank**, because a real value
  // would freeze to the default runtime directory and silently point at the wrong
  // weights/venv once the user moves `runtimeDir`. The rule goes in the hint
  // instead, substituted with the live value so it cannot go stale either.
  for (const key of ['modelsDir', 'pythonPath']) {
    assert.equal(value(key), '', `${key} must stay blank so it keeps following runtimeDir`)
    const field = SETTINGS_FIELDS.find((candidate) => candidate.key === key)
    const rendered = resolveHint(field.hint, { runtimeDir: value('runtimeDir') })
    console.log(`${key} hint ->`, rendered)
    assert.match(rendered, /留空/)
    assert.match(rendered, /跟随运行时目录/)
    assert.ok(rendered.includes(value('runtimeDir')), `${key} must show the live runtime directory`)
  }
})

test('the derived-path hints state exactly what the tool layer derives', async () => {
  // The hint is documentation of a rule, so it has to agree with the rule. Compare
  // it against the canonical derivation rather than against a copied string.
  const defaults = await import('../testlib/config-defaults.js')
  const runtimeDir = plugin.Config({}).runtimeDir.get()
  const cases = [
    ['modelsDir', defaults.defaultModelsDir(runtimeDir)],
    ['pythonPath', defaults.defaultPythonPath(runtimeDir)],
  ]
  for (const [key, derived] of cases) {
    const field = SETTINGS_FIELDS.find((candidate) => candidate.key === key)
    const rendered = resolveHint(field.hint, { runtimeDir })
    console.log(`${key}: derived=${derived}`)
    assert.ok(isAbsolute(derived))
    assert.ok(rendered.includes(derived), `${key}'s hint must name the path it derives: "${rendered}"`)
  }
})

test('the probes themselves only ever return an existing path or nothing', async () => {
  const defaults = await import('../testlib/config-defaults.js')
  const base = defaults.probeBasePython()
  const comfy = defaults.probeComfyModelsDir()
  console.log('probeBasePython ->', JSON.stringify(base))
  console.log('probeComfyModelsDir ->', JSON.stringify(comfy))
  assert.equal(typeof base, 'string')
  assert.equal(typeof comfy, 'string')
  if (base !== '') assert.ok(existsSync(base), 'probeBasePython returned a path that does not exist')
  if (comfy !== '') assert.ok(existsSync(comfy), 'probeComfyModelsDir returned a path that does not exist')
  // The candidate list is data, so its shape is checkable without any I/O.
  const candidates = defaults.comfyModelsCandidates()
  assert.ok(Array.isArray(candidates) && candidates.length >= 4)
  assert.ok(candidates.every((entry) => isAbsolute(entry)))
})

test('every field that may still be blank says what blank means', () => {
  // The acceptance rule: for each "empty = auto" field the page must show either a
  // real default or a hint naming the concrete fallback. These three stay empty on
  // purpose — `comfyEndpoint` must not open a socket while the schema is being
  // built — so their hints have to carry the value instead.
  const resolved = plugin.Config({})
  const value = (key) => (typeof resolved[key]?.get === 'function' ? resolved[key].get() : resolved[key])
  for (const key of ['comfyEndpoint', 'torchWheels', 'pipIndexUrl']) {    assert.equal(value(key), '', `${key} is expected to stay blank`)
    const field = SETTINGS_FIELDS.find((candidate) => candidate.key === key)
    console.log(`${key} hint:`, field.hint)
    assert.match(field.hint, /留空/, `${key} must say what blank means`)
    // A concrete fallback, not a vague "auto": each is checked by its own value
    // rather than by a digit, since a pip index is named by a URL.
  }
  assert.match(SETTINGS_FIELDS.find((f) => f.key === 'comfyEndpoint').hint, /8000/)
  assert.match(SETTINGS_FIELDS.find((f) => f.key === 'comfyEndpoint').hint, /8188/)
  assert.match(SETTINGS_FIELDS.find((f) => f.key === 'torchWheels').hint, /cu128/)
  assert.match(SETTINGS_FIELDS.find((f) => f.key === 'torchWheels').hint, /cu118/)
  assert.match(SETTINGS_FIELDS.find((f) => f.key === 'pipIndexUrl').hint, /pypi\.org/)
})

// ---------------------------------------------------------------------------
// The built client entry, which this sandbox cannot execute.
// ---------------------------------------------------------------------------

test('the built client entry wires the section and keeps the keyed tool view', () => {
  // `lib/client.js` imports `react`, which is not a dependency of this package,
  // so this entry cannot be imported here. These are source-level assertions,
  // and they are labelled as such: they prove the wiring is present in the
  // artifact the web client loads, not that it renders correctly.
  assert.match(CLIENT_SOURCE, /settings\.section/, 'the settings slot name must be in the bundle')
  assert.match(CLIENT_SOURCE, /dsh-image-forge/, 'the seat id must be in the bundle')
  assert.match(CLIENT_SOURCE, /registerSettingsSection/, 'the registration must be wired')
  assert.match(CLIENT_SOURCE, /tool\.call\.toolview/, 'the tool view slot must survive')
  assert.match(CLIENT_SOURCE, /qwen_image_generate/, 'the keyed tool view key must survive')
  assert.match(CLIENT_SOURCE, /password/, 'a secret control must render as a password input')
  assert.match(CLIENT_SOURCE, /SECRET_MASK|••••/, 'the secret mask must be reachable from the bundle')
  console.log('lib/client.js bytes:', CLIENT_SOURCE.length)
})

test('the browser half registers a lazy factory in the loader format', () => {
  // The web client does not `import` the browser half: it evaluates it and
  // expects a factory registration keyed by the package name. A bundle with a
  // top-level ESM `import` registers nothing and the entry reports as failing to
  // import — a failure this repository's Node tests cannot otherwise observe,
  // which is how plain ESM shipped here unnoticed until a real client loaded it.
  const head = CLIENT_SOURCE.split('\n').slice(0, 6).join('\n')
  console.log('lib/client.js head:\n' + head)
  console.log('lib/client.js tail:\n' + CLIENT_SOURCE.trimEnd().split('\n').slice(-4).join('\n'))

  assert.match(CLIENT_SOURCE, /window\.__ModuleLoader__\.load\(/, 'the loader registration must be present')
  assert.match(CLIENT_SOURCE, /id: "dsh-image-forge"/, 'the factory id must equal the package name')
  assert.match(CLIENT_SOURCE, /factory: \(require\) => \{/, 'the factory must take the loader-provided require')
  assert.match(CLIENT_SOURCE, /var exports = module\.exports;/, 'the factory must expose module.exports')
  assert.match(CLIENT_SOURCE, /return module\.exports;/, 'the factory must return module.exports')

  // CJS is what makes React come through the factory's `require` rather than a
  // hoisted ESM import.
  assert.match(CLIENT_SOURCE, /require\("react"\)/, 'react must be requested through the factory require')
  assert.ok(!/from "react"/.test(CLIENT_SOURCE), 'react must not be a top-level ESM import')

  // No top-level ESM statement at all — that is the whole point of the format.
  const esmStatements = CLIENT_SOURCE.split('\n').filter((line) => /^(import|export)\s/.test(line))
  console.log('top-level ESM statements in lib/client.js:', JSON.stringify(esmStatements))
  assert.deepEqual(esmStatements, [], 'the browser half must not be an ESM module')

  // The loader materializes one bundle, so nothing may be required from a sibling.
  for (const pattern of [/require\("\.\//, /from\s+"\.\//, /\bimport\("\.\//]) {
    assert.ok(!pattern.test(CLIENT_SOURCE), `lib/client.js must not pull in a sibling chunk: ${pattern}`)
  }

  // The shell's baseline module table supplies React; bundling a copy would
  // defeat that (and a second React breaks hooks).
  for (const bundled of ['react.development', 'react.production', 'react-dom.development']) {
    assert.ok(!CLIENT_SOURCE.includes(bundled), `react must not be bundled into lib/client.js: ${bundled}`)
  }

  // The exports the loader reads, by name — and nothing else, matching the
  // official template and every reference client entry (`{ apply, inject }`).
  const assigned = [...CLIENT_SOURCE.matchAll(/^exports\.(\w+) = /gm)].map((match) => match[1]).sort()
  console.log('assigned exports in lib/client.js:', JSON.stringify(assigned))
  assert.deepEqual(assigned, ['apply', 'inject'], 'the browser half must publish exactly apply and inject')
  console.log('lib/client.js bytes:', CLIENT_SOURCE.length)
})

test('the host half stays plain ESM, and the client bundle stays self-contained', () => {
  // The two halves are different artifact kinds and must not be conflated: the
  // host is loaded with a dynamic `import()`, so a CJS-ified index.js would break
  // it. Assert the separation in both directions.
  const hostSource = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.match(hostSource, /^import /m, 'lib/index.js must stay ESM')
  assert.ok(!hostSource.includes('__ModuleLoader__'), 'the host half must not carry the loader wrapper')
  const hostRelative = [...hostSource.matchAll(/from\s+"(\.\/[^"]+)"/g)].map((match) => match[1])
  console.log('relative imports in lib/index.js:', JSON.stringify(hostRelative))
  assert.deepEqual(hostRelative, [], 'lib/index.js must not import its siblings')

  const relativeImports = [...CLIENT_SOURCE.matchAll(/from\s+"(\.\/[^"]+)"/g)].map((match) => match[1])
  console.log('relative imports in lib/client.js:', JSON.stringify(relativeImports))
  assert.deepEqual(relativeImports, [], 'lib/client.js must not import its siblings')
})

test('the host entry still exports exactly its published surface', () => {
  assert.deepEqual(Object.keys(plugin).sort(), ['Config', 'apply', 'inject', 'name'])
  assert.deepEqual(plugin.inject, ['tools', 'skills'])
  assert.equal(plugin.name, 'dsh-image-forge')
})
