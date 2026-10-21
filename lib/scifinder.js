/**
 * SciFinder export import.
 *
 * CAS SciFinder's web API is OAuth-protected and its search response points
 * back into the SciFinder web application; it does not return the result set
 * directly. The reliable, precise route is the SDF/CSV export that a logged-in
 * user downloads from SciFinder. This module reads that export and turns each
 * record into a candidate for the operator to choose.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { firstValidCas } from './cas.js'
import { fetchProperties, fetchSynonyms, lookupCids } from './pubchem.js'
import { findPython } from './literature.js'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PDF_TOOL = path.join(PACKAGE_ROOT, 'scripts', 'pdf_tool.py')

function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    // Best effort.
  }
}

function run(command, args, timeoutMs, signal) {
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
      finish(reject, new Error('操作已取消。'))
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish(reject, new Error('SciFinder 导入超时。'))
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

function casIn(value) {
  const match = /\b\d{2,7}-\d{2}-\d\b/.exec(String(value ?? ''))
  return match ? match[0] : ''
}

function parseTable(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n').filter((line) => line.trim())
  if (lines.length === 0) return []
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : null
  const rows = []
  for (const line of lines) {
    const cells = delimiter ? line.split(delimiter).map((cell) => cell.replace(/^"|"$/g, '').trim()) : line.split(/\s{2,}/).map((cell) => cell.trim())
    const cas = cells.map(casIn).find(Boolean) ?? ''
    const names = cells.filter((cell) => cell && !casIn(cell) && !/^\d+$/.test(cell) && !/^[A-Z]{1,2}$/.test(cell))
    const name = names.sort((left, right) => right.length - left.length)[0] ?? ''
    if (!cas && !name) continue
    if (/cas|registry/i.test(line) && /name|substance/i.test(line)) continue
    rows.push({ cas, name })
    if (rows.length >= 100) break
  }
  return rows
}

async function recordCandidate(record, index, query) {
  const name = record.name || record.title || `SciFinder record ${index + 1}`
  const cas = record.cas || ''
  const scored = !query
    ? 1
    : (String(query).toLowerCase() === name.toLowerCase() ? 1 : 0.9)
  return {
    id: record.cid ? `CID:${record.cid}` : `SMILES:${record.smiles}`,
    cid: Number(record.cid) || 0,
    name,
    cas,
    formula: record.formula || '',
    score: scored,
    exact: !query || scored === 1,
    sources: record.source ? [record.source] : ['SciFinder'],
    smiles: record.smiles,
    heavyAtoms: record.heavyAtoms ?? 0,
  }
}

async function readSdf(file, python, signal) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sdf-'))
  const out = path.join(tempDir, 'sdf.json')
  try {
    const code = await run(python, [PDF_TOOL, 'sdf', file, out], 120_000, signal)
    if (code !== 0) throw new Error('RDKit 无法读取这个 SDF 文件。')
    const data = await readJson(out)
    return (data.records ?? []).map((record, index) => ({
      ...record,
      source: 'SciFinder SDF',
      cid: 0,
      name: record.title || `SciFinder record ${index + 1}`,
    }))
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function resolveTableRows(rows, signal) {
  const candidates = []
  for (const row of rows) {
    try {
      const cids = await lookupCids(row.cas || row.name, signal)
      const cid = cids[0]
      if (!cid) continue
      const properties = await fetchProperties(cid, signal)
      let cas = row.cas
      if (!cas) {
        try {
          cas = firstValidCas(await fetchSynonyms(cid, signal)) ?? ''
        } catch {
          cas = ''
        }
      }
      candidates.push({
        cid,
        name: properties.title || row.name,
        cas,
        formula: properties.formula,
        smiles: properties.smiles,
        heavyAtoms: properties.heavyAtomCount,
        source: 'SciFinder export',
      })
    } catch {
      // Skip a single unreadable row.
    }
  }
  return candidates
}

/**
 * Read a SciFinder export and return candidate records.
 * SDF is preferred because it carries the authoritative structure.
 */
export async function importScifinder(options = {}) {
  const file = path.resolve(String(options.filePath ?? ''))
  const stat = await fs.stat(file).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error(`找不到 SciFinder 导出文件：${file}`)
  const ext = path.extname(file).toLowerCase()
  const python = await findPython(options.pythonPath, options.signal)

  let records
  if (ext === '.sdf' || ext === '.sd') {
    records = await readSdf(file, python, options.signal)
  } else if (['.csv', '.tsv', '.txt'].includes(ext)) {
    const text = await fs.readFile(file, 'utf8')
    records = await resolveTableRows(parseTable(text), options.signal)
  } else {
    throw new Error('暂只支持 SciFinder 导出的 SDF、CSV、TSV 或 TXT 文件。请从 SciFinder 重新导出为 SDF。')
  }

  const candidates = []
  for (const [index, record] of records.entries()) {
    if (!record.smiles) continue
    candidates.push(await recordCandidate(record, index, options.query))
    if (candidates.length >= 20) break
  }
  return candidates
}
