/**
 * Shared "SMILES -> ChemDraw file" step.
 *
 * Both the identifier tool and the literature tool end here: ChemDraw writes
 * the file, then the CDXML is parsed and compared with the source SMILES
 * before any path is returned.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { smilesElementCounts, heavyAtomCount, formatElementCounts } from './smiles.js'
import { validateCdxml } from './cdxml.js'
import { runChemDraw, withChemDrawLock } from './chemdraw.js'
import { resolveOutputDir, sanitizeBaseName, uniquePath } from './naming.js'

async function removeQuietly(paths) {
  for (const target of paths) {
    if (!target) continue
    await fs.rm(target, { force: true }).catch(() => {})
  }
}

/**
 * @param {object} options
 * @param {string} options.smiles
 * @param {object} options.compound  identity record used for the receipt/meta
 * @param {string} [options.cwd]
 * @param {string} [options.outputDir]
 * @param {string} [options.fileName]
 * @param {boolean} [options.alsoCdx]
 * @param {boolean} [options.overwrite]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.warnings]
 * @param {object} [options.metadataExtra]
 */
export async function generateFromSmiles(options) {
  const smiles = String(options.smiles ?? '').trim()
  if (!smiles) throw new Error('SMILES 为空，无法绘制结构。')

  const expectedCounts = smilesElementCounts(smiles)
  const expectedHeavy = heavyAtomCount(expectedCounts)
  if (expectedHeavy < 1) throw new Error(`无法从 SMILES 解析出原子：${smiles}`)

  const compound = options.compound ?? {}
  const warnings = [...(options.warnings ?? [])]
  if (Number.isFinite(compound.heavyAtomCount) && compound.heavyAtomCount > 0 && compound.heavyAtomCount !== expectedHeavy) {
    warnings.push(`PubChem 的 HeavyAtomCount 为 ${compound.heavyAtomCount}，SMILES 解析为 ${expectedHeavy}；以 ChemDraw 实际输出校验为准。`)
  }
  if (compound.matchType === 'fuzzy') {
    warnings.push('名称只是 PubChem 模糊匹配，请核对结构后再使用。')
  }

  const cwd = options.cwd || process.cwd()
  const outputDir = resolveOutputDir(cwd, options.outputDir)
  await fs.mkdir(outputDir, { recursive: true })

  const title = compound.title || compound.iupacName || 'structure'
  const base = options.fileName
    ? sanitizeBaseName(options.fileName)
    : sanitizeBaseName(compound.cid ? `${title} (CID ${compound.cid})` : title)

  const overwrite = options.overwrite === true
  const cdxmlPath = await uniquePath(outputDir, base, '.cdxml', overwrite)
  const stem = path.basename(cdxmlPath, '.cdxml')
  const cdxPath = options.alsoCdx ? await uniquePath(outputDir, stem, '.cdx', overwrite) : ''

  let result
  try {
    result = await withChemDrawLock(() => runChemDraw({
      smiles,
      outCdxml: cdxmlPath,
      outCdx: cdxPath,
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
    const detail = validation.diff.length > 0 ? validation.diff.join('；') : '没有原子'
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
    source: compound.pubchemUrl ?? '',
    compound: {
      cid: compound.cid ?? 0,
      title,
      formula: compound.formula ?? '',
      molecularWeight: compound.molecularWeight ?? '',
      cas: compound.cas ?? '',
      casNumbers: compound.casNumbers ?? [],
      inchiKey: compound.inchiKey ?? '',
      smiles,
      iupacName: compound.iupacName ?? '',
      matchType: compound.matchType ?? '',
      matchedName: compound.matchedName ?? '',
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
    ...(options.metadataExtra ?? {}),
  }
  const metaPath = path.join(outputDir, `${stem}.meta.json`)
  const metaText = `${JSON.stringify(metadata, null, 2)}\n`
  await fs.writeFile(metaPath, metaText, 'utf8')

  const files = [{ path: cdxmlPath, format: 'cdxml', bytes: result.cdxmlBytes }]
  if (cdxPath) files.push({ path: cdxPath, format: 'cdx', bytes: result.cdxBytes })
  files.push({ path: metaPath, format: 'json', bytes: Buffer.byteLength(metaText) })

  return {
    ok: true,
    compound: {
      cid: compound.cid ?? 0,
      title,
      formula: compound.formula ?? '',
      molecularWeight: compound.molecularWeight ?? '',
      smiles,
      inchiKey: compound.inchiKey ?? '',
      heavyAtomCount: expectedHeavy,
      charge: Number.isFinite(compound.charge) ? compound.charge : 0,
      cas: compound.cas ?? '',
      casNumbers: compound.casNumbers ?? [],
      matchType: compound.matchType ?? '',
      matchedName: compound.matchedName ?? '',
      pubchemUrl: compound.pubchemUrl ?? '',
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
    message: [
      `已生成 ${title} 的 ChemDraw 源文件。`,
      `校验通过：${validation.actualHeavyAtoms} 个重原子，元素组成 ${formatElementCounts(expectedCounts)}。`,
    ].join(''),
  }
}
