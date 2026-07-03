import { Effect } from 'effect'
import type { BrainContext } from '../conductor/brain/types.js'
import { HISTORY_LEN, phraseRecord, type Feedback, type PhraseRecord } from '../conductor/history.js'
import type { Manifest, SlotSpec } from '../conductor/manifest.js'
import { chance, pick, randInt, runSeeded, uniform } from '../rand.js'
import { renderPatternV1 } from '../render.js'
import type { PatternV1, PhrasePlanV1 } from '../schema.js'
import { parsePhrasePlanV1 } from '../schema.js'

// Context sampler: the "input side" of LoRA training data. Randomly generates BrainContexts of
// the same shape buildPrompt consumes. Manifests are real ones; plans are drawn only in shapes
// consistent with the manifest's slot declarations (planManifestMismatch holds by construction —
// no violating examples in the training set).
// Everything follows the rand.ts rule "a pure program determined by the seed": the same
// (baseSeed, index) always yields the same context (safe to interrupt and append).

export interface SamplerOpts {
  /** Pool of measured desire values from sessions/*.jsonl (empty = use the synthetic distribution) */
  readonly desirePool: ReadonlyArray<number>
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** Euclid/grid denominators limited to 8 or 16, matching STYLE_RULES */
const STEP_LENGTHS = [8, 16] as const

const randomEuclid = (steps: 8 | 16): Effect.Effect<PatternV1> =>
  Effect.gen(function* () {
    // Sparse by default (snare-like roles stay sparse — STYLE_RULES); 20% dense
    const dense = yield* chance(0.2)
    const pulses = dense ? yield* randInt(Math.floor(steps / 2), steps) : yield* randInt(1, Math.floor(steps / 2))
    const kind = yield* uniform
    // Prefer alternating rotations [a, b] over a fixed one (STYLE_RULES)
    if (kind < 0.5) {
      const a = yield* randInt(0, Math.min(15, steps - 1))
      const b = yield* randInt(0, Math.min(15, steps - 1))
      return { type: 'euclid', pulses, steps, rotation: [a, b] } as const
    }
    if (kind < 0.75) {
      const r = yield* randInt(0, Math.min(15, steps - 1))
      return { type: 'euclid', pulses, steps, rotation: r } as const
    }
    return { type: 'euclid', pulses, steps } as const
  })

type Cell = 'x' | '~'

const gridVariant = (len: number): Effect.Effect<ReadonlyArray<Cell>> =>
  Effect.gen(function* () {
    const cells = yield* Effect.all(
      Array.from({ length: len }, () => Effect.map(chance(0.35), (hit): Cell => (hit ? 'x' : '~'))),
    )
    // An all-rest grid violates the schema (use silence instead) — guarantee one hit
    if (cells.includes('x')) return cells
    const idx = yield* randInt(0, len - 1)
    return cells.map((c, i): Cell => (i === idx ? 'x' : c))
  })

const randomGrid = (steps: 8 | 16): Effect.Effect<PatternV1> =>
  Effect.gen(function* () {
    const nVariants = (yield* chance(0.3)) ? 2 : 1
    const variants = yield* Effect.all(Array.from({ length: nVariants }, () => gridVariant(steps)))
    return { type: 'grid', variants } as const
  })

type NCell = number | '~'

/** Common shape of an index-sequence variant (only the value source differs: nRange / nSet / vocab) */
const indexVariant = (len: number, pickIndex: Effect.Effect<number>): Effect.Effect<ReadonlyArray<NCell>> =>
  Effect.gen(function* () {
    const cells = yield* Effect.all(
      Array.from({ length: len }, () =>
        Effect.gen(function* () {
          const rest = yield* chance(0.45)
          return rest ? ('~' as const) : yield* pickIndex
        }),
      ),
    )
    if (cells.some((c) => c !== '~')) return cells
    const idx = yield* randInt(0, len - 1)
    const v = yield* pickIndex
    return cells.map((c, i): NCell => (i === idx ? v : c))
  })

/** How nsteps values are drawn: from nSet when declared, otherwise from nRange */
const nstepsIndex = (spec: SlotSpec): Effect.Effect<number> =>
  spec.nSet !== undefined
    ? pick(spec.nSet)
    : Effect.suspend(() => {
        // Without a declared nRange stay in a modest range (the sample bank's extent is unknown)
        const [lo, hi] = spec.nRange ?? [0, 7]
        return randInt(lo, hi)
      })

const indexPattern = (
  type: 'nsteps' | 'samples',
  pickIndex: Effect.Effect<number>,
  maxLen: number,
): Effect.Effect<PatternV1> =>
  Effect.gen(function* () {
    const len = Math.min(yield* pick(STEP_LENGTHS), maxLen)
    const nVariants = (yield* chance(0.3)) ? 2 : 1
    const variants = yield* Effect.all(Array.from({ length: nVariants }, () => indexVariant(len, pickIndex)))
    return { type, variants } as const
  })

/** Draw only patterns consistent with the slot declaration (generator type + value range) */
const randomPatternFor = (spec: SlotSpec): Effect.Effect<PatternV1> =>
  Effect.gen(function* () {
    const silent = yield* chance(0.12)
    if (silent) return { type: 'silence' } as const
    if (spec.generator === 'nsteps') return yield* indexPattern('nsteps', nstepsIndex(spec), 32)
    if (spec.generator === 'samples')
      return yield* indexPattern('samples', randInt(0, Math.max(0, (spec.vocab?.length ?? 1) - 1)), 32)
    const steps = yield* pick(STEP_LENGTHS)
    return (yield* chance(0.5)) ? yield* randomEuclid(steps) : yield* randomGrid(steps)
  })

/** A manifest-consistent v1 plan (used to synthesise history and lastPlan; not a teacher output) */
export const randomPlanV1 = (
  manifest: Manifest,
  args: { readonly desire: number; readonly allowTransition: boolean },
): Effect.Effect<PhrasePlanV1> =>
  Effect.gen(function* () {
    const withTransition =
      args.allowTransition && (yield* chance(0.25)) ? yield* randInt(0, manifest.slots.length - 1) : -1
    const slots = yield* Effect.forEach(manifest.slots, (spec, i) =>
      Effect.gen(function* () {
        const pattern = yield* randomPatternFor(spec)
        return i === withTransition
          ? { slot: spec.slot, pattern, transition: yield* randomPatternFor(spec) }
          : { slot: spec.slot, pattern }
      }),
    )
    const jitter = yield* uniform
    const stray = yield* chance(0.2)
    const lengthCycles = stray ? yield* pick([1, 2, 4, 8] as const) : manifest.defaultLengthCycles
    return parsePhrasePlanV1({
      version: 1,
      energy: clamp01(args.desire + (jitter - 0.5) * 0.3),
      lengthCycles,
      slots,
    })
  })

const USED_MODES = ['api', 'api', 'pool', 'pool', 'pool', 'offline'] as const

const randomFeedback: Effect.Effect<Feedback | null> = Effect.gen(function* () {
  const r = yield* uniform
  if (r < 0.12) return 'mark'
  if (r < 0.18) return 'veto'
  if (r < 0.21) return 'kill'
  if (r < 0.25) return 'freeze'
  return null
})

const randomDesire = (pool: ReadonlyArray<number>): Effect.Effect<number> =>
  Effect.gen(function* () {
    // 70% the measured distribution (sessions), 30% a synthetic centre-heavy distribution
    if (pool.length > 0 && (yield* chance(0.7))) return yield* pick(pool)
    const a = yield* uniform
    const b = yield* uniform
    return (a + b) / 2
  })

/** Sample one buildPrompt-shaped input for the given manifest */
const contextFor = (manifest: Manifest, opts: SamplerOpts): Effect.Effect<BrainContext> =>
  Effect.gen(function* () {
    const desire = yield* randomDesire(opts.desirePool)
    const extremeFreedom = yield* chance(0.2)
    const freedom = extremeFreedom ? yield* pick([0, 1] as const) : yield* uniform
    const strayLength = yield* chance(0.2)
    const lengthCycles = strayLength ? yield* pick([1, 2, 4, 8] as const) : manifest.defaultLengthCycles
    // Allowed 85% of the time unless the manifest forbids it (mix in "allowed but not used" too)
    const allowTransition = manifest.allowTransition === false ? false : yield* chance(0.85)
    const act1 = yield* uniform
    const act2 = yield* uniform
    // 1/4 of contexts have an empty history (start of a set) — that is exactly when exemplars cannot help
    const emptyHistory = yield* chance(0.25)
    const historyLen = emptyHistory ? 0 : yield* randInt(1, HISTORY_LEN)
    const startCycle = yield* randInt(0, 256)
    const entries = yield* Effect.forEach(
      Array.from({ length: historyLen }, (_, i) => i),
      (i) =>
        Effect.gen(function* () {
          const drift = yield* uniform
          const histDesire = clamp01(desire + (drift - 0.5) * 0.5)
          const plan = yield* randomPlanV1(manifest, {
            desire: histDesire,
            allowTransition,
          })
          const usedMode = yield* pick(USED_MODES)
          const feedback = yield* randomFeedback
          const record: PhraseRecord = {
            ...phraseRecord({
              atCycle: startCycle + i * lengthCycles,
              desire: histDesire,
              usedMode,
              plan,
            }),
            feedback,
          }
          return { plan, record }
        }),
    )
    const last = entries.at(-1)
    const freshLast = yield* chance(0.5)
    const lastPlan =
      last !== undefined ? last.plan : freshLast ? yield* randomPlanV1(manifest, { desire, allowTransition }) : null
    return {
      manifest,
      desire,
      freedom,
      lengthCycles,
      lastPlan,
      allowTransition,
      activity: act1 * act2,
      history: entries.map((e) => e.record),
    }
  })

/** Sample one buildPrompt-shaped input (picks one of the real manifests) */
const sampleContext = (manifests: ReadonlyArray<Manifest>, opts: SamplerOpts): Effect.Effect<BrainContext> =>
  Effect.gen(function* () {
    const manifest = yield* pick(manifests)
    return yield* contextFor(manifest, opts)
  })

/**
 * The index-th context (deterministic). The key to append-only runs: using the current line
 * count of raw.jsonl as startIndex yields the next contexts without duplicates
 */
export const contextAt = (
  manifests: ReadonlyArray<Manifest>,
  opts: SamplerOpts,
  baseSeed: number,
  index: number,
): BrainContext => runSeeded(baseSeed + index, sampleContext(manifests, opts))

// --- Synthetic manifests ---
// A real lesson: with only two real manifests, every sample had the same layout and the model
// memorised "slot number → type" instead of reading the manifest in the prompt. Mixing in
// synthetic manifests with random slot counts, generator assignments and nRanges forces the
// model to read the declaration.

const STRUCT_ROLES = [
  'perc (low tom) — sparse to medium; do not fill every downbeat',
  'hat — 16th-note feel, leaning on the offbeats',
  'kick support — sparse, weaving between the kicks',
  'snare-like role — sparse',
  'noise perc — occasional accents',
  'shaker — fine subdivision, assume low volume',
] as const

const NSTEPS_ROLES = ['sample selection (paired with a struct slot)', 'timbre index — move it sparingly'] as const

const SAMPLES_ROLES = [
  'kit (one-shots mixing bd/sn/hat) — indexes point into vocab',
  'sample switching — pick from vocab, move sparingly',
] as const

// Boundary diversity: the old [3,4,7,11,15] plus the default [0,7] burned in a "7 is the maximum"
// prior (the model wrote 7 even when nRange [0,5] was declared). Scatter the upper bounds so the
// model has to read the declaration (same idea as breaking layout memorisation)
const N_RANGE_HI = [2, 3, 4, 5, 6, 7, 9, 11, 13, 15] as const

// Material for synthetic vocab on samples slots (the names do not matter for learning — only the
// skill "write indexes no greater than maxIndex" is taught)
const VOCAB_BASES = ['bd', 'sn', 'hh', 'perc', 'lt', 'mt', 'ho', 'cp'] as const

// Small vocab sizes are weighted up: the smaller the vocab, the more often the "7 habit" becomes
// a violation, i.e. the stronger the signal for reading the boundary
const VOCAB_SIZES = [2, 3, 3, 4, 4, 5, 5, 6, 7, 8] as const

const randomVocab: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
  const n = yield* pick(VOCAB_SIZES)
  return yield* Effect.all(Array.from({ length: n }, (_, i) => Effect.map(pick(VOCAB_BASES), (base) => `${base}:${i}`)))
})

// style: mix "present" and "absent" so the model learns both "follow it when given" and "carry on as usual otherwise"
const STYLE_TEXTS = [
  'Dub-leaning. Leave space; assume echo is added downstream, do not overfill',
  'Minimal techno. Embrace repetition; change slowly, over several phrases',
  'Breakbeat-driven. Hats push forward, weave between the kicks',
  'Ambient-leaning. Sparse overall; make active use of silence',
  'Hard groove. Strong downbeats; concentrate fills on the last cycle',
  'Laid back. Offbeat-centred; keep density low',
] as const

export const randomManifest: Effect.Effect<Manifest> = Effect.gen(function* () {
  const nSlots = yield* randInt(2, 6)
  // struct 50% / nsteps 25% / samples 25% (samples exposure raised from 15% to thicken boundary examples)
  const kinds = yield* Effect.all(
    Array.from({ length: nSlots }, () =>
      Effect.map(uniform, (r) =>
        r < 0.5 ? ('struct' as const) : r < 0.75 ? ('nsteps' as const) : ('samples' as const),
      ),
    ),
  )
  // Ensure at least one struct slot (a set always has a rhythm structure)
  const flipIdx = kinds.includes('struct') ? -1 : yield* randInt(0, nSlots - 1)
  const slots = yield* Effect.forEach(kinds, (kind, i) =>
    Effect.gen(function* () {
      if (kind === 'struct' || i === flipIdx)
        return {
          slot: i + 1,
          generator: 'struct' as const,
          role: yield* pick(STRUCT_ROLES),
        }
      if (kind === 'samples')
        return {
          slot: i + 1,
          generator: 'samples' as const,
          role: yield* pick(SAMPLES_ROLES),
          vocab: yield* randomVocab,
        }
      // nsteps: 30% nSet (a sparse allowed set), 70% nRange
      if (yield* chance(0.3)) {
        const size = yield* randInt(2, 6)
        const values = yield* Effect.all(Array.from({ length: size }, () => randInt(0, 15)))
        return {
          slot: i + 1,
          generator: 'nsteps' as const,
          role: yield* pick(NSTEPS_ROLES),
          nSet: [...new Set(values)] as const,
        }
      }
      const hi = yield* pick(N_RANGE_HI)
      return {
        slot: i + 1,
        generator: 'nsteps' as const,
        role: yield* pick(NSTEPS_ROLES),
        nRange: [0, hi] as const,
      }
    }),
  )
  const a = yield* randInt(0, 9)
  const b = yield* randInt(0, 9)
  const c = yield* randInt(0, 9)
  const style = (yield* chance(0.65)) ? yield* pick(STYLE_TEXTS) : null
  // 20% of manifests forbid transitions (teaches reading the permission field)
  const forbidTransition = yield* chance(0.2)
  return {
    id: `gen-${a}${b}${c}`,
    ...(style === null ? {} : { style }),
    ...(forbidTransition ? { allowTransition: false } : {}),
    defaultLengthCycles: yield* pick([1, 2, 4, 4, 8] as const),
    slots,
  } as Manifest
})

/**
 * Synthesise a "shapes to avoid" list (imitates the persistent veto context).
 * 40% empty (a session without vetoes). Patterns are drawn from what this manifest could produce
 */
const randomAvoid = (manifest: Manifest): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const empty = yield* chance(0.4)
    if (empty) return []
    const n = yield* randInt(1, 6)
    const pats = yield* Effect.all(
      Array.from({ length: n }, () =>
        Effect.gen(function* () {
          const spec = yield* pick(manifest.slots)
          return renderPatternV1(yield* randomPatternFor(spec))
        }),
      ),
    )
    return [...new Set(pats.filter((p) => p !== '~'))]
  })

/**
 * Synthesise a "preferred shapes" list (imitates the persistent mark context).
 * 60% empty (a manifest without marks). **The contents are not meant to be learned** — real marks
 * are manifest-specific and injected at runtime; only the skill "lean on this vocabulary when the
 * field is present" is taught
 */
const randomLiked = (manifest: Manifest): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const empty = yield* chance(0.6)
    if (empty) return []
    const n = yield* randInt(1, 4)
    const pats = yield* Effect.all(
      Array.from({ length: n }, () =>
        Effect.gen(function* () {
          const spec = yield* pick(manifest.slots)
          return renderPatternV1(yield* randomPatternFor(spec))
        }),
      ),
    )
    return [...new Set(pats.filter((p) => p !== '~'))]
  })

export interface TrainingSample {
  readonly ctx: BrainContext
  readonly avoid: ReadonlyArray<string>
  readonly liked: ReadonlyArray<string>
}

/** One training input (context + avoid / liked lists). 40% real manifests, 60% synthetic */
const sampleTraining = (manifests: ReadonlyArray<Manifest>, opts: SamplerOpts): Effect.Effect<TrainingSample> =>
  Effect.gen(function* () {
    const synthetic = yield* chance(0.6)
    const manifest = synthetic || manifests.length === 0 ? yield* randomManifest : yield* pick(manifests)
    const ctx = yield* contextFor(manifest, opts)
    const avoid = yield* randomAvoid(manifest)
    const liked = yield* randomLiked(manifest)
    return { ctx, avoid, liked }
  })

/** The index-th training sample (deterministic — same append contract as contextAt) */
export const trainingAt = (
  manifests: ReadonlyArray<Manifest>,
  opts: SamplerOpts,
  baseSeed: number,
  index: number,
): TrainingSample => runSeeded(baseSeed + index, sampleTraining(manifests, opts))

// --- Hard cases ---
// Measured on hardware: the model's favourite shapes (straight hats, etc.) leaked through the
// transition (announced fill) even when they were on the avoid list. Show favourite × avoid ×
// transition combinations intensively so the instruction reaches the fill as well.
// **Contrast examples are mandatory**: without examples where the favourite is allowed because it
// is not on the list, the model learns "this shape is always forbidden" and turns timid.

/** Frequent shapes measured from the model (violations seen in the veto gate + common baseline shapes) */
export const FAVORITE_SHAPES = [
  't ~ t ~ t ~ t ~',
  '~ t ~ t ~ t ~ t',
  't(3,8)',
  't(5,8)',
  't(5,16)',
  't(3,8,<0 2>)',
] as const

/** One hard case: 75% avoid lists containing favourites (compliance), 25% contrast (freedom) */
const sampleHardTraining = (manifests: ReadonlyArray<Manifest>, opts: SamplerOpts): Effect.Effect<TrainingSample> =>
  Effect.gen(function* () {
    const synthetic = yield* chance(0.6)
    const manifest = synthetic || manifests.length === 0 ? yield* randomManifest : yield* pick(manifests)
    const ctx0 = yield* contextFor(manifest, opts)
    // Bias towards contexts where transitions actually appear (the leak was in the fill)
    const ctx = { ...ctx0, allowTransition: true }
    const liked = yield* randomLiked(manifest)
    const contrast = yield* chance(0.25)
    if (contrast) {
      // Contrast: an avoid list (possibly non-empty) that contains no favourite — favourites are allowed
      const base = yield* randomAvoid(manifest)
      const favorites = new Set<string>(FAVORITE_SHAPES)
      return { ctx, avoid: base.filter((p) => !favorites.has(p)), liked }
    }
    // Direct hit: 1–3 favourites + 0–2 ordinary avoid entries
    const nFav = yield* randInt(1, 3)
    const favs = yield* Effect.all(Array.from({ length: nFav }, () => pick(FAVORITE_SHAPES)))
    const extra = (yield* randomAvoid(manifest)).slice(0, 2)
    return { ctx, avoid: [...new Set([...favs, ...extra])], liked }
  })

/** The index-th hard case (deterministic — same append contract as trainingAt) */
export const hardTrainingAt = (
  manifests: ReadonlyArray<Manifest>,
  opts: SamplerOpts,
  baseSeed: number,
  index: number,
): TrainingSample => runSeeded(baseSeed + index, sampleHardTraining(manifests, opts))
