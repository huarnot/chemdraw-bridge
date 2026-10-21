/**
 * Fuzzy compound search for the selection workflow.
 *
 * PubChem's autocomplete supplies chemically meaningful name suggestions; each
 * term is resolved to a CID and scored against the query. ChemicalBook is used
 * as a secondary, best-effort source because it has no public API. The caller
 * shows the candidates to the operator and only then draws the chosen CID.
 */

import { firstValidCas } from './cas.js'
import { fetchProperties, fetchSynonyms, lookupCids, normalizeName } from './pubchem.js'

const USER_AGENT = 'dsh-plugin-chemdraw-bridge/1.0 (fuzzy compound search)'
const PUBCHEM_AUTOCOMPLETE = 'https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound'
const CHEMICALBOOK_SEARCH = 'https://www.chemicalbook.com/Search_EN.aspx'

function stripTags(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function queryForm(value) {
  return normalizeName(value)
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function levenshtein(left, right) {
  if (left === right) return 0
  if (!left) return right.length
  if (!right) return left.length
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      const saved = previous[j]
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      )
      diagonal = saved
    }
  }
  return previous[right.length]
}

function ratio(left, right) {
  if (!left || !right) return 0
  return 1 - levenshtein(left, right) / Math.max(left.length, right.length)
}

function similarity(query, candidate) {
  const q = queryForm(query)
  const value = queryForm(candidate)
  if (!q || !value) return 0
  if (q === value) return 1
  if (value.startsWith(q) || q.startsWith(value)) return 0.94
  if (value.includes(q) || q.includes(value)) {
    const coverage = Math.min(q.length, value.length) / Math.max(q.length, value.length)
    if (coverage >= 0.75) return 0.88
  }
  const tokensA = new Set(q.split(' '))
  const tokensB = new Set(value.split(' '))
  let overlap = 0
  for (const token of tokensA) if (tokensB.has(token)) overlap += 1
  const jaccard = overlap / Math.max(tokensA.size, tokensB.size)
  return Math.max(0.5 + 0.5 * ratio(q, value), 0.55 + 0.35 * jaccard)
}

function candidateScore(query, term, properties) {
  const values = [term, properties.title, properties.iupacName].filter(Boolean)
  let best = 0
  let exact = false
  for (const value of values) {
    const score = similarity(query, value)
    if (queryForm(value) === queryForm(query)) exact = true
    if (score > best) best = score
  }
  return { score: Math.min(1, best), exact }
}

async function fetchJson(url, signal, timeoutMs = 20_000) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function fetchText(url, signal, timeoutMs = 20_000) {
  const response = await fetch(url, {
    headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

/** PubChem autocomplete terms for a partial or misspelled name. */
export async function pubchemTerms(query, signal) {
  const url = `${PUBCHEM_AUTOCOMPLETE}/${encodeURIComponent(query)}/json?limit=10`
  const data = await fetchJson(url, signal)
  const terms = data?.dictionary_terms?.compound
  return Array.isArray(terms) ? terms.filter((term) => typeof term === 'string' && term.trim()) : []
}

async function resolveTerm(term, query, source, signal, cache) {
  const key = `${source}:${term.toLowerCase()}`
  if (cache.has(key)) return cache.get(key)
  const promise = (async () => {
    const cids = await lookupCids(term, signal)
    const cid = cids[0]
    if (!cid) return null
    const properties = await fetchProperties(cid, signal)
    if (!properties.smiles) return null
    let cas = ''
    try {
      const synonyms = await fetchSynonyms(cid, signal)
      cas = firstValidCas(synonyms) ?? ''
    } catch {
      // CAS is helpful but not essential for selection.
    }
    const scored = candidateScore(query, term, properties)
    return {
      id: `CID:${cid}`,
      cid,
      name: properties.title || term,
      matchedName: term,
      cas,
      formula: properties.formula,
      molecularWeight: properties.molecularWeight,
      inchiKey: properties.inchiKey,
      smiles: properties.smiles,
      heavyAtomCount: properties.heavyAtomCount,
      charge: properties.charge,
      source,
      sources: [source],
      score: scored.score,
      exact: scored.exact,
    }
  })()
  cache.set(key, promise)
  return promise
}

function mergeCandidates(candidates) {
  const byCid = new Map()
  for (const candidate of candidates) {
    if (!candidate) continue
    const existing = byCid.get(candidate.cid)
    if (!existing) {
      byCid.set(candidate.cid, candidate)
      continue
    }
    existing.score = Math.max(existing.score, candidate.score)
    existing.exact = existing.exact || candidate.exact
    for (const source of candidate.sources) {
      if (!existing.sources.includes(source)) existing.sources.push(source)
    }
    if (!existing.cas && candidate.cas) existing.cas = candidate.cas
  }
  return [...byCid.values()].sort((left, right) => {
    if (left.exact !== right.exact) return left.exact ? -1 : 1
    return right.score - left.score
  })
}

/** Best-effort ChemicalBook search. The page has no API; failures are ignored. */
export async function chemicalBookCandidates(query, signal, limit = 5) {
  const url = `${CHEMICALBOOK_SEARCH}?keyword=${encodeURIComponent(query)}`
  let html
  try {
    html = await fetchText(url, signal, 20_000)
  } catch {
    return []
  }

  const blocks = html.split('CBNumber:').slice(1, limit + 1)
  const entries = []
  for (const block of blocks) {
    const nameMatch = /Chemical Name:[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!nameMatch) continue
    const name = stripTags(nameMatch[1])
    if (!name) continue
    const casMatch = /CAS\s*(?:No\.?|Registry Number)[\s\S]{0,160}?(\d{2,7}-\d{2}-\d)/i.exec(block)
    entries.push({ name, cas: casMatch ? casMatch[1] : '' })
  }

  const cache = new Map()
  const results = []
  for (const entry of entries.slice(0, limit)) {
    try {
      const term = entry.cas || entry.name
      const candidate = await resolveTerm(term, query, 'ChemicalBook', signal, cache)
      if (candidate) results.push(candidate)
    } catch {
      // Skip a single unreadable result.
    }
  }
  return mergeCandidates(results)
}

/**
 * Find candidates for a name. Exact PubChem matches return a single candidate;
 * otherwise the result is a ranked selection list.
 */
export async function findCandidates(query, options = {}) {
  const text = String(query ?? '').trim()
  if (!text) return []
  const limit = Math.min(8, Math.max(3, options.limit ?? 6))
  const signal = options.signal
  const cache = new Map()
  const candidates = []

  const terms = await pubchemTerms(text, signal)
  for (const term of [text, ...terms].slice(0, 6)) {
    try {
      const candidate = await resolveTerm(term, text, 'PubChem', signal, cache)
      if (candidate) candidates.push(candidate)
    } catch {
      // Skip a term that cannot be resolved.
    }
  }

  const merged = mergeCandidates(candidates)
  const exact = merged.filter((candidate) => candidate.exact)
  if (exact.length > 0) return exact.slice(0, limit)

  // PubChem autocomplete is prefix-based; probing a few shorter prefixes also
  // catches common typos such as "caffiene" -> "caffeine".
  if (!text.includes(' ') && text.length >= 6) {
    const lengths = [...new Set([text.length - 1, text.length - 2, text.length - 3])]
      .filter((length) => length >= 4 && length < text.length)
    const prefixTerms = []
    for (const length of lengths.slice(0, 3)) {
      try {
        prefixTerms.push(...await pubchemTerms(text.slice(0, length), signal))
      } catch {
        // A failed prefix probe is not fatal.
      }
    }
    for (const term of [...new Set(prefixTerms)].slice(0, 4)) {
      try {
        const candidate = await resolveTerm(term, text, 'PubChem', signal, cache)
        if (candidate) candidates.push(candidate)
      } catch {
        // Skip a term that cannot be resolved.
      }
    }
  }

  const fuzzyMerged = mergeCandidates(candidates)
  const chemicalBook = await chemicalBookCandidates(text, signal, 4)
  const final = mergeCandidates([...fuzzyMerged, ...chemicalBook])
  const top = final[0]?.score ?? 0
  const floor = Math.max(0.45, top >= 0.8 ? top - 0.16 : top - 0.1)
  return final.filter((candidate) => candidate.score >= floor).slice(0, limit)
}
