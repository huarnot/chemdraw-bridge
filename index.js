/**
 * ChemDraw Bridge — a DeepSeek Harness plugin.
 *
 * The user supplies a CAS number, an English/IUPAC compound name, or a compound
 * from a paper/SI PDF. The plugin resolves the structure, asks the locally
 * installed ChemDraw to draw it, and saves a native ChemDraw file (.cdxml,
 * optionally .cdx). The result is verified against the source SMILES before the
 * paths are returned.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { PubChemError, resolveCompound } from './lib/pubchem.js'
import { looksLikeCas } from './lib/cas.js'
import { smilesElementCounts, heavyAtomCount, formatElementCounts } from './lib/smiles.js'
import { validateCdxml } from './lib/cdxml.js'
import { runChemDraw, withChemDrawLock } from './lib/chemdraw.js'
import { resolveOutputDir, sanitizeBaseName, uniquePath } from './lib/naming.js'
import { generateFromSmiles } from './lib/generate.js'
import { runLiterature } from './lib/literature.js'
import { findCandidates } from './lib/search.js'
import { importScifinder } from './lib/scifinder.js'
import { recognizeImage } from './lib/vision.js'
import { drawReaction } from './lib/reaction.js'

export const name = 'chemdraw-bridge'
export const inject = ['tools']

const COMPOUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'cid', 'title', 'formula', 'molecularWeight', 'smiles', 'inchiKey',
    'heavyAtomCount', 'charge', 'cas', 'casNumbers', 'matchType', 'matchedName', 'pubchemUrl',
  ],
  properties: {
    cid: { type: 'integer' },
    title: { type: 'string' },
    formula: { type: 'string' },
    molecularWeight: { type: 'string' },
    smiles: { type: 'string' },
    inchiKey: { type: 'string' },
    heavyAtomCount: { type: 'integer' },
    charge: { type: 'integer' },
    cas: { type: 'string' },
    casNumbers: { type: 'array', items: { type: 'string' } },
    matchType: { type: 'string' },
    matchedName: { type: 'string' },
    pubchemUrl: { type: 'string' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'compound', 'files', 'validation', 'warnings', 'message'],
  properties: {
    ok: { type: 'boolean' },
    compound: COMPOUND_SCHEMA,
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'format', 'bytes'],
        properties: {
          path: { type: 'string' },
          format: { type: 'string' },
          bytes: { type: 'integer' },
        },
      },
    },
    validation: {
      type: 'object',
      additionalProperties: false,
      required: [
        'expectedHeavyAtoms', 'actualHeavyAtoms', 'elementsMatch',
        'expectedElements', 'actualElements', 'bondCount', 'fragmentCount',
        'creationProgram', 'cdxMagicOk',
      ],
      properties: {
        expectedHeavyAtoms: { type: 'integer' },
        actualHeavyAtoms: { type: 'integer' },
        elementsMatch: { type: 'boolean' },
        expectedElements: { type: 'object' },
        actualElements: { type: 'object' },
        bondCount: { type: 'integer' },
        fragmentCount: { type: 'integer' },
        creationProgram: { type: 'string' },
        cdxMagicOk: { type: 'boolean' },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
  },
}

const SEARCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['query', 'candidates', 'message'],
  properties: {
    query: { type: 'string' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cid', 'name', 'cas', 'formula', 'score', 'exact', 'sources', 'smiles'],
        properties: {
          cid: { type: 'integer' },
          name: { type: 'string' },
          cas: { type: 'string' },
          formula: { type: 'string' },
          score: { type: 'number' },
          exact: { type: 'boolean' },
          sources: { type: 'array', items: { type: 'string' } },
          smiles: { type: 'string' },
          inchiKey: { type: 'string' },
        },
      },
    },
    message: { type: 'string' },
  },
}

const REACTION_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'files', 'reaction', 'message'],
  properties: {
    ok: { type: 'boolean' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'format', 'bytes'],
        properties: {
          path: { type: 'string' },
          format: { type: 'string' },
          bytes: { type: 'integer' },
        },
      },
    },
    reaction: {
      type: 'object',
      additionalProperties: false,
      required: ['reactants', 'products', 'conditions', 'yield'],
      properties: {
        reactants: { type: 'array', items: { type: 'string' } },
        products: { type: 'array', items: { type: 'string' } },
        conditions: { type: 'string' },
        yield: { type: 'string' },
      },
    },
    message: { type: 'string' },
  },
}

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['identifier'],
  properties: {
    identifier: {
      type: 'string',
      description: 'CAS number (preferred, e.g. "50-78-2"), English/IUPAC name (e.g. "aspirin"), explicit PubChem CID (e.g. "CID:2244"), or an imported structure as "SMILES:<smiles>". Names are fuzzy-searched and may prompt the operator to choose among candidates.',
    },
    output_dir: {
      type: 'string',
      description: 'Directory for the generated files. Relative paths resolve against the session working directory; default is "<working directory>\\chemdraw".',
    },
    file_name: {
      type: 'string',
      description: 'Optional base file name without extension. Default is "<title> (CID <cid>)".',
    },
    also_cdx: {
      type: 'boolean',
      description: 'Also save the binary ChemDraw .cdx file (useful for OLE insertion into Word). Default false.',
    },
    overwrite: {
      type: 'boolean',
      description: 'Overwrite an existing file with the same name instead of adding a numeric suffix. Default false.',
    },
    auto_select: {
      type: 'boolean',
      description: 'When a name has several fuzzy matches, take the highest-scoring candidate without asking the operator. Default false.',
    },
  },
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function optionConfig(config) {
  return {
    outputDir: typeof config?.outputDir === 'string' ? config.outputDir : '',
    alsoCdx: config?.alsoCdx === true,
    timeoutMs: Number.isFinite(config?.timeoutMs) ? config.timeoutMs : 120_000,
    pythonPath: typeof config?.pythonPath === 'string' ? config.pythonPath : '',
  }
}

async function sessionWorkingDirectory(ctx, exec) {
  const service = ctx.get('workingDirectory')
  if (service && exec?.agent) {
    try {
      const directory = await service.ensure(exec.agent, exec.signal)
      if (typeof directory === 'string' && directory.trim()) return directory
    } catch {
      // Fall back to the host process directory.
    }
  }
  return process.cwd()
}

async function removeQuietly(paths) {
  for (const target of paths) {
    if (!target) continue
    await fs.rm(target, { force: true }).catch(() => {})
  }
}

function explainError(error) {
  if (error instanceof PubChemError && Array.isArray(error.details?.candidates)) {
    const candidates = error.details.candidates
      .map((candidate) => `- CID ${candidate.cid} · ${candidate.title}${candidate.formula ? ` · ${candidate.formula}` : ''}`)
      .join('\n')
    return new Error(`${error.message}\n候选记录：\n${candidates}\n请改用 CAS 号或 CID 重新生成。`)
  }
  return error
}

/** CAS and explicit CID inputs bypass fuzzy name search. */
function isNameIdentifier(value) {
  const text = String(value ?? '').trim()
  if (!text) return false
  if (/^SMILES:/i.test(text)) return false
  if (looksLikeCas(text)) return false
  if (/^cid\s*[:#]?\s*\d+$/i.test(text)) return false
  if (/^\d+$/.test(text)) return false
  return true
}

function candidateListText(candidates) {
  return candidates
    .map((candidate, index) => `${index + 1}. ${candidate.name}${candidate.cas ? ` — CAS ${candidate.cas}` : ''}${candidate.formula ? ` — ${candidate.formula}` : ''} — CID ${candidate.cid}`)
    .join('\n')
}

/**
 * Core pipeline, exported so the bundled CLI can exercise the exact same code.
 *
 * @param {object} options
 * @param {string} options.identifier
 * @param {string} [options.cwd]
 * @param {string} [options.outputDir]
 * @param {string} [options.fileName]
 * @param {boolean} [options.alsoCdx]
 * @param {boolean} [options.overwrite]
 * @param {boolean} [options.allowFuzzy]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 */
export async function generateStructure(options) {
  const identifier = String(options?.identifier ?? '').trim()
  if (!identifier) throw new Error('请提供 CAS 号或化合物名称。')

  // Structures imported from SciFinder (SDF) or other sources can be passed
  // directly without a PubChem round trip.
  if (/^SMILES:/i.test(identifier)) {
    const smiles = identifier.slice(identifier.indexOf(':') + 1).trim()
    if (!smiles) throw new Error('SMILES 为空，无法绘制结构。')
    return generateFromSmiles({
      smiles,
      compound: {
        cid: 0,
        title: options.fileName || 'structure',
        formula: '',
        molecularWeight: '',
        smiles,
        inchiKey: '',
        heavyAtomCount: 0,
        charge: 0,
        cas: '',
        casNumbers: [],
        matchType: 'smiles',
        matchedName: 'SMILES',
        pubchemUrl: '',
        iupacName: '',
      },
      cwd: options.cwd || process.cwd(),
      outputDir: options.outputDir,
      fileName: options.fileName || 'structure',
      alsoCdx: options.alsoCdx,
      overwrite: options.overwrite,
      timeoutMs: options.timeoutMs,
      pythonPath: options.pythonPath,
      signal: options.signal,
      metadataExtra: { importedFrom: 'SMILES' },
    })
  }

  let compound
  try {
    compound = await resolveCompound(identifier, {
      signal: options.signal,
      allowFuzzy: options.allowFuzzy === true,
    })
  } catch (error) {
    throw explainError(error)
  }

  if (!compound.smiles) {
    throw new Error(
      `PubChem 记录 CID ${compound.cid}（${compound.title}）没有可用的 SMILES，无法绘制结构。`,
    )
  }

  const expectedCounts = smilesElementCounts(compound.smiles)
  const expectedHeavy = heavyAtomCount(expectedCounts)
  if (expectedHeavy < 1) {
    throw new Error(`无法从 SMILES 解析出原子：${compound.smiles}`)
  }

  const warnings = []
  if (Number.isFinite(compound.heavyAtomCount) && compound.heavyAtomCount > 0 && compound.heavyAtomCount !== expectedHeavy) {
    warnings.push(
      `PubChem 的 HeavyAtomCount 为 ${compound.heavyAtomCount}，SMILES 解析为 ${expectedHeavy}；以 ChemDraw 实际输出校验为准。`,
    )
  }
  if (compound.matchType === 'fuzzy') {
    warnings.push('名称只是 PubChem 模糊匹配，请核对结构后再使用。')
  }

  const cwd = options.cwd || process.cwd()
  const outputDir = resolveOutputDir(cwd, options.outputDir)
  await fs.mkdir(outputDir, { recursive: true })

  const base = options.fileName
    ? sanitizeBaseName(options.fileName)
    : sanitizeBaseName(`${compound.title} (CID ${compound.cid})`)

  const overwrite = options.overwrite === true
  const cdxmlPath = await uniquePath(outputDir, base, '.cdxml', overwrite)
  const stem = path.basename(cdxmlPath, '.cdxml')
  const cdxPath = options.alsoCdx ? await uniquePath(outputDir, stem, '.cdx', overwrite) : ''

  let result
  try {
    result = await withChemDrawLock(() => runChemDraw({
      smiles: compound.smiles,
      outCdxml: cdxmlPath,
      outCdx: cdxPath,
      pythonPath: options.pythonPath,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    }))
  } catch (error) {
    if (process.env.DSH_CHEMDRAW_DEBUG !== '1') await removeQuietly([cdxmlPath, cdxPath])
    throw error
  }

  let validation
  try {
    const xml = await fs.readFile(cdxmlPath, 'utf8')
    validation = validateCdxml(xml, expectedCounts)
  } catch (error) {
    await removeQuietly([cdxmlPath, cdxPath])
    throw new Error(`CDXML 文件校验失败：${error.message}`)
  }

  if (!validation.ok) {
    await removeQuietly([cdxmlPath, cdxPath])
    const detail = validation.diff.length > 0
      ? validation.diff.join('；')
      : '没有原子'
    throw new Error(
      `生成的 CDXML 与源 SMILES 不一致（${detail}），已删除错误文件。请重试；若持续失败，请提供 CID 以便排查。`,
    )
  }

  if (result.atomCount > 0 && result.atomCount !== validation.actualHeavyAtoms) {
    warnings.push(`ChemDraw 文档原子数 ${result.atomCount} 与 CDXML 重原子数 ${validation.actualHeavyAtoms} 不同（可能含显式氢）。`)
  }

  const metadata = {
    generator: '@local/dsh-plugin-chemdraw-bridge',
    generatedAt: new Date().toISOString(),
    chemDrawVersion: result.version,
    layout: result.layout,
    source: compound.pubchemUrl,
    compound: {
      cid: compound.cid,
      title: compound.title,
      formula: compound.formula,
      molecularWeight: compound.molecularWeight,
      cas: compound.cas ?? '',
      casNumbers: compound.casNumbers ?? [],
      inchiKey: compound.inchiKey,
      smiles: compound.smiles,
      iupacName: compound.iupacName,
      matchType: compound.matchType,
      matchedName: compound.matchedName,
    },
    validation: {
      expectedHeavyAtoms: validation.expectedHeavyAtoms,
      actualHeavyAtoms: validation.actualHeavyAtoms,
      expectedElements: validation.expectedElements,
      actualElements: validation.actualElements,
      bondCount: validation.bondCount,
      fragmentCount: validation.fragmentCount,
    },
    warnings,
  }
  const metaPath = path.join(outputDir, `${stem}.meta.json`)
  const metaText = `${JSON.stringify(metadata, null, 2)}\n`
  await fs.writeFile(metaPath, metaText, 'utf8')

  const files = [
    { path: cdxmlPath, format: 'cdxml', bytes: result.cdxmlBytes },
  ]
  if (cdxPath) {
    files.push({ path: cdxPath, format: 'cdx', bytes: result.cdxBytes })
  }
  files.push({ path: metaPath, format: 'json', bytes: Buffer.byteLength(metaText) })

  const message = [
    `已生成 ${compound.title}（CID ${compound.cid}）的 ChemDraw 源文件。`,
    `校验通过：${validation.actualHeavyAtoms} 个重原子，元素组成 ${formatElementCounts(expectedCounts)}。`,
  ].join('')

  return {
    ok: true,
    compound: {
      cid: compound.cid,
      title: compound.title,
      formula: compound.formula,
      molecularWeight: compound.molecularWeight,
      smiles: compound.smiles,
      inchiKey: compound.inchiKey,
      heavyAtomCount: expectedHeavy,
      charge: Number.isFinite(compound.charge) ? compound.charge : 0,
      cas: compound.cas ?? '',
      casNumbers: compound.casNumbers ?? [],
      matchType: compound.matchType,
      matchedName: compound.matchedName ?? identifier,
      pubchemUrl: compound.pubchemUrl,
    },
    files,
    validation: {
      expectedHeavyAtoms: validation.expectedHeavyAtoms,
      actualHeavyAtoms: validation.actualHeavyAtoms,
      elementsMatch: validation.ok,
      expectedElements: validation.expectedElements,
      actualElements: validation.actualElements,
      bondCount: validation.bondCount,
      fragmentCount: validation.fragmentCount,
      creationProgram: validation.creationProgram,
      cdxMagicOk: cdxPath ? result.cdxMagicOk === true : false,
    },
    warnings,
    message,
  }
}

export function apply(ctx, config) {
  const defaults = optionConfig(config)

  /** Turn a fuzzy name into a chosen CID before the strict generation step. */
  async function resolveIdentifier(raw, exec, autoSelect) {
    const text = String(raw ?? '').trim()
    if (!isNameIdentifier(text)) return text

    let candidates
    try {
      candidates = await findCandidates(text, { signal: exec.signal, limit: 6 })
    } catch {
      return text
    }
    if (candidates.length === 0) return text

    const exact = candidates.filter((candidate) => candidate.exact)
    if (exact.length === 1) return `CID:${exact[0].cid}`
    if (autoSelect) return `CID:${candidates[0].cid}`

    throw new Error(
      `“${text}”找到 ${candidates.length} 个候选，需要操作者选择：\n${candidateListText(candidates)}\n请先调用 search_compounds 展示候选，让操作者选择后再用 CID:<cid> 调用 draw_from_identifier。`,
    )
  }

  ctx.tools.register({
    name: 'draw_from_identifier',
    description:
      'Generate an editable native ChemDraw source file from a compound identity. CAS numbers and CIDs are exact; a name is fuzzy-searched on PubChem (with ChemicalBook as a secondary source). When several structures match, the tool returns a candidate list and asks the caller to use search_compounds so the operator can choose; then call again with the chosen CID. The structure is drawn by the locally installed ChemDraw from its isomeric SMILES and saved as .cdxml (optionally .cdx) with atom-composition verification.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (!value?.ok) {
          return [{ type: 'text', text: value?.message ?? 'ChemDraw 文件生成失败。' }]
        }
        const lines = [
          `ChemDraw 源文件已生成：${value.compound.title}${value.compound.cid ? `（CID ${value.compound.cid}）` : ''}`,
          ...value.files.map((file) => `- ${file.path}（${formatBytes(file.bytes)}）`),
          `结构校验：${value.validation.actualHeavyAtoms}/${value.validation.expectedHeavyAtoms} 个重原子，元素组成一致；由 ${value.validation.creationProgram || 'ChemDraw'} 写入。`,
          value.compound.formula ? `分子式：${value.compound.formula}` : '',
          value.compound.cas ? `CAS：${value.compound.cas}` : '',
          value.compound.inchiKey ? `InChIKey：${value.compound.inchiKey}` : '',
          value.compound.pubchemUrl ? `PubChem：${value.compound.pubchemUrl}` : '',
          ...value.warnings.map((warning) => `注意：${warning}`),
        ]
        return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = await sessionWorkingDirectory(ctx, exec)
      const identifier = await resolveIdentifier(args?.identifier, exec, args?.auto_select === true)
      return generateStructure({
        identifier,
        cwd,
        outputDir: args?.output_dir || defaults.outputDir,
        fileName: args?.file_name,
        alsoCdx: args?.also_cdx === undefined ? defaults.alsoCdx : args.also_cdx === true,
        overwrite: args?.overwrite === true,
        allowFuzzy: false,
        pythonPath: defaults.pythonPath,
        timeoutMs: defaults.timeoutMs,
        signal: exec.signal,
      })
    },
  })

  ctx.tools.register({
    name: 'search_compounds',
    description:
      'Fuzzy-search a compound name and return ranked candidates with PubChem CID, CAS, formula, source and match score. Use this before drawing when a name may be ambiguous or misspelled; show the candidates to the operator, let them choose, then call draw_from_identifier with the chosen CID. PubChem is the primary source; ChemicalBook is used as a best-effort secondary source.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Compound name or partial name, for example "asprin", "vitamin c" or "阿司匹林".',
        },
        limit: {
          type: 'integer',
          minimum: 3,
          maximum: 8,
          description: 'Maximum number of candidates; default 6.',
        },
      },
    },
    output: {
      schema: SEARCH_OUTPUT,
      render: (_args, value) => {
        const candidates = Array.isArray(value?.candidates) ? value.candidates : []
        if (candidates.length === 0) {
          return [{ type: 'text', text: value?.message ?? '没有找到候选。' }]
        }
        const lines = [
          `“${value.query}”的候选（按匹配度排序）：`,
          ...candidates.map((candidate, index) => {
            const parts = [`${index + 1}. ${candidate.name}`]
            if (candidate.cas) parts.push(`CAS ${candidate.cas}`)
            if (candidate.formula) parts.push(candidate.formula)
            parts.push(`CID ${candidate.cid}`)
            parts.push(`${candidate.sources.join('/')}，匹配 ${Math.round(candidate.score * 100)}%`)
            return parts.join(' — ')
          }),
          '',
          '请让操作者选择编号；选中后用 CID:<cid> 调用 draw_from_identifier。',
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim()
      if (!query) throw new Error('请提供要搜索的化合物名称。')
      const limit = Number.isFinite(args?.limit) ? Math.min(8, Math.max(3, Math.round(args.limit))) : 6
      const candidates = await findCandidates(query, { signal: exec.signal, limit })
      const mapped = candidates.map((candidate) => ({
        cid: candidate.cid,
        name: candidate.name,
        cas: candidate.cas,
        formula: candidate.formula,
        score: candidate.score,
        exact: candidate.exact,
        sources: candidate.sources,
        smiles: candidate.smiles,
      }))
      return {
        query,
        candidates: mapped,
        message: mapped.length === 0
          ? `没有找到“${query}”的候选。请换一个英文名、IUPAC 名或 CAS 号。`
          : `找到 ${mapped.length} 个候选。请让操作者选择，然后用 CID:<cid> 调用 draw_from_identifier。`,
      }
    },
  })

  ctx.tools.register({
    name: 'import_scifinder',
    description:
      'Read a SciFinder export file and return its structures as candidates. SDF is preferred because it carries the authoritative structure; CSV/TSV/TXT exports with CAS numbers are also accepted. The operator chooses a candidate, then draw_from_identifier is called with SMILES:<smiles> (or CID:<cid> when PubChem resolved it). SciFinder itself has no public result API for this use, so export-and-import is the precise route.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file_path'],
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to a SciFinder export: .sdf (preferred), .csv, .tsv or .txt.',
        },
        query: {
          type: 'string',
          description: 'Optional compound name used to label/score the candidates.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Maximum candidates; default 10.',
        },
      },
    },
    output: {
      schema: SEARCH_OUTPUT,
      render: (_args, value) => {
        const candidates = Array.isArray(value?.candidates) ? value.candidates : []
        if (candidates.length === 0) {
          return [{ type: 'text', text: value?.message ?? 'SciFinder 导出中没有可读结构。' }]
        }
        const lines = [
          `SciFinder 导出中的候选（${candidates.length} 个）：`,
          ...candidates.map((candidate, index) => {
            const parts = [`${index + 1}. ${candidate.name}`]
            if (candidate.cas) parts.push(`CAS ${candidate.cas}`)
            if (candidate.formula) parts.push(candidate.formula)
            if (candidate.cid) parts.push(`CID ${candidate.cid}`)
            parts.push(candidate.sources.join('/'))
            return `${parts.join(' — ')}\n   SMILES: ${candidate.smiles}`
          }),
          '',
          '请让操作者选择；选中后优先用 SMILES:<smiles> 调用 draw_from_identifier。',
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = String(args?.file_path ?? '').trim()
      if (!filePath) throw new Error('请提供 SciFinder 导出文件路径。')
      const limit = Number.isFinite(args?.limit) ? Math.min(20, Math.max(1, Math.round(args.limit))) : 10
      const candidates = await importScifinder({
        filePath,
        pythonPath: defaults.pythonPath,
        query: args?.query,
        signal: exec.signal,
      })
      const mapped = candidates.slice(0, limit).map((candidate) => ({
        cid: candidate.cid,
        name: candidate.name,
        cas: candidate.cas,
        formula: candidate.formula,
        score: candidate.score,
        exact: candidate.exact,
        sources: candidate.sources,
        smiles: candidate.smiles,
      }))
      return {
        query: args?.query || path.basename(filePath),
        candidates: mapped,
        message: mapped.length === 0
          ? 'SciFinder 导出中没有可读结构；请确认导出为 SDF 或带 CAS 的 CSV。'
          : `读取到 ${mapped.length} 个结构。请让操作者选择，然后用 SMILES:<smiles> 调用 draw_from_identifier。`,
      }
    },
  })

  ctx.tools.register({
    name: 'recognize_image',
    description:
      'Recognize chemical structures in a figure image (or a PDF region) with OSRA, validate every SMILES with RDKit, and return candidates. Use this for compounds in a paper that have no printed IUPAC name. The result is a candidate that the operator must review; abbreviated groups (PhthN, MQ, Boc labels) and low-resolution images are expected to fail. After confirmation, draw it with draw_from_identifier(identifier="SMILES:<smiles>").',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image_path: {
          type: 'string',
          description: 'Path to a PNG/JPEG/TIFF crop of the structure. Use a tight crop for best results.',
        },
        pdf_path: {
          type: 'string',
          description: 'Path to a PDF; use with page and optional box instead of image_path.',
        },
        page: {
          type: 'integer',
          minimum: 1,
          description: 'PDF page number, 1-based. Default 1.',
        },
        box: {
          type: 'array',
          minItems: 4,
          maxItems: 4,
          items: { type: 'number' },
          description: 'Optional PDF crop box [x0,y0,x1,y1] in PDF points.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
          description: 'Maximum candidates; default 5.',
        },
      },
    },
    output: {
      schema: SEARCH_OUTPUT,
      render: (_args, value) => {
        const candidates = Array.isArray(value?.candidates) ? value.candidates : []
        if (candidates.length === 0) {
          return [{ type: 'text', text: value?.message ?? '没有识别出结构。' }]
        }
        const lines = [
          `图像识别候选（${candidates.length} 个，必须人工核对）：`,
          ...candidates.map((candidate, index) => `${index + 1}. ${candidate.formula} — ${candidate.smiles}`),
          '',
          '确认后用 draw_from_identifier(identifier="SMILES:<smiles>") 生成 ChemDraw。',
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const imagePath = String(args?.image_path ?? '').trim()
      const pdfPath = String(args?.pdf_path ?? '').trim()
      if (!imagePath && !pdfPath) throw new Error('请提供 image_path，或 pdf_path + page + box。')
      const limit = Number.isFinite(args?.limit) ? Math.min(8, Math.max(1, Math.round(args.limit))) : 5
      const candidates = await recognizeImage({
        imagePath: imagePath || undefined,
        pdfPath: pdfPath || undefined,
        page: Number.isFinite(args?.page) ? Math.round(args.page) : 1,
        box: Array.isArray(args?.box) ? args.box : undefined,
        pythonPath: defaults.pythonPath,
        signal: exec.signal,
      })
      const mapped = candidates.slice(0, limit).map((candidate) => ({
        cid: candidate.cid,
        name: candidate.name,
        cas: candidate.cas,
        formula: candidate.formula,
        score: candidate.score,
        exact: candidate.exact,
        sources: candidate.sources,
        smiles: candidate.smiles,
        inchiKey: candidate.inchiKey ?? '',
      }))
      return {
        query: imagePath ? path.basename(imagePath) : `${path.basename(pdfPath)} p.${args?.page ?? 1}`,
        candidates: mapped,
        message: mapped.length === 0
          ? '没有识别出结构；请换一张更紧、更高分辨率的裁剪图。'
          : `识别出 ${mapped.length} 个候选。请人工核对，再用 SMILES:<smiles> 生成。`,
      }
    },
  })

  ctx.tools.register({
    name: 'draw_reaction',
    description:
      'Draft a one-step ChemDraw reaction scheme from SMILES: places reactants and products, inserts a reaction arrow, conditions and optional yield, and saves .cdxml (optionally .cdx). This is a layout draft; stoichiometry and conditions still require a human check. Use recognize_image or known SMILES for the structures.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['reactants', 'products'],
      properties: {
        reactants: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: { type: 'string' },
          description: 'Reactant SMILES, left to right.',
        },
        products: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: { type: 'string' },
          description: 'Product SMILES, left to right.',
        },
        conditions: {
          type: 'string',
          description: 'Text above the arrow, for example "Pd(OAc)2, AgBF4, dioxane, 80 °C".',
        },
        yield_text: {
          type: 'string',
          description: 'Optional text below the arrow, for example "82% yield".',
        },
        name: {
          type: 'string',
          description: 'Base file name; default "reaction".',
        },
        output_dir: {
          type: 'string',
          description: 'Output directory; default "<working directory>\\chemdraw".',
        },
        also_cdx: {
          type: 'boolean',
          description: 'Also save the binary .cdx. Default false.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite instead of adding a numeric suffix.',
        },
      },
    },
    output: {
      schema: REACTION_OUTPUT,
      render: (_args, value) => {
        const lines = [
          `反应式草稿已生成：${value.reaction.reactants.length} 个反应物 → ${value.reaction.products.length} 个产物`,
          ...value.files.map((file) => `- ${file.path}（${file.format}，${formatBytes(file.bytes)}）`),
          value.reaction.conditions ? `条件：${value.reaction.conditions}` : '',
          value.reaction.yield ? `收率：${value.reaction.yield}` : '',
          '注意：这是排版草稿，请核对箭头方向、条件、化学计量和产物。',
        ]
        return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = await sessionWorkingDirectory(ctx, exec)
      return drawReaction({
        reactants: args?.reactants,
        products: args?.products,
        conditions: args?.conditions,
        yieldText: args?.yield_text,
        name: args?.name,
        cwd,
        outputDir: args?.output_dir || defaults.outputDir,
        alsoCdx: args?.also_cdx === undefined ? defaults.alsoCdx : args.also_cdx === true,
        overwrite: args?.overwrite === true,
        pythonPath: defaults.pythonPath,
        signal: exec.signal,
      })
    },
  })

  ctx.tools.register({
    name: 'draw_from_paper',
    description:
      'Extract a compound structure from a paper or its supporting information and write a native ChemDraw source file. Finds the compound label (for example 3a) in the PDF text, recovers its IUPAC name, resolves that name with the OPSIN name-to-structure service, independently verifies formula and InChIKey with RDKit, then draws the result with the locally installed ChemDraw. Use local_pdf when the publisher blocks DOI download. It refuses to guess when no unambiguous IUPAC name is present.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'compound'],
      properties: {
        source: {
          type: 'string',
          description: 'DOI (for example "10.1039/c7cc02426f"), a direct PDF URL, or a local PDF path.',
        },
        compound: {
          type: 'string',
          description: 'Compound label as printed (for example "3a" or "compound 7"), a full IUPAC name, or a known name/CAS.',
        },
        local_pdf: {
          type: 'string',
          description: 'Optional path to a locally downloaded paper/SI PDF. Used first; needed when the DOI PDF is paywalled or blocked.',
        },
        output_dir: {
          type: 'string',
          description: 'Directory for generated files. Defaults to "<working directory>\\chemdraw".',
        },
        file_name: {
          type: 'string',
          description: 'Optional base file name; defaults to the compound label.',
        },
        also_cdx: {
          type: 'boolean',
          description: 'Also save the binary .cdx file. Default false.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite an existing file instead of adding a numeric suffix.',
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (!value?.ok) {
          return [{ type: 'text', text: value?.message ?? '文献结构提取失败。' }]
        }
        const lines = [
          `ChemDraw 源文件已生成：${value.compound.title}${value.compound.cid ? `（CID ${value.compound.cid}）` : ''}`,
          ...value.files.map((file) => `- ${file.path}（${formatBytes(file.bytes)}）`),
          value.compound.matchedName ? `文献名称：${value.compound.matchedName}` : '',
          `结构校验：${value.validation.actualHeavyAtoms}/${value.validation.expectedHeavyAtoms} 个重原子，元素组成一致；由 ${value.validation.creationProgram || 'ChemDraw'} 写入。`,
          value.compound.formula ? `分子式：${value.compound.formula}` : '',
          value.compound.inchiKey ? `InChIKey：${value.compound.inchiKey}` : '',
          value.compound.pubchemUrl ? `文献：${value.compound.pubchemUrl}` : '',
          ...value.warnings.map((warning) => `注意：${warning}`),
        ]
        return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = await sessionWorkingDirectory(ctx, exec)
      const literature = await runLiterature({
        source: args?.source,
        localPdf: args?.local_pdf,
        compound: args?.compound,
        pythonPath: defaults.pythonPath,
        signal: exec.signal,
      })

      const result = await generateFromSmiles({
        smiles: literature.smiles,
        pythonPath: defaults.pythonPath,
        compound: {
          cid: 0,
          title: literature.label || literature.name,
          formula: literature.formula,
          molecularWeight: '',
          smiles: literature.smiles,
          inchiKey: literature.inchiKey,
          heavyAtomCount: literature.heavyAtoms,
          charge: 0,
          cas: '',
          casNumbers: [],
          matchType: 'literature',
          matchedName: literature.name,
          pubchemUrl: literature.doi ? `https://doi.org/${literature.doi}` : '',
          iupacName: literature.name,
        },
        cwd,
        outputDir: args?.output_dir || defaults.outputDir,
        fileName: args?.file_name || literature.label,
        alsoCdx: args?.also_cdx === undefined ? defaults.alsoCdx : args.also_cdx === true,
        overwrite: args?.overwrite === true,
        timeoutMs: defaults.timeoutMs,
        signal: exec.signal,
        warnings: literature.warnings,
        metadataExtra: { literature: literature.meta },
      })
      result.message = `已从文献提取 ${literature.label}（${literature.name}）的结构。${result.message}`
      return result
    },
  })
}
