import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Either } from 'effect'
import {
  API_DEFAULT_MODEL,
  API_KEY_ENV,
  hasApiKey,
  makeApiBrain,
  parseApiProvider,
} from '../src/conductor/brain/api.js'
import { LOCAL_DEFAULT_URL, makeLocalBrain } from '../src/conductor/brain/local.js'
import type { BrainContext } from '../src/conductor/brain/types.js'
import { HISTORY_LEN, phraseRecord, type PhraseRecord } from '../src/conductor/history.js'
import { loadManifestFile } from '../src/conductor/manifest.js'
import { violatesAvoid } from '../src/conductor/vetoMemory.js'
import { renderPlanV1, renderPlanV1WithVocab, SAFE_PATTERN_RE, SAFE_SAMPLES_PATTERN_RE } from '../src/render.js'
import type { PhrasePlanV1 } from '../src/schema.js'
import { casesOf, toNdjson } from './lib/ndjson-cases.js'

// Connectivity smoke test + latency measurement for the api/local Brain.
// Run: pnpm api-smoke [provider|local] [rounds]   (default: google 5)
//   Override the model: AI_BRAIN_MODEL=gemini-2.5-flash-lite pnpm api-smoke google 3
//   local: AI_LOCAL_MODEL=<model> pnpm api-smoke local 5 (needs `ollama serve`; the model name is required)
//   Target manifest: AI_SMOKE_MANIFEST=<path> (default manifests/example.json)
// Each round generates one plan (passing the previous round's plan as lastPlan, so continuity is
// exercised too), checks schema validation (the Brain's built-in double validation) + rendering
// safety, and compares latency against the production deadline of 4.5 s. All patterns are written
// to ghci/api-smoke.ndjson; run
//   haskell/check-cases.sh ghci/api-smoke.ndjson  (needs GHC with the tidal package)
// to push them through the real parseBP (the smoke's parseBP check).
// The smoke itself is not cut off at the deadline (to measure raw latency the cap is 15 s / 90 s for local).

// Production default deadline (lead 5000 − send-ahead 375 − margin 125)
const DEADLINE_MS = 4500
const DESIRES = [0.3, 0.5, 0.7, 0.4, 0.8] as const

const isLocal = process.argv[2] === 'local'
const SMOKE_TIMEOUT_MS = isLocal ? 90000 : 15000
const provider = parseApiProvider(process.argv[2])
const rounds = Number.parseInt(process.argv[3] ?? '5', 10)
const localUrl = process.env['AI_LOCAL_URL'] ?? LOCAL_DEFAULT_URL
const model = isLocal
  ? (process.env['AI_LOCAL_MODEL'] ?? '')
  : (process.env['AI_BRAIN_MODEL'] ?? API_DEFAULT_MODEL[provider])

if (isLocal && model === '') {
  console.error('local requires AI_LOCAL_MODEL (the Ollama model name)')
  process.exit(1)
}
if (!isLocal && !hasApiKey(provider)) {
  console.error(`${API_KEY_ENV[provider]} is not set (see .env.example — .env is loaded automatically)`)
  process.exit(1)
}

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
// AI_SMOKE_MANIFEST switches the target manifest (placement-generalization test: a slot layout that
// differs from the current one reveals whether the model has memorized "slot number → type")
const manifestPath = resolve(process.env['AI_SMOKE_MANIFEST'] ?? join(pkgRoot, 'manifests', 'example.json'))
const manifestResult = loadManifestFile(manifestPath)
if (Either.isLeft(manifestResult)) {
  console.error(`cannot read manifest: ${manifestResult.left}`)
  process.exit(1)
}
const manifest = manifestResult.right
// AI_SMOKE_AVOID: veto-compliance test. A ";"-separated list of patterns is injected into the
// system prompt as "shapes to avoid" and violations are counted per round (";" because patterns contain ",")
const smokeAvoid = (process.env['AI_SMOKE_AVOID'] ?? '')
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s !== '')

const ctxFor = (i: number, lastPlan: PhrasePlanV1 | null, history: ReadonlyArray<PhraseRecord>): BrainContext => ({
  manifest,
  desire: DESIRES[i % DESIRES.length]!,
  freedom: 0.5,
  lengthCycles: 4,
  lastPlan,
  allowTransition: manifest.allowTransition ?? true,
  activity: 0.2,
  history,
})

const brain = isLocal
  ? makeLocalBrain({
      baseUrl: localUrl,
      model,
      timeoutMs: SMOKE_TIMEOUT_MS,
      avoid: smokeAvoid,
    })
  : makeApiBrain({
      provider,
      model,
      timeoutMs: SMOKE_TIMEOUT_MS,
      avoid: smokeAvoid,
    })

interface Round {
  readonly n: number
  readonly desire: number
  readonly ms: number
  readonly plan: PhrasePlanV1 | null
  readonly error: string | null
}

/**
 * Turn successful rounds into history (so the smoke also exercises the in-context adaptation prompt path).
 * The first one gets a pseudo mark, so the measurement includes a generation context with feedback
 */
const historyOf = (rounds: ReadonlyArray<Round>): ReadonlyArray<PhraseRecord> =>
  rounds
    .flatMap((r) => (r.plan === null ? [] : [{ n: r.n, desire: r.desire, plan: r.plan }]))
    .map((r, idx) => ({
      ...phraseRecord({
        atCycle: r.n * 4,
        desire: r.desire,
        usedMode: 'api',
        plan: r.plan,
      }),
      feedback: idx === 0 ? ('mark' as const) : null,
    }))
    .slice(-HISTORY_LEN)

const runRound = (
  i: number,
  lastPlan: PhrasePlanV1 | null,
  history: ReadonlyArray<PhraseRecord>,
): Effect.Effect<Round> =>
  Effect.gen(function* () {
    const desire = DESIRES[i % DESIRES.length]!
    const t0 = performance.now()
    const result = yield* Effect.either(brain.nextPlan(ctxFor(i, lastPlan, history)))
    const ms = Math.round(performance.now() - t0)
    return Either.match(result, {
      onLeft: (e): Round => ({ n: i + 1, desire, ms, plan: null, error: e.message }),
      onRight: (plan): Round => ({ n: i + 1, desire, ms, plan, error: null }),
    })
  })

const showRound = (r: Round): string =>
  r.plan === null
    ? `round ${r.n}: FAIL ${r.ms}ms — ${r.error}`
    : [
        `round ${r.n}: OK ${r.ms}ms (desire ${r.desire} → energy ${r.plan.energy})`,
        ...renderPlanV1(r.plan).map(
          (s) => `    slot ${s.slot}: ${s.pattern}${s.transition === null ? '' : `  [trans: ${s.transition}]`}`,
        ),
      ].join('\n')

console.log(
  `api-smoke: ${isLocal ? `local(${localUrl})` : `provider=${provider}`} model=${model} rounds=${rounds}` +
    ` (production deadline ${DEADLINE_MS}ms / smoke cap ${SMOKE_TIMEOUT_MS}ms)` +
    ` manifest=${manifest.id}` +
    (smokeAvoid.length > 0 ? ` avoid=${smokeAvoid.length}` : ''),
)

const results = await Effect.runPromise(
  Effect.reduce(
    Array.from({ length: rounds }, (_, i) => i),
    [] as ReadonlyArray<Round>,
    (acc, i) =>
      Effect.map(runRound(i, [...acc].reverse().find((r) => r.plan !== null)?.plan ?? null, historyOf(acc)), (r) => {
        console.log(showRound(r))
        return [...acc, r]
      }),
  ),
)

// Rendering safety + parseBP harness output.
// samples slots are checked in two forms: the index form (LLM output — SAFE_PATTERN_RE) and
// the name form (the actual wired string after vocab substitution — SAFE_SAMPLES_PATTERN_RE + Pattern String)
const generatorOf = Object.fromEntries(manifest.slots.map((s) => [s.slot, s.generator]))
const vocabOf = (slot: number): ReadonlyArray<string> | undefined => manifest.slots.find((s) => s.slot === slot)?.vocab
const plans = results.flatMap((r) => (r.plan === null ? [] : [r.plan]))
const typed = plans.flatMap((plan) =>
  renderPlanV1(plan).flatMap((s) =>
    [s.pattern, ...(s.transition === null ? [] : [s.transition])].map((p) => ({ p, kind: generatorOf[s.slot]! })),
  ),
)
const namedSamples = plans.flatMap((plan) =>
  renderPlanV1WithVocab(plan, vocabOf).flatMap((s) =>
    generatorOf[s.slot] === 'samples' ? [s.pattern, ...(s.transition === null ? [] : [s.transition])] : [],
  ),
)
const unsafe = [
  ...typed.filter((e) => !SAFE_PATTERN_RE.test(e.p)).map((e) => e.p),
  ...namedSamples.filter((p) => !SAFE_SAMPLES_PATTERN_RE.test(p)),
]
unsafe.forEach((p) => console.error(`UNSAFE pattern: ${JSON.stringify(p)}`))

const outDir = join(pkgRoot, 'ghci')
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'api-smoke.ndjson'),
  toNdjson(
    casesOf({
      boolPats: typed.filter((e) => e.kind === 'struct').map((e) => e.p),
      notePats: typed.filter((e) => e.kind === 'nsteps').map((e) => e.p),
      stringPats: namedSamples,
    }),
  ),
)

// Latency stats (successful rounds only) and deadline check
const lats = results
  .filter((r) => r.plan !== null)
  .map((r) => r.ms)
  .sort((a, b) => a - b)
const within = lats.filter((ms) => ms <= DEADLINE_MS).length
const stats =
  lats.length === 0
    ? 'no successful rounds'
    : `min ${lats[0]}ms / median ${lats[Math.floor(lats.length / 2)]}ms / max ${lats[lats.length - 1]}ms — within the ${DEADLINE_MS}ms deadline: ${within}/${lats.length}`

console.log('')
console.log(`latency: ${stats}`)
if (smokeAvoid.length > 0) {
  // veto-compliance verdict: 0–1 violations per run is the passing line
  const violations = results.filter((r) => r.plan !== null && violatesAvoid(r.plan, smokeAvoid))
  console.log(
    `avoid compliance: ${violations.length}/${lats.length} violations` +
      (violations.length > 0 ? ` (round ${violations.map((r) => r.n).join(', ')})` : ' — all rounds compliant'),
  )
}
console.log(`wrote ${typed.length} patterns (unsafe ${unsafe.length}) to ghci/api-smoke.ndjson`)
console.log('parseBP check: haskell/check-cases.sh ghci/api-smoke.ndjson')

process.exit(results.every((r) => r.plan !== null) && unsafe.length === 0 ? 0 : 1)
