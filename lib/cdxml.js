/**
 * Minimal CDXML reader used to verify what ChemDraw actually wrote.
 *
 * CDXML is ChemDraw's native XML format. We only need atom elements, bond
 * count, fragment count and the writing program; the file itself is produced
 * by ChemDraw, never hand-authored here.
 */

export const ELEMENT_SYMBOLS = [
  '*',
  'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
  'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca',
  'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
  'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr',
  'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn',
  'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd',
  'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb',
  'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg',
  'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th',
  'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm',
  'Md', 'No', 'Lr', 'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds',
  'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og',
]

const SYMBOL_TO_Z = new Map(ELEMENT_SYMBOLS.map((symbol, index) => [symbol, index]))

export function atomicNumber(symbol) {
  return SYMBOL_TO_Z.get(symbol) ?? null
}

function parseAttributes(source) {
  const attributes = {}
  const regex = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g
  let match
  while ((match = regex.exec(source)) !== null) {
    attributes[match[1]] = match[2]
  }
  return attributes
}

export function inspectCdxml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new Error('CDXML 文件为空。')
  }
  const root = /<CDXML\b([^>]*)>/.exec(xml)
  if (!root) throw new Error('不是有效的 CDXML：缺少 <CDXML> 根节点。')
  if (!/<\/CDXML>\s*$/i.test(xml)) {
    throw new Error('不是完整的 CDXML：文件被截断。')
  }

  const rootAttributes = parseAttributes(root[1])
  const atoms = []
  const atomRegex = /<n\b([^>]*?)(?:\/>|>)/g
  let atomMatch
  while ((atomMatch = atomRegex.exec(xml)) !== null) {
    const attributes = parseAttributes(atomMatch[1])
    const element = attributes.Element === undefined ? 6 : Number(attributes.Element)
    atoms.push({
      element: Number.isFinite(element) ? element : 6,
      symbol: ELEMENT_SYMBOLS[element] ?? '*',
    })
  }

  let bondCount = 0
  const bondRegex = /<b\b([^>]*?)(?:\/>|>)/g
  while (bondRegex.exec(xml) !== null) bondCount += 1

  let fragmentCount = 0
  const fragmentRegex = /<fragment\b/g
  while (fragmentRegex.exec(xml) !== null) fragmentCount += 1

  return {
    creationProgram: rootAttributes.CreationProgram ?? '',
    name: rootAttributes.Name ?? '',
    atoms,
    bondCount,
    fragmentCount,
  }
}

function countBySymbol(atoms) {
  const counts = new Map()
  for (const atom of atoms) {
    counts.set(atom.symbol, (counts.get(atom.symbol) ?? 0) + 1)
  }
  return counts
}

function heavyOnly(counts) {
  const result = new Map()
  for (const [symbol, count] of counts) {
    if (symbol === 'H') continue
    result.set(symbol, count)
  }
  return result
}

function diffCounts(expected, actual) {
  const diff = []
  const symbols = new Set([...expected.keys(), ...actual.keys()])
  for (const symbol of [...symbols].sort()) {
    const want = expected.get(symbol) ?? 0
    const got = actual.get(symbol) ?? 0
    if (want !== got) diff.push(`${symbol}: 期望 ${want}，实际 ${got}`)
  }
  return diff
}

/**
 * Compare the atoms in the generated CDXML with the source SMILES.
 * Hydrogen is ignored here: ChemDraw stores most hydrogens implicitly.
 */
export function validateCdxml(xml, expectedCounts) {
  const info = inspectCdxml(xml)
  const actualCounts = countBySymbol(info.atoms)
  const expectedHeavy = heavyOnly(expectedCounts)
  const actualHeavy = heavyOnly(actualCounts)
  const expectedHeavyAtoms = [...expectedHeavy.values()].reduce((sum, value) => sum + value, 0)
  const actualHeavyAtoms = [...actualHeavy.values()].reduce((sum, value) => sum + value, 0)
  const diff = diffCounts(expectedHeavy, actualHeavy)
  return {
    ok: diff.length === 0 && info.atoms.length > 0 && actualHeavyAtoms > 0 && info.fragmentCount > 0,
    expectedHeavyAtoms,
    actualHeavyAtoms,
    expectedElements: Object.fromEntries(expectedHeavy),
    actualElements: Object.fromEntries(actualHeavy),
    diff,
    bondCount: info.bondCount,
    fragmentCount: info.fragmentCount,
    creationProgram: info.creationProgram,
  }
}
