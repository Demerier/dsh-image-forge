/**
 * Lightweight `@` mention parsing for the canvas prompt composer.
 *
 * The composer is a plain textarea, not a rich editor: the token remains visible
 * text while the picked picture is also added to the run's ordered reference
 * list. Keeping the range and replacement rules pure avoids a second, DOM-only
 * definition of what an active mention is.
 *
 * @module studio-mentions
 */

/** One picture the composer can offer after an `@`. */
export interface MentionCandidate {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly path?: string
  readonly nodeId?: string
  readonly previewUrl?: string
}

/** The active `@query` immediately before the caret. */
export interface MentionRange {
  readonly start: number
  readonly end: number
  readonly query: string
}

/** Locate the mention currently being typed, if any. */
export function mentionRangeAt(text: string, caret: number): MentionRange | undefined {
  const end = Math.max(0, Math.min(Math.trunc(caret), text.length))
  const at = text.lastIndexOf('@', Math.max(0, end - 1))
  if (at < 0 || at > end) return undefined
  if (at > 0 && /[A-Za-z0-9_.]/.test(text[at - 1] ?? '')) return undefined
  const query = text.slice(at + 1, end)
  if (/\s/.test(query) || query.includes('@')) return undefined
  return { start: at, end, query }
}

/** Filter in display order by label and path; already-held paths are omitted. */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  selectedPaths: readonly string[] = [],
  limit = 8,
): MentionCandidate[] {
  const needle = query.trim().toLocaleLowerCase()
  const held = new Set(selectedPaths)
  return candidates
    .filter((candidate) => candidate.path === undefined || !held.has(candidate.path))
    .filter((candidate) => {
      if (needle.length === 0) return true
      return candidate.label.toLocaleLowerCase().includes(needle)
        || (candidate.detail ?? '').toLocaleLowerCase().includes(needle)
        || (candidate.path ?? '').toLocaleLowerCase().includes(needle)
    })
    .slice(0, Math.max(0, limit))
}

/** Replace the active `@query` with the picked candidate's visible token. */
export function applyMention(
  text: string,
  range: MentionRange,
  label: string,
): { readonly prompt: string; readonly caret: number } {
  const token = `@${label.replace(/[@\r\n]+/g, ' ').trim()} `
  const prompt = text.slice(0, range.start) + token + text.slice(range.end)
  return { prompt, caret: range.start + token.length }
}
