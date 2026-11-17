/**
 * The environment layer (P1a): Desktop-registry discovery, background launch,
 * `/system_stats` health check, and the structured not-installed hand-off.
 *
 * Every case runs against a **fake** Comfy Desktop registry and a fake ComfyUI
 * on 127.0.0.1 — never the real registry, real install or the live server.
 * `npm test` has to stay safe on a machine where ComfyUI is already running.
 *
 * Runs with `node test/environment.test.mjs` (not `node --test`: the documented
 * reason is in docs/testing.md — spawn + pipe is EPERM in this sandbox).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ENVIRONMENT_TOOL_NAME,
  ensureEnvironment,
  environmentOptionsOf,
  inspectEnvironment,
  registerEnvironmentTools,
  stopEnvironment,
} from '../src/environment.ts'
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  discoverComfyPlan,
  splitArgs,
} from '../scripts/comfyui-discovery.mjs'

/** One temp root for the whole file; each case gets its own subdirectory. */
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'forge-environment-'))
let caseId = 0
function freshDir() {
  caseId += 1
  const dir = join(TMP_ROOT, `case-${caseId}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * A fake install with both Python layouts, so the same fixture works whether a
 * case asks the plan for Windows or POSIX. Windows' `.venv/Lib` torch marker is
 * what `hasTorch` looks for on this host.
 */
function makeInstall(root) {
  const mainPy = join(root, 'ComfyUI', 'main.py')
  mkdirSync(dirname(mainPy), { recursive: true })
  writeFileSync(mainPy, '# fake ComfyUI main.py\n')
  const venv = join(root, 'ComfyUI', '.venv')
  const winPython = join(venv, 'Scripts', 'python.exe')
  const posixPython = join(venv, 'bin', 'python')
  mkdirSync(dirname(winPython), { recursive: true })
  mkdirSync(dirname(posixPython), { recursive: true })
  writeFileSync(winPython, '')
  writeFileSync(posixPython, '')
  mkdirSync(join(venv, 'Lib', 'site-packages', 'torch'), { recursive: true })
  return { mainPy, venv, winPython, posixPython }
}

/** A temp machine: an install plus (optionally) a fake Comfy Desktop registry. */
function makeMachine(tmp, { port = 18188, register = true, launchArgs = '--enable-manager --reserve-vram 1' } = {}) {
  const installPath = join(tmp, 'ComfyUI-Installs', 'ComfyUI')
  const install = makeInstall(installPath)
  const desktop = join(tmp, 'Comfy Desktop')
  mkdirSync(desktop, { recursive: true })
  if (register) {
    writeFileSync(
      join(desktop, 'installations.json'),
      JSON.stringify([
        {
          id: 'inst-test',
          name: 'ComfyUI',
          version: 'v0.34.0',
          status: 'installed',
          installPath,
          port,
          launchArgs,
          envVars: { HF_ENDPOINT: 'https://hf-mirror.test' },
        },
      ]),
    )
    writeFileSync(
      join(desktop, 'settings.json'),
      JSON.stringify({ inputDir: join(tmp, 'shared', 'input'), outputDir: join(tmp, 'shared', 'output') }),
    )
    mkdirSync(join(desktop, 'instance-model-paths'), { recursive: true })
    writeFileSync(join(desktop, 'instance-model-paths', 'inst-test.yaml'), 'comfyui:\n  base_path: shared\n')
  }
  return { appData: tmp, desktop, installPath, ...install }
}

/** Deps for discovery against the fixture, with the expensive drive scan off. */
function depsOf(machine, extra = {}) {
  return { env: {}, platform: 'win32', appData: machine.appData, scanRoots: [], ...extra }
}

/** A fake `/system_stats` server; `close()` must run or the process will not exit. */
function startStatsServer(version = 'fake-0.0') {
  return new Promise((resolve) => {
    const seen = []
    const server = createServer((request, response) => {
      seen.push(request.url)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          system: { comfyui_version: version, python_version: '3.13.0' },
          devices: [{ name: 'fake-gpu', type: 'cuda', vram_total: 8 * 1024 ** 3, vram_free: 4 * 1024 ** 3 }],
        }),
      )
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, seen, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

/** A port that was just free (bound once, then closed) — connection refused fast. */
async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('a fake Comfy Desktop registry yields the full launch plan', () => {
  const machine = makeMachine(freshDir(), { port: 18188 })
  const plan = discoverComfyPlan(depsOf(machine))
  assert.ok(plan, 'the fixture registry must produce a plan')
  assert.equal(plan.installPath, machine.installPath)
  assert.equal(plan.mainPy, machine.mainPy)
  assert.equal(plan.python, machine.winPython, 'the torch-bearing interpreter must win')
  assert.equal(plan.port, 18188)
  assert.equal(plan.cwd, dirname(machine.mainPy))
  assert.equal(plan.logDir, join(machine.installPath, 'logs'))
  assert.match(plan.source, /Comfy Desktop/)
  // -s (Windows), main.py, the listen/port pair, then the shared dirs from
  // settings.json, then launchArgs verbatim.
  assert.deepEqual(plan.argv.slice(0, 6), ['-s', machine.mainPy, '--listen', '127.0.0.1', '--port', '18188'])
  assert.deepEqual(plan.argv.slice(6, 12), [
    '--extra-model-paths-config',
    join(machine.desktop, 'instance-model-paths', 'inst-test.yaml'),
    '--output-directory',
    join(machine.appData, 'shared', 'output'),
    '--input-directory',
    join(machine.appData, 'shared', 'input'),
  ])
  assert.deepEqual(plan.argv.slice(12), ['--enable-manager', '--reserve-vram', '1'])
  assert.deepEqual(plan.env, { HF_ENDPOINT: 'https://hf-mirror.test', PYTHONUTF8: '1' })
})

test('the torch-bearing interpreter wins over an earlier env without torch', () => {
  const machine = makeMachine(freshDir())
  // ComfyUI/.venv sorts first but has no torch; the install-root .venv does.
  rmSync(join(machine.venv, 'Lib', 'site-packages', 'torch'), { recursive: true })
  const alt = join(machine.installPath, '.venv')
  mkdirSync(join(alt, 'Lib', 'site-packages', 'torch'), { recursive: true })
  mkdirSync(join(alt, 'Scripts'), { recursive: true })
  writeFileSync(join(alt, 'Scripts', 'python.exe'), '')
  const plan = discoverComfyPlan(depsOf(machine))
  assert.equal(plan.python, join(alt, 'Scripts', 'python.exe'))
})

test('with no registry, the bounded scan finds a portable layout', () => {
  const tmp = freshDir()
  const drive = join(tmp, 'D')
  const comfy = join(drive, 'apps', 'ComfyUI')
  const mainPy = join(comfy, 'main.py')
  mkdirSync(dirname(mainPy), { recursive: true })
  writeFileSync(mainPy, '# portable ComfyUI\n')
  const embed = join(comfy, 'python_embeded')
  mkdirSync(embed, { recursive: true })
  writeFileSync(join(embed, 'python.exe'), '')
  const plan = discoverComfyPlan({ env: {}, platform: 'win32', appData: join(tmp, 'empty-appdata'), scanRoots: [drive] })
  assert.ok(plan)
  assert.match(plan.source, /scan/)
  assert.equal(plan.mainPy, mainPy)
  assert.equal(plan.python, join(embed, 'python.exe'))
  assert.equal(plan.port, 8188)
  assert.deepEqual(plan.argv, ['-s', mainPy, '--listen', '127.0.0.1', '--port', '8188'])
})

test('unusable records mean no install; an explicitly named bad dir throws', () => {
  const tmp = freshDir()
  // A cloud-only record has no installPath and must be skipped, not guessed at.
  mkdirSync(join(tmp, 'Comfy Desktop'), { recursive: true })
  writeFileSync(join(tmp, 'Comfy Desktop', 'installations.json'), JSON.stringify([{ id: 'cloud', status: 'installed' }]))
  assert.equal(discoverComfyPlan({ env: {}, platform: 'win32', appData: tmp, scanRoots: [] }), null)
  assert.throws(
    () => discoverComfyPlan({ dir: join(tmp, 'nope'), env: {}, platform: 'win32', appData: tmp, scanRoots: [] }),
    (error) => error.message.includes('no main.py or no Python found inside'),
  )
})

test('Desktop launchArgs are split the way a shell would', () => {
  assert.deepEqual(splitArgs('--enable-manager --reserve-vram 1'), ['--enable-manager', '--reserve-vram', '1'])
  assert.deepEqual(splitArgs('--foo "bar baz" --x'), ['--foo', 'bar baz', '--x'])
  assert.deepEqual(splitArgs(''), [])
})

test('port-table probing reaches a fake ComfyUI and reports it ready', async () => {
  const fake = await startStatsServer()
  try {
    const options = environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(fake.port), timeoutMs: 1000 })
    const status = await inspectEnvironment(options, { env: {}, platform: 'win32', appData: freshDir(), scanRoots: [] })
    assert.equal(status.state, 'ready')
    assert.equal(status.source, 'port-probe')
    assert.equal(status.endpoint, `http://127.0.0.1:${fake.port}`)
    assert.equal(status.stats?.version, 'fake-0.0')
    assert.equal(status.stats?.devices?.[0]?.name, 'fake-gpu')
    assert.ok(status.probed.length >= 1)
    assert.equal(status.hint, null)
    assert.ok(fake.seen.includes('/system_stats'))
  } finally {
    await fake.close()
  }
})

test('a configured endpoint that answers is used as-is', async () => {
  const fake = await startStatsServer()
  try {
    const options = environmentOptionsOf({
      comfyEndpoint: `http://127.0.0.1:${fake.port}/`,
      comfyPorts: '8000',
      timeoutMs: 1000,
    })
    const status = await inspectEnvironment(options, { env: {}, platform: 'win32', appData: freshDir(), scanRoots: [] })
    assert.equal(status.state, 'ready')
    assert.equal(status.source, 'configured')
    assert.equal(status.endpoint, `http://127.0.0.1:${fake.port}`)
  } finally {
    await fake.close()
  }
})

test('nothing running: install found → not-running, no install → not-installed', async () => {
  const closed = await freePort()
  const options = environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(closed), timeoutMs: 1000 })

  const machine = makeMachine(freshDir(), { port: closed })
  const withInstall = await inspectEnvironment(options, depsOf(machine))
  assert.equal(withInstall.state, 'not-running')
  assert.equal(withInstall.install?.installPath, machine.installPath)
  assert.equal(withInstall.install?.port, closed)
  assert.ok((withInstall.hint ?? '').includes('start'))

  const noInstall = await inspectEnvironment(options, { env: {}, platform: 'win32', appData: freshDir(), scanRoots: [] })
  assert.equal(noInstall.state, 'not-installed')
  assert.equal(noInstall.install, null)
  assert.match(noInstall.note, /没找到|没有发现/)
  assert.ok((noInstall.hint ?? '').includes('docs/comfyui-deployment.md'))
})

test('start spawns the recorded install detached, then waits for /system_stats', async () => {
  const fake = await startStatsServer()
  try {
    const closed = await freePort()
    const machine = makeMachine(freshDir(), { port: fake.port })
    const spawnCalls = []
    const child = { pid: 4242, exitCode: null, unrefCalls: 0, unref() { this.unrefCalls += 1 } }
    const spawn = (...args) => {
      spawnCalls.push(args)
      return child
    }
    const options = {
      ...environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(closed), timeoutMs: 1000 }),
      installTimeoutMs: 5000,
      waitIntervalMs: 20,
    }
    const status = await ensureEnvironment(options, depsOf(machine, { spawn }))

    assert.equal(status.state, 'ready')
    assert.equal(status.source, 'launched')
    assert.equal(status.endpoint, `http://127.0.0.1:${fake.port}`)
    assert.equal(status.install?.installPath, machine.installPath)
    assert.equal(status.stats?.version, 'fake-0.0')
    assert.equal(spawnCalls.length, 1)
    const [python, argv, spawnOptions] = spawnCalls[0]
    assert.equal(python, machine.winPython)
    assert.deepEqual(argv.slice(0, 6), ['-s', machine.mainPy, '--listen', '127.0.0.1', '--port', String(fake.port)])
    assert.equal(spawnOptions.detached, true)
    assert.equal(spawnOptions.windowsHide, true)
    assert.equal(child.unrefCalls, 1)

    const recordPath = join(machine.installPath, 'logs', 'dsh-image-forge-launch.json')
    assert.ok(existsSync(recordPath), 'the launch record must name the pid')
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    assert.equal(record.pid, 4242)
    assert.equal(record.endpoint, `http://127.0.0.1:${fake.port}`)
    assert.ok(typeof status.logPath === 'string' && existsSync(status.logPath))
  } finally {
    await fake.close()
  }
})

test('start is a no-op when the port table already answers (no second instance)', async () => {
  const fake = await startStatsServer()
  try {
    const machine = makeMachine(freshDir(), { port: fake.port })
    const spawn = () => {
      throw new Error('must not spawn a second ComfyUI')
    }
    const options = environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(fake.port), timeoutMs: 1000 })
    const status = await ensureEnvironment(options, depsOf(machine, { spawn }))
    assert.equal(status.state, 'ready')
    assert.equal(status.source, 'port-probe')
  } finally {
    await fake.close()
  }
})

test('an immediately exiting child is launch-failed, with its log path', async () => {
  const closed = await freePort()
  const machine = makeMachine(freshDir(), { port: closed })
  const child = { pid: 5151, exitCode: 1, unref() {} }
  const options = {
    ...environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(closed), timeoutMs: 1000 }),
    installTimeoutMs: 2000,
    waitIntervalMs: 20,
  }
  const status = await ensureEnvironment(options, depsOf(machine, { spawn: () => child }))
  assert.equal(status.state, 'launch-failed')
  assert.match(status.note, /exit code 1/)
  assert.equal(status.install?.installPath, machine.installPath)
  assert.ok(typeof status.logPath === 'string' && existsSync(status.logPath))
})

test('a child that never answers is a timeout, and is not retried', async () => {
  const closed = await freePort()
  const machine = makeMachine(freshDir(), { port: closed })
  let spawns = 0
  const child = { pid: 6161, exitCode: null, unref() {} }
  const spawn = () => {
    spawns += 1
    return child
  }
  const options = {
    ...environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(closed), timeoutMs: 1000 }),
    installTimeoutMs: 400,
    waitIntervalMs: 20,
  }
  const status = await ensureEnvironment(options, depsOf(machine, { spawn }))
  assert.equal(status.state, 'timeout')
  assert.equal(spawns, 1, 'a timeout must not become a retry loop')
  assert.ok((status.waitedMs ?? 0) >= 300)
  assert.ok(status.note.includes('没有就绪'))
})

test('stop kills the recorded pid tree on Windows and signals it on POSIX', () => {
  const machine = makeMachine(freshDir())
  const plan = discoverComfyPlan(depsOf(machine))
  const recordDir = join(plan.logDir)
  mkdirSync(recordDir, { recursive: true })
  writeFileSync(
    join(recordDir, 'dsh-image-forge-launch.json'),
    JSON.stringify({ pid: 4242, endpoint: 'http://127.0.0.1:18188', startedAt: '2026-01-01T00:00:00.000Z', logPath: join(recordDir, 'x.log') }),
  )

  const winCalls = []
  const win = stopEnvironment(depsOf(machine, { spawnSync: (...args) => { winCalls.push(args); return { status: 0 } } }))
  assert.equal(win.stopped, true)
  assert.equal(win.pid, 4242)
  assert.deepEqual(winCalls, [['taskkill', ['/PID', '4242', '/T', '/F'], { stdio: 'ignore' }]])

  const killed = []
  const posix = stopEnvironment(depsOf(machine, {
    platform: 'linux',
    kill: (pid, signal) => killed.push([pid, signal]),
    spawnSync: () => { throw new Error('taskkill must not run on POSIX') },
  }))
  assert.equal(posix.stopped, true)
  assert.deepEqual(killed, [[4242, 'SIGTERM']])
})

test('stop with no launch record reports nothing to stop', () => {
  const machine = makeMachine(freshDir())
  const result = stopEnvironment(depsOf(machine))
  assert.equal(result.stopped, false)
  assert.equal(result.pid, null)
  assert.ok(result.note.includes('no launch record'))
})

test('the environment tool is qwen_image_setup, never the retired qwen_image_env', () => {
  let captured = null
  const ctx = { tools: { register: (definition) => { captured = definition } } }
  registerEnvironmentTools(ctx, () => ({ comfyEndpoint: '', comfyPorts: '8188', timeoutMs: 1000 }))
  assert.ok(captured, 'registration must define exactly one tool')
  assert.equal(captured.name, ENVIRONMENT_TOOL_NAME)
  assert.equal(captured.name, 'qwen_image_setup')
  assert.notEqual(captured.name, 'qwen_image_env')
  const parameters = captured.parameters ?? {}
  const action = parameters.action ?? parameters.properties?.action
  assert.equal(action.type, 'string')
  assert.deepEqual(action.enum, ['status', 'start', 'stop'])
  const timeout = parameters.timeoutMs ?? parameters.properties?.timeoutMs
  assert.equal(timeout.type, 'integer')
  assert.equal(typeof captured.execute, 'function')
  assert.equal(captured.isConcurrencySafe(), false)
})

test('environmentOptionsOf reuses the ComfyUI port parser and trims the endpoint', () => {
  const options = environmentOptionsOf({ comfyEndpoint: 'http://127.0.0.1:8188///', comfyPorts: ' 8000, nope, 8188 ', timeoutMs: 1000 })
  assert.equal(options.endpoint, 'http://127.0.0.1:8188')
  assert.deepEqual(options.ports, [8000, 8188])
  assert.equal(options.installTimeoutMs, DEFAULT_INSTALL_TIMEOUT_MS)
  assert.equal(options.probeTimeoutMs, 800)
  // An unparseable list falls back to the documented default port table.
  assert.equal(environmentOptionsOf({ comfyEndpoint: '', comfyPorts: 'x', timeoutMs: 1 }).ports.length, 6)
})
