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

function caption(id, text, x, y, width = 120) {
  return `<t id="${id}" p="${x} ${y}" BoundingBox="${x - width / 2} ${y - 10} ${x + width / 2} ${y + 10}" Z="2" LineHeight="auto"><s font="20" size="12" color="0">${escapeXml(text)}</s></t>`
}

function buildSchemeXml(baseXml, layout) {
  const { arrow, captions } = layout
  const arrowXml = `<arrow id="9001" BoundingBox="${arrow.tail - 6} ${arrow.y - 6} ${arrow.head + 6} ${arrow.y + 6}" Z="1" FillType="None" ArrowheadHead="Full" ArrowheadType="Solid" HeadSize="2250" ArrowheadCenterSize="1969" ArrowheadWidth="563" Head3D="${arrow.head} ${arrow.y} 0" Tail3D="${arrow.tail} ${arrow.y} 0" Center3D="${(arrow.tail + arrow.head) / 2} ${arrow.y} 0" MajorAxisEnd3D="${(arrow.tail + arrow.head) / 2 + 30} ${arrow.y} 0" MinorAxisEnd3D="${(arrow.tail + arrow.head) / 2} ${arrow.y + 30} 0" />`
  const captionXml = captions.map((item, index) => caption(9101 + index, item.text, item.x, item.y, item.width ?? 120)).join('')
  if (!baseXml.includes('</page>')) throw new Error('ChemDraw 输出的 CDXML 缺少 page 节点。')
  return baseXml.replace('</page>', `${arrowXml}${captionXml}</page>`)
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
  const spacing = 120
  const items = []
  const reactantX = reactants.map((smiles, index) => ({ smiles, x: 70 + index * spacing, y }))
  items.push(...reactantX)
  const lastReactantX = reactantX[reactantX.length - 1].x
  const arrowTail = lastReactantX + 50
  const productStartX = arrowTail + 140
  const productX = products.map((smiles, index) => ({ smiles, x: productStartX + index * spacing, y }))
  items.push(...productX)
  const arrowHead = productStartX - 50

  const captions = []
  if (options.conditions) {
    captions.push({ text: options.conditions, x: (arrowTail + arrowHead) / 2, y: y - 24, width: 160 })
  }
  if (options.yieldText) {
    captions.push({ text: options.yieldText, x: (arrowTail + arrowHead) / 2, y: y + 26, width: 100 })
  }
  for (let index = 1; index < reactantX.length; index += 1) {
    captions.push({ text: '+', x: (reactantX[index - 1].x + reactantX[index].x) / 2, y, width: 20 })
  }
  for (let index = 1; index < productX.length; index += 1) {
    captions.push({ text: '+', x: (productX[index - 1].x + productX[index].x) / 2, y, width: 20 })
  }

  const cwd = options.cwd || process.cwd()
  const outputDir = resolveOutputDir(cwd, options.outputDir)
  await fs.mkdir(outputDir, { recursive: true })
  const base = options.name ? sanitizeBaseName(options.name) : 'reaction'
  const finalCdxml = await uniquePath(outputDir, base, '.cdxml', options.overwrite === true)
  const stem = path.basename(finalCdxml, '.cdxml')
  const finalCdx = options.alsoCdx ? await uniquePath(outputDir, stem, '.cdx', options.overwrite === true) : ''
  const finalPng = path.join(outputDir, `${stem}.png`)

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reaction-'))
  const baseCdxml = path.join(tempDir, 'base.cdxml')
  const schemeCdxml = path.join(tempDir, 'scheme.cdxml')
  const schemeCdx = path.join(tempDir, 'scheme.cdx')
  const schemePng = path.join(tempDir, 'scheme.png')

  try {
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
