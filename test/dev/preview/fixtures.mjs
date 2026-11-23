/**
 * Deterministic preview data — dev only, never shipped.
 *
 * The workbench preview (`test/dev/preview/run.mjs`) must show a canvas with real
 * nodes, real lineage edges, a stored task node and a layout draft, without ever
 * talking to ComfyUI. This module writes that data the same way the plugin does:
 * one v2 board file per project, a `workspace.json` and a `state.json` under the
 * output directory the preview host hands the plugin.
 *
 * The pictures are generated here as PNG bytes (no dependency, no files from the
 * user's folders): a plate whose border, diagonal stripes and centre circle make
 * cropping and letter-boxing visible at a glance, at the three aspect ratios the
 * canvas treats differently.
 *
 * Everything lands under the directory the caller passes in — `verify/preview/`
 * by default, which `.git/info/exclude` keeps out of the repository.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

/* -------------------------------------------------------------------------- */
/* PNG writer                                                                 */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** Standard CRC-32 over one PNG chunk payload. */
function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** One PNG chunk: length, type, payload, CRC. */
function chunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * Encode an RGB image with one painter callback per pixel.
 *
 * @param {number} width - pixels across.
 * @param {number} height - pixels down.
 * @param {(x: number, y: number) => [number, number, number]} paint - pixel colour.
 * @returns {Buffer} a complete PNG file.
 */
function png(width, height, paint) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0 // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y)
      const at = y * stride + 1 + x * 3
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * One preview picture.
 *
 * The frame is 14 px of near-white, then a diagonal stripe pattern over a
 * vertical gradient, then a darker circle in the middle. A node that crops the
 * picture loses the frame first; a node that letter-boxes shows bars beside it.
 *
 * `noise` adds deterministic ±10 dither to every pixel. That is there for the
 * **metadata** half of the preview: a synthetic plate deflates to a few KB, and
 * the project card's size line (`formatBytes`, bytes below 1 MiB) would then only
 * ever show `85215 B`. Real photographs are megabytes, so one noisy plate per
 * board keeps the card reading like a card a user would actually see.
 *
 * @param {number} width - pixels across.
 * @param {number} height - pixels down.
 * @param {[number, number, number]} top - gradient colour at the top edge.
 * @param {[number, number, number]} bottom - gradient colour at the bottom edge.
 * @param {boolean} [noise] - add incompressible dither.
 * @returns {Buffer} PNG bytes.
 */
function plate(width, height, top, bottom, noise = false) {
  const frame = 14
  const cx = width / 2
  const cy = height / 2
  const radius = Math.min(width, height) * 0.22
  return png(width, height, (x, y) => {
    const jitter = noise ? ((x * 1103515245 + y * 12345) % 21) - 10 : 0
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value + jitter)))
    if (x < frame || y < frame || x >= width - frame || y >= height - frame) return [clamp(246), clamp(244), clamp(240)]
    const dx = x - cx
    const dy = y - cy
    if (dx * dx + dy * dy < radius * radius) return [clamp(28), clamp(32), clamp(44)]
    // 45° stripes, 6 px on / 6 px off, as a slightly lighter band.
    if ((x + y) % 48 < 24) {
      const t = y / height
      return [
        clamp(top[0] + (bottom[0] - top[0]) * t),
        clamp(top[1] + (bottom[1] - top[1]) * t),
        clamp(top[2] + (bottom[2] - top[2]) * t),
      ]
    }
    const t = y / height
    return [
      clamp((top[0] + (bottom[0] - top[0]) * t) * 0.86),
      clamp((top[1] + (bottom[1] - top[1]) * t) * 0.86),
      clamp((top[2] + (bottom[2] - top[2]) * t) * 0.86),
    ]
  })
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const BOARD_VERSION = 2

/** Fixed ids: stable across runs, and legal for `assertBoardId` (`[a-z0-9]`). */
export const MAIN_BOARD = 'bpreviewmain'
export const SIDE_BOARD = 'bpreviewside'
export const SOLO_BOARD = 'bpreviewsolo'

/**
 * Absolute path of the preview output directory a caller seeds.
 *
 * @param {string} root - the `verify/preview` directory.
 * @returns {string} the output directory handed to the plugin as `outputDir`.
 */
export function dataDir(root) {
  return join(root, 'data')
}

/** Directory holding board JSON, mirroring `<outputDir>/.dsh-image-forge`. */
const boardsRoot = (dir) => join(dir, '.dsh-image-forge')

/** ISO time `offsetMinutes` before now, so the library sorts predictably. */
function ago(offsetMinutes) {
  return new Date(Date.now() - offsetMinutes * 60_000).toISOString()
}

/**
 * One picture on disk plus the two strings a board item stores for it.
 *
 * @param {string} dir - output directory.
 * @param {string} name - file stem.
 * @param {{width: number, height: number, top: [number,number,number], bottom: [number,number,number]}} spec - size and colours.
 * @returns {{path: string, markdownPath: string, width: number, height: number, bytes: number, mediaType: string}} the item's file fields.
 */
function picture(dir, name, spec) {
  const path = join(dir, 'images', `${name}.png`)
  const bytes = plate(spec.width, spec.height, spec.top, spec.bottom, spec.noise === true)
  writeFileSync(path, bytes)
  return {
    path,
    markdownPath: path,
    width: spec.width,
    height: spec.height,
    bytes: bytes.length,
    mediaType: 'image/png',
  }
}

/**
 * One image board item, with every field `migrateBoardFile` reads.
 *
 * @param {object} input - id, file fields, position and provenance.
 * @returns {object} the stored item.
 */
function imageItem(input) {
  return {
    id: input.id,
    kind: 'image',
    path: input.file.path,
    markdownPath: input.file.markdownPath,
    width: input.file.width,
    height: input.file.height,
    bytes: input.file.bytes,
    mediaType: input.file.mediaType,
    prompt: input.prompt,
    ratio: input.ratio ?? null,
    steps: input.steps ?? 8,
    seed: input.seed ?? 20261118,
    mode: input.mode ?? 'generate',
    backend: 'comfyui',
    parents: [...(input.parents ?? [])],
    createdAt: input.createdAt,
    sessionId: null,
    batchId: input.batchId ?? 'pv-batch-1',
    x: input.x,
    y: input.y,
  }
}

/** One failed task node, exactly as `saveTaskItem` would leave it on disk. */
function taskItem(input) {
  return {
    id: input.id,
    kind: 'task',
    path: '',
    markdownPath: '',
    width: 0,
    height: 0,
    bytes: 0,
    mediaType: '',
    prompt: '',
    ratio: null,
    steps: null,
    seed: null,
    mode: 'generate',
    backend: 'studio',
    parents: [],
    createdAt: input.createdAt,
    sessionId: null,
    batchId: 'pv-task-1',
    x: input.x,
    y: input.y,
    task: {
      status: 'failed',
      params: {
        prompt: input.prompt,
        ratio: '16:9',
        steps: 8,
        count: 2,
      },
      error: input.error,
    },
  }
}

/** One layout node, exactly as `saveLayoutItem` would leave it on disk. */
function layoutItem(input) {
  return {
    id: input.id,
    kind: 'layout',
    path: '',
    markdownPath: '',
    width: 0,
    height: 0,
    bytes: 0,
    mediaType: '',
    prompt: '',
    ratio: null,
    steps: null,
    seed: null,
    mode: 'generate',
    backend: 'studio',
    parents: [],
    createdAt: input.createdAt,
    sessionId: null,
    batchId: 'pv-layout-1',
    x: input.x,
    y: input.y,
    draft: {
      width: 1024,
      height: 1024,
      bbox_coord_space: 'abs',
      bbox_format: 'xyxy',
      summary: { caption: '雨夜街角的双人构图草图', canvas: 'single' },
      items: [
        { label: 'object', caption: '路灯与雨棚', bbox: [96, 176, 420, 760] },
        { label: 'character', caption: '打伞的行人', bbox: [512, 300, 792, 872] },
      ],
    },
    w: 300,
    h: 300,
  }
}

/**
 * Write every preview board, picture and workspace file.
 *
 * Idempotent: files are rewritten, so a change here shows up on the next run.
 *
 * @param {string} root - the `verify/preview` directory.
 * @returns {{root: string, outputDir: string, boards: string[], mainBoard: string, nodes: number}} what was written.
 */
export function writeFixtures(root) {
  const dir = dataDir(root)
  mkdirSync(join(boardsRoot(dir), 'boards'), { recursive: true })
  mkdirSync(join(dir, 'images'), { recursive: true })

  // ---- the board the canvas tab opens (8 nodes) ---------------------------
  const wide = picture(dir, 'rainy-wide', {
    width: 1600,
    height: 900,
    top: [54, 78, 126],
    bottom: [128, 62, 96],
    noise: true,
  })
  const tall = picture(dir, 'rainy-tall', {
    width: 608,
    height: 1080,
    top: [36, 96, 92],
    bottom: [16, 44, 78],
  })
  const square = picture(dir, 'rainy-square', {
    width: 800,
    height: 800,
    top: [120, 84, 40],
    bottom: [52, 34, 24],
  })
  const edited = picture(dir, 'rainy-edit', {
    width: 608,
    height: 1080,
    top: [92, 60, 132],
    bottom: [30, 20, 66],
  })
  const detail = picture(dir, 'rainy-detail', {
    width: 960,
    height: 540,
    top: [70, 100, 88],
    bottom: [22, 40, 46],
  })
  const spare = picture(dir, 'rainy-spare', {
    width: 800,
    height: 800,
    top: [110, 110, 118],
    bottom: [44, 44, 52],
  })

  const mainItems = [
    imageItem({
      id: 'node-wide',
      file: wide,
      prompt: '雨夜东京街口，霓虹招牌反射在积水上，16:9 横构图，浅景深。',
      ratio: '16:9',
      x: 40,
      y: 40,
      createdAt: ago(40),
    }),
    imageItem({
      id: 'node-tall',
      file: tall,
      prompt: '同一条街的竖构图：便利店门口撑伞的人，9:16。',
      ratio: '9:16',
      x: 560,
      y: 40,
      createdAt: ago(38),
      batchId: 'pv-batch-2',
    }),
    imageItem({
      id: 'node-square',
      file: square,
      prompt: '路灯下的雨伞特写，方图 1:1。',
      ratio: '1:1',
      x: 1080,
      y: 40,
      createdAt: ago(36),
      batchId: 'pv-batch-3',
    }),
    imageItem({
      id: 'node-edit',
      file: edited,
      prompt: '把竖构图的雨改成细雪，人物姿势与构图不变（改图）。',
      ratio: '9:16',
      mode: 'edit',
      parents: ['node-tall'],
      x: 40,
      y: 440,
      createdAt: ago(20),
      batchId: 'pv-batch-4',
    }),
    imageItem({
      id: 'node-detail',
      file: detail,
      prompt: '从横图延展出的近景细节，保留霓虹色温。',
      ratio: '16:9',
      mode: 'edit',
      parents: ['node-wide'],
      x: 560,
      y: 440,
      createdAt: ago(18),
      batchId: 'pv-batch-5',
    }),
    imageItem({
      id: 'node-spare',
      file: spare,
      prompt: '金属质感的雨伞骨架练习。',
      ratio: '1:1',
      x: 1080,
      y: 440,
      createdAt: ago(16),
      batchId: 'pv-batch-6',
    }),
    taskItem({
      id: 'node-task',
      prompt: '雨夜街口四宫格，电影感，16:9。',
      error: 'ComfyUI 未连接：connect ECONNREFUSED 127.0.0.1:8188（预览数据）',
      x: 40,
      y: 840,
      createdAt: ago(10),
    }),
    layoutItem({
      id: 'node-layout',
      prompt: '雨夜街角的双人构图草图',
      x: 560,
      y: 840,
      createdAt: ago(8),
    }),
  ]

  writeFileSync(
    join(boardsRoot(dir), 'boards', `${MAIN_BOARD}.json`),
    JSON.stringify(
      {
        version: BOARD_VERSION,
        id: MAIN_BOARD,
        name: '雨夜东京 · 竖构图',
        createdAt: ago(600),
        updatedAt: ago(5),
        sessionId: null,
        camera: { x: 20, y: 20, zoom: 0.5 },
        items: mainItems,
      },
      null,
      2,
    ),
  )

  // ---- two more projects, so the grid has real cards ---------------------
  const sideA = picture(dir, 'window-a', { width: 1600, height: 900, top: [186, 158, 120], bottom: [96, 74, 60], noise: true })
  const sideB = picture(dir, 'window-b', { width: 800, height: 800, top: [150, 132, 110], bottom: [70, 58, 50] })
  const sideC = picture(dir, 'window-c', { width: 608, height: 1080, top: [170, 150, 128], bottom: [88, 74, 66] })
  writeFileSync(
    join(boardsRoot(dir), 'boards', `${SIDE_BOARD}.json`),
    JSON.stringify(
      {
        version: BOARD_VERSION,
        id: SIDE_BOARD,
        name: '窗台午后',
        createdAt: ago(1500),
        updatedAt: ago(90),
        sessionId: null,
        camera: null,
        items: [
          imageItem({ id: 'side-a', file: sideA, prompt: '橘猫在朝西的窗台上，午后侧光穿过纱帘。', ratio: '16:9', x: 40, y: 40, createdAt: ago(140) }),
          imageItem({ id: 'side-b', file: sideB, prompt: '窗台特写，暖色木地板与猫尾。', ratio: '1:1', x: 560, y: 40, createdAt: ago(120) }),
          imageItem({ id: 'side-c', file: sideC, prompt: '竖版的窗边猫，9:16 壁纸用途。', ratio: '9:16', x: 40, y: 400, createdAt: ago(100) }),
        ],
      },
      null,
      2,
    ),
  )

  const solo = picture(dir, 'metal', { width: 800, height: 800, top: [96, 100, 108], bottom: [40, 44, 52] })
  writeFileSync(
    join(boardsRoot(dir), 'boards', `${SOLO_BOARD}.json`),
    JSON.stringify(
      {
        version: BOARD_VERSION,
        id: SOLO_BOARD,
        name: '金属质感练手',
        createdAt: ago(3000),
        updatedAt: ago(2400),
        sessionId: null,
        camera: null,
        items: [imageItem({ id: 'solo-a', file: solo, prompt: '不锈钢雨伞骨架的材质练习。', ratio: '1:1', x: 40, y: 40, createdAt: ago(2400) })],
      },
      null,
      2,
    ),
  )

  // ---- workspace: projects tab in front, one canvas tab already open -----
  writeFileSync(
    join(boardsRoot(dir), 'workspace.json'),
    JSON.stringify(
      {
        version: 1,
        openProjects: [MAIN_BOARD],
        activeTab: { kind: 'projects' },
        nodeDetailTabs: [],
        tabOrder: ['projects', `canvas:${MAIN_BOARD}`],
        recentProjects: [
          { boardId: MAIN_BOARD, openedAt: ago(12) },
          { boardId: SIDE_BOARD, openedAt: ago(120) },
        ],
      },
      null,
      2,
    ),
  )

  writeFileSync(join(boardsRoot(dir), 'state.json'), JSON.stringify({ active: MAIN_BOARD }, null, 2))

  return {
    root,
    outputDir: dir,
    boards: [MAIN_BOARD, SIDE_BOARD, SOLO_BOARD],
    mainBoard: MAIN_BOARD,
    nodes: mainItems.length,
  }
}
