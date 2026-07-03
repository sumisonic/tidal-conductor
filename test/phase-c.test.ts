import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { DEFAULT_BLIND_PAIR, pairKey, parseBlindPair, pickBlind } from '../src/conductor/blind.js'
import { makeHybridNextPlan } from '../src/conductor/brain/hybrid.js'
import { makeBrain } from '../src/conductor/brain/index.js'
import type { BrainContext, BrainResult } from '../src/conductor/brain/types.js'
import type { Manifest } from '../src/conductor/manifest.js'
import { parsePhrasePlanV1 } from '../src/schema.js'
import { runSeeded } from '../src/rand.js'

// Generalized blind pair matchups (pair guarantee) and hybrid mode.

const plan = parsePhrasePlanV1({
  version: 1,
  energy: 0.5,
  lengthCycles: 4,
  slots: [{ slot: 1, pattern: { type: 'euclid', pulses: 3, steps: 8 } }],
})

const manifest: Manifest = {
  id: 'example',
  defaultLengthCycles: 4,
  slots: [{ slot: 1, generator: 'struct', role: 'perc' }],
}

const ctx: BrainContext = {
  manifest,
  desire: 0.5,
  freedom: 0.5,
  lengthCycles: 4,
  lastPlan: null,
  allowTransition: true,
  activity: 0,
  history: [],
}

describe('pickBlind (generalized pair guarantee)', () => {
  const pair = DEFAULT_BLIND_PAIR // [api, pool]

  it('an even line count (new round) is decided by the coin', () => {
    expect(pickBlind([], pair, true)).toBe('api')
    expect(pickBlind([], pair, false)).toBe('pool')
  })

  it('an odd line count (second of the round) is the opposite of the first — regardless of the coin', () => {
    expect(pickBlind(['t1 api api,pool'], pair, true)).toBe('pool')
    expect(pickBlind(['t1 pool api,pool'], pair, false)).toBe('api')
  })

  it('lines of another pair are excluded by pairKey — even when mode names overlap (regression)', () => {
    // With an odd number of pool lines from the pool-vs-offline era, matching by mode name polluted
    // the parity and produced same-mode matchups. Matching by pairKey makes the second of the round
    // correctly the opposite of the first
    const lines = [
      't1 pool offline,pool',
      't2 offline offline,pool',
      't3 pool offline,pool',
      't4 local local,pool', // first of the current pair
    ]
    const lp = ['local', 'pool'] as const
    expect(pickBlind(lines, lp, true)).toBe('pool')
    expect(pickBlind(lines, lp, false)).toBe('pool')
  })

  it('legacy lines without pairKey are not counted (treated as even, back to the coin)', () => {
    const legacy = ['t1 api', 't2 pool', 't3 pool']
    expect(pickBlind(legacy, pair, true)).toBe('api')
    expect(pickBlind(legacy, pair, false)).toBe('pool')
  })

  it('pairKey does not depend on the order given in AI_BLIND_PAIR', () => {
    expect(pairKey(['pool', 'local'])).toBe('local,pool')
    expect(pairKey(['local', 'pool'])).toBe('local,pool')
  })

  it('parseBlindPair: unset/invalid falls back to api,pool; a valid value passes', () => {
    expect(parseBlindPair(undefined)).toEqual(['api', 'pool'])
    expect(parseBlindPair('pool,pool')).toEqual(['api', 'pool']) // same mode is invalid
    expect(parseBlindPair('some weird value')).toEqual(['api', 'pool'])
    expect(parseBlindPair('pool,offline')).toEqual(['pool', 'offline'])
    expect(parseBlindPair('hybrid, pool')).toEqual(['hybrid', 'pool'])
  })
})

describe('hybrid (pool-driven + api once every N phrases)', () => {
  const stubChain =
    (label: string) =>
    (_: BrainContext): Effect.Effect<BrainResult, Error> =>
      Effect.succeed({ plan, intended: label, usedMode: label })

  const intendedSeq = (every: number, calls: number): ReadonlyArray<string> =>
    Effect.runSync(
      Effect.gen(function* () {
        const nextPlan = yield* makeHybridNextPlan(stubChain('api'), stubChain('pool'), every)
        return yield* Effect.forEach(
          Array.from({ length: calls }, (_, i) => i),
          () => Effect.map(nextPlan(ctx), (r) => r.intended),
        )
      }),
    )

  it('every=3: api from the first phrase, then an api turn every 3 phrases', () => {
    expect(intendedSeq(3, 7)).toEqual(['api', 'pool', 'pool', 'api', 'pool', 'pool', 'api'])
  })

  it('every=0: always pool (effectively pool mode)', () => {
    expect(intendedSeq(0, 3)).toEqual(['pool', 'pool', 'pool'])
  })
})

describe('BrainResult intended / usedMode (observing degradation)', () => {
  // Make local fail immediately via an unreachable port (no network, deterministic)
  const unreachableLocal = {
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'test',
    timeoutMs: 2000,
  }

  it('when local fails it degrades to pool and reports intended=local / usedMode=pool', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const brain = yield* makeBrain('local', {
          poolPaths: ['plans/pool.json'],
          api: { provider: 'google', model: null, timeoutMs: 1000 },
          local: unreachableLocal,
          hybridEvery: 4,
          mask: false,
        })
        return yield* brain.nextPlan(ctx)
      }),
    )
    expect(result.intended).toBe('local')
    expect(result.usedMode).toBe('pool')
  })

  it('pool does not degrade: intended=usedMode=pool', () => {
    const result = runSeeded(
      1,
      Effect.gen(function* () {
        const brain = yield* makeBrain('pool', {
          poolPaths: ['plans/pool.json'],
          api: { provider: 'google', model: null, timeoutMs: 1000 },
          local: unreachableLocal,
          hybridEvery: 4,
          mask: false,
        })
        return yield* brain.nextPlan(ctx)
      }),
    )
    expect(result.intended).toBe('pool')
    expect(result.usedMode).toBe('pool')
  })
})
