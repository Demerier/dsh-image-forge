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
  HIDDEN_FIELD_KEYS,
  SETTINGS_FIELDS,
  SETTINGS_FIELD_KEYS,
  SETTINGS_GROUPS,
  SETTINGS_TABS,
  VISIBLE_FIELD_KEYS,
  advisoryText,
  fieldByKey,
  groupedFields,
  hintHasPath,
  missingFieldKeys,
  staleFieldKeys,
  tabFields,
} from '../testlib/settings-fields.js'

/** The built client bundle, as text — the only view of it this sandbox can get. */
const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/**
 * Every config field the plugin may not reintroduce.
 *
 * The plugin owns no local runtime any more: no venv, no weight cache, no managed
 * worker process. Each of these used to be a control on this page, so a
 * regression that brings one back shows up here as a name rather than as a
 * count that nobody can explain. The cloud-API fields are retired the same way:
 * generation is local-only, and a key field coming back would mean a second
 * backend is being rebuilt.
 */
const RETIRED_FIELDS = [
  'backend',
  'apiBaseUrl',
  'apiKey',
  'apiModel',
  'apiStyle',
  'localEndpoint',
  'runtimeDir',
  'modelsDir',
  'modelRepo',
  'hfMirror',
  'workerPorts',
  'workerStartTimeoutMs',
  'idleUnloadMs',
  'manageWorker',
  'pythonPath',
  'workerScript',
  'basePython',
  'torchWheels',
  'pipIndexUrl',
  'reuseBaseTorch',
  'minFreeVramMiB',
  'freeComfyBeforeLocalStart',
  'allowLocalEditOverBudget',
  'localReferenceBudget',
  'skipLmHead',
  'localSteps',
]

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
  forms.table.set('dsh-image-forge', fakeForm({ value: { timeoutMs: 180000 }, revision: 3 }))
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
  assert.equal(await form.set('outputDir', 'D:/pic'), false)
  assert.equal(await form.unset('outputDir'), false)
  assert.equal(await saveField(form, 'outputDir', 'D:/pic').then((outcome) => outcome.ok), false)
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
  const inner = fakeForm({ value: { comfyModelsDir: '/x' } })
  const form = createResolvedEntryForm({ forms: fakeForms(['dsh-image-forge']), entryIds: SETTINGS_ENTRY_IDS })
  form.rebind()
  const outcome = await saveField(form, 'comfyModelsDir', undefined)
  assert.deepEqual(inner.calls, [], 'the unbound form is the only one this fake served')
  assert.equal(outcome.ok, false)
})

test('clearing a bound field goes through the bound form\'s unset', async () => {
  const inner = fakeForm({ value: { comfyModelsDir: '/x' } })
  const forms = fakeForms(['dsh-image-forge'])
  forms.table.set('dsh-image-forge', inner)
  const form = createResolvedEntryForm({ forms, entryIds: SETTINGS_ENTRY_IDS })
  const outcome = await saveField(form, 'comfyModelsDir', undefined)
  console.log('unset calls:', JSON.stringify(inner.calls))
  assert.deepEqual(inner.calls, [{ op: 'unset', field: 'comfyModelsDir' }])
  assert.equal(outcome.ok, true)
})

test('a write against an unwritable entry is refused before anything is sent', async () => {
  const inner = fakeForm({ writable: false })
  const outcome = await saveField(inner, 'outputDir', 'D:/pic')
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
  const outcome = await saveField(inner, 'outputDir', 'D:/pic')
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
  const outcome = await saveField(inner, 'outputDir', 'D:/pic')
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
  const outcome = await saveField(inner, 'outputDir', 'D:/pic')
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
  const outcome = await saveField(inner, 'outputDir', 'D:/pic')
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
  const defaults = { someFlag: true, timeoutMs: 180000, comfyEndpoint: 'http://127.0.0.1:8188', outputDir: 'D:/pic' }
  const resolved = resolveConfigFields(defaults, {
    someFlag: { get: () => false },
    timeoutMs: { get: () => 1000 },
    comfyEndpoint: { get: () => '' },
    // `outputDir` is left out entirely and must keep its default.
  })
  console.log('resolved over defaults:', JSON.stringify(resolved))
  assert.equal(resolved.someFlag, false, 'an explicit false must not fall back to the default')
  assert.equal(resolved.timeoutMs, 1000)
  assert.equal(resolved.comfyEndpoint, '', 'an explicit empty string must not fall back to the default')
  assert.equal(resolved.outputDir, 'D:/pic', 'a missing field keeps its default')

  // A reference carrying undefined is an absent field, not an override.
  assert.equal(resolveConfigFields({ timeoutMs: 5 }, { timeoutMs: { get: () => undefined } }).timeoutMs, 5)
  // No config at all resolves to the defaults.
  assert.deepEqual(resolveConfigFields(defaults, undefined), defaults)
})

test('the real schema defaults survive a resolve round trip as plain data', () => {
  const resolved = resolveConfigFields(schemaDefaults(plugin.Config({})), plugin.Config({}))
  const kinds = new Set(Object.values(resolved).filter((value) => value !== undefined).map((value) => typeof value))
  console.log('resolved value types:', JSON.stringify([...kinds]))
  assert.deepEqual([...kinds].sort(), ['number', 'string'], 'the surviving fields are strings and numbers only')
  assert.equal(resolved.timeoutMs, 180000)
  assert.equal(resolved.defaultSteps, 25)
  assert.equal(resolved.comfyModel, 'base')
  // The two overrides are declared-but-unset, which is a real state: the key
  // exists and its value is undefined, so the resolver falls through.
  assert.equal(Object.keys(resolved).length, 9, 'the documented field count')
  assert.ok('comfyuiSteps' in resolved, 'a nullable field must keep its key')
  assert.equal(resolved.comfyuiSteps, undefined)
  assert.equal(resolved.turboSteps, undefined)
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
  console.log('page controls (table):', SETTINGS_FIELD_KEYS.length)
  console.log('visible on page:', VISIBLE_FIELD_KEYS.length, 'hidden:', HIDDEN_FIELD_KEYS.length, JSON.stringify(HIDDEN_FIELD_KEYS))
  console.log('missing from the page:', JSON.stringify(missing))
  console.log('stale on the page:', JSON.stringify(stale))
  assert.deepEqual(missing, [], 'these config fields have no control on the settings page')
  assert.deepEqual(stale, [], 'the settings page renders controls for fields the schema does not declare')
  assert.equal(SETTINGS_FIELD_KEYS.length, declared.length)
  assert.equal(declared.length, 9, 'the documented field count')
  // Nothing is hidden: the page shows every remaining field, because none of
  // them is plumbing any more.
  assert.deepEqual(HIDDEN_FIELD_KEYS, [], 'no surviving field is hidden')
  // The turbo pair is the newest thing on the page, so name it: a regression that
  // drops one reads as "what is missing" rather than "9 !== 8".
  for (const key of ['comfyModel', 'turboSteps', 'comfyEndpoint', 'comfyPorts', 'comfyModelsDir']) {
    assert.ok(declared.includes(key), `${key} must be a schema field`)
    assert.ok(SETTINGS_FIELD_KEYS.includes(key), `${key} must have a control`)
  }
})

test('the retired local-runtime fields are gone from both the schema and the page', () => {
  const declared = schemaKeys()
  for (const retired of RETIRED_FIELDS) {
    assert.ok(!declared.includes(retired), `${retired} is back in the config schema`)
    assert.ok(!SETTINGS_FIELD_KEYS.includes(retired), `${retired} is back on the settings page`)
  }
})

test('no backend or API control remains on the page', () => {
  // One backend remains (the local ComfyUI): a selector between one thing and
  // itself is not a control, and the key fields died with the cloud client.
  for (const retired of ['backend', 'apiBaseUrl', 'apiKey', 'apiModel', 'apiStyle']) {
    assert.equal(fieldByKey(retired), undefined, `${retired} is still on the settings page`)
  }
  // The weight-family control survives, and the coverage test above already
  // pins schema/table agreement on the removal.
  assert.equal(fieldByKey('comfyModel').kind, 'enum')
})

test('the weight-family control states the trade and the fallback', () => {
  const byKey = Object.fromEntries(SETTINGS_FIELDS.map((field) => [field.key, field]))
  const field = byKey.comfyModel
  console.log('comfyModel control:', JSON.stringify(field))
  assert.equal(field.group, 'steps')
  assert.equal(field.kind, 'enum')
  assert.deepEqual(field.choices.map((choice) => choice.value), ['base', 'turbo'])
  assert.match(field.hint, /8 步/)
  assert.match(field.hint, /2\.7/)
  // turbo is a request, not a guarantee — the page has to say what happens when
  // the turbo weights are not installed.
  assert.match(field.hint, /退回 base/)
})

test('the step controls state the tradeoff and mark the two overrides nullable', () => {
  const byKey = Object.fromEntries(SETTINGS_FIELDS.map((field) => [field.key, field]))
  console.log('step hints:', JSON.stringify({
    defaultSteps: byKey.defaultSteps.hint,
    comfyuiSteps: byKey.comfyuiSteps.hint,
    turboSteps: byKey.turboSteps.hint,
  }, null, 2))
  assert.equal(byKey.defaultSteps.group, 'steps')
  assert.equal(byKey.defaultSteps.kind, 'number')
  assert.equal(byKey.defaultSteps.nullable, undefined, 'the shared default is not nullable')
  for (const key of ['comfyuiSteps', 'turboSteps']) {
    assert.equal(byKey[key].group, 'steps')
    assert.equal(byKey[key].kind, 'number')
    assert.equal(byKey[key].nullable, true, `${key} must be clearable back to unset`)
    assert.equal(byKey[key].min, 1)
  }
  // turbo's own default is the distilled 8, and the hint must not let a user
  // think raising it is free.
  assert.match(byKey.turboSteps.hint, /留空 = 8/)
  assert.match(byKey.turboSteps.hint, /不一定更好/)
})

test('the config keys really are volatile references, and resolve back to plain data', () => {
  const resolved = plugin.Config({})
  const refs = Object.entries(resolved).filter(([, value]) => typeof value?.get === 'function')
  console.log('volatile reference count:', refs.length, 'of', Object.keys(resolved).length)
  assert.equal(refs.length, Object.keys(resolved).length, 'every field must be volatile for the Host to serve a form')
  assert.equal(resolved.comfyModel.get(), 'base')
  assert.equal(resolved.timeoutMs.get(), 180000)
})

test('the settings tabs cover every visible group exactly once', () => {
  assert.ok(SETTINGS_TABS.length >= 2, 'the page must be multi-tab')
  const seen = SETTINGS_TABS.flatMap((tab) => tabFields(tab).map(({ group }) => group.id))
  const visibleGroups = groupedFields().map(({ group }) => group.id)
  assert.deepEqual([...seen].sort(), [...visibleGroups].sort(), 'every visible group must live on exactly one tab')
  assert.equal(new Set(seen).size, seen.length, 'a group must not sit on two tabs')
  for (const tab of SETTINGS_TABS) {
    assert.ok(tab.label.length > 0 && tab.hint.length > 0, `tab ${tab.id} needs a label and hint`)
    assert.ok(tabFields(tab).length > 0, `tab ${tab.id} must not be empty`)
  }
  console.log(
    'tabs:',
    JSON.stringify(SETTINGS_TABS.map((tab) => `${tab.label}(${tabFields(tab).map((e) => e.group.id).join('+')})`)),
  )
})

test('the ComfyUI tab points at the deployment document', () => {
  // A user who has no ComfyUI yet lands on this tab first; the one thing it must
  // not do is leave them to guess. The document is asserted to exist below.
  const tab = SETTINGS_TABS.find((candidate) => candidate.id === 'comfyui')
  assert.ok(tab, 'the ComfyUI tab must exist')
  assert.match(tab.hint, /docs\/comfyui-deployment\.md/)
  const root = fileURLToPath(new URL('..', import.meta.url))
  assert.ok(existsSync(join(root, 'docs', 'comfyui-deployment.md')), 'the cited deployment document must ship')
})

test('the section groups every visible field exactly once and every group is non-empty', () => {
  const buckets = groupedFields()
  const seen = buckets.flatMap(({ fields }) => fields.map((field) => field.key))
  assert.deepEqual([...seen].sort(), [...VISIBLE_FIELD_KEYS].sort())
  assert.equal(new Set(seen).size, seen.length, 'a field must not appear in two groups')
  const groupIds = SETTINGS_GROUPS.map((group) => group.id)
  for (const { group, fields } of buckets) {
    assert.ok(groupIds.includes(group.id))
    assert.ok(fields.length > 0, `group ${group.id} is empty`)
    assert.ok(group.label.length > 0 && group.hint.length > 0)
    assert.ok(
      fields.every((field) => field.hidden !== true),
      `group ${group.id} must not carry hidden fields`,
    )
  }
  // The whole python / local-runtime block is gone: it must not appear as an
  // empty heading either.
  for (const retiredGroup of ['python', 'local']) {
    assert.ok(!buckets.some(({ group }) => group.id === retiredGroup), `the ${retiredGroup} group must be gone`)
  }
  console.log('groups:', JSON.stringify(buckets.map(({ group, fields }) => `${group.label}=${fields.length}`)))
})

test('every control carries a usable label, hint and kind-appropriate limits', () => {
  for (const field of SETTINGS_FIELDS) {
    assert.ok(field.label.length > 0, `${field.key} has no label`)
    assert.ok(field.hint.length > 0, `${field.key} has no hint`)
    assert.ok(
      ['enum', 'string', 'path', 'number', 'boolean'].includes(field.kind),
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

test('resolveSteps follows explicit > comfyui override > default', async () => {
  const { resolveSteps } = await import('../testlib/tools.js')
  /** A settings stub carrying only the fields the resolver reads. */
  const withSteps = (defaultSteps, comfyuiSteps) => ({ defaultSteps, comfyuiSteps })

  const cases = [
    // label, explicit, settings, expected
    ['explicit beats everything', 12, withSteps(25, 30), { steps: 12, source: 'explicit' }],
    ['the comfyui override wins over the default', undefined, withSteps(25, 30), { steps: 30, source: 'backend' }],
    ['an unset comfyui override falls through', undefined, withSteps(25, undefined), { steps: 25, source: 'default' }],
    ['the shipped defaults resolve to 25', undefined, withSteps(25, undefined), { steps: 25, source: 'default' }],
    ['a non-positive override is ignored', undefined, withSteps(25, 0), { steps: 25, source: 'default' }],
    // An explicit value is clamped, not honoured: a typo (10000) or a confused
    // caller must not pin the GPU for hours. Same contract as the Studio's
    // resolveStudioSteps, which clamps 1–200.
    ['an explicit 10000 arrives as the clamp ceiling', 10000, withSteps(25, 30), { steps: 200, source: 'explicit' }],
    ['an explicit 0 clamps to 1 instead of throwing', 0, withSteps(25, 30), { steps: 1, source: 'explicit' }],
  ]
  for (const [label, explicit, settings, expected] of cases) {
    const actual = resolveSteps(explicit, settings)
    console.log(`${label}: ${JSON.stringify(actual)}`)
    assert.deepEqual(actual, expected, label)
  }
})

test('resolveTurboSteps never borrows the base family\'s 25', async () => {
  const { resolveTurboSteps } = await import('../testlib/tools.js')
  // The distilled checkpoint is tuned for 8 steps: handing it the base family's
  // 25 makes the picture worse, so the fallthrough must be the turbo default and
  // never `defaultSteps` / `comfyuiSteps`.
  const settings = { defaultSteps: 25, comfyuiSteps: 30, turboSteps: undefined }
  assert.deepEqual(resolveTurboSteps(undefined, settings), { steps: 8, source: 'default' })
  assert.deepEqual(resolveTurboSteps(undefined, { ...settings, turboSteps: 6 }), { steps: 6, source: 'backend' })
  assert.deepEqual(resolveTurboSteps(4, { ...settings, turboSteps: 6 }), { steps: 4, source: 'explicit' })
  assert.deepEqual(
    resolveTurboSteps(undefined, { ...settings, turboSteps: 0 }),
    { steps: 8, source: 'default' },
    'a non-positive override must not be honoured',
  )
  assert.deepEqual(
    resolveTurboSteps(10000, settings),
    { steps: 200, source: 'explicit' },
    'an explicit turbo value clamps like the base one',
  )
})

test('the resolved step count is what reaches each backend, and the result says so', () => {
  // `resolveSteps` is unit-tested above; this asserts the *wiring* is present in
  // the bundle the Host loads. Whether "no explicit steps" really puts 25 on the
  // wire is not covered by a test here — the comfyui-e2e harness that could
  // observe it exercises the explicit path, and it asserts those explicit values
  // arrive unchanged.
  const source = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  for (const needle of ['steps_used', 'steps_source', 'resolveSteps', 'comfyuiSteps', 'defaultSteps', 'turboSteps']) {
    assert.match(source, new RegExp(needle), `${needle} must be present in the host bundle`)
  }
  // Every dispatch site must pass a resolved count rather than the raw request.
  // Anchored on `await` so the callee's own definition — whose first parameter
  // is also named `request` — cannot produce a false positive.
  const rawSites = [
    /await generateViaComfyUi\(target, models, request,/,
    /await generateViaComfyUiEdit\(target, models, request,/,
    /await generateViaComfyUiTurbo\(target, models, request,/,
    /await generateViaComfyUiTurboEdit\(target, models, request,/,
  ]
  for (const pattern of rawSites) {
    assert.ok(!pattern.test(source), `a dispatch site still passes the unresolved request: ${pattern}`)
  }
  // And the positive half: every dispatch site carries a resolved count. The
  // bundle wraps these object literals across lines, so this counts the markers
  // rather than trying to match one line. The turbo dispatch sites resolve
  // through `resolveTurboSteps` (a distilled checkpoint must never borrow the
  // base family's 25), so both resolvers count.
  //
  // Two base sites (generate + edit via ComfyUI) and two turbo sites — the same
  // pair — so four dispatch forwards, plus the two `recordRun` metadata writes
  // that report the same resolved count: six markers in total.
  const resolved = source.match(/resolveSteps\(steps, settings\)/g) ?? []
  const turboResolved = source.match(/resolveTurboSteps\(steps, settings\)/g) ?? []
  const forwarded = source.match(/steps: usedSteps\.steps/g) ?? []
  console.log('resolveSteps call sites:', resolved.length, '/ turbo sites:', turboResolved.length, '/ resolved-count forwards:', forwarded.length)
  assert.equal(resolved.length, 2, 'both base dispatch sites must resolve')
  assert.equal(turboResolved.length, 2, 'both turbo dispatch sites (generate + edit) must resolve through the turbo resolver')
  assert.equal(forwarded.length, 6, 'the four dispatch sites and two recordRun calls must carry the resolved count')
})

// ---------------------------------------------------------------------------
// The backend performance advisory: two lines on the page, the evidence in the
// shipped prose (README + `docs/`). Both halves are asserted, so neither can
// quietly become the other.
// ---------------------------------------------------------------------------

/** Every string the advisory renders. */
const ADVISORY_TEXT = advisoryText(BACKEND_PERF_ADVISORY)

/**
 * The shipped prose surface, which is where the advisory's evidence lives.
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

test('the advisory states the turbo/base conclusion and the numbers, in two lines', () => {
  console.log('--- advisory as rendered ---\n' + ADVISORY_TEXT + '\n--- end ---')
  assert.equal(BACKEND_PERF_ADVISORY.id, 'turbo-vs-base')
  assert.equal(BACKEND_PERF_ADVISORY.placedAfterGroup, 'steps')
  // The recommendation the user asked to keep on the page.
  assert.match(BACKEND_PERF_ADVISORY.title, /turbo/)
  assert.match(BACKEND_PERF_ADVISORY.title, /8 步/)
  assert.match(BACKEND_PERF_ADVISORY.title, /base/)
  assert.equal(BACKEND_PERF_ADVISORY.paragraphs.length, 2, 'two lines, not a page of evidence')
  // The blind-test score, the per-image times and the three题材 turbo loses on.
  assert.match(ADVISORY_TEXT, /3 : 2|3:2/)
  assert.match(ADVISORY_TEXT, /27–29 s/)
  assert.match(ADVISORY_TEXT, /9–11 s/)
  assert.match(ADVISORY_TEXT, /中文小字/)
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
  const MAX_GROUP_HINT = 36
  const MAX_ADVISORY = 180
  // The totals were reset with the local-runtime teardown: 14 controls replaced
  // 35, and the surviving hints were rewritten around turbo/base. The slack over
  // the measured 459 / 117 is deliberately thin — the next addition has to argue
  // for its characters here.
  const MAX_FIELD_TOTAL = 470
  const MAX_GROUP_TOTAL = 125

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
})

test('the withdrawn and falsified figures never come back', () => {
  // `8 倍` / `15 倍` / the derived per-step figures were products of total time
  // divided by steps and are withdrawn. `37 s` is the contaminated historical
  // reading the sweep could not reproduce (4 steps measures 18.81 s). Keeping
  // this list is the point: it pins "do not reintroduce that mistake".
  const withdrawn = ['8 倍', '15 倍', '7.75', '0.98', '36–43', '2.4–2.9', '37 s', '口径存疑', '219 s', '2.77×']
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
  const evidence = ['0.727', '2.014', '60.3%', 'kDequantizeBlockwise', 'convrot_w4a4_linear', '3.6 GiB', 'cudaMallocAsync', '24.06', '8666', 'WDDM', '18.81', '28.20']
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
    outputDir: value('outputDir'),
    comfyModelsDir: value('comfyModelsDir'),
    comfyEndpoint: value('comfyEndpoint'),
  }))

  assert.ok(isAbsolute(value('outputDir')), 'the output directory must be an absolute path')
  // The models directory is *probed*: it names a real directory when one exists
  // and stays blank otherwise, which keeps the error phrasing generic rather than
  // pointing at a path that is not there.
  const comfyModelsDir = value('comfyModelsDir')
  assert.equal(typeof comfyModelsDir, 'string')
  if (comfyModelsDir !== '') assert.ok(existsSync(comfyModelsDir), `comfyModelsDir must exist on disk: ${comfyModelsDir}`)
})

test('comfyEndpoint stays blank on purpose: building the schema opens no socket', () => {
  const value = plugin.Config({}).comfyEndpoint.get()
  assert.equal(value, '', 'comfyEndpoint must stay blank so the schema has no side effects')
  const field = fieldByKey('comfyEndpoint')
  // Blank is only an answer if the hint names the concrete fallback.
  assert.match(field.hint, /留空/)
  assert.match(field.hint, /8000/)
  assert.match(field.hint, /8188/)
})

test('the probes themselves only ever return an existing path or nothing', async () => {
  const defaults = await import('../testlib/config-defaults.js')
  const comfy = defaults.probeComfyModelsDir()
  console.log('probeComfyModelsDir ->', JSON.stringify(comfy))
  assert.equal(typeof comfy, 'string')
  if (comfy !== '') assert.ok(existsSync(comfy), 'probeComfyModelsDir returned a path that does not exist')
  // The candidate list is data, so its shape is checkable without any I/O.
  const candidates = defaults.comfyModelsCandidates()
  assert.ok(Array.isArray(candidates) && candidates.length >= 4)
  assert.ok(candidates.every((entry) => isAbsolute(entry)))
})

test('the defaults module exposes no runtime-shaped helper any more', async () => {
  const defaults = await import('../testlib/config-defaults.js')
  const exported = Object.keys(defaults).sort()
  console.log('config-defaults exports:', JSON.stringify(exported))
  assert.deepEqual(exported, ['comfyModelsCandidates', 'defaultOutputDir', 'probeComfyModelsDir'])
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
  // All three wire names must be seated, or the missing one silently renders
  // nothing.
  for (const key of ['qwen_image_generate', 'qwen_image_edit', 'qwen_image_status']) {
    assert.ok(CLIENT_SOURCE.includes(key), `the keyed tool view ${key} must survive`)
  }
  // ...and the retired one must be gone, in the bundle as well as in the source.
  assert.ok(!CLIENT_SOURCE.includes('qwen_image_env'), 'the retired local-runtime tool is still wired into the client')
  // The secret machinery is retired with the API key field: no password input
  // and no mask may come back without a field that needs it.
  assert.ok(!CLIENT_SOURCE.includes('password'), 'a secret control is still wired into the client')
  assert.ok(!CLIENT_SOURCE.includes('SECRET_MASK'), 'the secret mask is still in the bundle')
  console.log('lib/client.js bytes:', CLIENT_SOURCE.length)
})

test('the one-click deploy card is gone from the bundle', () => {
  // The deploy bridge existed to build a venv and fetch nf4 weights. With no
  // runtime of ours left there is nothing to deploy, and a button that points at
  // a dead host-side port is worse than no button.
  for (const needle of ['dsh-image-forge-deploy', '一键部署', '127.0.0.1:8411', 'DeployStatusPayload']) {
    assert.ok(!CLIENT_SOURCE.includes(needle), `the deploy card is still in the client bundle: ${needle}`)
  }
})

test('the client ships the presentation CSS and the settings ergonomics', () => {
  // Layout rules live in the lazy factory (the only injection point a plugin
  // has) and are pinned here so a silent drop cannot ship as "unchanged".
  assert.match(CLIENT_SOURCE, /dsh-image-forge-client-styles/, 'the style tag id must be in the bundle')
  assert.match(CLIENT_SOURCE, /injectClientStyles/, 'the style injection must be wired into apply')
  assert.match(CLIENT_SOURCE, /dsh-image-forge-setting-unit/, 'numeric fields must render a unit suffix')
  // Container query is the one that matters: a wide Host window with a narrow
  // settings pane must still stack, which a viewport `@media` cannot see.
  assert.match(CLIENT_SOURCE, /@container forge-settings/, 'the settings column must container-query its own width')
  assert.match(CLIENT_SOURCE, /container-type: inline-size/, 'the settings root must be a size container')
  assert.match(CLIENT_SOURCE, /max-width: 560px/, 'the narrow breakpoint must stay at 560px')
  assert.match(CLIENT_SOURCE, /overflow-wrap: anywhere/, 'long path hints must wrap instead of clipping')
  assert.match(CLIENT_SOURCE, /dsh-image-forge-images/, 'generate/edit cards must use the image grid')
  assert.match(CLIENT_SOURCE, /dsh-image-forge-checklist/, 'the status card must use the health checklist')
  assert.match(CLIENT_SOURCE, /data-advanced/, 'the advanced marker must stay available for a future group')
  assert.match(CLIENT_SOURCE, /htmlFor: controlId/, 'labels must point at their controls')
  // The Host hands the view a tool-result block, not `result.value`. Reading the
  // wrong shape made every card fall back to empty-state text on a real client.
  assert.match(CLIENT_SOURCE, /tool-result|block\?\.content/, 'the card must read the Host tool-result block')
  assert.match(CLIENT_SOURCE, /JSON\.parse/, 'the block text must be parsed as JSON')
  // Tabbed settings page: a strip of tabs, one active panel, denser field grid.
  assert.match(CLIENT_SOURCE, /dsh-image-forge-tabs/, 'the tab strip must be in the bundle')
  assert.match(CLIENT_SOURCE, /dsh-image-forge-tab-active/, 'the active tab must be styled')
  assert.match(CLIENT_SOURCE, /dsh-image-forge-settings-panel/, 'the active panel must be in the bundle')
  assert.match(CLIENT_SOURCE, /dsh-image-forge-settings-fields-grid/, 'the dense field grid must be in the bundle')
  assert.match(CLIENT_SOURCE, /role: ['"]tab['"]/, 'tabs must be exposed as tabs')
  assert.match(CLIENT_SOURCE, /role: ['"]tabpanel['"]/, 'the panel must be exposed as a tabpanel')
  assert.match(CLIENT_SOURCE, /SETTINGS_TABS|tabFields/, 'the tab model must drive the page')
  // The status card reports the card ComfyUI loaded its weights onto, so the
  // device list has to survive into the card.
  assert.match(CLIENT_SOURCE, /devices/, 'the status card must read the device list')
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
