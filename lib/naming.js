import fs from 'node:fs/promises'
import path from 'node:path'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Make a title safe as a Windows file name without destroying readability. */
export function sanitizeBaseName(value) {
  let name = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
  if (!name) name = 'structure'
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`
  return name
}

/** Resolve an output directory against the session working directory. */
export function resolveOutputDir(cwd, requested) {
  if (typeof requested === 'string' && requested.trim()) {
    return path.isAbsolute(requested.trim()) ? requested.trim() : path.resolve(cwd, requested.trim())
  }
  return path.join(cwd, 'chemdraw')
}

/** Pick a path that does not overwrite an existing file unless asked to. */
export async function uniquePath(directory, base, extension, overwrite = false) {
  const cleanBase = sanitizeBaseName(base)
  const first = path.join(directory, `${cleanBase}${extension}`)
  if (overwrite) return first
  let candidate = first
  for (let index = 2; index < 1000; index += 1) {
    try {
      await fs.access(candidate)
      candidate = path.join(directory, `${cleanBase} (${index})${extension}`)
    } catch {
      return candidate
    }
  }
  return path.join(directory, `${cleanBase} (${Date.now()})${extension}`)
}
