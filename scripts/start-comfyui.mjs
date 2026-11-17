#!/usr/bin/env node
/**
 * `start-comfyui.mjs` — one command that brings this machine's ComfyUI up.
 *
 * All machine facts and process mechanics live in `comfyui-discovery.mjs`, which
 * the plugin's environment layer (`src/environment.ts`) imports too — so the CLI
 * and a cold-start inside a DSH session cannot disagree about where the install
 * is, which Python runs it, or whether it answered. This file is the
 * human-facing CLI on top of that: argument parsing, the health report, and the
 * console output.
 *
 * The plugin itself still does **not** install ComfyUI or download weights (see
 * `docs/comfyui-deployment.md`). This script is the human-facing shortcut for
 * the step that used to need the most manual work: finding the install,
 * remembering the flags Comfy Desktop recorded, starting the backend, and
 * waiting for `/system_stats` to answer.
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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appDataRoot,
  discoverComfyPlan,
  launchComfyPlan,
  loopbackPortOf,
  planForRun,
  readJsonFile,
  stopComfyPlan,
  systemStats,
  waitForComfyStats,
} from './comfyui-discovery.mjs'

function parseArgs(argv) {
  const out = { print: false, stop: false, doctor: false, force: false, timeout: 180, endpoint: undefined, dir: undefined }
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

const gib = (n) => `${(n / 1024 ** 3).toFixed(1)} GiB`

/** Every model file ComfyUI could see, as `{ path, size }`, two levels deep. */
function scanModelFiles(dirs) {
  const out = []
  const exts = ['.safetensors', '.sft', '.gguf', '.ckpt', '.pt', '.pth']
  for (const dir of dirs) {
    if (!dir) continue
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
 * missing" without starting anything that costs GPU time.
 */
async function doctor(plan, endpoint) {
  log(`[doctor] install  ${plan.installPath}`)
  log(`[doctor] python   ${plan.python}`)
  log(`[doctor] endpoint ${endpoint}`)

  const desktopRoot = join(appDataRoot(), 'Comfy Desktop')
  const settings = readJsonFile(join(desktopRoot, 'settings.json')) ?? {}
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

/**
 * `--stop`: stop the instance a previous `--start` (or the plugin) launched.
 *
 * The discovery call here is deliberately the **same** one `--start` uses —
 * `--dir` / `COMFYUI_DIR`, then the Desktop registry, then the bounded scan.
 * Passing `scanRoots: []` (the old behaviour) found the Desktop record but not a
 * portable install, so a `--stop` for a scanned install answered “nothing to
 * stop” with exit code 4 while the process kept running.
 */
async function stopStarted() {
  const args = parseArgs(process.argv.slice(2))
  let plan
  try {
    plan = discoverComfyPlan({ dir: args.dir, env: process.env })
  } catch (error) {
    log(`[stop] no install discovered (${error?.message ?? error}), nothing to stop`)
    return 4
  }
  if (!plan) {
    log('[stop] no ComfyUI install found. Pass --dir <install dir> or set COMFYUI_DIR.')
    return 4
  }
  const result = await stopComfyPlan(plan, { endpoint: args.endpoint })
  log(`[stop] ${result.note}`)
  if (!result.stopped) return 4
  if (result.verified === false) return 4
  return 0
}

function tail(path, lines = 25) {
  try {
    const text = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/)
    for (const line of text.slice(-lines)) log(`  ${line}`)
  } catch (error) {
    log(`  (could not read ${path}: ${error?.message ?? error})`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?/, ''))
    return 0
  }
  if (args.stop) return await stopStarted()

  let plan
  try {
    plan = discoverComfyPlan({ dir: args.dir, env: process.env })
  } catch (error) {
    log(`[error] ${error?.message ?? error}`)
    return 1
  }
  if (!plan) {
    log('[error] no ComfyUI install found. Pass --dir <install dir>, set COMFYUI_DIR, or follow docs/comfyui-deployment.md.')
    return 1
  }
  const endpoint = (args.endpoint ?? process.env.COMFY_ENDPOINT ?? `http://127.0.0.1:${plan.port}`).replace(/\/$/, '')
  // Same port-source rule as the plugin: a loopback endpoint pins the `--port`
  // the launch uses, so argv, the wait and the health check cannot disagree.
  const pinned = loopbackPortOf(endpoint)
  if (pinned !== null) plan = planForRun(plan, { port: pinned })

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

  const launch = launchComfyPlan(plan, { endpoint })
  log(`[start] pid ${launch.pid} → log ${launch.logPath}`)

  process.stdout.write('[wait] /system_stats ')
  const wait = await waitForComfyStats(endpoint, {
    child: launch.child,
    timeoutMs: args.timeout * 1000,
    onWait: () => process.stdout.write('.'),
  })
  if (wait.ok) {
    process.stdout.write(' ok\n')
    report(endpoint, wait.stats, 'started by this script')
    return 0
  }
  if (wait.reason === 'exited') {
    process.stdout.write(' died\n')
    log(`[fail] ComfyUI exited with code ${wait.exitCode}. Last lines of ${launch.logPath}:`)
    tail(launch.logPath)
    return 2
  }
  process.stdout.write(' timeout\n')
  log(`[fail] no /system_stats after ${args.timeout}s. Check ${launch.logPath}`)
  return 3
}

function report(endpoint, stats, note) {
  const sys = stats?.system ?? {}
  const devices = Array.isArray(stats?.devices) ? stats.devices : []
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
