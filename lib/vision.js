/**
 * Image-based structure recognition.
 *
 * OSRA is used because it is small, local and works well on clean, complete
 * structure depictions. It is deliberately a candidate generator, not a
 * source of truth: every SMILES is parsed by RDKit and the operator must
 * confirm it before a ChemDraw file is written. Abbreviated schemes such as
 * PhthN/MQ cannot be reconstructed from pixels and are expected to fail.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findPython } from './literature.js'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const OSRA_DIR = path.join(PACKAGE_ROOT, 'vendor', 'osra')
const OSRA_EXE = path.join(OSRA_DIR, 'osra.exe')
const PDF_TOOL = path.join(PACKAGE_ROOT, 'scripts', 'pdf_tool.py')

function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    // Best effort.
  }
}

function run(command, args, options, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore', ...options })
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
      finish(reject, new Error('操作已取消。'))
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(reject, new Error('图像识别超时。'))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => finish(resolve, code))
  })
}

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8')
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

async function validate(smiles, python, signal) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ocr-'))
  const out = path.join(tempDir, 'validate.json')
  try {
    const code = await run(python, [PDF_TOOL, 'validate', smiles, out], {}, 30_000, signal)
    if (code !== 0) return null
    return await readJson(out)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Recognize one image or a PDF region.
 *
 * @param {object} options
 * @param {string} [options.imagePath]
 * @param {string} [options.pdfPath]
 * @param {number} [options.page]
 * @param {number[]} [options.box] [x0,y0,x1,y1] in PDF points
 */
export async function recognizeImage(options = {}) {
  if (!(await fs.stat(OSRA_EXE).catch(() => null))) {
    throw new Error('图像识别组件未安装。请运行 scripts/setup-osra.ps1。')
  }
  const python = await findPython(options.pythonPath, options.signal)
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-vision-'))
  try {
    let imagePath = options.imagePath ? path.resolve(options.imagePath) : ''
    if (!imagePath && options.pdfPath) {
      const pdf = path.resolve(options.pdfPath)
      await fs.access(pdf)
      imagePath = path.join(tempDir, 'figure.png')
      const args = [PDF_TOOL, 'clip', pdf, String(options.page ?? 1), imagePath, '--dpi', '300']
      if (Array.isArray(options.box) && options.box.length === 4) {
        args.push('--box', ...options.box.map(String))
      }
      const code = await run(python, args, {}, 60_000, options.signal)
      if (code !== 0) throw new Error('无法从 PDF 截取该区域。')
    }
    if (!imagePath) throw new Error('请提供 image_path，或 pdf_path + page + box。')
    await fs.access(imagePath)

    const smilesFile = path.join(tempDir, 'osra.smi')
    const code = await run(OSRA_EXE, ['-w', smilesFile, imagePath], { cwd: OSRA_DIR }, 120_000, options.signal)
    const text = await fs.readFile(smilesFile, 'utf8').catch(() => '')
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) {
      throw new Error('没有识别出结构。OSRA 对缩写结构（PhthN、MQ 等）或低分辨率图片通常无效。')
    }

    const candidates = []
    const seen = new Set()
    for (const [index, smiles] of lines.entries()) {
      const result = await validate(smiles, python, options.signal)
      if (!result || seen.has(result.inchiKey)) continue
      seen.add(result.inchiKey)
      candidates.push({
        cid: 0,
        name: `Image candidate ${index + 1}`,
        cas: '',
        formula: result.formula,
        score: Math.max(0.5, 1 - index * 0.08),
        exact: false,
        sources: ['OSRA'],
        smiles: result.canonicalSmiles,
        inchiKey: result.inchiKey,
      })
      if (candidates.length >= 8) break
    }
    if (candidates.length === 0) {
      throw new Error('识别出的 SMILES 都无法通过 RDKit 校验。')
    }
    return candidates
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
