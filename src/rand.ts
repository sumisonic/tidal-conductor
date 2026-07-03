import { Effect, Random } from 'effect'

// Random utilities — use Effect's Random service (the default service).
// Generators are written as "pure programs uniquely determined by the seed", and
// runSeeded is the single execution point. The same seed always gives the same result
// (reproducibility is the basis of A/B audition replay and of the tests).

/** Uniform random number in [0, 1) */
export const uniform: Effect.Effect<number> = Random.next

/** Uniform integer in [min, max] */
export const randInt = (min: number, max: number): Effect.Effect<number> =>
  Effect.map(uniform, (r) => min + Math.floor(r * (max - min + 1)))

/** One element drawn uniformly from an array */
export const pick = <T>(xs: readonly T[]): Effect.Effect<T> => Effect.map(randInt(0, xs.length - 1), (i) => xs[i]!)

/** true with probability p */
export const chance = (p: number): Effect.Effect<boolean> => Effect.map(uniform, (r) => r < p)

/** Run deterministically with a seed (failures are thrown as exceptions) */
export const runSeeded = <A, E>(seed: number, program: Effect.Effect<A, E>): A =>
  Effect.runSync(Effect.withRandom(program, Random.make(seed)))
