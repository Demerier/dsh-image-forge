/**
 * Pure draft, validation and batch-save rules for the settings page.
 *
 * The DSH config form only exposes per-field `set`/`unset`; it has no confirmed
 * transaction shape. This module therefore performs a best-effort transaction:
 * validate everything first, write sequentially, and if a write fails restore
 * the fields already attempted in reverse order. The caller keeps its draft
 * whenever the batch did not land completely.
 */
import { SETTINGS_FIELDS, type SettingsField } from './settings-fields.ts'
import { saveField, type ConfigFormLike } from './settings-section.ts'

/** One editable value in the local draft. */
export type SettingsDraftEntry =
  | { readonly kind: 'value'; readonly value: string | boolean }
  | { readonly kind: 'unset' }

/** Draft entries keyed by config field. */
export type SettingsDraft = Readonly<Record<string, SettingsDraftEntry>>

/** One validation failure, tied to its control. */
export interface SettingsDraftError {
  readonly key: string
  readonly message: string
}

/** One validated write. */
export interface SettingsChange {
  readonly key: string
  readonly label: string
  readonly unset: boolean
  readonly value?: unknown
}

/** Result of one batch save. */
export interface SettingsBatchResult {
  readonly status: 'saved' | 'invalid' | 'conflict' | 'rolled-back' | 'rollback-partial'
  readonly changed: readonly string[]
  readonly failedKey?: string
  readonly message?: string
  readonly rollbackFailed: readonly string[]
  readonly revision?: number
  readonly errors?: readonly SettingsDraftError[]
}

/** Build a draft that exactly mirrors one form snapshot. */
export function draftFromValues(
  fields: readonly SettingsField[],
  values: Readonly<Record<string, unknown>>,
): Record<string, SettingsDraftEntry> {
  const draft: Record<string, SettingsDraftEntry> = {}
  for (const field of fields) {
    const value = values[field.key]
    draft[field.key] = field.kind === 'boolean'
      ? { kind: 'value', value: value === true }
      : { kind: 'value', value: value === undefined || value === null ? '' : String(value) }
  }
  return draft
}

/** Normalize a field entry into its write value, or report why it cannot be saved. */
function normalizeEntry(
  field: SettingsField,
  entry: SettingsDraftEntry,
): { unset: boolean; value?: unknown; error?: string } {
  if (entry.kind === 'unset') return { unset: true }

  if (field.kind === 'boolean') {
    return typeof entry.value === 'boolean'
      ? { unset: false, value: entry.value }
      : { unset: false, error: '需要一个开/关值。' }
  }

  if (field.kind === 'number') {
    const text = String(entry.value).trim()
    if (text.length === 0) {
      return field.nullable === true
        ? { unset: true }
        : { unset: false, error: '不能为空。' }
    }
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return { unset: false, error: '请输入有效数字。' }
    if (field.min !== undefined && parsed < field.min) {
      return { unset: false, error: `不能小于 ${String(field.min)}。` }
    }
    if (field.max !== undefined && parsed > field.max) {
      return { unset: false, error: `不能大于 ${String(field.max)}。` }
    }
    return { unset: false, value: parsed }
  }

  if (field.kind === 'enum') {
    const text = String(entry.value)
    if ((field.choices ?? []).some((choice) => choice.value === text)) {
      return { unset: false, value: text }
    }
    return { unset: false, error: '请选择一个有效选项。' }
  }

  const text = String(entry.value)
  if (field.key === 'comfyEndpoint' && text.trim().length > 0) {
    try {
      const url = new URL(text.trim())
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { unset: false, error: '地址必须以 http:// 或 https:// 开头。' }
      }
      return { unset: false, value: text.trim() }
    } catch {
      return { unset: false, error: '请输入有效的 HTTP(S) 地址。' }
    }
  }
  if (field.key === 'comfyPorts') {
    const ports = text.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
    if (ports.length === 0) return { unset: false, error: '至少填写一个候选端口。' }
    for (const portText of ports) {
      if (!/^\d+$/.test(portText)) return { unset: false, error: '端口必须是逗号分隔的整数。' }
      const port = Number(portText)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { unset: false, error: '每个端口都必须在 1–65535 之间。' }
      }
    }
    return { unset: false, value: ports.join(',') }
  }
  return { unset: false, value: text }
}

/** Compare two values after normalization. */
function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right)
}

/** Validate a draft and return only the writes that differ from `values`. */
export function normalizeSettingsDraft(
  fields: readonly SettingsField[],
  draft: SettingsDraft,
  values: Readonly<Record<string, unknown>>,
): { changes: SettingsChange[]; errors: SettingsDraftError[] } {
  const changes: SettingsChange[] = []
  const errors: SettingsDraftError[] = []
  for (const field of fields) {
    const entry = draft[field.key]
    if (entry === undefined) continue
    const normalized = normalizeEntry(field, entry)
    if (normalized.error !== undefined) {
      errors.push({ key: field.key, message: normalized.error })
      continue
    }
    if (normalized.unset) {
      if (entry.kind === 'unset' || (values[field.key] !== undefined && values[field.key] !== null)) changes.push({ key: field.key, label: field.label, unset: true })
      continue
    }
    if (!sameValue(normalized.value, values[field.key])) {
      changes.push({
        key: field.key,
        label: field.label,
        unset: false,
        ...(normalized.value === undefined ? {} : { value: normalized.value }),
      })
    }
  }
  return { changes, errors }
}

/** Keys currently diverging from the server snapshot, including invalid input. */
export function dirtySettingsKeys(
  fields: readonly SettingsField[],
  draft: SettingsDraft,
  values: Readonly<Record<string, unknown>>,
): string[] {
  const dirty: string[] = []
  for (const field of fields) {
    const entry = draft[field.key]
    if (entry === undefined) continue
    const normalized = normalizeEntry(field, entry)
    if (normalized.error !== undefined || (normalized.unset && (entry.kind === 'unset' || (values[field.key] !== undefined && values[field.key] !== null))) || (!normalized.unset && !sameValue(normalized.value, values[field.key]))) {
      dirty.push(field.key)
    }
  }
  return dirty
}

/** Current revision, when the form serves one. */
function revisionOf(form: ConfigFormLike<unknown>): number | undefined {
  try {
    return form.getSnapshot().revision
  } catch {
    return undefined
  }
}

/**
 * Save one draft, rolling back attempted fields in reverse order on failure.
 *
 * A revision conflict is not rolled back: another writer changed the entry, and
 * replaying this page's values over that edit would be worse than a partial
 * save. The UI requires an explicit reload in that case.
 */
export async function commitSettingsDraft(
  form: ConfigFormLike<unknown>,
  fields: readonly SettingsField[],
  draft: SettingsDraft,
  values: Readonly<Record<string, unknown>>,
  baselineRevision?: number,
  onProgress?: (completed: number, total: number, key: string) => void,
): Promise<SettingsBatchResult> {
  const normalized = normalizeSettingsDraft(fields, draft, values)
  if (normalized.errors.length > 0) {
    return {
      status: 'invalid',
      changed: [],
      rollbackFailed: [],
      errors: normalized.errors,
      message: '还有配置项需要修正。',
    }
  }
  if (normalized.changes.length === 0) {
    return { status: 'saved', changed: [], rollbackFailed: [], revision: revisionOf(form) }
  }

  const currentRevision = revisionOf(form)
  if (baselineRevision !== undefined && currentRevision !== undefined && currentRevision !== baselineRevision) {
    return {
      status: 'conflict',
      changed: [],
      rollbackFailed: [],
      revision: currentRevision,
      message: '配置已在别处更新；请重新载入后再保存。',
    }
  }

  const attempted: SettingsChange[] = []
  for (const change of normalized.changes) {
    attempted.push(change)
    const outcome = await saveField(form, change.key, change.unset ? undefined : change.value)
    onProgress?.(attempted.length, normalized.changes.length, change.key)
    if (!outcome.ok) {
      if ('reason' in outcome && outcome.reason === 'conflict') {
        return {
          status: 'conflict',
          changed: attempted.map((entry) => entry.key),
          failedKey: change.key,
          rollbackFailed: attempted.map((entry) => entry.key),
          revision: revisionOf(form),
          message: `${change.label} 保存时遇到外部修改；请重新载入后再处理。`,
        }
      }

      const rollbackFailed: string[] = []
      for (const written of [...attempted].reverse()) {
        const original = values[written.key]
        const rollback = await saveField(form, written.key, original === undefined || original === null ? undefined : original)
        if (!rollback.ok) rollbackFailed.push(written.key)
      }
      const latestRevision = revisionOf(form)
      return rollbackFailed.length === 0
        ? {
            status: 'rolled-back',
            changed: attempted.map((entry) => entry.key),
            failedKey: change.key,
            rollbackFailed,
            revision: latestRevision,
            message: `${change.label} 保存失败；已尝试回滚之前的修改。`,
          }
        : {
            status: 'rollback-partial',
            changed: attempted.map((entry) => entry.key),
            failedKey: change.key,
            rollbackFailed,
            revision: latestRevision,
            message: `${change.label} 保存失败，且部分字段未能回滚。`,
          }
    }
  }

  return {
    status: 'saved',
    changed: normalized.changes.map((entry) => entry.key),
    rollbackFailed: [],
    revision: revisionOf(form),
  }
}

/** Every field the page knows about, exported for callers that do not carry the table. */
export const SETTINGS_DRAFT_FIELDS = SETTINGS_FIELDS
