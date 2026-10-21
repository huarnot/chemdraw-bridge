#!/usr/bin/env node
/**
 * Command-line harness for the same pipeline the plugin tool uses.
 *
 *   node tools/cli.mjs "50-78-2"
 *   node tools/cli.mjs aspirin --out "E:\\ds\\chemdraw" --cdx
 */

import { generateStructure } from '../index.js'

function parseArguments(argv) {
  const options = { identifier: '', outputDir: '', fileName: '', alsoCdx: false, overwrite: false, allowFuzzy: false }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out' || arg === '-o') {
      options.outputDir = argv[++index] ?? ''
    } else if (arg === '--name' || arg === '-n') {
      options.fileName = argv[++index] ?? ''
    } else if (arg === '--cdx') {
      options.alsoCdx = true
    } else if (arg === '--overwrite') {
      options.overwrite = true
    } else if (arg === '--fuzzy') {
      options.allowFuzzy = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      rest.push(arg)
    }
  }
  options.identifier = rest.join(' ').trim()
  return options
}

const options = parseArguments(process.argv.slice(2))
if (options.help || !options.identifier) {
  console.log('Usage: node tools/cli.mjs "<CAS | name | CID:number>" [--out DIR] [--name BASE] [--cdx] [--overwrite] [--fuzzy]')
  process.exit(options.help ? 0 : 2)
}

try {
  const result = await generateStructure({
    identifier: options.identifier,
    cwd: process.cwd(),
    outputDir: options.outputDir,
    fileName: options.fileName,
    alsoCdx: options.alsoCdx,
    overwrite: options.overwrite,
    allowFuzzy: options.allowFuzzy,
    timeoutMs: 120_000,
  })
  console.log(result.message)
  for (const file of result.files) {
    console.log(`${file.format.padEnd(6)} ${file.path} (${file.bytes} bytes)`)
  }
  console.log(JSON.stringify({
    cid: result.compound.cid,
    title: result.compound.title,
    cas: result.compound.cas,
    formula: result.compound.formula,
    inchiKey: result.compound.inchiKey,
    validation: result.validation,
    warnings: result.warnings,
  }, null, 2))
} catch (error) {
  console.error(`ERROR: ${error?.message ?? error}`)
  process.exit(1)
}
