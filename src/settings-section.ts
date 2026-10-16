/**
 * The `dsh-image-forge` first-level settings section: registration shape and
 * save semantics, as pure logic.
 *
 * Kept free of React and of any DSH client import so the whole contract can be
 * asserted against fakes. The DSH client packages
 * (`@deepseek-ai/dsh-client-ui-settings/client`) are provided by the Host and
 * are not dependencies of this package, so the shapes this module consumes are
 * restated structurally rather than imported — the same choice the reference
 * implementation makes for the binder input shape it cannot import either.
 *
 * ## Why a settings section at all
 *
 * Under the DSH 0.2.0 settings model the Host derives one settings page per
 * profile entry from the plugin's own `Config` schema, and serves it only when
 * at least one field is `volatile()`. That page is addressed by **profile entry
 * id**. The browser half addresses it through the shared configuration-forms
 * service (`ctx.configForms`): `describe()` mirrors the served namespaces and
 * `get(entryId)` hands back that entry's form.
 *
 * The entry id is the one thing the plugin cannot know for certain — this row's
 * id comes from the profile patch — so {@link createResolvedEntryForm} starts on
 * the most likely id and rebinds the moment the describe mirror names one of
 * ours, which is the reference implementation's own robust path.
 */

/** The list slot a first-level settings menu item registers into. */
export const SETTINGS_SECTION_NAME = 'settings.section'

/** This section's id inside that slot. A list slot addresses its seats by `id`. */
export const SETTINGS_SECTION_ID = 'dsh-image-forge'

/** First-level nav position: after the plugin/usage family rows. */
export const SETTINGS_SECTION_ORDER = 160

/**
 * Profile entry ids this package's row may carry, most likely first.
 *
 * `dsh-image-forge` is both the package name and the row id in this package's
 * own `cordis.yml`, which is the id a standalone `dsh plugin add <dir>` install
 * registers.
 */
export const SETTINGS_ENTRY_IDS: readonly string[] = ['dsh-image-forge']

/** The menu label. A function, because the slot contract renders it lazily. */
export const SETTINGS_SECTION_LABEL = 'Qwen 出图'

// ---------------------------------------------------------------------------
// Structural views of the Host-provided services.
// ---------------------------------------------------------------------------

/** The snapshot fields this module reads off a shared config form. */
export interface ConfigFormSnapshotLike<T> {
  /** `loading` until the Host has answered for this entry. */
  readonly status?: string
  /** The entry's current value. */
  readonly value?: T
  /** The Host's revision fence for this entry. */
  readonly revision?: number
  /** Whether the Host will accept a write to this entry. */
  readonly writable?: boolean
  /** `host` on the native shared-form path. */
  readonly mode?: string
}

/** The shared config form for one profile entry (`ctx.configForms.get(id)`). */
export interface ConfigFormLike<T> {
  /** @returns the form's current snapshot. */
  getSnapshot(): ConfigFormSnapshotLike<T>
  /**
   * Subscribe to snapshot changes.
   * @param listener - called after every change.
   * @returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void
  /**
   * Write one field.
   * @param field - the config key.
   * @param value - the new value.
   * @returns the Host's answer: false is a refusal (unwritable entry, or a write dropped).
   */
  set(field: string, value: unknown): Promise<boolean>
  /**
   * Clear one field back to its schema default.
   * @param field - the config key.
   * @returns the Host's answer.
   */
  unset(field: string): Promise<boolean>
  /**
   * Revision-fenced batch write. Optional: an adapter may serve `set`/`unset`
   * only. The op shape is adapter-owned and is **not** used by the live path
   * (see {@link mutateFields}).
   * @param ops - the adapter's own op list.
   * @param expectedRevision - the revision the caller read.
   * @returns the Host's answer.
   */
  mutate?(ops: readonly unknown[], expectedRevision?: number): Promise<boolean>
}

/** The describe mirror (`ctx.configForms.describe()`). */
export interface ConfigFormsDescribeLike {
  /** @returns the mirror's current snapshot. */
  getSnapshot(): { readonly view?: { readonly namespaces?: readonly { readonly ns?: unknown }[] } }
  /**
   * Subscribe to mirror changes.
   * @param listener - called after every change.
   * @returns an unsubscribe function.
   */
  subscribe?(listener: () => void): () => void
}

/** The shared configuration-forms service (`ctx.configForms`). */
export interface ConfigFormsLike {
  /** @returns the mirror of the namespaces the Host currently serves. */
  describe(): ConfigFormsDescribeLike
  /**
   * The form for one profile entry.
   * @param entryId - the profile entry id.
   * @returns that entry's form.
   */
  get<T>(entryId: string): ConfigFormLike<T>
}

/** The slot registry the section registers into (`ctx.slots`). */
export interface SlotsLike {
  /**
   * Run the registration once the named slot exists.
   * @param name - the slot name.
   * @param register - the registration body; its return value is the disposer.
   */
  inject(name: string, register: () => unknown): void
  /**
   * Seat a component in a slot.
   * @param options - the seat descriptor.
   * @param component - the component to render.
   * @returns the unregister function.
   */
  register(options: Record<string, unknown>, component: unknown): unknown
}

/** The client context this module needs. */
export interface SettingsSectionContext {
  /** The slot registry. */
  slots: SlotsLike
  /**
   * Service lookup, used to reach `configForms` **optionally**: the settings
   * section must degrade to an "unavailable" notice rather than take the
   * plugin's client half (and with it the tool card) down with it.
   * @param name - the service name.
   * @returns the service, or undefined.
   */
  get?(name: string): unknown
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

/** Props the section component receives through the slot's `inject`. */
export interface SettingsSectionProps<T> {
  /** The bound form, or undefined when no configuration-forms service is reachable. */
  readonly form: ConfigFormLike<T> | undefined
  /** Why the form is absent, for the notice the component renders. */
  readonly unavailableReason?: string
}

/**
 * The seat descriptor for this section.
 *
 * @param props - the props factory the slot calls when it mounts the component.
 * @returns the descriptor passed to `slots.register`.
 */
export function settingsSectionOptions(props: () => SettingsSectionProps<unknown>): Record<string, unknown> {
  return {
    name: SETTINGS_SECTION_NAME,
    id: SETTINGS_SECTION_ID,
    order: SETTINGS_SECTION_ORDER,
    label: () => SETTINGS_SECTION_LABEL,
    inject: props,
  }
}

/**
 * Reach the shared configuration-forms service, if this page serves one.
 *
 * @param ctx - the client context.
 * @returns the service, or undefined when the page serves no such service.
 */
export function reachConfigForms(ctx: SettingsSectionContext): ConfigFormsLike | undefined {
  if (typeof ctx.get !== 'function') return undefined
  let candidate: unknown
  try {
    candidate = ctx.get('configForms')
  } catch {
    // A context that refuses the lookup serves no forms.
    return undefined
  }
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const forms = candidate as Partial<ConfigFormsLike>
  return typeof forms.describe === 'function' && typeof forms.get === 'function'
    ? (candidate as ConfigFormsLike)
    : undefined
}

/**
 * Register the first-level settings section.
 *
 * A failure here is contained: the tool card is the plugin's older, load-bearing
 * half, and a settings seat that cannot be created must not cost the user that
 * card. The registration is therefore attempted inside the `inject` body and a
 * throw becomes a no-op disposer.
 *
 * @param ctx - the client context.
 * @param component - the section component.
 * @returns a disposer that unregisters the seat, when one was created.
 */
export function registerSettingsSection(
  ctx: SettingsSectionContext,
  component: unknown,
): () => void {
  if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') {
    return () => {}
  }
  const form = createResolvedEntryForm<unknown>({
    forms: reachConfigForms(ctx),
    entryIds: SETTINGS_ENTRY_IDS,
  })
  const props = (): SettingsSectionProps<unknown> => {
    if (form === undefined) {
      return {
        form: undefined,
        unavailableReason: '当前页面没有提供配置表单服务（ctx.configForms），本分区无法读写配置。',
      }
    }
    return { form }
  }
  ctx.slots.inject(SETTINGS_SECTION_NAME, () => {
    try {
      const unregister = ctx.slots.register(settingsSectionOptions(props), component)
      return () => {
        try {
          if (typeof unregister === 'function') (unregister as () => void)()
        } catch {
          // The slot fiber is already gone during teardown.
        }
      }
    } catch {
      return () => {}
    }
  })
  return () => {}
}

// ---------------------------------------------------------------------------
// Form binding.
// ---------------------------------------------------------------------------

/** The snapshot a form reports before the Host has answered for this entry. */
export function pendingSnapshot<T>(): ConfigFormSnapshotLike<T> {
  return { status: 'loading', value: undefined, revision: undefined, writable: false, mode: 'host' }
}

/** The form {@link createResolvedEntryForm} returns, plus its own resolution. */
export interface ResolvedEntryForm<T> extends ConfigFormLike<T> {
  /**
   * @returns the entry id currently bound, or undefined when none is.
   */
  boundEntryId(): string | undefined
  /**
   * Re-run the resolution now.
   * @returns the entry id it settled on.
   */
  rebind(): string | undefined
}

/**
 * Bind a form to the profile entry id this Host actually serves.
 *
 * The describe mirror is the only local evidence of which row id is served, and
 * it answers asynchronously — at activation it usually holds nothing yet. So the
 * binding starts on the most likely candidate and is redone the moment the
 * mirror names one of ours; an unanswered mirror is not evidence of absence and
 * keeps the current binding.
 *
 * @param options - the forms service (or undefined) and this package's candidate row ids.
 * @returns the bound form, or undefined when no forms service is reachable.
 */
export function createResolvedEntryForm<T>(options: {
  forms: ConfigFormsLike | undefined
  entryIds: readonly string[]
}): ResolvedEntryForm<T> | undefined {
  const { forms, entryIds } = options
  if (forms === undefined || entryIds.length === 0) return undefined
  const fallbackId = entryIds[0] as string
  const namespaceId = entryIds[entryIds.length - 1] as string
  const listeners = new Set<() => void>()
  let boundId: string | undefined
  let bound: ConfigFormLike<T> | undefined
  let offBound: (() => void) | undefined
  let snapshot: ConfigFormSnapshotLike<T> = pendingSnapshot<T>()

  /** Republish: the delegated snapshot when one is bound, the pending one otherwise. */
  const publish = (): void => {
    if (bound !== undefined) {
      try {
        snapshot = bound.getSnapshot()
      } catch {
        // A form that refuses the read stays at its last published snapshot.
      }
    }
    for (const listener of [...listeners]) listener()
  }

  /** The entry id the mirror currently justifies. */
  const resolve = (): string => {
    let served: readonly string[] | undefined
    try {
      served = forms
        .describe()
        .getSnapshot()
        .view?.namespaces?.map((row) => String(row.ns))
    } catch {
      // A mirror that refuses the read is unanswered too, not absent.
      served = undefined
    }
    if (served === undefined || served.length === 0) return fallbackId
    return entryIds.find((id) => served.includes(id)) ?? namespaceId
  }

  /** Bind (or rebind) the resolved entry's form; a no-op while it is unchanged. */
  const bind = (): string | undefined => {
    const target = resolve()
    if (target === boundId && bound !== undefined) return boundId
    if (offBound !== undefined) {
      try {
        offBound()
      } catch {
        // The previous form's subscription is already gone.
      }
      offBound = undefined
    }
    let form: ConfigFormLike<T>
    try {
      form = forms.get<T>(target)
    } catch {
      // A service that refuses the id stays unbound; the next mirror answer
      // retries rather than pinning a wrong entry for the session.
      boundId = undefined
      bound = undefined
      return undefined
    }
    boundId = target
    bound = form
    try {
      offBound = form.subscribe(() => {
        publish()
      })
    } catch {
      offBound = undefined
    }
    publish()
    return boundId
  }

  // The mirror subscription lives for the page: the section owns its form for
  // the session. A mirror without a subscription seat keeps the initial binding.
  try {
    forms.describe().subscribe?.(() => {
      bind()
    })
  } catch {
    // A describe face that refuses the subscription: the initial binding stands.
  }
  bind()

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (field, value) => bound?.set(field, value) ?? Promise.resolve(false),
    unset: (field) => bound?.unset(field) ?? Promise.resolve(false),
    ...(bound?.mutate === undefined
      ? {}
      : { mutate: (ops: readonly unknown[], revision?: number) => bound?.mutate?.(ops, revision) ?? Promise.resolve(false) }),
    boundEntryId: () => boundId,
    rebind: () => bind(),
  }
}

// ---------------------------------------------------------------------------
// Saving.
// ---------------------------------------------------------------------------

/** Why a write did not land. */
export type SaveFailure = 'unwritable' | 'conflict' | 'refused' | 'error'

/** The result of one write attempt. */
export type SaveOutcome =
  | { readonly ok: true; readonly revision?: number }
  | {
      readonly ok: false
      readonly reason: SaveFailure
      /** Operator-facing text. Never contains a field value. */
      readonly message: string
      /** The revision this attempt read before writing. */
      readonly expectedRevision?: number
      /** The revision observed after the attempt. */
      readonly observedRevision?: number
    }

/** A human label for a config key, for messages that must not carry values. */
function keyLabel(key: string): string {
  return key
}

/**
 * Read one field's value out of a form's snapshot.
 *
 * @param form - the bound form.
 * @param key - the config key.
 * @returns the value, or undefined when the form has not answered yet.
 */
export function readField<T>(form: ConfigFormLike<T>, key: string): unknown {
  try {
    const value = form.getSnapshot().value
    if (typeof value !== 'object' || value === null) return undefined
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** Read a form's snapshot without letting a throwing form take the caller down. */
function readSnapshot<T>(form: ConfigFormLike<T>): ConfigFormSnapshotLike<T> | undefined {
  try {
    return form.getSnapshot()
  } catch {
    return undefined
  }
}

/** Normalize a thrown value into a message that carries no field value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Write one field, revision-aware.
 *
 * `set`/`unset` is the write primitive because it is the shape the Host's
 * shared-form contract actually exposes and the shape the reference
 * implementation uses; the Host owns the revision fence on the far side. The
 * revision is still read **before** the write and compared against the snapshot
 * that follows, because that is what tells a genuine refusal apart from the far
 * more common "somebody else wrote first": on a conflict the caller re-reads
 * (the form's subscription has already pushed the fresh snapshot) instead of
 * re-issuing its stale value over the other edit.
 *
 * Nothing here is swallowed: every path returns an outcome, and a refusal is
 * reported rather than rendered as applied.
 *
 * @param form - the bound form.
 * @param key - the config key.
 * @param value - the new value; `undefined` clears the field back to its default.
 * @returns the outcome, with the revisions involved when it failed.
 */
export async function saveField<T>(
  form: ConfigFormLike<T>,
  key: string,
  value: unknown,
): Promise<SaveOutcome> {
  const before = readSnapshot(form)
  const expectedRevision = before?.revision
  if (before?.writable === false) {
    return {
      ok: false,
      reason: 'unwritable',
      message: `配置项 ${keyLabel(key)} 当前不可写（该配置条目为只读）。`,
      expectedRevision,
    }
  }

  let answer: Promise<boolean>
  try {
    answer = value === undefined ? form.unset(key) : form.set(key, value)
  } catch (error) {
    return { ok: false, reason: 'error', message: messageOf(error), expectedRevision }
  }

  let accepted: boolean
  try {
    accepted = await answer
  } catch (error) {
    // A rejecting transport reports through the same failed-save surface.
    return { ok: false, reason: 'error', message: messageOf(error), expectedRevision }
  }

  const after = readSnapshot(form)
  const observedRevision = after?.revision
  if (accepted === false) {
    const moved =
      expectedRevision !== undefined && observedRevision !== undefined && observedRevision !== expectedRevision
    if (moved) {
      return {
        ok: false,
        reason: 'conflict',
        message: `配置项 ${keyLabel(key)} 未能保存：该配置在别处已被修改（revision ${expectedRevision} → ${observedRevision}），已重新读取，请核对后重试。`,
        expectedRevision,
        observedRevision,
      }
    }
    return {
      ok: false,
      reason: 'refused',
      message: `配置项 ${keyLabel(key)} 未能保存：宿主拒绝了这次写入。`,
      expectedRevision,
      observedRevision,
    }
  }
  return observedRevision === undefined ? { ok: true } : { ok: true, revision: observedRevision }
}

/**
 * Revision-fenced batch write through the adapter's own `mutate`.
 *
 * **Not on the live path.** The op shape is adapter-owned and is not documented
 * anywhere reachable from this package, so the settings page writes through
 * `set`/`unset` instead of guessing a shape a real Host might reject. This is
 * the fenced alternative, kept and tested so it can be switched on the moment
 * the op shape is confirmed; it passes the revision the caller read straight
 * through and never invents one.
 *
 * @param form - the bound form; it must expose `mutate`.
 * @param ops - the adapter's own op list.
 * @param expectedRevision - the revision read before building `ops`.
 * @returns the outcome, with the revisions involved when it failed.
 */
export async function mutateFields<T>(
  form: ConfigFormLike<T>,
  ops: readonly unknown[],
  expectedRevision?: number,
): Promise<SaveOutcome> {
  if (typeof form.mutate !== 'function') {
    return { ok: false, reason: 'error', message: '该配置表单不提供 revision 围栏写入（mutate）。', expectedRevision }
  }
  const before = readSnapshot(form)
  if (before?.writable === false) {
    return { ok: false, reason: 'unwritable', message: '该配置条目为只读。', expectedRevision }
  }
  let accepted: boolean
  try {
    accepted = await form.mutate(ops, expectedRevision)
  } catch (error) {
    return { ok: false, reason: 'conflict', message: messageOf(error), expectedRevision }
  }
  const after = readSnapshot(form)
  const observedRevision = after?.revision
  if (accepted === false) {
    return {
      ok: false,
      reason: 'conflict',
      message: `写入被拒绝：该配置在别处已被修改（期望 revision ${String(expectedRevision)}，当前 ${String(observedRevision)}），已重新读取。`,
      expectedRevision,
      observedRevision,
    }
  }
  return observedRevision === undefined ? { ok: true } : { ok: true, revision: observedRevision }
}
