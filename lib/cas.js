/**
 * CAS Registry Number helpers.
 *
 * A CAS number has the form NNNNNNN-NN-N where the last digit is a check digit:
 * the body digits are weighted 1, 2, 3 ... from right to left, summed, and the
 * sum modulo 10 must equal the check digit.
 */

const CAS_RE = /^(\d{2,7})-(\d{2})-(\d)$/

/** Parse and validate a CAS number. Returns null when the shape is wrong. */
export function parseCas(value) {
  const text = String(value ?? '').trim()
  const match = CAS_RE.exec(text)
  if (!match) return null
  const body = match[1] + match[2]
  const check = Number(match[3])
  let sum = 0
  let weight = 1
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * weight
    weight += 1
  }
  return {
    cas: text,
    valid: sum % 10 === check,
    expectedCheckDigit: sum % 10,
  }
}

/** True when the text looks like a CAS number, valid or not. */
export function looksLikeCas(value) {
  return CAS_RE.test(String(value ?? '').trim())
}

/** Return the first valid CAS number in a list of synonyms. */
export function firstValidCas(values) {
  for (const value of values) {
    const parsed = parseCas(value)
    if (parsed?.valid) return parsed.cas
  }
  return null
}

/** All distinct valid CAS numbers in a list, preserving source order. */
export function validCasNumbers(values, limit = 12) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    const parsed = parseCas(value)
    if (!parsed?.valid) continue
    if (seen.has(parsed.cas)) continue
    seen.add(parsed.cas)
    result.push(parsed.cas)
    if (result.length >= limit) break
  }
  return result
}
