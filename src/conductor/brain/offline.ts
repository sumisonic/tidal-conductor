import { Effect } from 'effect'
import { match } from 'ts-pattern'
import { parsePhrasePlanV1, type PatternV1, type PhrasePlanV1 } from '../../schema.js'
import { chance, pick, randInt } from '../../rand.js'
import type { SlotSpec } from '../manifest.js'
import type { Brain, BrainContext } from './types.js'

// offline Brain: stochastic mutation only (no network needed).
// The same implementation serves as the fallback (degradation target) for api/pool.
// If there is a previous plan, replace just one slot to keep continuity; otherwise generate everything.

const STEPS_CHOICES = [8, 16] as const

/** A euclid whose density follows desire (steps limited to 8/16 — style rule) */
const genEuclid = (desire: number): Effect.Effect<PatternV1> =>
  Effect.gen(function* () {
    const steps = yield* pick(STEPS_CHOICES)
    const target = Math.round(steps * (0.15 + desire * 0.45))
    const jitter = yield* randInt(-1, 1)
    const pulses = Math.min(steps, Math.max(1, target + jitter))
    const rotate = yield* chance(0.6)
    if (!rotate) return { type: 'euclid', pulses, steps } as const
    const alt = yield* chance(0.4)
    if (!alt) {
      const rotation = yield* randInt(0, steps - 1)
      return { type: 'euclid', pulses, steps, rotation } as const
    }
    const a = yield* randInt(0, steps - 1)
    const b = yield* randInt(0, steps - 1)
    return { type: 'euclid', pulses, steps, rotation: [a, b] } as const
  })

/** An index sequence within the declared range (nRange / nSet / vocab), with rests mixed in */
const genIndexPattern = (
  type: 'nsteps' | 'samples',
  pickIndex: Effect.Effect<number>,
  desire: number,
): Effect.Effect<PatternV1> =>
  Effect.gen(function* () {
    const len = yield* pick([4, 8] as const)
    const cells = yield* Effect.forEach(Array.from({ length: len }), () =>
      Effect.gen(function* () {
        const rest = yield* chance(Math.max(0.1, 0.6 - desire * 0.4))
        if (rest) return '~' as const
        return yield* pickIndex
      }),
    )
    const hasIndex = cells.some((c) => c !== '~')
    const fixed = hasIndex ? cells : [yield* pickIndex, ...cells.slice(1)]
    return { type, variants: [fixed] } as const
  })

/** How nsteps values are drawn: from nSet when declared, otherwise from nRange */
const nstepsIndex = (spec: SlotSpec): Effect.Effect<number> =>
  spec.nSet !== undefined
    ? pick(spec.nSet)
    : Effect.suspend(() => {
        const [lo, hi] = spec.nRange ?? [0, 7]
        return randInt(lo, hi)
      })

const genSlotPattern = (spec: SlotSpec, desire: number): Effect.Effect<PatternV1> =>
  match(spec.generator)
    .with('struct', () => genEuclid(desire))
    .with('nsteps', () => genIndexPattern('nsteps', nstepsIndex(spec), desire))
    .with('samples', () => genIndexPattern('samples', randInt(0, Math.max(0, (spec.vocab?.length ?? 1) - 1)), desire))
    .exhaustive()

/** Transition (announced fill): a euclid slightly denser than the body (struct slots only, when allowed) */
const genTransition = (spec: SlotSpec, ctx: BrainContext): Effect.Effect<PatternV1 | undefined> =>
  spec.generator !== 'struct' || !ctx.allowTransition
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        const want = yield* chance(0.5)
        if (!want) return undefined
        return yield* genEuclid(Math.min(1, ctx.desire + 0.25))
      })

const freshPlan = (ctx: BrainContext): Effect.Effect<PhrasePlanV1> =>
  Effect.gen(function* () {
    const slots = yield* Effect.forEach(ctx.manifest.slots, (spec) =>
      Effect.gen(function* () {
        const pattern = yield* genSlotPattern(spec, ctx.desire)
        const transition = yield* genTransition(spec, ctx)
        return transition === undefined ? { slot: spec.slot, pattern } : { slot: spec.slot, pattern, transition }
      }),
    )
    return parsePhrasePlanV1({
      version: 1,
      energy: ctx.desire,
      lengthCycles: ctx.lengthCycles,
      slots,
    })
  })

/**
 * Replace just one slot of the previous plan (continuity between phrases).
 * Slots missing from the previous plan (ones the Brain omitted) are generated individually from
 * their own declaration — a pattern made for the replacement slot is never reused for a slot of another type
 */
const mutatePlan = (ctx: BrainContext, last: PhrasePlanV1): Effect.Effect<PhrasePlanV1> =>
  Effect.gen(function* () {
    const spec = yield* pick(ctx.manifest.slots)
    const slots = yield* Effect.forEach(ctx.manifest.slots, (s) =>
      Effect.gen(function* () {
        const prev = last.slots.find((p) => p.slot === s.slot)
        if (s.slot !== spec.slot && prev !== undefined) return prev
        const pattern = yield* genSlotPattern(s, ctx.desire)
        const transition = yield* genTransition(s, ctx)
        return transition === undefined ? { slot: s.slot, pattern } : { slot: s.slot, pattern, transition }
      }),
    )
    return parsePhrasePlanV1({
      version: 1,
      energy: ctx.desire,
      lengthCycles: ctx.lengthCycles,
      slots,
    })
  })

export const offlineBrain: Brain = {
  mode: 'offline',
  nextPlan: (ctx) =>
    Effect.gen(function* () {
      // Initiative policy (auxiliary signal): the more active the human is,
      // the more we avoid a full replacement and lean toward small mutations (the AI backs off)
      const mutateProb = 0.6 + 0.35 * ctx.activity
      const mutate = ctx.lastPlan !== null && (yield* chance(mutateProb))
      return mutate ? yield* mutatePlan(ctx, ctx.lastPlan!) : yield* freshPlan(ctx)
    }),
}
