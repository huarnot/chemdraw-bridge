/**
 * RDKit CoordGen layout helper.
 *
 * ChemDraw's clipboard parser often lays a large molecule out vertically. A
 * CoordGen MOL gives ChemDraw a compact, publication-style 2D layout, and the
 * chiral flag suppresses ChemDraw's "&1" enhanced-stereo labels.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PDF_TOOL = path.join(PACKAGE_ROOT, 'scripts', 'pdf_tool.py')
const VENDOR_PYTHON = path.join(PACKAGE_ROOT, 'vendor', 'venv', 'Scripts', 'python.exe')

function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    // Best effort.
  }
}

/**
 * Write a CoordGen MOL file for a SMILES. Returns the path that was written.
 */
export async function createCoordGenMol(options) {
  const python = path.resolve(options.pythonPath || VENDOR_PYTHON)
  const stat = await fs.stat(python).catch(() => null)
  if (!stat || !stat.isFile()) {
    throw new Error(`找不到 Python：${python}。请运行 scripts/setup-python.ps1。`)
  }
  const outPath = path.resolve(options.outPath)
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.min(60_000, Math.max(5_000, Math.round(options.timeoutMs)))
    : 30_000

  await new Promise((resolve, reject) => {
    const child = spawn(python, [PDF_TOOL, 'coordgen', String(options.smiles ?? ''), outPath], {
      windowsHide: true,
      stdio: 'ignore',
    })
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      killTree(child.pid)
      finish(reject, new Error('操作已取消。'))
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(reject, new Error('CoordGen 排版超时。'))
    }, timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => {
      if (code === 0) finish(resolve)
      else finish(reject, new Error(`CoordGen 排版失败（退出码 ${code}）。`))
    })
  })

  const result = await fs.stat(outPath).catch(() => null)
  if (!result || result.size < 100) throw new Error('CoordGen 没有写出 MOL 文件。')
  return outPath
}
