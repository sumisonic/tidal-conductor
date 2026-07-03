import { Effect, Ref } from 'effect'
import type { BrainContext, BrainResult } from './types.js'

// Hybrid mode: pool-driven + api inserts a fresh idea once every N phrases.
// Degradation on an api turn is always toward the safe side (api → pool → offline chain).
// "A verified foundation, with raw improvisation cutting in only occasionally" — a compromise
// for bringing api into the show without waiting for the blind gate.

export type ChainFn = (ctx: BrainContext) => Effect.Effect<BrainResult, Error>

/**
 * api from the very first phrase (show a fresh idea once at the start of the set), then an api turn every N phrases.
 * every <= 0 means always pool (effectively pool mode)
 */
export const makeHybridNextPlan = (apiChain: ChainFn, poolChain: ChainFn, every: number): Effect.Effect<ChainFn> =>
  Effect.map(
    Ref.make(0),
    (counter) => (ctx) =>
      Effect.gen(function* () {
        const n = yield* Ref.getAndUpdate(counter, (c) => c + 1)
        return every > 0 && n % every === 0 ? yield* apiChain(ctx) : yield* poolChain(ctx)
      }),
  )
