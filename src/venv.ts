/**
 * The plugin-owned Python environment: venv creation, the torch wheel matrix, and
 * package installs.
 *
 * Three host facts shape this module:
 *
 * 1. `python -m venv` can fail at `ensurepip` because the sandbox makes
 *    mode-0o700 directories unwritable; the documented fallback is
 *    `--without-pip` plus copying pip in from the base interpreter.
 * 2. Every pip call goes through `resources/pipwrap.py` **with the venv's own
 *    interpreter**, because plain pip dies with `PermissionError [Errno 13]` on
 *    this host and `pip --python <other>` would bypass the patch.
 * 3. A CUDA torch already on the machine must not be downloaded again: the venv
 *    is asked first, then the base interpreter (reused through
 *    `--system-site-packages`).
 */
import { cpSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { executableMissing, pathExists, runCaptured, type RunResult } from './procx.ts'

/** Packages the worker imports, in the versions the spike proved out. */
export const RUNTIME_PACKAGES = [
  'diffusers==0.41.0',
  'transformers==5.14.1',
  'accelerate',
  'safetensors',
  'sentencepiece',
  'bitsandbytes',
  'psutil',
  'einops',
  'protobuf',
] as const

/** Torch build the CV check orders by: newest CUDA first, then the proven one. */
export const TORCH_WHEEL_MATRIX = ['cu128', 'cu126', 'cu118'] as const

/** Pinned torch, so a rerun reproduces the environment the spike measured. */
export const TORCH_PIN = ['torch==2.9.1', 'torchvision'] as const

/** Python the worker needs; 3.12 is what the spike used, 3.10 is the floor for the deps. */
const MINIMUM_PYTHON = [3, 10] as const

/** Interpreter and tools status of one python, or why it could not be read. */
export interface InterpreterInfo {
  /** The path that was asked. */
  readonly path: string
  /** The interpreter answered a version query. */
  readonly ok: boolean
  /** Absolute `sys.executable` as the interpreter reports it. */
  readonly executable?: string
  /** Full version string, e.g. `3.12.10`. */
  readonly version?: string
  /** Major/minor tuple, for the version floor. */
  readonly majorMinor?: [number, number]
  /** Why the query failed. */
  readonly note?: string
}

/** Everything `status` wants to know about the installed packages. */
export interface PackageReport {
  /** Every probed package resolved an importable version. */
  readonly ok: boolean
  /** Package name → installed version, or null when the import failed. */
  readonly versions: Record<string, string | null>
  /** Torch build details, when torch itself is importable. */
  readonly torch: { version: string; cuda: string | null; cudaAvailable: boolean } | null
  /** Why the probe is incomplete. */
  readonly note?: string
}

/** Paths of the environment this plugin owns under `runtimeDir`. */
export interface VenvPaths {
  readonly runtimeDir: string
  readonly venvDir: string
  /** The venv's python: `<venv>/Scripts/python.exe` or `<venv>/bin/python`. */
  readonly python: string
}

/**
 * Resolve the venv layout for a runtime directory.
 *
 * @param runtimeDir - plugin-owned data directory.
 * @returns the venv directory and the interpreter inside it.
 */
export function venvPaths(runtimeDir: string): VenvPaths {
  const venvDir = join(runtimeDir, 'venv')
  const python =
    process.platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
  return { runtimeDir, venvDir, python }
}

/**
 * Run one python snippet and parse the JSON it prints as its last line.
 *
 * Scope, on purpose: only a line starting with `{` is accepted, so the snippet must print
 * an **object**. `json.dumps(["…"])` (a list) is silently ignored and the caller sees
 * `null` — that is how `copyPip` used to lose the base interpreter's site-packages while
 * reporting only "could not locate", with nothing in the output to point at the parse.
 * A snippet that must return several values should wrap them in an object.
 */
async function pythonJson<T>(
  python: string,
  code: string,
  options: { timeoutMs?: number; scratchDir?: string; label?: string },
): Promise<{ value: T | null; result: RunResult }> {
  const result = await runCaptured(python, ['-c', code], {
    timeoutMs: options.timeoutMs ?? 30_000,
    scratchDir: options.scratchDir,
    label: options.label ?? 'python',
    env: { PYTHONIOENCODING: 'utf-8' },
  })
  const lines = result.output.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'))
  const last = lines.at(-1)
  if (last === undefined) return { value: null, result }
  try {
    return { value: JSON.parse(last) as T, result }
  } catch {
    return { value: null, result }
  }
}

/** Ask an interpreter for its version. */
export async function probeInterpreter(
  python: string,
  options: { timeoutMs?: number; scratchDir?: string } = {},
): Promise<InterpreterInfo> {
  if (executableMissing(python)) return { path: python, ok: false, note: `not found: ${python}` }
  const { value, result } = await pythonJson<{ executable: string; version: string }>(
    python,
    'import json,sys;print(json.dumps({"executable":sys.executable,"version":"%d.%d.%d"%sys.version_info[:3]}))',
    options,
  )
  if (value === null) {
    return { path: python, ok: false, note: `version query failed: ${result.output.slice(-400) || result.note || 'no output'}` }
  }
  const parts = value.version.split('.').map((part) => Number(part))
  return {
    path: python,
    ok: true,
    executable: value.executable,
    version: value.version,
    majorMinor: [parts[0] ?? 0, parts[1] ?? 0],
  }
}

/**
 * Find a usable base interpreter.
 *
 * @param candidates - absolute paths or bare command names to try in order.
 * @returns the first interpreter at or above the version floor, else null.
 */
export async function findBasePython(
  candidates: readonly string[],
  options: { timeoutMs?: number; scratchDir?: string } = {},
): Promise<InterpreterInfo | null> {
  let lastFailure: InterpreterInfo | null = null
  for (const candidate of candidates) {
    const info = await probeInterpreter(candidate, options)
    if (!info.ok) {
      lastFailure ??= info
      continue
    }
    const [major, minor] = info.majorMinor ?? [0, 0]
    if (major > MINIMUM_PYTHON[0] || (major === MINIMUM_PYTHON[0] && minor >= MINIMUM_PYTHON[1])) return info
    lastFailure = { ...info, ok: false, note: `python ${info.version} is older than the required 3.10` }
  }
  return lastFailure
}

/** Probe torch inside one interpreter. */
export async function probeTorch(
  python: string,
  options: { timeoutMs?: number; scratchDir?: string } = {},
): Promise<PackageReport['torch']> {
  const { value } = await pythonJson<{ version: string; cuda: string | null; cudaAvailable: boolean }>(
    python,
    'import json,torch;print(json.dumps({"version":torch.__version__,"cuda":torch.version.cuda,"cudaAvailable":bool(torch.cuda.is_available())}))',
    { ...options, timeoutMs: options.timeoutMs ?? 120_000, label: 'torch-probe' },
  )
  return value
}

/**
 * Probe every package the worker imports.
 *
 * A missing package is reported rather than thrown: `status` and `repair` both
 * need the partial picture.
 */
export async function probePackages(
  python: string,
  options: { timeoutMs?: number; scratchDir?: string } = {},
): Promise<PackageReport> {
  if (executableMissing(python)) {
    return { ok: false, versions: {}, torch: null, note: `interpreter not found: ${python}` }
  }
  // One source, or the lists drift: every package `install` promises must also be
  // *probed*, otherwise the "everything is already present" branch can never fire.
  // `protobuf` used to be installed but never probed, so even a complete environment
  // re-installed it on every `install`/`repair`.
  const names = ['torch', ...RUNTIME_PACKAGES.map((spec) => spec.split('==')[0])]
  const code = [
    'import json, importlib.metadata as md',
    `out = {}`,
    `for name in ${JSON.stringify(names)}:`,
    '    try:',
    '        out[name] = md.version(name)',
    '    except Exception:',
    '        out[name] = None',
    'try:',
    '    import torch',
    '    torch_info = {"version": torch.__version__, "cuda": torch.version.cuda, "cudaAvailable": bool(torch.cuda.is_available())}',
    'except Exception:',
    '    torch_info = None',
    'print(json.dumps({"versions": out, "torch": torch_info}))',
  ].join('\n')
  const { value, result } = await pythonJson<{ versions: Record<string, string | null>; torch: PackageReport['torch'] }>(
    python,
    code,
    { ...options, timeoutMs: options.timeoutMs ?? 300_000, label: 'packages' },
  )
  if (value === null) {
    return { ok: false, versions: {}, torch: null, note: `package probe produced no JSON: ${result.output.slice(-400) || result.note || 'no output'}` }
  }
  const missing = Object.entries(value.versions).filter(([, version]) => version === null).map(([name]) => name)
  return {
    ok: missing.length === 0,
    versions: value.versions,
    torch: value.torch,
    note: missing.length === 0 ? undefined : `missing: ${missing.join(', ')}`,
  }
}

/** One step of an install run, in the order it happened. */
export interface InstallStep {
  readonly name: string
  readonly status: 'ok' | 'skipped' | 'failed' | 'planned'
  readonly detail?: string
  readonly command?: string
  readonly duration_ms?: number
}

/** Options for `runInstall`. */
export interface InstallOptions {
  readonly runtimeDir: string
  readonly pipwrap: string
  /** Absolute paths or bare names to try as the base interpreter. */
  readonly basePythonCandidates: readonly string[]
  /** CUDA tags to try, in order. */
  readonly torchWheels: readonly string[]
  /** Index URL for the non-torch packages; empty uses the default PyPI. */
  readonly pipIndexUrl: string
  /** Reuse a CUDA torch found in the base interpreter via `--system-site-packages`. */
  readonly reuseBaseTorch: boolean
  /** Report the plan without touching the machine. */
  readonly dryRun: boolean
  /** Budget per command (pip installs are slow, torch is ~2.6 GB). */
  readonly commandTimeoutMs: number
  /** Scratch directory for command logs and pip's temp files. */
  readonly scratchDir: string
}

/** Result of `runInstall`. */
export interface InstallReport {
  readonly action: 'install'
  readonly dry_run: boolean
  readonly ok: boolean
  readonly dry_run_skipped?: string
  readonly base_python: InterpreterInfo | null
  readonly venv_python: string
  readonly venv_dir: string
  readonly steps: InstallStep[]
  readonly packages: PackageReport | null
  readonly next: string
}

/** Does this interpreter have pip importable? (A `--without-pip` venv does not.) */
async function venvHasPip(python: string, options: InstallOptions): Promise<boolean> {
  const result = await runCaptured(python, ['-c', 'import pip'], {
    timeoutMs: 30_000,
    scratchDir: options.scratchDir,
    label: 'pip-probe',
  })
  return result.ok
}

/** Copy pip from the base interpreter into a `--without-pip` venv. */
async function copyPip(basePython: string, venvDir: string, options: InstallOptions): Promise<InstallStep> {
  const started = Date.now()
  // Ask for a JSON *object*: `pythonJson` only parses lines that start with `{`, and
  // `site.getsitepackages()` returns a list whose first entry is the install prefix
  // (the venv-less interpreter), which contains no `pip` at all.
  const { value } = await pythonJson<{ purelib?: string }>(basePython, 'import json,sysconfig;print(json.dumps({"purelib":sysconfig.get_paths()["purelib"]}))', {
    timeoutMs: 30_000,
    scratchDir: options.scratchDir,
    label: 'site',
  })
  const sitePackages = value?.purelib
  if (sitePackages === undefined) {
    return { name: 'venv:copy pip', status: 'failed', detail: 'could not locate the base interpreter site-packages' }
  }
  const libDir = process.platform === 'win32' ? join(venvDir, 'Lib', 'site-packages') : join(venvDir, 'lib', 'site-packages')
  const { readdirSync, mkdirSync } = await import('node:fs')
  mkdirSync(libDir, { recursive: true })
  const copied: string[] = []
  for (const entry of readdirSync(sitePackages)) {
    if (entry === 'pip' || entry.startsWith('pip-')) {
      cpSync(join(sitePackages, entry), join(libDir, entry), { recursive: true, force: true })
      copied.push(entry)
    }
  }
  return {
    name: 'venv:copy pip',
    status: copied.length > 0 ? 'ok' : 'failed',
    detail: copied.length > 0 ? `copied ${copied.join(', ')} from ${sitePackages}` : `no pip found in ${sitePackages}`,
    duration_ms: Date.now() - started,
  }
}

/** Create the venv, falling back to the sandbox workaround when ensurepip fails. */
async function createVenv(basePython: string, venvDir: string, options: InstallOptions, systemSite: boolean): Promise<InstallStep[]> {
  const steps: InstallStep[] = []
  const flags = systemSite ? ['--system-site-packages'] : []
  const started = Date.now()
  const first = await runCaptured(basePython, ['-m', 'venv', ...flags, venvDir], {
    timeoutMs: options.commandTimeoutMs,
    scratchDir: options.scratchDir,
    label: 'venv',
  })
  steps.push({
    name: 'venv:create',
    status: first.ok ? 'ok' : 'failed',
    command: first.command,
    detail: first.ok
      ? `created ${venvDir}${systemSite ? ' (--system-site-packages: reusing the base interpreter packages)' : ''}`
      : `exit ${first.code ?? 'null'}: ${first.output.slice(-600)}`,
    duration_ms: Date.now() - started,
  })
  if (first.ok) return steps
  // ensurepip writes into a 0o700 directory, which this host's sandbox refuses.
  //
  // `venv` is deliberately *not* handed a TMP/TEMP of our own: `pipInstall` mkdirs
  // `runtimeDir/tmp` before using it, but this call ran before that dir existed, and
  // `tempfile` answers a TMP that does not exist by falling back — it created its
  // 0o700 bootstrap tempdir *inside the venv*, where it can never be deleted again
  // (`Remove-Item -Recurse -Force` → Access denied), so every install left permanent
  // garbage in the user's runtime dir. The OS temp is the right home for a stock
  // `python -m venv`; pip keeps its own isolated temp below.
  const second = await runCaptured(basePython, ['-m', 'venv', ...flags, '--without-pip', venvDir], {
    timeoutMs: options.commandTimeoutMs,
    scratchDir: options.scratchDir,
    label: 'venv-nopip',
  })
  steps.push({
    name: 'venv:create (--without-pip)',
    status: second.ok ? 'ok' : 'failed',
    command: second.command,
    detail: second.ok ? 'ensurepip failed, so the venv was created without pip' : `exit ${second.code ?? 'null'}: ${second.output.slice(-600)}`,
  })
  if (!second.ok) return steps
  steps.push(await copyPip(basePython, venvDir, options))
  return steps
}

/** Run pip for one package set, through the sandbox patch. */
async function pipInstall(
  paths: VenvPaths,
  options: InstallOptions,
  args: readonly string[],
  extra: readonly string[],
): Promise<RunResult> {
  await mkdir(join(options.runtimeDir, 'tmp'), { recursive: true }).catch(() => undefined)
  return runCaptured(paths.python, [options.pipwrap, 'install', ...args, ...extra], {
    timeoutMs: options.commandTimeoutMs,
    scratchDir: options.scratchDir,
    label: 'pip',
    env: {
      TMP: join(options.runtimeDir, 'tmp'),
      TEMP: join(options.runtimeDir, 'tmp'),
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    },
  })
}

/**
 * Install the environment: venv, CUDA torch, then the worker's packages.
 *
 * @param options - resolved config values and the dry-run switch.
 * @returns a step-by-step report; a failed step is reported, never thrown.
 */
export async function runInstall(options: InstallOptions): Promise<InstallReport> {
  const paths = venvPaths(options.runtimeDir)
  const steps: InstallStep[] = []
  const base = await findBasePython(options.basePythonCandidates, { scratchDir: options.scratchDir })
  const report = (ok: boolean, next: string, extra: Partial<InstallReport> = {}): InstallReport => ({
    action: 'install',
    dry_run: options.dryRun,
    ok,
    base_python: base,
    venv_python: paths.python,
    venv_dir: paths.venvDir,
    steps,
    packages: null,
    next,
    ...extra,
  })
  if (base === null || !base.ok) {
    steps.push({
      name: 'base python',
      status: 'failed',
      detail:
        base?.note ??
        `no usable interpreter (>= 3.10) among: ${options.basePythonCandidates.join(', ')}`,
    })
    return report(false, 'Install Python 3.10+ (python.org), or point the plugin config `basePython` at it.')
  }
  const baseExe = base.executable ?? base.path
  if (options.dryRun) {
    const baseTorch = options.reuseBaseTorch ? await probeTorch(baseExe, { scratchDir: options.scratchDir }) : null
    steps.push({ name: 'base python', status: 'ok', detail: `${base.version} at ${baseExe}` })
    steps.push({
      name: 'venv',
      status: 'planned',
      detail: pathExists(paths.python)
        ? `${paths.venvDir} already exists`
        : `would run: ${baseExe} -m venv ${paths.venvDir}${baseTorch === null ? '' : ' --system-site-packages (base python has CUDA torch)'}`,
    })
    steps.push({
      name: 'torch',
      status: 'planned',
      detail: baseTorch === null
        ? `would try ${options.torchWheels.join(' → ')} with ${TORCH_PIN.join(' ')}`
        : `would reuse the base interpreter's torch ${baseTorch.version} (cuda ${baseTorch.cuda}) and install nothing`,
    })
    steps.push({
      name: 'packages',
      status: 'planned',
      detail: `would install ${RUNTIME_PACKAGES.join(' ')}${options.pipIndexUrl === '' ? '' : ` from ${options.pipIndexUrl}`}`,
    })
    return report(true, 'Re-run with `dryRun:false` to execute this plan.', {
      dry_run_skipped: 'nothing was created or installed; this is a plan',
    })
  }

  const baseTorch = options.reuseBaseTorch ? await probeTorch(base.executable ?? base.path, { scratchDir: options.scratchDir }) : null
  steps.push({ name: 'base python', status: 'ok', detail: `${base.version} at ${base.executable ?? base.path}` })

  const venvExists = pathExists(paths.python)
  let venvTorch = venvExists ? await probeTorch(paths.python, { scratchDir: options.scratchDir }) : null
  if (!venvExists) {
    steps.push(...(await createVenv(base.executable ?? base.path, paths.venvDir, options, baseTorch !== null)))
    if (!pathExists(paths.python)) {
      return report(false, 'The venv could not be created; see the step output above.')
    }
    venvTorch = null
  } else {
    steps.push({ name: 'venv', status: 'skipped', detail: `${paths.venvDir} already exists — reusing it` })
    // A venv created by the `--without-pip` fallback stays pip-less forever unless
    // something puts pip back: without this, every later `install`/`repair` dies in
    // pipwrap with `ImportError: No module named pip` and blames the network.
    if (!(await venvHasPip(paths.python, options))) {
      steps.push(await copyPip(base.executable ?? base.path, paths.venvDir, options))
    }
  }

  if (venvTorch !== null && venvTorch.cuda !== null) {
    steps.push({ name: 'torch', status: 'skipped', detail: `already installed: ${venvTorch.version} (cuda ${venvTorch.cuda})` })
  } else if (baseTorch !== null && baseTorch.cuda !== null) {
    steps.push({
      name: 'torch',
      status: 'skipped',
      detail: `reusing the base interpreter's CUDA torch ${baseTorch.version} via --system-site-packages`,
    })
    const probe = await probeTorch(paths.python, { scratchDir: options.scratchDir })
    if (probe === null) {
      return report(
        false,
        `The venv cannot see the base interpreter's torch. Recreate it with --system-site-packages, or run install with \`reuseBaseTorch:false\`.`,
      )
    }
  } else {
    let installed: InstallStep | null = null
    for (const tag of options.torchWheels) {
      const index = `https://download.pytorch.org/whl/${tag}`
      const started = Date.now()
      const result = await pipInstall(paths, options, ['--no-cache-dir', '--timeout', '180', '--retries', '15', '--index-url', index], [...TORCH_PIN])
      const ok = result.ok && pathExists(paths.python)
      installed = {
        name: `torch (${tag})`,
        status: ok ? 'ok' : 'failed',
        command: result.command,
        detail: ok ? `installed from ${index}` : `exit ${result.code ?? 'null'}: ${result.output.slice(-800)}`,
        duration_ms: Date.now() - started,
      }
      steps.push(installed)
      if (ok) break
    }
    if (installed === null || installed.status !== 'ok') {
      return report(
        false,
        'Every CUDA wheel index in the matrix failed. Check the machine\'s network/proxy, or set `pipIndexUrl` to an internal mirror and retry.',
      )
    }
  }

  const before = await probePackages(paths.python, { scratchDir: options.scratchDir })
  const missing = RUNTIME_PACKAGES.filter((spec) => {
    const name = spec.split('==')[0]
    return before.versions[name] === null || before.versions[name] === undefined
  })
  if (missing.length === 0) {
    steps.push({ name: 'packages', status: 'skipped', detail: `all present: ${JSON.stringify(before.versions)}` })
  } else {
    const started = Date.now()
    const extra = options.pipIndexUrl === '' ? [] : ['--index-url', options.pipIndexUrl]
    const result = await pipInstall(paths, options, ['--no-cache-dir', '--timeout', '180', '--retries', '15', ...extra], missing)
    steps.push({
      name: 'packages',
      status: result.ok ? 'ok' : 'failed',
      command: result.command,
      detail: result.ok ? `installed ${missing.join(' ')}` : `exit ${result.code ?? 'null'}: ${result.output.slice(-800)}`,
      duration_ms: Date.now() - started,
    })
  }

  const after = await probePackages(paths.python, { scratchDir: options.scratchDir })
  const ok = after.ok && after.torch !== null
  return {
    action: 'install',
    dry_run: false,
    ok,
    base_python: base,
    venv_python: paths.python,
    venv_dir: paths.venvDir,
    steps,
    packages: after,
    next: ok
      ? 'Environment ready. Run `qwen_image_env` with `action:"fetch-weights"` if the weights are not on disk yet.'
      : `Install is incomplete (${after.note ?? 'see steps'}). Re-run \`action:"repair"\` for a targeted fix.`,
  }
}
