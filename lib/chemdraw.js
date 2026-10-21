/**
 * ChemDraw COM bridge.
 *
 * A short Windows PowerShell script opens a hidden ChemDraw document, pastes a
 * SMILES string (ChemDraw turns it into a laid-out structure), and saves the
 * document as CDXML through ChemDraw itself. The conversion therefore uses
 * ChemDraw's own parser and drawing engine rather than a hand-written writer.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT_PATH = path.join(PACKAGE_ROOT, 'scripts', 'convert.ps1')
const DEFAULT_TIMEOUT_MS = 120_000

export class ChemDrawError extends Error {
  constructor(message, code = 'CHEMDRAW', details = {}) {
    super(message)
    this.name = 'ChemDrawError'
    this.code = code
    this.details = details
  }
}

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  } catch {
    // Best effort: the PowerShell process may already have exited.
  }
}

function runPowerShell(args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), args, {
      windowsHide: true,
      stdio: 'ignore',
    })

    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }

    const onAbort = () => {
      killTree(child.pid)
      finish(reject, new ChemDrawError('操作已取消。', 'ABORTED'))
    }

    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(reject, new ChemDrawError(
        `ChemDraw 转换超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成，已终止。`,
        'TIMEOUT',
      ))
    }, timeoutMs)

    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      finish(reject, new ChemDrawError(`无法启动 PowerShell：${error.message}`, 'SPAWN'))
    })
    child.on('close', (code) => finish(resolve, code))
  })
}

function formatLog(log) {
  if (!Array.isArray(log) || log.length === 0) return ''
  return log.slice(-8).join('\n')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function statWithRetry(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await fs.stat(file)
    } catch (error) {
      lastError = error
      await sleep(100)
    }
  }
  throw lastError ?? new Error(`无法读取文件：${file}`)
}

async function readResult(resultPath) {
  let text
  try {
    text = await fs.readFile(resultPath, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** Serialize clipboard/ChemDraw work: only one conversion may run at a time. */
let queue = Promise.resolve()
export function withChemDrawLock(task) {
  const run = queue.then(task, task)
  queue = run.then(() => undefined, () => undefined)
  return run
}

/**
 * Convert a SMILES string into a CDXML file written by ChemDraw.
 *
 * @param {object} input
 * @param {string} input.smiles
 * @param {string} input.outCdxml
 * @param {string} [input.outCdx]
 * @param {number} [input.timeoutMs]
 * @param {AbortSignal} [input.signal]
 */
export async function runChemDraw(input) {
  if (process.platform !== 'win32') {
    throw new ChemDrawError('ChemDraw 自动化只支持 Windows。', 'PLATFORM')
  }
  const timeoutMs = Number.isFinite(input.timeoutMs)
    ? Math.min(300_000, Math.max(20_000, Math.round(input.timeoutMs)))
    : DEFAULT_TIMEOUT_MS

  const outCdxml = path.resolve(input.outCdxml)
  const outCdx = input.outCdx ? path.resolve(input.outCdx) : ''
  const outputDir = path.dirname(outCdxml)
  await fs.mkdir(outputDir, { recursive: true })

  // ChemDraw's SaveAs is unreliable with non-ASCII paths. Always let it write
  // to an ASCII staging directory, then move the finished files with Node.
  const tempRoots = [...new Set([
    os.tmpdir(),
    'C:\\Windows\\Temp',
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Temp'),
  ])]
  const asciiRoots = tempRoots.filter((root) => /^[\x20-\x7E]+$/.test(root))
  let tempDir = ''
  for (const root of (asciiRoots.length > 0 ? asciiRoots : tempRoots)) {
    try {
      tempDir = await fs.mkdtemp(path.join(root, 'dsh-chemdraw-'))
      break
    } catch {
      // Try the next candidate.
    }
  }
  if (!tempDir) throw new ChemDrawError('无法创建 ChemDraw 临时目录。', 'TEMP')

  const stagedCdxml = path.join(tempDir, 'structure.cdxml')
  const stagedCdx = outCdx ? path.join(tempDir, 'structure.cdx') : ''
  const requestPath = path.join(tempDir, 'request.json')
  const resultPath = path.join(tempDir, 'result.json')

  try {
    await fs.writeFile(requestPath, JSON.stringify({
      smiles: String(input.smiles ?? ''),
      outCdxml: stagedCdxml,
      outCdx: stagedCdx,
    }), 'utf8')
    if (process.env.DSH_CHEMDRAW_DEBUG === '1') {
      console.error('[chemdraw] request', requestPath, JSON.stringify({ stagedCdxml, stagedCdx, outCdxml, outCdx }))
    }

    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT_PATH,
      '-RequestFile',
      requestPath,
      '-ResultFile',
      resultPath,
    ]

    const code = await runPowerShell(args, timeoutMs, input.signal)
    const result = await readResult(resultPath)

    if (!result) {
      throw new ChemDrawError(
        `ChemDraw 自动化没有返回结果（PowerShell 退出码 ${code}）。请确认 ChemOffice 已正确安装并已激活。`,
        'NO_RESULT',
      )
    }
    if (!result.ok) {
      const log = formatLog(result.log)
      throw new ChemDrawError(
        `ChemDraw 在“${result.stage ?? '未知阶段'}”失败：${result.error ?? '未知错误'}${log ? `\n${log}` : ''}`,
        'FAILED',
        { stage: result.stage, log: result.log },
      )
    }

    const cdxmlStat = await statWithRetry(stagedCdxml).catch(() => null)
    if (!cdxmlStat || cdxmlStat.size < 400) {
      throw new ChemDrawError('CDXML 文件没有正常写出。', 'EMPTY_CDXML')
    }

    let cdxMagicOk = null
    if (outCdx) {
      cdxMagicOk = result.cdxMagicOk === true
      if (!cdxMagicOk) {
        throw new ChemDrawError(`CDX 文件没有正常写出或文件头不正确：${stagedCdx}`, 'EMPTY_CDX')
      }
      const cdxStat = await statWithRetry(stagedCdx).catch(() => null)
      if (!cdxStat || cdxStat.size <= 0) {
        throw new ChemDrawError(`CDX 文件为空：${stagedCdx}`, 'EMPTY_CDX')
      }
    }

    // Move the ChemDraw-written files to the requested (possibly non-ASCII)
    // destination. copyFile overwrites atomically enough for our purpose and
    // also works across drives, unlike rename.
    await fs.copyFile(stagedCdxml, outCdxml)
    if (outCdx) await fs.copyFile(stagedCdx, outCdx)

    const finalCdxmlStat = await statWithRetry(outCdxml)
    const finalCdxStat = outCdx ? await statWithRetry(outCdx) : null

    return {
      atomCount: Number(result.atomCount) || 0,
      bondCount: Number(result.bondCount) || 0,
      version: String(result.version ?? ''),
      startedHere: Boolean(result.startedHere),
      cdxmlBytes: finalCdxmlStat.size,
      cdxBytes: finalCdxStat ? finalCdxStat.size : 0,
      cdxMagicOk,
      log: result.log ?? [],
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
