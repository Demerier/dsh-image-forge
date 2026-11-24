import assert from 'node:assert/strict'
import test from 'node:test'
import {
  environmentClientSnapshot,
  refreshStudioEnvironment,
  resetEnvironmentClient,
  runStudioEnvironmentAction,
  subscribeEnvironmentClient,
} from '../src/environment-client.ts'

function answer(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

test('the shared environment client refreshes and notifies subscribers', async () => {
  resetEnvironmentClient()
  const originalFetch = globalThis.fetch
  let notifications = 0
  const unsubscribe = subscribeEnvironmentClient(() => { notifications += 1 })
  globalThis.fetch = async () => answer({ environment: { state: 'ready', owned: true, canStop: true, pid: 42, endpoint: 'http://127.0.0.1:8188' } })
  try {
    await refreshStudioEnvironment()
    assert.equal(environmentClientSnapshot().environment?.state, 'ready')
    assert.equal(environmentClientSnapshot().environment?.canStop, true)
    assert.equal(environmentClientSnapshot().busy, undefined)
    assert.ok(notifications >= 2, 'busy and settled states both notify')
  } finally {
    unsubscribe()
    globalThis.fetch = originalFetch
    resetEnvironmentClient()
  }
})

test('start failure keeps the launch log path after the refresh overwrites the snapshot', async () => {
  resetEnvironmentClient()
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (_url, init) => {
    const action = JSON.parse(String(init?.body)).action
    calls.push(action)
    if (action === 'start') {
      return answer({ environment: { state: 'launch-failed', owned: false, canStop: false, note: '端口被占：18188 上已有进程在监听', logPath: 'C:/logs/launch-x.log' } })
    }
    return answer({ environment: { state: 'not-running', owned: false, canStop: false } })
  }
  try {
    await runStudioEnvironmentAction('start')
    const state = environmentClientSnapshot()
    assert.deepEqual(calls, ['start', 'status'])
    assert.equal(state.busy, undefined)
    assert.equal(state.environment?.logPath, 'C:/logs/launch-x.log')
    assert.match(state.note ?? '', /端口被占/)
    assert.match(state.note ?? '', /C:\/logs\/launch-x\.log/)
  } finally {
    globalThis.fetch = originalFetch
    resetEnvironmentClient()
  }
})

test('a refused stop becomes a visible error and never leaves the busy state stuck', async () => {
  resetEnvironmentClient()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const action = JSON.parse(String(init?.body)).action
    if (action === 'stop') {
      return answer({ environment: { state: 'ready', owned: true, canStop: true, pid: 42 }, stop: { stopped: false, reason: 'unverified', note: '无法确认 pid 42 是不是本插件启动的实例' } })
    }
    return answer({ environment: { state: 'ready', owned: true, canStop: true, pid: 42 } })
  }
  try {
    await runStudioEnvironmentAction('stop')
    const state = environmentClientSnapshot()
    assert.equal(state.busy, undefined)
    assert.match(state.error ?? '', /无法确认/)
    assert.equal(state.environment?.canStop, true, 'the process remains stoppable after a refused attempt')
  } finally {
    globalThis.fetch = originalFetch
    resetEnvironmentClient()
  }
})

test('the environment client accepts JSON-only test/host responses', async () => {
  resetEnvironmentClient()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ environment: { state: 'not-running', owned: false, canStop: false } }),
  })
  try {
    await refreshStudioEnvironment()
    assert.equal(environmentClientSnapshot().environment?.state, 'not-running')
    assert.equal(environmentClientSnapshot().busy, undefined)
  } finally {
    globalThis.fetch = originalFetch
    resetEnvironmentClient()
  }
})