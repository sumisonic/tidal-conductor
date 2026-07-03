import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Either } from 'effect'
import { loadManifestFile } from '../src/conductor/manifest.js'
import { extractMarks, mergePool, type PoolEntryJson } from '../src/conductor/poolGrow.js'

// Fold the "good moments" of a rehearsal into the pool:
//   pnpm pool-add sessions/session-2026-….jsonl [manifest.json]
// Appends the marked plans (/ai/knob mark) to plans/pool.json.
// When a manifest is given, the role word (role) of each slot is stamped on the entry, so the
// entry can be mapped onto a different manifest by matching roles.

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sessionPath = process.argv[2]
if (sessionPath === undefined) {
  console.error('Usage: pnpm pool-add <session-log.jsonl> [manifest.json]')
  process.exit(1)
}
const manifestArg = process.argv[3]
const manifest = manifestArg === undefined ? null : loadManifestFile(resolve(manifestArg))
if (manifest !== null && Either.isLeft(manifest)) {
  console.error(`cannot read manifest: ${manifest.left}`)
  process.exit(1)
}

const lines = readFileSync(sessionPath, 'utf8').split('\n')
const marks = extractMarks(lines, basename(sessionPath, '.jsonl'), manifest === null ? null : manifest.right)
if (marks.length === 0) {
  console.log('no marked plans found')
  process.exit(0)
}

const poolPath = join(pkgRoot, 'plans', 'pool.json')
const existing: ReadonlyArray<PoolEntryJson> = existsSync(poolPath)
  ? (JSON.parse(readFileSync(poolPath, 'utf8')) as PoolEntryJson[])
  : []
const merged = mergePool(existing, marks)
writeFileSync(poolPath, JSON.stringify(merged, null, 2) + '\n')
console.log(`${marks.length} marks → added ${merged.length - existing.length} to the pool (total ${merged.length})`)
