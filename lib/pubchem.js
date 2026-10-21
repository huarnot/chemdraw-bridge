/**
 * PubChem PUG REST client and identifier resolution.
 *
 * The resolver is intentionally strict: a CAS number must appear verbatim in
 * the candidate's synonym list, and a name must equal the title, IUPAC name or
 * one of the synonyms. If PubChem's "best match" is only fuzzy, the caller gets
 * a list of candidates instead of a silently wrong structure.
 */

import { firstValidCas, looksLikeCas, parseCas, validCasNumbers } from './cas.js'

const BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug'
const USER_AGENT = 'dsh-plugin-chemdraw-bridge/1.0 (local ChemDraw source generator)'
const REQUEST_TIMEOUT_MS = 30_000
const RETRIES = 2

export class PubChemError extends Error {
  constructor(message, code = 'PUBCHEM', details = {}) {
    super(message)
    this.name = 'PubChemError'
    this.code = code
    this.details = details
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new PubChemError('请求已取消。', 'ABORTED'))
    return
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  const onAbort = () => {
    clearTimeout(timer)
    reject(new PubChemError('请求已取消。', 'ABORTED'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
})

async function requestJson(url, signal) {
  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: combined,
      })
    } catch (error) {
      if (signal?.aborted) throw new PubChemError('请求已取消。', 'ABORTED')
      if (attempt < RETRIES) {
        await sleep(700 * (attempt + 1), signal)
        continue
      }
      throw new PubChemError(`无法连接 PubChem：${error?.message ?? error}`, 'NETWORK')
    }

    if (response.status === 404) return null

    if (response.status === 429 || response.status >= 500) {
      if (attempt < RETRIES) {
        await sleep(900 * (attempt + 1), signal)
        continue
      }
      throw new PubChemError(`PubChem 暂时不可用（HTTP ${response.status}），请稍后重试。`, 'HTTP')
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new PubChemError(
        `PubChem 返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`,
        'HTTP',
      )
    }

    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new PubChemError('PubChem 返回了无法解析的 JSON。', 'BAD_JSON')
    }
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return []
  return [value]
}

/** PubChem name lookup. Returns candidate CIDs in PubChem's ranking order. */
export async function lookupCids(identifier, signal) {
  const url = `${BASE}/compound/name/${encodeURIComponent(identifier)}/cids/JSON`
  const data = await requestJson(url, signal)
  if (!data) return []
  return asArray(data?.IdentifierList?.CID)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
}

/** Fetch the identity properties used in the receipt and in file naming. */
export async function fetchProperties(cid, signal) {
  const fields = [
    'Title',
    'MolecularFormula',
    'MolecularWeight',
    'SMILES',
    'ConnectivitySMILES',
    'InChIKey',
    'HeavyAtomCount',
    'Charge',
    'IUPACName',
  ].join(',')
  const url = `${BASE}/compound/cid/${cid}/property/${fields}/JSON`
  const data = await requestJson(url, signal)
  const properties = data?.PropertyTable?.Properties?.[0]
  if (!properties) {
    throw new PubChemError(`PubChem 没有返回 CID ${cid} 的结构属性。`, 'NO_PROPERTIES', { cid })
  }
  return {
    cid,
    title: String(properties.Title ?? '').trim(),
    formula: String(properties.MolecularFormula ?? '').trim(),
    molecularWeight: String(properties.MolecularWeight ?? '').trim(),
    smiles: String(properties.SMILES ?? properties.ConnectivitySMILES ?? '').trim(),
    connectivitySmiles: String(properties.ConnectivitySMILES ?? '').trim(),
    inchiKey: String(properties.InChIKey ?? '').trim(),
    heavyAtomCount: Number(properties.HeavyAtomCount),
    charge: Number(properties.Charge),
    iupacName: String(properties.IUPACName ?? '').trim(),
  }
}

/** All synonym strings for a CID. */
export async function fetchSynonyms(cid, signal) {
  const url = `${BASE}/compound/cid/${cid}/synonyms/JSON`
  const data = await requestJson(url, signal)
  const information = asArray(data?.InformationList?.Information)
  const result = []
  for (const entry of information) {
    for (const synonym of asArray(entry?.Synonym)) {
      if (typeof synonym === 'string' && synonym.trim()) result.push(synonym.trim())
    }
  }
  return result
}

/** Unicode- and whitespace-tolerant comparison form. */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function candidateSummary(properties) {
  return {
    cid: properties.cid,
    title: properties.title || `CID ${properties.cid}`,
    formula: properties.formula,
    molecularWeight: properties.molecularWeight,
  }
}

function finish(properties, synonyms, matchType, matchedName, preferredCas) {
  const casNumbers = validCasNumbers(synonyms)
  const cas = preferredCas ?? casNumbers[0] ?? firstValidCas(synonyms)
  return {
    cid: properties.cid,
    title: properties.title || `CID ${properties.cid}`,
    formula: properties.formula,
    molecularWeight: properties.molecularWeight,
    smiles: properties.smiles,
    connectivitySmiles: properties.connectivitySmiles,
    inchiKey: properties.inchiKey,
    iupacName: properties.iupacName,
    heavyAtomCount: Number.isFinite(properties.heavyAtomCount) ? properties.heavyAtomCount : null,
    charge: Number.isFinite(properties.charge) ? properties.charge : null,
    cas,
    casNumbers,
    matchType,
    matchedName,
    synonyms,
    pubchemUrl: `https://pubchem.ncbi.nlm.nih.gov/compound/${properties.cid}`,
  }
}

async function collectCandidate(cid, signal) {
  const properties = await fetchProperties(cid, signal)
  const synonyms = await fetchSynonyms(cid, signal)
  return { properties, synonyms }
}

/**
 * Resolve a CAS number, a compound name, or an explicit CID.
 *
 * @returns {Promise<object>} normalized compound record
 * @throws {PubChemError} with `details.candidates` when the match is ambiguous
 */
export async function resolveCompound(rawIdentifier, options = {}) {
  const identifier = String(rawIdentifier ?? '').trim()
  const signal = options.signal
  if (!identifier) throw new PubChemError('请提供 CAS 号或化合物名称。', 'EMPTY')

  // Explicit CID: "CID:2244", "cid 2244", or a bare integer.
  const explicitCid = /^cid\s*[:#]?\s*(\d+)$/i.exec(identifier)
  const bareCid = /^\d{1,12}$/.exec(identifier)
  if (explicitCid || bareCid) {
    const cid = Number(explicitCid ? explicitCid[1] : bareCid[0])
    if (!Number.isInteger(cid) || cid <= 0) {
      throw new PubChemError(`CID 无效：${identifier}`, 'BAD_CID')
    }
    const { properties, synonyms } = await collectCandidate(cid, signal)
    return finish(properties, synonyms, 'cid', `CID ${cid}`, null)
  }

  // A CAS-shaped string is never treated as a name: a typo in the check digit
  // must fail loudly instead of silently resolving to something else.
  if (looksLikeCas(identifier)) {
    const parsed = parseCas(identifier)
    if (!parsed?.valid) {
      throw new PubChemError(
        `CAS 号 ${identifier} 的校验位不正确（按规则应为 ${parsed?.expectedCheckDigit ?? '?'}），已拒绝查询。`,
        'CAS_CHECKSUM',
      )
    }

    const cids = await lookupCids(parsed.cas, signal)
    if (cids.length === 0) {
      throw new PubChemError(`PubChem 中没有找到 CAS 号 ${parsed.cas} 对应的化合物。`, 'NOT_FOUND')
    }

    const matches = []
    for (const cid of cids.slice(0, 8)) {
      try {
        const candidate = await collectCandidate(cid, signal)
        const hasCas = candidate.synonyms.some((synonym) => normalizeName(synonym) === normalizeName(parsed.cas))
        if (hasCas) matches.push(candidate)
      } catch (error) {
        if (error?.code === 'ABORTED') throw error
        // A single unreadable candidate must not hide a good one.
      }
    }

    if (matches.length === 1) {
      return finish(matches[0].properties, matches[0].synonyms, 'cas', parsed.cas, parsed.cas)
    }
    if (matches.length === 0) {
      throw new PubChemError(
        `PubChem 对 CAS 号 ${parsed.cas} 返回了 CID ${cids.join(', ')}，但它们的同义词中都没有这个 CAS 号；为避免给出错误结构，已拒绝生成。`,
        'CAS_UNCONFIRMED',
        { cids },
      )
    }
    throw new PubChemError(
      `CAS 号 ${parsed.cas} 同时对应多个 PubChem 记录（CID ${matches.map((item) => item.properties.cid).join(', ')}），无法唯一确定结构。`,
      'AMBIGUOUS_CAS',
      { candidates: matches.map((item) => candidateSummary(item.properties)) },
    )
  }

  // Name lookup.
  const cids = await lookupCids(identifier, signal)
  if (cids.length === 0) {
    const hint = /[\u3400-\u9fff]/.test(identifier)
      ? 'PubChem 的名称检索只支持英文名、IUPAC 名和同义词；中文名请改用 CAS 号。'
      : '请确认英文名或 IUPAC 名拼写，或改用 CAS 号（最可靠）。'
    throw new PubChemError(`PubChem 中没有找到名称“${identifier}”。${hint}`, 'NOT_FOUND')
  }

  const wanted = normalizeName(identifier)
  const exact = []
  const candidates = []

  for (const cid of cids.slice(0, 6)) {
    try {
      const candidate = await collectCandidate(cid, signal)
      candidates.push(candidate.properties)
      const title = normalizeName(candidate.properties.title)
      const iupac = normalizeName(candidate.properties.iupacName)
      const synonym = candidate.synonyms.some((value) => normalizeName(value) === wanted)
      if (title === wanted || iupac === wanted || synonym) {
        exact.push({
          ...candidate,
          matchType: title === wanted ? 'title' : iupac === wanted ? 'iupac' : 'synonym',
        })
      }
    } catch (error) {
      if (error?.code === 'ABORTED') throw error
    }
  }

  if (exact.length === 1) {
    const match = exact[0]
    return finish(match.properties, match.synonyms, match.matchType, identifier, null)
  }
  if (exact.length > 1) {
    throw new PubChemError(
      `名称“${identifier}”同时精确匹配多个 PubChem 记录（CID ${exact.map((item) => item.properties.cid).join(', ')}），请改用 CAS 号。`,
      'AMBIGUOUS_NAME',
      { candidates: exact.map((item) => candidateSummary(item.properties)) },
    )
  }

  if (options.allowFuzzy && candidates.length === 1) {
    return finish(candidates[0], [], 'fuzzy', identifier, null)
  }

  throw new PubChemError(
    `PubChem 对“${identifier}”只给出了模糊匹配，未找到完全相同的标题、IUPAC 名或同义词。为避免结构错误，已拒绝生成。`,
    'NAME_UNCONFIRMED',
    { candidates: candidates.map((item) => candidateSummary(item)) },
  )
}
