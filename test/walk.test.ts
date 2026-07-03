import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { walkStep } from '../src/conductor/walk.js'
import { runSeeded } from '../src/rand.js'

const runWalk = (seed: number, steps: number, from = 0): number =>
  runSeeded(
    seed,
    Effect.reduce(Array.from({ length: steps }), from, (d) => walkStep(0.12)(d)),
  )

describe('walkStep (mean-reverting random walk)', () => {
  it('is reproducible with a fixed seed', () => {
    expect(runWalk(42, 10)).toBe(runWalk(42, 10))
    expect(runWalk(1, 10)).not.toBe(runWalk(2, 10))
  })

  it('does not stick at 0 (regression from a hardware log: rises within 15 steps after a reset)', () => {
    Array.from({ length: 20 }, (_, i) => i + 1).forEach((seed) => {
      expect(runWalk(seed, 15, 0)).toBeGreaterThan(0.05)
    })
  })

  it('does not stick at 1 either (reverts toward the center)', () => {
    Array.from({ length: 20 }, (_, i) => i + 1).forEach((seed) => {
      expect(runWalk(seed, 15, 1)).toBeLessThan(0.95)
    })
  })

  it('always stays within [0,1]', () => {
    Array.from({ length: 50 }, (_, i) => i + 1).forEach((seed) => {
      const d = runWalk(seed, 100)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(1)
    })
  })

  it('at freedom 0 (strong pull) it locks onto the desired value within a few ticks', () => {
    // the conductor uses pull=0.45 and a 0.2x step size at freedom 0 (obedient mode)
    const obedient = (seed: number): number =>
      runSeeded(
        seed,
        Effect.reduce(Array.from({ length: 5 }), 0, (d) => walkStep(0.12 * 0.2, 0.45)(d, 1)),
      )
    Array.from({ length: 20 }, (_, i) => i + 1).forEach((seed) => {
      expect(obedient(seed)).toBeGreaterThan(0.85)
    })
  })

  it('follows the reversion center (the density desire knob)', () => {
    const runWalkTo = (seed: number, center: number, from: number): number =>
      runSeeded(
        seed,
        Effect.reduce(Array.from({ length: 25 }), from, (d) => walkStep(0.12)(d, center)),
      )
    // individual seeds can miss due to noise, so judge by the average over 20 seeds
    const seeds = Array.from({ length: 20 }, (_, i) => i + 1)
    const avg = (center: number, from: number): number =>
      seeds.reduce((acc, s) => acc + runWalkTo(s, center, from), 0) / seeds.length
    expect(avg(0.9, 0)).toBeGreaterThan(0.7)
    expect(avg(0.1, 1)).toBeLessThan(0.3)
  })
})
