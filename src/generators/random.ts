import { Effect } from 'effect'
import type { PhrasePlan, Rhythm, Role } from '../schema.js'
import { CORE_ROLES, parsePhrasePlan } from '../schema.js'
import { chance, pick, randInt, runSeeded, uniform } from '../rand.js'

// Random generator — the lowest baseline (a pattern source for the parseBP sweep and the tests).
// It just draws uniformly within the schema and has no musical knowledge whatsoever.
// A yardstick: a generator that cannot beat this is not worth adopting.
// The lineup (roles) can be fixed — to make rhythm the only variable in A/B comparison.

type Cell = 'x' | '~'
type Step = Cell | readonly Cell[]

const randomCell: Effect.Effect<Cell> = Effect.map(chance(0.5), (b) => (b ? 'x' : '~'))

const randomStep: Effect.Effect<Step> = Effect.gen(function* () {
  const subdivide = yield* chance(0.1)
  if (!subdivide) return yield* randomCell
  const n = yield* randInt(2, 4)
  return yield* Effect.all(Array.from({ length: n }, () => randomCell))
})

const hasHit = (steps: readonly Step[]): boolean => steps.some((s) => (Array.isArray(s) ? s.includes('x') : s === 'x'))

const randomVariant = (len: number): Effect.Effect<readonly Step[]> =>
  Effect.gen(function* () {
    const steps = yield* Effect.all(Array.from({ length: len }, () => randomStep))
    // An all-rest grid violates the schema (the convention is to use silence), so guarantee one hit
    if (hasHit(steps)) return steps
    const idx = yield* randInt(0, len - 1)
    return steps.map((s, i): Step => (i === idx ? 'x' : s))
  })

const randomRotation: Effect.Effect<number | readonly number[] | undefined> = Effect.gen(function* () {
  const none = yield* chance(0.5)
  if (none) return undefined
  const fixed = yield* chance(0.5)
  if (fixed) return yield* randInt(0, 15)
  const n = yield* randInt(2, 4)
  return yield* Effect.all(Array.from({ length: n }, () => randInt(0, 15)))
})

const randomEuclid: Effect.Effect<Rhythm> = Effect.gen(function* () {
  const steps = yield* randInt(2, 16)
  const pulses = yield* randInt(1, steps)
  const rotation = yield* randomRotation
  return rotation === undefined
    ? ({ type: 'euclid', pulses, steps } as const)
    : ({ type: 'euclid', pulses, steps, rotation } as const)
})

const randomGrid: Effect.Effect<Rhythm> = Effect.gen(function* () {
  const len = yield* pick([4, 8, 16] as const)
  const multi = yield* chance(0.25)
  const nVariants = multi ? yield* randInt(2, 4) : 1
  const variants = yield* Effect.all(Array.from({ length: nVariants }, () => randomVariant(len)))
  return { type: 'grid', variants } as const
})

const randomRhythm: Effect.Effect<Rhythm> = Effect.gen(function* () {
  const kind = yield* uniform
  if (kind < 0.45) return yield* randomEuclid
  if (kind < 0.9) return yield* randomGrid
  return { type: 'silence' } as const
})

export const randomPlan = (seed: number, roles: readonly Role[] = CORE_ROLES): PhrasePlan =>
  runSeeded(
    seed,
    Effect.gen(function* () {
      const slots = yield* Effect.forEach(roles, (role, i) =>
        Effect.map(randomRhythm, (rhythm) => ({ slot: i + 1, role, rhythm })),
      )
      const energy = yield* uniform
      const bars = yield* pick([1, 2, 4] as const)
      return parsePhrasePlan({ version: 0, energy, bars, slots })
    }),
  )
