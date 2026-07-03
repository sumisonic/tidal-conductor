import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Either } from 'effect'
import { metricsOf, planOf, splitDataset, type RawSample } from '../src/training/dataset.js'

// raw.jsonl → train.jsonl / valid.jsonl for mlx-lm / Unsloth.
// Run: pnpm build-dataset [validRatio] [check-log]   (default: 0.05)
//   check-log: a file holding the output of the parseBP gate (haskell/check-cases.sh training/data/cases.ndjson).
//   Samples containing a pattern from a FAIL line are dropped. Omit it to drop nothing
//   (if the gate said ALL OK there is nothing to drop anyway).
//   Split seed: AI_TRAIN_SPLIT_SEED (default 7)
// Purely local, no network — can be rebuilt any number of times (raw.jsonl is the source of truth).

const validRatio = Number.parseFloat(process.argv[2] ?? '0.05')
const checkLogPath = process.argv[3]
const splitSeed = Number.parseInt(process.env['AI_TRAIN_SPLIT_SEED'] ?? '7', 10)

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = join(pkgRoot, 'training', 'data')
const rawPath = join(dataDir, 'raw.jsonl')

if (!existsSync(rawPath)) {
  console.error(`${rawPath} does not exist — run pnpm gen-training-data first`)
  process.exit(1)
}

const rawLines = readFileSync(rawPath, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as RawSample)

// Last write wins for duplicate ids (guards against accidental duplicates from append-only runs)
const samples = [...new Map(rawLines.map((s) => [s.id, s] as const)).values()]

/** Recover pattern strings from the FAIL lines of the parseBP gate output (Haskell's show ≈ a JSON string) */
const failedPatternsOf = (path: string): ReadonlySet<string> =>
  new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line) => {
        const m = /^FAIL parse \((?:Bool|Note)\): ("(?:[^"\\]|\\.)*")/.exec(line)
        if (m === null) return []
        const decoded = Either.try(() => JSON.parse(m[1]!) as string)
        return Either.isRight(decoded) ? [decoded.right] : []
      }),
  )

const failed = checkLogPath === undefined ? new Set<string>() : failedPatternsOf(checkLogPath)

const clean = samples.filter((s) => ![...s.boolPats, ...s.notePats].some((p) => failed.has(p)))
const dropped = samples.length - clean.length

// Only messages are used for training (metadata stays in raw). Rows whose plan cannot be recovered are dropped
const usable = clean.filter((s) => planOf(s) !== null)
const { train, valid } = splitDataset(usable, validRatio, splitSeed)

const asLines = (xs: ReadonlyArray<RawSample>): string =>
  xs.map((s) => JSON.stringify({ messages: s.messages }) + '\n').join('')
writeFileSync(join(dataDir, 'train.jsonl'), asLines(train))
writeFileSync(join(dataDir, 'valid.jsonl'), asLines(valid))

const metrics = metricsOf(usable)
writeFileSync(join(dataDir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n')

console.log(
  `raw ${samples.length} → train ${train.length} / valid ${valid.length}` +
    (dropped > 0 ? ` (dropped ${dropped} parseBP failures)` : ''),
)
console.log('diversity metrics (a watch on skew — details in metrics.json):')
console.log(`  pattern types: ${JSON.stringify(metrics.patternTypes)}`)
console.log(`  energy bands: ${JSON.stringify(metrics.energyBands)}`)
console.log(`  euclid steps: ${JSON.stringify(metrics.euclidSteps)}`)
console.log(`  transition rate: ${metrics.transitionRate.toFixed(2)}`)
console.log(`next: Step 4 of training/README.md (MLX LoRA training)`)
