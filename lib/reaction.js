/**
 * Reaction-scheme drafting.
 *
 * ChemDraw lays out each structure at a known position, then a small CDXML
 * post-process adds the reaction arrow, conditions and plus signs. This is a
 * draft: structures come from trusted SMILES, but stoichiometry and conditions
 * still need a human check.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveOutputDir, sanitizeBaseName, uniquePath } from './naming.js'
import { createCoordGenMol } from './coordgen.js'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LAYOUT_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'reaction_layout.ps1')
const OPEN_SAVE_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'open_save.ps1')

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    // Best effort.
  }
}

function runPowerShell(script, requestFile, resultFile, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-RequestFile', requestFile, '-ResultFile', resultFile,
    ], { windowsHide: true, stdio: 'ignore' })
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
      finish(reject, new Error('反应式生成超时。'))
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

async function callScript(script, payload, timeoutMs, signal) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reaction-'))
  const request = path.join(tempDir, 'request.json')
  const result = path.join(tempDir, 'result.json')
  try {
    await fs.writeFile(request, JSON.stringify(payload), 'utf8')
    const code = await runPowerShell(script, request, result, timeoutMs, signal)
    const data = await readJson(result).catch(() => null)
    if (!data) throw new Error(`反应式脚本没有返回结果（退出码 ${code}）。`)
    if (!data.ok) throw new Error(`反应式生成失败（${data.stage}）：${data.error}`)
    return data
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function caption(id, text, x, y) {
  // CDXML captions use p as the left edge. Estimate Arial 9 pt text width so
  // the visual center lands on the arrow center.
  const width = Math.max(12, String(text).length * 5.2)
  const left = x - width / 2
  return `<t id="${id}" p="${left} ${y}" BoundingBox="${left} ${y - 9} ${left + width} ${y + 9}" Z="2" LabelJustification="Center" LabelAlignment="Center" LineHeight="auto"><s font="3" size="9" color="0">${escapeXml(text)}</s></t>`
}

function buildSchemeXml(baseXml, layout) {
  const { arrow, captions } = layout
  const arrowXml = `<arrow id="9001" BoundingBox="${arrow.tail - 5} ${arrow.y - 5} ${arrow.head + 5} ${arrow.y + 5}" Z="1" FillType="None" ArrowheadHead="Full" ArrowheadType="Solid" HeadSize="1500" ArrowheadCenterSize="1313" ArrowheadWidth="375" Head3D="${arrow.head} ${arrow.y} 0" Tail3D="${arrow.tail} ${arrow.y} 0" Center3D="${(arrow.tail + arrow.head) / 2} ${arrow.y} 0" MajorAxisEnd3D="${(arrow.tail + arrow.head) / 2 + 30} ${arrow.y} 0" MinorAxisEnd3D="${(arrow.tail + arrow.head) / 2} ${arrow.y + 30} 0" />`
  const captionXml = captions.map((item, index) => caption(9101 + index, item.text, item.x, item.y)).join('')
  if (!baseXml.includes('</page>')) throw new Error('ChemDraw 输出的 CDXML 缺少 page 节点。')
  return baseXml.replace('</page>', `${arrowXml}${captionXml}</page>`)
}

async function estimateMolWidth(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    const lines = text.split(/\r?\n/)
    const counts = lines[3] ?? ''
    const atomCount = Number.parseInt(counts.slice(0, 3), 10)
    if (!Number.isFinite(atomCount) || atomCount < 1) return 80
    let min = Infinity
    let max = -Infinity
    for (let index = 4; index < 4 + atomCount; index += 1) {
      const x = Number.parseFloat((lines[index] ?? '').slice(0, 10))
      if (!Number.isFinite(x)) continue
      min = Math.min(min, x)
      max = Math.max(max, x)
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 80
    // CoordGen coordinates are in Å; ChemDraw's 20 pt bond is about 13.3 pt/Å.
    return Math.max(30, (max - min) * 13.3 + 18)
  } catch {
    return 80
  }
}

/**
 * @param {object} options
 * @param {string[]} options.reactants SMILES
 * @param {string[]} options.products SMILES
 * @param {string} [options.conditions]
 * @param {string} [options.yieldText]
 * @param {string} [options.name]
 */
export async function drawReaction(options) {
  const reactants = (Array.isArray(options.reactants) ? options.reactants : []).map((value) => String(value ?? '').trim()).filter(Boolean)
  const products = (Array.isArray(options.products) ? options.products : []).map((value) => String(value ?? '').trim()).filter(Boolean)
  if (reactants.length === 0) throw new Error('至少需要一个反应物 SMILES。')
  if (products.length === 0) throw new Error('至少需要一个产物 SMILES。')

  const y = 260
  const items = [
    ...reactants.map((smiles) => ({ smiles, kind: 'reactant' })),
    ...products.map((smiles) => ({ smiles, kind: 'product' })),
  ]
  const captions = []
  let arrowTail = 0
  let arrowHead = 0

  const cwd = options.cwd || process.cwd()
  const outputDir = resolveOutputDir(cwd, options.outputDir)
  await fs.mkdir(outputDir, { recursive: true })
  const base = options.name ? sanitizeBaseName(options.name) : 'reaction'
  const finalCdxml = await uniquePath(outputDir, base, '.cdxml', options.overwrite === true)
  const stem = path.basename(finalCdxml, '.cdxml')
  const finalCdx = options.alsoCdx ? await uniquePath(outputDir, stem, '.cdx', options.overwrite === true) : ''
  const finalPng = path.join(outputDir, `${stem}.png`)

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reaction-'))
  const molDir = path.join(tempDir, 'mols')
  const baseCdxml = path.join(tempDir, 'base.cdxml')
  const schemeCdxml = path.join(tempDir, 'scheme.cdxml')
  const schemeCdx = path.join(tempDir, 'scheme.cdx')
  const schemePng = path.join(tempDir, 'scheme.png')
  const measureCdxml = path.join(tempDir, 'measure.cdxml')

  try {
    await fs.mkdir(molDir, { recursive: true })
    for (const [index, item] of items.entries()) {
      try {
        item.molPath = await createCoordGenMol({
          smiles: item.smiles,
          pythonPath: options.pythonPath,
          outPath: path.join(molDir, `structure-${index}.mol`),
          timeoutMs: 30_000,
          signal: options.signal,
        })
      } catch {
        item.molPath = ''
      }
    }

    const gap = 28
    let cursor = 70
    const conditionLines = String(options.conditions ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const conditionWidth = conditionLines.reduce((max, line) => Math.max(max, line.length * 5.2), 0)
    const arrowGap = Math.max(80, conditionWidth + 24)
    const reactantItems = items.filter((item) => item.kind === 'reactant')
    const productItems = items.filter((item) => item.kind === 'product')

    // First pass: let ChemDraw report the actual width of each CoordGen
    // structure, so large substrates/products cannot collide.
    const measured = await callScript(LAYOUT_SCRIPT, {
      outCdxml: measureCdxml,
      items: items.map((item) => ({ ...item, x: 70, y })),
    }, 180_000, options.signal)
    const widths = []
    for (const [index, item] of items.entries()) {
      const actual = Number(measured.placements?.[index]?.width)
      widths.push(Number.isFinite(actual) && actual > 0 ? actual : (item.molPath ? await estimateMolWidth(item.molPath) : 80))
    }

    for (const item of reactantItems) {
      const width = widths[items.indexOf(item)]
      item.x = cursor + width / 2
      item.y = y
      cursor += width + gap
    }
    arrowTail = cursor + 10
    arrowHead = arrowTail + arrowGap
    cursor = arrowHead + 18
    for (const item of productItems) {
      const width = widths[items.indexOf(item)]
      item.x = cursor + width / 2
      item.y = y
      cursor += width + gap
    }

    for (const [index, line] of conditionLines.entries()) {
      captions.push({
        text: line,
        x: (arrowTail + arrowHead) / 2,
        y: y - 18 - (conditionLines.length - 1 - index) * 12,
      })
    }
    if (options.yieldText) {
      captions.push({ text: options.yieldText, x: (arrowTail + arrowHead) / 2, y: y + 20 })
    }
    for (let index = 1; index < reactantItems.length; index += 1) {
      captions.push({ text: '+', x: (reactantItems[index - 1].x + reactantItems[index].x) / 2, y })
    }
    for (let index = 1; index < productItems.length; index += 1) {
      captions.push({ text: '+', x: (productItems[index - 1].x + productItems[index].x) / 2, y })
    }

    await callScript(LAYOUT_SCRIPT, { outCdxml: baseCdxml, items }, 180_000, options.signal)
    const baseXml = await fs.readFile(baseCdxml, 'utf8')
    const schemeXml = buildSchemeXml(baseXml, {
      arrow: { tail: arrowTail, head: arrowHead, y },
      captions,
    })
    await fs.writeFile(schemeCdxml, schemeXml, 'utf8')

    await callScript(OPEN_SAVE_SCRIPT, {
      inCdxml: schemeCdxml,
      outCdx: finalCdx ? schemeCdx : '',
      outPng: schemePng,
    }, 120_000, options.signal)

    await fs.copyFile(schemeCdxml, finalCdxml)
    if (finalCdx) await fs.copyFile(schemeCdx, finalCdx)
    await fs.copyFile(schemePng, finalPng)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  const files = [
    { path: finalCdxml, format: 'cdxml', bytes: (await fs.stat(finalCdxml)).size },
    { path: finalPng, format: 'png', bytes: (await fs.stat(finalPng)).size },
  ]
  if (finalCdx) files.push({ path: finalCdx, format: 'cdx', bytes: (await fs.stat(finalCdx)).size })

  const metaPath = path.join(outputDir, `${stem}.meta.json`)
  const metaText = `${JSON.stringify({
    generator: '@local/dsh-plugin-chemdraw-bridge',
    generatedAt: new Date().toISOString(),
    layout: 'coordgen',
    reaction: {
      reactants,
      products,
      conditions: options.conditions ?? '',
      yield: options.yieldText ?? '',
    },
    note: 'Reaction layout draft; verify arrow direction, conditions, stoichiometry and products.',
  }, null, 2)}\n`
  await fs.writeFile(metaPath, metaText, 'utf8')
  files.push({ path: metaPath, format: 'json', bytes: Buffer.byteLength(metaText) })

  return {
    ok: true,
    files,
    reaction: {
      reactants,
      products,
      conditions: options.conditions ?? '',
      yield: options.yieldText ?? '',
    },
    message: `已生成反应式草稿：${reactants.length} 个反应物 → ${products.length} 个产物。条件和化学计量请人工核对。`,
  }
}
