import { Effect } from 'effect'
import { match } from 'ts-pattern'
import { offlineBrain } from './offline.js'
import { makePoolBrain } from './pool.js'
import { makeApiBrain, type ApiBrainConfig } from './api.js'
import { makeLocalBrain, type LocalBrainConfig } from './local.js'
import { makeHybridNextPlan, type ChainFn } from './hybrid.js'
import type { Brain, BrainContext, BrainMode, BrainResult } from './types.js'
import { planManifestMismatch } from '../manifest.js'
import type { PhrasePlanV1 } from '../../schema.js'

// Brain assembly and the degradation chain.
// api → pool → offline / pool → offline / local → pool → offline /
// hybrid = pool-driven + one api chain turn every N phrases.
// Degradation is announced on the terminal + usedMode is shown on the status line, and optionally
// also notified to /ai/status (AI_NOTIFY).
// During blind, mask hides the Brain name in degradation logs (it would leak the answer).
//
// Acceptance contract (shared by all Brains, enforced by the chain wrapper):
// - lengthCycles is normalized to the requested length (the boundary was chosen for that length; the content is cycle-relative, so this is harmless)
// - if allowTransition=false, transitions are stripped
// - a plan that violates manifest consistency (type + value) counts as a failure (degrade to the next Brain)

export interface WrappedBrain {
  readonly mode: BrainMode
  readonly nextPlan: (ctx: BrainContext) => Effect.Effect<BrainResult, Error>
}

export const chainFor = (
  mode: Exclude<BrainMode, 'hybrid'>,
  pool: Brain,
  api: Brain,
  local: Brain,
): readonly [Brain, ...Brain[]] =>
  match(mode)
    .with('api', (): readonly [Brain, ...Brain[]] => [api, pool, offlineBrain])
    .with('pool', (): readonly [Brain, ...Brain[]] => [pool, offlineBrain])
    .with('offline', (): readonly [Brain, ...Brain[]] => [offlineBrain])
    .with('local', (): readonly [Brain, ...Brain[]] => [local, pool, offlineBrain])
    .exhaustive()

/** Normalize to the request context: length as requested, transitions stripped when not allowed */
export const conformToContext = (ctx: BrainContext, plan: PhrasePlanV1): PhrasePlanV1 => ({
  ...plan,
  lengthCycles: ctx.lengthCycles,
  slots: ctx.allowTransition
    ? plan.slots
    : plan.slots.map((s) => (s.transition === undefined ? s : { slot: s.slot, pattern: s.pattern })),
})

/** Run a Brain's output through the acceptance contract (a manifest mismatch is an Error) */
export const acceptPlan = (ctx: BrainContext, plan: PhrasePlanV1): Effect.Effect<PhrasePlanV1, Error> => {
  const conformed = conformToContext(ctx, plan)
  const mismatch = planManifestMismatch(conformed, ctx.manifest)
  return mismatch === null ? Effect.succeed(conformed) : Effect.fail(new Error(`manifest mismatch: ${mismatch}`))
}

const withMode = (brain: Brain, ctx: BrainContext, intended: string): Effect.Effect<BrainResult, Error> =>
  Effect.map(
    Effect.flatMap(brain.nextPlan(ctx), (plan) => acceptPlan(ctx, plan)),
    (plan) => ({
      plan,
      intended,
      usedMode: brain.mode,
    }),
  )

/**
 * Degradation chain: try from the head; on each failure, announce it on the terminal and move on.
 * catchAllCause: not only typed errors but also defects (a thrown schema violation etc.)
 * always degrade instead of dying silently. offline never fails (last line of defense)
 */
const chainNextPlan = (chain: readonly [Brain, ...Brain[]], mask: boolean): ChainFn => {
  const [head, ...rest] = chain
  return (ctx) =>
    rest.reduce(
      (acc, brain) =>
        Effect.catchAllCause(acc, (cause) =>
          Effect.zipRight(
            Effect.sync(() =>
              console.warn(
                mask
                  ? '[ai] ★ Brain degraded (blind — details withheld until scoring)'
                  : `[ai] ★ Brain degraded: ${cause.toString().split('\n')[0]} → retrying with ${brain.mode}`,
              ),
            ),
            withMode(brain, ctx, head.mode),
          ),
        ),
      withMode(head, ctx, head.mode),
    )
}

export const makeBrain = (
  mode: BrainMode,
  config: {
    readonly poolPaths: ReadonlyArray<string>
    readonly api: ApiBrainConfig
    readonly local: LocalBrainConfig
    /** hybrid: give api a turn once every N phrases (<= 0 means always pool) */
    readonly hybridEvery: number
    /** for blind: hide the Brain name and failure reason in degradation logs */
    readonly mask: boolean
  },
): Effect.Effect<WrappedBrain> =>
  Effect.gen(function* () {
    const pool = yield* makePoolBrain(config.poolPaths)
    const api = makeApiBrain(config.api)
    const local = makeLocalBrain(config.local)
    if (mode === 'hybrid') {
      const nextPlan = yield* makeHybridNextPlan(
        chainNextPlan([api, pool, offlineBrain], config.mask),
        chainNextPlan([pool, offlineBrain], config.mask),
        config.hybridEvery,
      )
      return { mode, nextPlan }
    }
    return {
      mode,
      nextPlan: chainNextPlan(chainFor(mode, pool, api, local), config.mask),
    }
  })
