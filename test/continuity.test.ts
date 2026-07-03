import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import type { PhrasePlanV1 } from '../src/schema.js'
import { makePoolBrain } from '../src/conductor/brain/pool.js'
import type { Manifest } from '../src/conductor/manifest.js'
import { initialState } from '../src/conductor/state.js'
import { pllInit, pllResync } from '../src/conductor/pll.js'
import {
  onPlanReady,
  planTick,
  schedDefaults,
  schedInit,
  type SchedAction,
  type SchedState,
} from '../src/conductor/scheduler.js'
import { offlineBrain } from '../src/conductor/brain/offline.js'
import { runSeeded } from '../src/rand.js'

// Regression test for "plan application stops after one".
// Simulates the scheduler without real time and confirms that application continues every phrase.

const manifest: Manifest = {
  id: 'my-set',
  defaultLengthCycles: 4,
  slots: [
    { slot: 1, generator: 'struct', role: 'perc' },
    { slot: 2, generator: 'struct', role: 'hat' },
    { slot: 3, generator: 'nsteps', role: 'n', nRange: [0, 7] },
  ],
}

describe('continuity of plan application', () => {
  const simulate = (allowTransition: boolean) => {
    // cps 0.542, starting at cycle 670, 100 ms tick
    const cps = 0.542
    const t0 = 100_000
    const pllAt = (nowMs: number) => pllResync(pllInit, 670 + (nowMs - t0) * (cps / 1000), cps, nowMs)

    const applied: number[] = []
    const result = Array.from({ length: 600 }, (_, i) => t0 + i * 100).reduce<SchedState>((sched, nowMs) => {
      const pll = pllAt(nowMs)
      const [next, actions] = planTick(sched, pll, initialState, manifest, nowMs, schedDefaults)
      return actions.reduce<SchedState>((s, action: SchedAction) => {
        if (action._tag === 'PlanApplied') {
          applied.push(action.targetCycle)
          return s
        }
        if (action._tag === 'RequestPlan') {
          // The Brain answers immediately (like pool/offline) — assumed to return right after the fork, as on hardware
          const plan: PhrasePlanV1 = runSeeded(
            action.targetCycle,
            offlineBrain.nextPlan({
              manifest,
              desire: 0.25,
              freedom: 0.5,
              lengthCycles: action.lengthCycles,
              lastPlan: s.current,
              allowTransition,
              activity: 0,
              history: [],
            }),
          )
          return onPlanReady(s, 1, action.generation, action.targetCycle, plan, pll, nowMs, schedDefaults, manifest)
        }
        return s
      }, next)
    }, schedInit)
    return { applied, result }
  }

  it('over a 60 s simulation application continues every phrase (does not stop after one)', () => {
    const { applied, result } = simulate(false)
    // 60 s ÷ phrase (4 cycles ≈ 7.4 s) ≈ 8 times — at least 5 applications expected
    expect(applied.length).toBeGreaterThanOrEqual(5)
    // Every application boundary is a multiple of 4 (remainder of the absolute cycle)
    applied.forEach((c) => expect(c % 4).toBe(0))
    expect(result.current).not.toBeNull()
  })

  it('with transitions included, every phrase is still applied consecutively and none is skipped', () => {
    const { applied } = simulate(true)
    expect(applied.length).toBeGreaterThanOrEqual(5)
    // Consecutive application boundaries always differ by 1 phrase (4 cycles) — the fill is not blocking requests
    applied.slice(1).forEach((c, i) => expect(c - applied[i]!).toBe(4))
  })

  it('does not break down over 20 consecutive calls with the bundled pool', () => {
    // From the 2nd call on, lastPlan is present (mutate path) + re-entry of pool-derived plans
    const plans = runSeeded(
      7,
      Effect.gen(function* () {
        const brain = yield* makePoolBrain(['plans/pool.json'])
        return yield* Effect.reduce(Array.from({ length: 20 }), [] as PhrasePlanV1[], (acc) =>
          Effect.map(
            brain.nextPlan({
              manifest,
              desire: 0.25,
              freedom: 0.5,
              lengthCycles: 4,
              lastPlan: acc[acc.length - 1] ?? null,
              allowTransition: false,
              activity: 0,
              history: [],
            }),
            (p) => [...acc, p],
          ),
        )
      }),
    )
    expect(plans.length).toBe(20)
  })
})
