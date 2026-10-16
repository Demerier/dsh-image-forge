/**
 * Reading plugin config out of the shape the Host actually hands an activation.
 *
 * Since DSH 0.2.0 a settings-editable field is declared `volatile()`, which
 * changes what the schema produces: a volatile field parses into a **stable
 * reference** read with `.get()`, not into a plain value, so the Host can commit
 * a settings save into the running fiber without remounting the row. The same
 * schema still parses a plain value when one is passed in, which is what every
 * profile patch and every test in this repository does.
 *
 * Everything downstream therefore has to accept `ref | value | absent` and
 * resolve it once, here, instead of at each of the twenty-odd read sites.
 */

/** A volatile field's reference: its owner updates it in place. */
export interface ConfigRef<T> {
  /** @returns the value currently committed for the running instance. */
  get(): T | undefined
}

/** One config field as the Host hands it over: a live reference, a plain value, or absent. */
export type ConfigField<T> = ConfigRef<T> | T | undefined

/** A config object as it arrives at `apply`, before resolution. */
export type ConfigRecord = Record<string, unknown>

/**
 * Whether a value is a volatile reference rather than data.
 *
 * Structural, because the reference crosses ESM/CJS copies and its class
 * identity is not something a plugin may rely on.
 *
 * @param value - the candidate.
 * @returns true when the value exposes `get()`.
 */
export function isConfigRef(value: unknown): value is ConfigRef<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { get?: unknown }).get === 'function'
  )
}

/**
 * Resolve one field, following a volatile reference.
 *
 * @param field - the field as it arrived.
 * @returns the committed value, or undefined when absent or unreadable.
 */
export function readConfigField<T>(field: ConfigField<T>): T | undefined {
  if (field === undefined || field === null) return undefined
  if (isConfigRef(field)) {
    try {
      return field.get() as T
    } catch {
      // A reference whose owner is torn down reads as absent rather than throwing.
      return undefined
    }
  }
  return field as T
}

/**
 * Resolve a whole config object into plain data.
 *
 * @param fields - the config as it arrived.
 * @returns a plain object holding each field's committed value, omitting
 *   unreadable references rather than storing `undefined` under their key.
 */
export function unwrapConfigFields(fields: ConfigRecord | undefined): ConfigRecord {
  const out: ConfigRecord = {}
  if (fields === undefined || fields === null) return out
  for (const [key, raw] of Object.entries(fields)) {
    if (isConfigRef(raw)) {
      const value = readConfigField(raw)
      if (value !== undefined) out[key] = value
      continue
    }
    out[key] = raw
  }
  return out
}

/**
 * Read a schema's own defaults, keeping **every** declared key.
 *
 * {@link unwrapConfigFields} drops a reference that resolves to `undefined`,
 * which is right for an activation's config but wrong for the schema itself: an
 * intentionally optional field — a nullable override whose "unset" is a real
 * state, not a missing value — would vanish from the resolved config and its key
 * would stop existing. Keeping the key with an `undefined` value preserves "this
 * field is declared and currently unset", which is what downstream code needs to
 * tell apart from "this field does not exist".
 *
 * @param parsed - a schema's output for the empty input.
 * @returns every declared key, with its default (possibly `undefined`).
 */
export function schemaDefaults(parsed: ConfigRecord): ConfigRecord {
  const out: ConfigRecord = {}
  for (const key of Object.keys(parsed)) out[key] = readConfigField(parsed[key] as ConfigField<unknown>)
  return out
}

/**
 * Merge an activation's config over the schema defaults.
 *
 * Keyed by the defaults, so a field the activation does not carry — an absent
 * reference, or a partial config from a test — keeps its default rather than
 * becoming `undefined`. A field explicitly set to an empty string is a value and
 * is kept; only `undefined` falls back.
 *
 * @param defaults - the schema defaults, already unwrapped.
 * @param config - the config as it arrived, or undefined.
 * @returns the resolved config.
 */
export function resolveConfigFields(defaults: ConfigRecord, config?: ConfigRecord): ConfigRecord {
  const resolved: ConfigRecord = { ...defaults }
  if (config === undefined || config === null) return resolved
  for (const key of Object.keys(defaults)) {
    if (!Object.hasOwn(config, key)) continue
    const value = readConfigField(config[key] as ConfigField<unknown>)
    if (value !== undefined) resolved[key] = value
  }
  return resolved
}
