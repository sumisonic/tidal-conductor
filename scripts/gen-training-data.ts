import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Either } from 'effect'
import {
  API_DEFAULT_MODEL,
  API_KEY_ENV,
  hasApiKey,
  makeApiBrain,
  parseApiProvider,
} from '../src/conductor/brain/api.js'
import { loadManifests } from '../src/conductor/manifest.js'
import { SAFE_PATTERN_RE } from '../src/render.js'
import { hardTrainingAt, trainingAt } from '../src/training/sampler.js'
import { toRawSample, type RawSample } from '../src/training/dataset.js'
import { violatesAvoid } from '../src/conductor/vetoMemory.js'
import { casesOf, toNdjson } from './lib/ndjson-cases.js'

// Generate LoRA training data.
// Run: pnpm gen-training-data [count] [provider] [hard]   (default: 50 google)
//   hard: generate hard cases of favorites × avoid × transition — meant to be appended to the
//   regular stock (do not make the whole set hard; aim for 15–25% of the total)
//   Override the model: AI_BRAIN_MODEL=... / concurrency: AI_TRAIN_CONCURRENCY (default 4)
//   Seed: AI_TRAIN_SEED (default 1000) — generation continues from max existing id index + 1, so
//   repeated runs with the same seed append without duplicates (safe to interrupt)
//
// Pipeline: context sampler → teacher (api Brain, no deadline, 30 s) → verification filter
//           (schema double validation + manifest consistency are built into the Brain; rendering safety is here)
//           → append to training/data/raw.jsonl + regenerate the parseBP gate (cases.ndjson) over the whole stock.
// A teacher failure only drops the sample (never mix bad data into the training set — only verified samples are stock).

const count = Number.parseInt(process.argv[2] ?? '50', 10)
const provider = parseApiProvider(process.argv[3])
const hardMode = process.argv[4] === 'hard'
const model = process.env['AI_BRAIN_MODEL'] ?? API_DEFAULT_MODEL[provider]
const concurrency = Number.parseInt(process.env['AI_TRAIN_CONCURRENCY'] ?? '4', 10)
const baseSeed = Number.parseInt(process.env['AI_TRAIN_SEED'] ?? '1000', 10)
const TEACHER_TIMEOUT_MS = 30000

if (!hasApiKey(provider)) {
  console.error(`${API_KEY_ENV[provider]} is not set (see .env.example — .env is loaded automatically)`)
  process.exit(1)
}

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = join(pkgRoot, 'training', 'data')
const rawPath = join(dataDir, 'raw.jsonl')
const casesPath = join(dataDir, 'cases.ndjson')
mkdirSync(dataDir, { recursive: true })

// Ids starting with "smoke-" are test-only — mixing them into training would stop the
// "unknown layout" gate from being a generalization test. AI_TRAIN_MANIFESTS_DIR points at another directory
const manifests = loadManifests(process.env['AI_TRAIN_MANIFESTS_DIR'] ?? join(pkgRoot, 'manifests')).filter(
  (m) => !m.id.startsWith('smoke-'),
)
if (manifests.length === 0) {
  console.error('manifests/ is empty — no context to sample from')
  process.exit(1)
}

/** Collect measured desire values from sessions/*.jsonl (falls back to a synthetic distribution when absent) */
const desirePoolOf = (dir: string): ReadonlyArray<number> =>
  !existsSync(dir)
    ? []
    : readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .flatMap((f) =>
          readFileSync(join(dir, f), 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .flatMap((line) => {
              const parsed = Either.try(() => JSON.parse(line) as { desire?: unknown })
              return Either.isRight(parsed) &&
                typeof parsed.right.desire === 'number' &&
                parsed.right.desire >= 0 &&
                parsed.right.desire <= 1
                ? [parsed.right.desire]
                : []
            }),
        )

const desirePool = desirePoolOf(process.env['AI_SESSIONS_DIR'] ?? join(pkgRoot, 'sessions'))

const readRaw = (): ReadonlyArray<RawSample> =>
  !existsSync(rawPath)
    ? []
    : readFileSync(rawPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as RawSample)

// Appending resumes at "max index for the same seed + 1". A line count would miss failures and,
// after a run that had failures, retry into an index band already attempted
// (measured once: 816 rows with duplicate ids = wasted API spend. build-dataset's last-write-wins
// dedup means no quality impact, but this prevents stepping on it again)
const startIndex = readRaw().reduce((max, s) => {
  const m = new RegExp(`^s${baseSeed}-(\\d+)$`).exec(s.id)
  return m === null ? max : Math.max(max, Number.parseInt(m[1]!, 10) + 1)
}, 0)

console.log(
  `teacher = ${provider}/${model}, generating ${count} (index from ${startIndex}, concurrency ${concurrency}` +
    `${hardMode ? ', hard case mode' : ''})`,
)
console.log(
  desirePool.length > 0
    ? `desire distribution: seeded from ${desirePool.length} measured points in sessions`
    : 'desire distribution: synthetic (no sessions/*.jsonl)',
)

type GenResult = { readonly ok: true; readonly sample: RawSample } | { readonly ok: false; readonly reason: string }

const genOne = (index: number): Effect.Effect<GenResult> =>
  Effect.gen(function* () {
    // Second pass: samples with a synthetic manifest + an avoid list.
    // Third pass: "liked shapes" (liked) are mixed in as well.
    // hard mode: hard cases of favorites × avoid × transition + control examples.
    // The teacher's system prompt gets the same avoid / liked (makeApiBrain — the same path as production.
    // liked is passed as the mark of per-manifest feedback and is assembled into markBlock)
    const { ctx, avoid, liked } = (hardMode ? hardTrainingAt : trainingAt)(manifests, { desirePool }, baseSeed, index)
    const brain = makeApiBrain({
      provider,
      model,
      timeoutMs: TEACHER_TIMEOUT_MS,
      avoid,
      // Training does not use partial degradation (dropping the transition) — to keep "fill omitted"
      // out of the reference answers, violations are rejected and regenerated (strictAvoid)
      strictAvoid: true,
      ...(liked.length > 0 ? { feedback: { [ctx.manifest.id]: { veto: [], mark: liked } } } : {}),
    })
    const result = yield* Effect.either(brain.nextPlan(ctx))
    if (Either.isLeft(result)) return { ok: false, reason: `teacher failed: ${result.left.message}` } as const
    // Reject samples where the teacher ignored the list (only "compliant" examples become teaching material)
    if (violatesAvoid(result.right, avoid))
      return { ok: false, reason: 'avoid violation (teacher ignored the list)' } as const
    const sample = toRawSample({
      id: `s${baseSeed}-${index}`,
      provider,
      model,
      seed: baseSeed,
      ctx,
      avoid,
      liked,
      plan: result.right,
    })
    const unsafe = [...sample.boolPats, ...sample.notePats].filter((p) => !SAFE_PATTERN_RE.test(p))
    return unsafe.length > 0
      ? ({ ok: false, reason: `rendering safety violation: ${unsafe[0]}` } as const)
      : ({ ok: true, sample } as const)
  })

const program = Effect.forEach(
  Array.from({ length: count }, (_, i) => startIndex + i),
  (index, i) =>
    Effect.tap(genOne(index), (r) =>
      Effect.sync(() => {
        // A success is appended immediately as one line (checkpoint). If a long run dies midway,
        // what was produced so far (= API spend) is not lost and a rerun picks up where it left off.
        // Node is single-threaded, so lines never interleave
        if (r.ok) appendFileSync(rawPath, JSON.stringify(r.sample) + '\n')
        const nth = i + 1
        if (nth % 10 === 0 || nth === count)
          console.log(`  ${nth}/${count} ${r.ok ? '' : `(last failure: ${r.reason})`}`)
      }),
    ),
  { concurrency },
)

const results = await Effect.runPromise(program)
const successes = results.flatMap((r) => (r.ok ? [r.sample] : []))
const failures = results.flatMap((r) => (r.ok ? [] : [r.reason]))

// The parseBP gate is always regenerated over the whole stock (every append re-verifies everything)
const all = readRaw()
writeFileSync(
  casesPath,
  toNdjson(casesOf({ boolPats: all.flatMap((s) => s.boolPats), notePats: all.flatMap((s) => s.notePats) })),
)

console.log(`\nsucceeded ${successes.length} / failed ${failures.length} (total ${all.length} → ${rawPath})`)
if (failures.length > 0) {
  const reasons = failures.reduce<Record<string, number>>(
    (acc, r) => ({ ...acc, [r.slice(0, 80)]: (acc[r.slice(0, 80)] ?? 0) + 1 }),
    {},
  )
  Object.entries(reasons).forEach(([r, n]) => console.log(`  ${n}× ${r}`))
}
console.log(`next: haskell/check-cases.sh training/data/cases.ndjson (parseBP gate) → pnpm build-dataset`)
