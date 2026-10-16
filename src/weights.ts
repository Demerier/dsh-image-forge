/**
 * Weight management: does the local model exist, and how to get it.
 *
 * The mirror is `hf-mirror.com`, deliberately: on this machine `huggingface.co`
 * answers at its root but times out on `/api/` paths, so a download driven
 * through the canonical host stalls. Downloads are resumable (`Range`), hashed
 * against the repo's LFS `sha256` while streaming, and preceded by a disk-space
 * check — 10.6 GiB of weights must not fail at 95% because nobody counted.
 *
 * Nothing here deletes user data it did not create.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { statfs } from 'node:fs/promises'

/** One file of the pipeline, as the spike downloaded it. */
export interface WeightsFile {
  /** Repo-relative path, e.g. `transformer/config.json`. */
  readonly path: string
  /** Expected size in bytes; 0 when the listing did not report one. */
  readonly size: number
  /** sha256 from the repo's LFS metadata, when the listing reported it. */
  readonly sha256: string | null
}

/**
 * The pipeline's files, used as the fallback list when the mirror's tree API
 * cannot be reached (HEAD per file still works).
 */
export const KNOWN_FILES: readonly string[] = [
  'model_index.json',
  'scheduler/scheduler_config.json',
  'transformer/config.json',
  'transformer/diffusion_pytorch_model.safetensors',
  'text_encoder/config.json',
  'text_encoder/generation_config.json',
  'text_encoder/model.safetensors',
  'vae/config.json',
  'vae/diffusion_pytorch_model.safetensors',
  'processor/tokenizer.json',
  'processor/tokenizer_config.json',
  'processor/chat_template.jinja',
  'processor/processor_config.json',
]

/**
 * The policy for a weight file that is already on disk: **size is the gate, sha256 is not
 * re-run**.
 *
 * `hf-mirror` reports each LFS file's size *and* its sha256, and the plugin verifies the
 * hash of every byte **it transfers itself** (a fresh download, or the tail of a resumed
 * one — `seedHash` re-reads the existing prefix so the digest still covers the whole
 * file). A file that was already complete is matched on size alone: re-hashing 10.63 GiB
 * on every `fetch-weights` call would make a no-op call read the entire checkpoint off
 * disk. That is a deliberate trade, so the receipt says so out loud (`sha256_verified:
 * null` plus this note) instead of looking verified — a same-size corrupted file is
 * accepted as complete, and deleting it is the way to force a re-download.
 */
const REUSED_SIZE_ONLY =
  'size matches the mirror; sha256 not re-verified in this run — delete the file to force a re-download'

/** The tensor this pipeline never reads, and the file that carries it. */
export const UNUSED_TENSOR = { file: 'text_encoder/model.safetensors', tensor: 'lm_head.weight' } as const

/** What a local weights directory looks like right now. */
export interface WeightsInspection {
  readonly dir: string
  readonly exists: boolean
  /** Every known file is present with a non-zero size. */
  readonly ready: boolean
  readonly present_files: string[]
  readonly missing_files: string[]
  /** Sum of the known files' sizes on disk, in MiB. */
  readonly total_MiB: number
  /** The bnb split flag is set in both configs, as the CPU/GPU split requires. */
  readonly quantization_flag: boolean | null
  readonly note?: string
}

/** One file's state inside a fetch report. */
export interface FetchFileReport {
  readonly path: string
  readonly status: 'downloaded' | 'resumed' | 'reused' | 'skipped' | 'would-download' | 'failed'
  readonly bytes: number
  readonly MiB: number
  readonly seconds: number
  readonly sha256_verified: boolean | null
  readonly note?: string
}

/** Result of `runFetchWeights`. */
export interface FetchReport {
  readonly action: 'fetch-weights'
  readonly dry_run: boolean
  readonly ok: boolean
  readonly repo: string
  readonly mirror: string
  readonly dir: string
  readonly listing_source: 'api' | 'head' | 'known'
  readonly api_note?: string
  readonly files: FetchFileReport[]
  readonly planned_MiB: number
  readonly disk: { freeMiB: number; neededMiB: number; enough: boolean; note?: string }
  readonly quantization: Record<string, unknown> | null
  readonly lm_head: Record<string, unknown> | null
  readonly inspection: WeightsInspection
  readonly next: string
  readonly dry_run_skipped?: string
}

/** Options for `runFetchWeights`. */
export interface FetchWeightsOptions {
  readonly repo: string
  readonly mirror: string
  readonly revision: string
  readonly dir: string
  /** Remove the unused `lm_head.weight` tensor from the text encoder afterwards. */
  readonly skipLmHead: boolean
  readonly dryRun: boolean
  /** Skip the disk-space check (for a user who knows better). */
  readonly force: boolean
  readonly scratchDir: string
  /** Per-request stall budget: no bytes for this long aborts the transfer. */
  readonly stallTimeoutMs: number
  readonly signal?: AbortSignal
}

/**
 * Is this file on disk already complete?
 *
 * Tensor files must be byte-exact. JSON config files are exempt from the size
 * check on purpose: this plugin patches `quantization_config` inside two of them
 * for the bnb CPU/GPU split, so their size legitimately differs from the repo's
 * copy — and "re-download because the size differs" would silently undo that
 * patch on every run.
 *
 * @param relative - repo-relative path.
 * @param expected - size the listing reported (0 when unknown).
 * @param actual - size on disk.
 * @returns true when the file may be left alone.
 */
function fileIsComplete(relative: string, expected: number, actual: number): boolean {
  if (actual <= 0) return false
  if (!relative.endsWith('.safetensors')) return true
  return expected <= 0 || actual === expected
}

/** Read `quantization_config.llm_int8_enable_fp32_cpu_offload` from a config file. */
async function readQuantFlag(path: string): Promise<boolean | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const quantization = parsed.quantization_config
    if (typeof quantization !== 'object' || quantization === null) return null
    return (quantization as Record<string, unknown>).llm_int8_enable_fp32_cpu_offload === true
  } catch {
    return null
  }
}

/**
 * Inspect a weights directory without touching it.
 *
 * @param dir - candidate model directory.
 * @returns what is there, what is missing, and whether the bnb flag is set.
 */
export async function inspectWeights(dir: string): Promise<WeightsInspection> {
  const present: string[] = []
  const missing: string[] = []
  let totalBytes = 0
  for (const relative of KNOWN_FILES) {
    try {
      const info = await stat(join(dir, relative))
      if (info.isFile() && info.size > 0) {
        present.push(relative)
        totalBytes += info.size
      } else {
        missing.push(relative)
      }
    } catch {
      missing.push(relative)
    }
  }
  const transformerFlag = await readQuantFlag(join(dir, 'transformer', 'config.json'))
  const textEncoderFlag = await readQuantFlag(join(dir, 'text_encoder', 'config.json'))
  const exists = await stat(dir).then(
    () => true,
    () => false,
  )
  return {
    dir,
    exists,
    ready: missing.length === 0,
    present_files: present,
    missing_files: missing,
    total_MiB: Math.round(totalBytes / 1024 / 1024),
    quantization_flag: transformerFlag === null || textEncoderFlag === null ? null : transformerFlag && textEncoderFlag,
    note:
      transformerFlag === true && textEncoderFlag === true
        ? undefined
        : 'both transformer/config.json and text_encoder/config.json need quantization_config.llm_int8_enable_fp32_cpu_offload = true for the bnb CPU/GPU split',
  }
}

/** Free space in MiB on the volume holding a directory (creating it first). */
async function freeSpaceMiB(dir: string): Promise<{ freeMiB: number; note?: string }> {
  try {
    await mkdir(dir, { recursive: true })
    const stats = await statfs(dir)
    return { freeMiB: Math.round((Number(stats.bavail) * Number(stats.bsize)) / 1024 / 1024) }
  } catch (error) {
    return { freeMiB: -1, note: `cannot stat ${dir}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Type-guard-ish read of the mirror's tree API payload. */
function parseTreePayload(payload: unknown): WeightsFile[] {
  if (!Array.isArray(payload)) return []
  const files: WeightsFile[] = []
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (record.type !== 'file' || typeof record.path !== 'string') continue
    // Repo metadata (`.gitattributes`, …) is never part of a diffusers pipeline:
    // downloading it would add junk to the model directory and keep an otherwise
    // complete snapshot looking "incomplete".
    if (record.path.split('/').some((segment) => segment.startsWith('.'))) continue
    const lfs = typeof record.lfs === 'object' && record.lfs !== null ? (record.lfs as Record<string, unknown>) : null
    const size = typeof lfs?.size === 'number' ? lfs.size : typeof record.size === 'number' ? record.size : 0
    const oid = typeof lfs?.oid === 'string' && /^[0-9a-f]{64}$/.test(lfs.oid) ? lfs.oid : null
    files.push({ path: record.path, size, sha256: oid })
  }
  return files
}

/** HEAD one resolve URL for its Content-Length. */
async function headSize(url: string, timeoutMs: number): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Number(response.headers.get('content-length') ?? 0)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * List the repo's files from the mirror.
 *
 * @param options - repo, revision, mirror, and the HEAD fallback's budget.
 * @returns the file list and which mechanism produced it.
 */
export async function listRepoFiles(options: {
  repo: string
  mirror: string
  revision: string
  headTimeoutMs?: number
}): Promise<{ files: WeightsFile[]; source: 'api' | 'head' | 'known'; apiNote?: string }> {
  const apiUrl = `${options.mirror}/api/models/${options.repo}/tree/${options.revision}?recursive=true`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), 30_000)
  let apiNote: string | undefined
  try {
    const response = await fetch(apiUrl, { signal: controller.signal })
    if (response.ok) {
      const files = parseTreePayload(await response.json())
      if (files.length > 0) return { files, source: 'api' }
      apiNote = `${apiUrl} answered but listed no files`
    } else {
      apiNote = `${apiUrl} answered HTTP ${response.status}`
    }
  } catch (error) {
    apiNote = `${apiUrl}: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    clearTimeout(timer)
  }
  const files: WeightsFile[] = []
  let headFailures = 0
  for (const relative of KNOWN_FILES) {
    try {
      const size = await headSize(
        `${options.mirror}/${options.repo}/resolve/${options.revision}/${relative}`,
        options.headTimeoutMs ?? 60_000,
      )
      files.push({ path: relative, size, sha256: null })
    } catch {
      headFailures += 1
      files.push({ path: relative, size: 0, sha256: null })
    }
  }
  if (headFailures === KNOWN_FILES.length) return { files, source: 'known', apiNote }
  return { files, source: 'head', apiNote }
}

/** Hash the bytes already on disk, so a resumed download can keep verifying. */
async function seedHash(path: string): Promise<{ hash: ReturnType<typeof createHash>; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  try {
    const info = await stat(path)
    if (info.size === 0) return { hash, bytes: 0 }
    const stream = createReadStream(path)
    for await (const chunk of stream) {
      hash.update(chunk as Buffer)
      bytes += (chunk as Buffer).length
    }
  } catch {
    /* no partial file */
  }
  return { hash, bytes }
}

/** One file's transfer, resumable and hash-checked. */
async function downloadFile(
  options: FetchWeightsOptions,
  file: WeightsFile,
): Promise<FetchFileReport> {
  const destination = join(options.dir, file.path.replace(/\//g, process.platform === 'win32' ? '\\' : '/'))
  await mkdir(dirname(destination), { recursive: true })
  const existing = await stat(destination).then(
    (info) => info.size,
    () => 0,
  )
  if (file.size > 0 && existing === file.size) {
    return { path: file.path, status: 'reused', bytes: existing, MiB: existing / 1024 / 1024, seconds: 0, sha256_verified: null, note: REUSED_SIZE_ONLY }
  }
  const url = `${options.mirror}/${options.repo}/resolve/${options.revision}/${file.path}`
  const { hash, bytes: have } = existing > 0 ? await seedHash(destination) : { hash: createHash('sha256'), bytes: 0 }
  const started = Date.now()
  const controller = new AbortController()
  let stall: NodeJS.Timeout | null = null
  const armStall = () => {
    if (stall !== null) clearTimeout(stall)
    stall = setTimeout(() => controller.abort(new Error(`no data for ${options.stallTimeoutMs} ms`)), options.stallTimeoutMs)
  }
  const onCallerAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  let written = 0
  try {
    armStall()
    const headers: Record<string, string> = { 'User-Agent': 'dsh-image-forge/0.2' }
    if (have > 0) headers.Range = `bytes=${have}-`
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) {
      return {
        path: file.path,
        status: 'failed',
        bytes: have,
        MiB: have / 1024 / 1024,
        seconds: (Date.now() - started) / 1000,
        sha256_verified: null,
        note: `HTTP ${response.status} from ${url}`,
      }
    }
    const resuming = response.status === 206 && have > 0
    const sink = createWriteStream(destination, { flags: resuming ? 'a' : 'w' })
    const body = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      written += chunk.length
      armStall()
    })
    await pipeline(body, sink)
    const total = (resuming ? have : 0) + written
    if (file.size > 0 && total !== file.size) {
      return {
        path: file.path,
        status: 'failed',
        bytes: total,
        MiB: total / 1024 / 1024,
        seconds: (Date.now() - started) / 1000,
        sha256_verified: null,
        note: `size mismatch: got ${total} B, expected ${file.size} B (re-run to resume)`,
      }
    }
    const digest = hash.digest('hex')
    if (file.sha256 !== null && digest !== file.sha256) {
      await rm(destination, { force: true })
      return {
        path: file.path,
        status: 'failed',
        bytes: 0,
        MiB: 0,
        seconds: (Date.now() - started) / 1000,
        sha256_verified: false,
        note: `sha256 mismatch (expected ${file.sha256}, got ${digest}); the partial file was deleted, re-run to download it again`,
      }
    }
    return {
      path: file.path,
      status: resuming ? 'resumed' : 'downloaded',
      bytes: total,
      MiB: total / 1024 / 1024,
      seconds: (Date.now() - started) / 1000,
      sha256_verified: file.sha256 === null ? null : true,
    }
  } catch (error) {
    return {
      path: file.path,
      status: 'failed',
      bytes: have + written,
      MiB: (have + written) / 1024 / 1024,
      seconds: (Date.now() - started) / 1000,
      sha256_verified: null,
      note: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (stall !== null) clearTimeout(stall)
    options.signal?.removeEventListener('abort', onCallerAbort)
  }
}

/**
 * Set the bnb split flag in both configs, which the CPU/GPU placement requires.
 *
 * @param dir - model directory.
 * @returns per-file outcome; a file whose flag was already set is left alone.
 */
export async function applyQuantizationFlag(dir: string): Promise<Record<string, unknown>> {
  const outcome: Record<string, unknown> = {}
  for (const relative of ['transformer/config.json', 'text_encoder/config.json']) {
    const path = join(dir, relative)
    try {
      const original = await readFile(path, 'utf8')
      const parsed = JSON.parse(original) as Record<string, unknown>
      const quantization =
        typeof parsed.quantization_config === 'object' && parsed.quantization_config !== null
          ? (parsed.quantization_config as Record<string, unknown>)
          : {}
      const alreadySet = quantization.llm_int8_enable_fp32_cpu_offload === true
      quantization.llm_int8_enable_fp32_cpu_offload = true
      parsed.quantization_config = quantization
      // Give `llm_int8_threshold` a decimal point. The mirror ships `6.0`, but JS has a single
      // number type, so `JSON.stringify` would write `6` — and diffusers'
      // `BitsAndBytesConfig.post_init` requires a Python float, so the re-serialized config dies
      // on load with `TypeError: llm_int8_threshold must be a float`.
      const text = `${JSON.stringify(parsed, null, 2).replace(/("llm_int8_threshold"\s*:\s*)(-?\d+)(?=[\s,}])/g, '$1$2.0')}\n`
      if (alreadySet && original === text) {
        outcome[relative] = 'already set'
        continue
      }
      await writeFile(path, text, 'utf8')
      outcome[relative] = alreadySet ? 'patched (threshold dtype)' : 'patched'
    } catch (error) {
      outcome[relative] = `failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return outcome
}

/**
 * Rewrite a `.safetensors` file without one tensor.
 *
 * The tensor map is the file's own JSON header; the data section is copied
 * verbatim (only the dropped tensor's byte range is left out, and the surviving
 * offsets are shifted), so no tensor content is ever re-encoded. The result is
 * written beside the original and replaces it only after the new header reads
 * back without the tensor and the file length matches.
 *
 * @param file - absolute `.safetensors` path.
 * @param tensor - tensor name to drop.
 * @returns bytes saved, or a note explaining why nothing was done.
 */
export async function stripTensor(
  file: string,
  tensor: string,
): Promise<{ removed: boolean; savedBytes: number; note?: string }> {
  const handle = await open(file, 'r')
  let headerLength = 0
  let removedBytes = 0
  let expectedSize = 0
  let strippedPath = `${file}.stripped`
  try {
    const lengthBuffer = Buffer.alloc(8)
    await handle.read(lengthBuffer, 0, 8, 0)
    headerLength = Number(lengthBuffer.readBigUInt64LE(0))
    const headerBuffer = Buffer.alloc(headerLength)
    await handle.read(headerBuffer, 0, headerLength, 8)
    const header = JSON.parse(headerBuffer.toString('utf8')) as Record<string, unknown>
    const entry = header[tensor]
    if (typeof entry !== 'object' || entry === null) {
      return { removed: false, savedBytes: 0, note: `${tensor} is not in ${file}` }
    }
    const [from, to] = (entry as { data_offsets: [number, number] }).data_offsets
    removedBytes = to - from
    if (removedBytes <= 0) return { removed: false, savedBytes: 0, note: `${tensor} occupies no bytes in ${file}` }
    const kept: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(header)) {
      if (name === tensor) continue
      if (name === '__metadata__') {
        kept.__metadata__ = value
        continue
      }
      const cast = value as { data_offsets: [number, number] }
      const [start, end] = cast.data_offsets
      cast.data_offsets = [start > from ? start - removedBytes : start, end > from ? end - removedBytes : end]
      kept[name] = cast
    }
    const rawHeader = Buffer.from(JSON.stringify(kept), 'utf8')
    const paddedHeader = Buffer.alloc(Math.ceil(rawHeader.length / 8) * 8, 0x20)
    rawHeader.copy(paddedHeader)

    const totalBytes = (await handle.stat()).size
    const dataStart = 8 + headerLength
    const dataLength = totalBytes - dataStart
    const keptRanges: [number, number][] = [
      [0, from],
      [to, dataLength],
    ].filter(([start, end]) => end > start) as [number, number][]

    const sink = createWriteStream(strippedPath)
    const prefix = Buffer.alloc(8)
    prefix.writeBigUInt64LE(BigInt(paddedHeader.length))
    sink.write(prefix)
    sink.write(paddedHeader)
    const chunkSize = 8 * 1024 * 1024
    for (const [start, end] of keptRanges) {
      for (let position = start; position < end; position += chunkSize) {
        const size = Math.min(chunkSize, end - position)
        const buffer = Buffer.alloc(size)
        await handle.read(buffer, 0, size, dataStart + position)
        sink.write(buffer)
      }
    }
    await new Promise<void>((resolve, reject) => {
      sink.end((error?: Error | null) => (error ? reject(error) : resolve()))
    })
    expectedSize = 8 + paddedHeader.length + (dataLength - removedBytes)
  } finally {
    // Windows refuses to replace a file that still has an open handle.
    await handle.close()
  }

  try {
    const verify = await open(strippedPath, 'r')
    try {
      const verifyLength = Buffer.alloc(8)
      await verify.read(verifyLength, 0, 8, 0)
      const verifyHeader = Buffer.alloc(Number(verifyLength.readBigUInt64LE(0)))
      await verify.read(verifyHeader, 0, verifyHeader.length, 8)
      const parsed = JSON.parse(verifyHeader.toString('utf8')) as Record<string, unknown>
      const rewritten = (await verify.stat()).size
      if (tensor in parsed || rewritten !== expectedSize) {
        return {
          removed: false,
          savedBytes: 0,
          note: `verification failed (tensor present: ${tensor in parsed}, size ${rewritten} B vs expected ${expectedSize} B); the original file is untouched`,
        }
      }
    } finally {
      await verify.close()
    }
    await rename(strippedPath, file)
    return { removed: true, savedBytes: removedBytes }
  } catch (error) {
    return {
      removed: false,
      savedBytes: 0,
      note: `${error instanceof Error ? error.message : String(error)}; the original file is untouched (the rewritten copy is at ${strippedPath})`,
    }
  }
}

/**
 * Fetch the weights from the mirror.
 *
 * @param options - resolved config plus the dry-run switch.
 * @returns a per-file report; a failed file is reported, never thrown.
 */
export async function runFetchWeights(options: FetchWeightsOptions): Promise<FetchReport> {
  const listing = await listRepoFiles({
    repo: options.repo,
    mirror: options.mirror,
    revision: options.revision,
    headTimeoutMs: 60_000,
  })
  const files = listing.files
  const present = new Set<string>()
  let missingBytes = 0
  for (const file of files) {
    const info = await stat(join(options.dir, file.path)).catch(() => null)
    if (info !== null && fileIsComplete(file.path, file.size, info.size)) {
      present.add(file.path)
      continue
    }
    missingBytes += file.size
  }
  const space = await freeSpaceMiB(options.dir)
  const neededMiB = Math.ceil((missingBytes / 1024 / 1024) * 1.02)
  const enough = space.freeMiB < 0 || space.freeMiB >= neededMiB
  const disk = { freeMiB: space.freeMiB, neededMiB, enough, note: space.note }

  const build = (
    fileReports: FetchFileReport[],
    ok: boolean,
    inspection: WeightsInspection,
    quantization: Record<string, unknown> | null,
    lmHead: Record<string, unknown> | null,
  ): FetchReport => ({
    action: 'fetch-weights',
    dry_run: options.dryRun,
    ok,
    repo: options.repo,
    mirror: options.mirror,
    dir: options.dir,
    listing_source: listing.source,
    api_note: listing.apiNote,
    files: fileReports,
    planned_MiB: neededMiB,
    disk,
    quantization,
    lm_head: lmHead,
    inspection,
    next: ok
      ? 'Weights ready. `qwen_image_generate` can start the worker now.'
      : 'Re-run `action:"fetch-weights"` to resume; completed files are skipped, partial files continue from where they stopped.',
  })

  if (options.dryRun) {
    const reports: FetchFileReport[] = files.map((file) => ({
      path: file.path,
      status: present.has(file.path) ? 'reused' : 'would-download',
      bytes: file.size,
      MiB: file.size / 1024 / 1024,
      seconds: 0,
      sha256_verified: null,
    }))
    // A plan must not read as "done": the old wording reported every missing file as
    // `skipped` and `next: "Weights ready."` while `inspection.ready` was false and
    // `missing_files` listed all of them — a contradiction on the one question a
    // fresh install actually asks.
    const ready = files.length > 0 && present.size === files.length
    return {
      ...build(reports, true, await inspectWeights(options.dir), null, null),
      dry_run_skipped: 'nothing was downloaded; this is a plan',
      next: ready
        ? 'Every file is already on disk and complete — nothing to download.'
        : `Plan only: ${files.length - present.size} of ${files.length} file(s) are missing and would need ${neededMiB} MiB; nothing was downloaded. Re-run without \`dryRun\` to fetch them.`,
    }
  }

  if (!enough && !options.force) {
    const report = build([], false, await inspectWeights(options.dir), null, null)
    return {
      ...report,
      next:
        `Only ${space.freeMiB} MiB free on the volume holding ${options.dir}, but ${neededMiB} MiB is needed. ` +
        'Free space, point `modelsDir` at another volume, or pass `force:true` to try anyway.',
    }
  }

  const reports: FetchFileReport[] = []
  for (const file of files) {
    if (present.has(file.path)) {
      reports.push({ path: file.path, status: 'reused', bytes: file.size, MiB: file.size / 1024 / 1024, seconds: 0, sha256_verified: null, note: REUSED_SIZE_ONLY })
      continue
    }
    reports.push(await downloadFile(options, file))
    if (options.signal?.aborted) break
  }
  const failed = reports.filter((report) => report.status === 'failed')
  const quantization = failed.length === 0 ? await applyQuantizationFlag(options.dir) : null
  let lmHead: Record<string, unknown> | null = null
  if (failed.length === 0 && options.skipLmHead) {
    const target = join(options.dir, UNUSED_TENSOR.file)
    const outcome = await stripTensor(target, UNUSED_TENSOR.tensor).catch((error: unknown) => ({
      removed: false,
      savedBytes: 0,
      note: error instanceof Error ? error.message : String(error),
    }))
    lmHead = {
      ...outcome,
      savedMiB: Math.round(outcome.savedBytes / 1024 / 1024),
      file: UNUSED_TENSOR.file,
      verified_on_this_machine: false,
    }
  }
  return build(reports, failed.length === 0, await inspectWeights(options.dir), quantization, lmHead)
}
