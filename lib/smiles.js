/**
 * A deliberately small SMILES atom counter.
 *
 * It is not a chemistry engine. It only needs to answer one question for
 * validation: how many atoms of each element does this SMILES string describe?
 * ChemDraw's own conversion must then produce exactly those atoms.
 */

const TWO_LETTER_AROMATIC = new Set(['se', 'as'])

function normalizeSymbol(symbol) {
  if (!symbol) return ''
  if (symbol === '*') return '*'
  const lower = symbol.toLowerCase()
  if (lower === 'd') return 'H'
  if (lower === 't') return 'H'
  return symbol[0].toUpperCase() + symbol.slice(1)
}

/** Count atoms by element symbol. Implicit hydrogens are not atoms here. */
export function smilesElementCounts(smiles) {
  const text = String(smiles ?? '')
  const counts = new Map()
  const add = (symbol) => {
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1)
  }

  let index = 0
  while (index < text.length) {
    const char = text[index]

    if (char === '[') {
      let cursor = index + 1
      while (cursor < text.length && /\d/.test(text[cursor])) cursor += 1

      let symbol = ''
      if (text[cursor] === '*') {
        symbol = '*'
        cursor += 1
      } else if (/[A-Z]/.test(text[cursor] ?? '')) {
        symbol = text[cursor]
        cursor += 1
        if (/[a-z]/.test(text[cursor] ?? '')) {
          symbol += text[cursor]
          cursor += 1
        }
      } else if (/[a-z]/.test(text[cursor] ?? '')) {
        symbol = text[cursor]
        cursor += 1
        const pair = symbol + (text[cursor] ?? '')
        if (TWO_LETTER_AROMATIC.has(pair)) {
          symbol = pair
          cursor += 1
        }
      }

      if (symbol) add(normalizeSymbol(symbol))
      while (cursor < text.length && text[cursor] !== ']') cursor += 1
      index = cursor + 1
      continue
    }

    if (char === '*') {
      add('*')
      index += 1
      continue
    }

    if (/[A-Z]/.test(char)) {
      let symbol = char
      let cursor = index + 1
      const pair = char + (text[cursor] ?? '')
      if (['Cl', 'Br', 'Si', 'Se', 'As'].includes(pair)) {
        symbol = pair
        cursor += 1
      }
      add(normalizeSymbol(symbol))
      index = cursor
      continue
    }

    if ('bcnops'.includes(char)) {
      add(char.toUpperCase())
      index += 1
      continue
    }

    index += 1
  }

  return counts
}

/** Sum of all atoms that are not hydrogen isotopes. */
export function heavyAtomCount(counts) {
  let total = 0
  for (const [symbol, count] of counts) {
    if (symbol === 'H') continue
    total += count
  }
  return total
}

/** Human-readable element formula, e.g. C9H8O4, from a count map. */
export function formatElementCounts(counts) {
  const order = ['C', 'H']
  const symbols = [...counts.keys()].sort((left, right) => {
    const leftIndex = order.indexOf(left)
    const rightIndex = order.indexOf(right)
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex)
    }
    return left.localeCompare(right)
  })
  return symbols.map((symbol) => {
    const count = counts.get(symbol)
    return count === 1 ? symbol : `${symbol}${count}`
  }).join('')
}
