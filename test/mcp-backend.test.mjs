/**
 * T15: the backend seam, the MCP client and the comfy-CLI fallback.
 *
 * The host-supplied `@modelcontextprotocol/client` cannot be imported by plain
 * `node` (it is a peer dependency resolved by the DSH profile runtime, see
 * docs/mcp-backend.md), so the fake here sits at the stdio connection seam
 * (`McpConnectionLike`): the same `listTools`/`callTool`/close surface the SDK
 * client exposes. That keeps every branch of the production code under test —
 * tool filtering, submit, poll, fetch, first-load `timed_out`, timeout and
 * process-tree kill — without a real toolchain on CI. The real wire was probed
 * against comfy-mcp 0.10.0 in verify/t15 (39 tools, real image run recorded in
 * the task report).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MCP_TOOL_ALLOWLIST,
  McpBackend,
  classifyJob,
} from '../src/mcp-backend.ts'
import {
  ENV_BACKEND,
  ENV_BACKEND_TIMEOUT_MS,
  ENV_COMFY_BIN,
  ENV_MCP_BIN,
  configureBackendDefaults,
  findExecutable,
  resolveBackendPlan,
  runThroughBackends,
} from '../src/backend.ts'
import { CliBackend, parseEnvelope } from '../src/cli-backend.ts'

/** Smallest valid 1x1 PNG, so sniffImageMime sees a real container. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const scratch = () => mkdtempSync(join(tmpdir(), 't15-test-'))

/** Fake stdio session at the SDK-client seam. */
function fakeSession(options) {
  const handlers = options.handlers ?? {}
  const tools = options.tools ?? [...MCP_TOOL_ALLOWLIST]
  const calls = []
  let closed = 0
  const client = {
    async listTools() {
      return { tools: tools.map(name => ({ name })) }
    },
    async callTool(params) {
      calls.push({ name: params.name, args: params.arguments })
      const handler = handlers[params.name]
      if (handler === undefined) return { content: [{ type: 'text', text: '{}' }] }
      const result = await handler(params.arguments)
      if (result !== null && typeof result === 'object' && result.__error === true) {
        return { isError: true, content: [{ type: 'text', text: result.text }] }
      }
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] }
    },
    async close() {
      closed += 1
    },
  }
  return {
    session: { client, pid: options.pid ?? 4242, close: client.close },
    calls,
    closedCount: () => closed,
  }
}

function request(overrides = {}) {
  return {
    endpoint: 'http://127.0.0.1:8188',
    graph: { 1: { class_type: 'KSampler', inputs: {} } },
    what: '出图',
    timeoutMs: 5_000,
    pollIntervalMs: 1,
    ...overrides,
  }
}

test('resolveBackendPlan: defaults to auto and detects nothing when PATH is empty', () => {
  const plan = resolveBackendPlan({ PATH: '' })
  assert.equal(plan.mode, 'auto')
  assert.equal(plan.mcpCommand, undefined)
  assert.equal(plan.comfyCommand, undefined)
  assert.equal(plan.timeoutMsOverride, undefined)
})

test('resolveBackendPlan: explicit bins and mode/budget overrides win over PATH', () => {
  const plan = resolveBackendPlan({
    PATH: '',
    [ENV_BACKEND]: 'mcp',
    [ENV_MCP_BIN]: 'C:/tools/comfy-mcp.exe',
    [ENV_COMFY_BIN]: 'C:/tools/comfy.exe',
    [ENV_BACKEND_TIMEOUT_MS]: '1234',
  })
  assert.equal(plan.mode, 'mcp')
  assert.equal(plan.mcpCommand, 'C:/tools/comfy-mcp.exe')
  assert.equal(plan.comfyCommand, 'C:/tools/comfy.exe')
  assert.equal(plan.timeoutMsOverride, 1234)
})

test('resolveBackendPlan: an unknown mode is a loud error, not a silent auto', () => {
  assert.throws(() => resolveBackendPlan({ [ENV_BACKEND]: 'grpc' }), /DSH_IMAGE_FORGE_BACKEND/)
})

test('findExecutable: finds an executable on PATH and missing names return undefined', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'comfy-mcp.exe'), 'x')
  const found = findExecutable('comfy-mcp', dir, 'win32')
  if (process.platform === 'win32') {
    assert.equal(found?.toLowerCase(), join(dir, 'comfy-mcp.exe').toLowerCase())
  } else {
    assert.equal(found, undefined, 'PATHEXT lookup is Windows-only; POSIX needs the exact name')
  }
  assert.equal(findExecutable('does-not-exist-xyz', dir), undefined)
})

test('MCP client filters tools/list down to the allowlist and needs the required names', async () => {
  const { session } = fakeSession({
    tools: ['server_info', 'run_workflow', 'job', 'fetch_outputs', 'validate_workflow', 'system_stats', 'download_model', 'auth_login'],
  })
  const backend = new McpBackend({ command: 'comfy-mcp', connect: async () => session })
  const allowed = await backend.connectAndFilterTools('http://127.0.0.1:8188')
  assert.deepEqual(allowed, ['run_workflow', 'job', 'fetch_outputs', 'validate_workflow', 'system_stats'])
  assert.deepEqual([...MCP_TOOL_ALLOWLIST], allowed)
  await backend.dispose()
})

test('MCP client: a missing required tool is a configuration error (wrong comfy-mcp version)', async () => {
  const { session } = fakeSession({ tools: ['run_workflow'] })
  const backend = new McpBackend({ command: 'comfy-mcp', connect: async () => session })
  await assert.rejects(() => backend.connectAndFilterTools('http://127.0.0.1:8188'), /缺少必需工具 job/)
})

test('MCP client: a non-allowlisted tool is refused before it reaches the server', async () => {
  const session = fakeSession({})
  const backend = new McpBackend({ command: 'comfy-mcp', connect: async () => session.session })
  await backend.connectAndFilterTools('http://127.0.0.1:8188')
  await assert.rejects(() => backend.callTool('download_model', {}), /不在客户端白名单内/)
  assert.equal(session.calls.length, 0)
})

test('MCP client: submit -> poll (timed_out is not failure) -> fetch writes the images', async () => {
  const imagesDir = scratch()
  writeFileSync(join(imagesDir, 'qwen_00001_.png'), PNG)
  let polls = 0
  const { session, calls } = fakeSession({
    handlers: {
      run_workflow: () => ({ prompt_id: 'p-1', ok: true }),
      job: () => {
        polls += 1
        // First poll mirrors MCP's default 110 s wait returning timed_out:true;
        // that is explicitly NOT a failure (docs/DIRECTION-ALIGNMENT.md §4.2).
        if (polls === 1) return { timed_out: true, prompt_id: 'p-1' }
        return { completed: true, prompt_id: 'p-1', status: { status_str: 'success' } }
      },
      fetch_outputs: args => {
        const target = join(args.out_dir, 'qwen_00001_.png')
        writeFileSync(target, PNG)
        return { copied: [target] }
      },
    },
  })
  const backend = new McpBackend({ command: 'comfy-mcp', connect: async () => session, sleep: async () => undefined })
  const promptIds = []
  const images = await backend.run(request({ onPromptId: id => promptIds.push(id) }))
  assert.deepEqual(promptIds, ['p-1'])
  assert.equal(images.length, 1)
  assert.equal(images[0].mime, 'image/png')
  assert.equal(images[0].bytes.byteLength, PNG.byteLength)
  assert.equal(calls[0].name, 'run_workflow')
  assert.equal(calls[0].args.wait, false, 'the default wait=True would lie on the first weight load')
  assert.ok(calls[0].args.workflow_path.endsWith('.json'))
  assert.equal(calls.filter(call => call.name === 'job').length, 2)
  assert.equal(calls.at(-1).name, 'fetch_outputs')
  assert.ok(calls.at(-1).args.out_dir.includes('dsh-image-forge-mcp-'), 'fetch_outputs must get an absolute out_dir')
  await backend.dispose()
})

test('MCP client: a completed job with no image bytes is an error, not an empty result', async () => {
  const { session } = fakeSession({
    handlers: {
      run_workflow: () => ({ prompt_id: 'p-2' }),
      job: () => ({ completed: true }),
      fetch_outputs: () => ({ copied: [] }),
    },
  })
  const backend = new McpBackend({ command: 'comfy-mcp', connect: async () => session, sleep: async () => undefined })
  await assert.rejects(() => backend.run(request()), /没有复制出任何图片/)
})

test('MCP client: timeout kills the whole process tree and fails with the prompt id', async () => {
  const { session } = fakeSession({
    handlers: {
      run_workflow: () => ({ prompt_id: 'p-timeout' }),
      job: () => ({ status: 'running' }),
    },
  })
  const killed = []
  const backend = new McpBackend({
    command: 'comfy-mcp',
    connect: async () => session,
    killTree: pid => killed.push(pid),
    sleep: async () => undefined,
  })
  await assert.rejects(
    () => backend.run(request({ timeoutMs: 25, pollIntervalMs: 5 })),
    /超过 25 ms 仍未完成/,
  )
  assert.deepEqual(killed, [4242])
})

test('MCP client: a tool error envelope surfaces the server text', async () => {
  const { session } = fakeSession({
    handlers: {
      run_workflow: () => ({ __error: true, text: 'comfy-cli returned no JSON (exit 1)' }),
    },
  })
  const backend = new McpBackend({ command: 'comfy-mcp', connect: async () => session })
  await assert.rejects(() => backend.run(request()), /run_workflow 失败[\s\S]*comfy-cli returned no JSON/)
})

test('classifyJob: completed/timed_out/status strings map to done|pending|failed', () => {
  assert.equal(classifyJob({ completed: true }), 'done')
  assert.equal(classifyJob({ outputs: { 9: { images: [] } } }), 'done')
  assert.equal(classifyJob({ timed_out: true }), 'pending')
  assert.equal(classifyJob({ status: 'running' }), 'pending')
  assert.equal(classifyJob({ status: 'error' }), 'failed')
  assert.equal(classifyJob({ error: { message: 'x' } }), 'failed')
})

test('backend chain: auto tries MCP, falls back to CLI and reports the skip', async () => {
  let mcpDisposed = 0
  const result = await runThroughBackends(request(), {
    mode: 'auto',
    mcpCommand: 'comfy-mcp',
    comfyCommand: 'comfy',
    timeoutMsOverride: undefined,
  }, {
    createMcpBackend: () => ({
      name: 'mcp',
      async run() { throw new Error('no sdk') },
      async dispose() { mcpDisposed += 1 },
    }),
    createCliBackend: () => ({
      name: 'cli',
      async run() { return [{ bytes: new Uint8Array(PNG), mime: 'image/png' }] },
      async dispose() {},
    }),
  })
  assert.equal(result?.via, 'cli')
  assert.equal(result?.skipped.length, 1)
  assert.match(result.skipped[0], /mcp: no sdk/)
  assert.equal(mcpDisposed, 1)
})

test('backend chain: strict mcp mode never falls back silently', async () => {
  await assert.rejects(
    () => runThroughBackends(request(), {
      mode: 'mcp', mcpCommand: 'comfy-mcp', comfyCommand: 'comfy', timeoutMsOverride: undefined,
    }, {
      createMcpBackend: () => ({ name: 'mcp', async run() { throw new Error('boom') }, async dispose() {} }),
      createCliBackend: () => ({ name: 'cli', async run() { throw new Error('must not run') }, async dispose() {} }),
    }),
    /boom/,
  )
})

test('backend chain: no toolchain configured means "no non-HTTP backend" (zero behaviour change)', async () => {
  const result = await runThroughBackends(request(), {
    mode: 'auto', mcpCommand: undefined, comfyCommand: undefined, timeoutMsOverride: undefined,
  })
  assert.equal(result, undefined)
})

test('CLI fallback: run --workflow then download parse the comfy envelope', async () => {
  const seen = []
  let loaded = ''
  const spawnCommand = async (args) => {
    seen.push(args)
    if (args.includes('run')) {
      return { code: 0, stdout: JSON.stringify({ schema: 'envelope/1', ok: true, data: { prompt_id: 'cli-1' } }), stderr: '' }
    }
    // download: find the --out-dir we were given and write one real PNG there
    const index = args.indexOf('--out-dir')
    const outDir = args[index + 1]
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'out_00001_.png'), PNG)
    return { code: 0, stdout: JSON.stringify({ ok: true, data: { files: [] } }), stderr: '' }
  }
  const backend = new CliBackend({ command: 'comfy', spawnCommand })
  const promptIds = []
  const images = await backend.run(request({ onPromptId: id => { promptIds.push(id); loaded = id } }))
  assert.deepEqual(promptIds, ['cli-1'])
  assert.equal(images.length, 1)
  assert.equal(images[0].mime, 'image/png')
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[0].slice(0, 6), ['--json', '--where', 'local', '--skip-prompt', 'run', '--workflow'])
  assert.ok(seen[0].includes('--wait'))
  assert.ok(seen[0].includes('--host') && seen[0].includes('127.0.0.1'))
  assert.equal(seen[1][4], 'download')
  assert.equal(seen[1][5], 'cli-1')
})

test('CLI fallback: a failed envelope surfaces comfy-cli\'s own message', async () => {
  const backend = new CliBackend({
    command: 'comfy',
    spawnCommand: async () => ({
      code: 1,
      stdout: JSON.stringify({ schema: 'envelope/1', ok: false, error: { message: 'comfy run failed [internal_error]: boom' } }),
      stderr: '',
    }),
  })
  await assert.rejects(() => backend.run(request()), /comfy run failed \[internal_error\]: boom/)
})

test('T22: config defaults feed the backend plan, and environment variables still win', () => {
  configureBackendDefaults({
    backend: 'cli',
    comfyMcpBin: 'C:/cfg/comfy-mcp.exe',
    comfyBin: 'C:/cfg/comfy.exe',
    backendTimeoutMs: 999,
    mcpDebug: true,
    backendTmpDir: 'C:/cfg/tmp',
    outputDir: 'C:/work',
  })
  try {
    const plan = resolveBackendPlan({ PATH: '' })
    assert.equal(plan.mode, 'cli')
    assert.equal(plan.mcpCommand, 'C:/cfg/comfy-mcp.exe')
    assert.equal(plan.comfyCommand, 'C:/cfg/comfy.exe')
    assert.equal(plan.timeoutMsOverride, 999)
    assert.equal(plan.scratchRoot, 'C:/cfg/tmp')
    assert.equal(plan.debug, true)
    // The workspace mirror root is derived from outputDir, never from tmpdir().
    assert.equal(plan.mirrorRoot, join('C:/work', '.dsh-image-forge', 'backend-mirror'))

    // Environment variables keep overriding the settings (T15 compatibility).
    const overridden = resolveBackendPlan({
      PATH: '',
      [ENV_BACKEND]: 'http',
      [ENV_MCP_BIN]: 'C:/env/comfy-mcp.exe',
      DSH_IMAGE_FORGE_MCP_DEBUG: '0',
      DSH_IMAGE_FORGE_BACKEND_TMPDIR: 'C:/env/tmp',
    })
    assert.equal(overridden.mode, 'http')
    assert.equal(overridden.mcpCommand, 'C:/env/comfy-mcp.exe')
    assert.equal(overridden.debug, false, 'an explicit env 0 can switch debug off')
    assert.equal(overridden.scratchRoot, 'C:/env/tmp')
  } finally {
    configureBackendDefaults({})
  }
})

test('T22: fetch_outputs mirrors into the workspace root, and the files survive the run', async () => {
  const mirror = scratch()
  const { session } = fakeSession({
    handlers: {
      run_workflow: () => ({ prompt_id: 'p-mirror', ok: true }),
      job: () => ({ completed: true, prompt_id: 'p-mirror' }),
      fetch_outputs: (args) => {
        const target = join(args.out_dir, 'qwen_00001_.png')
        writeFileSync(target, PNG)
        return { copied: [target] }
      },
    },
  })
  const backend = new McpBackend({ command: 'comfy-mcp', connect: async () => session, sleep: async () => undefined, mirrorRoot: mirror })
  const images = await backend.run(request())
  assert.equal(images.length, 1)
  const mirrored = join(mirror, 'p-mirror', 'qwen_00001_.png')
  assert.ok(existsSync(mirrored), 'the fetch_outputs copy stays in the workspace mirror')
  assert.deepEqual(readdirSync(mirror), ['p-mirror'])
})

test('CLI fallback: download out-dir can also be the workspace mirror', async () => {
  const mirror = scratch()
  const spawnCommand = async (args) => {
    if (args.includes('run')) {
      return { code: 0, stdout: JSON.stringify({ schema: 'envelope/1', ok: true, data: { prompt_id: 'cli-mirror' } }), stderr: '' }
    }
    const index = args.indexOf('--out-dir')
    const outDir = args[index + 1]
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'out_00001_.png'), PNG)
    return { code: 0, stdout: JSON.stringify({ ok: true, data: { files: [] } }), stderr: '' }
  }
  const backend = new CliBackend({ command: 'comfy', spawnCommand, mirrorRoot: mirror })
  const images = await backend.run(request())
  assert.equal(images.length, 1)
  assert.ok(existsSync(join(mirror, 'cli-mirror', 'out_00001_.png')), 'the CLI download lands in the workspace mirror too')
})

test('the MCP backend is private: no mcpManager registration, no mcp__* tools in the host bundle', async () => {
  // The conversation tool table is the thing decision 6 protects: registering
  // through ctx.mcpManager would turn comfy-mcp's 39 tools into mcp__* entries.
  // Machine-check the built host bundle instead of trusting the source review.
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const bundle = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.equal(bundle.includes('mcpManager'), false, 'the plugin must never touch ctx.mcpManager')
  assert.equal(bundle.includes('mcp__'), false, 'no MCP tool namespace may leak into the tool table')
  assert.ok(bundle.includes('fetch_outputs'), 'the private MCP client is bundled into the host half')
})

test('parseEnvelope: last JSON line wins, side lines are ignored', () => {
  const parsed = parseEnvelope('starting...\n{"ok":true,"data":{"a":1}}\n')
  assert.deepEqual(parsed, { ok: true, data: { a: 1 } })
  assert.equal(parseEnvelope('not json'), undefined)
})
