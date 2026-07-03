import { readFileSync } from 'node:fs'
import { Effect, Either } from 'effect'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  renderPatternV1,
  renderPlan,
  renderPlanV1,
  renderPlanV1WithVocab,
  renderRhythm,
  renderSamplesNames,
} from '../src/render.js'
import { randomPlan } from '../src/generators/random.js'
import { rulesPlan } from '../src/generators/rules.js'
import { parsePhrasePlan, type PatternV1, type PhrasePlanV1, type Rhythm } from '../src/schema.js'
import { runSeeded } from '../src/rand.js'
import { offlineBrain } from '../src/conductor/brain/offline.js'
import { loadPool, makePoolBrain } from '../src/conductor/brain/pool.js'
import { loadManifestFile, type Manifest } from '../src/conductor/manifest.js'
import { renderSends } from '../src/conductor/scheduler.js'
import { casesOf, toNdjson } from './lib/ndjson-cases.js'

// Emit renderer output as NDJSON cases for the parseBP gate (haskell/ParseBPCheck.hs reads them from stdin):
//   pnpm emit-pattern-cases | haskell/check-cases.sh      (or: pnpm verify:patterns)
// With --fixtures only the small hand-picked golden set is written (haskell/fixtures/golden.ndjson,
// committed and checked by `nix flake check`); the full sweep is regenerated on every run and never committed.
// Data only — no Haskell is generated. Cases: golden edge cases, wide seed sweeps of both generators,
// the bundled pool, 200 seeds of the offline Brain (transitions, nSet, samples included), and the strings
// the real wiring writes: renderSends (missing slots filled with "~") and the pool Brain's role mapping
// onto the bundled manifests.
// Each case is checked as the Pattern type the real wiring uses: struct → Bool, nsteps → Note,
// samples (name form) → String.

const fixturesOnly = process.argv.includes('--fixtures')

const edges: readonly Rhythm[] = [
  { type: 'silence' },
  { type: 'euclid', pulses: 1, steps: 2 },
  { type: 'euclid', pulses: 16, steps: 16 },
  { type: 'euclid', pulses: 1, steps: 16, rotation: 15 },
  { type: 'euclid', pulses: 1, steps: 8, rotation: [4, 4, 4, 3] },
  { type: 'euclid', pulses: 3, steps: 8, rotation: [0, 15, 7, 1] },
  { type: 'grid', variants: [['x', '~']] },
  { type: 'grid', variants: [Array.from({ length: 32 }, (_, i) => (i % 2 ? '~' : 'x'))] },
  { type: 'grid', variants: [Array.from({ length: 16 }, () => ['x', '~', 'x', '~'] as ('x' | '~')[])] },
  {
    type: 'grid',
    variants: [
      ['x', '~', '~', '~'],
      ['~', 'x', '~', '~'],
      ['~', '~', 'x', '~'],
      ['~', '~', '~', 'x'],
    ],
  },
]

const ALL7 = ['kick', 'snare', 'hat', 'perc', 'bass', 'stab', 'noise'] as const
const ALL8 = [...ALL7, 'kick'] as const
const seeds = Array.from({ length: 300 }, (_, i) => i + 1)
const sweep = seeds.flatMap((seed) =>
  [...renderPlan(randomPlan(seed, ALL8)), ...renderPlan(rulesPlan(seed, ALL7))].map((slot) => slot.pattern),
)

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const poolPath = join(pkgRoot, 'plans', 'pool.json')
const bundledPoolPatterns = (JSON.parse(readFileSync(poolPath, 'utf8')) as ReadonlyArray<{ plan: unknown }>).flatMap(
  (entry) => renderPlan(parsePhrasePlan(entry.plan)).map((slot) => slot.pattern),
)
const poolPatterns = loadPool(poolPath).flatMap((e) => renderPlanV1(e.plan).map((s) => s.pattern))

const v1Edges: readonly PatternV1[] = [
  { type: 'nsteps', variants: [[0, '~']] },
  { type: 'nsteps', variants: [[127, 0, '~', 64]] },
  {
    type: 'nsteps',
    variants: [
      [0, 1, 2, 3],
      ['~', 7, '~', 7],
    ],
  },
]
const samplesEdges: ReadonlyArray<string> = [
  renderSamplesNames({ type: 'samples', variants: [[0, '~', 1]] }, ['bd:0', 'sn']),
  renderSamplesNames(
    {
      type: 'samples',
      variants: [
        [0, 1, '~', 3],
        ['~', 2, 2, 0],
      ],
    },
    ['bd:0', 'mt:2', 'hh:12', 'cp'],
  ),
]

const sweepManifest: Manifest = {
  id: 'sweep',
  defaultLengthCycles: 4,
  slots: [
    { slot: 1, generator: 'struct', role: 'perc' },
    { slot: 2, generator: 'struct', role: 'hat' },
    { slot: 3, generator: 'nsteps', role: 'n', nRange: [0, 15] },
    { slot: 4, generator: 'nsteps', role: 'n set', nSet: [0, 2, 7, 11] },
    { slot: 5, generator: 'samples', role: 'kit', vocab: ['bd:0', 'sn:0', 'hh:0', 'perc:1'] },
  ],
}
const generatorOf = Object.fromEntries(sweepManifest.slots.map((s) => [s.slot, s.generator]))
const sweepVocabOf = (slot: number): ReadonlyArray<string> | undefined =>
  sweepManifest.slots.find((s) => s.slot === slot)?.vocab
const brainSweepTyped = Array.from({ length: 200 }, (_, i) => i + 1).flatMap((seed) =>
  renderPlanV1WithVocab(
    runSeeded(
      seed,
      offlineBrain.nextPlan({
        manifest: sweepManifest,
        desire: (seed % 10) / 10,
        freedom: 0.5,
        lengthCycles: 4,
        lastPlan: null,
        allowTransition: true,
        activity: 0,
        history: [],
      }),
    ),
    sweepVocabOf,
  ).flatMap((s) =>
    [s.pattern, ...(s.transition === null ? [] : [s.transition])].map((p) => ({ p, kind: generatorOf[s.slot]! })),
  ),
)

// Through the real wiring: renderSends is what reaches Tidal (a slot the plan omits is written as "~"),
// and the pool Brain maps entries onto a manifest by role and fills the rest with offline generation
const kindOfKey = (manifest: Manifest, key: string): string | undefined =>
  manifest.slots.find((s) => s.slot === Number(key.split('/')[2]))?.generator
const sendsOf = (manifest: Manifest, plan: PhrasePlanV1): ReadonlyArray<{ p: string; kind: string }> =>
  renderSends(1, plan, 0, manifest).sends.flatMap((send) => {
    const kind = kindOfKey(manifest, send.key)
    return kind === undefined ? [] : [{ p: send.value, kind }]
  })
const droppedSlotCases = Array.from({ length: 20 }, (_, i) => i + 1).flatMap((seed) => {
  const plan = runSeeded(
    seed,
    offlineBrain.nextPlan({
      manifest: sweepManifest,
      desire: (seed % 10) / 10,
      freedom: 0.5,
      lengthCycles: 4,
      lastPlan: null,
      allowTransition: false,
      activity: 0,
      history: [],
    }),
  )
  return sendsOf(sweepManifest, { ...plan, slots: plan.slots.filter((slot) => slot.slot !== 2) })
})
const bundledManifests = ['example', 'smoke-kit', 'smoke-alt'].flatMap((name) => {
  const m = loadManifestFile(join(pkgRoot, 'manifests', `${name}.json`))
  return Either.isLeft(m) ? [] : [m.right]
})
// The pool Brain reports its inventory on stdout, which is the NDJSON stream here: route it to stderr meanwhile
const stdoutLog = console.log
console.log = console.error
const poolBrain = Effect.runSync(makePoolBrain([poolPath]))
const poolBrainCases = bundledManifests.flatMap((manifest) =>
  Array.from({ length: 12 }, (_, i) => i + 1).flatMap((seed) => {
    const r = runSeeded(
      seed,
      Effect.either(
        poolBrain.nextPlan({
          manifest,
          desire: (seed % 10) / 10,
          freedom: 0.5,
          lengthCycles: manifest.defaultLengthCycles,
          lastPlan: null,
          allowTransition: manifest.allowTransition ?? true,
          activity: 0,
          history: [],
        }),
      ),
    )
    return Either.isLeft(r) ? [] : sendsOf(manifest, r.right)
  }),
)
console.log = stdoutLog
const wiredCases = [...droppedSlotCases, ...poolBrainCases]
const wiredOf = (generator: string): ReadonlyArray<string> =>
  wiredCases.filter((c) => c.kind === generator).map((c) => c.p)

const cases = fixturesOnly
  ? casesOf({
      boolPats: [...edges.map(renderRhythm), ...poolPatterns],
      notePats: v1Edges.map(renderPatternV1),
      stringPats: samplesEdges,
    })
  : casesOf({
      boolPats: [
        ...edges.map(renderRhythm),
        ...sweep,
        ...bundledPoolPatterns,
        ...poolPatterns,
        ...brainSweepTyped.filter((e) => e.kind === 'struct').map((e) => e.p),
        ...wiredOf('struct'),
      ],
      notePats: [
        ...v1Edges.map(renderPatternV1),
        ...brainSweepTyped.filter((e) => e.kind === 'nsteps').map((e) => e.p),
        ...wiredOf('nsteps'),
      ],
      stringPats: [
        ...samplesEdges,
        ...brainSweepTyped.filter((e) => e.kind === 'samples').map((e) => e.p),
        ...wiredOf('samples'),
      ],
    })
// A consumer that exits early (e.g. a runner that fails to compile) closes the pipe; that is its error to report, not ours
process.stdout.on('error', (e: NodeJS.ErrnoException) => process.exit(e.code === 'EPIPE' ? 0 : 1))
process.stdout.write(toNdjson(cases))
const count = (k: string) => cases.filter((c) => c.kind === k).length
console.error(
  `emitted ${cases.length} cases (bool ${count('bool')} / note ${count('note')} / string ${count('string')})`,
)
