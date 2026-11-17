/**
 * The Studio's live progress bridge: ComfyUI `/ws` → same-origin SSE.
 *
 * ## Why the bridge lives in Node
 *
 * The panel is served by the host, never by ComfyUI. A page that opened
 * ComfyUI's own WebSocket would be cross-origin against the renderer and would
 * make the UI depend on a renderer detail; decision 4 in
 * `docs/DIRECTION-ALIGNMENT.md` settles it the other way: **this plugin
 * subscribes to `/ws`, and the page only ever talks to this plugin**. The
 * bridge keeps exactly one ComfyUI socket for the whole host process and fans
 * normalized events out to every subscribed SSE response, so two panels (the
 * workbench and a tool card) watch the same run without opening two sockets.
 *
 * ## The `client_id` coupling, and why it is load-bearing
 *
 * ComfyUI sends per-prompt events (`execution_start`, `executing`,
 * `progress`, `execution_error`, `execution_success`) only to the socket
 * whose `clientId` equals the `client_id` that `/prompt` submission carried
 * — `PromptServer.client_id` is set from `extra_data["client_id"]`
 * (`execution.py`, `execute_async`) and every non-broadcast message is
 * addressed to that sid. The plugin submits with
 * `${process.pid}-dsh-image-forge` (`src/comfyui.ts`, `runGraph`), so the
 * bridge registers under that id; a random one would receive only the
 * broadcast `status` frames and never a step count. {@link COMFY_CLIENT_ID}
 * mirrors that literal here because `comfyui.ts` does not export it, and both
 * halves run in the same process, so the pid is the same.
 *
 * ## Normalized events
 *
 * Every SSE message is one JSON object shaped as {@link StudioProgressEvent},
 * in the vocabulary of `studio-shared.ts`: queue depth from `status`, the
 * step count from `progress` (with `progress_state` as the fallback for a
 * node that only reports the aggregate), node changes, completion and
 * failures. ComfyUI's binary preview frames and unknown message types
 * (`cam.monitor`, `feature_flags`, `executed`, future additions) are
 * dropped: the panel renders finished files from the generation response, and
 * an unrecognized frame is not a reason to tear down a stream.
 *
 * ## Connection lifetime
 *
 * The socket is opened on the first subscriber and closed when the last one
 * leaves, so a plugin nobody is watching costs ComfyUI nothing. A dropped
 * socket is retried with exponential backoff, and every subscriber receives
 * `state` events, which is what lets the page show "reconnecting" instead of
 * freezing on the last step it saw.
 *
 * @module progress
 */
import { comfyOptionsOf, discoverComfyUi, type ComfySettingsFields } from './comfyui.ts'
import { firstLine, type StudioProgressEvent } from './studio-shared.ts'

/**
 * ComfyUI socket id this plugin registers as.
 *
 * Must match the `client_id` the submission path sends
 * (`${process.pid}-dsh-image-forge` in `src/comfyui.ts`); see the module note
 * for why a mismatch silently degrades to queue-only updates.
 */
export const COMFY_CLIENT_ID = `${process.pid}-dsh-image-forge`

/** First reconnect delay, doubled after every failed attempt. */
const DEFAULT_RECONNECT_BASE_MS = 500
/** Ceiling for the reconnect delay. */
const DEFAULT_RECONNECT_MAX_MS = 5_000
/**
 * Budget for one `/system_stats` probe when (re)connecting.
 *
 * Deliberately shorter than one generation's budget: the bridge is a passive
 * observer, so "ComfyUI is not answering right now" should surface in under a
 * second rather than blocking the retry loop for three minutes.
 */
const DEFAULT_DISCOVER_TIMEOUT_MS = 800

/**
 * The slice of a WebSocket client this module uses.
 *
 * Declared structurally rather than as the DOM/Node `WebSocket` type so the
 * host bundle has no lib-DOM dependency: the runtime only needs a constructor
 * with these four members, which both Node 22's global client and a test
 * double provide.
 */
interface ProgressSocket {
  /** Preview frames arrive as bytes; the bridge only reads text frames. */
  binaryType: string
  addEventListener(type: 'open' | 'error' | 'close', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  close(code?: number, reason?: string): void
}

/** Constructor shape of the runtime's WebSocket client. */
type ProgressSocketConstructor = new (url: string) => ProgressSocket

/**
 * The runtime's WebSocket client, when it has one.
 *
 * Node 22+ ships one globally; older runtimes do not. A missing client is
 * reported as a disconnected state rather than a crash, so the Studio keeps
 * working on the HTTP path.
 */
function socketConstructor(): ProgressSocketConstructor | undefined {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket
  return typeof ctor === 'function' ? ctor as ProgressSocketConstructor : undefined
}

/** Timing knobs; every field has a production default and exists as a test seam. */
export interface ProgressBridgeTiming {
  /** First reconnect delay in milliseconds (default 500). */
  readonly reconnectBaseMs?: number
  /** Reconnect delay ceiling in milliseconds (default 5000). */
  readonly reconnectMaxMs?: number
  /** Budget for one ComfyUI discovery probe in milliseconds (default 800). */
  readonly discoverTimeoutMs?: number
}

/** Everything the bridge reads. */
export interface ProgressBridgeOptions extends ProgressBridgeTiming {
  /**
   * Read the resolved settings.
   *
   * Called per connection attempt rather than once, so a settings save that
   * moves `comfyEndpoint` is picked up on the next reconnect.
   */
  settings: () => ComfySettingsFields
  /** Socket id to register as; defaults to {@link COMFY_CLIENT_ID}. */
  clientId?: string
}

/** One live progress bridge. */
export interface ProgressBridge {
  /**
   * Subscribe one SSE response.
   *
   * The listener is called immediately with the current connection state, then
   * with every normalized event. The first subscriber opens the ComfyUI
   * socket; the last one closes it.
   *
   * @param listener - receives one event per call; errors are isolated.
   * @returns idempotent unsubscribe.
   */
  subscribe(listener: (event: StudioProgressEvent) => void): () => void
  /** Close the socket and drop every subscriber; idempotent, for host unmount. */
  stop(): void
  /** Current connection state, for diagnostics and tests. */
  status(): { connected: boolean; endpoint?: string; reason?: string }
}

/** Connection state as the bridge tracks it. */
interface BridgeState {
  readonly state: 'connecting' | 'connected' | 'disconnected'
  readonly endpoint?: string
  readonly reason?: string
}

/**
 * Create the process-wide ComfyUI progress bridge.
 *
 * The returned object is inert until somebody subscribes: no socket, no retry
 * timer, no discovery probe. That is what makes it safe to construct once per
 * route registration even though most plugin activations never open the
 * Studio panel.
 *
 * @param options - settings reader, socket id and timing overrides.
 * @returns the bridge.
 */
export function createProgressBridge(options: ProgressBridgeOptions): ProgressBridge {
  const listeners = new Set<(event: StudioProgressEvent) => void>()
  const clientId = options.clientId ?? COMFY_CLIENT_ID
  const reconnectBaseMs = Math.max(1, options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS)
  const reconnectMaxMs = Math.max(reconnectBaseMs, options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS)
  const discoverTimeoutMs = Math.max(1, options.discoverTimeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS)

  let socket: ProgressSocket | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let discovery: AbortController | undefined
  let attempt = 0
  /**
   * Bumped on every attempt and every teardown.
   *
   * Callbacks from a superseded socket compare their ticket against this and
   * return, which is what stops one slow `close` from scheduling a second
   * reconnect on top of the current one.
   */
  let generation = 0
  let stopped = false
  let current: BridgeState = { state: 'connecting' }
  /** Dedupe key of the last `progress` event (see `progressEvent`). */
  let lastProgress: string | undefined
  /** Prompt id the last `done` event was emitted for. */
  let lastDone: string | undefined

  /** The state event for the current state, with absent fields omitted. */
  function stateEvent(): StudioProgressEvent {
    return {
      type: 'state',
      state: current.state,
      ...(current.endpoint === undefined ? {} : { endpoint: current.endpoint }),
      ...(current.reason === undefined ? {} : { reason: current.reason }),
    }
  }

  /** Fan out one event; a throwing subscriber must not starve the rest. */
  function emit(event: StudioProgressEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // The route guards its writes; nothing here can help a broken stream.
      }
    }
  }

  /** Publish a state change, skipping the event when nothing changed. */
  function setState(next: BridgeState): void {
    const same = next.state === current.state
      && next.endpoint === current.endpoint
      && next.reason === current.reason
    current = next
    if (!same) emit(stateEvent())
  }

  /** Schedule the next attempt after a failure, at most one timer at a time. */
  function retry(reason: string | undefined): void {
    if (stopped || listeners.size === 0) return
    setState({ state: 'disconnected', ...(reason === undefined ? {} : { reason }) })
    if (retryTimer !== undefined) return
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** attempt)
    attempt += 1
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void connect()
    }, delay)
    // A closed panel must not be the reason the host process cannot exit; the
    // route also stops the bridge explicitly on unmount.
    retryTimer.unref?.()
  }

  /** Close the socket without scheduling a retry. */
  function closeSocket(): void {
    const open = socket
    socket = undefined
    if (open === undefined) return
    try {
      open.close(1000, 'dsh-image-forge 关闭')
    } catch {
      // Already closed; nothing to release.
    }
  }

  /** Attach the handlers for one attempt, ignoring callbacks from older ones. */
  function attach(ws: ProgressSocket, ticket: number): void {
    ws.addEventListener('message', (event) => {
      if (ticket !== generation || stopped) return
      const data = (event as { data?: unknown }).data
      // Binary frames are ComfyUI's latent previews. The panel shows finished
      // images from the generation response; a byte stream is not SSE payload.
      if (typeof data === 'string') receive(data)
    })
    ws.addEventListener('open', () => {
      if (ticket !== generation || stopped) return
      // A successful connection resets the backoff, so one outage does not
      // leave the bridge retrying at the ceiling for the rest of the session.
      attempt = 0
      setState({ state: 'connected', ...(current.endpoint === undefined ? {} : { endpoint: current.endpoint }) })
    })
    ws.addEventListener('error', () => {
      if (ticket !== generation || stopped) return
      retry('ComfyUI 的 /ws 连接出错')
    })
    ws.addEventListener('close', () => {
      if (ticket !== generation || stopped) return
      if (socket === ws) socket = undefined
      retry('ComfyUI 的 /ws 连接已断开')
    })
  }

  /** Resolve one endpoint and open the socket. */
  async function connect(): Promise<void> {
    if (stopped || listeners.size === 0) return
    const ticket = ++generation
    closeSocket()
    discovery?.abort()
    discovery = undefined
    setState({ state: 'connecting' })
    let endpoint: string
    try {
      const controller = new AbortController()
      discovery = controller
      const settings = options.settings()
      const target = await discoverComfyUi(
        { ...comfyOptionsOf(settings, discoverTimeoutMs), portProbeTimeoutMs: discoverTimeoutMs },
        controller.signal,
      )
      endpoint = target.endpoint
    } catch (error) {
      if (ticket !== generation || stopped) return
      retry(firstLine(error))
      return
    } finally {
      if (ticket === generation) discovery = undefined
    }
    if (ticket !== generation || stopped) return
    const Socket = socketConstructor()
    if (Socket === undefined) {
      // Retrying cannot install a WebSocket client, so report once and stay
      // down: the HTTP generation path is unaffected.
      setState({ state: 'disconnected', reason: '当前 Node 运行时没有 WebSocket 客户端（需要 Node 22+）' })
      return
    }
    let ws: ProgressSocket
    try {
      ws = new Socket(comfyWebSocketUrl(endpoint, clientId))
    } catch (error) {
      retry(firstLine(error))
      return
    }
    socket = ws
    try {
      ws.binaryType = 'arraybuffer'
    } catch {
      // Not every client exposes the property; text frames are unaffected.
    }
    setState({ state: 'connecting', endpoint })
    attach(ws, ticket)
  }

  /** Parse one text frame and emit whatever it normalizes to. */
  function receive(raw: string): void {
    const event = normalize(raw)
    if (event !== undefined) emit(event)
  }

  /**
   * Turn one ComfyUI `/ws` frame into at most one Studio event.
   *
   * Frames are `{"type": …, "data": …}` (ComfyUI `server.py`, `send_json`).
   * Unknown or malformed frames return `undefined` rather than throwing: a
   * stream that dies on the first unrecognized message is worse than one that
   * ignores it.
   *
   * @param raw - the text frame body.
   * @returns the normalized event, when the frame carries one.
   */
  function normalize(raw: string): StudioProgressEvent | undefined {
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return undefined
    }
    const envelope = record(message)
    if (envelope === undefined) return undefined
    const type = text(envelope.type)
    const data = record(envelope.data)
    if (type === undefined || data === undefined) return undefined

    switch (type) {
      case 'status': {
        // Broadcast on connect and on every queue change:
        // {"status":{"exec_info":{"queue_remaining":N}},"sid":"…"}.
        const remaining = number(record(record(data.status)?.exec_info)?.queue_remaining)
        return remaining === undefined ? undefined : { type: 'queue', remaining }
      }
      case 'execution_start': {
        const promptId = text(data.prompt_id)
        return promptId === undefined ? undefined : { type: 'start', promptId }
      }
      case 'execution_cached': {
        const promptId = text(data.prompt_id)
        if (promptId === undefined) return undefined
        const nodes = Array.isArray(data.nodes)
          ? data.nodes.filter((node): node is string => typeof node === 'string')
          : []
        return { type: 'cached', promptId, nodes }
      }
      case 'executing': {
        const promptId = text(data.prompt_id)
        const node = text(data.node)
        if (node === undefined) {
          // A null node is ComfyUI's "this prompt finished" marker; it arrives
          // right after `execution_success`, so emit `done` only once.
          if (promptId === undefined || promptId === lastDone) return undefined
          lastDone = promptId
          return { type: 'done', promptId }
        }
        if (promptId === undefined) return undefined
        const displayNode = text(data.display_node)
        return { type: 'node', promptId, node, ...(displayNode === undefined ? {} : { displayNode }) }
      }
      case 'progress': {
        // {"value":17,"max":50,"prompt_id":"…","node":"3"} — one per sampler
        // step, which is the "第 17/50 步" the panel renders.
        const promptId = text(data.prompt_id)
        const value = number(data.value)
        const max = number(data.max)
        if (promptId === undefined || value === undefined || max === undefined) return undefined
        return progressEvent(promptId, text(data.node), value, max)
      }
      case 'progress_state': {
        // Newer ComfyUI also reports the aggregate node map:
        // {"prompt_id":"…","nodes":{"3":{"value":17,"max":50,"state":"running",…}}}.
        // It duplicates `progress`, so it is only a fallback — the first
        // running node that carries a step count wins, and `progressEvent`
        // dedupes the copy.
        const promptId = text(data.prompt_id)
        const nodes = record(data.nodes)
        if (promptId === undefined || nodes === undefined) return undefined
        for (const [nodeId, rawNode] of Object.entries(nodes)) {
          const node = record(rawNode)
          if (node === undefined || node.state !== 'running') continue
          const value = number(node.value)
          const max = number(node.max)
          if (value === undefined || max === undefined) continue
          return progressEvent(promptId, text(node.node_id) ?? nodeId, value, max)
        }
        return undefined
      }
      case 'execution_success': {
        const promptId = text(data.prompt_id)
        if (promptId === undefined || promptId === lastDone) return undefined
        lastDone = promptId
        return { type: 'done', promptId }
      }
      case 'execution_error': {
        // Multi-line by design (ComfyUI appends an OOM hint); the wire copy
        // keeps the headline, like every other error the Studio forwards.
        const message = firstLine(text(data.exception_message) ?? 'ComfyUI 执行失败')
        const promptId = text(data.prompt_id)
        const node = text(data.node_id)
        const nodeType = text(data.node_type)
        return {
          type: 'error',
          ...(promptId === undefined ? {} : { promptId }),
          ...(node === undefined ? {} : { node }),
          ...(nodeType === undefined ? {} : { nodeType }),
          message,
        }
      }
      case 'execution_interrupted': {
        const promptId = text(data.prompt_id)
        return promptId === undefined ? undefined : { type: 'interrupted', promptId }
      }
      default:
        // `cam.monitor`, `feature_flags`, `executed` and future additions:
        // nothing the panel can render, and an unknown type must not break the
        // stream.
        return undefined
    }
  }

  /**
   * Build one `progress` event, dropping the duplicate ComfyUI sends in
   * `progress_state`.
   *
   * @param promptId - the run this step belongs to.
   * @param node - the executing node, when ComfyUI names one.
   * @param value - completed steps.
   * @param max - total steps.
   * @returns the event, or `undefined` when it duplicates the previous one.
   */
  function progressEvent(
    promptId: string,
    node: string | undefined,
    value: number,
    max: number,
  ): StudioProgressEvent | undefined {
    const key = `${promptId}|${node ?? ''}|${value}|${max}`
    if (key === lastProgress) return undefined
    lastProgress = key
    return {
      type: 'progress',
      promptId,
      ...(node === undefined ? {} : { node }),
      value,
      max,
      percent: max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0,
      // The one string the panel can print verbatim: "17/50".
      label: `${value}/${max}`,
    }
  }

  /** Cancel timers, abort discovery and close the socket. */
  function teardown(): void {
    generation += 1
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    discovery?.abort()
    discovery = undefined
    closeSocket()
    lastProgress = undefined
    lastDone = undefined
    current = { state: 'connecting' }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      try {
        listener(stateEvent())
      } catch {
        // A subscriber that cannot take its first event is still tracked; its
        // unsubscribe will clean it up.
      }
      if (listeners.size === 1) {
        attempt = 0
        void connect()
      }
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
        if (listeners.size === 0) teardown()
      }
    },
    stop() {
      stopped = true
      listeners.clear()
      teardown()
    },
    status() {
      return {
        connected: current.state === 'connected',
        ...(current.endpoint === undefined ? {} : { endpoint: current.endpoint }),
        ...(current.reason === undefined ? {} : { reason: current.reason }),
      }
    },
  }
}

/**
 * ComfyUI's WebSocket URL for one endpoint.
 *
 * @param endpoint - e.g. `http://127.0.0.1:8188` (already loopback-checked).
 * @param clientId - the socket id to register as.
 * @returns `ws://host/ws?clientId=…` (or `wss://` for an https endpoint).
 */
function comfyWebSocketUrl(endpoint: string, clientId: string): string {
  const base = new URL(endpoint)
  const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${base.host}/ws?clientId=${encodeURIComponent(clientId)}`
}

/** A non-array object, or `undefined`. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A non-empty string, or `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A finite number, or `undefined`. */
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
