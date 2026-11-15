#!/usr/bin/env node
/**
 * `start-comfyui.mjs` — one command that brings this machine's ComfyUI up.
 *
 * The plugin itself still does **not** install ComfyUI, download weights, or
 * invent launch flags (see `docs/comfyui-deployment.md`). This script is the
 * human-facing shortcut for the step that used to need the most manual work:
 * finding the install, remembering the flags Comfy Desktop recorded, starting
 * the backend, and waiting for `/system_stats` to answer.
 *
 * Where it takes its facts from, in order:
 *   1. `COMFYUI_DIR` / `COMFY_ENDPOINT` — explicit overrides win.
 *   2. Comfy Desktop's own registry (`%APPDATA%/Comfy Desktop/installations.json`):
 *      install path, `launchArgs`, `envVars`, port, plus `settings.json` for the
 *      shared input/output dirs and `instance-model-paths/<id>.yaml` for the
 *      model roots. **The flags are read, never invented or edited** — whatever
 *      Comfy Desktop would pass, this passes.
 *   3. A bounded scan for `<root>/**\/ComfyUI/main.py` with a sibling Python
 *      (`standalone-env/python.exe`, `python_embeded/python.exe`,
 *      `.venv/Scripts/python.exe`) for portable / plain installs.
 *
 * Usage:
 *   node scripts/start-comfyui.mjs              # discover → start → wait → verify
 *   node scripts/start-comfyui.mjs --print      # show the plan and argv, start nothing
 *   node scripts/start-comfyui.mjs --timeout 300
 *   node scripts/start-comfyui.mjs --stop       # stop an instance this script started
 *   node scripts/start-comfyui.mjs --force      # start even if /system_stats already answers
 *
 * Exit codes: 0 ready/already running, 1 discovery failed, 2 spawn failed,
 * 3 timed out waiting for `/system_stats`, 4 `--stop` had nothing to stop.
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const IS_WIN = platform() === 'win32'

function parseArgs(argv) {
  const out = { print: false, stop: false, force: false, timeout: 180, endpoint: undefined, dir: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--print') out.print = true
    else if (a === '--stop') out.stop = true
    else if (a === '--doctor') out.doctor = true
    else if (a === '--force') out.force = true
    else if (a === '--timeout') out.timeout = Number(argv[++i])
    else if (a === '--endpoint') out.endpoint = argv[++i]
    else if (a === '--dir') out.dir = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else if (!a.startsWith('--')) out.dir = a
    else throw new Error(`unknown option: ${a}`)
  }
  return out
}

const log = (...parts) => console.log(...parts)

/** Split a Desktop `launchArgs` string the way a shell would for the simple cases it uses. */
function splitArgs(s) {
  if (!s) return []
  const out = []
  let cur = ''
  let quote = null
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = '' }
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function appDataRoot() {
  return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Does this env root actually have the package that matters (`torch`) installed? */
function hasTorch(envRoot) {
  const direct = join(envRoot, 'Lib', 'site-packages', 'torch')
  if (existsSync(direct)) return true
  const lib = join(envRoot, 'lib')
  if (!existsSync(lib)) return false
  try {
    return readdirSync(lib).some((d) => d.startsWith('python') && existsSync(join(lib, d, 'site-packages', 'torch')))
  } catch {
    return false
  }
}

/**
 * The Python interpreter that belongs to an install.
 *
 * Comfy Desktop 0.34 puts the CUDA env in `<install>/ComfyUI/.venv` and ships a
 * bare `standalone-env` next to it — that one has **no torch**, so picking it
 * because it sorts first lands on `ModuleNotFoundError: No module named 'torch'`.
 * Any candidate that can prove it has torch wins; the rest are fallbacks.
 */
function findPython(installPath, mainPy) {
  const roots = IS_WIN
    ? [
        join(dirname(mainPy ?? ''), '.venv'), // Desktop per-instance uv env
        join(installPath, 'ComfyUI', '.venv'),
        join(installPath, '.venv'),
        join(installPath, 'venv'),
        join(installPath, 'python_embeded'),
        join(dirname(mainPy ?? ''), 'python_embeded'),
        join(installPath, 'standalone-env'),
      ]
    : [
        join(dirname(mainPy ?? ''), '.venv'),
        join(installPath, '.venv'),
        join(installPath, 'venv'),
      ]
  const exe = IS_WIN ? join('Scripts', 'python.exe') : join('bin', 'python')
  const candidates = roots.map((r) => (r.endsWith('python_embeded') || r.endsWith('standalone-env') ? join(r, 'python.exe') : join(r, exe)))
  const existing = candidates.filter((p) => existsSync(p))
  const withTorch = existing.filter((p) => hasTorch(dirname(dirname(p))))
  return withTorch[0] ?? existing[0] ?? null
}

/** `<install>/ComfyUI/main.py` for the Desktop layout, `main.py` for a plain checkout. */
function findMainPy(installPath) {
  const candidates = [
    join(installPath, 'ComfyUI', 'main.py'),
    join(installPath, 'main.py'),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Build a plan from one Comfy Desktop installation record. */
function planFromDesktop(install, desktopRoot) {
  const installPath = install.installPath
  if (!installPath || !existsSync(installPath)) return null
  const mainPy = findMainPy(installPath)
  const python = findPython(installPath, mainPy)
  if (!mainPy || !python) return null

  const settings = readJson(join(desktopRoot, 'settings.json')) ?? {}
  const modelPathsDir = join(desktopRoot, 'instance-model-paths')
  let modelPathsConfig = null
  if (existsSync(modelPathsDir)) {
    const own = join(modelPathsDir, `${install.id}.yaml`)
    modelPathsConfig = existsSync(own)
      ? own
      : (readdirSync(modelPathsDir).filter((f) => f.endsWith('.yaml')).map((f) => join(modelPathsDir, f))[0] ?? null)
  }

  const argv = []
  if (IS_WIN) argv.push('-s')
  argv.push(mainPy)
  argv.push('--listen', '127.0.0.1', '--port', String(install.port ?? 8188))
  if (modelPathsConfig) argv.push('--extra-model-paths-config', modelPathsConfig)
  if (settings.outputDir) argv.push('--output-directory', settings.outputDir)
  if (settings.inputDir) argv.push('--input-directory', settings.inputDir)
  for (const extra of splitArgs(install.launchArgs)) argv.push(extra)

  return {
    source: `Comfy Desktop (${install.name ?? install.id}${install.version ? ` ${install.version}` : ''})`,
    installPath,
    mainPy,
    python,
    cwd: dirname(mainPy),
    port: Number(install.port ?? 8188),
    argv,
    env: { ...install.envVars, PYTHONUTF8: '1' },
    logDir: join(installPath, 'logs'),
  }
}

/** Bounded scan for portable / plain installs, for machines without Comfy Desktop. */
function planFromScan(root, depth = 2) {
  if (!root || !existsSync(root)) return null
  const skip = new Set(['node_modules', '.git', 'Windows', 'Program Files', 'Program Files (x86)', '$Recycle.Bin', 'System Volume Information'])
  const walk = (dir, left) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name)) continue
      const child = join(dir, e.name)
      if (e.name.toLowerCase() === 'comfyui') {
        const mainPy = join(child, 'main.py')
        const python = findPython(dir, mainPy)
        if (existsSync(mainPy) && python) {
          return {
            source: `scan (${child})`,
            installPath: dir,
            mainPy,
            python,
            cwd: child,
            port: 8188,
            argv: [...(IS_WIN ? ['-s'] : []), mainPy, '--listen', '127.0.0.1', '--port', '8188'],
            env: { PYTHONUTF8: '1' },
            logDir: join(child, 'user'),
          }
        }
      }
      if (left > 0) {
        const hit = walk(child, left - 1)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(root, depth)
}

function discover(args) {
  if (args.dir) {
    const installPath = resolve(args.dir)
    const mainPy = findMainPy(installPath)
    const python = findPython(installPath, mainPy)
    if (!mainPy || !python) throw new Error(`--dir ${installPath}: no main.py or no Python found inside`)
    return {
      source: `--dir (${installPath})`,
      installPath,
      mainPy,
      python,
      cwd: dirname(mainPy),
      port: 8188,
      argv: [...(IS_WIN ? ['-s'] : []), mainPy, '--listen', '127.0.0.1', '--port', '8188'],
      env: { PYTHONUTF8: '1' },
      logDir: join(installPath, 'logs'),
    }
  }

  if (process.env.COMFYUI_DIR) {
    return discover({ ...args, dir: process.env.COMFYUI_DIR })
  }

  const desktopRoot = join(appDataRoot(), 'Comfy Desktop')
  const installations = readJson(join(desktopRoot, 'installations.json'))
  if (Array.isArray(installations)) {
    for (const install of installations) {
      if (install.status && install.status !== 'installed') continue
      const plan = planFromDesktop(install, desktopRoot)
      if (plan) return plan
    }
  }

  const roots = IS_WIN
    ? ['D:\\', 'E:\\', 'C:\\', join(homedir(), 'Documents'), join(homedir(), 'Desktop')]
    : [homedir(), '/opt', '/usr/local']
  for (const root of roots) {
    const plan = planFromScan(root)
    if (plan) return plan
  }

  throw new Error(
    'no ComfyUI install found. Pass --dir <install dir>, set COMFYUI_DIR, or follow docs/comfyui-deployment.md.',
  )
}

async function systemStats(endpoint, timeoutMs = 2500) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${endpoint}/system_stats`, { signal: ctrl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function pidFile(plan) {
  return join(plan.logDir ?? plan.installPath, 'dsh-image-forge-launch.json')
}

const gib = (n) => `${(n / 1024 ** 3).toFixed(1)} GiB`

/** Every model file ComfyUI could see, as `{ path, size }`, two levels deep. */
function scanModelFiles(dirs) {
  const out = []
  const exts = ['.safetensors', '.sft', '.gguf', '.ckpt', '.pt', '.pth']
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const walk = (d, depth) => {
      let entries
      try {
        entries = readdirSync(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(d, e.name)
        if (e.isDirectory()) {
          if (depth > 0) walk(p, depth - 1)
        } else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) {
          let size = 0
          try {
            size = statSync(p).size
          } catch {}
          out.push({ path: p, size, name: e.name })
        }
      }
    }
    walk(dir, 2)
  }
  return out
}

/**
 * `--doctor`: answer "is this deployment usable, and if not what exactly is
 * missing" without starting anything that costs GPU time. Replaces the manual
 * `dir /s` + sha256 checklist in docs/comfyui-deployment.md §6.
 */
async function doctor(plan, endpoint) {
  log(`[doctor] install  ${plan.installPath}`)
  log(`[doctor] python   ${plan.python}`)
  log(`[doctor] endpoint ${endpoint}`)

  const desktopRoot = join(appDataRoot(), 'Comfy Desktop')
  const settings = readJson(join(desktopRoot, 'settings.json')) ?? {}
  const dirs = settings.modelsDirs?.length
    ? settings.modelsDirs
    : [join(dirname(dirname(plan.mainPy)), '..', 'ComfyUI-Shared', 'models')]
  const files = scanModelFiles(dirs)
  log(`[doctor] model dirs: ${dirs.join(', ')} (${files.length} 个模型文件)`)

  const roles = [
    ['基础 unet（25 步）', (n) => /qwen_image/i.test(n) && !/turbo/i.test(n) && !/vae/i.test(n) && !/pe_/i.test(n)],
    ['turbo unet（8 步）', (n) => /qwen_image/i.test(n) && /turbo/i.test(n)],
    ['VAE', (n) => /qwen_image/i.test(n) && /vae/i.test(n)],
    ['文本编码器 t2i', (n) => /pe_t2i/i.test(n)],
    ['文本编码器 i2i（改图）', (n) => /pe_i2i/i.test(n)],
  ]
  let missing = 0
  for (const [label, test] of roles) {
    const hit = files.filter((f) => test(f.name)).sort((a, b) => b.size - a.size)[0]
    if (hit) log(`  ✔ ${label.padEnd(22)} ${gib(hit.size).padStart(9)}  ${hit.name}`)
    else {
      missing += 1
      log(`  ✘ ${label.padEnd(22)} ${'—'.padStart(9)}  缺`)
    }
  }

  const stats = await systemStats(endpoint)
  if (stats) {
    const dev = stats.devices?.[0] ?? {}
    log(`[doctor] ComfyUI 在线：v${stats.system?.comfyui_version ?? '?'}，显存 ${Math.round((dev.vram_total ?? 0) / 1024 ** 2)} MiB`)
    const info = await fetch(`${endpoint}/object_info/UNETLoader`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    const names = info?.UNETLoader?.input?.required?.unet_name?.[0] ?? []
    const qwen = names.filter((n) => /qwen/i.test(n))
    log(`[doctor] ComfyUI 能枚举到的 Qwen unet：${qwen.length ? qwen.join(' | ') : '（一个都没有 → 重启 ComfyUI 或查 extra_model_paths）'}`)
  } else {
    log(`[doctor] ComfyUI 不在 ${endpoint} 上；权重文件表仍按磁盘算`)
  }

  if (missing === 0 && stats) {
    log('[doctor] 结论：可以出图。pnpm run test:live 会真跑一张。')
    return 0
  }
  if (missing === 0) {
    log('[doctor] 结论：权重齐了，ComfyUI 没起 → node scripts/start-comfyui.mjs')
    return 0
  }
  log(`[doctor] 结论：缺 ${missing} 个权重 → 见 docs/comfyui-deployment.md §4（脚本不下载权重）`)
  return 1
}

function stopStarted() {
  const args = parseArgs(process.argv.slice(2))
  let plan
  try {
    plan = discover(args)
  } catch {
    log('[stop] no install discovered, nothing to stop')
    return 4
  }
  const file = pidFile(plan)
  if (!existsSync(file)) {
    log(`[stop] no launch record at ${file}, nothing to stop`)
    return 4
  }
  const record = readJson(file)
  if (!record?.pid) {
    log(`[stop] ${file} has no pid`)
    return 4
  }
  if (IS_WIN) spawnSync('taskkill', ['/PID', String(record.pid), '/T', '/F'], { stdio: 'inherit' })
  else process.kill(record.pid, 'SIGTERM')
  log(`[stop] signalled pid ${record.pid}`)
  return 0
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?/, ''))
    return 0
  }
  if (args.stop) return stopStarted()

  const plan = discover(args)
  const endpoint = (args.endpoint ?? process.env.COMFY_ENDPOINT ?? `http://127.0.0.1:${plan.port}`).replace(/\/$/, '')

  if (args.doctor) return await doctor(plan, endpoint)

  log(`[discover] ${plan.source}`)
  log(`[discover] main.py  ${plan.mainPy}`)
  log(`[discover] python   ${plan.python}`)
  log(`[discover] endpoint ${endpoint}`)
  if (args.print) {
    log('[plan] argv:')
    for (const a of plan.argv) log(`  ${a}`)
    if (Object.keys(plan.env).length) log(`[plan] env: ${JSON.stringify(plan.env)}`)
    return 0
  }

  const already = await systemStats(endpoint)
  if (already && !args.force) {
    report(endpoint, already, 'already running')
    return 0
  }

  if (!existsSync(plan.logDir)) mkdirSync(plan.logDir, { recursive: true })
  const logPath = join(plan.logDir, `dsh-image-forge-launch-${Date.now()}.log`)
  const fd = openSync(logPath, 'a')
  const env = { ...process.env, ...plan.env }
  const child = spawn(plan.python, plan.argv, {
    cwd: plan.cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  closeSync(fd)
  writeFileSync(pidFile(plan), JSON.stringify({ pid: child.pid, endpoint, startedAt: new Date().toISOString(), logPath }, null, 2))
  log(`[start] pid ${child.pid} → log ${logPath}`)

  const deadline = Date.now() + args.timeout * 1000
  process.stdout.write('[wait] /system_stats ')
  while (Date.now() < deadline) {
    const stats = await systemStats(endpoint, 2000)
    if (stats) {
      process.stdout.write(' ok\n')
      report(endpoint, stats, 'started by this script')
      return 0
    }
    if (child.exitCode !== null) {
      process.stdout.write(' died\n')
      log(`[fail] ComfyUI exited with code ${child.exitCode}. Last lines of ${logPath}:`)
      const text = readFileSync(logPath, 'utf8').trimEnd().split(/\r?\n/)
      for (const line of text.slice(-25)) log(`  ${line}`)
      return 2
    }
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 1000))
  }
  process.stdout.write(' timeout\n')
  log(`[fail] no /system_stats after ${args.timeout}s. Check ${logPath}`)
  return 3
}

function report(endpoint, stats, note) {
  const sys = stats?.system ?? {}
  const devices = stats?.devices ?? []
  const vram = devices.map((d) => `${d.name} ${Math.round((d.vram_total ?? 0) / 1024 ** 2)} MiB`).join(', ')
  log(`[ready] ${endpoint} (${note})`)
  log(`[ready] ComfyUI ${String(sys.comfyui_version ?? '?')} · python ${String(sys.python_version ?? '?').split(' ')[0]} · ${process.platform}`)
  if (vram) log(`[ready] ${vram}`)
  log('[next]  pnpm run test:live        # 文生图真机')
  log('[next]  pnpm run test:live:edit   # 参考图改图')
}

const code = await main().catch((err) => {
  log(`[error] ${err?.message ?? err}`)
  return 1
})
process.exit(code)
