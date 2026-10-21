/**
 * Literature pipeline.
 *
 * A paper's supporting information almost always gives an IUPAC name for each
 * new compound, even when it never ships a ChemDraw file. This module extracts
 * that name from the PDF and resolves it with the public OPSIN name-to-structure
 * service; RDKit then independently checks the resulting formula and InChIKey.
 * Only a name that OPSIN can parse unambiguously is allowed through.
 */

import { spawn, spawnSync } from 'node:child_process'
import dns from 'node:dns'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PDF_TOOL = path.join(PACKAGE_ROOT, 'scripts', 'pdf_tool.py')
const OPSIN_BASE = 'https://opsin.ch.cam.ac.uk/opsin/'
const USER_AGENT = 'dsh-plugin-chemdraw-bridge/1.0 (literature structure extraction)'
const CURL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')

// Some hosts (including the OPSIN redirect target at EBI) are unreachable over
// IPv6 from this machine; prefer IPv4 for the literature HTTP calls.
dns.setDefaultResultOrder('ipv4first')

export class LiteratureError extends Error {
  constructor(message, code = 'LITERATURE', details = {}) {
    super(message)
    this.name = 'LiteratureError'
    this.code = code
    this.details = details
  }
}

function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    // Best effort.
  }
}

function runProcess(command, args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' })
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
      finish(reject, new LiteratureError('操作已取消。', 'ABORTED'))
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(reject, new LiteratureError(`外部进程超过 ${Math.round(timeoutMs / 1000)} 秒未完成。`, 'TIMEOUT'))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => finish(reject, new LiteratureError(`无法启动 ${command}：${error.message}`, 'SPAWN')))
    child.on('close', (code) => finish(resolve, code))
  })
}

let cachedPython = null

/** Find a Python that can import both pymupdf and rdkit. */
export async function findPython(explicit, signal) {
  if (cachedPython) return cachedPython
  const candidates = [...new Set([
    explicit,
    process.env.DSH_CHEMDRAW_PYTHON,
    path.join(PACKAGE_ROOT, 'vendor', 'venv', 'Scripts', 'python.exe'),
    'E:\\ds\\.venv-lit\\Scripts\\python.exe',
    'python',
  ].filter(Boolean))]

  for (const candidate of candidates) {
    try {
      const code = await runProcess(candidate, ['-c', 'import pymupdf, rdkit'], 20_000, signal)
      if (code === 0) {
        cachedPython = candidate
        return candidate
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new LiteratureError(
    '文献功能需要 Python 环境，并安装 pymupdf 和 rdkit。请运行：python -m pip install pymupdf rdkit，或在插件配置里指定 pythonPath。',
    'NO_PYTHON',
  )
}

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8')
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

async function pythonJson(python, args, timeoutMs, signal) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lit-'))
  const out = path.join(tempDir, 'result.json')
  try {
    const code = await runProcess(python, [...args, out], timeoutMs, signal)
    if (code !== 0) {
      throw new LiteratureError('PDF/RDKit 辅助脚本执行失败。', 'PYTHON_FAILED')
    }
    return await readJson(out)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function extractPdfText(pdfPath, python, signal) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lit-'))
  const out = path.join(tempDir, 'text.json')
  try {
    const code = await runProcess(python, [PDF_TOOL, 'text', pdfPath, out], 180_000, signal)
    if (code !== 0) throw new LiteratureError('无法从 PDF 提取文字。', 'PDF_TEXT')
    return await readJson(out)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function validateSmiles(smiles, python, signal) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lit-'))
  const out = path.join(tempDir, 'validate.json')
  try {
    const code = await runProcess(python, [PDF_TOOL, 'validate', smiles, out], 60_000, signal)
    if (code !== 0) throw new LiteratureError('RDKit 无法解析 OPSIN 返回的 SMILES。', 'RDKIT')
    return await readJson(out)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Normalize a PDF text window while keeping chemical punctuation. */
function flatten(text) {
  return text
    .replace(/\u00ad/g, '')
    .replace(/\r/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/([-,])\s+/g, '$1')
    .replace(/\s+([),;])/g, '$1')
    .trim()
}

function looksLikeName(value) {
  const text = String(value ?? '')
  if (text.length < 18) return false
  const markers = [
    'yl', 'acid', 'amide', 'dione', 'one', 'amine', 'ester', 'azetidin',
    'quinolin', 'carboxylate', 'propanoate', 'dioxo', 'isoindolin', 'phenyl',
    'amino', 'butyl', 'methyl',
  ]
  let score = 0
  for (const marker of markers) {
    const matches = text.match(new RegExp(marker, 'gi'))
    if (matches) score += matches.length
  }
  return score >= 2
}

function smartJoin(lines) {
  let result = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (!result) {
      result = line
      continue
    }
    if (/[-,]$/.test(result) || /^[a-z]/.test(line)) result += line
    else result += ` ${line}`
  }
  return result
}

function suffixes(value, limit = 12) {
  const text = value.trim()
  const result = []
  for (let index = 0; index < text.length && result.length < limit; index += 1) {
    if (index > 0 && !/[\s(]/.test(text[index - 1])) continue
    const candidate = text.slice(index).trim()
    if (candidate.length >= 12 && looksLikeName(candidate)) result.push(candidate)
  }
  return result.sort((left, right) => right.length - left.length).slice(0, limit)
}

/** Cut the HPLC/page text that sometimes precedes the actual name. */
function trimToNameStart(value) {
  const text = String(value ?? '').trim()
  const patterns = [
    /\((?:[0-9]+[RS],?)+\)\s*-/i,
    /\((?:E|Z)\)\s*-/i,
    /\b\d+-\(/,
    /\b(?:tert|Boc|Cbz|Fmoc)-/i,
    /\b[NOS]-[A-Z]/,
  ]
  let best = -1
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match && (best < 0 || match.index < best)) best = match.index
  }
  return best > 0 ? text.slice(best) : text
}

/** Extract candidate IUPAC names for a label such as 3a from full PDF text. */
export function nameCandidates(text, label) {
  const cleanLabel = String(label ?? '').trim().replace(/^compound\s+/i, '').replace(/^\(|\)$/g, '')
  if (!cleanLabel) return []
  const escaped = cleanLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\(\\s*${escaped}\\s*\\)`, 'gi')
  const candidates = []

  let match
  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 1800), match.index)
    const lines = before.split(/\n/).filter((line) => line.trim()).slice(-7)
    if (lines.length === 0) continue
    const joined = flatten(lines.join(' '))
    const variants = [smartJoin(lines), joined]
    for (const variant of variants) {
      const afterStop = variant.split(/\.\s+/).pop() ?? variant
      const withoutPage = afterStop.replace(/^S\d+\s+/, '').trim()
      const trimmed = trimToNameStart(withoutPage)
      for (const candidate of [trimmed, ...suffixes(trimmed, 14)]) {
        if (looksLikeName(candidate) && !candidates.includes(candidate)) candidates.push(candidate)
      }
    }
  }
  return candidates.slice(0, 12)
}

export async function opsinLookup(name, signal) {
  const url = `${OPSIN_BASE}${encodeURIComponent(name)}.json`
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-opsin-'))
  const out = path.join(tempDir, 'opsin.json')
  try {
    // Node's fetch occasionally fails to reach the EBI redirect target from
    // this machine; curl uses the same IPv4 route as the rest of the toolchain.
    const code = await runProcess(CURL, [
      '-f', '-L', '-sS', '--max-time', '60', '-o', out, url,
    ], 70_000, signal)
    if (code !== 0) throw new LiteratureError('OPSIN 返回 HTTP 错误。', 'OPSIN_HTTP')
    const data = await readJson(out)
    if (data?.status !== 'SUCCESS' || !data?.smiles) {
      throw new LiteratureError(
        `OPSIN 无法解析名称：${data?.message || '未知原因'}`,
        'OPSIN_PARSE',
      )
    }
    return {
      name,
      smiles: String(data.smiles),
      inchi: String(data.stdinchi ?? ''),
      inchiKey: String(data.stdinchikey ?? ''),
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Try candidates in order and return the first OPSIN success. */
export async function resolveName(candidates, signal) {
  const errors = []
  for (const candidate of candidates) {
    try {
      return await opsinLookup(candidate, signal)
    } catch (error) {
      errors.push(`${candidate.slice(0, 80)}：${error.message}`)
    }
  }
  throw new LiteratureError(
    `没有候选名称能被 OPSIN 唯一解析。${errors.length > 0 ? `\n${errors.slice(-3).join('\n')}` : ''}`,
    'OPSIN_NONE',
  )
}

async function fetchJson(url, signal) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal,
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function cleanTitle(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeDoi(value) {
  const text = String(value ?? '').trim()
  const match = /(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i.exec(text)
  return match ? match[1] : text
}

/** Try to obtain a PDF for a DOI; publishers may refuse, so a local path wins. */
export async function resolveSource(source, localPdf, signal) {
  if (localPdf) {
    const resolved = path.resolve(localPdf)
    await fs.access(resolved)
    const doi = normalizeDoi(source)
    let title = ''
    try {
      const metadata = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, signal)
      title = cleanTitle(metadata?.message?.title?.[0] ?? '')
    } catch {
      // A local PDF works without Crossref metadata.
    }
    return { pdfPath: resolved, doi, title, metadata: null }
  }

  if (/^https?:\/\//i.test(source) && !/^https?:\/\/(?:dx\.)?doi\.org\//i.test(source)) {
    try {
      const response = await fetch(source, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf' },
        signal,
        redirect: 'follow',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('the URL did not return a PDF')
      }
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lit-pdf-'))
      const file = path.join(tempDir, 'paper.pdf')
      await fs.writeFile(file, buffer)
      return { pdfPath: file, doi: '', title: '', metadata: null }
    } catch (error) {
      throw new LiteratureError(
        `无法下载该 PDF 链接：${error.message}。请先把 PDF 保存到本地，再用 local_pdf 传入路径。`,
        'PDF_UNAVAILABLE',
      )
    }
  }

  const direct = path.resolve(source)
  try {
    const stat = await fs.stat(direct)
    if (stat.isFile()) return { pdfPath: direct, doi: normalizeDoi(source), title: '', metadata: null }
  } catch {
    // Not a local file.
  }

  const doi = normalizeDoi(source)
  if (!/^10\.\d{4,9}\//.test(doi)) {
    throw new LiteratureError('请提供 DOI、PDF 直链或本地 PDF 路径。', 'BAD_SOURCE')
  }

  let metadata = null
  let title = ''
  try {
    metadata = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, signal)
    title = cleanTitle(metadata?.message?.title?.[0] ?? '')
  } catch {
    // Metadata is helpful but not required for extraction.
  }

  const urls = []
  if (metadata?.message?.link) {
    for (const link of metadata.message.link) {
      if (typeof link.URL === 'string' && link.URL.toLowerCase().includes('pdf')) urls.push(link.URL)
    }
  }
  try {
    const openalex = await fetchJson(`https://api.openalex.org/works/https://doi.org/${doi}`, signal)
    for (const candidate of [
      openalex?.open_access?.oa_url,
      openalex?.best_oa_location?.pdf_url,
      ...(openalex?.locations ?? []).map((location) => location?.pdf_url),
    ]) {
      if (typeof candidate === 'string' && candidate) urls.push(candidate)
    }
  } catch {
    // OpenAlex may not know the DOI.
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lit-pdf-'))
  for (const [index, url] of [...new Set(urls)].entries()) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf' },
        signal,
        redirect: 'follow',
      })
      if (!response.ok) continue
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') continue
      const file = path.join(tempDir, `paper-${index}.pdf`)
      await fs.writeFile(file, buffer)
      return { pdfPath: file, doi, title, metadata }
    } catch {
      // Try the next candidate.
    }
  }

  throw new LiteratureError(
    `无法自动下载 ${doi} 的 PDF（出版社可能限制访问）。${title ? `文献标题：${title}。` : ''}请把论文或补充材料 PDF 下载到本地，然后用 local_pdf 参数传入路径。`,
    'PDF_UNAVAILABLE',
    { doi, title },
  )
}

function findHrmsFormula(text, label) {
  const escaped = String(label ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const index = text.search(new RegExp(`\\(\\s*${escaped}\\s*\\)`))
  const window = index >= 0 ? text.slice(index, index + 2500) : text.slice(0, 5000)
  const match = /calc\.\s*for\s+([A-Z][A-Za-z0-9]*)/i.exec(window)
  return match ? match[1] : ''
}

/**
 * Full literature extraction: PDF -> IUPAC name -> OPSIN -> RDKit check.
 */
export async function runLiterature(options) {
  const python = await findPython(options.pythonPath, options.signal)
  const sourceInfo = await resolveSource(options.source, options.localPdf, options.signal)
  const text = await extractPdfText(sourceInfo.pdfPath, python, options.signal)
  const fullText = String(text.fullText ?? '')

  const label = String(options.compound ?? '').trim()
  let candidates = []
  let method = 'label'
  if (looksLikeName(label) && !/^\(?\d+[a-z]?\)?$/i.test(label)) {
    candidates = [label]
    method = 'provided-name'
  } else {
    candidates = nameCandidates(fullText, label)
  }

  if (candidates.length === 0) {
    throw new LiteratureError(
      `在文献中没有找到与“${label}”对应的 IUPAC 名称。请确认图号/化合物编号，或直接提供完整 IUPAC 名称。`,
      'NAME_NOT_FOUND',
    )
  }

  const opsin = await resolveName(candidates, options.signal)
  const rdkit = await validateSmiles(opsin.smiles, python, options.signal)
  if (opsin.inchiKey && rdkit.inchiKey && opsin.inchiKey !== rdkit.inchiKey) {
    throw new LiteratureError('OPSIN 与 RDKit 得到的 InChIKey 不一致，已拒绝生成。', 'INCHI_MISMATCH')
  }

  const hrmsFormula = findHrmsFormula(fullText, label)
  const neutralHrmsFormula = hrmsFormula.replace(/(Na|K|Li)$/i, '')
  const warnings = []
  if (neutralHrmsFormula && neutralHrmsFormula !== rdkit.formula) {
    warnings.push(`文献 HRMS 分子式为 ${hrmsFormula}，OPSIN/RDKit 得到 ${rdkit.formula}；请核对。`)
  }

  return {
    pdfPath: sourceInfo.pdfPath,
    doi: sourceInfo.doi,
    title: sourceInfo.title,
    label,
    name: opsin.name,
    method,
    smiles: opsin.smiles,
    inchiKey: opsin.inchiKey || rdkit.inchiKey,
    inchi: opsin.inchi,
    formula: rdkit.formula,
    heavyAtoms: rdkit.heavyAtoms,
    hrmsFormula,
    warnings,
    meta: {
      doi: sourceInfo.doi,
      title: sourceInfo.title,
      pdf: sourceInfo.pdfPath,
      label,
      extractedName: opsin.name,
      method,
      opsinInchiKey: opsin.inchiKey,
      rdkitInchiKey: rdkit.inchiKey,
      formula: rdkit.formula,
      hrmsFormula,
      hrmsFormulaNeutral: neutralHrmsFormula,
    },
  }
}
