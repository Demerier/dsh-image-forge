/**
 * Process execution helpers.
 *
 * Every child process this plugin starts gets its stdout/stderr on a **file
 * descriptor**, never a pipe. Two reasons, both learned on this host:
 *
 * 1. The file sandbox denies pipe-backed spawns (`spawn ... EPERM`), so
 *    `execFile`/`spawn` with the default `stdio: 'pipe'` fails where the fd form
 *    works.
 * 2. A pipe dies with its reader: the worker's log would be lost exactly when it
 *    is needed, i.e. when the process crashes.
 *
 * The cost is that stdout and stderr arrive interleaved in one file, which is why
 * the result exposes `output` rather than separate streams — pip and torch both
 * write progress and errors there anyway.
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Outcome of one child process, with its combined output. */
export interface RunResult {
  /** Exit code 0. */
  readonly ok: boolean
  /** Exit code, or null when the process was killed or could not start. */
  readonly code: number | null
  /** Signal that ended the process, when it was not a plain exit. */
  readonly signal: string | null
  /** Combined stdout+stderr, tail-truncated. */
  readonly output: string
  /** The command was killed for exceeding its budget. */
  readonly timedOut: boolean
  /** Human-readable command line, for reports. */
  readonly command: string
  /** Why no exit code was obtained (spawn failure). */
  readonly note?: string
  /** Absolute path of the raw log, when one was written. */
  readonly logPath?: string
}

/** Options for `runCaptured`. */
export interface RunOptions {
  /** Kill the process after this many milliseconds. */
  readonly timeoutMs?: number
  /** Working directory. */
  readonly cwd?: string
  /** Extra environment variables, merged over `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Directory for the raw log file; defaults to the OS temp directory. */
  readonly scratchDir?: string
  /** Keep at most this many bytes of output (from the end). */
  readonly maxOutputBytes?: number
  /** Log file name prefix, so the leftover file is identifiable. */
  readonly label?: string
  /**
   * Keep the raw log file after the run. Off by default: short probes only need
   * the text they already got back. Long installs turn it on so a failure can be
   * pointed at.
   */
  readonly keepLog?: boolean
}

/** Read at most the last `maxBytes` of a file, as text. */
function readTail(path: string, maxBytes: number): string {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - maxBytes)
    const raw = readFileSync(path).subarray(start).toString('utf8')
    const truncated = start > 0
    const text = raw.replace(/\r\n/g, '\n').trimEnd()
    return truncated ? `…(truncated)\n${text}` : text
  } catch {
    return ''
  }
}

/**
 * Open a log file for a child process's stdout/stderr.
 *
 * The configured directory is tried first, then the OS temp directory: a runtime
 * directory that cannot be written (a locked-down sandbox, a read-only profile)
 * must degrade to "logs land elsewhere", not to "the probe silently failed" or
 * "an unhandled exception while starting the worker".
 *
 * @param preferredDir - directory the caller would like the log in.
 * @param name - file name inside that directory.
 * @returns the open descriptor, its path, and a note when the fallback was used.
 */
export async function openLogFile(
  preferredDir: string,
  name: string,
): Promise<{ fd: number; path: string; note?: string }> {
  const candidates = [preferredDir, tmpdir()].filter((dir, index, all) => dir.length > 0 && all.indexOf(dir) === index)
  const problems: string[] = []
  for (const dir of candidates) {
    const path = join(dir, name)
    try {
      await mkdir(dir, { recursive: true })
      const fd = openSync(path, 'a')
      return dir === preferredDir ? { fd, path } : { fd, path, note: `${preferredDir} is not writable, so logs go to ${dir}` }
    } catch (error) {
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`cannot open a log file (${problems.join('; ')})`)
}

/**
 * Run one command to completion, capturing its output through a log file.
 *
 * @param file - executable path (never resolved through a shell).
 * @param args - argument vector.
 * @param options - time budget, environment, and where to write the log.
 * @returns the exit code and combined output; spawn failures are reported, not thrown.
 */
export async function runCaptured(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const scratchDir = options.scratchDir ?? tmpdir()
  const label = options.label ?? 'cmd'
  const command = `${file} ${args.join(' ')}`
  let log: { fd: number; path: string; note?: string }
  try {
    log = await openLogFile(scratchDir, `${label}-${randomBytes(4).toString('hex')}.log`)
  } catch (error) {
    return {
      ok: false,
      code: null,
      signal: null,
      output: '',
      timedOut: false,
      command,
      note: error instanceof Error ? error.message : String(error),
    }
  }
  const { fd, path: logPath } = log
  try {
    return await new Promise<RunResult>((resolve) => {
      let settled = false
      let child: ReturnType<typeof spawn> | null = null
      let timer: NodeJS.Timeout | null = null
      let timedOut = false
      const finish = (result: Omit<RunResult, 'output' | 'command' | 'logPath'>) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        const output = readTail(logPath, options.maxOutputBytes ?? 262_144)
        if (options.keepLog !== true) {
          try {
            rmSync(logPath, { force: true })
          } catch {
            /* nothing to clean */
          }
        }
        resolve({
          ...result,
          output,
          command,
          logPath: options.keepLog === true ? logPath : undefined,
        })
      }
      try {
        child = spawn(file, [...args], {
          stdio: ['ignore', fd, fd],
          windowsHide: true,
          cwd: options.cwd,
          env: options.env === undefined ? process.env : { ...process.env, ...options.env },
        })
      } catch (error) {
        finish({
          ok: false,
          code: null,
          signal: null,
          timedOut: false,
          note: `${file} could not be started: ${error instanceof Error ? error.message : String(error)}`,
        })
        return
      }
      timer = setTimeout(() => {
        timedOut = true
        try {
          child?.kill()
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            child?.kill('SIGKILL')
          } catch {
            /* already gone */
          }
          // Last resort: a process that ignores both signals must not hang the
          // tool call forever. Its log is already on disk.
          setTimeout(() => finish({ ok: false, code: null, signal: null, timedOut: true, note: 'killed after timeout' }), 2000).unref?.()
        }, 3000).unref?.()
      }, timeoutMs)
      child.once('error', (error: NodeJS.ErrnoException) => {
        finish({ ok: false, code: null, signal: null, timedOut, note: `${error.code ?? ''} ${error.message}`.trim() })
      })
      child.once('exit', (code, signal) => {
        finish({ ok: code === 0, code, signal: signal ?? null, timedOut })
      })
    })
  } finally {
    closeSync(fd)
  }
}

/** Delete a log file produced by `runCaptured` (kept for the caller's copy). */
export function discardLog(path: string | undefined): void {
  if (path === undefined) return
  try {
    rmSync(path, { force: true })
  } catch {
    /* nothing to clean */
  }
}

/** Does this path exist? */
export function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Would starting this program fail for a reason we can see up front?
 *
 * A bare command name (`python`, `py`) is left to the OS path lookup — reporting
 * it as missing would be a guess, not a fact.
 *
 * @param executable - absolute path, or a bare command name.
 * @returns true only when an explicit path is absent.
 */
export function executableMissing(executable: string): boolean {
  const looksLikePath = /[\\/]/.test(executable) || /^[A-Za-z]:/.test(executable)
  return looksLikePath && !pathExists(executable)
}

/**
 * Parse a port list like `8399-8410`, `8399,8400`, or a mix.
 *
 * Unparsable fragments are dropped rather than rejected: a typo in the config
 * must not stop the plugin from loading, and the defaults are documented.
 *
 * @param spec - config value.
 * @param fallback - ports to use when nothing survives parsing.
 * @returns distinct valid ports, in the order written.
 */
export function parsePorts(spec: string, fallback: readonly number[]): number[] {
  const ports: number[] = []
  const push = (port: number) => {
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && !ports.includes(port)) ports.push(port)
  }
  for (const rawPart of spec.split(/[,\s]+/)) {
    const part = rawPart.trim()
    if (part.length === 0) continue
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (range !== null) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (to >= from && to - from <= 64) for (let port = from; port <= to; port += 1) push(port)
      continue
    }
    const single = /^(\d+)$/.exec(part)
    if (single !== null) push(Number(single[1]))
  }
  return ports.length > 0 ? ports : [...fallback]
}
