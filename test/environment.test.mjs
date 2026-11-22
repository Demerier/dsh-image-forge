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
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ENVIRONMENT_TOOL_NAME,
  checkObjectInfoFile,
  downloadOneWeight,
  ensureEnvironment,
  ensureProfileWeights,
  environmentOptionsOf,
  inspectEnvironment,
  installGuidanceOf,
  parseModelsBaseYaml,
  registerEnvironmentTools,
  resolveModelsBase,
  runInstallAutomation,
  stopEnvironment,
  weightPlanOf,
} from '../src/environment.ts'
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  discoverComfyPlan,
  loopbackPortOf,
  planForRun,
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
    // The pre-flight probe must see a *free* port before the spawn (that is the
    // whole point of it), then the launch wait must see the child answering.
    let probes = 0
    const fetchImpl = async () => {
      probes += 1
      if (probes <= 1) throw new Error('connect ECONNREFUSED (fake pre-flight)')
      return new Response(JSON.stringify({ system: { comfyui_version: 'fake-0.0' }, devices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const options = {
      ...environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(closed), timeoutMs: 1000 }),
      installTimeoutMs: 5000,
      waitIntervalMs: 20,
    }
    const status = await ensureEnvironment(options, depsOf(machine, { spawn, fetchImpl, portProbe: async () => false }))

    assert.equal(status.state, 'ready')
    assert.equal(status.source, 'launched')
    assert.equal(status.endpoint, `http://127.0.0.1:${fake.port}`)
    assert.equal(status.install?.installPath, machine.installPath)
    assert.equal(status.stats?.version, 'fake-0.0')
    assert.equal(status.owned, true, 'a launch this call performed is owned')
    assert.equal(status.pid, 4242)
    assert.ok(Array.isArray(status.argvPreview), 'the argv preview must be reported')
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
    assert.equal(record.mainPy, machine.mainPy, 'the record must carry the identity the stop path checks')
    assert.equal(record.port, fake.port)
    assert.ok(Array.isArray(record.argv) && record.argv.length > 0)
    assert.ok(typeof status.logPath === 'string' && existsSync(status.logPath))
  } finally {
    await fake.close()
  }
})

test('a launch port that already answers is not spawned again', async () => {
  // The realistic version of the port pre-flight: the Desktop record's port is
  // already serving ComfyUI (the user opened it themselves), while the configured
  // port table points somewhere else. The old code spawned a second renderer and
  // then waited the full budget on a port the panel was not probing.
  const fake = await startStatsServer()
  try {
    const closed = await freePort()
    const machine = makeMachine(freshDir(), { port: fake.port })
    const spawn = () => {
      throw new Error('a port that already answers must not be spawned on')
    }
    const options = {
      ...environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(closed), timeoutMs: 1000 }),
      installTimeoutMs: 5000,
      waitIntervalMs: 20,
    }
    const status = await ensureEnvironment(options, depsOf(machine, { spawn, portProbe: async () => true }))
    assert.notEqual(status.state, 'timeout')
    assert.ok(status.note.includes('没有重复拉起'), 'the note says why nothing was started: ' + status.note)
    assert.equal(status.owned, false, 'an instance this call did not start is not owned')
  } finally {
    await fake.close()
  }
})

test('a configured loopback endpoint pins the port argv, the wait and the record use', async () => {
  // Bug 1: the launch used to take `plan.port` (the Desktop record's) while the
  // panel probed `comfyEndpoint`. Setting `:18000` therefore launched `:18188`
  // and waited there, so the panel never turned green.
  const pinned = await freePort()
  const machine = makeMachine(freshDir(), { port: 18188 })
  const spawnCalls = []
  const child = { pid: 7373, exitCode: null, unref() {} }
  const probedUrls = []
  const fetchImpl = async (url) => {
    probedUrls.push(String(url))
    if (probedUrls.length <= 1) throw new Error('connect ECONNREFUSED (fake pre-flight)')
    return new Response(JSON.stringify({ system: { comfyui_version: 'fake-0.0' }, devices: [] }), { status: 200 })
  }
  const options = {
    ...environmentOptionsOf({ comfyEndpoint: `http://127.0.0.1:${pinned}`, comfyPorts: '8188', timeoutMs: 1000 }),
    installTimeoutMs: 1500,
    waitIntervalMs: 20,
  }
  const status = await ensureEnvironment(options, depsOf(machine, {
    spawn: (...args) => { spawnCalls.push(args); return child },
    fetchImpl,
    portProbe: async () => false,
  }))

  assert.equal(spawnCalls.length, 1, 'the pinned port does not prevent the launch')
  const [, argv] = spawnCalls[0]
  assert.deepEqual(argv.slice(0, 6), ['-s', machine.mainPy, '--listen', '127.0.0.1', '--port', String(pinned)])
  assert.equal(status.port, pinned, 'plan, argv and the report agree on one port')
  assert.equal(status.endpoint, `http://127.0.0.1:${pinned}`)
  assert.ok(probedUrls.every((url) => url.includes(`:${pinned}/`)), 'the wait polls the pinned port: ' + probedUrls.join(', '))
  const record = JSON.parse(readFileSync(join(machine.installPath, 'logs', 'dsh-image-forge-launch.json'), 'utf8'))
  assert.equal(record.port, pinned, 'the record names the same port, so stop verifies the right one')
  assert.equal(record.endpoint, `http://127.0.0.1:${pinned}`)
})

test('planForRun leaves the planned argv byte-identical unless it has something to change', () => {
  const machine = makeMachine(freshDir())
  const plan = discoverComfyPlan(depsOf(machine))
  assert.equal(planForRun(plan), plan, 'no override, no copy: the default argv is untouched')
  assert.deepEqual(planForRun(plan, { extraArgs: [] }).argv, plan.argv, 'an empty extraArgs appends nothing')

  const moved = planForRun(plan, { port: 19000 })
  assert.equal(moved.port, 19000)
  assert.deepEqual(moved.argv.slice(0, 6), ['-s', machine.mainPy, '--listen', '127.0.0.1', '--port', '19000'])
  assert.deepEqual(moved.argv.slice(6), plan.argv.slice(6), 'everything after the port pair is untouched')

  const extra = planForRun(plan, { extraArgs: ['--lowvram-extra', '1'] })
  assert.deepEqual(extra.argv.slice(-2), ['--lowvram-extra', '1'], 'stage 3 flags land after the planned argv')
  assert.equal(plan.argv.includes('--lowvram-extra'), false, 'the input plan is not mutated')

  assert.equal(loopbackPortOf('http://127.0.0.1:8000'), 8000)
  assert.equal(loopbackPortOf('http://localhost:8000/'), 8000)
  assert.equal(loopbackPortOf('http://192.168.1.7:8000'), null, 'a remote endpoint must not pin a local port')
  assert.equal(loopbackPortOf(''), null)
})

test('a live instance this plugin already started is not started twice', async () => {
  const closed = await freePort()
  const machine = makeMachine(freshDir(), { port: closed })
  writeLaunchRecord(machine, { pid: 9911, endpoint: `http://127.0.0.1:${closed}`, port: closed })
  let spawns = 0
  const options = {
    ...environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(closed), timeoutMs: 1000 }),
    installTimeoutMs: 1500,
    waitIntervalMs: 20,
  }
  const status = await ensureEnvironment(options, depsOf(machine, {
    spawn: () => { spawns += 1; throw new Error('must not spawn a second instance') },
    commandLineOf: () => ownedCommandLine(machine),
    // Deterministic liveness: signal 0 succeeds, so the recorded pid is "alive"
    // without depending on which pids this machine happens to have.
    kill: () => {},
    fetchImpl: refusedFetch,
    portProbe: async () => false,
  }))
  assert.equal(spawns, 0, 'the existing pid is the only handle; a second spawn would orphan it')
  assert.equal(status.state, 'launch-failed')
  assert.equal(status.pid, 9911)
  assert.ok(status.note.includes('没有重复拉起'))
})

test('a launch record is kept as history instead of silently overwritten', async () => {
  const closed = await freePort()
  const machine = makeMachine(freshDir(), { port: closed })
  // An earlier launch left a record whose process is gone.
  writeLaunchRecord(machine, { pid: 1111 })
  const child = { pid: 2222, exitCode: null, unref() {} }
  const options = {
    ...environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(closed), timeoutMs: 1000 }),
    installTimeoutMs: 1500,
    waitIntervalMs: 20,
  }
  let probes = 0
  const fetchImpl = async () => {
    probes += 1
    if (probes <= 1) throw new Error('connect ECONNREFUSED (fake pre-flight)')
    return new Response(JSON.stringify({ devices: [] }), { status: 200 })
  }
  await ensureEnvironment(options, depsOf(machine, {
    spawn: () => child,
    fetchImpl,
    commandLineOf: () => null, // pid 1111 cannot be proved alive → not "alive"
    kill: () => { const gone = new Error('kill ESRCH'); gone.code = 'ESRCH'; throw gone },
    portProbe: async () => false,
  }))
  const record = JSON.parse(readFileSync(join(machine.installPath, 'logs', 'dsh-image-forge-launch.json'), 'utf8'))
  assert.equal(record.pid, 2222)
  assert.equal(Array.isArray(record.history), true, 'the previous pid must not vanish')
  assert.equal(record.history.at(-1)?.pid, 1111)
})

test('an occupied port that is not ComfyUI is refused before spawning', async () => {
  const closed = await freePort()
  const machine = makeMachine(freshDir(), { port: closed })
  const spawn = () => {
    throw new Error('an occupied port must not be spawned on')
  }
  const options = {
    ...environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(closed), timeoutMs: 1000 }),
    installTimeoutMs: 5000,
    waitIntervalMs: 20,
  }
  const status = await ensureEnvironment(options, depsOf(machine, { spawn, portProbe: async () => true }))
  assert.equal(status.state, 'launch-failed')
  assert.match(status.note, /端口被占/)
  assert.equal(status.port, closed)
  assert.ok(typeof status.hint === 'string' && status.hint.includes('comfyEndpoint'))
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

/** Write the launch record a previous start would have left behind. */
function writeLaunchRecord(machine, overrides = {}) {
  const dir = join(machine.installPath, 'logs')
  mkdirSync(dir, { recursive: true })
  const record = {
    pid: 4242,
    endpoint: 'http://127.0.0.1:18188',
    port: 18188,
    mainPy: machine.mainPy,
    python: machine.winPython,
    argv: ['-s', machine.mainPy, '--listen', '127.0.0.1', '--port', '18188'],
    startedAt: '2026-01-01T00:00:00.000Z',
    logPath: join(dir, 'x.log'),
    ...overrides,
  }
  writeFileSync(join(dir, 'dsh-image-forge-launch.json'), JSON.stringify(record))
  return record
}

/** A command line that really is the recorded install (the ownership proof). */
function ownedCommandLine(machine) {
  return `"${machine.winPython}" -s "${machine.mainPy}" --listen 127.0.0.1 --port 18188`
}

/** A fetch stub that says "nothing is listening" — the post-stop expectation. */
const refusedFetch = async () => {
  throw new Error('connect ECONNREFUSED')
}

test('stop kills the recorded pid tree on Windows and signals it on POSIX', async () => {
  const machine = makeMachine(freshDir())
  const recordPath = join(machine.installPath, 'logs', 'dsh-image-forge-launch.json')

  writeLaunchRecord(machine)
  const winCalls = []
  const win = await stopEnvironment(depsOf(machine, {
    spawnSync: (...args) => { winCalls.push(args); return { status: 0 } },
    commandLineOf: () => ownedCommandLine(machine),
    fetchImpl: refusedFetch,
  }))
  assert.equal(win.stopped, true)
  assert.equal(win.pid, 4242)
  assert.equal(win.exitCode, 0, 'the exit code of taskkill is part of the answer')
  assert.equal(win.verified, true, 'the port probe decided the process really went away')
  assert.deepEqual(winCalls, [['taskkill', ['/PID', '4242', '/T', '/F'], { stdio: 'ignore' }]])
  assert.equal(existsSync(recordPath), false, 'a successful stop deletes the record')

  // The record is gone after the Windows half; a second stop is "no record".
  const again = await stopEnvironment(depsOf(machine, { spawnSync: () => { throw new Error('must not run') } }))
  assert.equal(again.stopped, false)
  assert.equal(again.reason, 'no-record')

  writeLaunchRecord(machine)
  const killed = []
  const posix = await stopEnvironment(depsOf(machine, {
    platform: 'linux',
    kill: (pid, signal) => killed.push([pid, signal]),
    spawnSync: () => { throw new Error('taskkill must not run on POSIX') },
    commandLineOf: () => ownedCommandLine(machine),
    fetchImpl: refusedFetch,
  }))
  assert.equal(posix.stopped, true)
  assert.deepEqual(killed, [[4242, 'SIGTERM']])
})

test('stop refuses a pid whose command line is not the recorded main.py', async () => {
  const machine = makeMachine(freshDir())
  const recordPath = join(machine.installPath, 'logs', 'dsh-image-forge-launch.json')
  writeLaunchRecord(machine)
  const winCalls = []
  const killed = []
  const result = await stopEnvironment(depsOf(machine, {
    // Same pid, different program: the OS may have recycled it.
    commandLineOf: () => '"C:\\\\other\\\\python.exe" -m http.server 8188',
    spawnSync: (...args) => { winCalls.push(args); return { status: 0 } },
    kill: (pid, signal) => killed.push([pid, signal]),
    fetchImpl: refusedFetch,
  }))
  assert.equal(result.stopped, false)
  assert.equal(result.reason, 'not-owned')
  assert.match(result.note, /未执行停止/)
  assert.deepEqual(winCalls, [], 'taskkill must not run for a process we cannot claim')
  assert.deepEqual(killed, [], 'no signal either')
  assert.ok(existsSync(recordPath), 'the record survives a refused stop')
})

test('stop refuses when the command line cannot be read, and says so', async () => {
  const machine = makeMachine(freshDir())
  writeLaunchRecord(machine)
  const winCalls = []
  const result = await stopEnvironment(depsOf(machine, {
    commandLineOf: () => null,
    spawnSync: (...args) => { winCalls.push(args); return { status: 0 } },
    fetchImpl: refusedFetch,
  }))
  assert.equal(result.stopped, false)
  assert.equal(result.reason, 'unverified')
  assert.match(result.note, /无法确认/)
  assert.deepEqual(winCalls, [], 'an unprovable pid is never killed')
})

test('stop reports a still-answering port and keeps the record for a retry', async () => {
  const machine = makeMachine(freshDir())
  const recordPath = join(machine.installPath, 'logs', 'dsh-image-forge-launch.json')
  writeLaunchRecord(machine)
  const result = await stopEnvironment(depsOf(machine, {
    spawnSync: () => ({ status: 0 }),
    commandLineOf: () => ownedCommandLine(machine),
    // The signal landed, but ComfyUI still answers /system_stats.
    fetchImpl: async () => new Response(JSON.stringify({ devices: [] }), { status: 200 }),
  }))
  assert.equal(result.stopped, true)
  assert.equal(result.reason, 'port-still-up')
  assert.equal(result.verified, false)
  assert.match(result.note, /仍在应答/)
  assert.ok(existsSync(recordPath), 'the handle is kept so the next click can retry')
})

test('POSIX ESRCH means "already gone", not a thrown error', async () => {
  const machine = makeMachine(freshDir())
  const recordPath = join(machine.installPath, 'logs', 'dsh-image-forge-launch.json')
  writeLaunchRecord(machine)
  const esrch = new Error('kill ESRCH')
  esrch.code = 'ESRCH'
  const result = await stopEnvironment(depsOf(machine, {
    platform: 'linux',
    kill: () => { throw esrch },
    commandLineOf: () => ownedCommandLine(machine),
    fetchImpl: refusedFetch,
  }))
  assert.equal(result.stopped, true, 'a process that is already gone still counts as stopped')
  assert.equal(result.reason, null)
  assert.equal(existsSync(recordPath), false)
})

test('stop with no launch record reports nothing to stop', async () => {
  const machine = makeMachine(freshDir())
  const result = await stopEnvironment(depsOf(machine))
  assert.equal(result.stopped, false)
  assert.equal(result.pid, null)
  assert.equal(result.reason, 'no-record')
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
  assert.deepEqual(action.enum, ['status', 'start', 'stop', 'install', 'download'], 'P1b adds install/download to the same tool')
  const timeout = parameters.timeoutMs ?? parameters.properties?.timeoutMs
  assert.equal(timeout.type, 'integer')
  const confirm = parameters.confirm ?? parameters.properties?.confirm
  assert.equal(confirm.type, 'boolean', 'download needs an explicit confirm')
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

// ---------------------------------------------------------------------------
// P1b (T14): model-root resolution, downloads and the /object_info criterion.
// ---------------------------------------------------------------------------

test('parseModelsBaseYaml reads base_path, with quotes, and returns null otherwise', () => {
  assert.equal(parseModelsBaseYaml("comfy.desktop_0:\n  base_path: 'D:\\\\models'\n"), 'D:\\\\models')
  assert.equal(parseModelsBaseYaml('comfyui:\n  base_path: shared\n'), 'shared')
  assert.equal(parseModelsBaseYaml('  base_path: "C:/x/models"'), 'C:/x/models')
  assert.equal(parseModelsBaseYaml('is_default: true'), null)
  assert.equal(parseModelsBaseYaml(''), null)
})

test('resolveModelsBase uses the running instance argv first, then the Desktop yaml', async () => {
  const tmp = freshDir()
  const shared = join(tmp, 'shared-models')
  const yamlPath = join(tmp, 'inst-argv.yaml')
  writeFileSync(yamlPath, "comfy.desktop_0:\n  base_path: '" + shared + "'\n")
  const seen = []
  const server = createServer((request, response) => {
    seen.push(request.url)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ system: { argv: ['-s', 'main.py', '--extra-model-paths-config', yamlPath] }, devices: [] }))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port
    const resolved = await resolveModelsBase({ endpoint }, { env: {}, platform: 'win32', appData: freshDir(), scanRoots: [] })
    assert.equal(resolved.source, 'instance-argv')
    assert.equal(resolved.base, shared)
    assert.ok(seen.includes('/system_stats'))
  } finally {
    await new Promise((done) => server.close(done))
  }

  const machine = makeMachine(freshDir())
  const fromYaml = await resolveModelsBase({ endpoint: null }, depsOf(machine))
  assert.equal(fromYaml.source, 'desktop-yaml')
  assert.equal(fromYaml.base, join(machine.desktop, 'instance-model-paths', 'shared'), 'relative base_path resolves against the yaml')
})

test('resolveModelsBase falls back to settings.json modelsDirs, then the install tree', async () => {
  const tmp = freshDir()
  const desktop = join(tmp, 'Comfy Desktop')
  mkdirSync(desktop, { recursive: true })
  const wanted = join(tmp, 'wanted-models')
  writeFileSync(join(desktop, 'settings.json'), JSON.stringify({ modelsDirs: [wanted] }))
  const settingsOnly = await resolveModelsBase({ endpoint: null }, { env: {}, platform: 'win32', appData: tmp, scanRoots: [] })
  assert.equal(settingsOnly.source, 'desktop-settings')
  assert.equal(settingsOnly.base, wanted)

  const machine = makeMachine(freshDir())
  rmSync(join(machine.desktop, 'instance-model-paths'), { recursive: true })
  const tree = join(dirname(machine.mainPy), 'models')
  mkdirSync(tree, { recursive: true })
  const fromTree = await resolveModelsBase({ endpoint: null }, depsOf(machine))
  assert.equal(fromTree.source, 'install-tree')
  assert.equal(fromTree.base, tree)
})

test('weightPlanOf maps each profile weight to its folder and exact file name', () => {
  const base = join('D:', 'models')
  const qwen = weightPlanOf('qwen21-base', base)
  assert.deepEqual(qwen.map((item) => item.folder), ['unet', 'clip', 'vae'])
  assert.deepEqual(qwen.map((item) => item.filename), [
    'qwen_image_2.1_int8_convrot.safetensors',
    'qwen3vl_8b_int8_convrot.safetensors',
    'qwen_image_2.1_vae_bf16.safetensors',
  ])
  assert.equal(qwen[0].targetPath, join(base, 'unet', 'qwen_image_2.1_int8_convrot.safetensors'))
  assert.equal(qwen[0].source?.bytes, 7_256_783_064)
  assert.equal(qwen[0].source?.sha256?.length, 64)
  const moss = weightPlanOf('moss-sft', base)
  assert.deepEqual(moss.map((item) => item.folder), ['diffusion_models', 'text_encoders', 'vae'])
  assert.equal(weightPlanOf('qwen21-base', null)[0].targetPath, null)
})

test('downloadOneWeight streams to .part, verifies, and renames atomically', async () => {
  const dir = freshDir()
  const body = Buffer.from('fake-weight-bytes-0123456789')
  const target = join(dir, 'unet', 'w.safetensors')
  const sha = createHash('sha256').update(body).digest('hex')
  const fetchImpl = async () => new Response(body, { status: 200 })
  const outcome = await downloadOneWeight({ url: 'https://fake/w', targetPath: target, expectedBytes: body.length, sha256: sha, fetchImpl })
  assert.equal(outcome.state, 'downloaded')
  assert.equal(outcome.sha256Ok, true)
  assert.equal(readFileSync(target).length, body.length)
  assert.equal(existsSync(target + '.part'), false, 'the part file is renamed away')

  const again = await downloadOneWeight({ url: 'https://fake/w', targetPath: target, expectedBytes: body.length, sha256: sha, fetchImpl })
  assert.equal(again.state, 'already-present')

  const bad = await downloadOneWeight({ url: 'https://fake/w', targetPath: join(dir, 'x.safetensors'), expectedBytes: body.length + 1, sha256: null, fetchImpl })
  assert.equal(bad.state, 'failed')
  assert.ok(bad.note.includes('字节数不对'))
  assert.ok(existsSync(join(dir, 'x.safetensors') + '.part'), 'a failed download keeps its .part for resume')
})

test('downloadOneWeight resumes a .part with Range, and restarts when the server ignores it', async () => {
  const dir = freshDir()
  const body = Buffer.from('0123456789abcdefghij')
  const target = join(dir, 'resume.safetensors')
  writeFileSync(target + '.part', body.subarray(0, 7))
  const ranged = []
  const honouring = async (url, init) => {
    ranged.push(init.headers?.Range ?? null)
    return new Response(body.subarray(7), { status: 206 })
  }
  const resumed = await downloadOneWeight({ url: 'https://fake/r', targetPath: target, expectedBytes: body.length, sha256: null, fetchImpl: honouring })
  assert.equal(resumed.state, 'resumed')
  assert.equal(resumed.partBytesAtStart, 7)
  assert.deepEqual(ranged, ['bytes=7-'])
  assert.equal(readFileSync(target).toString(), body.toString())

  const dir2 = freshDir()
  const target2 = join(dir2, 'restart.safetensors')
  writeFileSync(target2 + '.part', body.subarray(0, 5))
  const ignoring = async () => new Response(body, { status: 200 })
  const restarted = await downloadOneWeight({ url: 'https://fake/r2', targetPath: target2, expectedBytes: body.length, sha256: null, fetchImpl: ignoring })
  assert.equal(restarted.state, 'downloaded')
  assert.equal(readFileSync(target2).toString(), body.toString())
})

test('checkObjectInfoFile requires the exact file name, not a regex hit', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ UNETLoader: { input: { required: { unet_name: [['another_file.safetensors', 'qwen_image_2.1_int8_convrot.safetensors'], {}] } } } }))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port
    const exact = await checkObjectInfoFile({ endpoint, loader: 'UNETLoader', field: 'unet_name', filename: 'qwen_image_2.1_int8_convrot.safetensors' })
    assert.equal(exact.listed, true)
    const nearMiss = await checkObjectInfoFile({ endpoint, loader: 'UNETLoader', field: 'unet_name', filename: 'qwen_image_2.1.safetensors' })
    assert.equal(nearMiss.listed, false)
    assert.equal(nearMiss.options.length, 2)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('dry-run never writes: existing files are reported, missing ones are planned', async () => {
  const base = freshDir()
  const tiny = Buffer.from('tiny')
  const sources = {}
  for (const name of ['qwen_image_2.1_int8_convrot.safetensors', 'qwen3vl_8b_int8_convrot.safetensors', 'qwen_image_2.1_vae_bf16.safetensors']) {
    sources[name] = { url: 'https://fake/' + name, bytes: tiny.length, sha256: null, repoPath: name, urlVerified: true }
  }
  const plan = weightPlanOf('qwen21-base', base, sources)
  mkdirSync(dirname(plan[0].targetPath), { recursive: true })
  writeFileSync(plan[0].targetPath, tiny)
  const outcome = await ensureProfileWeights({ profileId: 'qwen21-base', base, endpoint: null, dryRun: true, sources })
  // A file already on disk at the expected size is *done*, not "planned": the
  // two used to share `dry-run`, which made the panel offer a download for it.
  assert.equal(outcome.weights[0].state, 'already-present')
  assert.equal(outcome.weights[1].state, 'would-download')
  assert.equal(outcome.state, 'ready', 'nothing to fetch is not a failure')
  assert.equal(existsSync(plan[1].targetPath), false)
})

test('no models root is blocked, and a download without a live endpoint is unverified', async () => {
  const blocked = await ensureProfileWeights({ profileId: 'qwen21-base', base: null, endpoint: null })
  assert.equal(blocked.state, 'blocked')
  assert.ok(blocked.weights.every((item) => item.state === 'no-base'))

  const base = freshDir()
  const tiny = Buffer.from('tiny')
  const sources = {
    'qwen_image_2.1_int8_convrot.safetensors': { url: 'https://fake/1', bytes: 4, sha256: createHash('sha256').update(tiny).digest('hex'), repoPath: 'x', urlVerified: true },
    'qwen3vl_8b_int8_convrot.safetensors': { url: 'https://fake/2', bytes: 4, sha256: null, repoPath: 'x', urlVerified: true },
    'qwen_image_2.1_vae_bf16.safetensors': { url: 'https://fake/3', bytes: 4, sha256: null, repoPath: 'x', urlVerified: true },
  }
  const outcome = await ensureProfileWeights({
    profileId: 'qwen21-base',
    base,
    endpoint: null,
    sources,
    deps: { fetchImpl: async () => new Response(tiny, { status: 200 }) },
  })
  assert.equal(outcome.state, 'unverified', 'a file on disk is not success without /object_info')
  assert.ok(outcome.weights.every((item) => item.state === 'unverified'))
})

test('fake closed loop: download -> rename -> /object_info lists the exact name', async () => {
  const base = freshDir()
  const tiny = Buffer.from('fake-weight')
  const sources = {}
  for (const item of weightPlanOf('qwen21-base', base)) {
    sources[item.filename] = { url: 'http://127.0.0.1:0/file/' + encodeURIComponent(item.filename), bytes: tiny.length, sha256: createHash('sha256').update(tiny).digest('hex'), repoPath: item.filename, urlVerified: true }
  }
  const kindsByLoader = { UNETLoader: ['unet', 'diffusion_models'], CLIPLoader: ['clip', 'text_encoders'], VAELoader: ['vae'] }
  const served = []
  const server = createServer((request, response) => {
    served.push(request.url)
    if (request.url === '/system_stats') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ system: { argv: [] }, devices: [] }))
      return
    }
    if (request.url.startsWith('/object_info/')) {
      const loader = request.url.slice('/object_info/'.length)
      const field = loader === 'UNETLoader' ? 'unet_name' : loader === 'CLIPLoader' ? 'clip_name' : 'vae_name'
      const folders = kindsByLoader[loader]
      const names = []
      for (const folder of folders) {
        const dir = join(base, folder)
        if (!existsSync(dir)) continue
        for (const name of readdirSync(dir)) if (name.endsWith('.safetensors')) names.push(name)
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ [loader]: { input: { required: { [field]: [names, {}] } } } }))
      return
    }
    if (request.url.startsWith('/file/')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': tiny.length })
      response.end(tiny)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  try {
    for (const key of Object.keys(sources)) sources[key].url = 'http://127.0.0.1:' + port + '/file/' + encodeURIComponent(key)
    const outcome = await ensureProfileWeights({ profileId: 'qwen21-base', base, endpoint: 'http://127.0.0.1:' + port, sources })
    console.log('closed-loop outcome:', JSON.stringify(outcome.weights.map((item) => [item.kind, item.state])))
    assert.equal(outcome.state, 'downloaded')
    assert.deepEqual(outcome.weights.map((item) => item.state), ['installed', 'installed', 'installed'])
    for (const item of outcome.weights) {
      assert.ok(item.targetPath && existsSync(item.targetPath), 'the weight is on disk: ' + item.filename)
      assert.equal(existsSync(item.targetPath + '.part'), false)
      assert.equal(item.objectInfo.listed, true)
    }
    assert.ok(served.some((url) => url.startsWith('/object_info/UNETLoader')))
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('install guidance: the unauthorised path never runs automation, the authorised one does', async () => {
  const manual = installGuidanceOf({}, false)
  assert.equal(manual.state, 'not-installed')
  assert.equal(manual.mode, 'manual')
  assert.equal(manual.authorized, false)
  assert.equal(manual.downloadPage, 'https://www.comfy.org/download')
  assert.ok(manual.steps.length >= 4)
  assert.match(manual.note, /未获 computer use 授权/)

  const calls = []
  const unauthorizedGate = { computerUse: { authorized: false, run: async () => { calls.push('ran') } } }
  const denied = await runInstallAutomation(unauthorizedGate)
  assert.equal(denied.ran, false)
  assert.deepEqual(calls, [], 'an unauthorised gate must not be invoked')

  const granted = await runInstallAutomation({ computerUse: { authorized: true, run: async () => { calls.push('ran'); return { ok: true, note: 'fake installer done' } } } })
  assert.equal(granted.ran, true)
  assert.deepEqual(calls, ['ran'])
  assert.equal(installGuidanceOf({ computerUse: { authorized: true } }, false).mode, 'automated')
})

test('the setup tool exposes install/download and keeps the retired name banned', () => {
  let captured = null
  const ctx = { tools: { register: (definition) => { captured = definition } } }
  registerEnvironmentTools(ctx, () => ({ comfyEndpoint: '', comfyPorts: '8188', timeoutMs: 1000, comfyModel: 'qwen21-base' }))
  assert.equal(captured.name, 'qwen_image_setup')
  assert.notEqual(captured.name, 'qwen_image_env')
  const parameters = captured.parameters ?? {}
  const action = parameters.action ?? parameters.properties?.action
  assert.deepEqual(action.enum, ['status', 'start', 'stop', 'install', 'download'])
  const confirm = parameters.confirm ?? parameters.properties?.confirm
  assert.equal(confirm.type, 'boolean')
  const description = String(captured.description ?? '')
  assert.match(description, /object_info/)
  assert.match(description, /computer use/)
})

test('start spawns only the hidden renderer — no external log window', async () => {
  const fake = await startStatsServer()
  try {
    const closed = await freePort()
    const machine = makeMachine(freshDir(), { port: fake.port })
    const spawnCalls = []
    const child = { pid: 4242, exitCode: null, unref() {} }
    const spawn = (...args) => { spawnCalls.push(args); return child }
    let probes = 0
    const fetchImpl = async () => {
      probes += 1
      if (probes <= 1) throw new Error('connect ECONNREFUSED (fake pre-flight)')
      return new Response(JSON.stringify({ system: { comfyui_version: 'fake-0.0' }, devices: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    const options = {
      ...environmentOptionsOf({ comfyEndpoint: '', comfyPorts: String(closed), timeoutMs: 1000 }),
      installTimeoutMs: 5000, waitIntervalMs: 20,
    }
    const status = await ensureEnvironment(options, depsOf(machine, { spawn, fetchImpl, portProbe: async () => false }))
    assert.equal(status.state, 'ready')
    assert.equal(spawnCalls.length, 1, 'only the renderer is spawned — no terminal window')
    const [rendererBin, , rendererOpts] = spawnCalls[0]
    assert.equal(rendererBin, machine.winPython)
    assert.equal(rendererOpts.windowsHide, true, 'the renderer stays fully hidden')
    assert.match(String(status.note), /日志：/, 'the note points at the log path for the in-panel viewer')
  } finally {
    await fake.close()
  }
})
